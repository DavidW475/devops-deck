import * as vscode from 'vscode';
import { AdoClient, AdoError } from '../client';
import { ConnectionManager } from '../connection';
import { IdentityRef, PullRequest, WorkItem } from '../types';
import { errorMessage, shortRef, VOTE_LABELS } from '../util';

type CommandAction = { command: string; args?: unknown[] };
type Action = 'notify' | 'open' | 'browser' | CommandAction;

interface BaseConfig {
  name: string;
  enabled?: boolean;
  /** seconds between checks */
  interval?: number;
  actions?: Action[];
  /** skip changes made by the signed-in user */
  ignoreOwnChanges?: boolean;
}

export interface WorkItemWatcherConfig extends BaseConfig {
  type: 'workItem';
  events?: ('created' | 'changed')[];
  /** WIQL condition, e.g. "[System.WorkItemType] = 'Bug' AND [System.AssignedTo] = @Me" */
  where?: string;
  /** only report "changed" when one of these fields changed */
  fields?: string[];
}

export interface PullRequestWatcherConfig extends BaseConfig {
  type: 'pullRequest';
  events?: PrEventKind[];
  repository?: string | string[];
  targetBranch?: string;
  sourceBranch?: string;
  createdBy?: string;
  reviewer?: string;
  titleContains?: string;
  includeDrafts?: boolean;
}

export type WatcherConfig = WorkItemWatcherConfig | PullRequestWatcherConfig;
type PrEventKind = 'created' | 'pushed' | 'voted' | 'completed' | 'abandoned';

export interface WatchEvent {
  watcher: string;
  message: string;
  time: number;
  kind: 'workItem' | 'pullRequest';
  id: number;
  title: string;
  url: string;
  repoId?: string;
}

const DEFAULT_INTERVAL = 300;
const MIN_INTERVAL = 60;
const TICK_MS = 15_000;
/** Look back a little further than the last check so clock skew between us and the server loses nothing. */
const OVERLAP_MS = 2 * 60_000;
/** More events than this per check are folded into one notification. */
const MAX_SINGLE_NOTIFICATIONS = 3;
const HISTORY = 50;

const intervalOf = (c: BaseConfig) => Math.max(MIN_INTERVAL, c.interval ?? DEFAULT_INTERVAL) * 1000;

function glob(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
}

function isPerson(ref: IdentityRef | undefined, who: string, me: IdentityRef): boolean {
  if (!ref) {
    return false;
  }
  if (who.toLowerCase() === '@me') {
    return ref.id === me.id;
  }
  const w = who.toLowerCase();
  return ref.displayName?.toLowerCase() === w || ref.uniqueName?.toLowerCase() === w;
}

function fieldText(v: unknown): string {
  if (v === undefined || v === null || v === '') {
    return '∅';
  }
  if (typeof v === 'object' && 'displayName' in (v as object)) {
    return String((v as IdentityRef).displayName);
  }
  const s = String(v).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

/** All configured watchers, including disabled ones. */
export function readWatchers(): WatcherConfig[] {
  return [...vscode.workspace.getConfiguration('azureDevOps').get<WatcherConfig[]>('watchers', [])];
}

/** Watchers live where they are already defined: workspace settings if there are any, else user settings. */
export function watchersTarget(): vscode.ConfigurationTarget {
  const inspect = vscode.workspace.getConfiguration('azureDevOps').inspect<WatcherConfig[]>('watchers');
  return inspect?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

export async function writeWatchers(list: WatcherConfig[]): Promise<void> {
  await vscode.workspace.getConfiguration('azureDevOps').update('watchers', list, watchersTarget());
}

/** One-line description, e.g. "Pull requests · created, voted · every 5 min". */
export function watcherSummary(w: WatcherConfig): string {
  const events = w.events?.length ? w.events : w.type === 'pullRequest' ? ['created'] : ['created', 'changed'];
  return `${w.type === 'pullRequest' ? 'Pull requests' : 'Work items'} · ${events.join(', ')} · every ${Math.round(intervalOf(w) / 60000)} min`;
}

/** Whether a pull request passes a watcher's filters. */
export function matchesPullRequest(c: PullRequestWatcherConfig, pr: PullRequest, me: IdentityRef): boolean {
  const repos = typeof c.repository === 'string' ? [c.repository] : c.repository ?? [];
  return (!repos.length || repos.some(r => r.toLowerCase() === pr.repository.name.toLowerCase()))
    && (!c.targetBranch || glob(c.targetBranch, shortRef(pr.targetRefName)))
    && (!c.sourceBranch || glob(c.sourceBranch, shortRef(pr.sourceRefName)))
    && (!c.createdBy || isPerson(pr.createdBy, c.createdBy, me))
    && (!c.reviewer || pr.reviewers.some(r => isPerson(r, c.reviewer!, me)))
    && (!c.titleContains || pr.title.toLowerCase().includes(c.titleContains.toLowerCase()))
    && (c.includeDrafts !== false || !pr.isDraft);
}

interface WatcherState {
  config: WatcherConfig;
  nextRun: number;
  /** work items: start of the next query window; undefined until the first (silent) baseline run */
  since?: number;
  /** work items: last revision we have seen per id */
  revs: Map<number, number>;
  /** pull requests: events collected since this watcher's last run */
  queue: WatchEvent[];
}

/**
 * Polls Azure DevOps for the watchers in `azureDevOps.watchers` and runs their actions.
 * Work item watchers run one WIQL query restricted to items changed since the last check, so a quiet
 * check costs a single small request. All pull request watchers share one list of active PRs and detect
 * changes by comparing it with the previous list.
 */
export class Watchers implements vscode.Disposable {
  private states: WatcherState[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private running = false;
  private me?: IdentityRef;
  private prSnapshot?: Map<number, PullRequest>;
  private readonly history: WatchEvent[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the configuration, the events or the status change. */
  readonly onDidChange = this.changed.event;
  private unseen = 0;
  private lastError?: string;
  private lastCheck?: number;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly output = vscode.window.createOutputChannel('DevOps Deck Watchers', { log: true });
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly client: AdoClient, private readonly connections: ConnectionManager) {
    this.status.command = 'azureDevOps.watchers.showEvents';
    this.disposables.push(this.status, this.output, this.changed,
      connections.onDidChange(() => this.load()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('azureDevOps.watchers')) {
          this.load();
        }
      }));
    this.load();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }

  /** (Re)reads the configuration; every watcher starts with a silent baseline so old changes do not flood in. */
  private load(): void {
    const configs = vscode.workspace.getConfiguration('azureDevOps').get<WatcherConfig[]>('watchers', [])
      .filter(c => c && c.name && (c.type === 'workItem' || c.type === 'pullRequest') && c.enabled !== false);
    this.states = configs.map(config => ({ config, nextRun: 0, revs: new Map(), queue: [] }));
    this.prSnapshot = undefined;
    this.me = undefined;
    this.lastError = undefined;
    this.renderStatus();
    void this.tick();
  }

  async checkNow(): Promise<void> {
    for (const s of this.states) {
      s.nextRun = 0;
    }
    await this.tick();
    if (this.lastError) {
      void vscode.window.showWarningMessage(`Watchers: ${this.lastError}`);
    } else {
      void vscode.window.setStatusBarMessage(`$(eye) Watchers checked: ${this.states.length} active`, 3000);
    }
  }

  get unseenCount(): number {
    return this.unseen;
  }

  get statusText(): string {
    return this.lastError ? `Last check failed: ${this.lastError}`
      : this.lastCheck ? `Last check: ${new Date(this.lastCheck).toLocaleTimeString()}` : 'Not checked yet';
  }

  /** Recent events of one watcher, newest first. */
  eventsOf(name: string): WatchEvent[] {
    return this.history.filter(e => e.watcher === name).reverse();
  }

  markSeen(): void {
    if (this.unseen) {
      this.unseen = 0;
      this.renderStatus();
    }
  }

  async showEvents(): Promise<void> {
    this.markSeen();
    if (!this.history.length) {
      const pick = await vscode.window.showInformationMessage(
        this.states.length ? 'No watcher events yet.' : 'No watchers configured.', 'Configure Watchers');
      if (pick) {
        await vscode.commands.executeCommand('azureDevOps.watchers.configure');
      }
      return;
    }
    await this.pickEvent([...this.history].reverse(), 'Watcher events');
  }

  private async pickEvent(events: WatchEvent[], title: string): Promise<void> {
    const pick = await vscode.window.showQuickPick(events.map(e => ({
      label: e.message,
      description: e.watcher,
      detail: new Date(e.time).toLocaleString(),
      event: e,
    })), { title, matchOnDescription: true });
    if (pick) {
      await this.open(pick.event);
    }
  }

  open(e: WatchEvent): Thenable<unknown> {
    return e.kind === 'workItem'
      ? vscode.commands.executeCommand('azureDevOps.wi.open', e.id)
      : vscode.commands.executeCommand('azureDevOps.pr.openOverview', e.repoId, e.id);
  }

  private renderStatus(): void {
    this.changed.fire();
    if (!this.states.length) {
      this.status.hide();
      return;
    }
    this.status.text = this.lastError ? '$(warning) Watchers' : this.unseen ? `$(bell-dot) ${this.unseen}` : '$(eye)';
    this.status.tooltip = `DevOps Deck: ${this.states.length} watcher${this.states.length === 1 ? '' : 's'} active`
      + (this.lastCheck ? `\nLast check: ${new Date(this.lastCheck).toLocaleTimeString()}` : '')
      + (this.lastError ? `\nLast error: ${this.lastError}` : '')
      + '\nClick to show recent events';
    this.status.show();
  }

  // ---------- polling ----------

  private async tick(): Promise<void> {
    const now = Date.now();
    const due = this.states.filter(s => s.nextRun <= now);
    if (this.running || !due.length || !this.connections.current) {
      return;
    }
    this.running = true;
    const states = this.states;
    try {
      this.me ??= await this.client.getMe();
      if (due.some(s => s.config.type === 'pullRequest')) {
        await this.pollPullRequests();
      }
      for (const s of due) {
        if (states !== this.states) {
          return; // configuration changed meanwhile
        }
        s.nextRun = Date.now() + intervalOf(s.config);
        const events = s.config.type === 'workItem' ? await this.pollWorkItems(s, s.config) : s.queue.splice(0);
        if (events.length) {
          this.output.info(`${s.config.name}: ${events.length} event(s)`);
          await this.dispatch(s.config, events);
        }
      }
      this.lastError = undefined;
      this.lastCheck = Date.now();
    } catch (e) {
      // Auth problems surface in the sidebar already; keep retrying quietly on the normal schedule.
      this.lastError = e instanceof AdoError && e.isAuthError ? 'not signed in' : errorMessage(e);
      this.output.warn(this.lastError);
      for (const s of due) {
        s.nextRun = Math.max(s.nextRun, Date.now() + intervalOf(s.config));
      }
    } finally {
      this.running = false;
      this.renderStatus();
    }
  }

  private async pollWorkItems(s: WatcherState, c: WorkItemWatcherConfig): Promise<WatchEvent[]> {
    const me = this.me!;
    const baseline = s.since === undefined;
    const since = s.since ?? Date.now();
    const from = new Date(since - OVERLAP_MS).toISOString();
    const where = c.where?.trim() ? ` AND (${c.where})` : '';
    const ids = await this.client.queryWiql(
      `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${where} AND [System.ChangedDate] > '${from}' ORDER BY [System.ChangedDate] DESC`,
      { top: 200, timePrecision: true });
    s.since = Date.now();
    if (!ids.length) {
      return [];
    }
    const items = await this.client.getWorkItems(ids, ['System.CreatedDate', 'System.CreatedBy', 'System.ChangedBy']);
    const events: WatchEvent[] = [];
    const kinds = c.events?.length ? c.events : ['created', 'changed'];
    for (const w of items) {
      const known = s.revs.get(w.id);
      s.revs.set(w.id, w.rev);
      if (baseline || (known !== undefined && known >= w.rev)) {
        continue;
      }
      const f = w.fields;
      const created = known === undefined && new Date(f['System.CreatedDate']).getTime() > since - OVERLAP_MS;
      const by: IdentityRef | undefined = created ? f['System.CreatedBy'] : f['System.ChangedBy'];
      if (c.ignoreOwnChanges !== false && by?.id === me.id) {
        continue;
      }
      if (created && kinds.includes('created')) {
        events.push(this.wiEvent(c, w, `${f['System.WorkItemType']} #${w.id} created${by ? ` by ${by.displayName}` : ''}`));
      } else if (!created && kinds.includes('changed')) {
        const detail = await this.changedFields(w, known, since, c.fields);
        if (detail !== undefined) {
          events.push(this.wiEvent(c, w, `${f['System.WorkItemType']} #${w.id} changed${detail}${by ? ` by ${by.displayName}` : ''}`));
        }
      }
    }
    return events;
  }

  /**
   * With `fields` configured, loads the item's recent updates and describes the watched fields that changed
   * (e.g. " (State: Active → Resolved)"); undefined when none of them changed. Without `fields` nothing is loaded.
   */
  private async changedFields(w: WorkItem, knownRev: number | undefined, since: number, fields?: string[]): Promise<string | undefined> {
    if (!fields?.length) {
      return '';
    }
    const updates = await this.client.getWorkItemUpdates(w.id, w.rev);
    const changes = new Map<string, { from: unknown; to: unknown }>();
    for (const u of updates) {
      const changedAt = u.fields?.['System.ChangedDate']?.newValue;
      const isNew = knownRev !== undefined ? u.rev > knownRev : !!changedAt && new Date(String(changedAt)).getTime() > since - OVERLAP_MS;
      for (const [name, v] of Object.entries(isNew ? u.fields ?? {} : {})) {
        if (fields.includes(name)) {
          changes.set(name, { from: changes.get(name)?.from ?? v.oldValue, to: v.newValue });
        }
      }
    }
    if (!changes.size) {
      return undefined;
    }
    return ' (' + [...changes].map(([name, v]) => `${name.split('.').pop()}: ${fieldText(v.from)} → ${fieldText(v.to)}`).join(', ') + ')';
  }

  private wiEvent(c: WatcherConfig, w: WorkItem, what: string): WatchEvent {
    const title = String(w.fields['System.Title'] ?? '');
    return { watcher: c.name, kind: 'workItem', id: w.id, title, url: this.client.webUrl('workItem', w.id), time: Date.now(), message: `${what}: ${title}` };
  }

  /** One request for all pull request watchers; changes are queued on every watcher whose filter matches. */
  private async pollPullRequests(): Promise<void> {
    const prWatchers = this.states.filter((s): s is WatcherState & { config: PullRequestWatcherConfig } => s.config.type === 'pullRequest');
    const active = await this.client.listActivePullRequests(1000);
    const current = new Map(active.map(pr => [pr.pullRequestId, pr]));
    const previous = this.prSnapshot;
    this.prSnapshot = current;
    if (!previous) {
      return; // baseline
    }
    const me = this.me!;
    const changes: { pr: PullRequest; kind: PrEventKind; text: string; actor?: IdentityRef }[] = [];
    for (const pr of active) {
      const old = previous.get(pr.pullRequestId);
      if (!old) {
        changes.push({ pr, kind: 'created', text: `New PR !${pr.pullRequestId} in ${pr.repository.name} by ${pr.createdBy.displayName}`, actor: pr.createdBy });
        continue;
      }
      if (old.lastMergeSourceCommit?.commitId && pr.lastMergeSourceCommit?.commitId !== old.lastMergeSourceCommit.commitId) {
        changes.push({ pr, kind: 'pushed', text: `PR !${pr.pullRequestId} has new changes` });
      }
      for (const r of pr.reviewers) {
        const before = old.reviewers.find(x => x.id === r.id)?.vote ?? 0;
        if (r.vote !== before && r.vote !== 0) {
          changes.push({ pr, kind: 'voted', text: `${r.displayName}: ${VOTE_LABELS[String(r.vote)] ?? r.vote} on PR !${pr.pullRequestId}`, actor: r });
        }
      }
    }
    // PRs that left the active list were completed or abandoned; a full list may just have been cut off.
    const gone = active.length < 1000 ? [...previous.values()].filter(pr => !current.has(pr.pullRequestId)).slice(0, 20) : [];
    for (const old of gone) {
      const pr = await this.client.getPullRequest(old.repository.id, old.pullRequestId).catch(() => undefined);
      if (pr?.status === 'completed' || pr?.status === 'abandoned') {
        changes.push({ pr, kind: pr.status, text: `PR !${pr.pullRequestId} ${pr.status}${pr.closedBy ? ` by ${pr.closedBy.displayName}` : ''}`, actor: pr.closedBy });
      }
    }
    for (const ch of changes) {
      for (const s of prWatchers) {
        const c = s.config;
        const kinds = c.events?.length ? c.events : ['created'];
        if (!kinds.includes(ch.kind) || !matchesPullRequest(c, ch.pr, me) || (c.ignoreOwnChanges !== false && ch.actor?.id === me.id)) {
          continue;
        }
        s.queue.push({
          watcher: c.name, kind: 'pullRequest', id: ch.pr.pullRequestId, repoId: ch.pr.repository.id, title: ch.pr.title,
          url: this.client.webUrl('pr', ch.pr.repository.name, ch.pr.pullRequestId), time: Date.now(), message: `${ch.text}: ${ch.pr.title}`,
        });
      }
    }
  }

  // ---------- actions ----------

  private async dispatch(c: WatcherConfig, events: WatchEvent[]): Promise<void> {
    this.history.push(...events);
    this.history.splice(0, Math.max(0, this.history.length - HISTORY));
    this.unseen += events.length;
    const actions = c.actions?.length ? c.actions : ['notify'];
    for (const a of actions) {
      if (a === 'notify') {
        this.notify(c, events);
      } else if (a === 'open') {
        for (const e of events.slice(0, MAX_SINGLE_NOTIFICATIONS)) {
          await this.open(e);
        }
      } else if (a === 'browser') {
        for (const e of events.slice(0, MAX_SINGLE_NOTIFICATIONS)) {
          await vscode.env.openExternal(vscode.Uri.parse(e.url));
        }
      } else if (a && typeof a === 'object' && typeof a.command === 'string') {
        for (const e of events) {
          await Promise.resolve(vscode.commands.executeCommand(a.command, ...(a.args ?? []).map(arg => fill(arg, e))))
            .catch(err => this.output.error(`${c.name}: command ${a.command} failed: ${errorMessage(err)}`));
        }
      }
    }
  }

  private notify(c: WatcherConfig, events: WatchEvent[]): void {
    if (events.length > MAX_SINGLE_NOTIFICATIONS) {
      void vscode.window.showInformationMessage(`${c.name}: ${events.length} new events`, 'Show').then(pick => {
        if (pick) {
          void this.pickEvent(events, c.name);
        }
      });
      return;
    }
    for (const e of events) {
      void vscode.window.showInformationMessage(`${c.name}: ${e.message}`, 'Open', 'Open in Browser').then(pick => {
        if (pick === 'Open') {
          void this.open(e);
        } else if (pick === 'Open in Browser') {
          void vscode.env.openExternal(vscode.Uri.parse(e.url));
        }
      });
    }
  }
}

/** Replaces ${id}, ${title}, ${url}, ${kind}, ${watcher} and ${message} in command arguments. */
function fill(arg: unknown, e: WatchEvent): unknown {
  if (typeof arg === 'string') {
    return arg.replace(/\$\{(id|title|url|kind|watcher|message)\}/g, (_, k: keyof WatchEvent) => String(e[k]));
  }
  if (Array.isArray(arg)) {
    return arg.map(a => fill(a, e));
  }
  if (arg && typeof arg === 'object') {
    return Object.fromEntries(Object.entries(arg).map(([k, v]) => [k, fill(v, e)]));
  }
  return arg;
}

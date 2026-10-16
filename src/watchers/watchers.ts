import * as vscode from 'vscode';
import { AdoClient, AdoError } from '../client';
import { ConnectionManager } from '../connection';
import { Build, IdentityRef, PullRequest, WorkItem, WorkItemUpdate } from '../types';
import { errorMessage, shortRef, VOTE_LABELS } from '../util';
import { stripTags } from '../workItems/wiModel';

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

export interface PipelineWatcherConfig extends BaseConfig {
  type: 'pipeline';
  events?: PipelineEventKind[];
  /** pipeline name(s); `*` is a wildcard */
  pipeline?: string | string[];
  /** branch, e.g. "main" or "release/*" */
  branch?: string;
  /** who started the run: "@me", a display name or an e-mail */
  requestedBy?: string;
}

export type WatcherConfig = WorkItemWatcherConfig | PullRequestWatcherConfig | PipelineWatcherConfig;
type PrEventKind = 'created' | 'pushed' | 'voted' | 'completed' | 'abandoned';
type PipelineEventKind = 'failed' | 'succeeded' | 'canceled' | 'started';
const WATCHER_TYPES = new Set(['workItem', 'pullRequest', 'pipeline']);

export interface WatchEvent {
  watcher: string;
  message: string;
  time: number;
  kind: 'workItem' | 'pullRequest' | 'pipeline';
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
  const s = stripTags(String(v)).replace(/\s+/g, ' ').trim();
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

const DEFAULT_EVENTS: Record<WatcherConfig['type'], string[]> = { workItem: ['created', 'changed'], pullRequest: ['created'], pipeline: ['failed'] };
const TYPE_LABEL: Record<WatcherConfig['type'], string> = { workItem: 'Work items', pullRequest: 'Pull requests', pipeline: 'Pipelines' };

export function eventsOf(w: WatcherConfig): string[] {
  return w.events?.length ? w.events : DEFAULT_EVENTS[w.type] ?? [];
}

/** One-line description, e.g. "Pull requests · created, voted · every 5 min". */
export function watcherSummary(w: WatcherConfig): string {
  return `${TYPE_LABEL[w.type] ?? w.type} · ${eventsOf(w).join(', ')} · every ${Math.round(intervalOf(w) / 60000)} min`;
}

/** Whether a pipeline run passes a watcher's filters. */
export function matchesBuild(c: PipelineWatcherConfig, b: Build, me: IdentityRef): boolean {
  const names = typeof c.pipeline === 'string' ? [c.pipeline] : c.pipeline ?? [];
  return (!names.length || names.some(n => glob(n, b.definition.name)))
    && (!c.branch || glob(c.branch, shortRef(b.sourceBranch)))
    && (!c.requestedBy || isPerson(b.requestedFor, c.requestedBy, me));
}

/** Which event a run is: started, or by its result once finished (partially succeeded counts as failed). */
export function buildEvent(b: Build): PipelineEventKind | undefined {
  if (b.status !== 'completed') {
    return b.startTime ? 'started' : undefined;
  }
  switch (b.result) {
    case 'succeeded': return 'succeeded';
    case 'failed': case 'partiallySucceeded': return 'failed';
    case 'canceled': return 'canceled';
    default: return undefined;
  }
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
  /** pipelines: start of the next query window; undefined until the first (silent) baseline run */
  private buildsSince?: number;
  /** pipelines: time of the silent baseline check */
  private buildsBaseline?: number;
  /** pipelines: "<buildId>:<event>" already reported (the query windows overlap) */
  private readonly buildSeen = new Set<string>();
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
      .filter(c => c?.name && WATCHER_TYPES.has(c.type) && c.enabled !== false);
    this.states = configs.map(config => ({ config, nextRun: 0, revs: new Map(), queue: [] }));
    this.prSnapshot = undefined;
    this.buildsSince = undefined;
    this.buildsBaseline = undefined;
    this.buildSeen.clear();
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
      vscode.window.setStatusBarMessage(`$(eye) Watchers checked: ${this.states.length} active`, 3000);
    }
  }

  get unseenCount(): number {
    return this.unseen;
  }

  get statusText(): string {
    if (this.lastError) {
      return `Last check failed: ${this.lastError}`;
    }
    return this.lastCheck ? `Last check: ${new Date(this.lastCheck).toLocaleTimeString()}` : 'Not checked yet';
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
    if (e.kind === 'pipeline') {
      return vscode.commands.executeCommand('azureDevOps.pipelines.openRun', e.id);
    }
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
    this.status.text = '$(eye)';
    if (this.lastError) {
      this.status.text = '$(warning) Watchers';
    } else if (this.unseen) {
      this.status.text = `$(bell-dot) ${this.unseen}`;
    }
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
    try {
      this.me ??= await this.client.getMe();
      if (due.some(s => s.config.type === 'pullRequest')) {
        await this.pollPullRequests();
      }
      if (due.some(s => s.config.type === 'pipeline')) {
        await this.pollPipelines();
      }
      await this.runDue(due, this.states);
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

  /** Collects each due watcher's events (work items query now, the others were queued) and runs its actions. */
  private async runDue(due: WatcherState[], states: WatcherState[]): Promise<void> {
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
  }

  private async pollWorkItems(s: WatcherState, c: WorkItemWatcherConfig): Promise<WatchEvent[]> {
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
    for (const w of items) {
      const known = s.revs.get(w.id);
      s.revs.set(w.id, w.rev);
      if (!baseline && (known === undefined || known < w.rev)) {
        const e = await this.workItemEvent(c, w, known, since);
        if (e) {
          events.push(e);
        }
      }
    }
    return events;
  }

  /** The event for a new revision of a work item, if the watcher reports it. */
  private async workItemEvent(c: WorkItemWatcherConfig, w: WorkItem, known: number | undefined, since: number): Promise<WatchEvent | undefined> {
    const f = w.fields;
    const kinds = c.events?.length ? c.events : ['created', 'changed'];
    const created = known === undefined && new Date(f['System.CreatedDate']).getTime() > since - OVERLAP_MS;
    const by: IdentityRef | undefined = created ? f['System.CreatedBy'] : f['System.ChangedBy'];
    if (c.ignoreOwnChanges !== false && by?.id === this.me!.id) {
      return undefined;
    }
    const byText = by ? ` by ${by.displayName}` : '';
    if (created) {
      return kinds.includes('created') ? this.wiEvent(c, w, `${f['System.WorkItemType']} #${w.id} created${byText}`) : undefined;
    }
    if (!kinds.includes('changed')) {
      return undefined;
    }
    const detail = await this.changedFields(w, known, since, c.fields);
    return detail === undefined ? undefined : this.wiEvent(c, w, `${f['System.WorkItemType']} #${w.id} changed${detail}${byText}`);
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
    const isNew = (u: WorkItemUpdate) => {
      if (knownRev !== undefined) {
        return u.rev > knownRev;
      }
      const changedAt = u.fields?.['System.ChangedDate']?.newValue;
      return !!changedAt && new Date(String(changedAt)).getTime() > since - OVERLAP_MS;
    };
    for (const u of updates.filter(isNew)) {
      for (const [name, v] of Object.entries(u.fields ?? {})) {
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
    const active = await this.client.listActivePullRequests(1000);
    const current = new Map(active.map(pr => [pr.pullRequestId, pr]));
    const previous = this.prSnapshot;
    this.prSnapshot = current;
    if (!previous) {
      return; // baseline
    }
    const changes = active.flatMap(pr => prChanges(pr, previous.get(pr.pullRequestId)));
    // PRs that left the active list were completed or abandoned; a full list may just have been cut off.
    const gone = active.length < 1000 ? [...previous.values()].filter(pr => !current.has(pr.pullRequestId)).slice(0, 20) : [];
    for (const old of gone) {
      const pr = await this.client.getPullRequest(old.repository.id, old.pullRequestId).catch(() => undefined);
      if (pr?.status === 'completed' || pr?.status === 'abandoned') {
        const by = pr.closedBy ? ` by ${pr.closedBy.displayName}` : '';
        changes.push({ pr, kind: pr.status, text: `PR !${pr.pullRequestId} ${pr.status}${by}`, actor: pr.closedBy });
      }
    }
    const me = this.me!;
    const prWatchers = this.states.filter((s): s is WatcherState & { config: PullRequestWatcherConfig } => s.config.type === 'pullRequest');
    for (const ch of changes) {
      for (const s of prWatchers.filter(w => wantsPrChange(w.config, ch, me))) {
        s.queue.push({
          watcher: s.config.name, kind: 'pullRequest', id: ch.pr.pullRequestId, repoId: ch.pr.repository.id, title: ch.pr.title,
          url: this.client.webUrl('pr', ch.pr.repository.name, ch.pr.pullRequestId), time: Date.now(), message: `${ch.text}: ${ch.pr.title}`,
        });
      }
    }
  }

  /**
   * One or two requests for all pipeline watchers: runs finished (and, if a watcher wants it, started) since the
   * last check. Events are queued on every matching watcher.
   */
  private async pollPipelines(): Promise<void> {
    const watchers = this.states.filter((s): s is WatcherState & { config: PipelineWatcherConfig } => s.config.type === 'pipeline');
    const since = this.buildsSince;
    const now = Date.now();
    if (since === undefined) {
      this.buildsSince = now;
      this.buildsBaseline = now;
      return; // baseline: report only what happens from now on
    }
    // Overlap with the previous window against clock skew, but never reach back before the baseline.
    const from = new Date(since === this.buildsBaseline ? since : since - OVERLAP_MS);
    const wantsStarted = watchers.some(w => eventsOf(w.config).includes('started'));
    const [finished, started] = await Promise.all([
      this.client.listBuildsSince(from, 'finished'),
      wantsStarted ? this.client.listBuildsSince(from, 'started') : Promise.resolve([] as Build[]),
    ]);
    // Only a successful check moves the window on, so a failed one loses nothing.
    this.buildsSince = now;
    const me = this.me!;
    for (const b of [...started.filter(x => x.status !== 'completed'), ...finished]) {
      const kind = buildEvent(b);
      if (!kind || this.buildSeen.has(`${b.id}:${kind}`)) {
        continue;
      }
      this.buildSeen.add(`${b.id}:${kind}`);
      for (const s of watchers.filter(w => wantsBuild(w.config, b, kind, me))) {
        s.queue.push({
          watcher: s.config.name, kind: 'pipeline', id: b.id, title: `${b.definition.name} #${b.buildNumber}`,
          url: this.client.webUrl('build', b.id), time: Date.now(), message: buildMessage(b, kind),
        });
      }
    }
    // Keep the memory of reported runs small; old ones fall out of the query window anyway.
    if (this.buildSeen.size > 2000) {
      [...this.buildSeen].slice(0, 1000).forEach(k => this.buildSeen.delete(k));
    }
  }

  // ---------- actions ----------

  private async dispatch(c: WatcherConfig, events: WatchEvent[]): Promise<void> {
    this.history.push(...events);
    this.history.splice(0, Math.max(0, this.history.length - HISTORY));
    this.unseen += events.length;
    const actions: Action[] = c.actions?.length ? c.actions : ['notify'];
    for (const a of actions) {
      await this.runAction(c, a, events);
    }
  }

  private async runAction(c: WatcherConfig, a: Action, events: WatchEvent[]): Promise<void> {
    if (a === 'notify') {
      this.notify(c, events);
      return;
    }
    if (a === 'open' || a === 'browser') {
      for (const e of events.slice(0, MAX_SINGLE_NOTIFICATIONS)) {
        await (a === 'open' ? this.open(e) : vscode.env.openExternal(vscode.Uri.parse(e.url)));
      }
      return;
    }
    if (a && typeof a === 'object' && typeof a.command === 'string') {
      for (const e of events) {
        await Promise.resolve(vscode.commands.executeCommand(a.command, ...(a.args ?? []).map(arg => fill(arg, e))))
          .catch(err => this.output.error(`${c.name}: command ${a.command} failed: ${errorMessage(err)}`));
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

type PrChange = { pr: PullRequest; kind: PrEventKind; text: string; actor?: IdentityRef };

/** What changed on an active pull request since the previous check. */
function prChanges(pr: PullRequest, old: PullRequest | undefined): PrChange[] {
  if (!old) {
    return [{ pr, kind: 'created', text: `New PR !${pr.pullRequestId} in ${pr.repository.name} by ${pr.createdBy.displayName}`, actor: pr.createdBy }];
  }
  const out: PrChange[] = [];
  if (old.lastMergeSourceCommit?.commitId && pr.lastMergeSourceCommit?.commitId !== old.lastMergeSourceCommit.commitId) {
    out.push({ pr, kind: 'pushed', text: `PR !${pr.pullRequestId} has new changes` });
  }
  for (const r of pr.reviewers) {
    const before = old.reviewers.find(x => x.id === r.id)?.vote ?? 0;
    if (r.vote !== before && r.vote !== 0) {
      out.push({ pr, kind: 'voted', text: `${r.displayName}: ${VOTE_LABELS[String(r.vote)] ?? r.vote} on PR !${pr.pullRequestId}`, actor: r });
    }
  }
  return out;
}

function wantsPrChange(c: PullRequestWatcherConfig, ch: PrChange, me: IdentityRef): boolean {
  const kinds = c.events?.length ? c.events : ['created'];
  return kinds.includes(ch.kind) && matchesPullRequest(c, ch.pr, me) && !(c.ignoreOwnChanges !== false && ch.actor?.id === me.id);
}

/** Pipeline watchers report own runs too, unless ignoreOwnChanges is set explicitly. */
function wantsBuild(c: PipelineWatcherConfig, b: Build, kind: PipelineEventKind, me: IdentityRef): boolean {
  return eventsOf(c).includes(kind) && matchesBuild(c, b, me) && !(c.ignoreOwnChanges === true && b.requestedFor?.id === me.id);
}

const BUILD_VERB: Record<PipelineEventKind, string> = { started: 'started', canceled: 'was canceled', succeeded: 'succeeded', failed: 'failed' };

function buildMessage(b: Build, kind: PipelineEventKind): string {
  const who = b.requestedFor ? ` (${b.requestedFor.displayName})` : '';
  return `${b.definition.name} #${b.buildNumber} ${BUILD_VERB[kind]} on ${shortRef(b.sourceBranch)}${who}`;
}

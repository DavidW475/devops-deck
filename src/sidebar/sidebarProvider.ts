import * as vscode from 'vscode';
import { AdoClient, AdoError } from '../client';
import { ConnectionManager, normalizeOrgUrl } from '../connection';
import { buildDto, timelineTree } from '../pipelines/timeline';
import { ChecksSummary, summarizeChecks } from '../pullRequests/checks';
import { changeVersion, ReviewedFiles } from '../pullRequests/reviewed';
import { Approval, PullRequest, TeamIteration, WorkItem, WorkItemState } from '../types';
import type { MyDayService } from '../myDay/service';
import type { MyDayResult } from '../myDay/types';
import { errorMessage, mapLimit, nonce, plural, shortRef } from '../util';
import { loadByPerson, sprintStructure, workingDays } from '../workItems/sprint';

export interface BuiltinQuery {
  name: string;
  wiql: string;
}

/** An optional text field from the page: a non-empty string or undefined. */
const optText = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const DEFAULT_QUERIES: BuiltinQuery[] = [
  { name: 'Assigned to me', wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed') ORDER BY [System.ChangedDate] DESC" },
  { name: 'Recently updated by me', wiql: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.ChangedBy] = @Me AND [System.ChangedDate] >= @Today - 14 ORDER BY [System.ChangedDate] DESC' },
  { name: 'Created by me', wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.CreatedBy] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed') ORDER BY [System.CreatedDate] DESC" },
];

/** The built-in "Assigned to me" query, also the work item source of My Day. */
export const ASSIGNED_TO_ME: BuiltinQuery = DEFAULT_QUERIES[0];

/** How long the policy status of a pull request is reused: switching filters or refreshing in a burst asks once. */
const CHECKS_TTL_MS = 15_000;
/** Entries kept at most: the cache is bounded in a long session that sees many pull requests. */
export const CHECKS_CACHE_MAX = 200;

const badgeTooltip = (count: number): string => (count === 1 ? '1 item needs you in My Day' : `${plural(count, 'item')} need you in My Day`);

/** The sidebar dashboard: a single webview with tabs for pull requests, work items and pipelines. */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly stateCache = new Map<string, Promise<WorkItemState[]>>();
  private readonly checksCache = new Map<string, { at: number; checks: Promise<ChecksSummary | undefined> }>();
  private myDay?: MyDayService;
  private myDaySubscribed = false;
  private lastCount = 0;
  private lastTab = '';

  constructor(
    private readonly client: AdoClient,
    private readonly connections: ConnectionManager,
    private readonly reviewed: ReviewedFiles,
    private readonly extensionUri: vscode.Uri,
  ) {
    reviewed.onDidChange(e => void this.view?.webview.postMessage({ type: 'reviewed', ...e }));
    vscode.window.onDidChangeWindowState(e => void this.view?.webview.postMessage({ type: 'focus', focused: e.focused }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const n = nonce();
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${n}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage(m => this.onMessage(m));
    view.onDidChangeVisibility(() => this.syncVisible());
    this.setBadge(this.lastCount);
    this.myDay?.start();
  }

  /** Connects My Day: its changes are pushed to the page and shown as the badge of the view. */
  useMyDay(service: MyDayService): void {
    this.myDay = service;
    if (this.myDaySubscribed) {
      return;
    }
    this.myDaySubscribed = true;
    service.onDidChange((result: MyDayResult) => {
      this.setBadge(result.count);
      void this.view?.webview.postMessage({ type: 'myDay', result });
    });
  }

  private setBadge(count: number): void {
    this.lastCount = count;
    if (this.view) {
      this.view.badge = count > 0 ? { value: count, tooltip: badgeTooltip(count) } : undefined;
    }
  }

  /** The service refreshes faster while its tab is on screen. */
  private syncVisible(): void {
    this.myDay?.setVisible(!!this.view?.visible && this.lastTab === 'myday');
  }

  /** The work item states of a project's type, cached; a failure caches an empty list. */
  statesFor(project: string, type: string, client?: AdoClient): Promise<WorkItemState[]> {
    // States depend on the project's process, so the cache is per project and type.
    const key = `${project}\n${type}`;
    let states = this.stateCache.get(key);
    if (!states) {
      states = (client ?? this.client.forProject(project || undefined)).getWorkItemStates(type).catch(() => []);
      this.stateCache.set(key, states);
    }
    return states;
  }

  refresh(): void {
    this.stateCache.clear();
    this.checksCache.clear();
    void this.view?.webview.postMessage({ type: 'refresh' });
  }

  private async onMessage(m: any): Promise<void> {
    if (m.type === 'command') {
      // Only our own commands: anything else (e.g. terminal commands) must not be reachable from the webview.
      if (typeof m.name === 'string' && m.name.startsWith('azureDevOps.')) {
        await vscode.commands.executeCommand(m.name, ...(Array.isArray(m.args) ? m.args : []));
      }
      return;
    }
    if (m.type !== 'rpc') {
      return;
    }
    try {
      const result = await this.rpc(m.method, m.params ?? {});
      void this.view?.webview.postMessage({ type: 'rpc', id: m.id, result });
    } catch (e) {
      const auth = e instanceof AdoError && e.isAuthError;
      void this.view?.webview.postMessage({ type: 'rpc', id: m.id, error: { message: errorMessage(e), auth } });
    }
  }

  private async myDayResult(force: boolean): Promise<MyDayResult> {
    if (!this.myDay) {
      throw new Error('My Day is not available');
    }
    const result = await this.myDay.get({ force });
    this.setBadge(result.count);
    return result;
  }

  private async rpc(method: string, p: any): Promise<unknown> {
    const c = this.client;
    switch (method) {
      case 'context':
        return this.context();
      case 'projects':
        return c.listProjects(p.org ? normalizeOrgUrl(String(p.org).trim()) : undefined);
      case 'setProject':
        await this.setProjects(String(p.org), Array.isArray(p.projects) ? p.projects.map(String) : [String(p.project)]);
        return null;
      case 'me':
        return c.getMe();
      case 'prs':
        return this.pullRequests(String(p.filter), !!p.force);
      case 'prFiles':
        return this.prFiles(String(p.repoId), Number(p.prId));
      case 'setReviewed':
        await this.reviewed.set(String(p.repoId), Number(p.prId), String(p.path), String(p.version), !!p.reviewed);
        return null;
      case 'queries': {
        const saved = await c.listSavedQueries().catch(() => []);
        return {
          builtin: this.builtinQueries().map((q, i) => ({ key: `builtin:${i}`, name: q.name })),
          saved: saved.map(q => ({ key: `saved:${q.id}`, name: q.name, path: q.path })),
        };
      }
      case 'workItems': {
        const key = String(p.query ?? 'builtin:0');
        // Saved queries belong to the primary project; built-in and custom WIQL run in every selected project.
        const wiql = (this.builtinQueries()[Number(key.slice(8))] ?? this.builtinQueries()[0]).wiql;
        // Up to 200 per project; with several projects the newest changes come first.
        const ids = key.startsWith('saved:')
          ? (await c.runSavedQuery(key.slice(6))).slice(0, 200)
          : [...new Set((await this.perProject(x => x.queryWiql(wiql).then(list => list.slice(0, 200).map(id => ({ id }))))).map(x => x.id))];
        let items = await c.getWorkItems(ids);
        if (this.multi()) {
          items = items.toSorted((a, b) => String(b.fields['System.ChangedDate']).localeCompare(String(a.fields['System.ChangedDate']))).slice(0, 200);
        }
        return Promise.all(items.map(w => this.workItemDto(w)));
      }
      case 'builds': {
        const requestedFor = p.filter === 'mine' ? (await c.getMe()).id : undefined;
        const builds = await this.perProject(x => x.listBuilds({ requestedFor, top: 30 }).then(list => list.map(buildDto)));
        return builds.toSorted((a, b) => (b.queueTime ?? '').localeCompare(a.queueTime ?? '')).slice(0, 30);
      }
      case 'definitions':
        return this.perProject(async (x, project) => (await x.listDefinitions()).map(d => {
          const folder = d.path.split('\\').filter(Boolean);
          return {
            id: d.id, name: d.name, path: [...(this.multi() ? [project] : []), ...folder].join(' / '),
            folder: this.multi() ? [project, ...folder] : folder,
            latest: d.latestBuild ? buildDto(d.latestBuild) : undefined,
          };
        }));
      case 'definitionBuilds':
        return (await c.forProject(optText(p.project)).listBuilds({ definitionId: Number(p.id), top: 10 })).map(buildDto);
      case 'timeline':
        return timelineTree(await c.forProject(optText(p.project)).getTimeline(Number(p.buildId)));
      case 'teams':
        return this.perProject(async x => (await x.listTeams()).map(t => ({ id: t.id, name: t.name })));
      case 'sprint':
        return this.sprint(c.forProject(optText(p.project)), String(p.team), p.iteration ? String(p.iteration) : undefined);
      case 'approvals':
        return this.perProject((x, project) => this.approvals(x, project));
      case 'myDay':
        return this.myDayResult(!!p.force);
      case 'tab':
        this.lastTab = typeof p.tab === 'string' ? p.tab : '';
        this.syncVisible();
        return null;
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  /** A team's sprint: its work items with hierarchy, remaining work and capacity. Defaults to the current sprint. */
  private async sprint(c: AdoClient, team: string, iterationId?: string) {
    const iterations = await c.listTeamIterations(team);
    const iteration = iterations.find(i => i.id === iterationId)
      ?? iterations.find(i => i.attributes?.timeFrame === 'current')
      ?? iterations.findLast(i => i.attributes?.timeFrame === 'past')
      ?? iterations[0];
    const iterationDto = (i: TeamIteration) => ({
      id: i.id, name: i.name, path: i.path, start: i.attributes?.startDate, finish: i.attributes?.finishDate, timeFrame: i.attributes?.timeFrame,
    });
    if (!iteration) {
      return { iterations: [], iteration: undefined, items: [], people: [] };
    }
    const [links, capacities, teamDaysOff] = await Promise.all([
      c.getIterationWorkItems(team, iteration.id),
      c.getCapacities(team, iteration.id).catch(() => []),
      c.getTeamDaysOff(team, iteration.id).catch(() => []),
    ]);
    const { ids, parentOf } = sprintStructure(links);
    const work = await c.getWorkItems(ids, ['Microsoft.VSTS.Scheduling.RemainingWork', 'Microsoft.VSTS.Scheduling.StoryPoints',
      'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.CompletedWork']);
    const order = new Map(ids.map((id, i) => [id, i]));
    work.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const items = await Promise.all(work.map(async w => {
      const f = w.fields;
      const dto = await this.workItemDto(w, c);
      return {
        ...dto, parent: parentOf.get(w.id),
        remaining: f['Microsoft.VSTS.Scheduling.RemainingWork'], completed: f['Microsoft.VSTS.Scheduling.CompletedWork'],
        points: f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? f['Microsoft.VSTS.Scheduling.Effort'],
      };
    }));
    const today = new Date();
    const finish = iteration.attributes?.finishDate;
    const start = iteration.attributes?.startDate;
    // Capacity and days left count from today, or from the start of a future sprint.
    const from = start && new Date(start) > today ? new Date(start) : today;
    const people = loadByPerson(items.map(i => ({ assignedTo: i.assignedTo, remaining: i.remaining, done: i.stateCategory === 'Completed' })),
      capacities, teamDaysOff, from, finish);
    return {
      iterations: iterations.map(iterationDto), iteration: iterationDto(iteration), items, people,
      daysLeft: finish && new Date(finish) >= today ? workingDays(from, finish, teamDaysOff) : 0,
      daysTotal: start && finish ? workingDays(start, finish, teamDaysOff) : undefined,
    };
  }

  /** Pending approvals of pipeline runs; `mine` marks the ones the signed-in user may answer. */
  private async approvals(c: AdoClient, project: string) {
    const pending = this.myDay ? this.myDay.rawApprovals(this.projectName(project)) : c.listPendingApprovals();
    const [list, me] = await Promise.all([pending, c.getMe()]);
    return list.map((a: Approval) => ({
      id: a.id,
      pipeline: a.pipeline?.name,
      runId: a.pipeline?.owner?.id,
      run: a.pipeline?.owner?.name,
      created: a.createdOn,
      instructions: a.instructions,
      approvers: (a.steps ?? []).map(s => ({ name: s.assignedApprover.displayName, status: s.status })),
      mine: (a.steps ?? []).some(s => s.assignedApprover.id === me.id && s.status === 'pending'),
    }));
  }

  private context() {
    const conn = this.connections.current;
    const cfg = vscode.workspace.getConfiguration('azureDevOps');
    return {
      configured: !!conn,
      orgUrl: conn?.orgUrl,
      org: conn?.orgUrl.split('/').pop(),
      project: conn?.project,
      projects: conn?.projects ?? [],
      authMethod: cfg.get('authMethod'),
      refreshInterval: cfg.get<number>('pipelines.refreshInterval', 10),
      autoRefreshInterval: cfg.get<number>('refreshInterval', 60),
      focused: vscode.window.state.focused,
    };
  }

  /**
   * Saved per workspace; the configuration listener re-resolves the connection and refreshes the view.
   * The first project is the primary one; further ones are shown alongside it.
   */
  private async setProjects(org: string, list: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('azureDevOps');
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg.update('organization', normalizeOrgUrl(org.trim()), target);
    await cfg.update('project', list[0], target);
    await cfg.update('additionalProjects', list.length > 1 ? list.slice(1) : undefined, target);
  }

  /** Pull requests of the selected projects, newest first, with the state of their required checks. */
  private async pullRequests(filter: string, force: boolean) {
    const c = this.client;
    const me = await c.getMe();
    const criteria: Record<string, { creatorId?: string; reviewerId?: string }> = { mine: { creatorId: me.id }, review: { reviewerId: me.id } };
    const list = (x: AdoClient, project: string) => filter === 'review' && this.myDay
      ? this.myDay.rawReviews(this.projectName(project))
      : x.listPullRequests(criteria[filter] ?? {});
    const prs = (await this.perProject<PullRequest>(list)).toSorted((a, b) => b.creationDate.localeCompare(a.creationDate));
    // Policy status per PR (at most 6 requests at a time); a PR whose policies cannot be read just shows no checks.
    const checks = await mapLimit(prs, 6, pr => pr.repository.project?.id
      ? this.checksOf(pr.repository.project.id, pr.pullRequestId, force)
      : Promise.resolve(undefined));
    return prs.map((pr, i) => ({ ...this.prDto(pr, me.id), project: pr.project, checks: checks[i] }));
  }

  /** The required-check summary of a PR; reused for CHECKS_TTL_MS unless `force` asks again. */
  private checksOf(projectId: string, prId: number, force: boolean): Promise<ChecksSummary | undefined> {
    const key = `${projectId}/${prId}`;
    const cached = this.checksCache.get(key);
    if (cached && !force && Date.now() - cached.at < CHECKS_TTL_MS) {
      return cached.checks;
    }
    const checks = this.client.getPolicyEvaluations(projectId, prId).then(summarizeChecks, () => undefined);
    this.rememberChecks(key, checks);
    return checks;
  }

  /** Stores the entry; expired entries go first, then the oldest, so the cache never exceeds CHECKS_CACHE_MAX. */
  private rememberChecks(key: string, checks: Promise<ChecksSummary | undefined>): void {
    const now = Date.now();
    this.checksCache.delete(key);
    if (this.checksCache.size >= CHECKS_CACHE_MAX) {
      for (const [k, entry] of this.checksCache) {
        if (now - entry.at >= CHECKS_TTL_MS) {
          this.checksCache.delete(k);
        }
      }
    }
    while (this.checksCache.size >= CHECKS_CACHE_MAX) {
      const oldest = this.checksCache.keys().next();
      if (oldest.done) {
        break;
      }
      this.checksCache.delete(oldest.value);
    }
    this.checksCache.set(key, { at: now, checks });
  }

  /** Files of a PR's latest update with their reviewed check marks. */
  private async prFiles(repoId: string, prId: number) {
    const iteration = await this.client.getLatestIteration(repoId, prId);
    const changes = await this.client.getIterationChanges(repoId, prId, iteration);
    return {
      iteration,
      files: changes.toSorted((a, b) => a.item.path.localeCompare(b.item.path)).map(change => {
        const version = changeVersion(change);
        const reviewed = this.reviewed.isReviewed(repoId, prId, change.item.path, version);
        return { path: change.item.path, changeType: change.changeType, change, version, reviewed };
      }),
    };
  }

  /** `perProject` passes '' for a single project: that is the primary one. */
  private projectName(project: string): string {
    return project || this.connections.current?.project || '';
  }

  private multi(): boolean {
    return (this.connections.current?.projects.length ?? 0) > 1;
  }

  /**
   * Runs `fn` for every selected project (at most 4 at a time) and tags the results with their project when
   * there are several. A project that fails is skipped unless all of them fail.
   */
  private async perProject<T extends object>(fn: (client: AdoClient, project: string) => Promise<T[]>): Promise<(T & { project?: string })[]> {
    const projects = this.connections.current?.projects ?? [];
    if (projects.length <= 1) {
      return fn(this.client, projects[0] ?? '');
    }
    const results = await mapLimit(projects, 4, project => fn(this.client.forProject(project), project)
      .then(list => ({ list: list.map(x => ({ ...x, project })) }), (error: unknown) => ({ error, list: [] as (T & { project: string })[] })));
    const failed = results.find(r => 'error' in r);
    if (failed && results.every(r => 'error' in r)) {
      throw (failed as { error: unknown }).error;
    }
    return results.flatMap(r => r.list);
  }

  private builtinQueries(): BuiltinQuery[] {
    const custom = vscode.workspace.getConfiguration('azureDevOps').get<BuiltinQuery[]>('workItems.queries', []);
    return custom.length ? custom : DEFAULT_QUERIES;
  }

  private prDto(pr: PullRequest, meId: string) {
    return {
      id: pr.pullRequestId,
      repoId: pr.repository.id,
      repoName: pr.repository.name,
      title: pr.title,
      isDraft: !!pr.isDraft,
      author: pr.createdBy.displayName,
      created: pr.creationDate,
      source: shortRef(pr.sourceRefName),
      target: shortRef(pr.targetRefName),
      mergeStatus: pr.mergeStatus,
      myVote: pr.reviewers.find(r => r.id === meId)?.vote ?? 0,
      reviewers: pr.reviewers.map(r => ({ name: r.displayName, vote: r.vote, isContainer: !!r.isContainer, isRequired: !!r.isRequired })),
    };
  }

  private async workItemDto(w: WorkItem, client?: AdoClient) {
    const f = w.fields;
    const type = f['System.WorkItemType'];
    const project = String(f['System.TeamProject'] ?? '');
    const state = (await this.statesFor(project, String(type), client)).find(s => s.name === f['System.State']);
    return {
      id: w.id,
      title: f['System.Title'],
      type,
      state: f['System.State'],
      stateColor: state ? `#${state.color}` : undefined,
      stateCategory: state?.category,
      assignedTo: f['System.AssignedTo']?.displayName,
      changed: f['System.ChangedDate'],
      priority: f['Microsoft.VSTS.Common.Priority'],
      iteration: String(f['System.IterationPath'] ?? '').split('\\').pop(),
      tags: String(f['System.Tags'] ?? '').split(';').map(t => t.trim()).filter(Boolean),
      project: this.multi() ? project : undefined,
    };
  }
}

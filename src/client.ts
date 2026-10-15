import * as vscode from 'vscode';
import { Connection, ConnectionManager, isAzureDevOpsUrl } from './connection';
import * as T from './types';

const ADO_RESOURCE_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const API_VERSION = '7.1';
export const PAT_SECRET_KEY = 'azureDevOps.pat';

export class AdoError extends Error {
  constructor(message: string, readonly status: number, readonly isAuthError = false) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;
type Scope = 'org' | 'project';

const WORK_ITEM_FIELDS = [
  'System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo',
  'System.ChangedDate', 'System.IterationPath', 'System.AreaPath', 'System.Tags',
  'Microsoft.VSTS.Common.Priority',
];

export class AdoClient {
  private me?: Promise<T.IdentityRef>;

  constructor(private readonly secrets: vscode.SecretStorage, private readonly connections: ConnectionManager) {}

  get connection(): Connection {
    const c = this.connections.current;
    if (!c) {
      throw new AdoError('Azure DevOps is not configured yet.', 0);
    }
    return c;
  }

  reset(): void {
    this.me = undefined;
  }

  // ---------- auth & http ----------

  async signIn(): Promise<void> {
    await this.authHeader(true);
    this.reset();
  }

  private async authHeader(interactive: boolean): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('azureDevOps');
    if (cfg.get<string>('authMethod') === 'pat') {
      const pat = await this.secrets.get(PAT_SECRET_KEY);
      if (!pat) {
        throw new AdoError('No Personal Access Token stored.', 401, true);
      }
      return 'Basic ' + Buffer.from(':' + pat).toString('base64');
    }
    const scopes = [ADO_RESOURCE_SCOPE];
    const tenant = cfg.get<string>('tenantId', '').trim();
    if (tenant) {
      scopes.push(`VSCODE_TENANT:${tenant}`);
    }
    const session = await vscode.authentication.getSession('microsoft', scopes,
      interactive ? { createIfNone: true } : { createIfNone: false });
    if (!session) {
      throw new AdoError('Not signed in to Microsoft.', 401, true);
    }
    return 'Bearer ' + session.accessToken;
  }

  private url(scope: Scope, path: string, query: Query = {}): string {
    const c = this.connection;
    const root = scope === 'org' ? c.orgUrl : `${c.orgUrl}/${encodeURIComponent(c.project)}`;
    const u = new URL(`${root}/_apis/${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) {
        u.searchParams.set(k, String(v));
      }
    }
    if (!u.searchParams.has('api-version')) {
      u.searchParams.set('api-version', API_VERSION);
    }
    return u.toString();
  }

  private async request<R>(method: string, url: string, body?: unknown,
    opts: { contentType?: string; raw?: boolean } = {}): Promise<R> {
    if (!isAzureDevOpsUrl(url)) {
      throw new AdoError(`Refusing to send credentials to ${new URL(url).origin}: only https://dev.azure.com and *.visualstudio.com are supported.`, 0);
    }
    const headers: Record<string, string> = {
      Authorization: await this.authHeader(false),
      Accept: opts.raw ? 'text/plain, application/octet-stream' : 'application/json',
      'X-TFS-FedAuthRedirect': 'Suppress',
    };
    if (body !== undefined) {
      headers['Content-Type'] = opts.contentType ?? 'application/json';
    }
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const contentType = res.headers.get('content-type') ?? '';
    if (res.status === 401 || res.status === 203 || contentType.includes('text/html')) {
      throw new AdoError('Azure DevOps rejected the credentials.', 401, true);
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        message = (await res.json() as { message?: string }).message ?? message;
      } catch { /* not json */ }
      throw new AdoError(message, res.status);
    }
    if (opts.raw) {
      return await res.text() as R;
    }
    if (res.status === 204) {
      return undefined as R;
    }
    return await res.json() as R;
  }

  private get<R>(scope: Scope, path: string, query?: Query): Promise<R> {
    return this.request<R>('GET', this.url(scope, path, query));
  }

  // ---------- identity ----------

  getMe(): Promise<T.IdentityRef> {
    this.me ??= this.request<any>('GET', `${this.connection.orgUrl}/_apis/connectionData`).then(d => ({
      id: d.authenticatedUser.id,
      displayName: d.authenticatedUser.providerDisplayName ?? d.authenticatedUser.customDisplayName,
      uniqueName: d.authenticatedUser.properties?.Account?.$value,
    })).catch(e => {
      this.me = undefined;
      throw e;
    });
    return this.me;
  }

  /** Projects of the given organization (defaults to the current one; works before a project is chosen). */
  async listProjects(orgUrl = this.connection.orgUrl): Promise<string[]> {
    const u = new URL(`${orgUrl}/_apis/projects`);
    u.searchParams.set('$top', '500');
    u.searchParams.set('api-version', API_VERSION);
    const r = await this.request<{ value: { name: string }[] }>('GET', u.toString());
    return r.value.map(p => p.name).sort((a, b) => a.localeCompare(b));
  }

  // ---------- pull requests ----------

  async listPullRequests(criteria: { creatorId?: string; reviewerId?: string }): Promise<T.PullRequest[]> {
    const r = await this.get<{ value: T.PullRequest[] }>('project', 'git/pullrequests', {
      'searchCriteria.status': 'active',
      'searchCriteria.creatorId': criteria.creatorId,
      'searchCriteria.reviewerId': criteria.reviewerId,
      $top: 100,
    });
    return r.value;
  }

  /** All active pull requests of the project, for change detection. */
  async listActivePullRequests(top = 1000): Promise<T.PullRequest[]> {
    const r = await this.get<{ value: T.PullRequest[] }>('project', 'git/pullrequests', { 'searchCriteria.status': 'active', $top: top });
    return r.value;
  }

  getPullRequest(repoId: string, prId: number): Promise<T.PullRequest> {
    return this.get('project', `git/repositories/${repoId}/pullrequests/${prId}`);
  }

  async getLatestIteration(repoId: string, prId: number): Promise<number> {
    const r = await this.get<{ value: T.PrIteration[] }>('project', `git/repositories/${repoId}/pullRequests/${prId}/iterations`);
    return Math.max(...r.value.map(i => i.id));
  }

  async getIterationChanges(repoId: string, prId: number, iterationId: number): Promise<T.PrChange[]> {
    const all: T.PrChange[] = [];
    let skip = 0;
    for (;;) {
      const r = await this.get<{ changeEntries: T.PrChange[]; nextSkip?: number }>('project',
        `git/repositories/${repoId}/pullRequests/${prId}/iterations/${iterationId}/changes`,
        { $compareTo: 0, $top: 2000, $skip: skip });
      all.push(...r.changeEntries);
      if (!r.nextSkip) {
        return all.filter(c => !c.item.isFolder && c.item.gitObjectType !== 'tree');
      }
      skip = r.nextSkip;
    }
  }

  getBlobText(repoId: string, objectId: string): Promise<string> {
    return this.request('GET', this.url('project', `git/repositories/${repoId}/blobs/${objectId}`, { $format: 'octetstream' }),
      undefined, { raw: true });
  }

  async getThreads(repoId: string, prId: number): Promise<T.PrThread[]> {
    const r = await this.get<{ value: T.PrThread[] }>('project', `git/repositories/${repoId}/pullRequests/${prId}/threads`);
    return r.value.filter(t => !t.isDeleted);
  }

  createThread(repoId: string, prId: number, thread: unknown): Promise<T.PrThread> {
    return this.request('POST', this.url('project', `git/repositories/${repoId}/pullRequests/${prId}/threads`), thread);
  }

  replyToThread(repoId: string, prId: number, threadId: number, content: string): Promise<T.PrComment> {
    return this.request('POST', this.url('project', `git/repositories/${repoId}/pullRequests/${prId}/threads/${threadId}/comments`),
      { content, parentCommentId: 1, commentType: 1 });
  }

  editComment(repoId: string, prId: number, threadId: number, commentId: number, content: string): Promise<T.PrComment> {
    return this.request('PATCH', this.url('project', `git/repositories/${repoId}/pullRequests/${prId}/threads/${threadId}/comments/${commentId}`), { content });
  }

  async deleteComment(repoId: string, prId: number, threadId: number, commentId: number): Promise<void> {
    await this.request('DELETE', this.url('project', `git/repositories/${repoId}/pullRequests/${prId}/threads/${threadId}/comments/${commentId}`), undefined, { raw: true });
  }

  updateThreadStatus(repoId: string, prId: number, threadId: number, status: number): Promise<T.PrThread> {
    return this.request('PATCH', this.url('project', `git/repositories/${repoId}/pullRequests/${prId}/threads/${threadId}`), { status });
  }

  async vote(repoId: string, prId: number, vote: number): Promise<void> {
    const me = await this.getMe();
    await this.request('PUT', this.url('project', `git/repositories/${repoId}/pullRequests/${prId}/reviewers/${me.id}`), { vote });
  }

  updatePullRequest(repoId: string, prId: number, patch: unknown): Promise<T.PullRequest> {
    return this.request('PATCH', this.url('project', `git/repositories/${repoId}/pullrequests/${prId}`), patch);
  }

  async getPullRequestWorkItemIds(repoId: string, prId: number): Promise<number[]> {
    const r = await this.get<{ value: { id: string }[] }>('project', `git/repositories/${repoId}/pullRequests/${prId}/workitems`);
    return r.value.map(w => Number(w.id));
  }

  async getPolicyEvaluations(projectId: string, prId: number): Promise<T.PolicyEvaluation[]> {
    const r = await this.get<{ value: T.PolicyEvaluation[] }>('project', 'policy/evaluations',
      { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`, 'api-version': '7.1-preview.1' });
    return r.value;
  }

  // ---------- work items ----------

  /** timePrecision makes date comparisons in the query use the time of day, not just the date. */
  async queryWiql(wiql: string, opts: { top?: number; timePrecision?: boolean } = {}): Promise<number[]> {
    const r = await this.request<{ workItems: { id: number }[] }>('POST',
      this.url('project', 'wit/wiql', { $top: opts.top ?? 200, timePrecision: opts.timePrecision }), { query: wiql });
    return r.workItems.map(w => w.id);
  }

  async runSavedQuery(queryId: string): Promise<number[]> {
    const r = await this.get<{ workItems?: { id: number }[]; workItemRelations?: { target?: { id: number } }[] }>(
      'project', `wit/wiql/${queryId}`, { $top: 200 });
    const ids = r.workItems?.map(w => w.id) ?? r.workItemRelations?.flatMap(w => w.target ? [w.target.id] : []) ?? [];
    return [...new Set(ids)];
  }

  /** Flattened list of all saved (non-folder) queries in "My Queries" and "Shared Queries". */
  async listSavedQueries(): Promise<T.QueryItem[]> {
    const out: T.QueryItem[] = [];
    const visit = async (items: T.QueryItem[]) => {
      for (const item of items) {
        if (!item.isFolder) {
          out.push(item);
        } else if (item.children) {
          await visit(item.children);
        } else if (item.hasChildren) {
          const folder = await this.get<T.QueryItem>('project', `wit/queries/${item.id}`, { $depth: 2 });
          await visit(folder.children ?? []);
        }
      }
    };
    const root = await this.get<{ value: T.QueryItem[] }>('project', 'wit/queries', { $depth: 2 });
    await visit(root.value);
    return out;
  }

  async getWorkItems(ids: number[], extraFields: string[] = []): Promise<T.WorkItem[]> {
    const out: T.WorkItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const r = await this.get<{ value: (T.WorkItem | null)[] }>('org', 'wit/workitems', {
        ids: ids.slice(i, i + 200).join(','),
        fields: [...WORK_ITEM_FIELDS, ...extraFields].join(','),
        errorPolicy: 'omit',
      });
      out.push(...r.value.filter((w): w is T.WorkItem => !!w));
    }
    return out;
  }

  /** The latest updates of a work item (field changes per revision), oldest first. */
  async getWorkItemUpdates(id: number, rev: number, count = 50): Promise<T.WorkItemUpdate[]> {
    const r = await this.get<{ value: T.WorkItemUpdate[] }>('org', `wit/workItems/${id}/updates`, { $skip: Math.max(0, rev - count), $top: count });
    return r.value;
  }

  getWorkItem(id: number): Promise<T.WorkItem> {
    return this.get('org', `wit/workitems/${id}`, { $expand: 'relations' });
  }

  /** Work items for a link picker: by ID when numeric, else by title; recent ones assigned to me when empty. */
  async searchWorkItems(text: string): Promise<T.WorkItem[]> {
    const t = text.trim().replace(/^#/, '');
    const where = /^\d+$/.test(t) ? `[System.Id] = ${t}`
      : t ? `[System.TeamProject] = @project AND [System.Title] CONTAINS '${t.replace(/'/g, "''")}'`
        : `[System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed')`;
    const ids = await this.queryWiql(`SELECT [System.Id] FROM WorkItems WHERE ${where} ORDER BY [System.ChangedDate] DESC`);
    return this.getWorkItems(ids.slice(0, 20));
  }

  /** Links a work item and a pull request (the same artifact link the web UI creates). */
  async linkPullRequest(workItemId: number, pr: PrArtifact): Promise<void> {
    await this.request('PATCH', this.url('org', `wit/workitems/${workItemId}`), [{
      op: 'add', path: '/relations/-',
      value: { rel: 'ArtifactLink', url: prArtifactUrl(pr), attributes: { name: 'Pull Request' } },
    }], { contentType: 'application/json-patch+json' });
  }

  async unlinkPullRequest(workItemId: number, pr: PrArtifact): Promise<void> {
    const w = await this.getWorkItem(workItemId);
    const index = (w.relations ?? []).findIndex(r => sameArtifact(r.url, pr));
    if (index < 0) {
      return;
    }
    await this.request('PATCH', this.url('org', `wit/workitems/${workItemId}`), [
      { op: 'test', path: '/rev', value: w.rev },
      { op: 'remove', path: `/relations/${index}` },
    ], { contentType: 'application/json-patch+json' });
  }

  /** Pull request by ID alone (works across projects of the organization). */
  getPullRequestById(prId: number): Promise<T.PullRequest> {
    return this.get('org', `git/pullrequests/${prId}`);
  }

  updateWorkItem(id: number, fields: Record<string, unknown>): Promise<T.WorkItem> {
    const ops = Object.entries(fields).map(([k, value]) => ({ op: 'add', path: `/fields/${k}`, value }));
    return this.request('PATCH', this.url('org', `wit/workitems/${id}`), ops, { contentType: 'application/json-patch+json' });
  }

  createWorkItem(type: string, fields: Record<string, unknown>): Promise<T.WorkItem> {
    const ops = Object.entries(fields).map(([k, value]) => ({ op: 'add', path: `/fields/${k}`, value }));
    return this.request('POST', this.url('project', `wit/workitems/$${encodeURIComponent(type)}`), ops,
      { contentType: 'application/json-patch+json' });
  }

  async getWorkItemTypes(): Promise<string[]> {
    const r = await this.get<{ value: { name: string; isDisabled?: boolean }[] }>('project', 'wit/workitemtypes');
    return r.value.filter(t => !t.isDisabled).map(t => t.name);
  }

  async getWorkItemStates(type: string): Promise<T.WorkItemState[]> {
    const r = await this.get<{ value: T.WorkItemState[] }>('project', `wit/workitemtypes/${encodeURIComponent(type)}/states`);
    return r.value;
  }

  async getWorkItemComments(id: number): Promise<T.WorkItemComment[]> {
    const r = await this.get<{ comments: T.WorkItemComment[] }>('project', `wit/workItems/${id}/comments`,
      { 'api-version': '7.1-preview.4' });
    return r.comments;
  }

  addWorkItemComment(id: number, text: string): Promise<unknown> {
    return this.request('POST', this.url('project', `wit/workItems/${id}/comments`, { 'api-version': '7.1-preview.4' }), { text });
  }

  // ---------- pipelines ----------

  async listDefinitions(): Promise<T.BuildDefinition[]> {
    const r = await this.get<{ value: T.BuildDefinition[] }>('project', 'build/definitions', {
      includeLatestBuilds: true, queryOrder: 'definitionNameAscending', $top: 500,
    });
    return r.value;
  }

  getDefinition(id: number): Promise<T.BuildDefinition> {
    return this.get('project', `build/definitions/${id}`);
  }

  async listBuilds(opts: { definitionId?: number; requestedFor?: string; top?: number }): Promise<T.Build[]> {
    const r = await this.get<{ value: T.Build[] }>('project', 'build/builds', {
      definitions: opts.definitionId,
      requestedFor: opts.requestedFor,
      $top: opts.top ?? 25,
      queryOrder: 'queueTimeDescending',
    });
    return r.value;
  }

  getBuild(id: number): Promise<T.Build> {
    return this.get('project', `build/builds/${id}`);
  }

  async getTimeline(buildId: number): Promise<T.TimelineRecord[]> {
    const r = await this.get<{ records: T.TimelineRecord[] } | undefined>('project', `build/builds/${buildId}/timeline`);
    return r?.records ?? [];
  }

  async getBuildLogs(buildId: number): Promise<T.BuildLog[]> {
    const r = await this.get<{ value: T.BuildLog[] }>('project', `build/builds/${buildId}/logs`);
    return r.value;
  }

  async getLogLines(buildId: number, logId: number): Promise<string[]> {
    const r = await this.get<{ value: string[] }>('project', `build/builds/${buildId}/logs/${logId}`);
    return r.value;
  }

  queueBuild(definitionId: number, sourceBranch: string): Promise<T.Build> {
    return this.request('POST', this.url('project', 'build/builds'), { definition: { id: definitionId }, sourceBranch });
  }

  /** Queues a classic (designer) pipeline with queue-time variables. */
  queueClassicBuild(definitionId: number, sourceBranch: string, variables: Record<string, string>, sourceVersion?: string): Promise<T.Build> {
    return this.request('POST', this.url('project', 'build/builds'), {
      definition: { id: definitionId }, sourceBranch, sourceVersion: sourceVersion || undefined,
      parameters: Object.keys(variables).length ? JSON.stringify(variables) : undefined,
    });
  }

  /** Runs a YAML pipeline with runtime parameters and variables; the run id is the build id. */
  async runPipeline(pipelineId: number, opts: {
    refName: string; version?: string; templateParameters: Record<string, string>; variables: Record<string, string>;
  }): Promise<{ id: number; name: string }> {
    return this.request('POST', this.url('project', `pipelines/${pipelineId}/runs`), {
      resources: { repositories: { self: { refName: opts.refName, version: opts.version || undefined } } },
      templateParameters: opts.templateParameters,
      variables: Object.fromEntries(Object.entries(opts.variables).map(([k, value]) => [k, { value }])),
    });
  }

  async listRepositoryNames(): Promise<string[]> {
    const r = await this.get<{ value: { name: string }[] }>('project', 'git/repositories');
    return r.value.map(x => x.name).sort((a, b) => a.localeCompare(b));
  }

  async listBranches(repoId: string): Promise<string[]> {
    const r = await this.get<{ value: { name: string }[] }>('project', `git/repositories/${repoId}/refs`, { filter: 'heads/', $top: 1000 });
    return r.value.map(b => b.name.replace(/^refs\/heads\//, '')).sort((a, b) => a.localeCompare(b));
  }

  /** Text content of a file in an Azure Repos repository at a branch. */
  async getFileText(repoId: string, path: string, branch: string): Promise<string> {
    const r = await this.get<{ content?: string }>('project', `git/repositories/${repoId}/items`, {
      path, includeContent: true, 'versionDescriptor.version': branch, 'versionDescriptor.versionType': 'branch',
    });
    return r.content ?? '';
  }

  cancelBuild(buildId: number): Promise<T.Build> {
    return this.request('PATCH', this.url('project', `build/builds/${buildId}`), { status: 'cancelling' });
  }

  // ---------- web links ----------

  webUrl(kind: 'pr' | 'workItem' | 'build' | 'definition', a: string | number, b?: number): string {
    const c = this.connection;
    const p = `${c.orgUrl}/${encodeURIComponent(c.project)}`;
    switch (kind) {
      case 'pr': return `${p}/_git/${encodeURIComponent(String(a))}/pullrequest/${b}`;
      case 'workItem': return `${p}/_workitems/edit/${a}`;
      case 'build': return `${p}/_build/results?buildId=${a}`;
      case 'definition': return `${p}/_build?definitionId=${a}`;
    }
  }
}

export interface PrArtifact {
  projectId: string;
  repoId: string;
  prId: number;
}

const PR_ARTIFACT = 'vstfs:///Git/PullRequestId/';

export function prArtifactUrl(pr: PrArtifact): string {
  return `${PR_ARTIFACT}${pr.projectId}%2F${pr.repoId}%2F${pr.prId}`;
}

/** Parses a work item relation URL pointing at a pull request. */
export function parsePrArtifact(url: string): PrArtifact | undefined {
  if (!url.toLowerCase().startsWith(PR_ARTIFACT.toLowerCase())) {
    return undefined;
  }
  const [projectId, repoId, prId] = decodeURIComponent(url.slice(PR_ARTIFACT.length)).split('/');
  return projectId && repoId && Number(prId) ? { projectId, repoId, prId: Number(prId) } : undefined;
}

function sameArtifact(url: string, pr: PrArtifact): boolean {
  const a = parsePrArtifact(url);
  return !!a && a.prId === pr.prId && a.repoId.toLowerCase() === pr.repoId.toLowerCase();
}

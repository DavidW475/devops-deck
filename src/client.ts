import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import * as vscode from 'vscode';
import { Connection, ConnectionManager, isAzureDevOpsUrl } from './connection';
import * as T from './types';

const ADO_RESOURCE_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const API_VERSION = '7.1';
/** A hung connection must not block polling loops (watchers, log streaming) forever. */
const REQUEST_TIMEOUT_MS = 60_000;
export const PAT_SECRET_KEY = 'azureDevOps.pat';

export class AdoError extends Error {
  constructor(message: string, readonly status: number, readonly isAuthError = false) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;
type Scope = 'org' | 'project';

const WORK_ITEM_FIELDS = [
  'System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo', 'System.TeamProject',
  'System.ChangedDate', 'System.IterationPath', 'System.AreaPath', 'System.Tags',
  'Microsoft.VSTS.Common.Priority',
];

/**
 * Ids from webviews and API responses end up in request paths. A segment that is empty, "." or ".." (also percent-encoded)
 * or contains "?", "#" or "\\" would point the request at another route, so such paths are refused.
 */
export function isSafeApiPath(path: string): boolean {
  return path.split('/').every(seg => {
    if (!seg || /[?#\\]/.test(seg)) {
      return false;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return false;
    }
    return decoded !== '.' && decoded !== '..';
  });
}

function assertSafePath(path: string): void {
  if (!isSafeApiPath(path)) {
    throw new AdoError('Invalid request path.', 400);
  }
}

/** Repository IDs (GUIDs) work in organization-wide routes, so repository calls do not depend on the project. */
const REPO_BY_ID = /^git\/repositories\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i;

export class AdoClient {
  private me?: Promise<T.IdentityRef>;
  private readonly scoped = new Map<string, AdoClient>();

  constructor(private readonly secrets: vscode.SecretStorage, private readonly connections: Pick<ConnectionManager, 'current'>,
    private readonly parent?: AdoClient) {}

  get connection(): Connection {
    const c = this.connections.current;
    if (!c) {
      throw new AdoError('Azure DevOps is not configured yet.', 0);
    }
    return c;
  }

  /**
   * The same client for another project of the organization (for project-bound APIs such as builds or
   * work item types). Without a project, or for the current one, returns this client.
   */
  forProject(project?: string): AdoClient {
    const root = this.parent ?? this;
    const c = root.connections.current;
    if (!project || !c || project.toLowerCase() === c.project.toLowerCase()) {
      return root;
    }
    let client = root.scoped.get(project.toLowerCase());
    if (!client) {
      const connections = { get current() { const cur = root.connections.current; return cur && { ...cur, project }; } };
      client = new AdoClient(root.secrets, connections, root);
      root.scoped.set(project.toLowerCase(), client);
    }
    return client;
  }

  reset(): void {
    this.me = undefined;
    this.scoped.clear();
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

  private url(scope: Scope, path: string, query: Query = {}, project?: string): string {
    const c = this.connection;
    const root = scope === 'org' || REPO_BY_ID.test(path) ? c.orgUrl : `${c.orgUrl}/${encodeURIComponent(project ?? c.project)}`;
    assertSafePath(root === c.orgUrl ? path : `${encodeURIComponent(project ?? c.project)}/${path}`);
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
    opts: { contentType?: string; raw?: boolean; headers?: Record<string, string> } = {}): Promise<R> {
    const res = await this.send(method, url, body, opts);
    if (opts.raw) {
      return await res.text() as R;
    }
    if (res.status === 204) {
      return undefined as R;
    }
    return await res.json() as R;
  }

  /** Sends a request with credentials; only to Azure DevOps hosts. Non-2xx answers become AdoErrors. */
  private async send(method: string, url: string, body?: unknown,
    opts: { contentType?: string; raw?: boolean; binary?: boolean; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
    if (!isAzureDevOpsUrl(url)) {
      throw new AdoError(`Refusing to send credentials to ${new URL(url).origin}: only https://dev.azure.com and *.visualstudio.com are supported.`, 0);
    }
    let accept = 'application/json';
    if (opts.binary) {
      accept = 'application/zip, application/octet-stream';
    } else if (opts.raw) {
      accept = 'text/plain, application/octet-stream';
    }
    const headers: Record<string, string> = {
      Authorization: await this.authHeader(false),
      Accept: accept,
      'X-TFS-FedAuthRedirect': 'Suppress',
      ...opts.headers,
    };
    if (body !== undefined) {
      headers['Content-Type'] = opts.contentType ?? 'application/json';
    }
    // fetch drops the Authorization header on redirects to other origins (e.g. blob storage for artifacts).
    const res = await fetch(url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
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
    return res;
  }

  private get<R>(scope: Scope, path: string, query?: Query): Promise<R> {
    return this.request<R>('GET', this.url(scope, path, query));
  }

  // ---------- identity ----------

  getMe(): Promise<T.IdentityRef> {
    if (this.parent) {
      return this.parent.getMe();
    }
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
    const iterations = await this.getIterations(repoId, prId);
    if (!iterations.length) {
      throw new AdoError(`Pull request !${prId} has no iterations yet.`, 404);
    }
    return Math.max(...iterations.map(i => i.id));
  }

  async getIterations(repoId: string, prId: number): Promise<T.PrIteration[]> {
    const r = await this.get<{ value: T.PrIteration[] }>('project', `git/repositories/${repoId}/pullRequests/${prId}/iterations`);
    return r.value;
  }

  /** Files changed in an iteration, compared with the target branch (compareTo 0) or an earlier iteration. */
  async getIterationChanges(repoId: string, prId: number, iterationId: number, compareTo = 0): Promise<T.PrChange[]> {
    const all: T.PrChange[] = [];
    let skip = 0;
    for (;;) {
      const r = await this.get<{ changeEntries: T.PrChange[]; nextSkip?: number }>('project',
        `git/repositories/${repoId}/pullRequests/${prId}/iterations/${iterationId}/changes`,
        { $compareTo: compareTo, $top: 2000, $skip: skip });
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
    // The PR's own project (by ID) in the route, so this works for PRs of every selected project.
    const r = await this.request<{ value: T.PolicyEvaluation[] }>('GET', this.url('project', 'policy/evaluations',
      { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`, 'api-version': '7.1-preview.1' }, projectId));
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
    let where = `[System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed')`;
    if (/^\d+$/.test(t)) {
      where = `[System.Id] = ${t}`;
    } else if (t) {
      where = `[System.TeamProject] = @project AND [System.Title] CONTAINS '${t.replaceAll("'", "''")}'`;
    }
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

  /** Removes relation number `index`; `rev` guards against concurrent edits. */
  async removeWorkItemRelation(id: number, rev: number, index: number): Promise<void> {
    await this.request('PATCH', this.url('org', `wit/workitems/${id}`), [
      { op: 'test', path: '/rev', value: rev },
      { op: 'remove', path: `/relations/${index}` },
    ], { contentType: 'application/json-patch+json' });
  }

  /** Pull request by ID alone (works across projects of the organization). */
  getPullRequestById(prId: number): Promise<T.PullRequest> {
    return this.get('org', `git/pullrequests/${prId}`);
  }

  /** Sets fields; `null` removes a field's value. */
  updateWorkItem(id: number, fields: Record<string, unknown>): Promise<T.WorkItem> {
    return this.request('PATCH', this.url('org', `wit/workitems/${id}`), fieldOps(fields), { contentType: 'application/json-patch+json' });
  }

  /** Creates a work item; `parentId` adds a parent link (e.g. a task below a user story). */
  createWorkItem(type: string, fields: Record<string, unknown>, opts: { parentId?: number; hyperlink?: string } = {}): Promise<T.WorkItem> {
    const ops: unknown[] = fieldOps(fields);
    if (opts.parentId) {
      ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${this.connection.orgUrl}/_apis/wit/workItems/${opts.parentId}` } });
    }
    if (opts.hyperlink) {
      ops.push({ op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url: opts.hyperlink } });
    }
    return this.request('POST', this.url('project', `wit/workitems/$${encodeURIComponent(type)}`), ops,
      { contentType: 'application/json-patch+json' });
  }

  async getWorkItemTypes(): Promise<string[]> {
    const r = await this.get<{ value: { name: string; isDisabled?: boolean }[] }>('project', 'wit/workitemtypes');
    return r.value.filter(t => !t.isDisabled).map(t => t.name);
  }

  /** Fields of a work item type with their allowed values (e.g. priorities). */
  async getWorkItemTypeFields(type: string): Promise<T.WorkItemTypeField[]> {
    const r = await this.get<{ value: T.WorkItemTypeField[] }>('project', `wit/workitemtypes/${encodeURIComponent(type)}/fields`, { $expand: 'allowedValues' });
    return r.value;
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

  async listBuilds(opts: { definitionId?: number; requestedFor?: string; branchName?: string; top?: number }): Promise<T.Build[]> {
    const r = await this.get<{ value: T.Build[] }>('project', 'build/builds', {
      definitions: opts.definitionId,
      requestedFor: opts.requestedFor,
      branchName: opts.branchName,
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

  // ---------- identities ----------

  /** People and groups of the organization, like the web UI's identity picker. */
  async searchIdentities(query: string): Promise<T.Identity[]> {
    const r = await this.request<{ results?: { identities?: any[] }[] }>('POST',
      this.url('org', 'IdentityPicker/Identities', { 'api-version': '7.1-preview.1' }), {
        query, identityTypes: ['user', 'group'], operationScopes: ['ims', 'source'],
        options: { MinResults: 5, MaxResults: 20 }, properties: ['DisplayName', 'Mail', 'SignInAddress', 'Active'],
      });
    return (r.results?.[0]?.identities ?? [])
      .filter(i => i.localId && i.active !== false)
      .map(i => ({
        id: String(i.localId), displayName: String(i.displayName ?? ''), uniqueName: i.signInAddress || i.mail || undefined,
        mail: i.mail || undefined, isGroup: i.entityType === 'Group',
      }));
  }

  // ---------- pull requests: create, reviewers, auto-complete, commits ----------

  createPullRequest(repoId: string, pr: {
    sourceRefName: string; targetRefName: string; title: string; description?: string; isDraft?: boolean;
    reviewers?: { id: string; isRequired?: boolean }[]; workItemRefs?: { id: string }[];
  }): Promise<T.PullRequest> {
    return this.request('POST', this.url('project', `git/repositories/${repoId}/pullrequests`, { supportsIterations: true }), pr);
  }

  /** Active pull requests from a branch, newest first. */
  async findPullRequestsForBranch(repoId: string, branch: string): Promise<T.PullRequest[]> {
    const r = await this.get<{ value: T.PullRequest[] }>('project', `git/repositories/${repoId}/pullrequests`, {
      'searchCriteria.status': 'active', 'searchCriteria.sourceRefName': refName(branch), $top: 10,
    });
    return r.value;
  }

  async addReviewer(repoId: string, prId: number, reviewerId: string, isRequired: boolean): Promise<void> {
    await this.request('PUT', this.url('project', `git/repositories/${repoId}/pullRequests/${prId}/reviewers/${reviewerId}`), { vote: 0, isRequired });
  }

  async removeReviewer(repoId: string, prId: number, reviewerId: string): Promise<void> {
    await this.request('DELETE', this.url('project', `git/repositories/${repoId}/pullRequests/${prId}/reviewers/${reviewerId}`), undefined, { raw: true });
  }

  /** Turns auto-complete on (completes once all policies pass) or off. */
  async setAutoComplete(repoId: string, prId: number, options: T.PrCompletionOptions | undefined): Promise<T.PullRequest> {
    if (!options) {
      return this.updatePullRequest(repoId, prId, { autoCompleteSetBy: { id: '00000000-0000-0000-0000-000000000000' } });
    }
    const me = await this.getMe();
    return this.updatePullRequest(repoId, prId, { autoCompleteSetBy: { id: me.id }, completionOptions: options });
  }

  async getPullRequestCommits(repoId: string, prId: number): Promise<T.GitCommitRef[]> {
    const r = await this.get<{ value: T.GitCommitRef[] }>('project', `git/repositories/${repoId}/pullRequests/${prId}/commits`, { $top: 250 });
    return r.value;
  }

  // ---------- repositories & branches ----------

  async listRepositories(): Promise<T.GitRepository[]> {
    const r = await this.get<{ value: T.GitRepository[] }>('project', 'git/repositories');
    return r.value.filter(x => !x.isDisabled).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A repository by name or ID. */
  getRepository(nameOrId: string): Promise<T.GitRepository> {
    return this.get('project', `git/repositories/${encodeURIComponent(nameOrId)}`);
  }

  /** All branches with ahead/behind counts relative to `base`. */
  async getBranchStats(repoId: string, base: string): Promise<T.BranchStats[]> {
    const r = await this.get<{ value: T.BranchStats[] }>('project', `git/repositories/${repoId}/stats/branches`, {
      'baseVersionDescriptor.version': base, 'baseVersionDescriptor.versionType': 'branch',
    });
    return r.value;
  }

  /** Creates (oldObjectId all zeros) or deletes (newObjectId all zeros) a branch on the server. */
  async updateRef(repoId: string, branch: string, oldObjectId: string, newObjectId: string): Promise<void> {
    const r = await this.request<{ value: { success: boolean; updateStatus?: string; customMessage?: string }[] }>('POST',
      this.url('project', `git/repositories/${repoId}/refs`), [{ name: refName(branch), oldObjectId, newObjectId }]);
    const result = r.value[0];
    if (!result?.success) {
      throw new AdoError(result?.customMessage || `Could not update ${branch}: ${result?.updateStatus ?? 'unknown error'}`, 409);
    }
  }

  /** Files that differ between two branches (`target` compared with `base`). */
  async diffBranches(repoId: string, base: string, target: string): Promise<{ aheadCount?: number; behindCount?: number; changes: T.GitChange[] }> {
    const all: T.GitChange[] = [];
    let first: { aheadCount?: number; behindCount?: number } | undefined;
    for (let skip = 0; ; skip += 1000) {
      const r = await this.get<{ aheadCount?: number; behindCount?: number; changes: T.GitChange[]; allChangesIncluded?: boolean }>('project',
        `git/repositories/${repoId}/diffs/commits`, {
          baseVersion: base, baseVersionType: 'branch', targetVersion: target, targetVersionType: 'branch', $top: 1000, $skip: skip,
        });
      first ??= r;
      all.push(...r.changes);
      if (r.allChangesIncluded !== false || r.changes.length < 1000) {
        break;
      }
    }
    return { aheadCount: first?.aheadCount, behindCount: first?.behindCount, changes: all.filter(c => !c.item.isFolder && c.item.gitObjectType !== 'tree') };
  }

  // ---------- teams & sprints ----------

  async listTeams(): Promise<T.TeamRef[]> {
    const project = encodeURIComponent(this.connection.project);
    const [mine, all] = await Promise.all([
      this.get<{ value: T.TeamRef[] }>('org', `projects/${project}/teams`, { $mine: true, $top: 100 }).catch(() => ({ value: [] as T.TeamRef[] })),
      this.get<{ value: T.TeamRef[] }>('org', `projects/${project}/teams`, { $top: 300 }),
    ]);
    const mineIds = new Set(mine.value.map(t => t.id));
    // Own teams first.
    return [...all.value].sort((a, b) => Number(mineIds.has(b.id)) - Number(mineIds.has(a.id)) || a.name.localeCompare(b.name));
  }

  async listTeamIterations(team: string): Promise<T.TeamIteration[]> {
    const r = await this.request<{ value: T.TeamIteration[] }>('GET', this.teamUrl(team, 'work/teamsettings/iterations'));
    return r.value;
  }

  async getIterationWorkItems(team: string, iterationId: string): Promise<T.IterationWorkItemLink[]> {
    const r = await this.request<{ workItemRelations: T.IterationWorkItemLink[] }>('GET',
      this.teamUrl(team, `work/teamsettings/iterations/${iterationId}/workitems`));
    return r.workItemRelations ?? [];
  }

  /** Capacity per team member; empty when the team does not plan capacity. */
  async getCapacities(team: string, iterationId: string): Promise<T.TeamMemberCapacity[]> {
    const r = await this.request<{ teamMembers?: T.TeamMemberCapacity[]; value?: T.TeamMemberCapacity[] }>('GET',
      this.teamUrl(team, `work/teamsettings/iterations/${iterationId}/capacities`));
    return r.teamMembers ?? r.value ?? [];
  }

  async getTeamDaysOff(team: string, iterationId: string): Promise<{ start: string; end: string }[]> {
    const r = await this.request<{ daysOff?: { start: string; end: string }[] }>('GET',
      this.teamUrl(team, `work/teamsettings/iterations/${iterationId}/teamdaysoff`));
    return r.daysOff ?? [];
  }

  /** Iteration or area paths of the project, e.g. "Fabrikam\\Sprint 1". */
  async listClassificationPaths(group: 'Iterations' | 'Areas'): Promise<string[]> {
    const root = await this.get<T.ClassificationNode>('project', `wit/classificationnodes/${group}`, { $depth: 10 });
    const out: string[] = [];
    const visit = (node: T.ClassificationNode, path: string) => {
      out.push(path);
      for (const c of node.children ?? []) {
        visit(c, `${path}\\${c.name}`);
      }
    };
    visit(root, root.name);
    return out;
  }

  // ---------- pipelines: dependencies, approvals, stages, artifacts, tests ----------

  /** A YAML pipeline run with the parameters and source version it was started with. */
  getPipelineRun(pipelineId: number, runId: number): Promise<{
    templateParameters?: Record<string, unknown>; resources?: { repositories?: Record<string, { refName?: string; version?: string }> };
  }> {
    return this.get('project', `pipelines/${pipelineId}/runs/${runId}`);
  }

  /** The fully expanded YAML (templates resolved) a run would use, without starting it. */
  async previewPipeline(pipelineId: number, refName: string, version: string | undefined, templateParameters?: Record<string, unknown>,
    yamlOverride?: string): Promise<string> {
    const r = await this.request<{ finalYaml?: string }>('POST', this.url('project', `pipelines/${pipelineId}/preview`, { 'api-version': '7.1-preview.1' }), {
      previewRun: true, resources: { repositories: { self: { refName, version } } }, templateParameters, yamlOverride,
    });
    return r.finalYaml ?? '';
  }

  /** Text of a file at a commit. */
  async getFileTextAtCommit(repoId: string, path: string, commit: string): Promise<string> {
    const r = await this.get<{ content?: string }>('project', `git/repositories/${repoId}/items`, {
      path, includeContent: true, 'versionDescriptor.version': commit, 'versionDescriptor.versionType': 'commit',
    });
    return r.content ?? '';
  }

  /**
   * Text of a file at a repository resource `ref`: `refs/heads/x` or a plain name = branch, `refs/tags/x` = tag,
   * a full SHA = commit, none = the default branch.
   */
  async getFileTextAtRef(repoId: string, path: string, ref?: string): Promise<string> {
    const r = await this.get<{ content?: string }>('project', `git/repositories/${repoId}/items`, { path, includeContent: true, ...versionQuery(ref) });
    return r.content ?? '';
  }

  /** YAML pipelines whose file lives in an Azure Repos repository (with `process.yamlFilename`). */
  async listYamlDefinitions(repoId: string): Promise<T.BuildDefinition[]> {
    const r = await this.get<{ value: T.BuildDefinition[] }>('project', 'build/definitions', {
      repositoryId: repoId, repositoryType: 'TfsGit', includeAllProperties: true, $top: 500,
    });
    return r.value.filter(d => d.process?.type === 2);
  }

  async listPendingApprovals(): Promise<T.Approval[]> {
    const r = await this.get<{ value: T.Approval[] }>('project', 'pipelines/approvals',
      { state: 'pending', $expand: 'steps', 'api-version': '7.1-preview.1' });
    return r.value;
  }

  getApproval(approvalId: string): Promise<T.Approval> {
    return this.get('project', `pipelines/approvals/${approvalId}`, { $expand: 'steps', 'api-version': '7.1-preview.1' });
  }

  async updateApproval(approvalId: string, status: 'approved' | 'rejected', comment: string): Promise<void> {
    await this.request('PATCH', this.url('project', 'pipelines/approvals', { 'api-version': '7.1-preview.1' }), [{ approvalId, status, comment }]);
  }

  /** Re-runs the failed (or, with forceAll, all) jobs of a stage in a finished run. */
  async retryStage(buildId: number, stageRefName: string, forceAll = false): Promise<void> {
    await this.request('PATCH', this.url('project', `build/builds/${buildId}/stages/${encodeURIComponent(stageRefName)}`, { 'api-version': '7.1-preview.1' }),
      { state: 'retry', forceRetryAllJobs: forceAll });
  }

  async listArtifacts(buildId: number): Promise<T.BuildArtifact[]> {
    const r = await this.get<{ value: T.BuildArtifact[] }>('project', `build/builds/${buildId}/artifacts`);
    return r.value;
  }

  /** Streams a file from Azure DevOps (e.g. an artifact as zip) to disk, without holding it in memory. */
  async downloadTo(url: string, target: string): Promise<void> {
    const res = await this.send('GET', url, undefined, { binary: true, timeoutMs: 30 * 60_000 });
    if (!res.body) {
      throw new AdoError('The download is empty.', res.status);
    }
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(target));
  }

  async listTestRuns(buildId: number): Promise<T.TestRun[]> {
    const r = await this.get<{ value: T.TestRun[] }>('project', 'test/runs', { buildUri: `vstfs:///Build/Build/${buildId}`, includeRunDetails: true });
    return r.value;
  }

  async listFailedTestResults(runId: number): Promise<T.TestResult[]> {
    const r = await this.get<{ value: T.TestResult[] }>('project', `test/Runs/${runId}/results`, { outcomes: 'Failed', $top: 200 });
    return r.value;
  }

  /** Builds that finished (or, with 'started', started) after `since`, newest first. */
  async listBuildsSince(since: Date, order: 'finished' | 'started'): Promise<T.Build[]> {
    const r = await this.get<{ value: T.Build[] }>('project', 'build/builds', {
      minTime: since.toISOString(), queryOrder: order === 'finished' ? 'finishTimeDescending' : 'startTimeDescending',
      statusFilter: order === 'finished' ? 'completed' : undefined, $top: 200,
    });
    return r.value;
  }

  // ---------- wiki ----------

  async listWikis(): Promise<T.Wiki[]> {
    const r = await this.get<{ value: T.Wiki[] }>('project', 'wiki/wikis');
    return r.value;
  }

  getWikiPageTree(wikiId: string): Promise<T.WikiPage> {
    return this.get('project', `wiki/wikis/${encodeURIComponent(wikiId)}/pages`, { path: '/', recursionLevel: 'full' });
  }

  /** Page content and its ETag, which a later save needs to detect concurrent edits. */
  async getWikiPage(wikiId: string, path: string): Promise<{ content: string; etag?: string }> {
    const res = await this.send('GET', this.url('project', `wiki/wikis/${encodeURIComponent(wikiId)}/pages`, { path, includeContent: true }));
    const page = await res.json() as T.WikiPage;
    return { content: page.content ?? '', etag: res.headers.get('etag') ?? undefined };
  }

  /** Creates (no etag) or updates a page; returns the new ETag. */
  async saveWikiPage(wikiId: string, path: string, content: string, etag?: string): Promise<string | undefined> {
    const res = await this.send('PUT', this.url('project', `wiki/wikis/${encodeURIComponent(wikiId)}/pages`, { path }), { content },
      { headers: etag ? { 'If-Match': etag } : {} });
    return res.headers.get('etag') ?? undefined;
  }

  private teamUrl(team: string, path: string, query: Query = {}): string {
    const c = this.connection;
    assertSafePath(`${encodeURIComponent(c.project)}/${encodeURIComponent(team)}/${path}`);
    const u = new URL(`${c.orgUrl}/${encodeURIComponent(c.project)}/${encodeURIComponent(team)}/_apis/${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) {
        u.searchParams.set(k, String(v));
      }
    }
    u.searchParams.set('api-version', API_VERSION);
    return u.toString();
  }

  // ---------- web links ----------

  webUrl(kind: 'pr' | 'workItem' | 'build' | 'definition' | 'repo', a: string | number, b?: number, project?: string): string {
    const c = this.connection;
    const p = `${c.orgUrl}/${encodeURIComponent(project ?? c.project)}`;
    switch (kind) {
      case 'pr': return `${p}/_git/${encodeURIComponent(String(a))}/pullrequest/${b}`;
      case 'workItem': return `${p}/_workitems/edit/${a}`;
      case 'build': return `${p}/_build/results?buildId=${a}`;
      case 'definition': return `${p}/_build?definitionId=${a}`;
      case 'repo': return `${p}/_git/${encodeURIComponent(String(a))}`;
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

function versionQuery(ref: string | undefined): Query {
  if (!ref) {
    return {};
  }
  if (ref.startsWith('refs/tags/')) {
    return { 'versionDescriptor.version': ref.slice(10), 'versionDescriptor.versionType': 'tag' };
  }
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    return { 'versionDescriptor.version': ref, 'versionDescriptor.versionType': 'commit' };
  }
  return { 'versionDescriptor.version': ref.replace(/^refs\/heads\//, ''), 'versionDescriptor.versionType': 'branch' };
}

export const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';

/** "main" or "refs/heads/main" → "refs/heads/main". */
export function refName(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

/** JSON patch operations for work item fields; null or undefined removes a value. */
export function fieldOps(fields: Record<string, unknown>): { op: string; path: string; value?: unknown }[] {
  return Object.entries(fields).map(([k, value]) => value === null || value === undefined
    ? { op: 'remove', path: `/fields/${k}` }
    : { op: 'add', path: `/fields/${k}`, value });
}

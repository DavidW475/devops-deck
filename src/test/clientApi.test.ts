import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdoClient, AdoError, isSafeApiPath, prArtifactUrl, refName, ZERO_OBJECT_ID } from '../client';
import { ConnectionManager } from '../connection';
import * as vscode from './vscodeStub';

interface Call { method: string; url: URL; body: unknown; headers: Record<string, string> }

const P = '/contoso/Fabrikam%20Shop/_apis/';
const O = '/contoso/_apis/';
const GUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ME = { authenticatedUser: { id: 'me-1', providerDisplayName: 'Alex Kim', properties: { Account: { $value: 'alex@contoso.com' } } } };

let calls: Call[];
let reply: (url: URL, method: string) => Response;
let conn: { orgUrl: string; project: string; projects: string[]; detected: boolean } | undefined;
const realFetch = globalThis.fetch;
const realGetSession = vscode.authentication.getSession;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function newClient(pat = 'secret-pat'): AdoClient {
  return new AdoClient({ get: async () => pat } as never, { get current() { return conn; } } as unknown as ConnectionManager);
}

/** Answers connectionData with the signed-in user and everything else with `body`. */
function replyWith(body: unknown): void {
  reply = url => (url.pathname.endsWith('connectionData') ? json(ME) : json(body));
}

function lastCall(): Call {
  return calls.at(-1)!;
}

beforeEach(() => {
  vscode.reset();
  vscode.settings['azureDevOps.authMethod'] = 'pat';
  conn = { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false };
  calls = [];
  replyWith({ value: [] });
  globalThis.fetch = (async (input: string, init: RequestInit) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return reply(url, method);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vscode.authentication.getSession = realGetSession;
});

interface Case {
  name: string;
  call: (c: AdoClient) => Promise<unknown>;
  reply?: unknown;
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  result?: unknown;
}

const PR_PATH = `${P}git/repositories/web-shop/pullRequests/7`;

const cases: Case[] = [
  {
    name: 'listProjects sorts the project names', call: c => c.listProjects(),
    reply: { value: [{ name: 'Zeta' }, { name: 'Alpha' }] }, path: `${O}projects`, query: { $top: '500' }, result: ['Alpha', 'Zeta'],
  },
  {
    name: 'listPullRequests filters by creator', call: c => c.listPullRequests({ creatorId: 'u-1' }),
    reply: { value: [{ pullRequestId: 1 }] }, path: `${P}git/pullrequests`,
    query: { 'searchCriteria.status': 'active', 'searchCriteria.creatorId': 'u-1', $top: '100' }, result: [{ pullRequestId: 1 }],
  },
  {
    name: 'listActivePullRequests asks for 1000 by default', call: c => c.listActivePullRequests(),
    path: `${P}git/pullrequests`, query: { $top: '1000' }, result: [],
  },
  { name: 'getIterations', call: c => c.getIterations('web-shop', 7), reply: { value: [{ id: 1 }] }, path: `${PR_PATH}/iterations`, result: [{ id: 1 }] },
  { name: 'getLatestIteration picks the highest id', call: c => c.getLatestIteration('web-shop', 7), reply: { value: [{ id: 2 }, { id: 5 }, { id: 3 }] }, path: `${PR_PATH}/iterations`, result: 5 },
  {
    name: 'getThreads drops deleted threads', call: c => c.getThreads('web-shop', 7),
    reply: { value: [{ id: 1 }, { id: 2, isDeleted: true }] }, path: `${PR_PATH}/threads`, result: [{ id: 1 }],
  },
  { name: 'createThread posts the thread', call: c => c.createThread('web-shop', 7, { status: 1 }), method: 'POST', path: `${PR_PATH}/threads`, body: { status: 1 } },
  {
    name: 'replyToThread posts a text reply', call: c => c.replyToThread('web-shop', 7, 3, 'Looks good'), method: 'POST',
    path: `${PR_PATH}/threads/3/comments`, body: { content: 'Looks good', parentCommentId: 1, commentType: 1 },
  },
  { name: 'editComment patches the content', call: c => c.editComment('web-shop', 7, 3, 2, 'Fixed'), method: 'PATCH', path: `${PR_PATH}/threads/3/comments/2`, body: { content: 'Fixed' } },
  { name: 'updateThreadStatus patches the status', call: c => c.updateThreadStatus('web-shop', 7, 3, 2), method: 'PATCH', path: `${PR_PATH}/threads/3`, body: { status: 2 } },
  { name: 'vote uses the signed-in user', call: c => c.vote('web-shop', 7, 10), method: 'PUT', path: `${PR_PATH}/reviewers/me-1`, body: { vote: 10 } },
  { name: 'updatePullRequest', call: c => c.updatePullRequest('web-shop', 7, { title: 'New' }), method: 'PATCH', path: `${P}git/repositories/web-shop/pullrequests/7`, body: { title: 'New' } },
  { name: 'getPullRequestWorkItemIds converts ids to numbers', call: c => c.getPullRequestWorkItemIds('web-shop', 7), reply: { value: [{ id: '12' }, { id: '15' }] }, path: `${PR_PATH}/workitems`, result: [12, 15] },
  {
    name: 'runSavedQuery de-duplicates flat results', call: c => c.runSavedQuery('q-1'),
    reply: { workItems: [{ id: 4 }, { id: 4 }, { id: 9 }] }, path: `${P}wit/wiql/q-1`, query: { $top: '200' }, result: [4, 9],
  },
  {
    name: 'runSavedQuery reads tree query targets', call: c => c.runSavedQuery('q-2'),
    reply: { workItemRelations: [{ target: { id: 1 } }, {}, { target: { id: 2 } }] }, path: `${P}wit/wiql/q-2`, result: [1, 2],
  },
  { name: 'runSavedQuery without results', call: c => c.runSavedQuery('q-3'), reply: {}, path: `${P}wit/wiql/q-3`, result: [] },
  {
    name: 'getWorkItemUpdates reads the latest revisions', call: c => c.getWorkItemUpdates(42, 80, 50),
    path: `${O}wit/workItems/42/updates`, query: { $skip: '30', $top: '50' }, result: [],
  },
  { name: 'getWorkItemUpdates never skips below zero', call: c => c.getWorkItemUpdates(42, 3), path: `${O}wit/workItems/42/updates`, query: { $skip: '0' }, result: [] },
  { name: 'getWorkItem expands relations', call: c => c.getWorkItem(42), reply: { id: 42 }, path: `${O}wit/workitems/42`, query: { $expand: 'relations' }, result: { id: 42 } },
  {
    name: 'linkPullRequest adds an artifact link', call: c => c.linkPullRequest(42, { projectId: 'p1', repoId: 'r1', prId: 7 }), method: 'PATCH',
    path: `${O}wit/workitems/42`,
    body: [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: prArtifactUrl({ projectId: 'p1', repoId: 'r1', prId: 7 }), attributes: { name: 'Pull Request' } } }],
  },
  {
    name: 'removeWorkItemRelation guards with the revision', call: c => c.removeWorkItemRelation(42, 6, 2), method: 'PATCH', path: `${O}wit/workitems/42`,
    body: [{ op: 'test', path: '/rev', value: 6 }, { op: 'remove', path: '/relations/2' }],
  },
  { name: 'getPullRequestById uses the organization route', call: c => c.getPullRequestById(7), reply: { pullRequestId: 7 }, path: `${O}git/pullrequests/7`, result: { pullRequestId: 7 } },
  {
    name: 'updateWorkItem sends field operations', call: c => c.updateWorkItem(42, { 'System.State': 'Active' }), method: 'PATCH', path: `${O}wit/workitems/42`,
    body: [{ op: 'add', path: '/fields/System.State', value: 'Active' }],
  },
  {
    name: 'getWorkItemTypes skips disabled types', call: c => c.getWorkItemTypes(),
    reply: { value: [{ name: 'Bug' }, { name: 'Old', isDisabled: true }, { name: 'Task' }] }, path: `${P}wit/workitemtypes`, result: ['Bug', 'Task'],
  },
  {
    name: 'getWorkItemTypeFields expands allowed values', call: c => c.getWorkItemTypeFields('User Story'),
    path: `${P}wit/workitemtypes/User%20Story/fields`, query: { $expand: 'allowedValues' }, result: [],
  },
  { name: 'getWorkItemStates', call: c => c.getWorkItemStates('Bug'), reply: { value: [{ name: 'New' }] }, path: `${P}wit/workitemtypes/Bug/states`, result: [{ name: 'New' }] },
  {
    name: 'getWorkItemComments uses the preview API', call: c => c.getWorkItemComments(42), reply: { comments: [{ id: 1 }] },
    path: `${P}wit/workItems/42/comments`, query: { 'api-version': '7.1-preview.4' }, result: [{ id: 1 }],
  },
  {
    name: 'addWorkItemComment posts the text', call: c => c.addWorkItemComment(42, 'Deployed'), method: 'POST',
    path: `${P}wit/workItems/42/comments`, query: { 'api-version': '7.1-preview.4' }, body: { text: 'Deployed' },
  },
  {
    name: 'listDefinitions includes the latest builds', call: c => c.listDefinitions(), path: `${P}build/definitions`,
    query: { includeLatestBuilds: 'true', queryOrder: 'definitionNameAscending', $top: '500' }, result: [],
  },
  { name: 'getDefinition', call: c => c.getDefinition(3), reply: { id: 3 }, path: `${P}build/definitions/3`, result: { id: 3 } },
  {
    name: 'listBuilds filters by definition and branch', call: c => c.listBuilds({ definitionId: 3, branchName: 'refs/heads/main' }),
    path: `${P}build/builds`, query: { definitions: '3', branchName: 'refs/heads/main', $top: '25', queryOrder: 'queueTimeDescending' }, result: [],
  },
  { name: 'getBuild', call: c => c.getBuild(99), reply: { id: 99 }, path: `${P}build/builds/99`, result: { id: 99 } },
  { name: 'getTimeline returns the records', call: c => c.getTimeline(99), reply: { records: [{ id: 'r' }] }, path: `${P}build/builds/99/timeline`, result: [{ id: 'r' }] },
  { name: 'getBuildLogs', call: c => c.getBuildLogs(99), reply: { value: [{ id: 1, lineCount: 4 }] }, path: `${P}build/builds/99/logs`, result: [{ id: 1, lineCount: 4 }] },
  { name: 'getLogLines', call: c => c.getLogLines(99, 4), reply: { value: ['a', 'b'] }, path: `${P}build/builds/99/logs/4`, result: ['a', 'b'] },
  {
    name: 'queueBuild posts definition and branch', call: c => c.queueBuild(3, 'refs/heads/main'), method: 'POST', path: `${P}build/builds`,
    body: { definition: { id: 3 }, sourceBranch: 'refs/heads/main' },
  },
  {
    name: 'queueClassicBuild sends variables as JSON text', call: c => c.queueClassicBuild(3, 'refs/heads/main', { config: 'Release' }, 'abc123'), method: 'POST',
    path: `${P}build/builds`, body: { definition: { id: 3 }, sourceBranch: 'refs/heads/main', sourceVersion: 'abc123', parameters: '{"config":"Release"}' },
  },
  {
    name: 'queueClassicBuild leaves out empty variables and version', call: c => c.queueClassicBuild(3, 'refs/heads/main', {}), method: 'POST',
    path: `${P}build/builds`, body: { definition: { id: 3 }, sourceBranch: 'refs/heads/main' },
  },
  {
    name: 'runPipeline sends parameters and variables', reply: { id: 5, name: '20261016.1' }, method: 'POST', path: `${P}pipelines/12/runs`,
    call: c => c.runPipeline(12, { refName: 'refs/heads/main', templateParameters: { env: 'staging' }, variables: { verbose: 'true' } }),
    body: { resources: { repositories: { self: { refName: 'refs/heads/main' } } }, templateParameters: { env: 'staging' }, variables: { verbose: { value: 'true' } } },
    result: { id: 5, name: '20261016.1' },
  },
  {
    name: 'listRepositoryNames sorts names', call: c => c.listRepositoryNames(), reply: { value: [{ name: 'web-shop' }, { name: 'api' }] },
    path: `${P}git/repositories`, result: ['api', 'web-shop'],
  },
  {
    name: 'listBranches strips refs/heads', call: c => c.listBranches('web-shop'), reply: { value: [{ name: 'refs/heads/main' }, { name: 'refs/heads/feature/a' }] },
    path: `${P}git/repositories/web-shop/refs`, query: { filter: 'heads/', $top: '1000' }, result: ['feature/a', 'main'],
  },
  {
    name: 'getFileText reads a file at a branch', call: c => c.getFileText('web-shop', '/azure-pipelines.yml', 'main'), reply: { content: 'trigger: none' },
    path: `${P}git/repositories/web-shop/items`, query: { path: '/azure-pipelines.yml', 'versionDescriptor.versionType': 'branch' }, result: 'trigger: none',
  },
  { name: 'getFileText of an empty item', call: c => c.getFileText('web-shop', '/a', 'main'), reply: {}, path: `${P}git/repositories/web-shop/items`, result: '' },
  { name: 'cancelBuild', call: c => c.cancelBuild(99), method: 'PATCH', path: `${P}build/builds/99`, body: { status: 'cancelling' } },
  {
    name: 'findPullRequestsForBranch uses the full ref name', call: c => c.findPullRequestsForBranch('web-shop', 'feature/a'),
    path: `${P}git/repositories/web-shop/pullrequests`, query: { 'searchCriteria.sourceRefName': 'refs/heads/feature/a', $top: '10' }, result: [],
  },
  { name: 'addReviewer', call: c => c.addReviewer('web-shop', 7, 'r-1', true), method: 'PUT', path: `${PR_PATH}/reviewers/r-1`, body: { vote: 0, isRequired: true } },
  {
    name: 'setAutoComplete with options sets the signed-in user', method: 'PATCH', path: `${P}git/repositories/web-shop/pullrequests/7`,
    call: c => c.setAutoComplete('web-shop', 7, { deleteSourceBranch: true } as never),
    body: { autoCompleteSetBy: { id: 'me-1' }, completionOptions: { deleteSourceBranch: true } },
  },
  { name: 'getPullRequestCommits', call: c => c.getPullRequestCommits('web-shop', 7), path: `${PR_PATH}/commits`, query: { $top: '250' }, result: [] },
  {
    name: 'listRepositories skips disabled ones and sorts', call: c => c.listRepositories(),
    reply: { value: [{ name: 'web' }, { name: 'old', isDisabled: true }, { name: 'api' }] }, path: `${P}git/repositories`, result: [{ name: 'api' }, { name: 'web' }],
  },
  { name: 'getRepository encodes the name', call: c => c.getRepository('web shop'), reply: { id: 'r' }, path: `${P}git/repositories/web%20shop`, result: { id: 'r' } },
  {
    name: 'getBranchStats compares with the base branch', call: c => c.getBranchStats('web-shop', 'main'), path: `${P}git/repositories/web-shop/stats/branches`,
    query: { 'baseVersionDescriptor.version': 'main', 'baseVersionDescriptor.versionType': 'branch' }, result: [],
  },
  {
    name: 'updateRef creates a branch', call: c => c.updateRef(GUID, 'feature/b', ZERO_OBJECT_ID, 'abc'), reply: { value: [{ success: true }] }, method: 'POST',
    path: `${O}git/repositories/${GUID}/refs`, body: [{ name: 'refs/heads/feature/b', oldObjectId: ZERO_OBJECT_ID, newObjectId: 'abc' }],
  },
  {
    name: 'getPipelineRun', call: c => c.getPipelineRun(12, 5), reply: { templateParameters: { env: 'prod' } }, path: `${P}pipelines/12/runs/5`,
    result: { templateParameters: { env: 'prod' } },
  },
  {
    name: 'previewPipeline returns the final YAML', call: c => c.previewPipeline(12, 'refs/heads/main', 'abc', { env: 'prod' }), reply: { finalYaml: 'jobs: []' },
    method: 'POST', path: `${P}pipelines/12/preview`, query: { 'api-version': '7.1-preview.1' },
    body: { previewRun: true, resources: { repositories: { self: { refName: 'refs/heads/main', version: 'abc' } } }, templateParameters: { env: 'prod' } }, result: 'jobs: []',
  },
  { name: 'previewPipeline without YAML', call: c => c.previewPipeline(12, 'refs/heads/main', undefined), reply: {}, method: 'POST', path: `${P}pipelines/12/preview`, result: '' },
  {
    name: 'getFileTextAtCommit', call: c => c.getFileTextAtCommit('web-shop', '/a.yml', 'abc'), reply: { content: 'x' }, path: `${P}git/repositories/web-shop/items`,
    query: { 'versionDescriptor.version': 'abc', 'versionDescriptor.versionType': 'commit', includeContent: 'true' }, result: 'x',
  },
  {
    name: 'previewPipeline with local YAML', call: c => c.previewPipeline(12, 'refs/heads/main', undefined, undefined, 'steps: []'), reply: { finalYaml: 'jobs: []' },
    method: 'POST', path: `${P}pipelines/12/preview`,
    body: { previewRun: true, resources: { repositories: { self: { refName: 'refs/heads/main' } } }, yamlOverride: 'steps: []' }, result: 'jobs: []',
  },
  {
    name: 'getFileTextAtRef at a tag', call: c => c.getFileTextAtRef('web-shop', '/a.yml', 'refs/tags/v1.2'), reply: { content: 'x' }, path: `${P}git/repositories/web-shop/items`,
    query: { path: '/a.yml', 'versionDescriptor.version': 'v1.2', 'versionDescriptor.versionType': 'tag', includeContent: 'true' }, result: 'x',
  },
  {
    name: 'getFileTextAtRef at a branch', call: c => c.getFileTextAtRef('web-shop', '/a.yml', 'refs/heads/release/1'), reply: { content: 'x' },
    path: `${P}git/repositories/web-shop/items`, query: { 'versionDescriptor.version': 'release/1', 'versionDescriptor.versionType': 'branch' }, result: 'x',
  },
  {
    name: 'getFileTextAtRef at a commit', call: c => c.getFileTextAtRef('web-shop', '/a.yml', 'A'.repeat(40)), reply: {},
    path: `${P}git/repositories/web-shop/items`, query: { 'versionDescriptor.version': 'A'.repeat(40), 'versionDescriptor.versionType': 'commit' }, result: '',
  },
  {
    name: 'getFileTextAtRef at the default branch', call: c => c.getFileTextAtRef('web-shop', '/a.yml'), reply: { content: 'y' },
    path: `${P}git/repositories/web-shop/items`, query: { path: '/a.yml' }, result: 'y',
  },
  {
    name: 'listYamlDefinitions keeps YAML pipelines', call: c => c.listYamlDefinitions('repo-1'),
    reply: { value: [{ id: 1, process: { type: 2, yamlFilename: 'ci.yml' } }, { id: 2, process: { type: 1 } }] }, path: `${P}build/definitions`,
    query: { repositoryId: 'repo-1', repositoryType: 'TfsGit', includeAllProperties: 'true' }, result: [{ id: 1, process: { type: 2, yamlFilename: 'ci.yml' } }],
  },
  { name: 'getFileTextAtCommit of an empty item', call: c => c.getFileTextAtCommit('web-shop', '/a.yml', 'abc'), reply: {}, path: `${P}git/repositories/web-shop/items`, result: '' },
  {
    name: 'listPendingApprovals', call: c => c.listPendingApprovals(), path: `${P}pipelines/approvals`,
    query: { state: 'pending', $expand: 'steps', 'api-version': '7.1-preview.1' }, result: [],
  },
  { name: 'getApproval', call: c => c.getApproval('ap-1'), reply: { id: 'ap-1' }, path: `${P}pipelines/approvals/ap-1`, query: { $expand: 'steps' }, result: { id: 'ap-1' } },
  {
    name: 'updateApproval', call: c => c.updateApproval('ap-1', 'approved', 'Ship it'), method: 'PATCH', path: `${P}pipelines/approvals`,
    body: [{ approvalId: 'ap-1', status: 'approved', comment: 'Ship it' }],
  },
  {
    name: 'retryStage', call: c => c.retryStage(99, 'Deploy EU', true), method: 'PATCH', path: `${P}build/builds/99/stages/Deploy%20EU`,
    query: { 'api-version': '7.1-preview.1' }, body: { state: 'retry', forceRetryAllJobs: true },
  },
  { name: 'listArtifacts', call: c => c.listArtifacts(99), reply: { value: [{ id: 1, name: 'drop' }] }, path: `${P}build/builds/99/artifacts`, result: [{ id: 1, name: 'drop' }] },
  {
    name: 'listTestRuns by build URI', call: c => c.listTestRuns(99), path: `${P}test/runs`,
    query: { buildUri: 'vstfs:///Build/Build/99', includeRunDetails: 'true' }, result: [],
  },
  { name: 'listFailedTestResults', call: c => c.listFailedTestResults(8), path: `${P}test/Runs/8/results`, query: { outcomes: 'Failed', $top: '200' }, result: [] },
  {
    name: 'listBuildsSince finished builds', call: c => c.listBuildsSince(new Date('2026-10-01T00:00:00Z'), 'finished'), path: `${P}build/builds`,
    query: { minTime: '2026-10-01T00:00:00.000Z', queryOrder: 'finishTimeDescending', statusFilter: 'completed' }, result: [],
  },
  {
    name: 'listBuildsSince started builds', call: c => c.listBuildsSince(new Date('2026-10-01T00:00:00Z'), 'started'), path: `${P}build/builds`,
    query: { queryOrder: 'startTimeDescending' }, result: [],
  },
  { name: 'listWikis', call: c => c.listWikis(), reply: { value: [{ id: 'w' }] }, path: `${P}wiki/wikis`, result: [{ id: 'w' }] },
  {
    name: 'getWikiPageTree reads the full tree', call: c => c.getWikiPageTree('Fabrikam Shop.wiki'), reply: { path: '/' }, path: `${P}wiki/wikis/Fabrikam%20Shop.wiki/pages`,
    query: { path: '/', recursionLevel: 'full' }, result: { path: '/' },
  },
  {
    name: 'getTeamDaysOff', call: c => c.getTeamDaysOff('Team A', 'it-1'), reply: { daysOff: [{ start: 'a', end: 'b' }] },
    path: '/contoso/Fabrikam%20Shop/Team%20A/_apis/work/teamsettings/iterations/it-1/teamdaysoff', result: [{ start: 'a', end: 'b' }],
  },
  { name: 'getTeamDaysOff without days off', call: c => c.getTeamDaysOff('Team A', 'it-1'), reply: {}, path: '/contoso/Fabrikam%20Shop/Team%20A/_apis/work/teamsettings/iterations/it-1/teamdaysoff', result: [] },
  {
    name: 'listTeamIterations uses the team route', call: c => c.listTeamIterations('Team A'), reply: { value: [{ id: 'it-1' }] },
    path: '/contoso/Fabrikam%20Shop/Team%20A/_apis/work/teamsettings/iterations', query: { 'api-version': '7.1' }, result: [{ id: 'it-1' }],
  },
  {
    name: 'getIterationWorkItems', call: c => c.getIterationWorkItems('Team A', 'it-1'), reply: { workItemRelations: [{ target: { id: 1 } }] },
    path: '/contoso/Fabrikam%20Shop/Team%20A/_apis/work/teamsettings/iterations/it-1/workitems', result: [{ target: { id: 1 } }],
  },
  { name: 'getIterationWorkItems when empty', call: c => c.getIterationWorkItems('Team A', 'it-1'), reply: {}, path: '/contoso/Fabrikam%20Shop/Team%20A/_apis/work/teamsettings/iterations/it-1/workitems', result: [] },
  { name: 'getCapacities reads teamMembers', call: c => c.getCapacities('Team A', 'it-1'), reply: { teamMembers: [{ a: 1 }] }, path: '/contoso/Fabrikam%20Shop/Team%20A/_apis/work/teamsettings/iterations/it-1/capacities', result: [{ a: 1 }] },
  { name: 'getCapacities reads value', call: c => c.getCapacities('Team A', 'it-1'), reply: { value: [{ b: 2 }] }, path: '/contoso/Fabrikam%20Shop/Team%20A/_apis/work/teamsettings/iterations/it-1/capacities', result: [{ b: 2 }] },
  { name: 'getCapacities without capacity', call: c => c.getCapacities('Team A', 'it-1'), reply: {}, path: '/contoso/Fabrikam%20Shop/Team%20A/_apis/work/teamsettings/iterations/it-1/capacities', result: [] },
  {
    name: 'listClassificationPaths flattens the tree', call: c => c.listClassificationPaths('Iterations'),
    reply: { name: 'Fabrikam Shop', children: [{ name: 'Sprint 1' }, { name: 'Release 2', children: [{ name: 'Sprint 2' }] }] },
    path: `${P}wit/classificationnodes/Iterations`, query: { $depth: '10' },
    result: ['Fabrikam Shop', 'Fabrikam Shop\\Sprint 1', 'Fabrikam Shop\\Release 2', 'Fabrikam Shop\\Release 2\\Sprint 2'],
  },
];

describe('AdoClient API calls', () => {
  for (const tc of cases) {
    it(tc.name, async () => {
      replyWith(tc.reply ?? { value: [] });
      const result = await tc.call(newClient());
      const call = lastCall();
      assert.equal(call.method, tc.method ?? 'GET');
      assert.equal(call.url.pathname, tc.path);
      for (const [k, v] of Object.entries(tc.query ?? {})) {
        assert.equal(call.url.searchParams.get(k), v, k);
      }
      if (tc.body !== undefined) {
        assert.deepEqual(call.body, tc.body);
      }
      if ('result' in tc) {
        assert.deepEqual(result, tc.result);
      }
    });
  }

  it('sends JSON patch bodies with the json-patch content type', async () => {
    await newClient().updateWorkItem(1, { 'System.Title': 'x' });
    assert.equal(lastCall().headers['Content-Type'], 'application/json-patch+json');
    await newClient().getBuild(1);
    assert.equal(lastCall().headers['Content-Type'], undefined, 'no content type without a body');
  });

  it('getLatestIteration fails without iterations', async () => {
    await assert.rejects(newClient().getLatestIteration('web-shop', 7), (e: unknown) => e instanceof AdoError && e.status === 404);
  });

  it('getIterationChanges pages with nextSkip and drops folders', async () => {
    reply = url => (url.searchParams.get('$skip') === '0'
      ? json({ changeEntries: [{ item: { path: '/a.ts' } }, { item: { path: '/src', isFolder: true } }], nextSkip: 2 })
      : json({ changeEntries: [{ item: { path: '/b', gitObjectType: 'tree' } }, { item: { path: '/c.ts' } }] }));
    const changes = await newClient().getIterationChanges('web-shop', 7, 3);
    assert.deepEqual(changes.map(c => c.item.path), ['/a.ts', '/c.ts']);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.searchParams.get('$skip'), '2');
    assert.equal(calls[0].url.searchParams.get('$compareTo'), '0');
  });

  it('getBlobText reads plain text', async () => {
    reply = () => new Response('console.log(1);', { status: 200, headers: { 'content-type': 'text/plain' } });
    assert.equal(await newClient().getBlobText('web-shop', 'abc'), 'console.log(1);');
    assert.equal(lastCall().url.searchParams.get('$format'), 'octetstream');
    assert.match(lastCall().headers.Accept, /text\/plain/);
  });

  it('deleteComment and removeReviewer send DELETE and accept empty answers', async () => {
    reply = () => new Response(null, { status: 204 });
    assert.equal(await newClient().deleteComment('web-shop', 7, 3, 2), undefined);
    assert.equal(lastCall().method, 'DELETE');
    assert.equal(lastCall().url.pathname, `${PR_PATH}/threads/3/comments/2`);
    await newClient().removeReviewer('web-shop', 7, 'r-1');
    assert.equal(lastCall().url.pathname, `${PR_PATH}/reviewers/r-1`);
  });

  it('getTimeline of a build without timeline is empty', async () => {
    reply = () => new Response(null, { status: 204 });
    assert.deepEqual(await newClient().getTimeline(99), []);
  });

  it('listSavedQueries flattens folders and loads unexpanded ones', async () => {
    reply = url => {
      if (url.pathname.endsWith('wit/queries/f-2')) {
        return json({ id: 'f-2', isFolder: true, children: [{ id: 'q-3', isFolder: false }] });
      }
      return json({ value: [
        { id: 'f-1', isFolder: true, children: [{ id: 'q-1', isFolder: false }, { id: 'q-2', isFolder: false }] },
        { id: 'f-2', isFolder: true, hasChildren: true },
        { id: 'f-3', isFolder: true },
      ] });
    };
    const queries = await newClient().listSavedQueries();
    assert.deepEqual(queries.map(q => q.id), ['q-1', 'q-2', 'q-3']);
    assert.equal(calls[0].url.searchParams.get('$depth'), '2');
  });

  it('listSavedQueries handles a lazily loaded folder without children', async () => {
    reply = url => (url.pathname.endsWith('wit/queries/f-1') ? json({ id: 'f-1' }) : json({ value: [{ id: 'f-1', isFolder: true, hasChildren: true }] }));
    assert.deepEqual(await newClient().listSavedQueries(), []);
  });

  it('searchWorkItems queries by ID, by title or my open items', async () => {
    const wiqlOf = async (text: string) => {
      calls = [];
      reply = url => (url.pathname.endsWith('wit/wiql') ? json({ workItems: [{ id: 42 }] }) : json({ value: [{ id: 42, rev: 1, fields: {} }] }));
      const items = await newClient().searchWorkItems(text);
      assert.deepEqual(items.map(w => w.id), [42]);
      return (calls[0].body as { query: string }).query;
    };
    assert.match(await wiqlOf(' #42 '), /\[System\.Id\] = 42 ORDER BY/);
    assert.match(await wiqlOf("O'Brien login"), /CONTAINS 'O''Brien login'/);
    assert.match(await wiqlOf(''), /\[System\.AssignedTo\] = @Me/);
  });

  it('searchWorkItems skips fetching when nothing matches', async () => {
    reply = () => json({ workItems: [] });
    assert.deepEqual(await newClient().searchWorkItems('nothing'), []);
    assert.equal(calls.length, 1);
  });

  it('unlinkPullRequest removes the matching relation', async () => {
    const pr = { projectId: 'p1', repoId: 'R1', prId: 7 };
    reply = (_url, method) => (method === 'GET'
      ? json({ id: 42, rev: 9, relations: [{ url: 'https://x' }, { url: prArtifactUrl({ ...pr, repoId: 'r1' }) }] })
      : json({}));
    await newClient().unlinkPullRequest(42, pr);
    assert.equal(calls.length, 2);
    assert.deepEqual(lastCall().body, [{ op: 'test', path: '/rev', value: 9 }, { op: 'remove', path: '/relations/1' }]);
  });

  it('unlinkPullRequest does nothing when the link is gone', async () => {
    reply = () => json({ id: 42, rev: 9 });
    await newClient().unlinkPullRequest(42, { projectId: 'p1', repoId: 'r1', prId: 7 });
    assert.equal(calls.length, 1);
  });

  it('createWorkItem adds parent and hyperlink relations', async () => {
    replyWith({ id: 50 });
    const item = await newClient().createWorkItem('User Story', { 'System.Title': 'Checkout' }, { parentId: 10, hyperlink: 'https://contoso.example/spec' });
    assert.equal(item.id, 50);
    assert.equal(lastCall().method, 'POST');
    assert.equal(lastCall().url.pathname, `${P}wit/workitems/$User%20Story`);
    assert.deepEqual(lastCall().body, [
      { op: 'add', path: '/fields/System.Title', value: 'Checkout' },
      { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/10' } },
      { op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url: 'https://contoso.example/spec' } },
    ]);
  });

  it('searchIdentities maps active people and groups', async () => {
    replyWith({ results: [{ identities: [
      { localId: 'u1', displayName: 'Robin Diaz', signInAddress: 'robin@contoso.com', mail: 'robin@contoso.com', entityType: 'User' },
      { localId: 'g1', displayName: 'Fabrikam Team', entityType: 'Group' },
      { localId: 'u2', displayName: 'Gone', active: false },
      { displayName: 'No id' },
      { localId: 'u3', mail: 'sam@contoso.com' },
    ] }] });
    const ids = await newClient().searchIdentities('rob');
    assert.deepEqual(ids, [
      { id: 'u1', displayName: 'Robin Diaz', uniqueName: 'robin@contoso.com', mail: 'robin@contoso.com', isGroup: false },
      { id: 'g1', displayName: 'Fabrikam Team', uniqueName: undefined, mail: undefined, isGroup: true },
      { id: 'u3', displayName: '', uniqueName: 'sam@contoso.com', mail: 'sam@contoso.com', isGroup: false },
    ]);
    assert.equal(lastCall().url.pathname, `${O}IdentityPicker/Identities`);
    assert.equal((lastCall().body as { query: string }).query, 'rob');
  });

  it('searchIdentities without results', async () => {
    replyWith({});
    assert.deepEqual(await newClient().searchIdentities('x'), []);
  });

  it('updateRef reports the custom message or an unknown error', async () => {
    replyWith({ value: [{ success: false, customMessage: 'Branch policy forbids this' }] });
    await assert.rejects(newClient().updateRef('web-shop', 'main', 'a', ZERO_OBJECT_ID), /Branch policy forbids this/);
    replyWith({ value: [] });
    await assert.rejects(newClient().updateRef('web-shop', 'main', 'a', ZERO_OBJECT_ID), /Could not update main: unknown error/);
  });

  it('diffBranches pages until all changes are included', async () => {
    const page = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ item: { path: `/${prefix}${i}` } }));
    reply = url => (url.searchParams.get('$skip') === '0'
      ? json({ aheadCount: 3, behindCount: 1, changes: [...page(999, 'a'), { item: { path: '/dir', isFolder: true } }], allChangesIncluded: false })
      : json({ aheadCount: 0, changes: page(2, 'b'), allChangesIncluded: false }));
    const diff = await newClient().diffBranches('web-shop', 'main', 'feature/a');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.searchParams.get('$skip'), '1000');
    assert.equal(diff.aheadCount, 3);
    assert.equal(diff.behindCount, 1);
    assert.equal(diff.changes.length, 1001);
  });

  it('diffBranches stops after one complete page', async () => {
    replyWith({ changes: [{ item: { path: '/a' } }, { item: { path: '/t', gitObjectType: 'tree' } }] });
    const diff = await newClient().diffBranches('web-shop', 'main', 'feature/a');
    assert.equal(calls.length, 1);
    assert.deepEqual(diff.changes.map(c => c.item.path), ['/a']);
  });

  it('listTeams puts my teams first, then sorts by name', async () => {
    reply = url => (url.searchParams.get('$mine') === 'true'
      ? json({ value: [{ id: 't3', name: 'Web' }] })
      : json({ value: [{ id: 't1', name: 'Mobile' }, { id: 't3', name: 'Web' }, { id: 't2', name: 'Data' }] }));
    const teams = await newClient().listTeams();
    assert.deepEqual(teams.map(t => t.name), ['Web', 'Data', 'Mobile']);
    assert.equal(calls[0].url.pathname, `${O}projects/Fabrikam%20Shop/teams`);
  });

  it('listTeams works when my teams cannot be read', async () => {
    reply = url => (url.searchParams.get('$mine') === 'true' ? json({ message: 'denied' }, 403) : json({ value: [{ id: 't2', name: 'B' }, { id: 't1', name: 'A' }] }));
    assert.deepEqual((await newClient().listTeams()).map(t => t.name), ['A', 'B']);
  });

  it('getWikiPage returns content and ETag', async () => {
    reply = () => json({ content: '# Home' }, 200, { etag: '"v1"' });
    assert.deepEqual(await newClient().getWikiPage('wiki', '/Home'), { content: '# Home', etag: '"v1"' });
    assert.equal(lastCall().url.searchParams.get('includeContent'), 'true');
    reply = () => json({});
    assert.deepEqual(await newClient().getWikiPage('wiki', '/Empty'), { content: '', etag: undefined });
  });

  it('saveWikiPage sends If-Match only for updates', async () => {
    reply = () => json({}, 200, { etag: '"v2"' });
    assert.equal(await newClient().saveWikiPage('wiki', '/Home', '# Home', '"v1"'), '"v2"');
    assert.equal(lastCall().method, 'PUT');
    assert.equal(lastCall().headers['If-Match'], '"v1"');
    assert.deepEqual(lastCall().body, { content: '# Home' });
    reply = () => json({});
    assert.equal(await newClient().saveWikiPage('wiki', '/New', 'x'), undefined);
    assert.equal(lastCall().headers['If-Match'], undefined);
  });

  it('downloadTo streams the body to a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devops-deck-test-'));
    try {
      const target = join(dir, 'drop.zip');
      reply = () => new Response('zip-bytes', { status: 200, headers: { 'content-type': 'application/zip' } });
      await newClient().downloadTo('https://dev.azure.com/contoso/_apis/resources/Containers/1?format=zip', target);
      assert.equal(readFileSync(target, 'utf8'), 'zip-bytes');
      assert.match(lastCall().headers.Accept, /application\/zip/);
      reply = () => new Response(null, { status: 200 });
      await assert.rejects(newClient().downloadTo('https://dev.azure.com/contoso/_apis/x', join(dir, 'empty.zip')), /empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('webUrl builds links to the web UI', () => {
    const c = newClient();
    const base = 'https://dev.azure.com/contoso/Fabrikam%20Shop';
    assert.equal(c.webUrl('pr', 'web shop', 7), `${base}/_git/web%20shop/pullrequest/7`);
    assert.equal(c.webUrl('workItem', 42), `${base}/_workitems/edit/42`);
    assert.equal(c.webUrl('build', 99), `${base}/_build/results?buildId=99`);
    assert.equal(c.webUrl('definition', 3), `${base}/_build?definitionId=3`);
    assert.equal(c.webUrl('repo', 'web-shop', undefined, 'Northwind'), 'https://dev.azure.com/contoso/Northwind/_git/web-shop');
  });

  it('isSafeApiPath refuses paths that could leave the route', () => {
    assert.ok(isSafeApiPath('git/repositories/web-shop/pullrequests/7'));
    assert.ok(isSafeApiPath('wiki/wikis/Fabrikam%20Shop.wiki/pages'));
    for (const bad of ['git//x', 'git/../x', 'git/%2e%2E/x', 'git/./x', 'git/x?y=1', 'git/x#top', 'git\\x', 'git/%E0%A4%A/x', '']) {
      assert.equal(isSafeApiPath(bad), false, bad);
    }
  });

  it('refuses unsafe paths before sending anything', async () => {
    await assert.rejects(async () => newClient().getBuild('../../x' as never), (e: unknown) => e instanceof AdoError && e.status === 400);
    await assert.rejects(async () => newClient().getTeamDaysOff('Team A', '..'), (e: unknown) => e instanceof AdoError && e.status === 400);
    assert.equal(calls.length, 0);
  });

  it('refName keeps full refs', () => {
    assert.equal(refName('refs/tags/v1'), 'refs/tags/v1');
    assert.equal(refName('main'), 'refs/heads/main');
  });
});

describe('AdoClient identity, auth and errors', () => {
  it('getMe maps the signed-in user and caches it', async () => {
    const c = newClient();
    assert.deepEqual(await c.getMe(), { id: 'me-1', displayName: 'Alex Kim', uniqueName: 'alex@contoso.com' });
    await c.getMe();
    assert.equal(calls.length, 1);
    c.reset();
    await c.getMe();
    assert.equal(calls.length, 2, 'reset forgets the cached user');
  });

  it('getMe falls back to the custom display name and retries after a failure', async () => {
    reply = () => json({ message: 'boom' }, 500);
    const c = newClient();
    await assert.rejects(c.getMe(), /boom/);
    reply = () => json({ authenticatedUser: { id: 'me-2', customDisplayName: 'Build Service' } });
    assert.deepEqual(await c.getMe(), { id: 'me-2', displayName: 'Build Service', uniqueName: undefined });
  });

  it('throws when no organization is configured', () => {
    conn = undefined;
    const c = newClient();
    assert.throws(() => c.connection, /not configured/);
    assert.equal(c.forProject('Northwind'), c, 'no scoped client without a connection');
  });

  it('forProject without a project returns the client itself', () => {
    const c = newClient();
    assert.equal(c.forProject(), c);
    assert.equal(c.forProject('Northwind').forProject('Fabrikam Shop'), c, 'scoped clients resolve to the root');
  });

  it('fails with an auth error when no PAT is stored', async () => {
    await assert.rejects(newClient('').getBuild(1), (e: unknown) => e instanceof AdoError && e.isAuthError && /Personal Access Token/.test(e.message));
    assert.equal(calls.length, 0);
  });

  it('uses a Microsoft session with the tenant scope', async () => {
    vscode.settings['azureDevOps.authMethod'] = 'microsoft';
    vscode.settings['azureDevOps.tenantId'] = ' tenant-1 ';
    const requests: { scopes: string[]; opts: { createIfNone: boolean } }[] = [];
    vscode.authentication.getSession = (async (_provider: string, scopes: string[], opts: { createIfNone: boolean }) => {
      requests.push({ scopes, opts });
      return { accessToken: 'token-1' };
    }) as never;
    const c = newClient();
    await c.getBuild(1);
    assert.equal(lastCall().headers.Authorization, 'Bearer token-1');
    assert.deepEqual(requests[0].scopes.slice(1), ['VSCODE_TENANT:tenant-1']);
    assert.equal(requests[0].opts.createIfNone, false);
    await c.signIn();
    assert.equal(requests[1].opts.createIfNone, true, 'signIn may prompt');
  });

  it('fails with an auth error without a Microsoft session', async () => {
    vscode.settings['azureDevOps.authMethod'] = 'microsoft';
    await assert.rejects(newClient().getBuild(1), (e: unknown) => e instanceof AdoError && e.isAuthError && /Not signed in/.test(e.message));
  });

  it('uses the status text when the error body is not JSON', async () => {
    reply = () => new Response('oops', { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/plain' } });
    await assert.rejects(newClient().getBuild(1), (e: unknown) => e instanceof AdoError && e.status === 502 && e.message === '502 Bad Gateway');
  });

  it('uses the status when the JSON error has no message', async () => {
    reply = () => json({}, 409);
    await assert.rejects(newClient().getBuild(1), (e: unknown) => e instanceof AdoError && e.status === 409 && /^409/.test(e.message));
  });
});

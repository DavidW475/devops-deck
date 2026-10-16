import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdoClient, AdoError, fieldOps, parsePrArtifact, prArtifactUrl } from '../client';
import { ConnectionManager } from '../connection';
import * as vscode from './vscodeStub';

interface Call { url: string; init: RequestInit }

describe('AdoClient', () => {
  let calls: Call[];
  let respond: (url: string) => Response;
  let conn: { orgUrl: string; project: string } | undefined;
  const realFetch = globalThis.fetch;

  const client = () => new AdoClient(
    { get: async () => 'secret-pat' } as never,
    { get current() { return conn; } } as unknown as ConnectionManager);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    vscode.reset();
    vscode.settings['azureDevOps.authMethod'] = 'pat';
    conn = { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop' };
    calls = [];
    respond = () => json({ value: [] });
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond(String(url));
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('builds project URLs with api-version and sends the PAT as basic auth', async () => {
    respond = () => json({ pullRequestId: 7 });
    const pr = await client().getPullRequest('repo-1', 7);
    assert.equal(pr.pullRequestId, 7);
    const u = new URL(calls[0].url);
    assert.equal(u.pathname, '/contoso/Fabrikam%20Shop/_apis/git/repositories/repo-1/pullrequests/7');
    assert.equal(u.searchParams.get('api-version'), '7.1');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Basic ' + Buffer.from(':secret-pat').toString('base64'));
  });

  it('refuses to send credentials to hosts other than Azure DevOps', async () => {
    conn = { orgUrl: 'https://evil.example.com/contoso', project: 'p' };
    await assert.rejects(client().getPullRequest('r', 1), /Refusing to send credentials/);
    assert.equal(calls.length, 0);
  });

  it('maps 401, 203 and HTML sign-in pages to auth errors', async () => {
    for (const res of [
      () => new Response('', { status: 401 }),
      () => new Response('', { status: 203 }),
      () => new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]) {
      respond = res;
      await assert.rejects(client().getPullRequest('r', 1), (e: unknown) => e instanceof AdoError && e.isAuthError);
    }
  });

  it('uses the server message for other errors', async () => {
    respond = () => json({ message: 'TF401019: repository not found' }, 404);
    await assert.rejects(client().getPullRequest('r', 1), (e: unknown) => e instanceof AdoError && e.status === 404 && /TF401019/.test(e.message));
  });

  it('reads policy evaluations with the preview api-version and the PR artifact id', async () => {
    await client().getPolicyEvaluations('proj-1', 42);
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('api-version'), '7.1-preview.1');
    assert.equal(u.searchParams.get('artifactId'), 'vstfs:///CodeReview/CodeReviewId/proj-1/42');
  });

  it('posts WIQL with time precision when asked', async () => {
    respond = () => json({ workItems: [{ id: 1 }, { id: 2 }] });
    const ids = await client().queryWiql('SELECT [System.Id] FROM WorkItems', { top: 10, timePrecision: true });
    assert.deepEqual(ids, [1, 2]);
    const u = new URL(calls[0].url);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(u.searchParams.get('timePrecision'), 'true');
    assert.equal(u.searchParams.get('$top'), '10');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { query: 'SELECT [System.Id] FROM WorkItems' });
  });

  it('fetches work items in batches of 200', async () => {
    respond = url => json({ value: new URL(url).searchParams.get('ids')!.split(',').map(id => ({ id: Number(id), rev: 1, fields: {} })) });
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    const items = await client().getWorkItems(ids, ['System.CreatedDate']);
    assert.equal(items.length, 450);
    assert.equal(calls.length, 3);
    assert.match(new URL(calls[0].url).searchParams.get('fields')!, /System\.CreatedDate$/);
  });

  it('round-trips pull request artifact links', () => {
    const pr = { projectId: 'p1', repoId: 'r1', prId: 12 };
    assert.deepEqual(parsePrArtifact(prArtifactUrl(pr)), pr);
    assert.equal(parsePrArtifact('vstfs:///Git/Commit/x'), undefined);
  });

  const GUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

  it('uses organization-wide routes for repositories by ID, so PRs of every project work', async () => {
    respond = () => json({ pullRequestId: 7 });
    await client().getPullRequest(GUID, 7);
    assert.equal(new URL(calls[0].url).pathname, `/contoso/_apis/git/repositories/${GUID}/pullrequests/7`);
  });

  it('forProject routes project APIs to the other project and shares the signed-in user', async () => {
    respond = url => url.includes('connectionData')
      ? json({ authenticatedUser: { id: 'me', providerDisplayName: 'Alex' } })
      : json({ value: [] });
    const c = client();
    const other = c.forProject('Northwind');
    assert.equal(c.forProject('fabrikam shop'), c, 'the current project returns the same client');
    assert.equal(c.forProject('Northwind'), other, 'scoped clients are cached');
    await other.listBuilds({ top: 1 });
    assert.equal(new URL(calls[0].url).pathname, '/contoso/Northwind/_apis/build/builds');
    await other.getMe();
    await c.getMe();
    assert.equal(calls.filter(x => x.url.includes('connectionData')).length, 1);
  });

  it('reads policy evaluations in the PR\'s own project', async () => {
    await client().getPolicyEvaluations('proj-9', 1);
    assert.equal(new URL(calls[0].url).pathname, '/contoso/proj-9/_apis/policy/evaluations');
  });

  it('creates pull requests and turns auto-complete off', async () => {
    respond = () => json({ pullRequestId: 3, repository: { id: GUID } });
    await client().createPullRequest(GUID, { sourceRefName: 'refs/heads/a', targetRefName: 'refs/heads/main', title: 'T', reviewers: [{ id: 'r' }] });
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(new URL(calls[0].url).searchParams.get('supportsIterations'), 'true');
    await client().setAutoComplete(GUID, 3, undefined);
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { autoCompleteSetBy: { id: '00000000-0000-0000-0000-000000000000' } });
  });

  it('reports a failed ref update', async () => {
    respond = () => json({ value: [{ success: false, updateStatus: 'staleOldObjectId' }] });
    await assert.rejects(client().updateRef(GUID, 'feature/x', 'a', 'b'), /staleOldObjectId/);
  });

  it('removes empty work item fields', () => {
    assert.deepEqual(fieldOps({ 'System.Title': 'x', 'Microsoft.VSTS.Scheduling.StoryPoints': null }), [
      { op: 'add', path: '/fields/System.Title', value: 'x' },
      { op: 'remove', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints' },
    ]);
  });
});

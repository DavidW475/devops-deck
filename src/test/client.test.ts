import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdoClient, AdoError, parsePrArtifact, prArtifactUrl } from '../client';
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
});

import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { controllers, fakeDoc, fakeEditor, fire, Range, registered, resetExtras, threads } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { AdoClient } from '../client';
import { makePrUri, PrFileQuery } from '../pullRequests/prFiles';
import { PrCommentController } from '../pullRequests/prComments';
import { PrComment, PrThread } from '../types';

const ME = { id: 'me', displayName: 'Alex Morgan' };
const LENA = { id: 'lena', displayName: 'Lena Hoffmann' };
const w = vscode.window as any;
const ws = vscode.workspace as any;
const flush = () => new Promise(r => setImmediate(r));
const q = (side: 'left' | 'right', obj = 'blob1'): PrFileQuery => ({ repo: 'r1', pr: 7, obj, side, ct: 3, iter: 2, base: 1 });

function comment(id: number, content: string, opts: Partial<PrComment> = {}): PrComment {
  return { id, parentCommentId: 0, author: LENA, content, publishedDate: '2026-02-01T09:00:00Z', commentType: 'text', ...opts };
}

function serverThreads(): PrThread[] {
  return [
    { id: 1, status: 'active', threadContext: { filePath: '/src/cart.ts', rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 3, offset: 1 } },
      comments: [comment(1, 'Use a ```suggestion\n```suggestion\nconst x = 2;\n```'), comment(2, 'mine', { author: ME }), comment(3, 'gone', { isDeleted: true })] },
    { id: 2, status: 2, threadContext: { filePath: '/src/cart.ts', leftFileStart: { line: 1, offset: 1 }, leftFileEnd: { line: 1, offset: 5 } }, comments: [comment(4, 'old code')] },
    { id: 3, status: 'active', threadContext: { filePath: '/src/other.ts', rightFileStart: { line: 1, offset: 1 } }, comments: [comment(5, 'elsewhere')] },
    { id: 4, status: 'active', threadContext: { filePath: '/src/cart.ts', rightFileStart: { line: 1, offset: 1 } }, comments: [comment(6, 'Policy', { commentType: 'system' })] },
    { id: 5, threadContext: null, comments: [comment(7, 'general')] },
  ];
}

function fakeClient() {
  const calls: unknown[][] = [];
  let failThreads = false;
  const client = {
    getThreads: async () => {
      calls.push(['getThreads']);
      if (failThreads) {
        failThreads = false;
        throw new Error('offline');
      }
      return serverThreads();
    },
    getMe: async () => ME,
    replyToThread: async (...a: unknown[]) => { calls.push(['reply', ...a]); return comment(10, String(a[3]), { author: undefined as unknown as typeof ME }); },
    createThread: async (...a: unknown[]) => { calls.push(['create', ...a]); return { id: 50, comments: [{ id: 11 }] }; },
    editComment: async (...a: unknown[]) => { calls.push(['edit', ...a]); },
    deleteComment: async (...a: unknown[]) => { calls.push(['delete', ...a]); },
    updateThreadStatus: async (...a: unknown[]) => { calls.push(['status', ...a]); },
  } as unknown as AdoClient;
  return { client, calls, failNext: () => { failThreads = true; } };
}

const LINES = ['import x;', 'const a = 1;', 'const b = 2;', 'export {};'];

describe('PrCommentController', () => {
  let ctl: PrCommentController;
  let fake: ReturnType<typeof fakeClient>;
  let rightDoc: ReturnType<typeof fakeDoc>;
  let leftDoc: ReturnType<typeof fakeDoc>;
  let answer: string | undefined;

  const run = (id: string, ...args: unknown[]) => registered.get(id)!(...args);
  const threadsOn = (doc: { uri: unknown }) => threads.filter(t => t.uri === doc.uri && !t.disposed);

  beforeEach(async () => {
    vscode.reset();
    resetExtras();
    threads.length = 0;
    answer = undefined;
    w.showWarningMessage = async () => answer;
    rightDoc = fakeDoc(makePrUri('/src/cart.ts', q('right')), LINES);
    leftDoc = fakeDoc(makePrUri('/src/cart.ts', q('left', 'blob0')), LINES, 'javascript');
    ws.textDocuments = [rightDoc, fakeDoc(vscode.Uri.file('/src/x.ts'), ['x'])];
    fake = fakeClient();
    ctl = new PrCommentController(fake.client);
    await flush();
  });
  afterEach(() => ctl.dispose());

  it('offers commenting ranges on PR files only', () => {
    const provider = controllers.at(-1).commentingRangeProvider;
    const [range] = provider.provideCommentingRanges(rightDoc);
    assert.deepEqual([range.start.line, range.end.line], [0, 3]);
    assert.deepEqual(provider.provideCommentingRanges(fakeDoc(makePrUri('/a.ts', q('left', '')), ['x'])), []);
    assert.deepEqual(provider.provideCommentingRanges(fakeDoc(vscode.Uri.file('/a.ts'), ['x'])), []);
  });

  it('shows the threads of each diff side with their status', async () => {
    const right = threadsOn(rightDoc);
    assert.equal(right.length, 1);
    assert.deepEqual([right[0].range.start.line, right[0].range.end.line], [1, 2]);
    assert.equal(right[0].comments.length, 2);
    assert.equal(right[0].comments[0].body.value, 'Use a ```suggestion\n**Suggested change:**\n```typescript\nconst x = 2;\n```');
    assert.equal(right[0].comments[0].contextValue, undefined);
    assert.equal(right[0].comments[1].contextValue, 'ado-comment-mine');
    assert.equal(right[0].label, 'Active');
    assert.equal(right[0].contextValue, 'ado-thread-active');

    await fire('openDoc', leftDoc);
    await fire('openDoc', leftDoc);
    await flush();
    const left = threadsOn(leftDoc);
    assert.equal(left.length, 1);
    assert.equal(left[0].label, 'Resolved');
    assert.equal(left[0].contextValue, 'ado-thread-resolved');
    assert.equal(fake.calls.filter(c => c[0] === 'getThreads').length, 1, 'threads are loaded once per pull request');
  });

  it('retries loading after an error and reloads on refresh', async () => {
    fake.failNext();
    ctl.reload();
    await flush();
    assert.equal(threadsOn(rightDoc).length, 0);
    ctl.reload();
    await flush();
    assert.equal(threadsOn(rightDoc).length, 1);
    await fire('closeDoc', rightDoc);
    assert.equal(threadsOn(rightDoc).length, 0);
  });

  it('replies to an existing thread', async () => {
    const t = threadsOn(rightDoc)[0];
    await run('azureDevOps.pr.submitComment', { thread: t, text: '   ' });
    await run('azureDevOps.pr.submitComment', { thread: t, text: ' Done ' });
    assert.deepEqual(fake.calls.at(-1), ['reply', 'r1', 7, 1, 'Done']);
    assert.equal(t.comments.length, 3);
    assert.equal(t.comments[2].author.name, 'Alex Morgan');
    assert.equal(t.comments[2].contextValue, 'ado-comment-mine');
  });

  it('starts a thread on the selected lines', async () => {
    await run('azureDevOps.pr.addComment');
    assert.match(vscode.messages[0], /Open a pull request file diff/);
    w.activeTextEditor = fakeEditor(rightDoc, new Range(1, 4, 3, 0));
    await run('azureDevOps.pr.addComment');
    const t = threads.at(-1)!;
    assert.deepEqual([t.range.start.line, t.range.end.line], [1, 2]);
    assert.equal(t.canReply, true);
    await run('azureDevOps.pr.submitComment', { thread: t, text: 'Why two constants?' });
    const [, repo, pr, body] = fake.calls.at(-1) as [string, string, number, any];
    assert.deepEqual([repo, pr], ['r1', 7]);
    assert.deepEqual(body.threadContext, { filePath: '/src/cart.ts', rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 3, offset: 13 } });
    assert.deepEqual(body.pullRequestThreadContext, { changeTrackingId: 3, iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2 } });
    assert.equal(t.comments[0].id, 11);
    assert.equal(t.label, 'Active');
    assert.ok(threadsOn(rightDoc).includes(t));
  });

  it('starts a thread on the left side of a file that is not open as a document', async () => {
    const t = { uri: leftDoc.uri, range: undefined, comments: [] as unknown[] };
    await run('azureDevOps.pr.submitComment', { thread: t, text: 'Old' });
    const [, , , body] = fake.calls.at(-1) as [string, string, number, any];
    assert.deepEqual(body.threadContext, { filePath: '/src/cart.ts', leftFileStart: { line: 1, offset: 1 }, leftFileEnd: { line: 1, offset: 1 } });
  });

  it('prepares a code suggestion on the right side only', async () => {
    w.activeTextEditor = fakeEditor(leftDoc, new Range(1, 0, 1, 0));
    await run('azureDevOps.pr.suggestChange');
    assert.match(vscode.messages[0], /right side/);
    w.activeTextEditor = fakeEditor(rightDoc, new Range(1, 0, 2, 3));
    await run('azureDevOps.pr.suggestChange');
    const t = threads.at(-1)!;
    const draft = t.comments[0];
    assert.equal(t.label, 'Suggest a change');
    assert.equal(draft.contextValue, 'ado-comment-draft');
    assert.equal(draft.body, '```suggestion\nconst a = 1;\nconst b = 2;\n```');
    await run('azureDevOps.pr.saveComment', draft);
    assert.equal((fake.calls.at(-1) as any[])[3].comments[0].content, draft.body);
    w.activeTextEditor = fakeEditor(rightDoc, new Range(0, 0, 0, 0));
    await run('azureDevOps.pr.suggestChange');
    const cancelled = threads.at(-1)!;
    run('azureDevOps.pr.cancelEdit', cancelled.comments[0]);
    assert.ok(cancelled.disposed);
  });

  it('edits own comments', async () => {
    const t = threadsOn(rightDoc)[0];
    const mine = t.comments[1];
    run('azureDevOps.pr.editComment', mine);
    assert.equal(mine.body, 'mine');
    assert.equal(mine.mode, (vscode as any).CommentMode.Editing);
    run('azureDevOps.pr.cancelEdit', mine);
    assert.equal(mine.body.value, 'mine');
    mine.body = '  ';
    await run('azureDevOps.pr.saveComment', mine);
    mine.body = 'mine, edited';
    await run('azureDevOps.pr.saveComment', mine);
    assert.deepEqual(fake.calls.at(-1), ['edit', 'r1', 7, 1, 2, 'mine, edited']);
    assert.equal(mine.raw, 'mine, edited');
    assert.equal(mine.mode, (vscode as any).CommentMode.Preview);
  });

  it('ignores edits and deletes of comments without a server thread', async () => {
    const t = { uri: rightDoc.uri, comments: [] as unknown[], dispose() { /* stub */ } };
    const c = { parent: t, body: 'x', id: 1 };
    await run('azureDevOps.pr.saveComment', c);
    await run('azureDevOps.pr.deleteComment', c);
    await run('azureDevOps.pr.resolveThread', t);
    assert.equal(fake.calls.filter(x => x[0] !== 'getThreads').length, 0);
  });

  it('deletes comments after confirmation and drops empty threads', async () => {
    const t = threadsOn(rightDoc)[0];
    await run('azureDevOps.pr.deleteComment', t.comments[1]);
    assert.equal(t.comments.length, 2);
    answer = 'Delete';
    await run('azureDevOps.pr.deleteComment', t.comments[1]);
    assert.deepEqual(fake.calls.at(-1), ['delete', 'r1', 7, 1, 2]);
    await run('azureDevOps.pr.deleteComment', t.comments[0]);
    assert.ok(t.disposed);
  });

  it('resolves and reactivates threads', async () => {
    const t = threadsOn(rightDoc)[0];
    await run('azureDevOps.pr.resolveThread', t);
    assert.deepEqual(fake.calls.at(-1), ['status', 'r1', 7, 1, 2]);
    assert.equal(t.state, (vscode as any).CommentThreadState.Resolved);
    await run('azureDevOps.pr.reactivateThread', t);
    assert.equal(t.label, 'Active');
    assert.equal(t.state, (vscode as any).CommentThreadState.Unresolved);
  });
});

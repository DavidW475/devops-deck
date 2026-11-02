import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { fakeDoc, fakeEditor, fakeRepo, fire, historyProviders, listeners, quickPicks, resetExtras, setGitRepositories } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { AdoError } from '../client';
import { BlameUi } from '../blame/blameUi';
import { HOVER_COMMANDS } from '../blame/blameModel';
import type { BlameLookups, CommitLine, LineLookup, PrLookup, TraceWorkItem } from '../blame/blameTypes';
import { PullRequest, WorkItem } from '../types';

const REMOTE = 'https://dev.azure.com/contoso/Fabrikam%20Shop/_git/web-shop';
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const REPO_ID = '11111111-1111-1111-1111-111111111111';
const FILE = '/src/web-shop/src/billing/tax.ts';
const NOW = Date.now();
const w = vscode as any;
const flush = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setImmediate(r)); } };
const tick = async (ms: number) => { mock.timers.tick(ms); await flush(); };

class Deferred<T> {
  resolve!: (v: T) => void;
  reject!: (e: unknown) => void;
  readonly promise = new Promise<T>((res, rej) => { this.resolve = res; this.reject = rej; });
}

const line = (over: Partial<CommitLine> = {}): CommitLine => ({
  kind: 'commit', sha: SHA, author: 'Erika Muster', authorTime: Math.floor(NOW / 1000) - 3 * 86400 - 3600, summary: 'Round VAT per line', boundary: false, ...over,
});
const pullRequest = (): PullRequest => ({
  pullRequestId: 1234, title: 'Fix VAT rounding', status: 'completed', sourceRefName: 'refs/heads/feature/vat', targetRefName: 'refs/heads/main',
} as PullRequest);
const prLookup = (): PrLookup => ({ repoId: REPO_ID, match: { pr: pullRequest(), via: 'mergeCommit', others: [] } });
const workItems = (): TraceWorkItem[] => [{
  item: { id: 4711, fields: { 'System.Title': 'VAT off by one cent', 'System.State': 'Active', 'System.WorkItemType': 'Bug' } } as unknown as WorkItem,
  sources: ['pr'],
}];

describe('BlameUi', () => {
  let repo: ReturnType<typeof fakeRepo>;
  let local: { repo: any; remoteName: string; repoName: string; project: string };
  let calls: [string, ...unknown[]][];
  let h: {
    lookupLine: (doc: any, line: number, o?: any) => Promise<LineLookup>;
    lookupCommit: (root: unknown, sha: unknown) => Promise<LineLookup>;
    pullRequest: (...a: any[]) => Promise<PrLookup | undefined>;
    workItems: (...a: any[]) => Promise<TraceWorkItem[]>;
  };
  let emitter: InstanceType<typeof vscode.EventEmitter<void>>;
  let connections: any;
  let ui: BlameUi;
  let statusItems: any[];
  let hoverRegs: { provider: any; disposed: boolean; dispose(): void }[];
  const origItem = w.window.createStatusBarItem;

  const lookups = (): BlameLookups => ({
    lookupLine: (...a) => { calls.push(['lookupLine', ...a]); return h.lookupLine(...a); },
    lookupCommit: (...a) => { calls.push(['lookupCommit', ...a]); return h.lookupCommit(...a); },
    pullRequest: (...a) => { calls.push(['pullRequest', ...a]); return h.pullRequest(...a); },
    workItems: (...a) => { calls.push(['workItems', ...a]); return h.workItems(...a); },
    commitUrl: (r, sha) => `https://dev.azure.com/contoso/${encodeURIComponent(r.project)}/_git/${r.repoName}/commit/${sha}`,
    reset: () => { calls.push(['reset']); },
  });
  const count = (name: string) => calls.filter(c => c[0] === name).length;
  const commit = (over: Partial<CommitLine> = {}): LineLookup => ({ state: 'commit', line: line(over), repo: local });

  beforeEach(() => {
    vscode.reset();
    resetExtras();
    mock.timers.enable({ apis: ['setTimeout'] });
    repo = fakeRepo('/src/web-shop', REMOTE, 'main');
    setGitRepositories([repo]);
    local = { repo, remoteName: 'origin', repoName: 'web-shop', project: 'Fabrikam Shop' };
    calls = [];
    h = {
      lookupLine: async () => commit(),
      lookupCommit: async () => commit(),
      pullRequest: async () => prLookup(),
      workItems: async () => workItems(),
    };
    emitter = new vscode.EventEmitter<void>();
    connections = { current: { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop'], detected: false }, onDidChange: emitter.event };
    statusItems = [];
    w.window.createStatusBarItem = (...args: unknown[]) => {
      const item = origItem(...args);
      item.args = args;
      statusItems.push(item);
      return item;
    };
    hoverRegs = [];
    w.languages.registerHoverProvider = (_s: unknown, provider: any) => {
      const r = { provider, disposed: false, dispose() { r.disposed = true; } };
      hoverRegs.push(r);
      return r;
    };
    delete w.workspace.asRelativePath;
    ui = new BlameUi(lookups(), connections);
  });
  afterEach(() => {
    ui.dispose();
    mock.timers.reset();
  });

  const editorAt = (lineNo: number, lines = ['const net = 1;', 'const tax = net * rate;', 'return net + tax;']) => {
    const doc = fakeDoc(vscode.Uri.file(FILE), lines);
    const editor = fakeEditor(doc, new (w.Range)(lineNo, 0, lineNo, 0));
    w.window.activeTextEditor = editor;
    return editor;
  };
  const list = () => quickPicks[quickPicks.length - 1];
  const labels = () => list().items.map(i => i.label);

  describe('trace list', () => {
    it('asks to open a file first', async () => {
      await ui.traceLine();
      assert.deepEqual(vscode.messages, ['Open a file first.']);
      assert.equal(quickPicks.length, 0);
    });

    it('opens at once and fills step by step', async () => {
      editorAt(1);
      const pr = new Deferred<PrLookup | undefined>();
      const wi = new Deferred<TraceWorkItem[]>();
      h.pullRequest = () => pr.promise;
      h.workItems = () => wi.promise;
      const done = ui.traceLine();
      await flush();
      assert.deepEqual(calls[0].slice(0, 2), ['lookupLine', calls[0][1]]);
      assert.deepEqual(calls[0][3], { explicit: true });
      assert.equal(calls[0][2], 1);
      const qp = list();
      assert.equal(qp.title, 'Line 2 of tax.ts');
      assert.equal(qp.matchOnDescription, true);
      assert.equal(qp.busy, true);
      assert.ok(qp.visible);
      assert.ok(labels().some(l => l.includes('Looking for the pull request')));
      assert.equal(qp.items[0].kind, -1);
      pr.resolve(prLookup());
      await flush();
      assert.ok(labels().some(l => l.includes('Looking for work items')));
      assert.ok(labels().some(l => l.includes('!1234')));
      assert.equal(qp.busy, true);
      wi.resolve(workItems());
      await done;
      assert.equal(qp.busy, false);
      assert.ok(labels().some(l => l.includes('#4711')));
      assert.ok(labels().every(l => !l.includes('Looking')));
      assert.equal(calls.find(c => c[0] === 'pullRequest')?.[3], undefined);
      assert.equal((calls.find(c => c[0] === 'workItems')?.[3] as any).pr.pullRequestId, 1234);
    });

    it('uses the workspace relative path when there is one', async () => {
      w.workspace.asRelativePath = () => 'src/billing/tax.ts';
      editorAt(41, Array.from({ length: 50 }, () => 'x'));
      await ui.traceLine();
      assert.equal(list().title, 'Line 42 of src/billing/tax.ts');
    });

    for (const state of ['unpublished', 'shallow'] as const) {
      it(`makes no REST call for a ${state} commit`, async () => {
        editorAt(0);
        h.lookupLine = async () => ({ state, line: line(), repo: local });
        await ui.traceLine();
        assert.equal(count('pullRequest') + count('workItems'), 0);
        assert.equal(list().busy, false);
        assert.ok(labels().length > 0);
      });
    }

    it('shows a failed step as a row and stops', async () => {
      editorAt(0);
      h.pullRequest = async () => { throw new Error('Service unavailable'); };
      await ui.traceLine();
      assert.ok(labels().some(l => l.includes('Service unavailable')));
      assert.equal(count('workItems'), 0);
      assert.equal(list().busy, false);
      assert.deepEqual(vscode.messages, []);
    });

    it('keeps the pull request in the list when the work item step fails', async () => {
      editorAt(0);
      h.workItems = async () => { throw new Error('Work items unavailable'); };
      await ui.traceLine();
      assert.ok(labels().some(l => l.includes('!1234')), 'the pull request stays');
      assert.ok(labels().some(l => l.includes('Work items unavailable')));
    });

    it('offers to sign in after an auth error', async () => {
      editorAt(0);
      vscode.answers.message.push('Sign In');
      h.workItems = async () => { throw new AdoError('Token expired', 401, true); };
      await ui.traceLine();
      assert.ok(labels().some(l => l.includes('Token expired')));
      assert.deepEqual(vscode.messages, ['DevOps Deck: Token expired']);
      assert.ok(vscode.executed.some(e => e[0] === 'azureDevOps.signIn'));
    });

    it('stops after the list is hidden', async () => {
      editorAt(0);
      const pr = new Deferred<PrLookup | undefined>();
      h.pullRequest = () => pr.promise;
      const done = ui.traceLine();
      await flush();
      const qp = list();
      qp.hide();
      assert.ok(qp.disposed);
      pr.resolve(prLookup());
      await done;
      assert.equal(count('workItems'), 0);
    });

    it('does not show an error after the list is hidden', async () => {
      editorAt(0);
      const pr = new Deferred<PrLookup | undefined>();
      h.pullRequest = () => pr.promise;
      const done = ui.traceLine();
      await flush();
      list().hide();
      pr.reject(new AdoError('late', 401, true));
      await done;
      assert.deepEqual(vscode.messages, []);
    });

    it('runs the action of the selected row and closes', async () => {
      editorAt(0);
      await ui.traceLine();
      const qp = list();
      qp.selectedItems = [qp.items.find(i => i.action?.command === 'azureDevOps.wi.open')];
      qp.fire('accept');
      assert.deepEqual(vscode.executed.at(-1), ['azureDevOps.wi.open', 4711]);
      assert.equal(qp.visible, false);
    });

    it('keeps the list open for a row without action', async () => {
      editorAt(0);
      h.pullRequest = async () => ({ repoId: REPO_ID });
      await ui.traceLine();
      const qp = list();
      qp.show();
      qp.selectedItems = [qp.items.find(i => i.label.includes('No pull request'))];
      qp.fire('accept');
      assert.equal(vscode.executed.length, 0);
      assert.ok(qp.visible);
      qp.selectedItems = [];
      qp.fire('accept');
      assert.equal(vscode.executed.length, 0);
    });

    it('says why a line cannot be traced', async () => {
      editorAt(0);
      h.lookupLine = async () => ({ state: 'uncommitted' });
      await ui.traceLine();
      assert.deepEqual(vscode.messages, ['This line is not committed yet.']);
      h.lookupLine = async () => ({ state: 'notAdo' });
      await ui.traceLine();
      assert.match(vscode.messages[1], /tax\.ts is not in a clone .* https:\/\/dev\.azure\.com\/contoso/);
      assert.equal(quickPicks.length, 0);
    });

    it('shows git errors plainly', async () => {
      editorAt(0);
      h.lookupLine = async () => ({ state: 'error', message: 'git failed' });
      await ui.traceLine();
      assert.deepEqual(vscode.messages, ['git failed']);
      assert.equal(vscode.executed.length, 0);
    });
  });

  describe('openForCommit', () => {
    it('opens the list for a commit', async () => {
      await ui.openForCommit('/src/web-shop', SHA);
      assert.deepEqual(calls[0], ['lookupCommit', '/src/web-shop', SHA]);
      assert.equal(list().title, 'Commit a1b2c3d');
      assert.ok(labels().some(l => l.includes('#4711')));
    });

    it('shows a message for a rejected root or sha', async () => {
      h.lookupCommit = async () => ({ state: 'error', message: 'Not a repository of this organization.' });
      await ui.openForCommit('/etc', SHA);
      assert.deepEqual(vscode.messages, ['Not a repository of this organization.']);
      assert.equal(quickPicks.length, 0);
    });

    it('makes no REST call for an unpublished commit', async () => {
      h.lookupCommit = async () => ({ state: 'unpublished', line: line(), repo: local });
      await ui.openForCommit('/src/web-shop', SHA);
      assert.equal(count('pullRequest'), 0);
    });
  });

  describe('openCommit', () => {
    it('opens the commit in the browser', async () => {
      await ui.openCommit('Fabrikam Shop', 'web-shop', SHA);
      assert.deepEqual(vscode.opened, [`https:///contoso/Fabrikam%20Shop/_git/web-shop/commit/${SHA}`]);
    });

    it('ignores invalid arguments', async () => {
      await ui.openCommit('', 'web-shop', SHA);
      await ui.openCommit('Fabrikam Shop', '', SHA);
      await ui.openCommit(5, 'web-shop', SHA);
      await ui.openCommit('Fabrikam Shop', {}, SHA);
      await ui.openCommit('Fabrikam Shop', 'web-shop', 'a1b2c3d');
      await ui.openCommit('Fabrikam Shop', 'web-shop', undefined);
      assert.deepEqual(vscode.opened, []);
    });
  });

  describe('hover link of the git extension', () => {
    it('registers once and answers for Azure Repos only', () => {
      ui.start();
      ui.start();
      assert.equal(historyProviders.length, 1);
      const p = historyProviders[0];
      assert.deepEqual(p.provideHoverCommands(repo), [{
        title: '$(git-pull-request) Pull Request & Work Items', command: 'azureDevOps.blame.openForCommit', arguments: ['/src/web-shop'],
      }]);
      const gh = fakeRepo('/src/gh', 'https://github.com/contoso/shop.git');
      assert.equal(p.provideHoverCommands(gh), undefined);
      connections.current = undefined;
      assert.equal(p.provideHoverCommands(repo), undefined);
      assert.equal(p.provideAvatar(), undefined);
      assert.equal(p.provideMessageLinks(), undefined);
      ui.dispose();
      assert.equal(historyProviders.length, 0);
    });

    it('works without the optional register function', () => {
      w.extensions.getExtension = () => ({ isActive: true, exports: { getAPI: () => ({ repositories: [] }) } });
      assert.doesNotThrow(() => ui.start());
    });

    it('survives a register function that throws', () => {
      w.extensions.getExtension = () => ({
        isActive: true, exports: { getAPI: () => ({ repositories: [], registerSourceControlHistoryItemDetailsProvider: () => { throw new Error('old'); } }) },
      });
      assert.doesNotThrow(() => ui.start());
    });
  });

  describe('annotations', () => {
    const setMode = (mode: unknown) => { vscode.settings['azureDevOps.blame.annotations'] = mode; };
    const status = () => statusItems[0];
    const decorations = (e: ReturnType<typeof editorAt>) => e.decorations;
    const lastRanges = (e: ReturnType<typeof editorAt>) => e.decorations.at(-1)?.ranges as any[];
    const run = async () => { ui.start(); await tick(1); };

    it('does nothing when off', async () => {
      const e = editorAt(1);
      ui.start();
      await tick(2000);
      await fire('selection', {});
      assert.equal(calls.length, 0);
      assert.equal(statusItems.length, 0);
      assert.equal(decorations(e).length, 0);
      assert.equal(listeners.selection?.length ?? 0, 0);
      assert.equal(hoverRegs.length, 0);
    });

    it('treats an unknown value as off', async () => {
      setMode('bogus');
      editorAt(1);
      await run();
      assert.equal(calls.length, 0);
    });

    it('shows author and pull request in the status bar', async () => {
      setMode('statusBar');
      editorAt(1);
      const pr = new Deferred<PrLookup | undefined>();
      h.pullRequest = () => pr.promise;
      await run();
      assert.deepEqual(status().args, ['azureDevOps.blame', vscode.StatusBarAlignment.Right, 199]);
      assert.equal(status().name, 'DevOps Deck: Line Blame');
      assert.equal(status().command.command, 'azureDevOps.blame.traceLine');
      assert.equal(status().text, '$(git-commit) Erika Muster, 3 days ago $(sync~spin)');
      assert.ok(status().visible);
      assert.deepEqual(calls.find(c => c[0] === 'pullRequest')?.[3], { background: true });
      assert.equal(calls.find(c => c[0] === 'lookupLine')?.[3] !== undefined, true);
      pr.resolve(prLookup());
      await flush();
      assert.equal(status().text, '$(git-commit) Erika Muster, 3 days ago · !1234 Fix VAT rounding');
      const tip = status().tooltip;
      assert.deepEqual(tip.isTrusted, { enabledCommands: [...HOVER_COMMANDS] });
      assert.equal(tip.supportHtml, false);
      assert.match(tip.value, /Erika Muster/);
      assert.equal(hoverRegs.length, 0);
      assert.equal(count('workItems'), 0);
    });

    it('shows inline text on the cursor line only, without icons', async () => {
      setMode('inline');
      const e = editorAt(1);
      await run();
      assert.equal(statusItems.length, 0);
      const d = decorations(e).at(-1)!;
      assert.equal((d.type as any).options.after.margin, '0 0 0 3em');
      assert.equal((d.type as any).options.after.color.id, 'editorCodeLens.foreground');
      assert.equal((d.type as any).options.rangeBehavior, 1);
      const ranges = d.ranges as any[];
      assert.equal(ranges.length, 1);
      assert.equal(ranges[0].range.start.line, 1);
      assert.equal(ranges[0].range.start.character, 'const tax = net * rate;'.length);
      assert.equal(ranges[0].renderOptions.after.contentText, 'Erika Muster, 3 days ago · !1234 Fix VAT rounding');
      assert.ok(!ranges[0].renderOptions.after.contentText.includes('$('));
      assert.equal(hoverRegs.length, 1);
    });

    it('shows both when asked', async () => {
      setMode('both');
      const e = editorAt(1);
      await run();
      assert.ok(status().visible);
      assert.equal(lastRanges(e).length, 1);
    });

    it('uses the local text for uncommitted lines and clears for other states', async () => {
      setMode('statusBar');
      editorAt(1);
      h.lookupLine = async () => ({ state: 'uncommitted' });
      await run();
      assert.equal(status().text, '$(git-commit) Not committed yet');
      assert.equal(count('pullRequest'), 0);
      h.lookupLine = async () => ({ state: 'notAdo' });
      await fire('selection', {});
      editorAt(2);
      await fire('selection', {});
      await tick(400);
      assert.equal(status().visible, false);
    });

    it('debounces cursor moves', async () => {
      setMode('statusBar');
      const e = editorAt(0);
      await run();
      assert.equal(count('lookupLine'), 1);
      e.selection = Object.assign(new (w.Range)(1, 0, 1, 0), { active: new (w.Position)(1, 0) });
      await fire('selection', {});
      await tick(200);
      await fire('selection', {});
      await tick(399);
      assert.equal(count('lookupLine'), 1);
      await tick(1);
      assert.equal(count('lookupLine'), 2);
      assert.equal(calls.filter(c => c[0] === 'lookupLine').at(-1)?.[2], 1);
    });

    it('ignores moves inside the annotated line', async () => {
      setMode('statusBar');
      const e = editorAt(1);
      await run();
      e.selection = Object.assign(new (w.Range)(1, 3, 1, 3), { active: new (w.Position)(1, 3) });
      await fire('selection', {});
      await tick(400);
      assert.equal(count('lookupLine'), 1);
      assert.ok(status().visible);
    });

    it('never paints a stale answer', async () => {
      setMode('statusBar');
      const e = editorAt(0);
      const first = new Deferred<LineLookup>();
      let n = 0;
      h.lookupLine = async () => (++n === 1 ? first.promise : commit({ author: 'Jonas Beispiel' }));
      await run();
      e.selection = Object.assign(new (w.Range)(1, 0, 1, 0), { active: new (w.Position)(1, 0) });
      await fire('selection', {});
      await tick(400);
      assert.match(status().text, /Jonas Beispiel/);
      first.resolve(commit({ author: 'Old Author' }));
      await flush();
      assert.match(status().text, /Jonas Beispiel/);
      assert.equal(count('pullRequest'), 1);
    });

    it('clears while typing and comes back when the cursor rests', async () => {
      setMode('both');
      const e = editorAt(1);
      await run();
      assert.ok(status().visible);
      await fire('changeDoc', { document: e.document, contentChanges: [{ text: 'x' }] });
      assert.equal(status().visible, false);
      assert.deepEqual(lastRanges(e), []);
      await tick(399);
      assert.equal(status().visible, false);
      await tick(1);
      assert.ok(status().visible);
      assert.equal(lastRanges(e).length, 1);
    });

    it('ignores edits of other documents', async () => {
      setMode('statusBar');
      editorAt(1);
      await run();
      await fire('changeDoc', { document: fakeDoc(vscode.Uri.file('/other.ts'), ['x']), contentChanges: [{ text: 'x' }] });
      assert.ok(status().visible);
    });

    it('asks nothing while the window is not focused', async () => {
      setMode('statusBar');
      editorAt(1);
      vscode.window.state.focused = false;
      await run();
      assert.equal(calls.length, 0);
      vscode.window.state.focused = true;
      await fire('windowState', { focused: false });
      await tick(10);
      assert.equal(calls.length, 0);
      await fire('windowState', { focused: true });
      await tick(1);
      assert.equal(count('lookupLine'), 1);
    });

    it('only handles file editors with one selection', async () => {
      setMode('statusBar');
      const e = editorAt(1);
      (e as any).selections = [e.selection, e.selection];
      await run();
      assert.equal(calls.length, 0);
      (e as any).selections = [e.selection];
      (e.document.uri as any) = { scheme: 'git', fsPath: FILE };
      await fire('activeEditor', e);
      await tick(400);
      assert.equal(calls.length, 0);
      w.window.activeTextEditor = undefined;
      await fire('activeEditor');
      await tick(400);
      assert.equal(calls.length, 0);
    });

    it('keeps the author when the search budget is used up', async () => {
      setMode('statusBar');
      editorAt(1);
      h.pullRequest = async () => undefined;
      await run();
      assert.equal(status().text, '$(git-commit) Erika Muster, 3 days ago');
    });

    it('reuses the pull request of the same commit', async () => {
      setMode('statusBar');
      const e = editorAt(0);
      await run();
      e.selection = Object.assign(new (w.Range)(1, 0, 1, 0), { active: new (w.Position)(1, 0) });
      await fire('selection', {});
      await tick(400);
      assert.equal(count('lookupLine'), 2);
      assert.equal(count('pullRequest'), 1);
      assert.match(status().text, /!1234/);
    });

    it('keeps the author after a REST error and tries again later', async () => {
      setMode('statusBar');
      const e = editorAt(0);
      h.pullRequest = async () => { throw new Error('boom'); };
      await run();
      assert.equal(status().text, '$(git-commit) Erika Muster, 3 days ago');
      e.selection = Object.assign(new (w.Range)(1, 0, 1, 0), { active: new (w.Position)(1, 0) });
      await fire('selection', {});
      await tick(400);
      assert.equal(count('pullRequest'), 2);
      assert.deepEqual(vscode.messages, []);
    });

    it('stops all REST after an auth error until reset', async () => {
      setMode('statusBar');
      const e = editorAt(0);
      h.pullRequest = async () => { throw new AdoError('expired', 401, true); };
      await run();
      assert.deepEqual(vscode.messages, []);
      e.selection = Object.assign(new (w.Range)(1, 0, 1, 0), { active: new (w.Position)(1, 0) });
      await fire('selection', {});
      await tick(400);
      assert.equal(count('pullRequest'), 1);
      assert.equal(status().text, '$(git-commit) Erika Muster, 3 days ago');
      h.pullRequest = async () => prLookup();
      ui.reset();
      assert.equal(count('reset'), 1);
      await tick(1);
      assert.equal(count('pullRequest'), 2);
      assert.match(status().text, /!1234/);
    });

    it('a timeout or a huge file only stops that file, not the annotations of other files, until reset', async () => {
      setMode('both');
      const slow = editorAt(0);
      h.lookupLine = async () => ({ state: 'error', message: 'slow', timedOut: true });
      await run();
      assert.deepEqual(vscode.messages, []);
      assert.equal(hoverRegs[0].disposed, false, 'annotations stay on');
      assert.equal((listeners.selection?.length ?? 0) > 0, true);
      // The same file is left alone from now on.
      slow.selection = Object.assign(new (w.Range)(1, 0, 1, 0), { active: new (w.Position)(1, 0) });
      await fire('selection', {});
      await tick(2000);
      assert.equal(count('lookupLine'), 1);
      // Another file still gets its annotation.
      h.lookupLine = async () => commit();
      const other = fakeEditor(fakeDoc(vscode.Uri.file('/src/web-shop/src/other.ts'), ['a', 'b']), new (w.Range)(0, 0, 0, 0));
      w.window.activeTextEditor = other;
      await fire('activeEditor', {});
      await tick(400);
      assert.equal(count('lookupLine'), 2);
      assert.ok(statusItems.at(-1).visible);
      // A reset gives the slow file another chance.
      w.window.activeTextEditor = slow;
      ui.reset();
      await tick(1);
      assert.equal(count('lookupLine'), 3);
      assert.equal(count('reset'), 1);
      assert.equal(lastRanges(slow).length, 1);
      // A file whose output is too large is treated the same way.
      h.lookupLine = async () => ({ state: 'error', message: 'git blame output is too large.', tooLarge: true });
      ui.reset();
      await tick(1);
      const before = count('lookupLine');
      await fire('selection', {});
      await tick(2000);
      assert.equal(count('lookupLine'), before);
    });

    it('does not follow the connection itself: the extension resets it where the connection changes', async () => {
      setMode('statusBar');
      editorAt(0);
      await run();
      emitter.fire();
      await tick(1);
      assert.equal(count('reset'), 0);
      assert.equal(count('lookupLine'), 1);
    });

    it('ignores a change event without changes (saving), and waits longer after typing in a document with unsaved changes', async () => {
      setMode('statusBar');
      const e = editorAt(1);
      await run();
      assert.equal(count('lookupLine'), 1);
      await fire('changeDoc', { document: e.document, contentChanges: [] });
      await tick(400);
      assert.equal(count('lookupLine'), 1, 'saving does not blame again');
      assert.ok(status().visible, 'and the annotation does not flicker away');
      (e.document as any).isDirty = true;
      await fire('changeDoc', { document: e.document, contentChanges: [{ text: 'x' }] });
      assert.equal(status().visible, false, 'typing hides the stale annotation');
      await tick(1999);
      assert.equal(count('lookupLine'), 1);
      await tick(1);
      assert.equal(count('lookupLine'), 2);
    });

    it('follows the setting', async () => {
      editorAt(0);
      ui.start();
      await tick(10);
      assert.equal(count('lookupLine'), 0);
      await vscode.workspace.getConfiguration('azureDevOps').update('blame.annotations', 'statusBar');
      await tick(1);
      assert.equal(count('lookupLine'), 1);
      assert.ok(status().visible);
      await vscode.workspace.getConfiguration('azureDevOps').update('blame.annotations', 'inline');
      await tick(1);
      assert.equal(status().visible, false);
      assert.equal(hoverRegs.length, 1);
      await vscode.workspace.getConfiguration('azureDevOps').update('blame.annotations', 'statusBar');
      await tick(1);
      assert.equal(hoverRegs[0].disposed, true);
      await vscode.workspace.getConfiguration('azureDevOps').update('blame.annotations', 'off');
      await tick(1);
      assert.equal(listeners.selection?.length ?? 0, 0);
      const n = count('lookupLine');
      await tick(2000);
      assert.equal(count('lookupLine'), n);
    });

    it('looks again when HEAD changes', async () => {
      setMode('statusBar');
      editorAt(0);
      repo.state.HEAD = { commit: 'c1' } as any;
      await run();
      assert.equal(count('lookupLine'), 1);
      await fire('repo:/src/web-shop');
      await tick(400);
      assert.equal(count('lookupLine'), 1);
      repo.state.HEAD = { commit: 'c2' } as any;
      await fire('repo:/src/web-shop');
      await tick(399);
      assert.equal(count('lookupLine'), 1);
      await tick(1);
      assert.equal(count('lookupLine'), 2);
    });

    describe('hover', () => {
      const hoverAt = (character: number, lineNo = 1, file = FILE) => {
        const doc = fakeDoc(vscode.Uri.file(file), ['const net = 1;', 'const tax = net * rate;', 'return net + tax;']);
        return hoverRegs[0].provider.provideHover(doc, new (w.Position)(lineNo, character));
      };
      const END = 'const tax = net * rate;'.length;

      beforeEach(async () => {
        setMode('inline');
        editorAt(1);
        await run();
      });

      it('answers at the end of the annotated line only', async () => {
        assert.equal(await hoverAt(3), undefined);
        assert.equal(await hoverAt(END - 1), undefined);
        assert.equal(await hoverAt(END, 0), undefined);
        assert.equal(await hoverAt(END, 1, '/other.ts'), undefined);
        assert.equal(count('workItems'), 0);
        const hover = await hoverAt(END);
        assert.ok(hover);
        const md = hover.contents;
        assert.match(md.value, /Erika Muster/);
        assert.match(md.value, /#4711/);
        assert.match(md.value, /!1234/);
        assert.deepEqual(md.isTrusted, { enabledCommands: [...HOVER_COMMANDS] });
        assert.equal(md.supportHtml, false);
        await hoverAt(END + 5);
        assert.equal(count('workItems'), 1);
      });

      it('leaves work items out when they fail', async () => {
        h.workItems = async () => { throw new Error('nope'); };
        const hover = await hoverAt(END);
        assert.ok(hover);
        assert.doesNotMatch(hover.contents.value, /#4711/);
        assert.match(hover.contents.value, /Erika Muster/);
      });

      it('answers nothing without an annotation or for uncommitted lines', async () => {
        h.lookupLine = async () => ({ state: 'uncommitted' });
        await fire('activeEditor');
        await tick(400);
        assert.equal(await hoverAt(END), undefined);
      });

      it('does not ask for work items after an auth error', async () => {
        h.workItems = async () => { throw new AdoError('expired', 401, true); };
        await hoverAt(END);
        await hoverAt(END);
        assert.equal(count('workItems'), 1);
        assert.deepEqual(vscode.messages, []);
      });
    });

    describe('collision hint', () => {
      const hint = 'Another extension or VS Code already shows blame at the end of the line.';

      it('offers the status bar when VS Code shows blame itself', async () => {
        vscode.settings['git.blame.editorDecoration.enabled'] = true;
        setMode('inline');
        editorAt(1);
        vscode.answers.message.push('Use status bar instead');
        await run();
        assert.deepEqual(vscode.messages, [hint]);
        assert.equal(vscode.settings['azureDevOps.blame.annotations'], 'statusBar');
        assert.equal(vscode.settings['git.blame.editorDecoration.enabled'], true);
      });

      it('offers it when GitLens shows the current line', async () => {
        const git = w.extensions.getExtension;
        w.extensions.getExtension = (id: string) => (id === 'eamodio.gitlens' ? { id } : git(id));
        vscode.settings['gitlens.currentLine.enabled'] = true;
        setMode('both');
        editorAt(1);
        await run();
        assert.deepEqual(vscode.messages, [hint]);
        assert.equal(vscode.settings['azureDevOps.blame.annotations'], 'both');
      });

      it('stays quiet without a collision, for the status bar and when GitLens is not installed', async () => {
        vscode.settings['gitlens.currentLine.enabled'] = true;
        setMode('inline');
        editorAt(1);
        await run();
        await vscode.workspace.getConfiguration('azureDevOps').update('blame.annotations', 'statusBar');
        vscode.settings['git.blame.editorDecoration.enabled'] = true;
        await vscode.workspace.getConfiguration('azureDevOps').update('blame.annotations', 'statusBar');
        assert.deepEqual(vscode.messages, []);
      });

      it('asks once per session', async () => {
        vscode.settings['git.blame.editorDecoration.enabled'] = true;
        setMode('inline');
        editorAt(1);
        await run();
        await vscode.workspace.getConfiguration('azureDevOps').update('blame.annotations', 'both');
        await vscode.workspace.getConfiguration('azureDevOps').update('blame.annotations', 'inline');
        assert.deepEqual(vscode.messages, [hint]);
      });
    });
  });
});

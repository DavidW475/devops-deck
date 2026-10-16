import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdoClient } from '../client';
import { ConnectionManager } from '../connection';
import { assertBranchName } from '../git';
import { PullRequest } from '../types';
import { glob, Watchers, watchersInWorkspaceSettings } from '../watchers/watchers';
import * as vscode from './vscodeStub';

const realGetConfiguration = vscode.workspace.getConfiguration;

/** Makes `inspect('watchers')` report the current value as coming from workspace (folder) settings. */
function watchersFromWorkspace(scope: 'workspaceValue' | 'workspaceFolderValue'): void {
  vscode.workspace.getConfiguration = ((section?: string) => {
    const cfg = realGetConfiguration(section);
    return { ...cfg, inspect: (key: string) => ({ [scope]: vscode.settings[`${section}.${key}`] }) };
  }) as typeof realGetConfiguration;
}

describe('assertBranchName', () => {
  it('accepts ordinary branch names', () => {
    for (const ok of ['main', 'feature/1234-login', 'users/alex/fix_v2', 'release-2026.10']) {
      assert.equal(assertBranchName(ok), ok);
    }
  });

  it('refuses names git would reject or misread as options', () => {
    const bad = ['', '-f', '--upload-pack=x', '/main', 'main/', 'main.', 'main.lock', 'a..b', 'a//b', 'a@{1}',
      'a b', 'a\tb', 'a\x7fb', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b'];
    for (const name of bad) {
      assert.throws(() => assertBranchName(name), /is not a valid branch name/, JSON.stringify(name));
    }
  });
});

describe('glob', () => {
  it('matches literally without wildcards, ignoring case', () => {
    assert.ok(glob('Main', 'main'));
    assert.ok(!glob('main', 'mainline'));
  });

  it('matches prefix, suffix and middle wildcards', () => {
    assert.ok(glob('release/*', 'release/2026.10'));
    assert.ok(glob('*-ci', 'web-shop-ci'));
    assert.ok(glob('*', ''));
    assert.ok(glob('a*b*c', 'aXXbYYc'));
    assert.ok(glob('a**c', 'ac'));
    assert.ok(!glob('a*b*c', 'aXXc'));
    assert.ok(!glob('ab*ba', 'aba'), 'prefix and suffix must not overlap');
    assert.ok(!glob('a*bc*cd', 'abcd'), 'middle part may not run into the suffix');
    assert.ok(!glob('x*', 'yx'));
    assert.ok(!glob('*x', 'xy'));
  });

  it('stays fast on inputs that make backtracking regexes explode', () => {
    const started = Date.now();
    assert.ok(!glob('*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000)));
    assert.ok(Date.now() - started < 1000);
  });
});

describe('watchers from workspace settings', () => {
  let watchers: Watchers | undefined;
  let active: PullRequest[];

  const client = {
    getMe: async () => ({ id: 'me', displayName: 'Alex Morgan' }),
    listActivePullRequests: async () => active,
    webUrl: (kind: string, a: string | number, b?: number) => `https://dev.azure.com/contoso/${kind}/${b ?? a}`,
  } as unknown as AdoClient;
  const connections = { current: { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop' }, onDidChange: () => ({ dispose() { /* stub */ } }) } as unknown as ConnectionManager;

  const pr = (id: number): PullRequest => ({
    pullRequestId: id, title: `PR ${id}`, status: 'active', createdBy: { id: 'lena', displayName: 'Lena Hoffmann' }, creationDate: new Date().toISOString(),
    sourceRefName: 'refs/heads/feature/x', targetRefName: 'refs/heads/main', repository: { id: 'r1', name: 'web-shop' }, reviewers: [],
  } as unknown as PullRequest);

  type Internals = { running: boolean; states: { nextRun: number }[]; tick(): Promise<void> };
  async function check(): Promise<void> {
    const w = watchers as unknown as Internals;
    while (w.running) {
      await new Promise(r => setTimeout(r, 1));
    }
    w.states.forEach(s => { s.nextRun = 0; });
    await w.tick();
  }

  beforeEach(() => {
    vscode.reset();
    active = [];
  });
  afterEach(() => {
    watchers?.dispose();
    watchers = undefined;
    vscode.workspace.getConfiguration = realGetConfiguration;
  });

  it('watchersInWorkspaceSettings tells user settings from workspace settings', () => {
    vscode.settings['azureDevOps.watchers'] = [];
    assert.equal(watchersInWorkspaceSettings(), false);
    watchersFromWorkspace('workspaceValue');
    assert.equal(watchersInWorkspaceSettings(), true);
    watchersFromWorkspace('workspaceFolderValue');
    assert.equal(watchersInWorkspaceSettings(), true);
  });

  it('runs only DevOps Deck commands for watchers from workspace settings', async () => {
    watchersFromWorkspace('workspaceValue');
    vscode.settings['azureDevOps.watchers'] = [{
      name: 'Repo watcher', type: 'pullRequest',
      actions: [{ command: 'workbench.action.terminal.sendSequence', args: [{ text: '${title}' }] }, { command: 'azureDevOps.refresh', args: ['${id}'] }],
    }];
    watchers = new Watchers(client, connections);
    await check();
    active = [pr(1)];
    await check();
    assert.deepEqual(vscode.executed, [['azureDevOps.refresh', '1']]);
  });

  it('runs any command for watchers from user settings', async () => {
    vscode.settings['azureDevOps.watchers'] = [{ name: 'Mine', type: 'pullRequest', actions: [{ command: 'my.command', args: ['${id}'] }] }];
    watchers = new Watchers(client, connections);
    await check();
    active = [pr(2)];
    await check();
    assert.deepEqual(vscode.executed, [['my.command', '2']]);
  });
});

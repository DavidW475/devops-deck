import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WatchEvent, Watchers } from '../watchers/watchers';
import { WatchersTree } from '../watchers/watchersTree';
import * as vscode from './vscodeStub';

type Visibility = (e: { visible: boolean }) => void;

interface FakeView {
  badge: unknown;
  description: unknown;
  visibility?: Visibility;
  disposed: boolean;
}

const EVENT: WatchEvent = {
  watcher: 'Bugs for me', message: 'New bug #42: Checkout fails', time: Date.UTC(2026, 9, 1, 8, 30), kind: 'workItem', id: 42,
  title: 'Checkout fails', url: 'https://dev.azure.com/contoso/Fabrikam%20Shop/_workitems/edit/42',
};

function fakeWatchers() {
  const listeners: (() => void)[] = [];
  const state = { unseen: 0, seen: 0, events: [] as WatchEvent[] };
  const watchers = {
    get unseenCount() { return state.unseen; },
    statusText: 'checked 1 min ago',
    eventsOf: (name: string) => state.events.filter(e => e.watcher === name),
    markSeen: () => { state.seen++; },
    onDidChange: (l: () => void) => { listeners.push(l); return { dispose() { listeners.length = 0; } }; },
  };
  return { watchers: watchers as unknown as Watchers, state, fire: () => listeners.forEach(l => l()) };
}

describe('WatchersTree', () => {
  const original = vscode.window.createTreeView;
  let view: FakeView;

  beforeEach(() => {
    vscode.reset();
    view = { badge: undefined, description: undefined, disposed: false };
    (vscode.window as Record<string, unknown>).createTreeView = () => ({
      get badge() { return view.badge; },
      set badge(v: unknown) { view.badge = v; },
      get description() { return view.description; },
      set description(v: unknown) { view.description = v; },
      onDidChangeVisibility: (l: Visibility) => { view.visibility = l; return { dispose() { /* nothing */ } }; },
      dispose: () => { view.disposed = true; },
    });
  });
  afterEach(() => {
    vscode.window.createTreeView = original;
  });

  it('lists watchers with their state and their recent events', () => {
    vscode.settings['azureDevOps.watchers'] = [
      { name: 'Bugs for me', type: 'workItem', where: "[System.WorkItemType] = 'Bug'" },
      { name: 'Paused <PRs>', type: 'pullRequest', enabled: false },
    ];
    const { watchers, state } = fakeWatchers();
    state.events = [EVENT];
    const tree = new WatchersTree(watchers);

    const roots = tree.getChildren();
    assert.equal(roots.length, 2);
    const active = tree.getTreeItem(roots[0]);
    assert.equal(active.label, 'Bugs for me');
    assert.equal(active.id, 'watcher:Bugs for me');
    assert.equal(active.contextValue, 'watcher-enabled');
    assert.equal((active.iconPath as vscode.ThemeIcon).id, 'checklist');
    assert.deepEqual(active.command, { command: 'azureDevOps.watchers.edit', title: 'Edit', arguments: [roots[0]] });

    const paused = tree.getTreeItem(roots[1]);
    assert.equal(paused.description, 'paused');
    assert.equal(paused.contextValue, 'watcher-disabled');
    assert.equal((paused.iconPath as vscode.ThemeIcon).id, 'debug-pause');
    assert.match((paused.tooltip as vscode.MarkdownString).value, /\*Paused\*/);

    const events = tree.getChildren(roots[0]);
    assert.equal(events.length, 1);
    const item = tree.getTreeItem(events[0]);
    assert.equal(item.label, EVENT.message);
    assert.equal((item.iconPath as vscode.ThemeIcon).id, 'note');
    assert.deepEqual(item.command, { command: 'azureDevOps.watchers.openEvent', title: 'Open', arguments: [EVENT] });
    assert.deepEqual(tree.getChildren(events[0]), []);

    const empty = tree.getChildren(roots[1]);
    assert.deepEqual(empty, [{ kind: 'empty' }]);
    assert.equal(tree.getTreeItem(empty[0]).label, 'No events yet');
  });

  it('updates badge and description on changes and marks events seen when shown', async () => {
    vscode.settings['azureDevOps.watchers'] = [{ name: 'Failed builds', type: 'pipeline' }];
    const { watchers, state, fire } = fakeWatchers();
    const tree = new WatchersTree(watchers);

    state.unseen = 3;
    fire();
    assert.deepEqual(view.badge, { value: 3, tooltip: '3 new watcher events' });
    assert.equal(view.description, 'checked 1 min ago');

    state.unseen = 0;
    await vscode.workspace.getConfiguration('azureDevOps').update('watchers', []);
    assert.equal(view.badge, undefined);
    assert.equal(view.description, undefined);

    view.visibility?.({ visible: false });
    assert.equal(state.seen, 0);
    view.visibility?.({ visible: true });
    assert.equal(state.seen, 1);

    tree.dispose();
    assert.ok(view.disposed);
  });
});

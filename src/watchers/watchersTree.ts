import * as vscode from 'vscode';
import { timeAgo } from '../util';
import { readWatchers, WatchEvent, WatcherConfig, Watchers, watcherSummary } from './watchers';

type Node = { kind: 'watcher'; index: number; config: WatcherConfig } | { kind: 'event'; event: WatchEvent } | { kind: 'empty' };

/** "Watchers" section below the dashboard: every watcher with its recent events; empty state comes from viewsWelcome. */
export class WatchersTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly watchers: Watchers) {
    this.view = vscode.window.createTreeView('azureDevOps.watchers', { treeDataProvider: this });
    this.disposables.push(this.view, this.changed,
      watchers.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('azureDevOps.watchers')) {
          this.refresh();
        }
      }),
      // New events count as seen once the section is on screen.
      this.view.onDidChangeVisibility(e => e.visible && watchers.markSeen()));
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  private refresh(): void {
    const unseen = this.watchers.unseenCount;
    this.view.badge = unseen ? { value: unseen, tooltip: `${unseen} new watcher event${unseen === 1 ? '' : 's'}` } : undefined;
    this.view.description = readWatchers().length ? this.watchers.statusText : undefined;
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return readWatchers().map((config, index) => ({ kind: 'watcher', index, config }));
    }
    if (node.kind === 'watcher') {
      const events = this.watchers.eventsOf(node.config.name).slice(0, 10);
      return events.length ? events.map(event => ({ kind: 'event', event })) : [{ kind: 'empty' }];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'watcher') {
      const { config } = node;
      const enabled = config.enabled !== false;
      const item = new vscode.TreeItem(config.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `watcher:${config.name}`;
      item.description = enabled ? watcherSummary(config) : 'paused';
      item.iconPath = new vscode.ThemeIcon(enabled ? (config.type === 'pullRequest' ? 'git-pull-request' : 'checklist') : 'debug-pause');
      item.tooltip = new vscode.MarkdownString(`**${config.name}**\n\n${watcherSummary(config)}${enabled ? '' : '\n\n*Paused*'}\n\nClick to edit.`);
      item.contextValue = enabled ? 'watcher-enabled' : 'watcher-disabled';
      item.command = { command: 'azureDevOps.watchers.edit', title: 'Edit', arguments: [node] };
      return item;
    }
    if (node.kind === 'event') {
      const e = node.event;
      const item = new vscode.TreeItem(e.message, vscode.TreeItemCollapsibleState.None);
      item.description = timeAgo(new Date(e.time).toISOString());
      item.iconPath = new vscode.ThemeIcon(e.kind === 'pullRequest' ? 'git-pull-request' : 'note');
      item.tooltip = `${e.message}\n${new Date(e.time).toLocaleString()}`;
      item.command = { command: 'azureDevOps.watchers.openEvent', title: 'Open', arguments: [e] };
      return item;
    }
    const item = new vscode.TreeItem('No events yet', vscode.TreeItemCollapsibleState.None);
    item.description = 'changes from now on show up here';
    return item;
  }
}

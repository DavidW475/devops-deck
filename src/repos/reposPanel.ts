import * as path from 'path';
import * as vscode from 'vscode';
import { AdoClient, ZERO_OBJECT_ID } from '../client';
import { ConnectionManager } from '../connection';
import { currentBranch, localAdoRepos } from '../git';
import { openBranchDiff } from '../pullRequests/prFiles';
import { BranchStats, GitRepository } from '../types';
import { errorMessage, guarded, panelHtml, plural, shortRef } from '../util';

/** Repositories of the project and their branches: ahead/behind, compare, create, delete, checkout, clone. */
export class ReposPanel {
  private static current?: ReposPanel;
  private repos: GitRepository[] = [];
  private repo?: GitRepository;
  private branches: BranchStats[] = [];

  static show(client: AdoClient, connections: ConnectionManager, extensionUri: vscode.Uri, onChange: () => void): void {
    if (ReposPanel.current) {
      ReposPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.repos', 'Repositories', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    ReposPanel.current = new ReposPanel(panel, client, connections, onChange);
    panel.onDidDispose(() => ReposPanel.current = undefined);
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Repositories', BODY, '', 'repos.js');
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AdoClient,
    private readonly connections: ConnectionManager,
    private readonly onChange: () => void,
  ) {
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private async handle(m: any): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.init(m.repoId);
        return;
      case 'repo':
        await this.selectRepo(String(m.repoId));
        return;
      case 'refresh':
        await this.selectRepo(this.repo?.id ?? '');
        return;
      case 'compare':
        await this.compare(String(m.branch));
        return;
      case 'create':
        await this.createBranch(m.from ? String(m.from) : undefined);
        return;
      case 'delete':
        await this.deleteBranch(String(m.branch));
        return;
      case 'checkout':
        await this.checkout(String(m.branch));
        return;
      case 'pr':
        await vscode.commands.executeCommand('azureDevOps.pr.create', this.repo?.name, String(m.branch));
        return;
      case 'clone':
        await this.clone();
        return;
      case 'browser':
        if (this.repo) {
          const base = this.client.webUrl('repo', this.repo.name);
          await vscode.env.openExternal(vscode.Uri.parse(m.branch ? `${base}?version=GB${encodeURIComponent(String(m.branch))}` : base));
        }
        return;
    }
  }

  private async init(preferred?: string): Promise<void> {
    try {
      this.repos = await this.client.listRepositories();
      // Start with the repository of the open folder, if any.
      const localName = localAdoRepos(this.connections.current)[0]?.repoName.toLowerCase();
      const repo = this.repos.find(r => r.id === preferred) ?? this.repos.find(r => r.name.toLowerCase() === localName) ?? this.repos[0];
      this.post({ type: 'repos', repos: this.repos.map(r => ({ id: r.id, name: r.name, size: r.size })), selected: repo?.id });
      if (repo) {
        await this.selectRepo(repo.id);
      }
    } catch (e) {
      this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  private async selectRepo(repoId: string): Promise<void> {
    const repo = this.repos.find(r => r.id === repoId);
    if (!repo) {
      return;
    }
    this.repo = repo;
    this.panel.title = `Branches: ${repo.name}`;
    const base = shortRef(repo.defaultBranch);
    this.post({ type: 'loading', repoId });
    if (!base) {
      this.branches = [];
      this.post({ type: 'branches', repoId, base: '', branches: [], local: [] });
      return;
    }
    try {
      this.branches = await this.client.getBranchStats(repo.id, base);
      const local = localAdoRepos(this.connections.current).find(r => r.repoName.toLowerCase() === repo.name.toLowerCase());
      this.post({
        type: 'branches', repoId, base, current: currentBranch(local?.repo), cloned: !!local,
        branches: this.branches.map(b => ({
          name: b.name, ahead: b.aheadCount, behind: b.behindCount, isBase: !!b.isBaseVersion || b.name === base,
          commit: b.commit.commitId.slice(0, 8), message: (b.commit.comment ?? '').split('\n')[0], author: b.commit.author?.name, date: b.commit.author?.date,
        })).sort((a, b) => Number(b.isBase) - Number(a.isBase) || (b.date ?? '').localeCompare(a.date ?? '')),
      });
    } catch (e) {
      this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  private async compare(branch: string): Promise<void> {
    const repo = this.repo;
    const base = shortRef(repo?.defaultBranch);
    if (!repo || !base) {
      return;
    }
    const diff = await this.client.diffBranches(repo.id, base, branch);
    if (!diff.changes.length) {
      void vscode.window.showInformationMessage(`${branch} has no changes compared with ${base}.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(diff.changes.map(c => ({
      label: path.posix.basename(c.item.path), description: path.posix.dirname(c.item.path), detail: c.changeType, c,
    })), { title: `${branch} vs ${base}: ${diff.changes.length} file${diff.changes.length === 1 ? '' : 's'} (${diff.aheadCount ?? '?'} ahead, ${diff.behindCount ?? '?'} behind)`, matchOnDescription: true });
    if (pick) {
      await openBranchDiff(repo.id, pick.c, base, branch);
    }
  }

  private async createBranch(from?: string): Promise<void> {
    const repo = this.repo;
    if (!repo) {
      return;
    }
    const source = from ?? shortRef(repo.defaultBranch);
    const name = await vscode.window.showInputBox({
      title: `New branch in ${repo.name}`, prompt: `Created from ${source}`, placeHolder: 'feature/my-change',
      validateInput: v => branchNameProblem(v.trim(), this.branches),
    });
    if (!name) {
      return;
    }
    const sourceCommit = this.branches.find(b => b.name === source)?.commit.commitId;
    if (!sourceCommit) {
      throw new Error(`Branch ${source} was not found.`);
    }
    await this.client.updateRef(repo.id, name.trim(), ZERO_OBJECT_ID, sourceCommit);
    vscode.window.setStatusBarMessage(`$(check) Created ${name.trim()}`, 3000);
    await this.selectRepo(repo.id);
  }

  private async deleteBranch(branch: string): Promise<void> {
    const repo = this.repo;
    const b = this.branches.find(x => x.name === branch);
    if (!repo || !b) {
      return;
    }
    const unmerged = b.aheadCount ? ` It has ${plural(b.aheadCount, 'commit')} that are not in ${shortRef(repo.defaultBranch)}.` : '';
    const ok = await vscode.window.showWarningMessage(`Delete the branch "${branch}" on the server?${unmerged}`, { modal: true }, 'Delete');
    if (ok !== 'Delete') {
      return;
    }
    await this.client.updateRef(repo.id, branch, b.commit.commitId, ZERO_OBJECT_ID);
    vscode.window.setStatusBarMessage(`$(trash) Deleted ${branch}`, 3000);
    this.onChange();
    await this.selectRepo(repo.id);
  }

  private async checkout(branch: string): Promise<void> {
    const local = localAdoRepos(this.connections.current).find(r => r.repoName.toLowerCase() === this.repo?.name.toLowerCase());
    if (!local) {
      throw new Error(`No open folder is a clone of ${this.repo?.name}. Clone it first.`);
    }
    const repo = local.repo;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking out ${branch}…` }, async () => {
      await repo.fetch(local.remoteName, branch);
      const exists = repo.state.refs.some((r: any) => r.type === 0 && r.name === branch);
      if (exists) {
        await repo.checkout(branch);
      } else {
        await repo.createBranch(branch, true, `${local.remoteName}/${branch}`);
        await repo.setBranchUpstream?.(branch, `${local.remoteName}/${branch}`).catch(() => undefined);
      }
    });
    await this.selectRepo(this.repo!.id);
  }

  private async clone(): Promise<void> {
    if (this.repo?.remoteUrl) {
      await vscode.commands.executeCommand('git.clone', this.repo.remoteUrl);
    }
  }
}

/** Why a new branch name cannot be used, or undefined when it is fine. */
function branchNameProblem(name: string, existing: BranchStats[]): string | undefined {
  if (!name) {
    return 'Enter a name';
  }
  if (existing.some(b => b.name === name)) {
    return 'A branch with this name exists';
  }
  return /[\s~^:?*[\\]|\.\.|@\{|\/$|^\//.test(name) ? 'Not a valid branch name' : undefined;
}

const BODY = `<div class="run repos" id="root">
  <header class="run-head">
    <div class="run-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg></div>
    <div class="run-head-text"><h1>Branches</h1><p class="muted" id="subtitle">Loading repositories…</p></div>
    <span class="spacer"></span>
    <select id="repo" title="Repository"></select>
  </header>
  <div class="repo-bar">
    <label class="log-search"><input id="filter" type="search" placeholder="Filter branches…" spellcheck="false"></label>
    <span class="spacer"></span>
    <button class="btn" data-act="create">New branch</button>
    <button class="btn ghost" data-act="clone" id="clone">Clone</button>
    <button class="btn ghost" data-act="browser">Open in browser</button>
    <button class="btn ghost" data-act="refresh">Refresh</button>
  </div>
  <div id="error" class="run-alert" hidden></div>
  <div id="list" class="branch-list"></div>
</div>`;

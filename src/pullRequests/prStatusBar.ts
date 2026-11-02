import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { ConnectionManager, gitApi } from '../connection';
import { currentBranch, isInside, LocalRepo, localAdoRepos } from '../git';
import { Build, GitRepository, PullRequest } from '../types';
import { mdEscape, plural, shortRef } from '../util';
import { summarizeChecks } from './checks';

const BUILD_ICON: Record<string, string> = {
  succeeded: '$(pass)', failed: '$(error)', partiallySucceeded: '$(warning)', canceled: '$(circle-slash)',
};

/**
 * Status bar entry for the checked-out branch: its pull request with the state of the required checks,
 * or "Create pull request" when there is none, plus the latest pipeline run of the branch.
 */
export class PrStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('azureDevOps.prStatus', vscode.StatusBarAlignment.Left, 49);
  private readonly disposables: vscode.Disposable[] = [this.item];
  private readonly repoCache = new Map<string, Promise<GitRepository>>();
  private readonly hooked = new Set<unknown>();
  private timer?: ReturnType<typeof setTimeout>;
  private seq = 0;
  private lastKey = '';

  constructor(private readonly client: AdoClient, private readonly connections: ConnectionManager) {
    this.item.name = 'DevOps Deck: Pull Request';
    this.disposables.push(
      connections.onDidChange(() => { this.repoCache.clear(); this.schedule(0); }),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(500)),
      vscode.window.onDidChangeWindowState(e => e.focused && this.schedule(0)),
      vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('azureDevOps') && this.schedule(0)),
    );
    this.schedule(2000);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach(d => d.dispose());
  }

  /** Re-checks soon; the branch or the remote state may have changed. */
  refresh(): void {
    this.schedule(0);
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), ms);
  }

  private interval(): number {
    const s = vscode.workspace.getConfiguration('azureDevOps').get<number>('refreshInterval', 60);
    return s > 0 ? Math.max(30, s) * 1000 : 0;
  }

  /** Watches HEAD changes of every repository once. */
  private hookRepos(): void {
    const git = gitApi();
    for (const repo of git?.repositories ?? []) {
      if (!this.hooked.has(repo)) {
        this.hooked.add(repo);
        this.disposables.push(repo.state.onDidChange(() => {
          const key = `${repo.rootUri.fsPath}:${currentBranch(repo)}`;
          if (key !== this.lastKey) {
            this.schedule(300);
          }
        }));
      }
    }
  }

  private activeRepo(): LocalRepo | undefined {
    const repos = localAdoRepos(this.connections.current);
    const file = vscode.window.activeTextEditor?.document.uri;
    if (file?.scheme === 'file') {
      const hit = repos.find(r => isInside(file.fsPath, r.repo.rootUri.fsPath));
      if (hit) {
        return hit;
      }
    }
    return repos[0];
  }

  private async update(): Promise<void> {
    const seq = ++this.seq;
    this.hookRepos();
    const local = this.activeRepo();
    const branch = currentBranch(local?.repo);
    if (!local || !branch || !vscode.window.state.focused && this.lastKey) {
      if (!local || !branch) {
        this.item.hide();
      }
      return this.again();
    }
    this.lastKey = `${local.repo.rootUri.fsPath}:${branch}`;
    try {
      const api = this.client.forProject(local.project);
      const cacheKey = `${local.project}/${local.repoName}`;
      let repo = this.repoCache.get(cacheKey);
      if (!repo) {
        repo = api.getRepository(local.repoName);
        repo.catch(() => this.repoCache.delete(cacheKey));
        this.repoCache.set(cacheKey, repo);
      }
      const r = await repo;
      const [prs, builds] = await Promise.all([
        api.findPullRequestsForBranch(r.id, branch),
        api.listBuilds({ branchName: `refs/heads/${branch}`, top: 1 }).catch(() => [] as Build[]),
      ]);
      if (seq !== this.seq) {
        return;
      }
      await this.render(r, branch, prs[0], builds[0]);
    } catch {
      this.item.hide();
    }
    this.again();
  }

  private again(): void {
    const ms = this.interval();
    if (ms) {
      this.schedule(ms);
    }
  }

  private async render(repo: GitRepository, branch: string, pr: PullRequest | undefined, build: Build | undefined): Promise<void> {
    const run = buildInfo(build);
    if (pr) {
      await this.renderPr(pr, run);
    } else {
      this.renderNoPr(repo, branch, build, run);
    }
  }

  /** No pull request yet: on the default branch only the latest run, elsewhere "Create PR". */
  private renderNoPr(repo: GitRepository, branch: string, build: Build | undefined, run: { text: string; tip: string }): void {
    const isDefault = shortRef(repo.defaultBranch) === branch;
    if (isDefault && !build) {
      this.item.hide();
      return;
    }
    if (isDefault) {
      this.item.text = `$(rocket)${run.text}`;
      this.item.tooltip = new vscode.MarkdownString(`**${branch}**${run.tip}`);
      this.item.command = { command: 'azureDevOps.pipelines.openRun', title: 'Open run', arguments: [build!.id, repo.project?.name] };
    } else {
      this.item.text = `$(git-pull-request-create) Create PR${run.text}`;
      this.item.tooltip = new vscode.MarkdownString(`No pull request for **${branch}** yet. Click to create one.${run.tip}`);
      this.item.command = { command: 'azureDevOps.pr.create', title: 'Create pull request', arguments: [repo.name, branch] };
    }
    this.item.show();
  }

  private async renderPr(pr: PullRequest, run: { text: string; tip: string }): Promise<void> {
    const checks = pr.repository.project?.id
      ? await this.client.getPolicyEvaluations(pr.repository.project.id, pr.pullRequestId).then(summarizeChecks, () => undefined) : undefined;
    const state = checks?.state ?? 'none';
    const approvals = pr.reviewers.filter(r => r.vote >= 5).length;
    const thumbs = approvals ? ` $(thumbsup) ${approvals}` : '';
    this.item.text = `$(git-pull-request) !${pr.pullRequestId}${CHECK_ICON[state]}${thumbs}${run.text}`;
    const checkText: Record<string, string> = {
      fail: `\n\n${plural(checks?.failing ?? 0, 'required check')} failing`,
      pending: `\n\n${plural(checks?.pending ?? 0, 'required check')} pending`,
      ok: '\n\nAll required checks passed',
      none: '',
    };
    const lines = [
      `**!${pr.pullRequestId} ${mdEscape(pr.title)}**${pr.isDraft ? ' (draft)' : ''}`,
      `\n\n${shortRef(pr.sourceRefName)} → ${shortRef(pr.targetRefName)}`,
      checkText[state],
      pr.autoCompleteSetBy ? '\n\nAuto-complete is set' : '',
      run.tip,
      '\n\nClick to open the overview.',
    ];
    this.item.tooltip = new vscode.MarkdownString(lines.join(''));
    this.item.command = { command: 'azureDevOps.pr.openOverview', title: 'Open pull request', arguments: [pr.repository.id, pr.pullRequestId] };
    this.item.show();
  }

}

const CHECK_ICON: Record<string, string> = { fail: ' $(error)', pending: ' $(clock)', ok: ' $(check)', none: '' };

/** Icon and tooltip line for the latest run of the branch. */
function buildInfo(build: Build | undefined): { text: string; tip: string } {
  if (!build) {
    return { text: '', tip: '' };
  }
  const done = build.status === 'completed';
  const icon = done ? BUILD_ICON[build.result ?? ''] ?? '$(circle-outline)' : '$(sync~spin)';
  return { text: ` ${icon}`, tip: `\n\nLatest run: ${build.definition.name} #${build.buildNumber} — ${done ? build.result : build.status}` };
}

import * as vscode from 'vscode';
import { AdoClient, PrArtifact } from '../client';
import { PolicyEvaluation, PrThread, PullRequest, WorkItem } from '../types';
import { avatarHtml, errorMessage, escapeHtml, guarded, LINK_PICKER_SCRIPT, LinkCandidate, linkPickerHtml, panelHtml, renderMarkdown, shortRef, showError, timeAgo, VOTE_LABELS } from '../util';
import { CheckKind, summarizeChecks } from './checks';
import { checkoutPullRequest } from './prFiles';

const VOTE_CLASS: Record<string, string> = { '10': 'ok', '5': 'ok', '-5': 'warn', '-10': 'bad', '0': 'muted' };
const THREAD_STATUS = ['unknown', 'active', 'fixed', 'wontFix', 'closed', 'byDesign', 'pending'];

const CHECK_LABEL: Record<CheckKind, string> = { fail: 'Failed', expired: 'Expired', running: 'Running', queued: 'Pending', ok: 'Passed' };
const CHECK_ICON: Record<CheckKind, string> = {
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  fail: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  expired: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  running: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  queued: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
};

/** Rich overview of a pull request: description, reviewers, discussion and review actions. */
export class PullRequestPanel {
  private static readonly panels = new Map<string, PullRequestPanel>();
  private pr?: PullRequest;
  private linkedWorkItems: number[] = [];

  static show(client: AdoClient, extensionUri: vscode.Uri, repoId: string, prId: number, onChange: () => void): void {
    const key = `${repoId}/${prId}`;
    const existing = PullRequestPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      void existing.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.pr', `PR !${prId}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const instance = new PullRequestPanel(panel, client, extensionUri, repoId, prId, onChange);
    PullRequestPanel.panels.set(key, instance);
    panel.onDidDispose(() => PullRequestPanel.panels.delete(key));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AdoClient,
    private readonly extensionUri: vscode.Uri,
    private readonly repoId: string,
    private readonly prId: number,
    private readonly onChange: () => void,
  ) {
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Loading', '<div class="loading"><div class="spinner"></div></div>', '');
    void this.render();
  }

  private async handle(m: any): Promise<void> {
    const { repoId, prId, client } = this;
    switch (m.type) {
      case 'vote':
        await client.vote(repoId, prId, m.vote);
        void vscode.window.setStatusBarMessage(`$(check) Voted: ${VOTE_LABELS[String(m.vote)]}`, 3000);
        break;
      case 'comment':
        await client.createThread(repoId, prId, { comments: [{ parentCommentId: 0, content: m.text, commentType: 1 }], status: 1 });
        break;
      case 'reply':
        await client.replyToThread(repoId, prId, m.threadId, m.text);
        break;
      case 'threadStatus':
        await client.updateThreadStatus(repoId, prId, m.threadId, m.status);
        break;
      case 'complete':
        if (!(await this.complete())) {
          return;
        }
        break;
      case 'draft':
        await client.updatePullRequest(repoId, prId, { isDraft: m.value });
        break;
      case 'abandon': {
        const ok = await vscode.window.showWarningMessage(`Abandon PR !${prId}?`, { modal: true }, 'Abandon');
        if (ok !== 'Abandon') {
          return;
        }
        await client.updatePullRequest(repoId, prId, { status: 'abandoned' });
        break;
      }
      case 'checkout':
        if (this.pr) {
          await checkoutPullRequest(this.pr);
        }
        return;
      case 'browser':
        if (this.pr) {
          await vscode.env.openExternal(vscode.Uri.parse(client.webUrl('pr', this.pr.repository.name, prId)));
        }
        return;
      case 'openRun':
        await vscode.commands.executeCommand('azureDevOps.pipelines.openRun', Number(m.id));
        return;
      case 'openWorkItem':
        await vscode.commands.executeCommand('azureDevOps.wi.open', m.id);
        return;
      case 'linkSearch': {
        try {
          const items = (await client.searchWorkItems(String(m.text ?? '')))
            .filter(w => !this.linkedWorkItems.includes(w.id))
            .map((w): LinkCandidate => ({
              key: String(w.id),
              title: `#${w.id} ${w.fields['System.Title']}`,
              sub: `${w.fields['System.WorkItemType']} · ${w.fields['System.State']}`,
            }));
          void this.panel.webview.postMessage({ type: 'linkResults', seq: m.seq, items });
        } catch (e) {
          void this.panel.webview.postMessage({ type: 'linkResults', seq: m.seq, error: errorMessage(e) });
        }
        return;
      }
      case 'link':
        await client.linkPullRequest(Number(m.key), this.artifact());
        break;
      case 'unlink':
        await client.unlinkPullRequest(Number(m.key), this.artifact());
        break;
      case 'refresh':
        break;
      default:
        return;
    }
    await this.render();
    this.onChange();
  }

  private artifact(): PrArtifact {
    const projectId = this.pr?.repository.project?.id;
    if (!projectId) {
      throw new Error('The pull request has not loaded yet.');
    }
    return { projectId, repoId: this.repoId, prId: this.prId };
  }

  private async complete(): Promise<boolean> {
    const pr = this.pr;
    if (!pr) {
      return false;
    }
    const strategy = await vscode.window.showQuickPick([
      { label: 'Squash commit', value: 'squash' },
      { label: 'Merge (no fast-forward)', value: 'noFastForward' },
      { label: 'Rebase and fast-forward', value: 'rebase' },
      { label: 'Semi-linear merge', value: 'rebaseMerge' },
    ], { title: `Complete PR !${pr.pullRequestId}`, placeHolder: 'Merge strategy' });
    if (!strategy) {
      return false;
    }
    const del = await vscode.window.showQuickPick(['Delete source branch', 'Keep source branch'], { title: 'Source branch' });
    if (!del) {
      return false;
    }
    await this.client.updatePullRequest(this.repoId, this.prId, {
      status: 'completed',
      lastMergeSourceCommit: pr.lastMergeSourceCommit,
      completionOptions: { mergeStrategy: strategy.value, deleteSourceBranch: del.startsWith('Delete'), transitionWorkItems: true },
    });
    void vscode.window.showInformationMessage(`PR !${pr.pullRequestId} completed.`);
    return true;
  }

  private async render(): Promise<void> {
    try {
      const [pr, threads, wiIds, me] = await Promise.all([
        this.client.getPullRequest(this.repoId, this.prId),
        this.client.getThreads(this.repoId, this.prId),
        this.client.getPullRequestWorkItemIds(this.repoId, this.prId).catch(() => [] as number[]),
        this.client.getMe(),
      ]);
      const projectId = pr.repository.project?.id;
      const [workItems, checks] = await Promise.all([
        wiIds.length ? this.client.getWorkItems(wiIds) : Promise.resolve([] as WorkItem[]),
        projectId ? this.client.getPolicyEvaluations(projectId, pr.pullRequestId).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      this.pr = pr;
      this.linkedWorkItems = wiIds;
      this.panel.title = `PR !${pr.pullRequestId}: ${pr.title}`;
      const description = pr.description ? await renderMarkdown(pr.description) : '<p class="muted">No description.</p>';
      const threadHtml = await Promise.all(threads
        .filter(t => t.comments.some(c => !c.isDeleted && c.commentType !== 'system' && c.commentType !== 3))
        .sort((a, b) => (b.publishedDate ?? '').localeCompare(a.publishedDate ?? ''))
        .map(t => this.threadHtml(t)));
      const myVote = pr.reviewers.find(r => r.id === me.id)?.vote ?? 0;
      this.panel.webview.html = panelHtml(this.panel.webview, this.extensionUri, pr.title,
        this.bodyHtml(pr, description, threadHtml, workItems, myVote, checks), SCRIPT);
    } catch (e) {
      await showError(e);
    }
  }

  private async threadHtml(t: PrThread): Promise<string> {
    const status = typeof t.status === 'number' ? THREAD_STATUS[t.status] : t.status ?? 'unknown';
    const resolved = ['fixed', 'wontFix', 'closed', 'byDesign'].includes(status);
    const comments = await Promise.all(t.comments
      .filter(c => !c.isDeleted && c.commentType !== 'system' && c.commentType !== 3)
      .map(async c => `<div class="comment">${avatarHtml(c.author.displayName, 26)}
        <div class="comment-body"><div class="comment-head"><strong>${escapeHtml(c.author.displayName)}</strong>
        <span class="muted">${timeAgo(c.publishedDate)}</span></div>
        <div class="md">${await renderMarkdown(c.content ?? '')}</div></div></div>`));
    const ctx = t.threadContext;
    const where = ctx ? `<div class="thread-file">${escapeHtml(ctx.filePath)}${ctx.rightFileStart ? `:${ctx.rightFileStart.line}` : ''}</div>` : '';
    return `<div class="thread ${resolved ? 'resolved' : ''}">
      <div class="thread-head">${where}<span class="pill ${resolved ? 'ok' : 'info'}">${escapeHtml(status === 'fixed' ? 'resolved' : status)}</span>
        <button class="link" data-status="${resolved ? 1 : 2}" data-thread="${t.id}">${resolved ? 'Reactivate' : 'Resolve'}</button></div>
      ${comments.join('')}
      <form class="reply" data-thread="${t.id}"><input name="text" placeholder="Reply…" autocomplete="off"><button class="btn small">Reply</button></form>
    </div>`;
  }

  /** Branch policies (builds, reviewers, comments, status checks) with failing ones first; undefined if they could not be loaded. */
  private checksHtml(evaluations: PolicyEvaluation[] | undefined): { summary: string; card: string } {
    if (!evaluations) {
      return { summary: '', card: '' };
    }
    const { checks, failing, pending, state } = summarizeChecks(evaluations);
    const plural = (n: number) => `${n} required check${n === 1 ? '' : 's'}`;
    const summary = state === 'fail' ? `<span class="pill bad">${plural(failing)} failing</span>`
      : state === 'pending' ? `<span class="pill info">${plural(pending)} pending</span>`
      : state === 'ok' ? '<span class="pill ok">All required checks passed</span>' : '';
    const rows = checks.map(c => `<div class="check check-${c.kind}">
        <svg class="check-icon ${c.kind === 'running' ? 'spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="${CHECK_LABEL[c.kind]}">${CHECK_ICON[c.kind]}</svg>
        <div class="check-body"><div class="check-name">${escapeHtml(c.name)}${c.required ? '' : ' <span class="pill muted">optional</span>'}</div>
          <div class="check-sub">${CHECK_LABEL[c.kind]}${c.definitionName && c.definitionName !== c.name ? ` · ${escapeHtml(c.definitionName)}` : ''}</div></div>
        ${c.buildId ? `<button class="btn ghost small" data-run="${c.buildId}" title="Open run overview">Open run</button>` : ''}
      </div>`).join('');
    return {
      summary,
      card: `<div class="card"><h2>Checks <span class="count">${checks.length}</span></h2>${rows || '<p class="muted">No branch policies apply.</p>'}</div>`,
    };
  }

  private bodyHtml(pr: PullRequest, description: string, threads: string[], workItems: WorkItem[], myVote: number,
    evaluations: PolicyEvaluation[] | undefined): string {
    const checks = this.checksHtml(evaluations);
    const voteBtn = (vote: number, label: string, cls: string) =>
      `<button class="btn ${cls} ${myVote === vote ? 'active' : ''}" data-vote="${vote}">${label}</button>`;
    const reviewers = pr.reviewers.length ? pr.reviewers.map(r => `<div class="person">${avatarHtml(r.displayName)}
        <div><div>${escapeHtml(r.displayName)}${r.isRequired ? ' <span class="pill muted">required</span>' : ''}</div>
        <div class="vote ${VOTE_CLASS[String(r.vote)] ?? 'muted'}">${VOTE_LABELS[String(r.vote)] ?? r.vote}</div></div></div>`).join('')
      : '<p class="muted">No reviewers.</p>';
    const wis = (workItems.length ? workItems.map(w => `<div class="linked"><a class="wi-link" data-wi="${w.id}"><span class="pill muted">${escapeHtml(w.fields['System.WorkItemType'])}</span>
        #${w.id} ${escapeHtml(w.fields['System.Title'])}</a>
        <button class="unlink" data-unlink="${w.id}" title="Remove link">✕</button></div>`).join('') : '<p class="muted">None linked.</p>')
      + linkPickerHtml('Link work item… (ID or title)');
    const status = pr.status !== 'active' ? `<span class="pill info">${escapeHtml(pr.status)}</span>` : '';
    const conflicts = pr.mergeStatus === 'conflicts' ? '<span class="pill bad">Merge conflicts</span>' : '';
    return `
<header class="hero">
  <div class="hero-top">
    <span class="pill ${pr.isDraft ? 'muted' : 'info'}">${pr.isDraft ? 'Draft' : 'Active'}</span>${status}${conflicts}${checks.summary}
    <span class="muted">!${pr.pullRequestId} · ${escapeHtml(pr.repository.name)}</span>
  </div>
  <h1>${escapeHtml(pr.title)}</h1>
  <div class="hero-meta">${avatarHtml(pr.createdBy.displayName, 22)} <strong>${escapeHtml(pr.createdBy.displayName)}</strong>
    <span class="muted">opened ${timeAgo(pr.creationDate)}</span>
    <span class="branch">${escapeHtml(shortRef(pr.sourceRefName))}</span><span class="muted">→</span><span class="branch">${escapeHtml(shortRef(pr.targetRefName))}</span>
  </div>
  <div class="toolbar">
    ${voteBtn(10, 'Approve', 'primary')}${voteBtn(5, 'Approve with suggestions', '')}${voteBtn(-5, 'Wait for author', '')}${voteBtn(-10, 'Reject', 'danger')}
    ${myVote !== 0 ? voteBtn(0, 'Reset vote', 'ghost') : ''}
    <span class="spacer"></span>
    <button class="btn ghost" data-action="checkout">Checkout</button>
    <button class="btn ghost" data-action="draft" data-value="${!pr.isDraft}">${pr.isDraft ? 'Publish' : 'Mark as draft'}</button>
    <button class="btn ghost" data-action="abandon">Abandon</button>
    <button class="btn ghost" data-action="browser">Open in browser</button>
    <button class="btn ghost" data-action="refresh">Refresh</button>
    <button class="btn success" data-action="complete">Complete</button>
  </div>
</header>
<main class="grid">
  <section>
    <div class="card"><h2>Description</h2><div class="md">${description}</div></div>
    <div class="card"><h2>Discussion <span class="count">${threads.length}</span></h2>
      <form id="new-comment"><textarea name="text" rows="3" placeholder="Add a comment… (Markdown)"></textarea>
      <div class="right"><button class="btn primary">Comment</button></div></form>
      ${threads.join('') || '<p class="muted">No comments yet.</p>'}
    </div>
  </section>
  <aside>
    ${checks.card}
    <div class="card"><h2>Reviewers</h2>${reviewers}</div>
    <div class="card"><h2>Work items <span class="count">${workItems.length}</span></h2>${wis}</div>
  </aside>
</main>`;
  }
}

const SCRIPT = LINK_PICKER_SCRIPT + `
document.addEventListener('click', e => {
  const el = e.target.closest('[data-vote],[data-action],[data-status],[data-wi],[data-run]');
  if (!el || el.closest('.md')) return; // ignore look-alike controls inside rendered descriptions/comments
  if (el.dataset.vote !== undefined) vscode.postMessage({ type: 'vote', vote: Number(el.dataset.vote) });
  else if (el.dataset.status) vscode.postMessage({ type: 'threadStatus', threadId: Number(el.dataset.thread), status: Number(el.dataset.status) });
  else if (el.dataset.wi) vscode.postMessage({ type: 'openWorkItem', id: Number(el.dataset.wi) });
  else if (el.dataset.run) { vscode.postMessage({ type: 'openRun', id: Number(el.dataset.run) }); return; }
  else vscode.postMessage({ type: el.dataset.action, value: el.dataset.value === 'true' });
  if (el.classList.contains('btn')) el.classList.add('busy');
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  if (form.closest('.md')) return;
  const text = form.elements.text.value.trim();
  if (!text) return;
  if (form.id === 'new-comment') vscode.postMessage({ type: 'comment', text });
  else vscode.postMessage({ type: 'reply', threadId: Number(form.dataset.thread), text });
  form.querySelector('button').classList.add('busy');
});
`;

import * as vscode from 'vscode';
import { AdoClient, PrArtifact } from '../client';
import { GitCommitRef, PolicyEvaluation, PrIteration, PrThread, PullRequest, WorkItem } from '../types';
import {
  avatarHtml, errorMessage, escapeHtml, guarded, LINK_PICKER_SCRIPT, LinkCandidate, linkPickerHtml, LivePanel, panelHtml, plural, renderMarkdown, shortRef, showError, timeAgo, viewButtonsHtml, VOTE_LABELS,
} from '../util';
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
  /** Remembers the newest iteration each PR had when its overview was last closed ("new since your last visit"). */
  private static store?: vscode.Memento;

  static useStore(store: vscode.Memento): void {
    PullRequestPanel.store = store;
  }
  private pr?: PullRequest;
  private linkedWorkItems: number[] = [];
  private latestIteration = 0;
  private requiredReviewer = false;
  private readonly page: LivePanel;

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
    void instance.render();
    panel.onDidDispose(() => {
      PullRequestPanel.panels.delete(key);
      void instance.markSeen();
    });
  }

  private visitKey(): string {
    return `prVisit:${this.client.connection.orgUrl}/${this.repoId}/${this.prId}`;
  }

  private lastSeenIteration(): number | undefined {
    return PullRequestPanel.store?.get<number>(this.visitKey());
  }

  private async markSeen(): Promise<void> {
    if (this.latestIteration) {
      await PullRequestPanel.store?.update(this.visitKey(), this.latestIteration);
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AdoClient,
    extensionUri: vscode.Uri,
    private readonly repoId: string,
    private readonly prId: number,
    private readonly onChange: () => void,
  ) {
    this.page = new LivePanel(panel, extensionUri, SCRIPT);
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Loading', '<div class="loading"><div class="spinner"></div></div>', '');
  }

  /** Messages that only navigate or search; true when handled. */
  private async handleView(m: any): Promise<boolean> {
    switch (m.type) {
      case 'checkout':
        if (this.pr) {
          await checkoutPullRequest(this.pr);
        }
        return true;
      case 'browser':
        if (this.pr) {
          await vscode.env.openExternal(vscode.Uri.parse(this.client.webUrl('pr', this.pr.repository.name, this.prId, this.pr.repository.project?.name)));
        }
        return true;
      case 'openRun':
        await vscode.commands.executeCommand('azureDevOps.pipelines.openRun', Number(m.id), this.pr?.repository.project?.name);
        return true;
      case 'openWorkItem':
        await vscode.commands.executeCommand('azureDevOps.wi.open', Number(m.id));
        return true;
      case 'compare':
        await vscode.commands.executeCommand('azureDevOps.pr.compareIterations', this.repoId, this.prId, Number(m.base), Number(m.target));
        return true;
      case 'reviewerRequired':
        this.requiredReviewer = !!m.value;
        return true;
      case 'linkSearch':
        await (m.picker === 'reviewer' ? this.searchReviewers(String(m.text ?? ''), m.seq) : this.searchWorkItems(String(m.text ?? ''), m.seq));
        return true;
      default:
        return false;
    }
  }

  private async searchWorkItems(text: string, seq: number): Promise<void> {
    try {
      // Work items of the PR's project.
      const items = (await this.client.forProject(this.pr?.repository.project?.name).searchWorkItems(text))
        .filter(w => !this.linkedWorkItems.includes(w.id))
        .map((w): LinkCandidate => ({
          key: String(w.id),
          title: `#${w.id} ${w.fields['System.Title']}`,
          sub: `${w.fields['System.WorkItemType']} · ${w.fields['System.State']}`,
        }));
      this.page.post({ type: 'linkResults', seq, items });
    } catch (e) {
      this.page.post({ type: 'linkResults', seq, error: errorMessage(e) });
    }
  }

  private async handle(m: any): Promise<void> {
    if (await this.handleView(m)) {
      return;
    }
    if (await this.page.action(() => this.act(m))) {
      await this.render();
      this.onChange();
    }
  }

  /** Runs a page action; true when the pull request changed (re-render), false when it was cancelled or unknown. */
  private async act(m: any): Promise<boolean> {
    const { repoId, prId, client } = this;
    switch (m.type) {
      case 'vote':
        await client.vote(repoId, prId, Number(m.vote));
        await this.markSeen();
        vscode.window.setStatusBarMessage(`$(check) Voted: ${VOTE_LABELS[String(m.vote)]}`, 3000);
        return true;
      case 'removeReviewer':
        await client.removeReviewer(repoId, prId, String(m.id));
        return true;
      case 'autoComplete':
        return this.autoComplete(!!m.value);
      case 'seen':
        await this.markSeen();
        return true;
      case 'comment':
        await client.createThread(repoId, prId, { comments: [{ parentCommentId: 0, content: String(m.text ?? ''), commentType: 1 }], status: 1 });
        return true;
      case 'reply':
        await client.replyToThread(repoId, prId, Number(m.threadId), String(m.text ?? ''));
        return true;
      case 'threadStatus':
        await client.updateThreadStatus(repoId, prId, Number(m.threadId), Number(m.status));
        return true;
      case 'complete':
        return this.complete();
      case 'draft':
        await client.updatePullRequest(repoId, prId, { isDraft: !!m.value });
        return true;
      case 'abandon':
        return this.abandon();
      case 'link':
        await this.link(m);
        return true;
      case 'unlink':
        await client.unlinkPullRequest(Number(m.key), this.artifact());
        return true;
      case 'refresh':
        return true;
      default:
        return false;
    }
  }

  private async abandon(): Promise<boolean> {
    const ok = await vscode.window.showWarningMessage(`Abandon PR !${this.prId}?`, { modal: true }, 'Abandon');
    if (ok !== 'Abandon') {
      return false;
    }
    await this.client.updatePullRequest(this.repoId, this.prId, { status: 'abandoned' });
    return true;
  }

  /** Adds a reviewer (reviewer picker) or links a work item (link picker). */
  private async link(m: { key?: unknown; picker?: unknown }): Promise<void> {
    if (m.picker === 'reviewer') {
      await this.client.addReviewer(this.repoId, this.prId, String(m.key), this.requiredReviewer);
    } else {
      await this.client.linkPullRequest(Number(m.key), this.artifact());
    }
  }

  private artifact(): PrArtifact {
    const projectId = this.pr?.repository.project?.id;
    if (!projectId) {
      throw new Error('The pull request has not loaded yet.');
    }
    return { projectId, repoId: this.repoId, prId: this.prId };
  }

  private async searchReviewers(text: string, seq: number): Promise<void> {
    try {
      const present = new Set(this.pr?.reviewers.map(r => r.id));
      const people = text.trim().length >= 2 ? await this.client.searchIdentities(text.trim()) : [];
      const items = people.filter(p => !present.has(p.id))
        .map((p): LinkCandidate => ({ key: p.id, title: p.displayName, sub: p.isGroup ? 'Group' : p.uniqueName }));
      this.page.post({ type: 'linkResults', picker: 'reviewer', seq, items });
    } catch (e) {
      this.page.post({ type: 'linkResults', picker: 'reviewer', seq, error: errorMessage(e) });
    }
  }

  /** Merge strategy and branch deletion, asked before completing or setting auto-complete. */
  private async completionOptions(title: string): Promise<{ mergeStrategy: string; deleteSourceBranch: boolean; transitionWorkItems: boolean } | undefined> {
    const strategy = await vscode.window.showQuickPick([
      { label: 'Squash commit', value: 'squash' },
      { label: 'Merge (no fast-forward)', value: 'noFastForward' },
      { label: 'Rebase and fast-forward', value: 'rebase' },
      { label: 'Semi-linear merge', value: 'rebaseMerge' },
    ], { title, placeHolder: 'Merge strategy' });
    if (!strategy) {
      return undefined;
    }
    const del = await vscode.window.showQuickPick(['Delete source branch', 'Keep source branch'], { title: 'Source branch' });
    if (!del) {
      return undefined;
    }
    return { mergeStrategy: strategy.value, deleteSourceBranch: del.startsWith('Delete'), transitionWorkItems: true };
  }

  private async complete(): Promise<boolean> {
    const pr = this.pr;
    if (!pr) {
      return false;
    }
    const options = await this.completionOptions(`Complete PR !${pr.pullRequestId}`);
    if (!options) {
      return false;
    }
    await this.client.updatePullRequest(this.repoId, this.prId, {
      status: 'completed',
      lastMergeSourceCommit: pr.lastMergeSourceCommit,
      completionOptions: options,
    });
    void vscode.window.showInformationMessage(`PR !${pr.pullRequestId} completed.`);
    return true;
  }

  /** Auto-complete merges the PR as soon as all required policies pass. */
  private async autoComplete(enable: boolean): Promise<boolean> {
    if (!enable) {
      await this.client.setAutoComplete(this.repoId, this.prId, undefined);
      return true;
    }
    const options = await this.completionOptions(`Set auto-complete for PR !${this.prId}`);
    if (!options) {
      return false;
    }
    await this.client.setAutoComplete(this.repoId, this.prId, options);
    vscode.window.setStatusBarMessage(`$(check) Auto-complete set for PR !${this.prId}`, 3000);
    return true;
  }

  private async render(): Promise<void> {
    try {
      const [pr, threads, wiIds, me, iterations, commits] = await Promise.all([
        this.client.getPullRequest(this.repoId, this.prId),
        this.client.getThreads(this.repoId, this.prId),
        this.client.getPullRequestWorkItemIds(this.repoId, this.prId).catch(() => [] as number[]),
        this.client.getMe(),
        this.client.getIterations(this.repoId, this.prId).catch(() => [] as PrIteration[]),
        this.client.getPullRequestCommits(this.repoId, this.prId).catch(() => [] as GitCommitRef[]),
      ]);
      this.latestIteration = Math.max(0, ...iterations.map(i => i.id));
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
      this.page.show(pr.title, this.bodyHtml(pr, description, threadHtml, workItems, myVote, checks)
        .replace('<!--updates-->', () => this.updatesHtml(iterations) + this.commitsHtml(commits)));
    } catch (e) {
      this.page.idle();
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
    const line = ctx?.rightFileStart ? `:${ctx.rightFileStart.line}` : '';
    const where = ctx ? `<div class="thread-file">${escapeHtml(ctx.filePath)}${line}</div>` : '';
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
    const SUMMARY: Record<string, string> = {
      fail: `<span class="pill bad">${plural(failing, 'required check')} failing</span>`,
      pending: `<span class="pill info">${plural(pending, 'required check')} pending</span>`,
      ok: '<span class="pill ok">All required checks passed</span>',
    };
    const summary = SUMMARY[state] ?? '';
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

  /** Pushes to the PR ("iterations"), newest first, each comparable with the one before or with the last visit. */
  private updatesHtml(iterations: PrIteration[]): string {
    if (!iterations.length) {
      return '';
    }
    const seen = this.lastSeenIteration();
    const latest = this.latestIteration;
    const banner = seen && seen < latest
      ? `<div class="since"><span><strong>${plural(latest - seen, 'new update')}</strong> since your last visit</span>
          <button class="btn primary small" data-compare="${seen}" data-target="${latest}">Review changes since update ${seen}</button>
          <button class="btn ghost small" data-action="seen">Mark as seen</button></div>` : '';
    const rows = [...iterations].sort((a, b) => b.id - a.id).map(it => `<div class="iteration">
        <span class="iter-id">${it.id}</span>
        <div class="grow"><div>${escapeHtml(it.description || (it.id === 1 ? 'Created' : 'Pushed'))}${seen && it.id > seen ? ' <span class="pill info">new</span>' : ''}</div>
          <div class="muted small">${escapeHtml(it.author?.displayName ?? '')} · ${timeAgo(it.createdDate)}</div></div>
        <button class="btn ghost small" data-compare="${it.id - 1}" data-target="${it.id}" title="${it.id === 1 ? 'Files of the first push' : `Changes between update ${it.id - 1} and ${it.id}`}">Changes</button>
      </div>`).join('');
    return `<div class="card"><h2>Updates <span class="count">${iterations.length}</span></h2>${banner}<div class="iterations">${rows}</div></div>`;
  }

  private commitsHtml(commits: GitCommitRef[]): string {
    if (!commits.length) {
      return '';
    }
    const rows = commits.slice(0, 50).map(c => `<div class="commit"><span class="mono muted">${escapeHtml(c.commitId.slice(0, 8))}</span>
        <span class="grow" title="${escapeHtml(c.comment ?? '')}">${escapeHtml((c.comment ?? '').split('\n')[0])}</span>
        <span class="muted small">${escapeHtml(c.author?.name ?? '')} · ${timeAgo(c.author?.date)}</span></div>`).join('');
    return `<details class="card" id="commits"><summary><h2>Commits <span class="count">${commits.length}</span></h2></summary>${rows}</details>`;
  }

  private bodyHtml(pr: PullRequest, description: string, threads: string[], workItems: WorkItem[], myVote: number,
    evaluations: PolicyEvaluation[] | undefined): string {
    const checks = this.checksHtml(evaluations);
    const autoLabel = pr.autoCompleteSetBy ? 'Cancel auto-complete' : 'Set auto-complete';
    const autoButton = pr.isDraft ? '' : `<button class="btn ghost" data-action="autoComplete" data-value="${!pr.autoCompleteSetBy}">${autoLabel}</button>`;
    const voteBtn = (vote: number, label: string, cls: string) =>
      `<button class="btn ${cls} ${myVote === vote ? 'active' : ''}" data-vote="${vote}">${label}</button>`;
    const reviewers = (pr.reviewers.length ? pr.reviewers.map(r => `<div class="person">${avatarHtml(r.displayName)}
        <div class="grow"><div>${escapeHtml(r.displayName)}${r.isRequired ? ' <span class="pill muted">required</span>' : ''}</div>
        <div class="vote ${VOTE_CLASS[String(r.vote)] ?? 'muted'}">${VOTE_LABELS[String(r.vote)] ?? r.vote}</div></div>
        <button class="unlink" data-remove-reviewer="${escapeHtml(r.id)}" title="Remove reviewer">✕</button></div>`).join('')
      : '<p class="muted">No reviewers.</p>')
      + linkPickerHtml('Add reviewer… (name or e-mail)', 'reviewer')
      + `<label class="req-toggle"><input type="checkbox" id="reqReviewer"${this.requiredReviewer ? ' checked' : ''}> Add as required reviewer</label>`;
    const auto = pr.autoCompleteSetBy
      ? `<span class="pill ok" title="Completes automatically once all required policies pass">Auto-complete · ${escapeHtml(pr.autoCompleteSetBy.displayName)}</span>` : '';
    const wis = (workItems.length ? workItems.map(w => `<div class="linked"><a class="wi-link" data-wi="${w.id}"><span class="pill muted">${escapeHtml(w.fields['System.WorkItemType'])}</span>
        #${w.id} ${escapeHtml(w.fields['System.Title'])}</a>
        <button class="unlink" data-unlink="${w.id}" title="Remove link">✕</button></div>`).join('') : '<p class="muted">None linked.</p>')
      + linkPickerHtml('Link work item… (ID or title)');
    const status = pr.status !== 'active' ? `<span class="pill info">${escapeHtml(pr.status)}</span>` : '';
    const conflicts = pr.mergeStatus === 'conflicts' ? '<span class="pill bad">Merge conflicts</span>' : '';
    return `
<header class="hero">
  <div class="hero-top">
    <span class="pill ${pr.isDraft ? 'muted' : 'info'}">${pr.isDraft ? 'Draft' : 'Active'}</span>${status}${conflicts}${checks.summary}${auto}
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
    ${viewButtonsHtml()}
    ${autoButton}
    <button class="btn success" data-action="complete">Complete</button>
  </div>
</header>
<main class="grid">
  <section>
    <div class="card"><h2>Description</h2><div class="md">${description}</div></div>
    <!--updates-->
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

/** Delegated listeners only: LIVE_UPDATE_SCRIPT replaces the page content in place after every action. */
const SCRIPT = LINK_PICKER_SCRIPT + `
const VIEW_ACTIONS = ['checkout', 'browser'];
document.addEventListener('change', e => {
  if (e.target.id === 'reqReviewer') vscode.postMessage({ type: 'reviewerRequired', value: e.target.checked });
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-vote],[data-action],[data-status],[data-wi],[data-run],[data-compare],[data-remove-reviewer]');
  if (!el || el.closest('.md')) return; // ignore look-alike controls inside rendered descriptions/comments
  const d = el.dataset;
  if (d.compare !== undefined) vscode.postMessage({ type: 'compare', base: Number(d.compare), target: Number(d.target) });
  else if (d.wi) vscode.postMessage({ type: 'openWorkItem', id: Number(d.wi) });
  else if (d.run) vscode.postMessage({ type: 'openRun', id: Number(d.run) });
  else if (d.removeReviewer) postAction({ type: 'removeReviewer', id: d.removeReviewer }, el);
  else if (d.vote !== undefined) postAction({ type: 'vote', vote: Number(d.vote) }, el);
  else if (d.status) postAction({ type: 'threadStatus', threadId: Number(d.thread), status: Number(d.status) }, el);
  else if (VIEW_ACTIONS.includes(d.action)) vscode.postMessage({ type: d.action });
  else postAction({ type: d.action, value: d.value === 'true' }, el);
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  if (form.closest('.md')) return;
  const text = form.elements.text.value.trim();
  if (!text) return;
  const button = form.querySelector('button');
  if (form.id === 'new-comment') postAction({ type: 'comment', text }, button);
  else postAction({ type: 'reply', threadId: Number(form.dataset.thread), text }, button);
});
`;

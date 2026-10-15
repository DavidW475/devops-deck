import * as vscode from 'vscode';
import { AdoClient, PrArtifact, parsePrArtifact } from '../client';
import { PullRequest, WorkItem, WorkItemComment, WorkItemState } from '../types';
import { avatarHtml, errorMessage, escapeHtml, guarded, LINK_PICKER_SCRIPT, LinkCandidate, linkPickerHtml, panelHtml, shortRef, showError, timeAgo } from '../util';

interface LinkedPr {
  artifact: PrArtifact;
  pr?: PullRequest;
}

/** Detail view of a single work item with state switching, assignment and comments. */
export class WorkItemPanel {
  private static readonly panels = new Map<number, WorkItemPanel>();
  private item?: WorkItem;
  private linkedPrs: LinkedPr[] = [];
  private activePrs?: Promise<PullRequest[]>;

  static show(client: AdoClient, extensionUri: vscode.Uri, id: number, onChange: () => void): void {
    const existing = WorkItemPanel.panels.get(id);
    if (existing) {
      existing.panel.reveal();
      void existing.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.workItem', `#${id}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    WorkItemPanel.panels.set(id, new WorkItemPanel(panel, client, extensionUri, id, onChange));
    panel.onDidDispose(() => WorkItemPanel.panels.delete(id));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AdoClient,
    private readonly extensionUri: vscode.Uri,
    private readonly id: number,
    private readonly onChange: () => void,
  ) {
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Loading', '<div class="loading"><div class="spinner"></div></div>', '');
    void this.render();
  }

  private async handle(m: any): Promise<void> {
    switch (m.type) {
      case 'state':
        await this.client.updateWorkItem(this.id, { 'System.State': m.value });
        break;
      case 'assignMe': {
        const me = await this.client.getMe();
        await this.client.updateWorkItem(this.id, { 'System.AssignedTo': me.uniqueName ?? me.displayName });
        break;
      }
      case 'title':
        await this.client.updateWorkItem(this.id, { 'System.Title': m.value });
        break;
      case 'comment':
        await this.client.addWorkItemComment(this.id, m.text);
        break;
      case 'browser':
        await vscode.env.openExternal(vscode.Uri.parse(this.client.webUrl('workItem', this.id)));
        return;
      case 'branch':
        await vscode.commands.executeCommand('azureDevOps.wi.createBranch', this.id);
        return;
      case 'openPr':
        await vscode.commands.executeCommand('azureDevOps.pr.openOverview', m.repoId, m.prId);
        return;
      case 'linkSearch':
        await this.searchPullRequests(String(m.text ?? ''), m.seq);
        return;
      case 'link':
        await this.client.linkPullRequest(this.id, JSON.parse(m.key) as PrArtifact);
        break;
      case 'unlink':
        await this.client.unlinkPullRequest(this.id, JSON.parse(m.key) as PrArtifact);
        break;
      case 'refresh':
        this.activePrs = undefined;
        break;
      default:
        return;
    }
    await this.render();
    this.onChange();
  }

  /** Active PRs of the project matching the text (ID or title), minus the ones already linked. */
  private async searchPullRequests(text: string, seq: number): Promise<void> {
    try {
      this.activePrs ??= this.client.listPullRequests({});
      this.activePrs.catch(() => this.activePrs = undefined);
      const q = text.trim().replace(/^!/, '').toLowerCase();
      const linked = new Set(this.linkedPrs.map(l => l.artifact.prId));
      const items = (await this.activePrs)
        .filter(pr => !linked.has(pr.pullRequestId) && (!q || String(pr.pullRequestId) === q || pr.title.toLowerCase().includes(q)))
        .slice(0, 20)
        .map((pr): LinkCandidate => ({
          key: JSON.stringify({ projectId: pr.repository.project?.id, repoId: pr.repository.id, prId: pr.pullRequestId }),
          title: `!${pr.pullRequestId} ${pr.title}`,
          sub: `${pr.repository.name} · ${shortRef(pr.sourceRefName)} → ${shortRef(pr.targetRefName)} · ${pr.createdBy.displayName}`,
        }));
      void this.panel.webview.postMessage({ type: 'linkResults', seq, items });
    } catch (e) {
      void this.panel.webview.postMessage({ type: 'linkResults', seq, error: errorMessage(e) });
    }
  }

  private async render(): Promise<void> {
    try {
      const item = await this.client.getWorkItem(this.id);
      const type = item.fields['System.WorkItemType'];
      const artifacts = (item.relations ?? []).map(r => parsePrArtifact(r.url)).filter((a): a is PrArtifact => !!a);
      const [states, comments, linkedPrs] = await Promise.all([
        this.client.getWorkItemStates(type).catch(() => [] as WorkItemState[]),
        this.client.getWorkItemComments(this.id).catch(() => [] as WorkItemComment[]),
        Promise.all(artifacts.map(async (artifact): Promise<LinkedPr> =>
          ({ artifact, pr: await this.client.getPullRequestById(artifact.prId).catch(() => undefined) }))),
      ]);
      this.linkedPrs = linkedPrs;
      this.item = item;
      this.panel.title = `#${item.id} ${item.fields['System.Title']}`;
      this.panel.webview.html = panelHtml(this.panel.webview, this.extensionUri, this.panel.title,
        this.bodyHtml(item, states, comments, linkedPrs), SCRIPT);
    } catch (e) {
      await showError(e);
    }
  }

  private prsHtml(linked: LinkedPr[]): string {
    const statusPill = (pr: PullRequest) => pr.status === 'completed' ? '<span class="pill ok">Completed</span>'
      : pr.status === 'abandoned' ? '<span class="pill muted">Abandoned</span>'
        : pr.isDraft ? '<span class="pill muted">Draft</span>' : '<span class="pill info">Active</span>';
    const rows = linked.map(({ artifact, pr }) => `<div class="linked">
      ${pr ? `<a class="pr-link" data-pr="${escapeHtml(pr.repository.id)}" data-pr-id="${pr.pullRequestId}" title="${escapeHtml(`!${pr.pullRequestId} ${pr.title}\n${pr.repository.name}: ${shortRef(pr.sourceRefName)} → ${shortRef(pr.targetRefName)}`)}">
          <span class="pr-title"><span class="pr-id">!${pr.pullRequestId}</span>${escapeHtml(pr.title)}</span>
          <span class="pr-meta">${statusPill(pr)}<span class="pr-repo">${escapeHtml(pr.repository.name)}</span></span>
          <span class="pr-branch">${escapeHtml(shortRef(pr.sourceRefName))}</span></a>`
        : `<span class="muted">!${artifact.prId} (not accessible)</span>`}
      <button class="unlink" data-unlink="${escapeHtml(JSON.stringify(artifact))}" title="Remove link">✕</button></div>`).join('');
    return `<div class="card"><h2>Pull requests <span class="count">${linked.length}</span></h2>
      ${rows || '<p class="muted">None linked.</p>'}${linkPickerHtml('Link pull request… (ID or title)')}</div>`;
  }

  private bodyHtml(w: WorkItem, states: WorkItemState[], comments: WorkItemComment[], linkedPrs: LinkedPr[]): string {
    const f = w.fields;
    const assigned = f['System.AssignedTo']?.displayName;
    const state = f['System.State'];
    const stateColor = states.find(s => s.name === state)?.color ?? '888888';
    const field = (label: string, value: unknown) => value === undefined || value === null || value === ''
      ? '' : `<div class="field"><span class="muted">${label}</span><span>${escapeHtml(value)}</span></div>`;
    const tags = String(f['System.Tags'] ?? '').split(';').map(t => t.trim()).filter(Boolean)
      .map(t => `<span class="pill muted">${escapeHtml(t)}</span>`).join(' ');
    const html = (key: string, title: string) => f[key] ? `<div class="card"><h2>${title}</h2><div class="md html">${f[key]}</div></div>` : '';
    const commentHtml = comments.map(c => `<div class="comment">${avatarHtml(c.createdBy.displayName, 26)}
      <div class="comment-body"><div class="comment-head"><strong>${escapeHtml(c.createdBy.displayName)}</strong>
      <span class="muted">${timeAgo(c.createdDate)}</span></div><div class="md html">${c.text}</div></div></div>`).join('');
    return `
<header class="hero" style="--accent:#${escapeHtml(stateColor)}">
  <div class="hero-top"><span class="pill info">${escapeHtml(f['System.WorkItemType'])}</span><span class="muted">#${w.id} · rev ${w.rev}</span></div>
  <h1 contenteditable="true" id="title" spellcheck="false">${escapeHtml(f['System.Title'])}</h1>
  <div class="hero-meta">
    <label class="state-select"><span class="dot" style="background:#${escapeHtml(stateColor)}"></span>
      <select id="state">${states.map(s => `<option ${s.name === state ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('') || `<option>${escapeHtml(state)}</option>`}</select></label>
    ${assigned ? `${avatarHtml(assigned, 22)} <span>${escapeHtml(assigned)}</span>` : '<span class="muted">Unassigned</span>'}
    <span class="muted">updated ${timeAgo(f['System.ChangedDate'])}</span>
  </div>
  <div class="toolbar">
    <button class="btn primary" data-action="assignMe">Assign to me</button>
    <button class="btn ghost" data-action="branch">Create branch</button>
    <span class="spacer"></span>
    <button class="btn ghost" data-action="browser">Open in browser</button>
    <button class="btn ghost" data-action="refresh">Refresh</button>
  </div>
</header>
<main class="grid">
  <section>
    ${html('System.Description', 'Description')}
    ${html('Microsoft.VSTS.TCM.ReproSteps', 'Repro steps')}
    ${html('Microsoft.VSTS.Common.AcceptanceCriteria', 'Acceptance criteria')}
    <div class="card"><h2>Discussion <span class="count">${comments.length}</span></h2>
      <form id="new-comment"><textarea name="text" rows="3" placeholder="Add a comment…"></textarea>
      <div class="right"><button class="btn primary">Comment</button></div></form>
      ${commentHtml || '<p class="muted">No comments yet.</p>'}
    </div>
  </section>
  <aside>
    <div class="card"><h2>Details</h2>
      ${field('Area', f['System.AreaPath'])}${field('Iteration', f['System.IterationPath'])}
      ${field('Priority', f['Microsoft.VSTS.Common.Priority'])}${field('Story points', f['Microsoft.VSTS.Scheduling.StoryPoints'])}
      ${field('Remaining work', f['Microsoft.VSTS.Scheduling.RemainingWork'])}${field('Created by', f['System.CreatedBy']?.displayName)}
      ${field('Created', f['System.CreatedDate'] ? new Date(f['System.CreatedDate']).toLocaleString() : '')}
      ${tags ? `<div class="tags">${tags}</div>` : ''}
    </div>
    ${this.prsHtml(linkedPrs)}
  </aside>
</main>`;
  }
}

const SCRIPT = LINK_PICKER_SCRIPT + `
document.addEventListener('click', e => {
  if (e.target.closest('.md')) return; // work item HTML is shown as-is; ignore look-alike controls inside it
  const pr = e.target.closest('[data-pr]');
  if (pr) { vscode.postMessage({ type: 'openPr', repoId: pr.dataset.pr, prId: Number(pr.dataset.prId) }); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  vscode.postMessage({ type: el.dataset.action });
  el.classList.add('busy');
});
document.getElementById('state').addEventListener('change', e => vscode.postMessage({ type: 'state', value: e.target.value }));
const title = document.getElementById('title');
const original = title.textContent;
title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { title.textContent = original; title.blur(); } });
title.addEventListener('blur', () => { const v = title.textContent.trim(); if (v && v !== original) vscode.postMessage({ type: 'title', value: v }); });
document.getElementById('new-comment').addEventListener('submit', e => {
  e.preventDefault();
  const text = e.target.elements.text.value.trim();
  if (text) { vscode.postMessage({ type: 'comment', text }); e.target.querySelector('button').classList.add('busy'); }
});
`;

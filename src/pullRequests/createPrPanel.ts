import * as vscode from 'vscode';
import { AdoClient, refName } from '../client';
import { ConnectionManager } from '../connection';
import { currentBranch, describeCommits, LocalRepo, localAdoRepos, pickLocalRepo, workItemIdsFromBranch, workItemIdsFromText } from '../git';
import { GitRepository } from '../types';
import { errorMessage, guarded, LINK_PICKER_SCRIPT, LinkCandidate, linkPickerHtml, panelHtml, shortRef } from '../util';

interface CreateRequest {
  repoId: string;
  source: string;
  target: string;
  title: string;
  description: string;
  isDraft: boolean;
  autoComplete: boolean;
  mergeStrategy: string;
  deleteSourceBranch: boolean;
  reviewers: { id: string; isRequired: boolean }[];
  workItems: number[];
}

/** The form as the page sent it, with every field converted (the page is not trusted). */
export function toCreateRequest(raw: any): CreateRequest {
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  return {
    repoId: String(r.repoId ?? ''), source: String(r.source ?? ''), target: String(r.target ?? ''),
    title: String(r.title ?? ''), description: String(r.description ?? ''),
    isDraft: !!r.isDraft, autoComplete: !!r.autoComplete, mergeStrategy: String(r.mergeStrategy ?? ''), deleteSourceBranch: !!r.deleteSourceBranch,
    reviewers: list(r.reviewers).map(x => ({ id: String(x?.id ?? ''), isRequired: !!x?.isRequired })),
    workItems: list(r.workItems).map(Number).filter(Number.isInteger),
  };
}

/** A picked link candidate sent back by the page: only id, title and sub, as text. */
export function parseLinkKey(key: unknown): { id: string; title: string; sub: string } | undefined {
  try {
    const v = JSON.parse(String(key));
    return v && typeof v === 'object' ? { id: String(v.id ?? ''), title: String(v.title ?? ''), sub: String(v.sub ?? '') } : undefined;
  } catch {
    return undefined;
  }
}

/** Form to open a pull request, prefilled from the local branch and its commits. */
export class CreatePullRequestPanel {
  private static current?: CreatePullRequestPanel;
  private repos: GitRepository[] = [];
  private local?: LocalRepo;
  private suggestSeq = 0;

  static async show(client: AdoClient, connections: ConnectionManager, extensionUri: vscode.Uri, opts: { repoName?: string; source?: string } = {},
    onCreated: () => void = () => undefined): Promise<void> {
    if (CreatePullRequestPanel.current) {
      CreatePullRequestPanel.current.panel.reveal();
      return;
    }
    // Without explicit arguments, start from the local repository and its checked-out branch.
    const local = opts.repoName ? localAdoRepos(connections.current).find(r => r.repoName.toLowerCase() === opts.repoName!.toLowerCase())
      : await pickLocalRepo(connections.current, 'Create pull request');
    const panel = vscode.window.createWebviewPanel('azureDevOps.createPr', 'New pull request', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    // The local clone may belong to another selected project than the primary one.
    const instance = new CreatePullRequestPanel(panel, client.forProject(local?.project), local, opts, onCreated);
    CreatePullRequestPanel.current = instance;
    panel.onDidDispose(() => CreatePullRequestPanel.current = undefined);
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'New pull request', BODY, LINK_PICKER_SCRIPT + SCRIPT);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AdoClient,
    local: LocalRepo | undefined,
    private readonly opts: { repoName?: string; source?: string },
    private readonly onCreated: () => void,
  ) {
    this.local = local;
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private async handle(m: any): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.init();
        return;
      case 'repo':
        await this.selectRepo(String(m.repoId));
        return;
      case 'suggest':
        await this.suggest(String(m.repoId), String(m.source), String(m.target));
        return;
      case 'linkSearch':
        await this.search(m.picker, String(m.text ?? ''), m.seq);
        return;
      case 'link': {
        const item = parseLinkKey(m.key);
        if (item?.id) {
          this.post({ type: 'add', picker: String(m.picker), item });
        }
        return;
      }
      case 'create':
        await this.create(toCreateRequest(m.request), !!m.push);
        return;
      case 'openPr':
        await vscode.commands.executeCommand('azureDevOps.pr.openOverview', String(m.repoId), Number(m.prId));
        return;
      case 'cancel':
        this.panel.dispose();
        return;
    }
  }

  private async init(): Promise<void> {
    try {
      this.repos = await this.client.listRepositories();
      const wanted = this.opts.repoName ?? this.local?.repoName;
      const repo = this.repos.find(r => r.name.toLowerCase() === wanted?.toLowerCase()) ?? this.repos[0];
      this.post({ type: 'repos', repos: this.repos.map(r => ({ id: r.id, name: r.name })), selected: repo?.id });
      if (repo) {
        await this.selectRepo(repo.id);
      }
    } catch (e) {
      this.post({ type: 'fatal', message: errorMessage(e) });
    }
  }

  private async selectRepo(repoId: string): Promise<void> {
    const repo = this.repos.find(r => r.id === repoId);
    if (!repo) {
      return;
    }
    if (this.local && this.local.repoName.toLowerCase() !== repo.name.toLowerCase()) {
      this.local = undefined;
    }
    const branches = await this.client.listBranches(repo.id).catch(() => [] as string[]);
    const source = this.opts.source ?? currentBranch(this.local?.repo) ?? '';
    const target = shortRef(repo.defaultBranch) || 'main';
    this.post({ type: 'branches', repoId, branches, source: source === target ? '' : source, target });
  }

  /** Title, description, commits and work items for the branch pair. */
  private async suggest(repoId: string, source: string, target: string): Promise<void> {
    const seq = ++this.suggestSeq;
    if (!source || !target || source === target) {
      this.post({ type: 'suggestion', seq, commits: [], pushed: true });
      return;
    }
    const pushed = await this.client.listBranches(repoId).then(b => b.includes(source), () => true);
    let messages: string[] = [];
    const repo = this.local?.repo;
    if (repo && currentBranch(repo) === source) {
      // Local commits not yet on the target: works before the branch is pushed, too.
      const remote = this.local!.remoteName;
      await repo.fetch?.(remote, target).catch(() => undefined);
      const commits: { message: string }[] = await repo.log({ range: `${remote}/${target}..${source}`, maxEntries: 100 }).catch(() => []);
      messages = commits.map(c => c.message);
    }
    const { title, description } = describeCommits(source, messages);
    const ids = [...new Set([...workItemIdsFromBranch(source), ...messages.flatMap(workItemIdsFromText)])];
    const items = ids.length ? await this.client.getWorkItems(ids.slice(0, 20)).catch(() => []) : [];
    const existing = await this.client.findPullRequestsForBranch(repoId, source).catch(() => []);
    if (seq !== this.suggestSeq) {
      return;
    }
    this.post({
      type: 'suggestion', seq, title, description, pushed,
      commits: messages.map(msg => msg.split('\n')[0]),
      workItems: items.map(w => ({ id: w.id, title: `#${w.id} ${w.fields['System.Title']}`, sub: `${w.fields['System.WorkItemType']} · ${w.fields['System.State']}` })),
      existing: existing.filter(pr => shortRef(pr.targetRefName) === target).map(pr => ({ id: pr.pullRequestId, title: pr.title, repoId: pr.repository.id })),
    });
  }

  private async search(picker: string, text: string, seq: number): Promise<void> {
    try {
      let items: LinkCandidate[];
      if (picker === 'reviewer') {
        const people = text.trim().length >= 2 ? await this.client.searchIdentities(text.trim()) : [];
        items = people.map(p => ({
          key: JSON.stringify({ id: p.id, title: p.displayName, sub: p.uniqueName ?? (p.isGroup ? 'Group' : '') }),
          title: p.displayName, sub: p.isGroup ? 'Group' : p.uniqueName,
        }));
      } else {
        items = (await this.client.searchWorkItems(text)).map(w => {
          const title = `#${w.id} ${w.fields['System.Title']}`;
          const sub = `${w.fields['System.WorkItemType']} · ${w.fields['System.State']}`;
          return { key: JSON.stringify({ id: w.id, title, sub }), title, sub };
        });
      }
      this.post({ type: 'linkResults', picker, seq, items });
    } catch (e) {
      this.post({ type: 'linkResults', picker, seq, error: errorMessage(e) });
    }
  }

  private async create(r: CreateRequest, push: boolean): Promise<void> {
    try {
      if (push) {
        await this.push(r.source);
      }
      const pr = await this.client.createPullRequest(r.repoId, {
        sourceRefName: refName(r.source), targetRefName: refName(r.target), title: r.title, description: r.description || undefined,
        isDraft: r.isDraft, reviewers: r.reviewers, workItemRefs: r.workItems.map(id => ({ id: String(id) })),
      });
      if (r.autoComplete && !r.isDraft) {
        await this.client.setAutoComplete(r.repoId, pr.pullRequestId, {
          mergeStrategy: r.mergeStrategy || 'squash', deleteSourceBranch: r.deleteSourceBranch, transitionWorkItems: true,
        }).catch(e => vscode.window.showWarningMessage(`PR !${pr.pullRequestId} was created, but auto-complete could not be set: ${errorMessage(e)}`));
      }
      this.onCreated();
      this.panel.dispose();
      void vscode.window.showInformationMessage(`Created pull request !${pr.pullRequestId}.`);
      await vscode.commands.executeCommand('azureDevOps.pr.openOverview', pr.repository.id, pr.pullRequestId);
    } catch (e) {
      this.post({ type: 'createError', message: errorMessage(e) });
    }
  }

  private async push(branch: string): Promise<void> {
    const local = this.local;
    if (local?.repo && currentBranch(local.repo) === branch) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing ${branch}…` },
        () => local.repo.push(local.remoteName, branch, true));
      return;
    }
    throw new Error(`The branch ${branch} does not exist on the server yet. Push it first.`);
  }
}

const BODY = `
<form class="run cpr" id="form" autocomplete="off" novalidate>
  <header class="run-head">
    <div class="run-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/></svg></div>
    <div class="run-head-text"><h1>New pull request</h1><p class="muted" id="subtitle">Loading repositories…</p></div>
  </header>
  <div id="fatal" class="run-alert" hidden></div>
  <section class="run-section">
    <h2>Branches</h2>
    <label class="run-field"><span class="run-label">Repository</span><select id="repo"></select></label>
    <div class="wt-row">
      <label class="run-field"><span class="run-label">Source branch <span class="req">*</span></span><input id="source" list="branchList" spellcheck="false" placeholder="feature/…"></label>
      <label class="run-field"><span class="run-label">Target branch <span class="req">*</span></span><input id="target" list="branchList" spellcheck="false"></label>
    </div>
    <datalist id="branchList"></datalist>
    <div id="branchNote" class="run-note" hidden></div>
    <div id="existing" class="run-note" hidden></div>
  </section>
  <section class="run-section">
    <h2>Details</h2>
    <label class="run-field"><span class="run-label">Title <span class="req">*</span></span><input id="title" required></label>
    <label class="run-field"><span class="run-label">Description <span class="muted">(Markdown)</span></span><textarea id="description" rows="8"></textarea></label>
    <div id="commits" class="cpr-commits" hidden></div>
  </section>
  <section class="run-section">
    <h2>Reviewers</h2>
    <div id="reviewerChips" class="chip-list"></div>
    ${linkPickerHtml('Add reviewer… (name or e-mail)', 'reviewer')}
  </section>
  <section class="run-section">
    <h2>Work items</h2>
    <div id="wiChips" class="chip-list"></div>
    ${linkPickerHtml('Link work item… (ID or title)', 'link')}
  </section>
  <section class="run-section">
    <h2>Options</h2>
    <label class="run-toggle"><input type="checkbox" id="draft"><span class="switch"></span><span>Create as draft</span></label>
    <label class="run-toggle"><input type="checkbox" id="autoComplete"><span class="switch"></span><span>Set auto-complete <span class="hint">merge once all required policies pass</span></span></label>
    <div id="deleteBox">
      <label class="run-field"><span class="run-label">Merge strategy</span><select id="mergeStrategy">
        <option value="squash">Squash commit</option><option value="noFastForward">Merge (no fast-forward)</option>
        <option value="rebase">Rebase and fast-forward</option><option value="rebaseMerge">Semi-linear merge</option></select></label>
      <label class="run-toggle"><input type="checkbox" id="deleteSource" checked><span class="switch"></span><span>Delete source branch after merging</span></label>
    </div>
  </section>
  <div id="formError" class="run-alert" hidden></div>
  <footer class="run-foot">
    <span class="spacer"></span>
    <button type="button" class="btn ghost" id="cancel">Cancel</button>
    <button type="submit" class="btn primary" id="create">Create</button>
  </footer>
</form>`;

const SCRIPT = `
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reviewers = new Map(), workItems = new Map();
let pushed = true, suggestTimer = 0, touched = { title: false, description: false };

function chips() {
  $('reviewerChips').innerHTML = [...reviewers.values()].map(r =>
    '<span class="pchip"><span>' + esc(r.title) + '</span>' +
    '<label class="pchip-req" title="Required reviewer"><input type="checkbox" data-req="' + esc(r.id) + '"' + (r.isRequired ? ' checked' : '') + '>required</label>' +
    '<button type="button" class="pchip-x" data-remove-reviewer="' + esc(r.id) + '" title="Remove">✕</button></span>').join('');
  $('wiChips').innerHTML = [...workItems.values()].map(w =>
    '<span class="pchip" title="' + esc(w.sub || '') + '"><span>' + esc(w.title) + '</span>' +
    '<button type="button" class="pchip-x" data-remove-wi="' + esc(w.id) + '" title="Remove">✕</button></span>').join('');
}

function suggest() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => vscode.postMessage({ type: 'suggest', repoId: $('repo').value, source: $('source').value.trim(), target: $('target').value.trim() }), 300);
}

function resetPicker(picker) {
  const box = document.querySelector('.linker[data-picker="' + picker + '"]');
  const input = box.querySelector('input');
  input.disabled = false; input.value = '';
  box.querySelector('.linker-results').hidden = true;
}

$('repo').addEventListener('change', () => vscode.postMessage({ type: 'repo', repoId: $('repo').value }));
$('source').addEventListener('input', suggest);
$('target').addEventListener('input', suggest);
$('title').addEventListener('input', () => touched.title = true);
$('description').addEventListener('input', () => touched.description = true);
$('autoComplete').addEventListener('change', () => $('deleteBox').hidden = !$('autoComplete').checked);
$('deleteBox').hidden = true;
$('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
document.addEventListener('click', e => {
  const r = e.target.closest('[data-remove-reviewer]');
  if (r) { reviewers.delete(r.dataset.removeReviewer); chips(); return; }
  const w = e.target.closest('[data-remove-wi]');
  if (w) { workItems.delete(w.dataset.removeWi); chips(); return; }
  const o = e.target.closest('[data-open-pr]');
  if (o) { e.preventDefault(); vscode.postMessage({ type: 'openPr', repoId: o.dataset.openPr, prId: Number(o.dataset.id) }); }
});
document.addEventListener('change', e => {
  const req = e.target.closest('[data-req]');
  if (req && reviewers.has(req.dataset.req)) reviewers.get(req.dataset.req).isRequired = req.checked;
});
$('form').addEventListener('submit', e => {
  e.preventDefault();
  const request = {
    repoId: $('repo').value, source: $('source').value.trim(), target: $('target').value.trim(),
    title: $('title').value.trim(), description: $('description').value, isDraft: $('draft').checked,
    autoComplete: $('autoComplete').checked, mergeStrategy: $('mergeStrategy').value, deleteSourceBranch: $('deleteSource').checked,
    reviewers: [...reviewers.values()].map(r => ({ id: r.id, isRequired: !!r.isRequired })),
    workItems: [...workItems.keys()].map(Number),
  };
  const error = !request.source || !request.target ? 'Choose a source and a target branch.'
    : request.source === request.target ? 'Source and target branch must differ.'
    : !request.title ? 'Enter a title.' : '';
  if (error) { $('formError').textContent = error; $('formError').hidden = false; return; }
  $('formError').hidden = true;
  $('create').classList.add('busy');
  $('create').disabled = true;
  vscode.postMessage({ type: 'create', request, push: !pushed });
});

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'repos') {
    $('repo').innerHTML = m.repos.map(r => '<option value="' + esc(r.id) + '"' + (r.id === m.selected ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('');
    $('subtitle').textContent = 'Propose merging a branch.';
  } else if (m.type === 'branches') {
    $('branchList').innerHTML = m.branches.map(b => '<option value="' + esc(b) + '"></option>').join('');
    if (m.source) $('source').value = m.source;
    $('target').value = m.target;
    suggest();
  } else if (m.type === 'suggestion') {
    pushed = m.pushed;
    $('branchNote').hidden = pushed;
    $('branchNote').textContent = 'This branch is not on the server yet. It will be pushed when you create the pull request.';
    $('create').textContent = pushed ? 'Create' : 'Push and create';
    if (!touched.title && m.title) $('title').value = m.title;
    if (!touched.description && m.description !== undefined) $('description').value = m.description;
    $('commits').hidden = !m.commits.length;
    $('commits').innerHTML = '<div class="run-label">' + m.commits.length + ' commit' + (m.commits.length === 1 ? '' : 's') + '</div><ul>' +
      m.commits.slice(0, 20).map(c => '<li>' + esc(c) + '</li>').join('') + (m.commits.length > 20 ? '<li class="muted">…</li>' : '') + '</ul>';
    for (const w of m.workItems || []) if (!workItems.has(String(w.id))) workItems.set(String(w.id), w);
    const ex = (m.existing || [])[0];
    $('existing').hidden = !ex;
    if (ex) $('existing').innerHTML = 'An active pull request already exists for these branches: <a href="#" data-open-pr="' + esc(ex.repoId) + '" data-id="' + ex.id + '">!' + ex.id + ' ' + esc(ex.title) + '</a>';
    chips();
  } else if (m.type === 'add') {
    const item = m.item;
    if (m.picker === 'reviewer') reviewers.set(item.id, { ...item, isRequired: false });
    else workItems.set(String(item.id), item);
    resetPicker(m.picker);
    chips();
  } else if (m.type === 'createError') {
    $('create').classList.remove('busy');
    $('create').disabled = false;
    $('formError').textContent = m.message;
    $('formError').hidden = false;
  } else if (m.type === 'fatal') {
    $('fatal').textContent = m.message;
    $('fatal').hidden = false;
  }
});
vscode.postMessage({ type: 'ready' });
`;

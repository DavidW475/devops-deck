import * as vscode from 'vscode';
import { AdoClient, PrArtifact, parsePrArtifact } from '../client';
import { PullRequest, WorkItem, WorkItemComment, WorkItemState, WorkItemTypeField, WorkItemUpdate } from '../types';
import {
  asText, avatarHtml, errorMessage, escapeHtml, guarded, LINK_PICKER_SCRIPT, LinkCandidate, linkPickerHtml, LivePanel, panelHtml, sanitizeHtml, shortRef, showError, timeAgo, viewButtonsHtml,
} from '../util';
import { EditableField, editableFields, hierarchyOf, HistoryEntry, historyEntries, joinTags, PARENT_REL, splitTags } from './wiModel';

interface LinkedPr {
  artifact: PrArtifact;
  pr?: PullRequest;
}

interface Related {
  parent?: WorkItem;
  children: WorkItem[];
  related: WorkItem[];
}

/** Lists that rarely change, shared by all work item panels until the next refresh. */
const cache = new Map<string, Promise<unknown>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Detail view of a single work item: fields, hierarchy, linked pull requests, discussion and history. */
export class WorkItemPanel {
  private static readonly panels = new Map<number, WorkItemPanel>();
  private linkedPrs: LinkedPr[] = [];
  private activePrs?: Promise<PullRequest[]>;
  private item?: WorkItem;
  /** client for the work item's own project (types, states, comments, classification nodes) */
  private scoped?: AdoClient;
  private readonly page: LivePanel;

  static show(client: AdoClient, extensionUri: vscode.Uri, id: number, onChange: () => void): void {
    const existing = WorkItemPanel.panels.get(id);
    if (existing) {
      existing.panel.reveal();
      void existing.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.workItem', `#${id}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const instance = new WorkItemPanel(panel, client, extensionUri, id, onChange);
    WorkItemPanel.panels.set(id, instance);
    void instance.render();
    panel.onDidDispose(() => WorkItemPanel.panels.delete(id));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AdoClient,
    extensionUri: vscode.Uri,
    private readonly id: number,
    private readonly onChange: () => void,
  ) {
    this.page = new LivePanel(panel, extensionUri, LINK_PICKER_SCRIPT + SCRIPT);
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Loading', '<div class="loading"><div class="spinner"></div></div>', '');
  }

  private get api(): AdoClient {
    return this.scoped ?? this.client;
  }

  private key(what: string): string {
    const c = this.api.connection;
    return `${c.orgUrl}/${c.project}/${what}`;
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

  /** Runs a page action; true when the work item may have changed (re-render), false for unknown messages. */
  private async act(m: any): Promise<boolean> {
    switch (m.type) {
      case 'state':
        await this.api.updateWorkItem(this.id, { 'System.State': m.value });
        break;
      case 'assignMe': {
        const me = await this.api.getMe();
        await this.api.updateWorkItem(this.id, { 'System.AssignedTo': me.uniqueName ?? me.displayName });
        break;
      }
      case 'unassign':
        await this.api.updateWorkItem(this.id, { 'System.AssignedTo': '' });
        break;
      case 'title':
        await this.api.updateWorkItem(this.id, { 'System.Title': m.value });
        break;
      case 'field':
        await this.api.updateWorkItem(this.id, { [String(m.name)]: fieldValue(m.value, m.kind) });
        break;
      case 'tags':
        await this.api.updateWorkItem(this.id, { 'System.Tags': joinTags(String(m.value ?? '').split(/[;,]/)) || null });
        break;
      case 'addChild':
        await this.addChild(String(m.childType), String(m.title ?? '').trim());
        break;
      case 'removeParent':
        await this.removeRelation(Number(m.id));
        break;
      case 'comment':
        await this.api.addWorkItemComment(this.id, m.text);
        break;
      case 'link':
        await this.link(m);
        break;
      case 'unlink':
        await this.api.unlinkPullRequest(this.id, JSON.parse(m.key) as PrArtifact);
        break;
      case 'refresh':
        this.activePrs = undefined;
        cache.clear();
        break;
      default:
        return false;
    }
    return true;
  }

  /** Messages that only navigate or search; true when handled. */
  private async handleView(m: any): Promise<boolean> {
    switch (m.type) {
      case 'browser':
        await vscode.env.openExternal(vscode.Uri.parse(this.api.webUrl('workItem', this.id)));
        return true;
      case 'branch':
        await vscode.commands.executeCommand('azureDevOps.wi.createBranch', this.id);
        return true;
      case 'openPr':
        await vscode.commands.executeCommand('azureDevOps.pr.openOverview', m.repoId, m.prId);
        return true;
      case 'openWi':
        await vscode.commands.executeCommand('azureDevOps.wi.open', Number(m.id));
        return true;
      case 'linkSearch':
        if (m.picker === 'assignee') {
          await this.searchPeople(String(m.text ?? ''), m.seq);
        } else {
          await this.searchPullRequests(String(m.text ?? ''), m.seq);
        }
        return true;
      default:
        return false;
    }
  }

  private async link(m: { key: string; picker?: string }): Promise<void> {
    if (m.picker === 'assignee') {
      await this.api.updateWorkItem(this.id, { 'System.AssignedTo': m.key });
      return;
    }
    await this.api.linkPullRequest(this.id, JSON.parse(m.key) as PrArtifact);
  }

  private async addChild(type: string, title: string): Promise<void> {
    if (!title) {
      return;
    }
    const f = this.item?.fields ?? {};
    const child = await this.api.createWorkItem(type, {
      'System.Title': title, 'System.AreaPath': f['System.AreaPath'], 'System.IterationPath': f['System.IterationPath'],
    }, { parentId: this.id });
    vscode.window.setStatusBarMessage(`$(check) Created ${type} #${child.id}`, 3000);
  }

  /** Removes the link to another work item (e.g. the parent). */
  private async removeRelation(otherId: number): Promise<void> {
    const w = await this.api.getWorkItem(this.id);
    const index = (w.relations ?? []).findIndex(r => r.rel === PARENT_REL && r.url.toLowerCase().endsWith(`/workitems/${otherId}`));
    if (index >= 0) {
      await this.api.removeWorkItemRelation(this.id, w.rev, index);
    }
  }

  private async searchPeople(text: string, seq: number): Promise<void> {
    try {
      const people = text.trim().length >= 2 ? await this.api.searchIdentities(text.trim()) : [];
      const items = people.filter(p => !p.isGroup && p.uniqueName)
        .map((p): LinkCandidate => ({ key: `${p.displayName} <${p.uniqueName}>`, title: p.displayName, sub: p.uniqueName }));
      this.page.post({ type: 'linkResults', picker: 'assignee', seq, items });
    } catch (e) {
      this.page.post({ type: 'linkResults', picker: 'assignee', seq, error: errorMessage(e) });
    }
  }

  /** Active PRs of the project matching the text (ID or title), minus the ones already linked. */
  private async searchPullRequests(text: string, seq: number): Promise<void> {
    try {
      this.activePrs ??= this.api.listPullRequests({});
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
      this.page.post({ type: 'linkResults', seq, items });
    } catch (e) {
      this.page.post({ type: 'linkResults', seq, error: errorMessage(e) });
    }
  }

  private async render(): Promise<void> {
    try {
      const item = await this.client.getWorkItem(this.id);
      this.item = item;
      this.scoped = this.client.forProject(item.fields['System.TeamProject']);
      const type = item.fields['System.WorkItemType'];
      const artifacts = (item.relations ?? []).map(r => parsePrArtifact(r.url)).filter((a): a is PrArtifact => !!a);
      const h = hierarchyOf(item);
      const c = this.api;
      const [states, comments, linkedPrs, typeFields, updates, related, types, iterations, areas] = await Promise.all([
        c.getWorkItemStates(type).catch(() => [] as WorkItemState[]),
        c.getWorkItemComments(this.id).catch(() => [] as WorkItemComment[]),
        Promise.all(artifacts.map(async (artifact): Promise<LinkedPr> =>
          ({ artifact, pr: await c.getPullRequestById(artifact.prId).catch(() => undefined) }))),
        cached(this.key(`fields:${type}`), () => c.getWorkItemTypeFields(type)).catch(() => [] as WorkItemTypeField[]),
        c.getWorkItemUpdates(this.id, item.rev, 100).catch(() => [] as WorkItemUpdate[]),
        this.loadRelated(h),
        cached(this.key('types'), () => c.getWorkItemTypes()).catch(() => [] as string[]),
        cached(this.key('iterations'), () => c.listClassificationPaths('Iterations')).catch(() => [] as string[]),
        cached(this.key('areas'), () => c.listClassificationPaths('Areas')).catch(() => [] as string[]),
      ]);
      this.linkedPrs = linkedPrs;
      this.panel.title = `#${item.id} ${item.fields['System.Title']}`;
      const view: View = { w: item, states, comments, linkedPrs, fields: editableFields(typeFields), history: historyEntries(updates), related, types, iterations, areas };
      this.page.show(this.panel.title, bodyHtml(view));
    } catch (e) {
      this.page.idle();
      await showError(e);
    }
  }

  private async loadRelated(h: { parent?: number; children: number[]; related: number[] }): Promise<Related> {
    const ids = [...new Set([...(h.parent ? [h.parent] : []), ...h.children, ...h.related])];
    const items = ids.length ? await this.api.getWorkItems(ids).catch(() => [] as WorkItem[]) : [];
    const byId = new Map(items.map(w => [w.id, w]));
    const pick = (list: number[]) => list.map(id => byId.get(id)).filter((w): w is WorkItem => !!w);
    return { parent: h.parent ? byId.get(h.parent) : undefined, children: pick(h.children), related: pick(h.related) };
  }
}

function fieldValue(value: unknown, kind: unknown): unknown {
  const s = asText(value).trim();
  if (!s) {
    return null;
  }
  if (kind === 'number') {
    const n = Number(s.replace(',', '.'));
    if (!Number.isFinite(n)) {
      throw new TypeError(`"${s}" is not a number.`);
    }
    return n;
  }
  return /^\d+$/.test(s) && kind === 'int' ? Number(s) : s;
}

interface View {
  w: WorkItem;
  states: WorkItemState[];
  comments: WorkItemComment[];
  linkedPrs: LinkedPr[];
  fields: EditableField[];
  history: HistoryEntry[];
  related: Related;
  types: string[];
  iterations: string[];
  areas: string[];
}

function statusPill(pr: PullRequest): string {
  if (pr.status === 'completed') {
    return '<span class="pill ok">Completed</span>';
  }
  if (pr.status === 'abandoned') {
    return '<span class="pill muted">Abandoned</span>';
  }
  return pr.isDraft ? '<span class="pill muted">Draft</span>' : '<span class="pill info">Active</span>';
}

function prLinkHtml(pr: PullRequest): string {
  const tip = `!${pr.pullRequestId} ${pr.title}\n${pr.repository.name}: ${shortRef(pr.sourceRefName)} → ${shortRef(pr.targetRefName)}`;
  return `<a class="pr-link" data-pr="${escapeHtml(pr.repository.id)}" data-pr-id="${pr.pullRequestId}" title="${escapeHtml(tip)}">
    <span class="pr-title"><span class="pr-id">!${pr.pullRequestId}</span>${escapeHtml(pr.title)}</span>
    <span class="pr-meta">${statusPill(pr)}<span class="pr-repo">${escapeHtml(pr.repository.name)}</span></span>
    <span class="pr-branch">${escapeHtml(shortRef(pr.sourceRefName))}</span></a>`;
}

function prsHtml(linked: LinkedPr[]): string {
  const rows = linked.map(({ artifact, pr }) => `<div class="linked">
    ${pr ? prLinkHtml(pr) : `<span class="muted">!${artifact.prId} (not accessible)</span>`}
    <button class="unlink" data-unlink="${escapeHtml(JSON.stringify(artifact))}" title="Remove link">✕</button></div>`).join('');
  return `<div class="card"><h2>Pull requests <span class="count">${linked.length}</span></h2>
    ${rows || '<p class="muted">None linked.</p>'}${linkPickerHtml('Link pull request… (ID or title)')}</div>`;
}

function wiRow(w: WorkItem, extra = ''): string {
  return `<div class="linked"><a class="wi-link" data-wi="${w.id}"><span class="pill muted">${escapeHtml(w.fields['System.WorkItemType'])}</span>
    #${w.id} ${escapeHtml(w.fields['System.Title'])} <span class="muted small">${escapeHtml(w.fields['System.State'])}</span></a>${extra}</div>`;
}

function hierarchyHtml(v: View): string {
  const { parent, children, related } = v.related;
  const done = children.filter(c => ['Closed', 'Done', 'Completed', 'Resolved', 'Removed'].includes(c.fields['System.State'])).length;
  const childTypes = v.types.length ? v.types : ['Task'];
  const defaultChild = childTypes.includes('Task') ? 'Task' : childTypes[0];
  return `<div class="card"><h2>Hierarchy</h2>
    <div class="sub-h">Parent</div>
    ${parent ? wiRow(parent, `<button class="unlink" data-remove-parent="${parent.id}" title="Remove parent link">✕</button>`) : '<p class="muted small">No parent.</p>'}
    <div class="sub-h">Children ${children.length ? `<span class="count">${done}/${children.length} done</span>` : ''}</div>
    ${children.map(c => wiRow(c)).join('') || '<p class="muted small">No children.</p>'}
    <form id="add-child" class="add-child">
      <select name="childType">${childTypes.map(t => `<option ${t === defaultChild ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
      <input name="title" placeholder="New child title…" autocomplete="off"><button class="btn small">Add</button>
    </form>
    ${related.length ? `<div class="sub-h">Related</div>${related.map(r => wiRow(r)).join('')}` : ''}
  </div>`;
}

/** Iteration and area paths without the project name ("Sprint 42" instead of "Fabrikam Shop\\Sprint 42"). */
function pathLabel(path: string): string {
  const parts = path.split('\\');
  return parts.length > 1 ? parts.slice(1).join(' › ') : path;
}

function select(name: string, current: string, options: string[], kind = 'text'): string {
  const all = options.includes(current) || !current ? options : [current, ...options];
  const empty = current ? '' : '<option value="" selected></option>';
  const label = kind === 'path' ? pathLabel : (o: string) => o;
  const opts = all.map(o => `<option value="${escapeHtml(o)}" title="${escapeHtml(o)}" ${o === current ? 'selected' : ''}>${escapeHtml(label(o))}</option>`).join('');
  return `<select class="field-input" data-field="${escapeHtml(name)}" data-kind="${kind}">${empty}${opts}</select>`;
}

function detailsHtml(v: View): string {
  const f = v.w.fields;
  const assigned = f['System.AssignedTo'];
  const row = (label: string, control: string) => `<div class="field edit"><span class="muted">${label}</span>${control}</div>`;
  const choiceKind = (x: EditableField) => x.ref.endsWith('Priority') ? 'int' : 'text';
  const control = (x: EditableField) => x.kind === 'choice'
    ? select(x.ref, String(f[x.ref] ?? ''), x.options ?? [], choiceKind(x))
    : `<input class="field-input" type="number" step="any" min="0" data-field="${escapeHtml(x.ref)}" data-kind="number" value="${escapeHtml(f[x.ref] ?? '')}">`;
  const planning = v.fields.map(x => row(escapeHtml(x.label), control(x))).join('');
  const assignee = assigned
    ? `${avatarHtml(assigned.displayName, 20)}<span>${escapeHtml(assigned.displayName)}</span><button class="link" data-action="unassign">Unassign</button>`
    : '<span class="muted">Unassigned</span>';
  const created = f['System.CreatedDate']
    ? escapeHtml(new Date(f['System.CreatedDate']).toLocaleDateString(undefined, { dateStyle: 'medium' })) : '';
  return `<div class="card"><h2>Details</h2>
    <div class="field edit"><span class="muted">Assigned to</span>
      <div class="assignee">${assignee}</div></div>
    ${linkPickerHtml('Assign to… (name or e-mail)', 'assignee')}
    ${row('Iteration', select('System.IterationPath', String(f['System.IterationPath'] ?? ''), v.iterations, 'path'))}
    ${row('Area', select('System.AreaPath', String(f['System.AreaPath'] ?? ''), v.areas, 'path'))}
    ${planning}
    ${row('Tags', `<input class="field-input" id="tags" value="${escapeHtml(splitTags(f['System.Tags']).join(', '))}" placeholder="tag1, tag2">`)}
    <div class="field"><span class="muted">Created</span><span>${escapeHtml(f['System.CreatedBy']?.displayName ?? '')} · ${created}</span></div>
  </div>`;
}

function historyHtml(history: HistoryEntry[]): string {
  if (!history.length) {
    return '';
  }
  const change = (c: HistoryEntry['changes'][number]) =>
    `<li><span class="muted">${escapeHtml(c.field)}:</span> <span class="old">${escapeHtml(c.from)}</span> → ${escapeHtml(c.to)}</li>`;
  const link = (l: string) => `<li class="muted">${escapeHtml(l)}</li>`;
  const rows = history.slice(0, 50).map(h => `<div class="hist">
      <div class="hist-head">${avatarHtml(h.by, 20)}<strong>${escapeHtml(h.by)}</strong><span class="muted small">${timeAgo(h.date)} · rev ${h.rev}</span></div>
      <ul>${h.changes.map(change).join('')}${h.links.map(link).join('')}</ul></div>`).join('');
  return `<details class="card" id="history"><summary><h2>History <span class="count">${history.length}</span></h2></summary>${rows}</details>`;
}

function bodyHtml(v: View): string {
  const f = v.w.fields;
  const state = f['System.State'];
  const stateColor = v.states.find(s => s.name === state)?.color ?? '888888';
  // Work item HTML is written by anyone in the project: sanitize before showing it.
  const html = (key: string, title: string) => f[key] ? `<div class="card"><h2>${title}</h2><div class="md html">${sanitizeHtml(String(f[key]))}</div></div>` : '';
  const commentHtml = v.comments.map(c => `<div class="comment">${avatarHtml(c.createdBy.displayName, 26)}
    <div class="comment-body"><div class="comment-head"><strong>${escapeHtml(c.createdBy.displayName)}</strong>
    <span class="muted">${timeAgo(c.createdDate)}</span></div><div class="md html">${sanitizeHtml(c.text)}</div></div></div>`).join('');
  const assigned = f['System.AssignedTo']?.displayName;
  const stateOptions = v.states.map(s => `<option ${s.name === state ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')
    || `<option>${escapeHtml(state)}</option>`;
  const assignedHtml = assigned ? `${avatarHtml(assigned, 22)} <span>${escapeHtml(assigned)}</span>` : '<span class="muted">Unassigned</span>';
  return `
<header class="hero" style="--accent:#${escapeHtml(stateColor)}">
  <div class="hero-top"><span class="pill info">${escapeHtml(f['System.WorkItemType'])}</span><span class="muted">#${v.w.id} · rev ${v.w.rev}</span></div>
  <h1 contenteditable="true" id="title" spellcheck="false" data-original="${escapeHtml(f['System.Title'])}">${escapeHtml(f['System.Title'])}</h1>
  <div class="hero-meta">
    <label class="state-select"><span class="dot" style="background:#${escapeHtml(stateColor)}"></span>
      <select id="state">${stateOptions}</select></label>
    ${assignedHtml}
    <span class="muted">updated ${timeAgo(f['System.ChangedDate'])}</span>
  </div>
  <div class="toolbar">
    <button class="btn primary" data-action="assignMe">Assign to me</button>
    <button class="btn ghost" data-action="branch">Create branch</button>
    <span class="spacer"></span>
    ${viewButtonsHtml()}
  </div>
</header>
<main class="grid">
  <section>
    ${html('System.Description', 'Description')}
    ${html('Microsoft.VSTS.TCM.ReproSteps', 'Repro steps')}
    ${html('Microsoft.VSTS.Common.AcceptanceCriteria', 'Acceptance criteria')}
    <div class="card"><h2>Discussion <span class="count">${v.comments.length}</span></h2>
      <form id="new-comment"><textarea name="text" rows="3" placeholder="Add a comment…"></textarea>
      <div class="right"><button class="btn primary">Comment</button></div></form>
      ${commentHtml || '<p class="muted">No comments yet.</p>'}
    </div>
    ${historyHtml(v.history)}
  </section>
  <aside>
    ${detailsHtml(v)}
    ${hierarchyHtml(v)}
    ${prsHtml(v.linkedPrs)}
  </aside>
</main>`;
}

/** Delegated listeners only: LIVE_UPDATE_SCRIPT replaces the page content in place after every action. */
const SCRIPT = `
const VIEW_ACTIONS = ['browser', 'branch'];
document.addEventListener('click', e => {
  if (e.target.closest('.md')) return; // work item HTML: ignore look-alike controls inside it
  const pr = e.target.closest('[data-pr]');
  if (pr) { vscode.postMessage({ type: 'openPr', repoId: pr.dataset.pr, prId: Number(pr.dataset.prId) }); return; }
  const wi = e.target.closest('[data-wi]');
  if (wi) { vscode.postMessage({ type: 'openWi', id: Number(wi.dataset.wi) }); return; }
  const rp = e.target.closest('[data-remove-parent]');
  if (rp) { postAction({ type: 'removeParent', id: Number(rp.dataset.removeParent) }, rp); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (VIEW_ACTIONS.includes(el.dataset.action)) vscode.postMessage({ type: el.dataset.action });
  else postAction({ type: el.dataset.action }, el);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.closest('.md')) return;
  if (el.id === 'state') postAction({ type: 'state', value: el.value }, el);
  else if (el.dataset.field) postAction({ type: 'field', name: el.dataset.field, kind: el.dataset.kind, value: el.value }, el);
});
document.addEventListener('keydown', e => {
  const el = e.target;
  if (el.id === 'tags' && e.key === 'Enter') { e.preventDefault(); el.blur(); }
  if (el.id !== 'title') return;
  if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
  if (e.key === 'Escape') { el.textContent = el.dataset.original; el.blur(); }
});
document.addEventListener('focusout', e => {
  const el = e.target;
  if (el.id === 'tags' && !el.disabled && el.value !== el.defaultValue) postAction({ type: 'tags', value: el.value }, el);
  if (el.id !== 'title') return;
  const v = el.textContent.trim();
  if (v && v !== el.dataset.original) postAction({ type: 'title', value: v });
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  const f = form.elements;
  const button = form.querySelector('button');
  if (form.id === 'new-comment') {
    const text = f.text.value.trim();
    if (text) postAction({ type: 'comment', text }, button);
  } else if (form.id === 'add-child' && f.title.value.trim()) {
    postAction({ type: 'addChild', childType: f.childType.value, title: f.title.value }, button);
  }
});
`;

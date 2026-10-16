import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { errorMessage, guarded, panelHtml, plural, shortRef } from '../util';
import {
  matchesBuild, matchesPullRequest, PipelineWatcherConfig, PullRequestWatcherConfig, readWatchers, WatcherConfig, watchersTarget, WorkItemWatcherConfig, writeWatchers,
} from './watchers';

/** Form editor for `azureDevOps.watchers`: list on the left, the selected watcher on the right, with a filter preview. */
export class WatchersPanel {
  private static current?: WatchersPanel;

  /** `select`: index of the watcher to edit, or 'new' to start a new one. */
  static show(client: AdoClient, extensionUri: vscode.Uri, select?: number | 'new'): void {
    if (WatchersPanel.current) {
      WatchersPanel.current.panel.reveal();
      if (select !== undefined) {
        WatchersPanel.current.post({ type: 'select', index: select });
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.watchers', 'Watchers', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const instance = new WatchersPanel(panel, client, select);
    WatchersPanel.current = instance;
    panel.onDidDispose(() => {
      WatchersPanel.current = undefined;
      instance.configListener.dispose();
    });
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Watchers', BODY, SCRIPT);
  }

  private readonly configListener: vscode.Disposable;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly client: AdoClient, private initialSelect?: number | 'new') {
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
    // Edits made in settings.json while the editor is open show up here too.
    this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('azureDevOps.watchers')) {
        this.sendWatchers();
      }
    });
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private target(): vscode.ConfigurationTarget {
    return watchersTarget();
  }

  private watchers(): WatcherConfig[] {
    return readWatchers();
  }

  private sendWatchers(): void {
    this.post({
      type: 'watchers',
      watchers: this.watchers(),
      target: this.target() === vscode.ConfigurationTarget.Workspace ? 'workspace settings' : 'user settings',
    });
  }

  private write(list: WatcherConfig[]): Promise<void> {
    return writeWatchers(list);
  }

  private async handle(m: any): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready();
        return;
      case 'save':
        await this.save(m.watcher as WatcherConfig, Number(m.index));
        return;
      case 'delete': {
        const list = this.watchers();
        list.splice(Number(m.index), 1);
        await this.write(list);
        return;
      }
      case 'setEnabled':
        await this.setEnabled(Number(m.index), !!m.enabled);
        return;
      case 'preview':
        await this.preview(m.watcher as WatcherConfig, Number(m.seq));
        return;
      case 'open':
        if (Array.isArray(m.args) && typeof m.args[0] === 'string' && m.args[0].startsWith('azureDevOps.')) {
          await vscode.commands.executeCommand(m.args[0], ...m.args.slice(1));
        }
        return;
      case 'json':
        await vscode.commands.executeCommand(this.target() === vscode.ConfigurationTarget.Workspace
          ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson',
        { revealSetting: { key: 'azureDevOps.watchers', edit: true } });
        return;
    }
  }

  /** Sends the watchers and, in the background, the names offered as suggestions. */
  private ready(): void {
    this.sendWatchers();
    if (this.initialSelect !== undefined) {
      this.post({ type: 'select', index: this.initialSelect });
      this.initialSelect = undefined;
    }
    this.client.listRepositoryNames().then(repos => this.post({ type: 'repos', repos }), () => undefined);
    this.client.listDefinitions().then(defs => this.post({ type: 'pipelines', names: defs.map(d => d.name) }), () => undefined);
  }

  private async save(w: WatcherConfig, index: number): Promise<void> {
    const list = this.watchers();
    if (list.some((x, i) => i !== index && x.name.trim().toLowerCase() === w.name.trim().toLowerCase())) {
      this.post({ type: 'saveError', message: `A watcher named "${w.name}" already exists.` });
      return;
    }
    const replace = index >= 0 && index < list.length;
    if (replace) {
      list[index] = w;
    } else {
      list.push(w);
    }
    await this.write(list);
    this.post({ type: 'saved', index: replace ? index : list.length - 1 });
  }

  private async setEnabled(index: number, enabled: boolean): Promise<void> {
    const list = this.watchers();
    const w = list[index];
    if (w) {
      list[index] = { ...w, enabled: enabled ? undefined : false };
      await this.write(list);
    }
  }

  /** What the filter matches right now: recent matching work items, or matching active pull requests. */
  private async preview(w: WatcherConfig, seq: number): Promise<void> {
    try {
      let result: Preview;
      if (w.type === 'workItem') {
        result = await this.previewWorkItems(w);
      } else if (w.type === 'pipeline') {
        result = await this.previewPipelines(w);
      } else {
        result = await this.previewPullRequests(w);
      }
      this.post({ type: 'preview', seq, ...result });
    } catch (e) {
      this.post({ type: 'preview', seq, error: errorMessage(e) });
    }
  }

  private async previewWorkItems(w: WorkItemWatcherConfig): Promise<Preview> {
    const where = w.where?.trim() ? ` AND (${w.where})` : '';
    const ids = await this.client.queryWiql(
      `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${where} ORDER BY [System.ChangedDate] DESC`, { top: 10 });
    const items = ids.length ? await this.client.getWorkItems(ids) : [];
    return {
      note: ids.length ? 'Most recently changed matches (up to 10). Only changes from now on will trigger.' : 'No work items match this filter right now.',
      items: items.map(x => ({
        title: `#${x.id} ${x.fields['System.Title']}`,
        sub: `${x.fields['System.WorkItemType']} · ${x.fields['System.State']}`,
        open: ['azureDevOps.wi.open', x.id],
      })),
    };
  }

  private async previewPipelines(w: PipelineWatcherConfig): Promise<Preview> {
    const [me, builds] = await Promise.all([this.client.getMe(), this.client.listBuilds({ top: 100 })]);
    const hits = builds.filter(b => matchesBuild(w, b, me));
    return {
      note: hits.length ? `${hits.length} of the last 100 runs match this filter${showing(hits.length)}. Only runs from now on will trigger.`
        : 'None of the last 100 runs match this filter.',
      items: hits.slice(0, 10).map(b => {
        const state = b.status === 'completed' ? b.result : b.status;
        const who = b.requestedFor ? ` · ${b.requestedFor.displayName}` : '';
        return { title: `${b.definition.name} #${b.buildNumber}`, sub: `${shortRef(b.sourceBranch)} · ${state}${who}`, open: ['azureDevOps.pipelines.openRun', b.id] };
      }),
    };
  }

  private async previewPullRequests(w: PullRequestWatcherConfig): Promise<Preview> {
    const [me, prs] = await Promise.all([this.client.getMe(), this.client.listActivePullRequests()]);
    const hits = prs.filter(pr => matchesPullRequest(w, pr, me));
    const verb = hits.length === 1 ? 'matches' : 'match';
    return {
      note: hits.length ? `${plural(hits.length, 'active pull request')} ${verb} this filter${showing(hits.length)}.`
        : 'No active pull requests match this filter right now.',
      items: hits.slice(0, 10).map(pr => ({
        title: `!${pr.pullRequestId} ${pr.title}`,
        sub: `${pr.repository.name} · ${shortRef(pr.sourceRefName)} → ${shortRef(pr.targetRefName)}`,
        open: ['azureDevOps.pr.openOverview', pr.repository.id, pr.pullRequestId],
      })),
    };
  }

}

interface Preview {
  note: string;
  items: { title: string; sub: string; open: unknown[] }[];
}

const showing = (n: number) => n > 10 ? ' (showing 10)' : '';

const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const hintHtml = (hint: string, lead = '') => hint ? `${lead}<span class="hint">${hint}</span>` : '';
const toggle = (id: string, label: string, hint = '') =>
  `<label class="run-toggle"><input type="checkbox" id="${id}"><span class="switch"></span><span>${label}${hintHtml(hint, ' ')}</span></label>`;
const field = (id: string, label: string, attrs = '', hint = '') =>
  `<label class="run-field"><span class="run-label">${label}</span><input id="${id}" spellcheck="false" ${attrs}>${hintHtml(hint)}</label>`;

const BODY = `
<div class="run wt">
  <header class="run-head">
    <div class="run-icon">${EYE}</div>
    <div class="run-head-text"><h1>Watchers</h1><p class="muted" id="subtitle">Get notified when work items, pull requests or pipeline runs change.</p></div>
    <span class="spacer"></span>
    <button type="button" class="btn ghost" id="json">Edit in settings.json</button>
  </header>
  <div class="wt-grid">
    <aside>
      <div id="list" class="wt-list"></div>
      <button type="button" class="btn wt-add" id="add">+ New watcher</button>
    </aside>
    <div>
      <div id="empty" class="wt-empty" hidden>
        <p><strong>No watchers yet.</strong></p>
        <p class="muted">A watcher checks Azure DevOps in the background, for example for new bugs assigned to you or new pull requests you should review, and notifies you when something changes.</p>
        <button type="button" class="btn primary" id="addEmpty">Create a watcher</button>
      </div>
      <form id="form" autocomplete="off" novalidate hidden>
        <section class="run-section">
          <h2>General</h2>
          ${field('name', 'Name <span class="req">*</span>', 'required placeholder="e.g. New bugs for me"')}
          <div class="run-field"><span class="run-label">Watch</span>
            <div class="seg" id="type"><button type="button" data-value="workItem">Work items</button><button type="button" data-value="pullRequest">Pull requests</button><button type="button" data-value="pipeline">Pipelines</button></div></div>
          <label class="run-field"><span class="run-label">Check every</span>
            <select id="interval"><option value="60">1 minute</option><option value="120">2 minutes</option><option value="300">5 minutes</option>
            <option value="600">10 minutes</option><option value="900">15 minutes</option><option value="1800">30 minutes</option><option value="3600">1 hour</option></select></label>
          ${toggle('enabled', 'Enabled')}
          ${toggle('ignoreOwn', 'Ignore my own changes')}
        </section>
        <section class="run-section">
          <h2>Filter</h2>
          <div id="wiFilter">
            <label class="run-field"><span class="run-label">WIQL condition <span class="muted">(optional)</span></span>
              <textarea id="where" rows="3" class="mono" spellcheck="false" placeholder="[System.WorkItemType] = 'Bug' AND [System.AssignedTo] = @Me"></textarea>
              <span class="hint">Everything after WHERE in a WIQL query. Macros such as @Me, @CurrentIteration and @Today - 7 work. Empty means all work items of the project.</span></label>
          </div>
          <div id="prFilter">
            ${field('repository', 'Repository <span class="muted">(optional)</span>', 'list="repos" placeholder="All repositories"', 'Separate several with commas.')}
            <datalist id="repos"></datalist>
            <div class="wt-row">
              ${field('targetBranch', 'Target branch', 'placeholder="e.g. main or release/*"')}
              ${field('sourceBranch', 'Source branch', 'placeholder="e.g. feature/*"')}
            </div>
            <div class="wt-row">
              ${field('createdBy', 'Author', 'list="people" placeholder="@me, name or e-mail"')}
              ${field('reviewer', 'Reviewer', 'list="people" placeholder="@me, name or e-mail"')}
            </div>
            <datalist id="people"><option value="@me"></option></datalist>
            ${field('titleContains', 'Title contains', 'placeholder="Any title"')}
            ${toggle('includeDrafts', 'Include draft pull requests')}
          </div>
          <div id="plFilter">
            ${field('pipeline', 'Pipeline <span class="muted">(optional)</span>', 'list="pipelines" placeholder="All pipelines"', 'Separate several with commas; * is a wildcard.')}
            <datalist id="pipelines"></datalist>
            <div class="wt-row">
              ${field('branch', 'Branch', 'placeholder="e.g. main or release/*"')}
              ${field('requestedBy', 'Started by', 'list="people" placeholder="@me, name or e-mail"')}
            </div>
          </div>
          <div class="wt-test"><button type="button" class="btn" id="test">Test filter</button><span class="hint">Shows what the filter matches right now.</span></div>
          <div id="preview" class="wt-preview" hidden></div>
        </section>
        <section class="run-section">
          <h2>Trigger on</h2>
          <div id="events"></div>
          <div id="fieldsBox">
            ${field('fields', 'Only when these fields change <span class="muted">(optional)</span>', 'class="mono" list="wiFields" placeholder="System.State, System.AssignedTo"', 'Leave empty to report any change. Otherwise the notification shows the old and new values.')}
            <datalist id="wiFields"><option value="System.State"></option><option value="System.AssignedTo"></option><option value="System.Title"></option>
              <option value="System.IterationPath"></option><option value="System.AreaPath"></option><option value="Microsoft.VSTS.Common.Priority"></option><option value="System.Tags"></option></datalist>
          </div>
        </section>
        <section class="run-section">
          <h2>Actions</h2>
          ${toggle('actNotify', 'Show a notification', 'with Open and Open in Browser buttons')}
          ${toggle('actOpen', 'Open it in VS Code')}
          ${toggle('actBrowser', 'Open it in the browser')}
          ${toggle('actCommand', 'Run a VS Code command')}
          <div id="commandBox">
            ${field('command', 'Command ID', 'class="mono" placeholder="e.g. workbench.action.tasks.runTask"')}
            <label class="run-field"><span class="run-label">Arguments <span class="muted">(JSON array, optional)</span></span>
              <textarea id="args" rows="2" class="mono" spellcheck="false" placeholder='["\${id}", "\${url}"]'></textarea>
              <span class="hint">\${id}, \${title}, \${url}, \${kind}, \${watcher} and \${message} are replaced for each event.</span></label>
          </div>
        </section>
        <div id="formError" class="run-alert" hidden></div>
        <footer class="run-foot">
          <span class="muted small" id="where-saved"></span>
          <span class="spacer"></span>
          <button type="button" class="btn ghost danger" id="delete">Delete</button>
          <button type="button" class="btn ghost" id="discard" hidden>Discard changes</button>
          <button type="submit" class="btn primary" id="save">Save</button>
        </footer>
      </form>
    </div>
  </div>
</div>`;

const SCRIPT = `
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const EVENTS = {
  workItem: [['created', 'Created', 'a new work item matches the filter'], ['changed', 'Changed', 'a matching work item was edited']],
  pullRequest: [['created', 'Created', 'a new pull request is opened'], ['pushed', 'New commits', 'the source branch was updated'],
    ['voted', 'Votes', 'a reviewer approves, rejects or waits for the author'], ['completed', 'Completed', 'it was merged'], ['abandoned', 'Abandoned', '']],
  pipeline: [['failed', 'Failed', 'including partially succeeded runs'], ['succeeded', 'Succeeded', ''], ['canceled', 'Canceled', ''], ['started', 'Started', 'a run begins']],
};
const DEFAULT_EVENTS = { workItem: ['created', 'changed'], pullRequest: ['created'], pipeline: ['failed'] };
const TYPE_LABEL = { workItem: 'Work items', pullRequest: 'Pull requests', pipeline: 'Pipelines' };
const OWN_DEFAULT = { workItem: true, pullRequest: true, pipeline: false };
let watchers = [], selected = -1, type = 'workItem', saved = null, previewSeq = 0, pendingSelect = null;

function summary(w) {
  const what = TYPE_LABEL[w.type] || 'Work items';
  const ev = (w.events && w.events.length ? w.events : DEFAULT_EVENTS[w.type] || []).join(', ');
  const mins = Math.round(Math.max(60, w.interval || 300) / 60);
  return what + ' · ' + ev + ' · every ' + mins + ' min';
}

function renderList() {
  $('list').innerHTML = watchers.map((w, i) =>
    '<div class="wt-item' + (i === selected ? ' selected' : '') + (w.enabled === false ? ' disabled' : '') + '" data-index="' + i + '" tabindex="0">' +
      '<div class="wt-item-text"><div class="wt-item-name">' + esc(w.name || '(unnamed)') + '</div><div class="wt-item-sub">' + esc(summary(w)) + '</div></div>' +
      '<label class="run-toggle wt-switch" title="' + (w.enabled === false ? 'Enable' : 'Disable') + '"><input type="checkbox" data-enable="' + i + '"' + (w.enabled === false ? '' : ' checked') + '><span class="switch"></span></label>' +
    '</div>').join('') + (selected === watchers.length ? '<div class="wt-item selected"><div class="wt-item-text"><div class="wt-item-name">New watcher</div><div class="wt-item-sub">Not saved yet</div></div></div>' : '');
  const none = !watchers.length && selected < 0;
  $('empty').hidden = !none;
  $('form').hidden = none || selected < 0;
}

function setType(t) {
  type = t;
  $('type').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === t)));
  $('wiFilter').hidden = t !== 'workItem';
  $('prFilter').hidden = t !== 'pullRequest';
  $('plFilter').hidden = t !== 'pipeline';
  $('preview').hidden = true;
}

function renderEvents(list) {
  $('events').innerHTML = EVENTS[type].map(([id, label, hint]) =>
    '<label class="run-toggle"><input type="checkbox" data-event="' + id + '"' + (list.includes(id) ? ' checked' : '') + '><span class="switch"></span><span>' + label +
    (hint ? ' <span class="hint">' + hint + '</span>' : '') + '</span></label>').join('');
  updateVisibility();
}

function updateVisibility() {
  const changed = document.querySelector('[data-event="changed"]');
  $('fieldsBox').hidden = type !== 'workItem' || !changed || !changed.checked;
  $('commandBox').hidden = !$('actCommand').checked;
}

function fill(w) {
  $('name').value = w.name || '';
  setType(TYPE_LABEL[w.type] ? w.type : 'workItem');
  const interval = String(Math.max(60, w.interval || 300));
  if (![...$('interval').options].some(o => o.value === interval)) {
    $('interval').insertAdjacentHTML('beforeend', '<option value="' + interval + '">' + Math.round(interval / 60) + ' minutes</option>');
  }
  $('interval').value = interval;
  $('enabled').checked = w.enabled !== false;
  $('ignoreOwn').checked = w.ignoreOwnChanges ?? OWN_DEFAULT[type];
  $('where').value = w.where || '';
  $('fields').value = (w.fields || []).join(', ');
  $('repository').value = Array.isArray(w.repository) ? w.repository.join(', ') : (w.repository || '');
  for (const k of ['targetBranch', 'sourceBranch', 'createdBy', 'reviewer', 'titleContains', 'branch', 'requestedBy']) $(k).value = w[k] || '';
  $('pipeline').value = Array.isArray(w.pipeline) ? w.pipeline.join(', ') : (w.pipeline || '');
  $('includeDrafts').checked = w.includeDrafts !== false;
  renderEvents(w.events && w.events.length ? w.events : DEFAULT_EVENTS[type]);
  const actions = w.actions && w.actions.length ? w.actions : ['notify'];
  $('actNotify').checked = actions.includes('notify');
  $('actOpen').checked = actions.includes('open');
  $('actBrowser').checked = actions.includes('browser');
  const cmd = actions.find(a => a && typeof a === 'object');
  $('actCommand').checked = !!cmd;
  $('command').value = cmd ? cmd.command : '';
  $('args').value = cmd && cmd.args ? JSON.stringify(cmd.args) : '';
  $('formError').hidden = true;
  $('preview').hidden = true;
  $('delete').hidden = selected >= watchers.length;
  updateVisibility();
  saved = JSON.stringify(read(true));
  dirtyCheck();
}

/** The watcher as stored in settings: defaults and empty fields are left out. */
function read(lenient) {
  const w = { name: $('name').value.trim(), type };
  if (!$('enabled').checked) w.enabled = false;
  const interval = Number($('interval').value);
  if (interval !== 300) w.interval = interval;
  const events = [...document.querySelectorAll('[data-event]')].filter(e => e.checked).map(e => e.dataset.event);
  if (events.join() !== DEFAULT_EVENTS[type].join()) w.events = events;
  if (type === 'workItem') {
    if ($('where').value.trim()) w.where = $('where').value.trim();
    const fields = $('fields').value.split(',').map(s => s.trim()).filter(Boolean);
    if (fields.length && events.includes('changed')) w.fields = fields;
  } else if (type === 'pipeline') {
    const names = $('pipeline').value.split(',').map(s => s.trim()).filter(Boolean);
    if (names.length) w.pipeline = names.length === 1 ? names[0] : names;
    for (const k of ['branch', 'requestedBy']) if ($(k).value.trim()) w[k] = $(k).value.trim();
  } else {
    const repos = $('repository').value.split(',').map(s => s.trim()).filter(Boolean);
    if (repos.length) w.repository = repos.length === 1 ? repos[0] : repos;
    for (const k of ['targetBranch', 'sourceBranch', 'createdBy', 'reviewer', 'titleContains']) if ($(k).value.trim()) w[k] = $(k).value.trim();
    if (!$('includeDrafts').checked) w.includeDrafts = false;
  }
  if ($('ignoreOwn').checked !== OWN_DEFAULT[type]) w.ignoreOwnChanges = $('ignoreOwn').checked;
  const actions = [];
  if ($('actNotify').checked) actions.push('notify');
  if ($('actOpen').checked) actions.push('open');
  if ($('actBrowser').checked) actions.push('browser');
  if ($('actCommand').checked) {
    const action = { command: $('command').value.trim() };
    const args = $('args').value.trim();
    if (args) {
      try { action.args = JSON.parse(args); } catch { if (!lenient) throw new Error('Arguments must be a JSON array, e.g. ["\${id}"].'); }
      if (!lenient && !Array.isArray(action.args)) throw new Error('Arguments must be a JSON array, e.g. ["\${id}"].');
    }
    if (!lenient && !action.command) throw new Error('Enter the ID of the command to run.');
    actions.push(action);
  }
  if (actions.join() !== 'notify' || actions.length !== 1) w.actions = actions;
  if (!lenient) {
    if (!w.name) throw new Error('Give the watcher a name.');
    if (!events.length) throw new Error('Choose at least one event to trigger on.');
    if (!actions.length) throw new Error('Choose at least one action.');
  }
  return w;
}

function isDirty() { return saved !== null && JSON.stringify(read(true)) !== saved; }
function dirtyCheck() {
  const dirty = isDirty() || selected >= watchers.length;
  $('save').disabled = !dirty;
  $('discard').hidden = !isDirty() || selected >= watchers.length;
}

function select(i) {
  if (i !== selected && isDirty()) {
    pendingSelect = i;
    $('formError').textContent = 'You have unsaved changes. Save them, or click "Discard changes" first.';
    $('formError').hidden = false;
    $('discard').hidden = false;
    return;
  }
  pendingSelect = null;
  selected = i;
  renderList();
  if (i >= 0) fill(watchers[i] || { type: 'workItem', name: '' });
}

$('list').addEventListener('click', e => {
  const en = e.target.closest('[data-enable]');
  if (en) { vscode.postMessage({ type: 'setEnabled', index: Number(en.dataset.enable), enabled: en.checked }); return; }
  if (e.target.closest('.wt-switch')) return;
  const item = e.target.closest('[data-index]');
  if (item) select(Number(item.dataset.index));
});
$('add').addEventListener('click', () => select(watchers.length));
$('addEmpty').addEventListener('click', () => select(watchers.length));
$('json').addEventListener('click', () => vscode.postMessage({ type: 'json' }));
$('type').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.dataset.value === type) return;
  setType(b.dataset.value);
  renderEvents(DEFAULT_EVENTS[type]);
  $('ignoreOwn').checked = OWN_DEFAULT[type];
  dirtyCheck();
});
$('form').addEventListener('input', () => { updateVisibility(); dirtyCheck(); });
$('form').addEventListener('change', () => { updateVisibility(); dirtyCheck(); });
$('discard').addEventListener('click', () => {
  saved = null;
  const next = pendingSelect !== null ? pendingSelect : selected;
  pendingSelect = null;
  selected = -2;
  select(next);
});
$('delete').addEventListener('click', () => {
  if ($('delete').dataset.confirm) {
    vscode.postMessage({ type: 'delete', index: selected });
    saved = null;
    selected = -1;
    delete $('delete').dataset.confirm;
    return;
  }
  $('delete').dataset.confirm = '1';
  $('delete').textContent = 'Click again to delete';
  setTimeout(() => { delete $('delete').dataset.confirm; $('delete').textContent = 'Delete'; }, 3000);
});
$('test').addEventListener('click', () => {
  let w;
  try { w = read(true); } catch { return; }
  $('preview').hidden = false;
  $('preview').innerHTML = '<p class="muted">Checking…</p>';
  vscode.postMessage({ type: 'preview', watcher: w, seq: ++previewSeq });
});
$('preview').addEventListener('click', e => {
  const a = e.target.closest('[data-open]');
  if (a) vscode.postMessage({ type: 'open', args: JSON.parse(a.dataset.open) });
});
$('form').addEventListener('submit', e => {
  e.preventDefault();
  let w;
  try { w = read(false); } catch (err) { $('formError').textContent = err.message; $('formError').hidden = false; return; }
  $('formError').hidden = true;
  $('save').classList.add('busy');
  vscode.postMessage({ type: 'save', index: selected, watcher: w });
});

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'watchers') {
    watchers = m.watchers || [];
    $('where-saved').textContent = 'Saved in your ' + m.target;
    // Keep unsaved edits; otherwise show the stored version (it may have been edited in settings.json).
    if (selected >= 0 && selected < watchers.length && !isDirty()) fill(watchers[selected]);
    if (selected >= watchers.length && selected !== watchers.length) selected = -1;
    if (selected < 0 && watchers.length) { selected = 0; fill(watchers[0]); }
    renderList();
  } else if (m.type === 'saved') {
    // May arrive before or after the updated list; either way the form shows the stored version afterwards.
    $('save').classList.remove('busy');
    saved = null;
    selected = m.index;
    if (watchers[selected]) fill(watchers[selected]);
    renderList();
  } else if (m.type === 'saveError') {
    $('save').classList.remove('busy');
    $('formError').textContent = m.message;
    $('formError').hidden = false;
  } else if (m.type === 'select') {
    select(m.index === 'new' ? watchers.length : m.index);
  } else if (m.type === 'pipelines') {
    $('pipelines').innerHTML = m.names.map(r => '<option value="' + esc(r) + '"></option>').join('');
  } else if (m.type === 'repos') {
    $('repos').innerHTML = m.repos.map(r => '<option value="' + esc(r) + '"></option>').join('');
  } else if (m.type === 'preview' && m.seq === previewSeq) {
    $('preview').innerHTML = m.error ? '<div class="run-alert">' + esc(m.error) + '</div>'
      : '<p class="hint">' + esc(m.note) + '</p>' + (m.items || []).map(x =>
        '<a class="wt-hit" data-open="' + esc(JSON.stringify(x.open)) + '"><span>' + esc(x.title) + '</span><span class="hint">' + esc(x.sub) + '</span></a>').join('');
  }
});
vscode.postMessage({ type: 'ready' });
`;

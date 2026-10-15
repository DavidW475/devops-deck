import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { errorMessage, guarded, panelHtml } from '../util';
import { BuildLogTerminal } from './logs';
import { buildDto, timelineTree } from './timeline';

/** Run summary like the Azure DevOps stage view: stages side by side, their jobs and steps, logs one click away. */
export class RunViewPanel {
  private static readonly panels = new Map<number, RunViewPanel>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private title = '';

  static show(client: AdoClient, extensionUri: vscode.Uri, buildId: number, onChange: () => void): void {
    const existing = RunViewPanel.panels.get(buildId);
    if (existing) {
      existing.panel.reveal();
      void existing.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.run', `Run ${buildId}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const view = new RunViewPanel(panel, client, buildId, onChange);
    RunViewPanel.panels.set(buildId, view);
    panel.onDidDispose(() => {
      view.disposed = true;
      clearTimeout(view.timer);
      RunViewPanel.panels.delete(buildId);
    });
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Run', BODY, SCRIPT);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AdoClient,
    private readonly buildId: number,
    private readonly onChange: () => void,
  ) {
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
  }

  private async handle(m: any): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        await this.load();
        return;
      case 'openLog':
        await vscode.commands.executeCommand('azureDevOps.pipelines.openLog', this.buildId, m.logId, m.name);
        return;
      case 'stream':
        BuildLogTerminal.show(this.client, this.buildId, this.title);
        return;
      case 'browser':
        await vscode.env.openExternal(vscode.Uri.parse(this.client.webUrl('build', this.buildId)));
        return;
      case 'cancel':
        await vscode.commands.executeCommand('azureDevOps.pipelines.cancel', this.buildId);
        await this.load();
        return;
      case 'rerun':
        await vscode.commands.executeCommand('azureDevOps.pipelines.run', m.definitionId);
        return;
    }
  }

  /** Fetches run + timeline, pushes them to the page, and keeps polling while the run is active. */
  private async load(): Promise<void> {
    clearTimeout(this.timer);
    try {
      const [build, records] = await Promise.all([
        this.client.getBuild(this.buildId),
        this.client.getTimeline(this.buildId).catch(() => []),
      ]);
      if (this.disposed) {
        return;
      }
      const run = buildDto(build);
      this.title = `${run.definitionName} #${run.number}`;
      this.panel.title = `${run.definitionName} #${run.number}`;
      void this.panel.webview.postMessage({ type: 'data', run, stages: timelineTree(records) });
      if (run.status !== 'completed') {
        const seconds = Math.max(5, vscode.workspace.getConfiguration('azureDevOps').get<number>('pipelines.refreshInterval', 10));
        this.timer = setTimeout(() => void this.load(), seconds * 1000);
      } else if (this.wasRunning) {
        this.onChange();
      }
      this.wasRunning = run.status !== 'completed';
    } catch (e) {
      void this.panel.webview.postMessage({ type: 'error', message: errorMessage(e) });
    }
  }

  private wasRunning = false;
}

const BODY = `<div id="root" class="rv"><div class="loading"><div class="spinner"></div></div></div>`;

const SCRIPT = `
const root = document.getElementById('root');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ICONS = {
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  fail: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  skip: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  spin: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  commit: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  rerun: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
};
const icon = (n, cls = '') => '<svg class="i ' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[n] || '') + '</svg>';

function kind(state, result, waiting) {
  if (waiting) return 'waiting';
  if (state === 'inProgress' || state === 'cancelling') return 'running';
  if (state === 'pending' || state === 'notStarted' || state === 'postponed' || !state) return result ? kindOf(result) : 'queued';
  return kindOf(result);
}
function kindOf(result) {
  switch (result) {
    case 'succeeded': return 'ok';
    case 'failed': return 'fail';
    case 'succeededWithIssues': case 'partiallySucceeded': return 'warn';
    case 'canceled': case 'abandoned': return 'canceled';
    case 'skipped': return 'skipped';
  }
  return 'queued';
}
const KIND_ICON = { ok: 'ok', fail: 'fail', warn: 'warn', canceled: 'ban', skipped: 'skip', queued: 'clock', running: 'spin', waiting: 'hand' };
const KIND_LABEL = { ok: 'Succeeded', fail: 'Failed', warn: 'Succeeded with issues', canceled: 'Canceled', skipped: 'Skipped', queued: 'Not started', running: 'Running', waiting: 'Waiting for approval' };
const badge = (k, cls = '') => '<span class="st st-' + k + ' ' + cls + '" title="' + KIND_LABEL[k] + '">' + icon(KIND_ICON[k], k === 'running' ? 'spin' : '') + '</span>';
const nodeKind = n => kind(n.state, n.result, n.waiting);

function dur(start, end) {
  if (!start) return '';
  const s = Math.max(0, Math.round(((end ? new Date(end) : new Date()) - new Date(start)) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(iso).toLocaleString();
}

const saved = vscode.getState() || {};
let data = null, selected = saved.selected ?? null, openJobs = new Set(saved.openJobs || []), userPicked = !!saved.userPicked;
const persist = () => vscode.setState({ selected, openJobs: [...openJobs], userPicked });

/** Pipelines without stages have jobs at the top; show them as one implicit stage. */
function stagesOf(nodes) {
  if (nodes.length && nodes.every(n => n.type === 'Stage')) return nodes;
  return nodes.length ? [{ id: '__jobs', name: 'Jobs', type: 'Stage', state: data.run.status === 'completed' ? 'completed' : 'inProgress', result: data.run.result, start: data.run.startTime, finish: data.run.finishTime, errors: [], warningCount: 0, children: nodes }] : [];
}
function jobsOf(stage) { return stage.children.filter(c => c.type === 'Job'); }

function defaultStage(stages) {
  return (stages.find(s => nodeKind(s) === 'running' || nodeKind(s) === 'waiting')
    || stages.find(s => nodeKind(s) === 'fail')
    || stages.filter(s => nodeKind(s) !== 'queued' && nodeKind(s) !== 'skipped').pop()
    || stages[0])?.id;
}

function render() {
  if (!data) return;
  const r = data.run;
  const runKind = kind(r.status === 'completed' ? 'completed' : r.status === 'notStarted' ? 'pending' : 'inProgress', r.result);
  const stages = stagesOf(data.stages);
  if (!userPicked || !stages.some(s => s.id === selected)) selected = defaultStage(stages);
  const stage = stages.find(s => s.id === selected);
  const running = r.status !== 'completed';
  const scroller = document.querySelector('.stages');
  const scrollLeft = scroller ? scroller.scrollLeft : 0;

  root.innerHTML =
    '<header class="rv-head rv-' + runKind + '">' +
      '<div class="rv-title">' + badge(runKind, 'big') +
        '<div><h1>' + esc(r.definitionName) + ' <span class="muted">#' + esc(r.number) + '</span></h1>' +
        '<div class="rv-meta">' +
          '<span class="chip">' + icon('branch') + esc(r.branch) + '</span>' +
          (r.commit ? '<span class="chip mono">' + icon('commit') + esc(r.commit) + '</span>' : '') +
          (r.requestedFor ? '<span class="chip">' + icon('user') + esc(r.requestedFor) + '</span>' : '') +
          '<span class="muted">' + esc(KIND_LABEL[runKind]) + (r.startTime ? ' · started ' + ago(r.startTime) + ' · <span data-live="' + esc(r.startTime) + '"' + (r.finishTime ? ' data-end="' + esc(r.finishTime) + '"' : '') + '>' + dur(r.startTime, r.finishTime) + '</span>' : r.queueTime ? ' · queued ' + ago(r.queueTime) : '') + '</span>' +
        '</div></div></div>' +
      '<div class="rv-actions">' +
        '<button class="btn primary" data-act="stream">' + icon('terminal') + (running ? 'Stream live logs' : 'All logs') + '</button>' +
        (running ? '<button class="btn danger" data-act="cancel">' + icon('stop') + 'Cancel</button>' : '<button class="btn" data-act="rerun" data-def="' + r.definitionId + '">' + icon('rerun') + 'Run again</button>') +
        '<button class="btn ghost icon-only" data-act="refresh" title="Refresh">' + icon('refresh') + '</button>' +
        '<button class="btn ghost icon-only" data-act="browser" title="Open in browser">' + icon('external') + '</button>' +
      '</div>' +
    '</header>' +
    (stages.length ? '<div class="stages">' + stages.map((s, i) => {
      const k = nodeKind(s);
      const jobs = jobsOf(s);
      const done = jobs.filter(j => !['running', 'queued', 'waiting'].includes(nodeKind(j))).length;
      return (i ? '<div class="stage-link link-' + k + '"></div>' : '') +
        '<button class="stage st-card-' + k + (s.id === selected ? ' selected' : '') + '" data-stage="' + esc(s.id) + '">' +
          '<div class="stage-top">' + badge(k) + '<span class="stage-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span></div>' +
          '<div class="stage-sub">' + (k === 'waiting' ? 'Waiting for approval' : k === 'queued' ? 'Not started' : k === 'skipped' ? 'Skipped' :
            (jobs.length ? done + '/' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's') : '') + (s.start ? ' · <span data-live="' + esc(s.start) + '"' + (s.finish ? ' data-end="' + esc(s.finish) + '"' : '') + '>' + dur(s.start, s.finish) + '</span>' : '')) + '</div>' +
          (s.errors.length ? '<div class="stage-err">' + icon('fail') + s.errors.length + ' error' + (s.errors.length === 1 ? '' : 's') + '</div>' : '') +
        '</button>';
    }).join('') + '</div>' : '<div class="rv-empty">' + (running ? 'Waiting for an agent to pick up the run…' : 'No stages or jobs were recorded for this run.') + '</div>') +
    (stage ? '<section class="jobs"><h2>' + esc(stage.name) + '</h2>' + (jobsOf(stage).map(jobHtml).join('') || '<p class="muted">No jobs in this stage yet.</p>') + '</section>' : '');

  const sc = document.querySelector('.stages');
  if (sc) sc.scrollLeft = scrollLeft;
}

function jobHtml(j) {
  const k = nodeKind(j);
  // Failed and running jobs open by default; the user's toggles win.
  const open = openJobs.has(j.id) !== (k === 'fail' || k === 'running');
  const steps = j.children.filter(c => c.type === 'Task');
  return '<div class="job' + (open ? ' open' : '') + '">' +
    '<div class="job-head" data-job="' + esc(j.id) + '">' + icon('chevron', 'caret') + badge(k) +
      '<span class="job-name">' + esc(j.name) + '</span>' +
      (j.warningCount ? '<span class="pill warn-pill">' + j.warningCount + ' warning' + (j.warningCount === 1 ? '' : 's') + '</span>' : '') +
      '<span class="spacer"></span><span class="muted mono small" ' + (j.start ? 'data-live="' + esc(j.start) + '"' + (j.finish ? ' data-end="' + esc(j.finish) + '"' : '') : '') + '>' + dur(j.start, j.finish) + '</span>' +
      (j.logId ? '<button class="btn ghost small" data-log="' + j.logId + '" data-name="' + esc(j.name) + '" title="Open job log">' + icon('file') + 'Log</button>' : '') +
    '</div>' +
    (open ? '<ol class="steps">' + (steps.map(s => {
      const sk = nodeKind(s);
      return '<li class="step' + (s.logId ? ' has-log' : '') + ' step-' + sk + '"' + (s.logId ? ' data-log="' + s.logId + '" data-name="' + esc(j.name + ' › ' + s.name) + '" title="Open log"' : '') + '>' +
        '<div class="step-row">' + badge(sk) + '<span class="step-name">' + esc(s.name) + '</span>' +
        (s.warningCount ? '<span class="pill warn-pill">' + s.warningCount + '</span>' : '') +
        '<span class="spacer"></span><span class="muted mono small" ' + (s.start ? 'data-live="' + esc(s.start) + '"' + (s.finish ? ' data-end="' + esc(s.finish) + '"' : '') : '') + '>' + dur(s.start, s.finish) + '</span></div>' +
        (s.errors.length ? '<div class="step-errors">' + s.errors.map(e => '<div>' + esc(e) + '</div>').join('') + '</div>' : '') +
      '</li>';
    }).join('') || '<li class="muted small step-empty">No steps yet.</li>') + '</ol>' : '') +
  '</div>';
}

root.addEventListener('click', e => {
  const el = e.target.closest('[data-act],[data-stage],[data-log],[data-job]');
  if (!el) return;
  if (el.dataset.log) { e.stopPropagation(); vscode.postMessage({ type: 'openLog', logId: Number(el.dataset.log), name: el.dataset.name }); }
  else if (el.dataset.stage) { selected = el.dataset.stage; userPicked = true; persist(); render(); }
  else if (el.dataset.job) { const id = el.dataset.job; openJobs.has(id) ? openJobs.delete(id) : openJobs.add(id); persist(); render(); }
  else {
    if (el.dataset.act === 'refresh' || el.dataset.act === 'cancel') el.classList.add('busy');
    vscode.postMessage({ type: el.dataset.act, definitionId: Number(el.dataset.def) });
  }
});

// Tick running durations every second between polls.
setInterval(() => document.querySelectorAll('[data-live]:not([data-end])').forEach(el => { el.textContent = dur(el.dataset.live); }), 1000);

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'data') { data = m; render(); }
  if (m.type === 'error') {
    if (!data) root.innerHTML = '<div class="run-alert">' + esc(m.message) + '</div>';
    document.querySelectorAll('.busy').forEach(b => b.classList.remove('busy'));
  }
});
vscode.postMessage({ type: 'ready' });
`;

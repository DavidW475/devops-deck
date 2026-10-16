import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { BuildDefinition } from '../types';
import { errorMessage, guarded, panelHtml, shortRef } from '../util';
import { parsePipelineParameters } from './yamlParameters';

/** "Run pipeline" form like the Azure DevOps one: branch, commit, runtime parameters and queue-time variables. */
export class RunPipelinePanel {
  private static current?: RunPipelinePanel;
  private def?: BuildDefinition;
  private paramSeq = 0;

  static show(client: AdoClient, extensionUri: vscode.Uri, definitionId: number | undefined, onQueued: () => void): void {
    const existing = RunPipelinePanel.current;
    if (existing && existing.client !== client) {
      existing.panel.dispose(); // another project
    } else if (existing) {
      existing.panel.reveal();
      if (definitionId !== undefined) {
        void existing.selectDefinition(definitionId);
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.runPipeline', 'Run pipeline', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    RunPipelinePanel.current = new RunPipelinePanel(panel, client, definitionId, onQueued);
    panel.onDidDispose(() => RunPipelinePanel.current = undefined);
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Run pipeline', BODY, SCRIPT);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AdoClient,
    private initialId: number | undefined,
    private readonly onQueued: () => void,
  ) {
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private async handle(m: any): Promise<void> {
    switch (m.type) {
      case 'ready': {
        const defs = await this.client.listDefinitions().catch(e => { this.post({ type: 'fatal', message: errorMessage(e) }); return []; });
        this.post({
          type: 'definitions',
          items: defs.map(d => ({ id: d.id, name: d.name, folder: d.path === '\\' ? '' : d.path.replace(/^\\/, '').replace(/\\/g, ' / ') })),
        });
        if (this.initialId !== undefined) {
          await this.selectDefinition(this.initialId);
        }
        return;
      }
      case 'definition':
        await this.selectDefinition(Number(m.id));
        return;
      case 'branch':
        await this.loadParameters(String(m.branch));
        return;
      case 'run':
        await this.run(m);
        return;
      case 'cancel':
        this.panel.dispose();
        return;
    }
  }

  private async selectDefinition(id: number): Promise<void> {
    this.initialId = id;
    this.post({ type: 'loadingDefinition', id });
    try {
      const def = await this.client.getDefinition(id);
      this.def = def;
      this.panel.title = `Run ${def.name}`;
      const repoId = def.repository?.id;
      const azureRepo = def.repository?.type === 'TfsGit' && !!repoId;
      const branch = shortRef(def.repository?.defaultBranch) || 'main';
      const variables = Object.entries(def.variables ?? {})
        .filter(([, v]) => v.allowOverride)
        .map(([name, v]) => ({ name, value: v.isSecret ? '' : v.value ?? '', isSecret: !!v.isSecret }));
      this.post({
        type: 'definition', id, name: def.name, folder: def.path === '\\' ? '' : def.path.replace(/^\\/, '').replace(/\\/g, ' / '),
        yaml: def.process?.type === 2, yamlFile: def.process?.yamlFilename, repoName: def.repository?.name, branch, variables,
      });
      if (azureRepo) {
        this.client.listBranches(repoId).then(branches => this.post({ type: 'branches', id, branches }), () => undefined);
      }
      await this.loadParameters(branch);
    } catch (e) {
      this.post({ type: 'fatal', message: errorMessage(e) });
    }
  }

  /** Runtime parameters are declared in the YAML file, which can differ per branch. */
  private async loadParameters(branch: string): Promise<void> {
    const def = this.def;
    const seq = ++this.paramSeq;
    if (!def || def.process?.type !== 2) {
      this.post({ type: 'parameters', id: def?.id, params: [] });
      return;
    }
    const repoId = def.repository?.id;
    if (def.repository?.type !== 'TfsGit' || !repoId || !def.process.yamlFilename) {
      this.post({ type: 'parameters', id: def.id, params: [], note: 'Parameters can only be read from Azure Repos. The run uses their defaults.' });
      return;
    }
    this.post({ type: 'parametersLoading', id: def.id });
    try {
      const text = await this.client.getFileText(repoId, def.process.yamlFilename, branch);
      if (seq === this.paramSeq) {
        this.post({ type: 'parameters', id: def.id, params: parsePipelineParameters(text) });
      }
    } catch (e) {
      if (seq === this.paramSeq) {
        this.post({ type: 'parameters', id: def.id, params: [], note: `Couldn't read ${def.process.yamlFilename} on ${branch}: ${errorMessage(e)}` });
      }
    }
  }

  private async run(m: { branch: string; commit?: string; parameters: Record<string, string>; variables: Record<string, string> }): Promise<void> {
    const def = this.def;
    if (!def) {
      return;
    }
    const ref = m.branch.startsWith('refs/') ? m.branch : `refs/heads/${m.branch}`;
    let buildId: number;
    let number: string;
    try {
      if (def.process?.type === 2) {
        const run = await this.client.runPipeline(def.id, { refName: ref, version: m.commit, templateParameters: m.parameters, variables: m.variables });
        buildId = run.id;
        number = run.name;
      } else {
        const build = await this.client.queueClassicBuild(def.id, ref, m.variables, m.commit);
        buildId = build.id;
        number = build.buildNumber;
      }
    } catch (e) {
      this.post({ type: 'runFailed', message: errorMessage(e) });
      return;
    }
    this.panel.dispose();
    this.onQueued();
    vscode.window.setStatusBarMessage(`$(play) Queued ${def.name} #${number}`, 4000);
    await vscode.commands.executeCommand('azureDevOps.pipelines.openRun', buildId, this.client.connection.project);
  }
}

const BODY = `
<div class="run">
  <header class="run-head">
    <div class="run-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg></div>
    <div class="run-head-text"><h1>Run pipeline</h1><p class="muted" id="subtitle">Select the pipeline and how it should run.</p></div>
  </header>
  <div id="fatal" class="run-alert" hidden></div>
  <form id="form" autocomplete="off">
    <section class="run-section">
      <label class="run-field"><span class="run-label">Pipeline</span>
        <select id="definition" required><option value="">Loading pipelines…</option></select></label>
    </section>
    <div id="details" hidden>
      <section class="run-section">
        <h2>Source</h2>
        <label class="run-field"><span class="run-label">Branch</span>
          <span class="run-input-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
          <input id="branch" list="branches" required spellcheck="false"></span>
          <datalist id="branches"></datalist></label>
        <label class="run-field"><span class="run-label">Commit <span class="muted">(optional)</span></span>
          <input id="commit" placeholder="Latest commit of the branch" spellcheck="false" pattern="[0-9a-fA-F]{7,40}" title="Commit SHA"></label>
      </section>
      <section class="run-section" id="paramSection">
        <h2>Parameters</h2>
        <div id="params"></div>
      </section>
      <section class="run-section" id="varSection" hidden>
        <h2>Variables</h2>
        <div id="vars"></div>
      </section>
    </div>
    <div id="runError" class="run-alert" hidden></div>
    <footer class="run-foot">
      <span class="muted small">Ctrl+Enter to run</span>
      <span class="spacer"></span>
      <button type="button" class="btn ghost" id="cancel">Cancel</button>
      <button type="submit" class="btn primary" id="runBtn" disabled>
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg> Run</button>
    </footer>
  </form>
</div>`;

const SCRIPT = `
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let current = null, params = [], edited = {};

function setBusy(on) { $('runBtn').disabled = on || !current; $('runBtn').classList.toggle('busy', on); }
function show(el, on) { el.hidden = !on; }

$('definition').addEventListener('change', e => { if (e.target.value) { edited = {}; vscode.postMessage({ type: 'definition', id: Number(e.target.value) }); } });
let branchTimer;
$('branch').addEventListener('change', () => { clearTimeout(branchTimer); branchTimer = setTimeout(() => vscode.postMessage({ type: 'branch', branch: $('branch').value.trim() }), 150); });
$('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
document.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('form').requestSubmit(); } });

$('params').addEventListener('input', e => { const n = e.target.closest('[data-param]')?.dataset.param; if (n) edited[n] = true; });
$('params').addEventListener('click', e => {
  const chip = e.target.closest('.seg button');
  if (!chip) return;
  const seg = chip.parentElement;
  seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === chip)));
  seg.dataset.value = chip.dataset.value;
  edited[seg.dataset.param] = true;
});

function paramControl(p, prev) {
  const value = prev ?? p.default ?? '';
  const id = esc('p_' + p.name);
  const label = '<span class="run-label">' + esc(p.displayName || p.name) + (p.default === undefined ? ' <span class="req">*</span>' : '') + '</span>';
  if (p.type === 'boolean') {
    const on = String(value).toLowerCase() === 'true';
    return '<label class="run-toggle" data-param="' + esc(p.name) + '"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span class="switch"></span>' + label + '</label>';
  }
  if (p.values && p.values.length) {
    if (p.values.length <= 4 && p.values.every(v => v.length <= 24)) {
      return '<div class="run-field">' + label + '<div class="seg" data-param="' + esc(p.name) + '" data-value="' + esc(value) + '">' +
        p.values.map(v => '<button type="button" data-value="' + esc(v) + '" aria-pressed="' + (v === value) + '">' + esc(v) + '</button>').join('') + '</div></div>';
    }
    return '<label class="run-field" data-param="' + esc(p.name) + '">' + label + '<select id="' + id + '">' +
      p.values.map(v => '<option' + (v === value ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select></label>';
  }
  if (p.type === 'number') {
    return '<label class="run-field" data-param="' + esc(p.name) + '">' + label + '<input type="number" step="any" id="' + id + '" value="' + esc(value) + '"' + (p.default === undefined ? ' required' : '') + '></label>';
  }
  if (p.type !== 'string' || String(value).includes('\\n')) {
    const structured = p.type !== 'string';
    return '<label class="run-field" data-param="' + esc(p.name) + '">' + label + '<textarea id="' + id + '" rows="' + Math.min(10, Math.max(3, String(value).split('\\n').length + 1)) + '" class="' + (structured ? 'mono' : '') + '" spellcheck="false"' + (p.default === undefined ? ' required' : '') + '>' + esc(value) + '</textarea>' +
      (structured ? '<span class="hint">' + esc(p.type) + ' — YAML or JSON</span>' : '') + '</label>';
  }
  return '<label class="run-field" data-param="' + esc(p.name) + '">' + label + '<input id="' + id + '" value="' + esc(value) + '"' + (p.default === undefined ? ' required' : '') + ' spellcheck="false"></label>';
}

function paramValue(p) {
  const el = document.getElementById('p_' + p.name);
  if (p.type === 'boolean') return el.checked ? 'true' : 'false';
  const seg = document.querySelector('.seg[data-param="' + CSS.escape(p.name) + '"]');
  if (seg) return seg.dataset.value || '';
  return el ? el.value : '';
}

function renderParams(list, note) {
  // Keep what the user already typed when the branch (and so the YAML) changes.
  const prev = {};
  for (const p of params) if (edited[p.name] && (document.getElementById('p_' + p.name) || document.querySelector('.seg[data-param="' + CSS.escape(p.name) + '"]'))) prev[p.name] = paramValue(p);
  params = list;
  $('params').innerHTML = (note ? '<p class="run-note">' + esc(note) + '</p>' : '') +
    (list.length ? list.map(p => paramControl(p, prev[p.name])).join('') : (note ? '' : '<p class="muted">This pipeline has no runtime parameters.</p>'));
}

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'fatal') { $('fatal').textContent = m.message; show($('fatal'), true); setBusy(false); return; }
  if (m.type === 'definitions') {
    const groups = {};
    for (const d of m.items) (groups[d.folder] ||= []).push(d);
    $('definition').innerHTML = '<option value="">Select a pipeline…</option>' + Object.keys(groups).sort().map(f => {
      const opts = groups[f].map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('');
      return f ? '<optgroup label="' + esc(f) + '">' + opts + '</optgroup>' : opts;
    }).join('');
    if (current) $('definition').value = String(current.id);
    else $('definition').focus();
    return;
  }
  if (m.type === 'loadingDefinition') { $('definition').value = String(m.id); $('details').classList.add('loading'); setBusy(true); return; }
  if (m.type === 'definition') {
    current = m;
    show($('fatal'), false); show($('runError'), false);
    $('definition').value = String(m.id);
    $('subtitle').textContent = [m.folder, m.repoName, m.yamlFile].filter(Boolean).join(' · ') || m.name;
    $('branch').value = m.branch;
    $('commit').value = '';
    $('branches').innerHTML = '';
    show($('paramSection'), m.yaml);
    show($('varSection'), m.variables.length > 0);
    $('vars').innerHTML = m.variables.map(v => '<label class="run-field"><span class="run-label mono">' + esc(v.name) + (v.isSecret ? ' <span class="pill muted">secret</span>' : '') + '</span>' +
      '<input data-var="' + esc(v.name) + '" type="' + (v.isSecret ? 'password' : 'text') + '" value="' + esc(v.value) + '" placeholder="' + (v.isSecret ? 'Leave empty to keep the stored value' : '') + '" spellcheck="false"></label>').join('');
    show($('details'), true);
    $('details').classList.remove('loading');
    setBusy(false);
    return;
  }
  if (!current || m.id !== current.id) return;
  if (m.type === 'branches') $('branches').innerHTML = m.branches.map(b => '<option value="' + esc(b) + '">').join('');
  if (m.type === 'parametersLoading') $('params').innerHTML = '<div class="run-skel"></div><div class="run-skel"></div>';
  if (m.type === 'parameters') renderParams(m.params, m.note);
});
window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'runFailed') { $('runError').textContent = m.message; show($('runError'), true); setBusy(false); }
});

$('form').addEventListener('submit', e => {
  e.preventDefault();
  if (!current || !$('form').reportValidity()) return;
  const parameters = {};
  for (const p of params) {
    const v = paramValue(p);
    if (v !== '' || p.default !== undefined) parameters[p.name] = v;
  }
  const variables = {};
  document.querySelectorAll('[data-var]').forEach(el => {
    const v = current.variables.find(x => x.name === el.dataset.var);
    if (v && el.value !== v.value && !(v.isSecret && el.value === '')) variables[v.name] = el.value;
  });
  show($('runError'), false);
  setBusy(true);
  vscode.postMessage({ type: 'run', branch: $('branch').value.trim(), commit: $('commit').value.trim(), parameters, variables });
});

vscode.postMessage({ type: 'ready' });
`;

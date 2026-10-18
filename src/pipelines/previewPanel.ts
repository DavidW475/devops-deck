import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage, guarded, panelHtml } from '../util';
import { buildModel, PipelineModel } from './pipelineModel';
import { SourceRef } from './templateExpander';
import { parsePipelineParameters, parseYamlDocument, setOwn } from './yamlParameters';
import { PreviewError, YamlTemplateSupport } from './yamlTemplates';

export type PreviewMode = 'local' | 'server';

const MODE_KEY = 'pipelinePreview.mode';
const DEBOUNCE_MS = 700;

const BODY = `<div class="pv">
  <div class="pv-head">
    <div class="pv-title"><h1 id="title"></h1><div id="info" class="muted small"></div></div>
    <div class="seg" role="group" aria-label="Preview source">
      <button class="btn small" data-mode="local" title="Expand the templates here: local files and clones, unsaved changes included">Local</button>
      <button class="btn small" data-mode="server" title="Let Azure DevOps expand the pipeline with this file's content">Azure DevOps</button>
    </div>
    <button class="btn small ghost" id="refresh" title="Expand again">Refresh</button>
  </div>
  <p class="pv-hint muted small" id="hint"></p>
  <div id="params"></div>
  <div id="messages"></div>
  <div class="graph-wrap" id="graphWrap" hidden><div class="graph" id="graph"></div></div>
  <div class="jobs" id="jobs"></div>
</div>`;

/**
 * Graphical preview of what a pipeline's templates produce: stages with their dependencies, jobs and steps.
 * Two sources the user switches between: the local expander, or Azure DevOps' preview endpoint.
 */
export class PipelinePreviewPanel {
  private static readonly panels = new Map<string, PipelinePreviewPanel>();
  private static store?: vscode.Memento;
  private mode: PreviewMode;
  private params: Record<string, string> = {};
  private definitionId?: number;
  private sources: SourceRef[] = [];
  private seq = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  /** Remembers the last chosen mode across panels and sessions. */
  static useStore(store: vscode.Memento): void {
    PipelinePreviewPanel.store = store;
  }

  static show(support: YamlTemplateSupport, extensionUri: vscode.Uri, doc: vscode.TextDocument, mode?: PreviewMode): PipelinePreviewPanel {
    const key = doc.uri.toString();
    const open = PipelinePreviewPanel.panels.get(key);
    if (open) {
      open.panel.reveal();
      if (mode && mode !== open.mode) {
        open.setMode(mode);
      }
      return open;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.pipelinePreview', `Preview ${path.basename(doc.uri.path)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const stored = PipelinePreviewPanel.store?.get<PreviewMode>(MODE_KEY);
    const p = new PipelinePreviewPanel(panel, support, doc, mode ?? (stored === 'server' ? 'server' : 'local'));
    PipelinePreviewPanel.panels.set(key, p);
    panel.onDidDispose(() => p.dispose(key));
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Pipeline preview', BODY, '', 'pipelinePreview.js');
    return p;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly support: YamlTemplateSupport,
    private doc: vscode.TextDocument, mode: PreviewMode) {
    this.mode = mode;
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        // Local previews follow every edit, also in the templates; server previews only follow saves.
        const yaml = e.document.languageId === 'yaml' || e.document.languageId === 'azure-pipelines';
        if (this.mode === 'local' && (e.document.uri.toString() === this.doc.uri.toString() || yaml)) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(d => {
        if (this.mode === 'server' && d.uri.toString() === this.doc.uri.toString()) {
          this.schedule();
        }
      }),
    );
  }

  private dispose(key: string): void {
    this.disposed = true;
    clearTimeout(this.timer);
    PipelinePreviewPanel.panels.delete(key);
    this.disposables.forEach(d => d.dispose());
  }

  private post(m: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(m);
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.render(), DEBOUNCE_MS);
  }

  private setMode(mode: PreviewMode): void {
    this.mode = mode;
    void PipelinePreviewPanel.store?.update(MODE_KEY, mode);
    void this.render();
  }

  private async handle(m: any): Promise<void> {
    switch (m?.type) {
      case 'ready':
      case 'refresh':
        await this.render();
        return;
      case 'mode':
        if (m.mode === 'local' || m.mode === 'server') {
          this.setMode(m.mode);
        }
        return;
      case 'param':
        if (typeof m.name === 'string' && parsePipelineParameters((await this.current()).getText()).some(p => p.name === m.name)) {
          setOwn(this.params, m.name, String(m.value ?? ''));
          await this.render();
        }
        return;
      case 'resetParams':
        this.params = {};
        await this.render();
        return;
      case 'pipeline':
        this.definitionId = undefined;
        await this.render();
        return;
      case 'open':
        await this.open(Number(m.source));
        return;
    }
  }

  /** Opens the template file of a stage, job or step at its line (only sources this panel sent, by index). */
  private async open(index: number): Promise<void> {
    const s = Number.isInteger(index) ? this.sources[index] : undefined;
    if (!s) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(s.uri));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(s.line, 0, s.line, 0) });
  }

  /**
   * The previewed document. Once its editor is closed, the old instance keeps its last text, and reopening the file
   * creates a new one: a closed document is opened again, which returns the reopened instance or reads the file.
   */
  private async current(): Promise<vscode.TextDocument> {
    if (this.doc.isClosed && this.doc.uri.scheme !== 'untitled') {
      this.doc = await vscode.workspace.openTextDocument(this.doc.uri);
    }
    return this.doc;
  }

  private parameterView() {
    return parsePipelineParameters(this.doc.getText()).map(p => {
      const changed = Object.hasOwn(this.params, p.name);
      return {
        name: p.name, displayName: p.displayName, type: p.type, values: p.values, default: p.default,
        value: changed ? this.params[p.name] : p.default ?? '', changed,
      };
    });
  }

  async render(): Promise<void> {
    const seq = ++this.seq;
    await this.current().catch(() => undefined); // deleted file: keep showing the last text
    const base = { mode: this.mode, title: path.basename(this.doc.uri.path), params: this.parameterView() };
    this.post({ type: 'busy', ...base });
    try {
      const result = this.mode === 'local' ? await this.local() : await this.server();
      if (seq !== this.seq) {
        return;
      }
      this.sources = result.model.sources;
      const sources = result.model.sources.map(s => ({ label: s.label, line: s.line + 1 }));
      this.post({ type: 'model', ...base, model: { ...result.model, sources }, info: result.info, warnings: result.warnings });
    } catch (e) {
      if (seq === this.seq) {
        this.post({ type: 'error', ...base, message: e instanceof PreviewError ? e.message : errorMessage(e) });
      }
    }
  }

  private async local(): Promise<{ model: PipelineModel; info: string; warnings: string[] }> {
    const res = await this.support.expandLocally(this.doc, this.params);
    const model = buildModel(res.doc, res.sourceOf);
    return { model, info: `Expanded locally from ${res.files + 1} ${res.files ? 'files' : 'file'}`, warnings: res.warnings };
  }

  private async server(): Promise<{ model: PipelineModel; info: string; warnings: string[] }> {
    const res = await this.support.expandOnServer(this.doc, this.params, this.definitionId);
    if (!res) {
      throw new PreviewError('No pipeline selected. Choose Refresh to pick the pipeline to expand this file as.', 'info');
    }
    this.definitionId = res.definition.id;
    const doc = parseYamlDocument(res.yaml);
    const model = buildModel(doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {});
    return { model, info: `Expanded by Azure DevOps as "${res.definition.name}" at ${res.branch}`, warnings: [] };
  }
}

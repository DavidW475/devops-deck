/**
 * Pipeline designer: a form for the `template:` / `extends:` calls of a pipeline. Picks templates from a catalog of a
 * template repository (at a tag or branch), fills their parameters, inserts or updates the call with targeted line
 * edits (`WorkspaceEdit`: undo/redo and dirty state stay native) and validates the result with the server preview.
 * Always works on the open document's current text, unsaved changes included.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { errorMessage, guarded, panelHtml, plural } from '../util';
import {
  catalogItems, excerpt, fullPreview, ParamView, paramViews, refLabel, refOptions, RefOption, structure, targetPathIn, templatePathFor, topLevelBlock,
  unknownParams,
} from './designerModel';
import { asTree, defaultText, treeIssue, TreeNode, treeText } from './objectParams';
import { buildModel } from './pipelineModel';
import {
  applyLineEdits, callReadOnlyReason, controlOf, findInsertionPoints, indentUnit, InsertionPoint, isBranchRef, LineEdit, LineMark, newCallLines,
  planCallEdits, planRepositoryEdits, templateKind, TemplateKind, toRangeEdits,
} from './templateEdits';
import { findTemplateRefs, parseRepositories, RepoResource, TemplateRef } from './templateRefs';
import { Catalog, CatalogEntry, locationLabel, Origin, TemplateContext, TemplateResolver } from './templateResolver';
import { parseYamlDocument, PipelineParameter, setOwn } from './yamlParameters';
import { PreviewError, sameFile, ServerPreview } from './yamlTemplates';

/** What the designer needs from the rest of the extension (narrow, so tests can fake it). */
export interface DesignerHost {
  resolver: Pick<TemplateResolver, 'contextFor' | 'resolve' | 'catalog' | 'refsOf' | 'originOf'>;
  expandOnServer(doc: vscode.TextDocument, params?: Record<string, string>, definitionId?: number, text?: string): Promise<ServerPreview | undefined>;
  client: Pick<AdoClient, 'listRepositories'>;
}

type Selection = { kind: 'call'; line: number; raw: string } | { kind: 'new'; path: string } | undefined;

interface Notice {
  level: 'info' | 'ok' | 'warn' | 'error';
  title: string;
  detail?: string;
}

interface Validation extends Notice {
  state: 'idle' | 'running' | 'ok' | 'error';
  problems: { label: string; line?: number }[];
}

interface CallModel {
  isNew: boolean;
  ref?: TemplateRef;
  index?: number;
  title: string;
  declared: PipelineParameter[];
  kind?: TemplateKind;
  error?: string;
  readOnly?: string;
  points: InsertionPoint[];
  point?: InsertionPoint;
  /** `template:` value of a new call */
  templatePath?: string;
}

interface RepoChoice {
  alias: string;
  resource?: RepoResource;
}

/** Everything one render or apply needs, computed from the document's current text. */
interface Computed {
  doc: vscode.TextDocument;
  text: string;
  version: number;
  refs: TemplateRef[];
  ctx?: TemplateContext;
  repos: RepoChoice[];
  repo: RepoChoice;
  ref?: string;
  call?: CallModel;
  edits: LineEdit[];
  newText: string;
  marks: Map<number, LineMark>;
  blocking?: string;
}

const DEBOUNCE_MS = 300;
const ALIAS = /^[A-Za-z_]\w*$/;

const BODY = '<div class="pd" id="app"><div class="loading"><div class="spinner"></div></div></div>';

const IDLE: Validation = {
  state: 'idle', level: 'info', title: 'Not validated yet',
  detail: 'Validate sends the pipeline with the pending changes to Azure DevOps as a preview run: the server expands the templates and returns the result or its errors.',
  problems: [],
};

export class PipelineDesignerPanel {
  private static readonly panels = new Map<string, PipelineDesignerPanel>();
  private selection: Selection;
  private pending: Record<string, string> = {};
  /** last form tree per object parameter: keeps empty and duplicate keys visible that the YAML text can't hold */
  private trees = new Map<string, TreeNode>();
  private writeDefaults = false;
  private alias = '';
  /** chosen ref of the catalog repository: undefined = as declared, '' = default branch */
  private refChoice?: string;
  private target?: number;
  private validation: Validation = IDLE;
  private notice?: Notice;
  private definitionId?: number;
  private catalogKey = '';
  private catalog?: { loading: boolean; error?: string; value?: Catalog };
  private readonly refs = new Map<string, { loading: boolean; options: RefOption[]; error?: string }>();
  /** repository path of the designed pipeline (for `self` templates) */
  private pipelinePath = '/';
  private seq = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  /** Opens the designer for a local pipeline file; `line` selects the call there. */
  static show(host: DesignerHost, extensionUri: vscode.Uri, doc: vscode.TextDocument, line?: number): PipelineDesignerPanel | undefined {
    if (doc.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('The pipeline designer edits local YAML files: open the pipeline from the workspace.');
      return undefined;
    }
    const key = doc.uri.toString();
    const open = PipelineDesignerPanel.panels.get(key);
    if (open) {
      open.panel.reveal();
      if (line !== undefined) {
        open.selectLine(line);
        void open.render();
      }
      return open;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.pipelineDesigner', `Designer ${path.basename(doc.uri.path)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const p = new PipelineDesignerPanel(panel, host, doc);
    PipelineDesignerPanel.panels.set(key, p);
    panel.onDidDispose(() => {
      PipelineDesignerPanel.panels.delete(key);
      p.disposables.forEach(d => d.dispose());
    });
    p.selectLine(line ?? 0);
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Pipeline designer', BODY, '', 'pipelineDesigner.js');
    return p;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly host: DesignerHost, private doc: vscode.TextDocument) {
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
    this.disposables.push(
      // Edits in the editor (or undo of an applied change) re-read the calls after a short pause.
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() === this.doc.uri.toString()) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.render(), DEBOUNCE_MS);
        }
      }),
      { dispose: () => { this.disposed = true; clearTimeout(this.timer); } },
    );
  }

  /** Sends a message to the page unless the panel was closed. */
  private send(type: 'state' | 'validation', body: object): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type, ...body });
    }
  }

  /** Selects the call whose mapping contains `line` (the nearest call above it, else the first one). */
  private selectLine(line: number): void {
    const refs = findTemplateRefs(this.doc.getText());
    const hit = refs.find(r => r.line <= line && line <= r.end) ?? refs.filter(r => r.line <= line).at(-1) ?? refs[0];
    this.select(hit ? { kind: 'call', line: hit.line, raw: hit.raw } : undefined);
  }

  private select(selection: Selection): void {
    this.selection = selection;
    this.pending = {};
    this.trees.clear();
    this.target = undefined;
    this.validation = IDLE;
    this.notice = undefined;
  }

  // ----- messages from the page -----

  private async handle(m: any): Promise<void> {
    const handlers: Record<string, (m: any) => unknown> = {
      ready: () => undefined,
      select: x => this.onSelect(x.index),
      pick: x => this.onPick(x.path),
      repo: x => this.onRepo(x.alias),
      ref: x => this.onRef(x.ref),
      value: x => this.onValue(x.name, x.value, x.tree),
      writeDefaults: x => { this.writeDefaults = x.on === true; },
      target: x => { this.target = Number.isInteger(x.index) ? x.index : undefined; },
      reset: () => this.onReset(),
      apply: () => this.apply(),
      validate: () => this.validate(),
      open: x => this.openLine(x.line),
      addRepo: () => this.addRepository(),
      reloadCatalog: () => { this.catalogKey = ''; },
    };
    const fn = typeof m?.type === 'string' && Object.hasOwn(handlers, m.type) ? handlers[m.type] : undefined;
    if (!fn) {
      return;
    }
    if ((await fn(m)) !== false) {
      await this.render();
    }
  }

  private onSelect(index: unknown): boolean {
    const ref = typeof index === 'number' ? findTemplateRefs(this.doc.getText())[index] : undefined;
    if (!ref) {
      return false;
    }
    this.select({ kind: 'call', line: ref.line, raw: ref.raw });
    return true;
  }

  private onPick(file: unknown): boolean {
    const entry = typeof file === 'string' ? this.catalog?.value?.entries.find(e => e.path === file) : undefined;
    if (!entry) {
      return false;
    }
    const used = this.usedCall(entry.path);
    this.select(used ? { kind: 'call', line: used.line, raw: used.raw } : { kind: 'new', path: entry.path });
    return true;
  }

  /** The first call of the document that points to this catalog file, if any. */
  private usedCall(file: string): TemplateRef | undefined {
    const pipelinePath = this.pipelinePath;
    return findTemplateRefs(this.doc.getText()).find(r => targetPathIn(r.target, this.alias, pipelinePath)?.toLowerCase() === file.toLowerCase());
  }

  private onRepo(alias: unknown): boolean {
    const known = typeof alias === 'string' && (alias === 'self' || parseRepositories(this.doc.getText()).some(r => r.alias === alias));
    if (!known || alias === this.alias) {
      return false;
    }
    this.alias = alias;
    this.refChoice = undefined;
    if (this.selection?.kind === 'new') {
      this.select(undefined);
    }
    return true;
  }

  private onRef(ref: unknown): boolean {
    const options = this.refs.get(this.alias)?.options ?? [];
    if (ref !== '' && !options.some(o => o.name === ref)) {
      return false;
    }
    this.refChoice = ref as string;
    this.validation = IDLE;
    return true;
  }

  private onValue(name: unknown, value: unknown, tree: unknown): boolean {
    const node = tree === undefined ? undefined : asTree(tree);
    if (typeof name !== 'string' || (node === undefined && typeof value !== 'string' && typeof value !== 'boolean')) {
      return false;
    }
    if (node) {
      this.trees.set(name, node);
      setOwn(this.pending, name, treeText(node, indentUnit(this.doc.getText())));
    } else {
      this.trees.delete(name);
      setOwn(this.pending, name, String(value));
    }
    this.validation = IDLE;
    this.notice = undefined;
    return true;
  }

  /** Every parameter back to its default: lines are removed, or written explicitly with "Write defaults". */
  private async onReset(): Promise<void> {
    const c = await this.compute();
    this.pending = {};
    this.trees.clear();
    const unit = indentUnit(c.text);
    for (const p of c.call?.declared ?? []) {
      const value = controlOf(p) === 'raw' ? defaultText(p, unit) : p.default;
      if (value !== undefined) {
        setOwn(this.pending, p.name, value);
      }
    }
    this.validation = IDLE;
  }

  private async openLine(line: unknown): Promise<false> {
    const doc = await this.current();
    if (typeof line === 'number' && Number.isInteger(line) && line >= 0 && line < doc.lineCount) {
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(line, 0, line, 0) });
    }
    return false;
  }

  // ----- computing the state -----

  /** The designed document; a closed one is opened again (the old instance keeps stale text). */
  private async current(): Promise<vscode.TextDocument> {
    if (this.doc.isClosed) {
      this.doc = await vscode.workspace.openTextDocument(this.doc.uri);
    }
    return this.doc;
  }

  private repoChoices(text: string): RepoChoice[] {
    return [{ alias: 'self' }, ...parseRepositories(text).map(r => ({ alias: r.alias, resource: r }))];
  }

  /** Default catalog repository: the alias of the selected call, else the first declared Azure Repos resource, else self. */
  private defaultAlias(repos: RepoChoice[], refs: TemplateRef[]): string {
    const selected = this.selection?.kind === 'call' ? this.findRef(refs) : undefined;
    const fromCall = selected?.target?.alias;
    if (fromCall && repos.some(r => r.alias === fromCall)) {
      return fromCall;
    }
    return repos.find(r => r.resource?.type === 'git')?.alias ?? 'self';
  }

  private findRef(refs: TemplateRef[]): TemplateRef | undefined {
    const s = this.selection;
    if (s?.kind !== 'call') {
      return undefined;
    }
    const same = refs.filter(r => r.raw === s.raw);
    return same.toSorted((a, b) => Math.abs(a.line - s.line) - Math.abs(b.line - s.line))[0];
  }

  private async compute(): Promise<Computed> {
    const doc = await this.current().catch(() => this.doc);
    const text = doc.getText();
    const refs = findTemplateRefs(text);
    const ctx = await this.host.resolver.contextFor(doc.uri, text).catch(() => undefined);
    this.pipelinePath = ctx?.location.path ?? '/';
    const repos = this.repoChoices(text);
    if (!repos.some(r => r.alias === this.alias)) {
      this.alias = this.defaultAlias(repos, refs);
      this.refChoice = undefined;
    }
    const repo = repos.find(r => r.alias === this.alias) ?? repos[0];
    const ref = this.refChoice === undefined ? repo.resource?.ref : this.refChoice || undefined;
    const call = await this.callModel(text, refs, ctx);
    const edits = this.plan(text, call, repo);
    const applied = applyLineEdits(text, edits);
    const firstError = call && this.paramRows(text, call).find(p => p.error);
    const blocking = call?.error ?? call?.readOnly ?? (firstError ? `${firstError.label}: ${firstError.error}` : undefined);
    return { doc, text, version: doc.version, refs, ctx, repos, repo, ref, call, edits, newText: applied.text, marks: applied.marks, blocking };
  }

  private async callModel(text: string, refs: TemplateRef[], ctx: TemplateContext | undefined): Promise<CallModel | undefined> {
    const s = this.selection;
    if (s?.kind === 'new') {
      const entry = this.catalog?.value?.entries.find(e => e.path === s.path);
      return entry ? this.newCallModel(text, entry) : undefined;
    }
    const ref = this.findRef(refs);
    if (!ref) {
      return undefined;
    }
    const model: CallModel = {
      isNew: false, ref, index: refs.indexOf(ref), title: ref.target ? refLabel(ref) : ref.raw || '(empty)', declared: [], points: [],
      readOnly: callReadOnlyReason(text, ref),
    };
    if (ref.target && ctx) {
      try {
        const resolved = await this.host.resolver.resolve(ctx, ref.target);
        model.declared = resolved.parameters;
        model.kind = templateKind(resolved.text);
        model.title = resolved.label;
      } catch (e) {
        model.error = errorMessage(e);
      }
    } else if (ref.target) {
      model.error = 'The pipeline file could not be located.';
    }
    return model;
  }

  private newCallModel(text: string, entry: CatalogEntry): CallModel {
    const kind = entry.kind ?? 'steps';
    const points = findInsertionPoints(text, kind);
    const point = points[this.target ?? points.length - 1] ?? points.at(-1);
    return {
      isNew: true, title: entry.path.replace(/^\//, ''), declared: entry.parameters, kind: entry.kind, points, point,
      templatePath: templatePathFor(entry.path, this.alias, this.pipelinePath),
      readOnly: point ? undefined : `The pipeline has no ${kind}: list to add this ${kind} template to.`,
    };
  }

  /** Edits for the selected call plus a changed `ref:` of the catalog repository. */
  private plan(text: string, call: CallModel | undefined, repo: RepoChoice): LineEdit[] {
    const opts = { writeDefaults: this.writeDefaults };
    const edits: LineEdit[] = [];
    if (call?.ref && !call.error) {
      edits.push(...planCallEdits(text, call.ref, call.declared, this.pending, opts).edits);
    } else if (call?.isNew && call.point && call.templatePath) {
      const lines = newCallLines(call.templatePath, call.declared, this.pending, call.point.indent, indentUnit(text), opts);
      edits.push({ line: call.point.line, deleteCount: 0, insert: lines });
    }
    const declared = repo.resource?.ref;
    if (repo.resource && this.refChoice !== undefined && (this.refChoice || undefined) !== declared) {
      edits.push(...planRepositoryEdits(text, { ...repo.resource, ref: this.refChoice || undefined }));
    }
    return edits;
  }

  // ----- rendering -----

  async render(): Promise<void> {
    const seq = ++this.seq;
    const c = await this.compute();
    if (seq !== this.seq || this.disposed) {
      return;
    }
    this.send('state', this.view(c));
    this.loadCatalog(c);
    this.loadRefs(c.repo);
  }

  /** Form rows; an object parameter edited in the form shows the form's tree (and its empty or duplicate keys as errors). */
  private paramRows(text: string, call: CallModel): ParamView[] {
    const unit = indentUnit(text);
    return paramViews(text, call.declared, call.ref, this.pending, call.readOnly).map(p => {
      const tree = this.trees.get(p.name);
      if (!tree || p.readOnly || treeText(tree, unit) !== p.value) {
        return p;
      }
      return { ...p, tree, error: p.error ?? treeIssue(tree) };
    });
  }

  private view(c: Computed) {
    const call = c.call;
    const params = call ? this.paramRows(c.text, call) : [];
    const removed = c.edits.reduce((n, e) => n + Math.max(0, e.deleteCount - e.insert.length), 0);
    const marks = [...c.marks.values()];
    return {
      title: path.basename(c.doc.uri.path),
      repos: c.repos.map(r => ({ alias: r.alias, label: r.resource ? `${r.alias} · ${r.resource.name}` : 'self · this repository' })),
      repo: this.repoView(c),
      catalog: this.catalogView(c),
      structure: structure(c.text, c.refs, call?.index, call?.isNew ? { label: path.posix.basename(call.title), stage: call.point?.stage } : undefined),
      call: call && {
        isNew: call.isNew, title: call.title, kind: call.kind, error: call.error, readOnly: call.readOnly, line: call.ref?.line,
        status: callStatus(call), params: call.error ? [] : params, unknown: unknownParams(call.ref, call.declared),
        points: call.points.map(p => p.label), point: call.point ? call.points.indexOf(call.point) : -1,
        applyLabel: call.isNew ? 'Insert into pipeline' : 'Update in pipeline', blocking: c.blocking,
      },
      empty: !call && !c.refs.length,
      writeDefaults: this.writeDefaults,
      preview: {
        lines: excerpt(c.newText, c.marks, this.focus(c)),
        full: fullPreview(c.newText, c.marks),
        added: marks.filter(m => m === '+').length, changed: marks.filter(m => m === '~').length, removed,
      },
      validation: this.validation,
      notices: this.notices(c),
    };
  }

  private repoView(c: Computed) {
    const r = c.repo.resource;
    const refs = this.refs.get(c.repo.alias);
    let source = 'Templates of the pipeline’s own repository';
    try {
      source = r ? describeOrigin(this.host.resolver.originOf({ ...r, ref: c.ref })) : source;
    } catch (e) {
      source = errorMessage(e);
    }
    return {
      alias: c.repo.alias, name: r?.name, type: r?.type, ref: c.ref ?? '', declaredRef: r?.ref ?? '', refChanged: this.refChoice !== undefined && (this.refChoice || undefined) !== r?.ref,
      refs: refs?.options ?? [], refsLoading: !!refs?.loading, refsError: refs?.error, source, canPickRef: r?.type === 'git',
    };
  }

  private catalogView(c: Computed) {
    const used = new Set(c.refs.map(r => targetPathIn(r.target, c.repo.alias, this.pipelinePath)?.toLowerCase()).filter((p): p is string => !!p));
    const selected = this.selection?.kind === 'new' ? this.selection.path : c.call?.ref && targetPathIn(c.call.ref.target, c.repo.alias, this.pipelinePath);
    return {
      loading: this.catalog?.loading ?? true, error: this.catalog?.error, truncated: !!this.catalog?.value?.truncated,
      items: catalogItems(this.catalog?.value?.entries ?? [], used, selected),
    };
  }

  /** Lines the preview always shows: the resources block and the selected call (in the new text). */
  private focus(c: Computed): [number, number][] {
    const out: [number, number][] = [];
    const resources = topLevelBlock(c.newText, 'resources');
    if (resources) {
      out.push(resources);
    }
    const newRefs = findTemplateRefs(c.newText);
    const call = c.call;
    let ref: TemplateRef | undefined;
    if (call?.isNew && call.point) {
      const head = newCallLines(call.templatePath ?? '', [], {}, call.point.indent, 2, { writeDefaults: false })[0];
      ref = newRefs.find(r => c.marks.get(r.line) === '+' && c.newText.split(/\r?\n/)[r.line] === head);
    } else if (call?.index !== undefined) {
      ref = newRefs[call.index];
    }
    if (ref) {
      out.push([ref.line, ref.end]);
    }
    return out;
  }

  private notices(c: Computed): Notice[] {
    const out: Notice[] = [];
    if (this.notice) {
      out.push(this.notice);
    }
    const r = c.repo.resource;
    if (r?.type === 'git' && isBranchRef(c.ref)) {
      const where = c.ref ? `the branch ${c.ref.replace(/^refs\/heads\//, '')}` : 'the default branch (no ref)';
      out.push({
        level: 'warn', title: `ref of ${r.alias} points to ${where}`,
        detail: 'Changes in the template repository take effect on this pipeline immediately. Pin a tag for reproducible builds.',
      });
    }
    return out;
  }

  // ----- catalog and refs -----

  private catalogOrigin(c: Computed): Origin | undefined {
    if (!c.repo.resource) {
      return c.ctx?.self;
    }
    return this.host.resolver.originOf({ ...c.repo.resource, ref: c.ref });
  }

  /** Loads the catalog of the chosen repository and ref when they changed; renders again when it arrives. */
  private loadCatalog(c: Computed): void {
    const key = `${c.repo.alias}@${c.ref ?? ''}`;
    if (key === this.catalogKey) {
      return;
    }
    const force = this.catalogKey === '' && !!this.catalog;
    this.catalogKey = key;
    let origin: Origin | undefined;
    try {
      origin = this.catalogOrigin(c);
    } catch (e) {
      this.catalog = { loading: false, error: errorMessage(e) };
      void this.render();
      return;
    }
    if (!origin) {
      this.catalog = { loading: false, error: 'The pipeline file could not be located.' };
      void this.render();
      return;
    }
    this.catalog = { loading: true };
    this.host.resolver.catalog(origin, force).then(
      value => { this.catalog = { loading: false, value }; },
      e => { this.catalog = { loading: false, error: errorMessage(e) }; },
    ).finally(() => {
      if (this.catalogKey === key) {
        void this.render();
      }
    });
  }

  private loadRefs(repo: RepoChoice): void {
    const r = repo.resource;
    if (!r || r.type !== 'git' || this.refs.has(repo.alias)) {
      return;
    }
    this.refs.set(repo.alias, { loading: true, options: refOptions({ tags: [], branches: [] }, r.ref) });
    this.host.resolver.refsOf(r).then(
      found => this.refs.set(repo.alias, { loading: false, options: refOptions(found, r.ref) }),
      e => this.refs.set(repo.alias, { loading: false, options: refOptions({ tags: [], branches: [] }, r.ref), error: errorMessage(e) }),
    ).finally(() => void this.render());
  }

  // ----- actions -----

  /** Writes the pending changes into the document (not saved: the editor shows it dirty, undo works as usual). */
  private async apply(): Promise<void> {
    const c = await this.compute();
    if (c.blocking) {
      this.notice = { level: 'error', title: 'Not applied', detail: c.blocking };
      return;
    }
    if (!c.edits.length) {
      this.notice = { level: 'info', title: 'Nothing to change', detail: 'The file already matches the form.' };
      return;
    }
    if (c.doc.version !== c.version) {
      this.notice = { level: 'warn', title: 'The file changed', detail: 'Check the form and apply again.' };
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const r of toRangeEdits(c.text, c.edits)) {
      edit.replace(c.doc.uri, new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar), r.text);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      this.notice = { level: 'error', title: 'Not applied', detail: 'VS Code rejected the edit (is the file read-only?).' };
      return;
    }
    const file = path.basename(c.doc.uri.path);
    const what = c.call?.isNew ? 'Inserted' : 'Updated';
    const target = c.call?.isNew ? this.newRefAfterApply(c) : c.call?.ref && findTemplateRefs(c.newText)[c.call.index ?? -1];
    this.select(target ? { kind: 'call', line: target.line, raw: target.raw } : this.selection);
    this.refChoice = undefined;
    this.notice = c.call
      ? { level: 'ok', title: `${what} the call of ${c.call.title}`, detail: `${file} has unsaved changes: save it to keep them (undo works as usual).` }
      : { level: 'ok', title: 'Updated the repository resource', detail: `${file} has unsaved changes.` };
  }

  private newRefAfterApply(c: Computed): TemplateRef | undefined {
    const lines = c.newText.split(/\r?\n/);
    return findTemplateRefs(c.newText).find(r => c.marks.get(r.line) === '+' && lines[r.line].includes(c.call?.templatePath ?? '\0'));
  }

  /** Expands the pipeline with the pending changes on Azure DevOps (preview run with `yamlOverride`). */
  private async validate(): Promise<void> {
    const c = await this.compute();
    this.validation = { state: 'running', level: 'warn', title: 'Validating with Azure DevOps …', detail: 'Preview run with the pending changes as yamlOverride', problems: [] };
    this.send('validation', { validation: this.validation });
    try {
      const res = await this.host.expandOnServer(c.doc, undefined, this.definitionId, c.newText);
      if (!res) {
        this.validation = { ...IDLE, title: 'No pipeline selected', detail: 'Validate again to pick the pipeline to expand this file as.' };
        return;
      }
      this.definitionId = res.definition.id;
      const parsed = parseYamlDocument(res.yaml);
      const counts = buildModel(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}).counts;
      this.validation = {
        state: 'ok', level: 'ok', title: 'Pipeline is valid', problems: [],
        detail: `Expanded by Azure DevOps as "${res.definition.name}" at ${res.branch}: ${plural(counts.stages, 'stage')}, ${plural(counts.jobs, 'job')}, ${plural(counts.steps, 'step')}.`,
      };
    } catch (e) {
      const problems = e instanceof PreviewError ? e.problems : [];
      const pipelinePath = this.pipelinePath;
      const unchanged = c.newText === c.text;
      this.validation = {
        state: 'error', level: 'error', title: 'Validation failed', detail: errorMessage(e),
        problems: problems.map(p => ({
          label: `${p.file} (line ${p.line}): ${p.text}`, line: unchanged && sameFile(p.file, pipelinePath) ? p.line - 1 : undefined,
        })),
      };
    }
  }

  /** Declares another Azure Repos repository of the project as a repository resource. */
  private async addRepository(): Promise<void> {
    const repos = await this.host.client.listRepositories();
    const pick = await vscode.window.showQuickPick(repos.map(r => ({ label: r.name, description: r.defaultBranch?.replace(/^refs\/heads\//, ''), r })), {
      title: 'Template repository', placeHolder: 'Repository with the templates',
    });
    if (!pick) {
      return;
    }
    const text = (await this.current()).getText();
    const taken = new Set(['self', ...parseRepositories(text).map(r => r.alias)]);
    const suggested = pick.r.name.replaceAll(/\W/g, '_').replace(/^(\d)/, '_$1');
    const alias = await vscode.window.showInputBox({
      title: 'Alias of the repository resource', value: taken.has(suggested) ? `${suggested}_2` : suggested,
      prompt: 'Templates are referenced as path@alias.',
      validateInput: v => {
        if (!ALIAS.test(v)) {
          return 'Letters, digits and _; must not start with a digit.';
        }
        return taken.has(v) ? `'${v}' is already used.` : undefined;
      },
    });
    if (!alias || !ALIAS.test(alias) || taken.has(alias)) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const r of toRangeEdits(text, planRepositoryEdits(text, { alias, name: pick.r.name, type: 'git' }))) {
      edit.replace(this.doc.uri, new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar), r.text);
    }
    if (await vscode.workspace.applyEdit(edit)) {
      this.alias = alias;
      this.refChoice = undefined;
      this.notice = { level: 'ok', title: `Added the repository resource ${alias}`, detail: 'Pick a tag as ref for reproducible builds.' };
    }
  }
}

function describeOrigin(o: Origin): string {
  return locationLabel({ origin: o, path: '/' }).replace(/^ · /, '');
}

function callStatus(call: CallModel): string {
  if (call.isNew) {
    return call.point ? `New: goes to ${call.point.label}` : 'New: no place to insert it';
  }
  const kind = call.ref?.kind === 'extends' ? 'extends' : 'template';
  return call.ref ? `${kind} · line ${call.ref.line + 1}` : kind;
}

/** "Open in Designer" above every `template:` / `extends:` call of local YAML files (setting `azureDevOps.yaml.designerCodeLens`). */
export class DesignerCodeLens implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== 'file' || !vscode.workspace.getConfiguration('azureDevOps').get<boolean>('yaml.designerCodeLens', true)) {
      return [];
    }
    return findTemplateRefs(doc.getText()).map(ref => new vscode.CodeLens(new vscode.Range(ref.line, 0, ref.line, 0), {
      title: 'Open in Designer', tooltip: 'Edit the parameters of this template call in a form', command: 'azureDevOps.yaml.openDesigner', arguments: [doc.uri, ref.line],
    }));
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

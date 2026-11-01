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
  catalogItems, excerpt, fullPreview, ParamView, paramViews, itemAt, refLabel, refOptions, RefOption, structure, targetPathIn, templatePathFor,
  topLevelBlock, unknownParams,
} from './designerModel';
import { asTree, defaultText, treeIssue, TreeNode, treeText } from './objectParams';
import { buildModel } from './pipelineModel';
import { CatalogSnapshot, TaskInfo, TaskIndex, TaskStepRef } from './taskModel';
import { buildTaskForm, orgLabel, planNewTask, planTaskStep, TaskForm, taskListState, taskSummary } from './taskDesigner';
import { asTemplateRef, findDisplayName, findTaskSteps } from './taskRefs';
import {
  applyLineEdits, callReadOnlyReason, controlOf, findInsertionPoints, indentUnit, InsertionPoint, isBranchRef, LineEdit, LineMark, newCallLines,
  newTaskLines, planCallEdits, planRepositoryEdits, templateKind, TemplateKind, toRangeEdits,
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
  /** The task catalog of the organization; without it (or with `azureDevOps.yaml.taskSupport` off) the designer has no task features. */
  tasks?: TaskSource;
  /** URL of the connected organization, for the catalog footer. */
  orgUrl?(): string | undefined;
}

/** What the designer needs from `TaskCatalog`. */
export interface TaskSource {
  readonly onDidChange: vscode.Event<void>;
  snapshot(): CatalogSnapshot;
  ensure(): Promise<CatalogSnapshot>;
  refresh(): Promise<CatalogSnapshot>;
}

type Selection =
  | { kind: 'call'; line: number; raw: string }
  | { kind: 'new'; path: string }
  | { kind: 'task'; line: number; raw: string }
  | { kind: 'newTask'; id: string; major: number }
  | undefined;

type CatalogMode = 'templates' | 'tasks';

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
  /** set for a task step (existing or new): `ref` is then the step as a template reference */
  task?: TaskModel;
}

/** A task step in the form: the step (existing ones), its definition and the form rows. */
interface TaskModel {
  step?: TaskStepRef;
  stepIndex?: number;
  info?: TaskInfo;
  index?: TaskIndex;
  form?: TaskForm;
  /** `Name@Major` as shown, also when there is no definition */
  label: string;
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
  taskSteps: TaskStepRef[];
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
  private readonly trees = new Map<string, TreeNode>();
  private writeDefaults = false;
  /** per panel: what the catalog lists */
  private catalogMode: CatalogMode = 'templates';
  /** pending major of the selected task step (undefined = as in the file) */
  private taskMajor?: number;
  /** pending `displayName` of the selected or new task step (undefined = untouched) */
  private displayName?: string;
  private tasksRequested = false;
  private tasksRefreshing = false;
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
          this.schedule();
        }
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('azureDevOps.yaml')) {
          this.schedule();
        }
      }),
      { dispose: () => { this.disposed = true; clearTimeout(this.timer); } },
    );
    const tasks = host.tasks?.onDidChange(() => this.schedule());
    if (tasks) {
      this.disposables.push(tasks);
    }
  }

  /** Renders again after a short pause (edits, settings and catalog changes arrive in bursts). */
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.render(), DEBOUNCE_MS);
  }

  /** Sends a message to the page unless the panel was closed. */
  private send(type: 'state' | 'validation', body: object): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type, ...body });
    }
  }

  /** Selects the call whose mapping contains `line` (the nearest call above it, else the first one). */
  private selectLine(line: number): void {
    const text = this.doc.getText();
    const refs = findTemplateRefs(text);
    const steps = this.taskSupport() ? findTaskSteps(text) : [];
    const at = itemAt(refs.map(r => ({ line: r.line, last: r.end })), steps.map(t => ({ line: t.line, last: t.end - 1 })), line);
    const ref = at?.kind === 'call' ? refs[at.index] : undefined;
    const step = at?.kind === 'task' ? steps[at.index] : undefined;
    if (ref) {
      this.select({ kind: 'call', line: ref.line, raw: ref.raw });
    } else {
      this.select(step ? { kind: 'task', line: step.line, raw: step.raw } : undefined);
    }
  }

  /** Task features are on: a task catalog is there and the setting is not off. */
  private taskSupport(): boolean {
    return !!this.host.tasks && this.setting('taskSupport');
  }

  private setting(key: string): boolean {
    return vscode.workspace.getConfiguration('azureDevOps').get<boolean>(`yaml.${key}`, true);
  }

  private select(selection: Selection): void {
    this.selection = selection;
    this.taskMajor = undefined;
    this.displayName = undefined;
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
      catalogMode: x => this.onCatalogMode(x.mode),
      pickTask: x => this.onPickTask(x.id, x.major),
      selectTask: x => this.onSelectTask(x.index),
      taskVersion: x => this.onTaskVersion(x.major),
      taskField: x => this.onTaskField(x.name, x.value),
      reloadTasks: () => this.onReloadTasks(),
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

  private onCatalogMode(mode: unknown): boolean {
    if ((mode !== 'templates' && mode !== 'tasks') || (mode === 'tasks' && !this.taskSupport()) || mode === this.catalogMode) {
      return false;
    }
    this.catalogMode = mode;
    return true;
  }

  /** A task of the catalog (id and major must be in it) becomes a new step; a picked task keeps the chosen target list. */
  private onPickTask(id: unknown, major: unknown): boolean {
    const index = this.taskSupport() ? this.host.tasks?.snapshot().index : undefined;
    if (typeof id !== 'string' || typeof major !== 'number' || !index?.all().some(t => t.id === id && t.major === major)) {
      return false;
    }
    const target = this.selection?.kind === 'newTask' ? this.target : undefined;
    this.select({ kind: 'newTask', id, major });
    this.target = target;
    return true;
  }

  private onSelectTask(index: unknown): boolean {
    const step = typeof index === 'number' && this.taskSupport() ? findTaskSteps(this.doc.getText())[index] : undefined;
    if (!step) {
      return false;
    }
    this.select({ kind: 'task', line: step.line, raw: step.raw });
    return true;
  }

  /** Another major of the selected step's task (it must be in the catalog); only the `task:` line changes. */
  private onTaskVersion(major: unknown): boolean {
    const step = this.selection?.kind === 'task' ? this.findStep(findTaskSteps(this.doc.getText())) : undefined;
    const index = this.host.tasks?.snapshot().index;
    if (typeof major !== 'number' || !step?.name || !index?.majors(step.name).includes(major)) {
      return false;
    }
    this.taskMajor = major === step.major ? undefined : major;
    this.validation = IDLE;
    this.notice = undefined;
    return true;
  }

  private onTaskField(name: unknown, value: unknown): boolean {
    if (name !== 'displayName' || typeof value !== 'string' || (this.selection?.kind !== 'task' && this.selection?.kind !== 'newTask')) {
      return false;
    }
    this.displayName = value;
    this.validation = IDLE;
    this.notice = undefined;
    return true;
  }

  private async onReloadTasks(): Promise<void> {
    if (!this.host.tasks || !this.taskSupport()) {
      return;
    }
    this.tasksRefreshing = true;
    void this.render();
    try {
      await this.host.tasks.refresh();
    } finally {
      this.tasksRefreshing = false;
    }
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
    if (c.call?.task) {
      // Task steps: Reset discards the form's changes (an input that is not set has no default to restore).
      this.displayName = undefined;
      this.taskMajor = undefined;
      this.validation = IDLE;
      return;
    }
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

  /** The selected task step: same text, nearest to the remembered line. */
  private findStep(steps: TaskStepRef[]): TaskStepRef | undefined {
    const s = this.selection;
    if (s?.kind !== 'task') {
      return undefined;
    }
    return steps.filter(t => t.raw === s.raw).toSorted((a, b) => Math.abs(a.line - s.line) - Math.abs(b.line - s.line))[0];
  }

  private async compute(): Promise<Computed> {
    const doc = await this.current().catch(() => this.doc);
    const text = doc.getText();
    const refs = findTemplateRefs(text);
    const taskSteps = this.taskSupport() ? findTaskSteps(text) : [];
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
    const firstError = call && this.rows(text, call).find(p => p.error);
    const blocking = call?.error ?? call?.readOnly ?? (firstError ? `${firstError.label}: ${firstError.error}` : undefined);
    return { doc, text, version: doc.version, refs, taskSteps, ctx, repos, repo, ref, call, edits, newText: applied.text, marks: applied.marks, blocking };
  }

  private async callModel(text: string, refs: TemplateRef[], ctx: TemplateContext | undefined): Promise<CallModel | undefined> {
    const s = this.selection;
    if ((s?.kind === 'task' || s?.kind === 'newTask') && this.taskSupport()) {
      return this.taskModel(text, s);
    }
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

  /** The form model of a task step or a new task. Without the task's definition it says why there is no form. */
  private taskModel(text: string, s: Extract<Selection, { kind: 'task' | 'newTask' }>): CallModel | undefined {
    const snap = this.host.tasks!.snapshot();
    if (s.kind === 'newTask') {
      const info = snap.index?.all().find(t => t.id === s.id && t.major === s.major);
      return info && snap.index ? this.newTaskModel(text, info, snap.index) : undefined;
    }
    const steps = findTaskSteps(text);
    const step = this.findStep(steps);
    if (!step) {
      return undefined;
    }
    const name = step.name ?? (step.raw || '(no task)');
    const model: CallModel = {
      isNew: false, ref: asTemplateRef(step), title: `${name} · line ${step.line + 1}`, declared: [], points: [],
      task: { step, stepIndex: steps.indexOf(step), label: step.raw || '(no task)' },
    };
    if (step.name === undefined || step.major === undefined) {
      model.readOnly = callReadOnlyReason(text, model.ref!, 'inputs');
      return model;
    }
    const major = this.taskMajor ?? step.major;
    model.task!.label = `${step.name}@${major}`;
    const info = snap.index?.find(step.name, major);
    if (!snap.index || !info) {
      model.error = this.missingTaskText(snap, step.name, major);
      return model;
    }
    model.ref = asTemplateRef(step, info);
    model.readOnly = callReadOnlyReason(text, model.ref, 'inputs');
    Object.assign(model.task!, { info, index: snap.index });
    if (!model.readOnly) {
      model.task!.form = buildTaskForm(text, info, step, model.ref, this.pending);
      model.declared = model.task!.form.declared;
    }
    return model;
  }

  private missingTaskText(snap: CatalogSnapshot, name: string, major: number): string {
    if (!snap.index) {
      return snap.status === 'error' ? 'The task list could not be read, so this step has no form. Edit it in the text.' : 'The form appears when the task list is there.';
    }
    const org = orgLabel(this.host.orgUrl?.()) || 'your organization';
    const what = snap.index.knowsName(name) ? `Version @${major} is not in the task list of ${org}.` : `This task is not in the task list of ${org}.`;
    return `${what} Edit it in the text.`;
  }

  private newTaskModel(text: string, info: TaskInfo, index: TaskIndex): CallModel {
    const points = findInsertionPoints(text, 'steps');
    const point = points[this.target ?? points.length - 1] ?? points.at(-1);
    const form = buildTaskForm(text, info, undefined, undefined, this.pending);
    return {
      isNew: true, title: `New: ${info.name}@${info.major}`, declared: form.declared, points, point,
      readOnly: point ? undefined : 'The pipeline has no steps: list to add this task to.',
      task: { info, index, form, label: `${info.name}@${info.major}` },
    };
  }

  /** Edits for the selected task step, or the insertion of a new one. */
  private planTask(text: string, call: CallModel): LineEdit[] {
    const t = call.task;
    if (!t?.info || !t.form || call.readOnly || call.error) {
      return [];
    }
    const opts = { writeDefaults: this.writeDefaults };
    if (call.isNew) {
      return call.point ? [planNewTask(t.info, t.form, this.pending, { at: call.point.line, indent: call.point.indent, unit: indentUnit(text) }, opts, this.displayName)] : [];
    }
    return t.step ? planTaskStep({ step: t.step, info: t.info, form: t.form, text, pending: this.pending, opts, displayName: this.displayName, major: this.taskMajor }) : [];
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
    if (call?.task) {
      edits.push(...this.planTask(text, call));
    } else if (call?.ref && !call.error) {
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
    this.loadTasks(c);
    this.loadCatalog(c);
    this.loadRefs(c.repo);
  }

  /** Form rows of the selected call or task step. */
  private rows(text: string, call: CallModel): ParamView[] {
    return call.task ? call.task.form?.rows ?? [] : this.paramRows(text, call);
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
    const params = call ? this.rows(c.text, call) : [];
    const tasksOn = this.taskSupport();
    const removed = c.edits.reduce((n, e) => n + Math.max(0, e.deleteCount - e.insert.length), 0);
    const marks = [...c.marks.values()];
    return {
      title: path.basename(c.doc.uri.path),
      repos: c.repos.map(r => ({ alias: r.alias, label: r.resource ? `${r.alias} · ${r.resource.name}` : 'self · this repository' })),
      repo: this.repoView(c),
      catalog: this.catalogView(c),
      catalogMode: tasksOn ? this.catalogMode : 'templates',
      tasks: tasksOn ? this.tasksView() : undefined,
      structure: structure(c.text, c.refs, call?.task ? undefined : call?.index, this.newItem(call), tasksOn ? { steps: c.taskSteps, selected: call?.task?.stepIndex } : undefined),
      call: call && {
        isNew: call.isNew, title: call.title, kind: call.kind, error: call.error, readOnly: call.readOnly, line: call.ref?.line,
        status: callStatus(call), params: call.error ? [] : params, unknown: call.task ? call.task.form?.unknown ?? [] : unknownParams(call.ref, call.declared),
        task: call.task && this.taskView(c.text, call.task),
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

  /** The new, not yet inserted item of the structure strip. */
  private newItem(call: CallModel | undefined): { label: string; stage?: string; kind: 'template' | 'task' } | undefined {
    if (!call?.isNew) {
      return undefined;
    }
    return call.task ? { label: call.task.label, stage: call.point?.stage, kind: 'task' } : { label: path.posix.basename(call.title), stage: call.point?.stage, kind: 'template' };
  }

  /** The task part of the catalog: state, age and (in Tasks mode) the short list items. */
  private tasksView() {
    return taskListState(this.host.tasks!.snapshot(), Date.now(), this.host.orgUrl?.(), this.tasksRefreshing, this.catalogMode === 'tasks');
  }

  /** What the page shows about the task of the form: summary, version choices, display name and groups. */
  private taskView(text: string, t: TaskModel) {
    const summary = t.info && t.index ? taskSummary(t.index, t.info, this.setting('taskVersionHints')) : undefined;
    const inFile = t.step ? findDisplayName(text, t.step)?.value : undefined;
    const shown = this.displayName ?? inFile ?? '';
    return {
      label: t.label, summary, hasForm: !!t.form, groups: t.form?.groups ?? [],
      displayName: { value: shown, placeholder: t.info?.title ?? '', unsaved: this.displayName !== undefined && this.displayName.trim() !== (inFile ?? '') },
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
    const call = c.call;
    if (call?.task) {
      const step = this.focusStep(c);
      if (step) {
        out.push([step.line, step.end - 1]);
      }
      return out;
    }
    const newRefs = findTemplateRefs(c.newText);
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

  /** The selected task step in the new text: the inserted one (`+` on its line) or the existing one by index. */
  private focusStep(c: Computed): TaskStepRef | undefined {
    const call = c.call;
    const steps = findTaskSteps(c.newText);
    if (!call?.isNew) {
      return steps[call?.task?.stepIndex ?? -1];
    }
    const head = newTaskLines(call.task?.label ?? '', [], {}, call.point?.indent ?? 0, 2, { writeDefaults: false })[0];
    const lines = c.newText.split(/\r?\n/);
    return steps.find(t => c.marks.get(t.line) === '+' && lines[t.line] === head);
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

  /** Reads the task catalog once the designer needs it: Tasks mode, or a task in the form. Later changes arrive through `onDidChange`. */
  private loadTasks(c: Computed): void {
    const wanted = this.catalogMode === 'tasks' || !!c.call?.task;
    if (!this.host.tasks || !this.taskSupport() || !wanted || this.tasksRequested) {
      return;
    }
    this.tasksRequested = true;
    void this.host.tasks.ensure().then(() => undefined, () => undefined).then(() => {
      if (!this.disposed) {
        void this.render();
      }
    });
  }

  private loadRefs(repo: RepoChoice): void {
    const r = repo.resource;
    if (r?.type !== 'git' || this.refs.has(repo.alias)) {
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
    this.selectApplied(c);
    this.refChoice = undefined;
    const subject = c.call?.task ? `the step ${c.call.task.label}` : `the call of ${c.call?.title}`;
    this.notice = c.call
      ? { level: 'ok', title: `${what} ${subject}`, detail: `${file} has unsaved changes: save it to keep them (undo works as usual).` }
      : { level: 'ok', title: 'Updated the repository resource', detail: `${file} has unsaved changes.` };
  }

  /** After applying: selects what was written, as an existing call or step (the pending values are in the file now). */
  private selectApplied(c: Computed): void {
    const call = c.call;
    if (call?.task) {
      const steps = findTaskSteps(c.newText);
      const step = call.isNew ? steps.find(t => c.marks.get(t.line) === '+' && t.raw === call.task?.label) : steps[call.task.stepIndex ?? -1];
      this.select(step ? { kind: 'task', line: step.line, raw: step.raw } : this.selection);
      return;
    }
    const target = call?.isNew ? this.newRefAfterApply(c) : call?.ref && findTemplateRefs(c.newText)[call.index ?? -1];
    this.select(target ? { kind: 'call', line: target.line, raw: target.raw } : this.selection);
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
  const info = call.task?.info;
  if (call.task && info) {
    return call.isNew ? `New: goes to ${call.point?.label ?? 'no place to insert it'}` : `${info.title} · ${info.category} · installed ${info.version}`;
  }
  if (call.task) {
    return call.ref ? `task · line ${call.ref.line + 1}` : 'task';
  }
  if (call.isNew) {
    return call.point ? `New: goes to ${call.point.label}` : 'New: no place to insert it';
  }
  const kind = call.ref?.kind === 'extends' ? 'extends' : 'template';
  return call.ref ? `${kind} · line ${call.ref.line + 1}` : kind;
}

/** "Open in Designer" above every `template:` / `extends:` call and `- task:` step of local YAML files (settings `azureDevOps.yaml.designerCodeLens`, `.taskSupport`). */
export class DesignerCodeLens implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const config = vscode.workspace.getConfiguration('azureDevOps');
    if (doc.uri.scheme !== 'file' || !config.get<boolean>('yaml.designerCodeLens', true)) {
      return [];
    }
    const text = doc.getText();
    const lines = findTemplateRefs(text).map(ref => ({ line: ref.line, tooltip: 'Edit the parameters of this template call in a form' }));
    if (config.get<boolean>('yaml.taskSupport', true)) {
      lines.push(...findTaskSteps(text).map(step => ({ line: step.line, tooltip: 'Edit the inputs of this task step in a form' })));
    }
    return lines.map(l => new vscode.CodeLens(new vscode.Range(l.line, 0, l.line, 0), {
      title: 'Open in Designer', tooltip: l.tooltip, command: 'azureDevOps.yaml.openDesigner', arguments: [doc.uri, l.line],
    }));
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

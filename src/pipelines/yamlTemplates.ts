/**
 * Editing help for Azure Pipelines YAML: completions, hovers, go to definition and diagnostics for the parameters of
 * `template:` / `extends:` references (also through repository resources, recursively), a template tree and a server
 * preview of the expanded pipeline with the local file content.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AdoClient, AdoError } from '../client';
import { Connection } from '../connection';
import { currentBranch, isInside, localAdoRepos } from '../git';
import { plural } from '../util';
import {
  checkTemplateParameters, completionContext, CompletionContext, describeParameter, findTemplateRefs, mdEscape, parameterSnippet,
  parsePreviewErrors, TemplateRef,
} from './templateRefs';
import { ExpandResult, TemplateExpander } from './templateExpander';
import { ResolvedTemplate, TemplateContentProvider, TemplateNode, TemplateResolver, TEMPLATE_SCHEME, templateText, toRepoPath } from './templateResolver';

export interface ServerPreview {
  yaml: string;
  definition: { id: number; name: string };
  branch: string;
  filePath: string;
}

/** A preview problem for the user (not a bug): shown as a message or in the preview panel. */
export class PreviewError extends Error {
  constructor(message: string, readonly level: 'info' | 'warning' | 'error') {
    super(message);
  }

  show(): void {
    const show = { info: vscode.window.showInformationMessage, warning: vscode.window.showWarningMessage, error: vscode.window.showErrorMessage }[this.level];
    void show(this.message);
  }
}

const SELECTOR: vscode.DocumentSelector = [{ language: 'yaml' }, { language: 'azure-pipelines' }, { scheme: TEMPLATE_SCHEME }];
const DEBOUNCE_MS = 600;

const isPipelineDoc = (d: vscode.TextDocument) =>
  d.uri.scheme === TEMPLATE_SCHEME || ((d.languageId === 'yaml' || d.languageId === 'azure-pipelines') && d.uri.scheme === 'file');

/** Line of `- name: <name>` (or a legacy `<name>:` key) in a template, for go to definition. */
export function declarationLine(text: string, name: string): number {
  const lines = text.split(/\r?\n/);
  const quoted = [name, `'${name}'`, `"${name}"`];
  const hit = lines.findIndex(l => quoted.some(q => l.trim().replace(/^-\s*/, '') === `name: ${q}`));
  if (hit >= 0) {
    return hit;
  }
  return Math.max(lines.findIndex(l => /^\s+\S/.test(l) && quoted.some(q => l.trim() === `${q}:` || l.trim().startsWith(`${q}: `))), 0);
}

export class YamlTemplateSupport implements vscode.CompletionItemProvider, vscode.HoverProvider, vscode.DefinitionProvider, vscode.Disposable {
  readonly resolver: TemplateResolver;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('azureDevOps.templates');
  private readonly previewDiagnostics = vscode.languages.createDiagnosticCollection('azureDevOps.pipelinePreview');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly client: AdoClient, private readonly connections: { current?: Connection }) {
    this.resolver = new TemplateResolver(client, connections);
  }

  /** Registers the providers and listeners; returns this for `context.subscriptions`. */
  register(): this {
    this.disposables.push(
      this.diagnostics,
      this.previewDiagnostics,
      vscode.workspace.registerTextDocumentContentProvider(TEMPLATE_SCHEME, new TemplateContentProvider(this.resolver)),
      vscode.languages.registerCompletionItemProvider(SELECTOR, this, ' ', ':', '@', '/'),
      vscode.languages.registerHoverProvider(SELECTOR, this),
      vscode.languages.registerDefinitionProvider(SELECTOR, this),
      vscode.workspace.onDidOpenTextDocument(d => this.schedule(d)),
      vscode.workspace.onDidChangeTextDocument(e => {
        this.previewDiagnostics.delete(e.document.uri);
        this.schedule(e.document);
      }),
      vscode.workspace.onDidSaveTextDocument(d => {
        if (isPipelineDoc(d)) {
          this.resolver.invalidate();
          vscode.workspace.textDocuments.forEach(doc => this.schedule(doc));
        }
      }),
      vscode.workspace.onDidCloseTextDocument(d => {
        this.diagnostics.delete(d.uri);
        this.previewDiagnostics.delete(d.uri);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('azureDevOps')) {
          this.resolver.invalidate();
          vscode.workspace.textDocuments.forEach(doc => this.schedule(doc));
        }
      }),
    );
    vscode.workspace.textDocuments.forEach(d => this.schedule(d));
    return this;
  }

  dispose(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear();
    this.disposables.forEach(d => d.dispose());
  }

  // ----- resolving -----

  private async resolveRef(doc: vscode.TextDocument, ref: TemplateRef): Promise<ResolvedTemplate | undefined> {
    const ctx = await this.resolver.contextFor(doc.uri, doc.getText());
    return ctx && ref.target ? this.resolver.resolve(ctx, ref.target) : undefined;
  }

  private async tryResolve(doc: vscode.TextDocument, ref: TemplateRef): Promise<ResolvedTemplate | undefined> {
    try {
      return await this.resolveRef(doc, ref);
    } catch {
      return undefined;
    }
  }

  // ----- completions -----

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const cc = completionContext(doc.getText(), pos.line, pos.character);
    if (!cc) {
      return undefined;
    }
    if (cc.kind === 'path') {
      return this.pathItems(doc, cc.prefix);
    }
    const resolved = await this.tryResolve(doc, cc.ref);
    if (!resolved) {
      return undefined;
    }
    return parameterItems(cc, resolved);
  }

  /** `@alias` choices after an `@`, else YAML files of the same repository relative to the document. */
  private async pathItems(doc: vscode.TextDocument, prefix: string): Promise<vscode.CompletionItem[] | undefined> {
    const ctx = await this.resolver.contextFor(doc.uri, doc.getText());
    if (!ctx) {
      return undefined;
    }
    if (prefix.includes('@')) {
      return ['self', ...Object.keys(ctx.repos)].map(alias => {
        const item = new vscode.CompletionItem(alias, vscode.CompletionItemKind.Module);
        item.detail = alias === 'self' ? 'Repository of the pipeline' : `${ctx.repos[alias].type}: ${ctx.repos[alias].name}`;
        return item;
      });
    }
    const origin = ctx.location.origin;
    if (origin.kind !== 'local') {
      return undefined;
    }
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(origin.root, '**/*.{yml,yaml}'), '**/node_modules/**', 300);
    const dir = path.posix.dirname(ctx.location.path);
    return files.map(f => toRepoPath(origin.root, f.fsPath)).filter(p => p !== ctx.location.path).map(p => {
      const item = new vscode.CompletionItem(path.posix.relative(dir, p), vscode.CompletionItemKind.File);
      item.detail = p;
      return item;
    });
  }

  // ----- hover and definition -----

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const hit = this.refAt(doc, pos);
    if (!hit) {
      return undefined;
    }
    let resolved: ResolvedTemplate | undefined;
    try {
      resolved = await this.resolveRef(doc, hit.ref);
    } catch (e) {
      return new vscode.Hover(new vscode.MarkdownString(`$(warning) ${mdEscape((e as Error).message)}`, true));
    }
    if (!resolved) {
      return undefined;
    }
    if (hit.param) {
      const p = resolved.parameters.find(x => x.name === hit.param);
      return new vscode.Hover(new vscode.MarkdownString(p ? describeParameter(p) : `'${mdEscape(hit.param)}' is not a parameter of this template.`));
    }
    return new vscode.Hover(new vscode.MarkdownString(templateSummary(resolved), true));
  }

  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location | undefined> {
    const hit = this.refAt(doc, pos);
    const resolved = hit && await this.tryResolve(doc, hit.ref);
    if (!resolved) {
      return undefined;
    }
    const line = hit?.param ? declarationLine(resolved.text, hit.param) : 0;
    return new vscode.Location(resolved.uri, new vscode.Position(line, 0));
  }

  /** The reference whose path or one of whose parameter names is under the cursor. */
  private refAt(doc: vscode.TextDocument, pos: vscode.Position): { ref: TemplateRef; param?: string } | undefined {
    for (const ref of findTemplateRefs(doc.getText())) {
      if (ref.line === pos.line && pos.character >= ref.valueStart && pos.character <= ref.valueEnd && ref.target) {
        return { ref };
      }
      const p = ref.params.find(e => e.line === pos.line && pos.character >= e.start && pos.character <= e.end);
      if (p && ref.target) {
        return { ref, param: p.name };
      }
    }
    return undefined;
  }

  // ----- diagnostics -----

  private schedule(doc: vscode.TextDocument): void {
    if (!isPipelineDoc(doc)) {
      return;
    }
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.validate(doc);
    }, DEBOUNCE_MS));
  }

  /** Checks the parameters of every resolvable reference; unresolvable templates get a warning on their path. */
  async validate(doc: vscode.TextDocument): Promise<void> {
    if (!vscode.workspace.getConfiguration('azureDevOps').get<boolean>('yaml.templateDiagnostics', true)) {
      this.diagnostics.delete(doc.uri);
      return;
    }
    const version = doc.version;
    const out: vscode.Diagnostic[] = [];
    for (const ref of findTemplateRefs(doc.getText()).filter(r => r.target)) {
      out.push(...await this.checkRef(doc, ref));
    }
    if (doc.version === version && !doc.isClosed) {
      this.diagnostics.set(doc.uri, out);
    }
  }

  private async checkRef(doc: vscode.TextDocument, ref: TemplateRef): Promise<vscode.Diagnostic[]> {
    const pathRange = new vscode.Range(ref.line, ref.valueStart, ref.line, ref.valueEnd);
    try {
      const resolved = await this.resolveRef(doc, ref);
      return resolved ? checkTemplateParameters(ref, resolved.parameters).map(i => diagnostic(
        new vscode.Range(i.line, i.start, i.line, i.end), i.message,
        i.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning)) : [];
    } catch (e) {
      // Not signed in or not configured: stay quiet instead of marking every remote template.
      if (e instanceof AdoError && (e.isAuthError || e.status === 0)) {
        return [];
      }
      return [diagnostic(pathRange, (e as Error).message, vscode.DiagnosticSeverity.Warning)];
    }
  }

  // ----- commands -----

  /** Quick pick of every template the active pipeline includes, recursively; picking one opens it. */
  async showTemplates(uri?: vscode.Uri): Promise<void> {
    const doc = await this.documentFor(uri);
    const ctx = doc && await this.resolver.contextFor(doc.uri, doc.getText());
    if (!doc || !ctx) {
      void vscode.window.showInformationMessage('Open an Azure Pipelines YAML file first.');
      return;
    }
    const nodes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Resolving templates' },
      () => this.resolver.tree(ctx, doc.getText()));
    if (!nodes.length) {
      void vscode.window.showInformationMessage(`${path.basename(doc.uri.path)} includes no templates.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(treeItems(nodes, 0), {
      title: `Templates of ${path.basename(doc.uri.path)}`, placeHolder: 'Open a template', matchOnDescription: true,
    });
    if (pick?.node.resolved) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(pick.node.resolved.uri), { preview: true });
    }
  }

  /** The clone of an Azure Repos repository (of the selected projects) that contains the document. */
  private localRepoOf(doc: vscode.TextDocument) {
    return localAdoRepos(this.connections.current).filter(r => isInside(doc.uri.fsPath, r.repo.rootUri.fsPath))
      .sort((a, b) => b.repo.rootUri.fsPath.length - a.repo.rootUri.fsPath.length)[0];
  }

  /**
   * Lets Azure DevOps expand the pipeline with the local content of this file (`yamlOverride`). Other files are read
   * from the server at the checked-out branch. `definitionId` skips the pipeline picker (the preview panel keeps the
   * choice). Returns undefined when the user cancels; problems the user has to fix throw a `PreviewError`, and the
   * server's template errors are also marked in the file.
   */
  async expandOnServer(doc: vscode.TextDocument, templateParameters?: Record<string, string>, definitionId?: number):
    Promise<ServerPreview | undefined> {
    if (doc.uri.scheme !== 'file') {
      throw new PreviewError('Open a local Azure Pipelines YAML file first.', 'info');
    }
    const local = this.localRepoOf(doc);
    if (!local) {
      throw new PreviewError('This file is not in a clone of an Azure Repos repository of the selected projects.', 'warning');
    }
    const api = this.client.forProject(local.project);
    const repo = await api.getRepository(local.repoName);
    const filePath = toRepoPath(local.repo.rootUri.fsPath, doc.uri.fsPath);
    const defs = await api.listYamlDefinitions(repo.id);
    const def = defs.find(d => d.id === definitionId) ?? await pickDefinition(defs, filePath, local.repoName);
    if (!def) {
      return undefined;
    }
    const branch = currentBranch(local.repo) ?? repo.defaultBranch?.replace(/^refs\/heads\//, '') ?? 'main';
    this.previewDiagnostics.delete(doc.uri);
    try {
      const yaml = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Expanding ${def.name}` },
        () => api.previewPipeline(def.id, `refs/heads/${branch}`, undefined, templateParameters, doc.getText()));
      return { yaml, definition: { id: def.id, name: def.name }, branch, filePath };
    } catch (e) {
      if (e instanceof AdoError && !e.isAuthError) {
        throw new PreviewError(this.markPreviewErrors(doc, filePath, e.message), 'error');
      }
      throw e;
    }
  }

  /** Expands the document locally (templates through the resolver, so local clones and unsaved changes count). */
  async expandLocally(doc: vscode.TextDocument, parameters?: Record<string, string>): Promise<ExpandResult> {
    const ctx = await this.resolver.contextFor(doc.uri, doc.getText());
    if (!ctx) {
      throw new PreviewError('Open a local Azure Pipelines YAML file first.', 'info');
    }
    const branch = doc.uri.scheme === 'file' ? currentBranch(this.localRepoOf(doc)?.repo) : undefined;
    return new TemplateExpander(this.resolver).expand(ctx, doc.getText(), doc.uri.toString(), path.basename(doc.uri.path), { parameters, branch });
  }

  /** Command: the expanded YAML from Azure DevOps in a new editor next to the file. */
  async previewPipeline(uri?: vscode.Uri): Promise<void> {
    const doc = await this.documentFor(uri);
    let result: ServerPreview | undefined;
    try {
      if (!doc) {
        throw new PreviewError('Open a local Azure Pipelines YAML file first.', 'info');
      }
      result = await this.expandOnServer(doc);
    } catch (e) {
      if (e instanceof PreviewError) {
        e.show();
        return;
      }
      throw e;
    }
    if (!result) {
      return;
    }
    const header = `# Expanded by Azure DevOps for "${result.definition.name}" at ${result.branch}, with the local content of ${result.filePath.slice(1)}.\n`
      + '# Other files (templates of this repository) are read from the server.\n';
    const preview = await vscode.workspace.openTextDocument({ language: 'yaml', content: header + result.yaml });
    await vscode.window.showTextDocument(preview, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  /** Marks the server's errors that point into this file; returns a one-line summary. */
  private markPreviewErrors(doc: vscode.TextDocument, filePath: string, message: string): string {
    const errors = parsePreviewErrors(message);
    const own = errors.filter(e => e.file.replace(/^\//, '').toLowerCase() === filePath.slice(1).toLowerCase());
    this.previewDiagnostics.set(doc.uri, own.map(e =>
      diagnostic(new vscode.Range(e.line - 1, Math.max(e.col - 1, 0), e.line - 1, Number.MAX_SAFE_INTEGER), e.text, vscode.DiagnosticSeverity.Error)));
    const first = errors[0] ? `${errors[0].file} (line ${errors[0].line}): ${errors[0].text}` : message;
    const more = errors.length > 1 ? ` (${plural(errors.length, 'error')})` : '';
    return `Azure DevOps could not expand the pipeline${more}: ${first}`;
  }

  private async documentFor(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    if (uri instanceof vscode.Uri) {
      return vscode.workspace.openTextDocument(uri);
    }
    return vscode.window.activeTextEditor?.document;
  }
}

function diagnostic(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = 'DevOps Deck';
  return d;
}

/** Completion items for parameter names (not yet passed), values, or a `parameters:` block with the required ones. */
export function parameterItems(cc: Exclude<CompletionContext, { kind: 'path' }>, resolved: ResolvedTemplate): vscode.CompletionItem[] {
  const declared = resolved.parameters;
  if (cc.kind === 'value') {
    const p = declared.find(x => x.name === cc.name);
    const choices = p?.type === 'boolean' && !p.values?.length ? ['true', 'false'] : p?.values ?? [];
    return choices.map((v, i) => {
      const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember);
      item.sortText = String(i).padStart(4, '0');
      item.detail = v === p?.default ? 'default' : undefined;
      return item;
    });
  }
  if (cc.kind === 'parametersKey') {
    const required = declared.filter(p => p.default === undefined);
    const lines = (required.length ? required : declared).map((p, i) => '\n  ' + parameterSnippet(p, i + 1));
    const item = new vscode.CompletionItem('parameters', vscode.CompletionItemKind.Snippet);
    item.insertText = new vscode.SnippetString('parameters:' + (lines.join('') || '\n  $0'));
    item.detail = required.length ? `with the required ${plural(required.length, 'parameter')}` : `Parameters of ${resolved.label}`;
    item.documentation = new vscode.MarkdownString(declared.map(describeParameter).join('\n\n'));
    return [item];
  }
  const passed = new Set(cc.ref.params.map(e => e.name));
  return declared.filter(p => !passed.has(p.name)).map(p => {
    const item = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property);
    item.insertText = new vscode.SnippetString(parameterSnippet(p, 1));
    item.detail = p.default === undefined ? `${p.type} (required)` : p.type;
    item.sortText = (p.default === undefined ? '0' : '1') + p.name;
    item.documentation = new vscode.MarkdownString(describeParameter(p));
    return item;
  });
}

/** Hover text: where the template comes from, its parameters and the templates it includes itself. */
export function templateSummary(r: ResolvedTemplate): string {
  const params = r.parameters.length ? r.parameters.map(p => '- ' + describeParameter(p)).join('\n') : '_No parameters._';
  const nested = findTemplateRefs(r.text).filter(t => t.target).map(t => '`' + templateText(t.target!).replace(/`/g, "'") + '`');
  const includes = nested.length ? `\n\nIncludes ${[...new Set(nested)].join(', ')}` : '';
  return `$(file-code) **${mdEscape(r.label)}**\n\n${params}${includes}`;
}

type TreeItem = vscode.QuickPickItem & { node: TemplateNode };

function treeItems(nodes: TemplateNode[], depth: number): TreeItem[] {
  return nodes.flatMap(node => {
    const icon = node.error ? '$(warning)' : '$(file-code)';
    const item: TreeItem = {
      label: `${' '.repeat(depth)}${icon} ${node.label}`,
      description: node.resolved?.label,
      detail: node.error ?? `${' '.repeat(depth)}${plural(node.resolved?.parameters.length ?? 0, 'parameter')}`,
      node,
    };
    return [item, ...treeItems(node.children, depth + 1)];
  });
}

const sameFile = (a: string | undefined, b: string) => !!a && a.replace(/^\//, '').toLowerCase() === b.replace(/^\//, '').toLowerCase();

async function pickDefinition<D extends { id: number; name: string; path: string; process?: { yamlFilename?: string } }>(
  defs: D[], filePath: string, repoName: string): Promise<D | undefined> {
  const matches = defs.filter(d => sameFile(d.process?.yamlFilename, filePath));
  if (matches.length === 1) {
    return matches[0];
  }
  const list = matches.length ? matches : defs;
  if (!list.length) {
    void vscode.window.showWarningMessage(`No YAML pipeline uses the repository ${repoName}.`);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(list.map(d => ({ label: d.name, description: d.process?.yamlFilename, detail: d.path, d })), {
    title: matches.length ? 'Several pipelines use this file' : `No pipeline uses ${filePath.slice(1)}: expand it as`,
    placeHolder: 'Pipeline',
  });
  return pick?.d;
}

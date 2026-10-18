/**
 * Resolves `template:` references of Azure Pipelines YAML to file contents: relative paths in the same repository,
 * `path@alias` through `resources.repositories` (Azure Repos via the REST API, or a local clone in the workspace) and
 * `@self`. Templates from other repositories open as read-only `ado-template:` documents whose URI carries the
 * context (repository, `self`, declared aliases), so references inside them resolve the same way, recursively.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AdoClient, AdoError } from '../client';
import { Connection } from '../connection';
import { isInside, localAdoRepos } from '../git';
import { mapLimit } from '../util';
import { findTemplateRefs, joinTemplatePath, parseRepositories, RepoResource, TemplatePath, TemplateRef } from './templateRefs';
import { parsePipelineParameters, PipelineParameter, setOwn } from './yamlParameters';

export const TEMPLATE_SCHEME = 'ado-template';

export type Origin =
  | { kind: 'local'; root: string }
  | { kind: 'remote'; project: string; repo: string; ref?: string };

export interface TemplateLocation {
  origin: Origin;
  /** repository-relative, starting with '/' */
  path: string;
}

/** Where a document lives and which repositories its references can name. */
export interface TemplateContext {
  location: TemplateLocation;
  /** repository of the root pipeline (`@self`) */
  self: Origin;
  /** repository resources by alias; declarations closer to the root pipeline win */
  repos: Record<string, RepoResource>;
}

export interface ResolvedTemplate {
  context: TemplateContext;
  uri: vscode.Uri;
  text: string;
  parameters: PipelineParameter[];
  label: string;
}

export interface TemplateNode {
  ref: TemplateRef;
  label: string;
  resolved?: ResolvedTemplate;
  error?: string;
  children: TemplateNode[];
}

/** Azure Pipelines limits: 100 template files per pipeline, nesting depth 100 (we stop earlier, at 20 levels). */
const MAX_FILES = 100;
const MAX_DEPTH = 20;
const CACHE_MS = 30_000;

const isString = (v: unknown): v is string => typeof v === 'string';

/** Short name of a location for hovers and the template tree, e.g. `templates/build.yml · pipeline-templates@main`. */
export function locationLabel(l: TemplateLocation): string {
  const file = l.path.replace(/^\//, '');
  if (l.origin.kind === 'local') {
    return `${file} · ${path.basename(l.origin.root)} (local)`;
  }
  const ref = l.origin.ref ? '@' + l.origin.ref.replace(/^refs\/(heads|tags)\//, '') : '';
  return `${file} · ${l.origin.repo}${ref}`;
}

const originKey = (o: Origin) => (o.kind === 'local' ? `local:${o.root}` : `remote:${o.project}/${o.repo}@${o.ref ?? ''}`.toLowerCase());

export class TemplateResolver {
  private readonly texts = new Map<string, { at: number; text: Promise<string> }>();
  private readonly repoIds = new Map<string, Promise<string>>();
  private readonly roots = new Map<string, Promise<string>>();
  private workspaceAliases?: Promise<Map<string, RepoResource>>;

  constructor(private readonly client: AdoClient, private readonly connections: { current?: Connection }) {}

  /** Forgets cached files (after a save or a configuration change). */
  invalidate(): void {
    this.texts.clear();
    this.repoIds.clear();
    this.workspaceAliases = undefined;
  }

  /** Context of an open document: a local file, or a template opened from another repository. */
  async contextFor(uri: vscode.Uri, text: string): Promise<TemplateContext | undefined> {
    const own = Object.fromEntries(parseRepositories(text).map(r => [r.alias, r]));
    if (uri.scheme === TEMPLATE_SCHEME) {
      const ctx = decodeContext(uri.query);
      return ctx && { ...ctx, repos: { ...own, ...ctx.repos } };
    }
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const root = await this.gitRoot(path.dirname(uri.fsPath));
    const origin: Origin = { kind: 'local', root };
    return { location: { origin, path: toRepoPath(root, uri.fsPath) }, self: origin, repos: own };
  }

  /** Resolves and reads a referenced template. Throws an Error with a message for the user when that fails. */
  async resolve(ctx: TemplateContext, target: TemplatePath): Promise<ResolvedTemplate> {
    let location: TemplateLocation;
    if (!target.alias) {
      location = { origin: ctx.location.origin, path: joinTemplatePath(ctx.location.path, target.path) };
    } else if (target.alias === 'self') {
      location = { origin: ctx.self, path: joinTemplatePath('/', target.path) };
    } else {
      const repo = (Object.hasOwn(ctx.repos, target.alias) ? ctx.repos[target.alias] : undefined)
        ?? (await this.aliasesInWorkspace()).get(target.alias);
      if (!repo) {
        throw new Error(`The repository '${target.alias}' is not declared under resources.repositories.`);
      }
      location = { origin: this.originOf(repo), path: joinTemplatePath('/', target.path) };
    }
    const text = await this.read(location);
    const context: TemplateContext = {
      location, self: ctx.self, repos: { ...Object.fromEntries(parseRepositories(text).map(r => [r.alias, r])), ...ctx.repos },
    };
    return { context, uri: uriOf(context), text, parameters: parsePipelineParameters(text), label: locationLabel(location) };
  }

  /** Every template the document includes, recursively (cycles and the Azure Pipelines file limit stop the walk). */
  async tree(ctx: TemplateContext, text: string): Promise<TemplateNode[]> {
    const budget = { files: MAX_FILES };
    return this.walk(ctx, text, [originKey(ctx.location.origin) + ctx.location.path], budget);
  }

  /** One reference after another on purpose: the file budget must cut the same templates on every run. */
  private async walk(ctx: TemplateContext, text: string, chain: string[], budget: { files: number }): Promise<TemplateNode[]> {
    const nodes: TemplateNode[] = [];
    for (const ref of findTemplateRefs(text)) {
      const node: TemplateNode = { ref, label: ref.target ? templateText(ref.target) : ref.raw || '(empty)', children: [] };
      nodes.push(node);
      if (!ref.target) {
        node.error = 'Expression: resolved when the pipeline runs';
        continue;
      }
      if (budget.files-- <= 0) {
        node.error = `More than ${MAX_FILES} template files`;
        continue;
      }
      try {
        node.resolved = await this.resolve(ctx, ref.target); // NOSONAR: sequential on purpose (file budget)
      } catch (e) {
        node.error = (e as Error).message;
        continue;
      }
      const key = originKey(node.resolved.context.location.origin) + node.resolved.context.location.path;
      if (chain.includes(key)) {
        node.error = 'Includes itself (cycle)';
      } else if (chain.length >= MAX_DEPTH) {
        node.error = `Nested deeper than ${MAX_DEPTH} levels`;
      } else {
        node.children = await this.walk(node.resolved.context, node.resolved.text, [...chain, key], budget); // NOSONAR: sequential on purpose
      }
    }
    return nodes;
  }

  /** Contents of a template file; an open local document is read with its unsaved changes. */
  read(location: TemplateLocation): Promise<string> {
    const o = location.origin;
    if (o.kind === 'local') {
      return readLocal(path.join(o.root, ...location.path.split('/')));
    }
    const key = `${originKey(o)}:${location.path}`;
    const hit = this.texts.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return hit.text;
    }
    const text = this.readRemote(o, location.path);
    this.texts.set(key, { at: Date.now(), text });
    text.catch(() => this.texts.delete(key));
    return text;
  }

  private async readRemote(o: Extract<Origin, { kind: 'remote' }>, file: string): Promise<string> {
    const api = this.client.forProject(o.project);
    const idKey = `${o.project}/${o.repo}`.toLowerCase();
    let id = this.repoIds.get(idKey);
    if (!id) {
      id = api.getRepository(o.repo).then(r => r.id);
      this.repoIds.set(idKey, id);
      id.catch(() => this.repoIds.delete(idKey));
    }
    try {
      return await api.getFileTextAtRef(await id, file, o.ref);
    } catch (e) {
      if (e instanceof AdoError && e.status === 404) {
        throw new Error(`${file.slice(1)} was not found in ${o.project}/${o.repo}${o.ref ? ' at ' + o.ref : ''}.`);
      }
      throw e;
    }
  }

  /**
   * Where a repository resource is read from. A local clone in the workspace wins when
   * `azureDevOps.yaml.preferLocalRepositories` is on (so unpushed template changes count); GitHub and other
   * external repositories can only be read from a local clone, because credentials only go to Azure DevOps.
   */
  originOf(repo: RepoResource): Origin {
    const conn = this.connections.current;
    const slash = repo.name.indexOf('/');
    const project = slash > 0 ? repo.name.slice(0, slash) : conn?.project ?? '';
    const name = slash > 0 ? repo.name.slice(slash + 1) : repo.name;
    const isAzure = repo.type === 'git';
    const preferLocal = vscode.workspace.getConfiguration('azureDevOps').get<boolean>('yaml.preferLocalRepositories', true);
    const local = isAzure ? this.localClone(project, name) : workspaceFolderNamed(name.split('/').pop() ?? name);
    if (local && (preferLocal || !isAzure)) {
      return { kind: 'local', root: local };
    }
    if (!isAzure) {
      throw new Error(`'${repo.name}' is a ${repo.type} repository: open a clone of it in the workspace to resolve its templates.`);
    }
    if (!project) {
      throw new Error('Azure DevOps is not configured yet.');
    }
    return { kind: 'remote', project, repo: name, ref: repo.ref };
  }

  private localClone(project: string, name: string): string | undefined {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const hit = localAdoRepos(this.connections.current).find(r => same(r.repoName, name) && same(r.project, project));
    return hit?.repo.rootUri.fsPath ?? workspaceFolderNamed(name);
  }

  /** Repository resources declared anywhere in the workspace's YAML files, for templates opened on their own. */
  private aliasesInWorkspace(): Promise<Map<string, RepoResource>> {
    this.workspaceAliases ??= (async () => {
      const map = new Map<string, RepoResource>();
      const files = await vscode.workspace.findFiles('**/*.{yml,yaml}', '**/node_modules/**', 500);
      const texts = await mapLimit(files, 8, f => readLocal(f.fsPath).catch(() => ''));
      // In file order, so the first declaration of an alias wins as before.
      for (const text of texts.filter(t => t.includes('repositories'))) {
        parseRepositories(text).forEach(r => map.has(r.alias) || map.set(r.alias, r));
      }
      return map;
    })();
    return this.workspaceAliases;
  }

  /** Nearest folder with a `.git` entry, else the workspace folder, else the file's folder. */
  private gitRoot(dir: string): Promise<string> {
    let root = this.roots.get(dir);
    if (!root) {
      root = findGitRoot(dir);
      this.roots.set(dir, root);
    }
    return root;
  }
}

async function findGitRoot(start: string): Promise<string> {
  for (let dir = start; ; dir = path.dirname(dir)) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, '.git')));
      return dir;
    } catch {
      if (path.dirname(dir) === dir) {
        break;
      }
    }
  }
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(start))?.uri.fsPath ?? start;
}

function workspaceFolderNamed(name: string): string | undefined {
  return vscode.workspace.workspaceFolders?.find(f => path.basename(f.uri.fsPath).toLowerCase() === name.toLowerCase())?.uri.fsPath;
}

async function readLocal(fsPath: string): Promise<string> {
  const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
  if (open) {
    return open.getText();
  }
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
  } catch {
    throw new Error(`${fsPath} does not exist.`);
  }
}

export function toRepoPath(root: string, file: string): string {
  return '/' + path.relative(root, file).split(path.sep).join('/');
}

export function templateText(t: TemplatePath): string {
  return t.alias ? `${t.path}@${t.alias}` : t.path;
}

/** Local templates open as the file itself; others as `ado-template:/<project>/<repo>/<path>?<context>`. */
export function uriOf(ctx: TemplateContext): vscode.Uri {
  const o = ctx.location.origin;
  if (o.kind === 'local') {
    return vscode.Uri.file(path.join(o.root, ...ctx.location.path.split('/')));
  }
  return vscode.Uri.from({ scheme: TEMPLATE_SCHEME, path: `/${o.project}/${o.repo}${ctx.location.path}`, query: JSON.stringify(ctx) });
}

/** Reads the context from an `ado-template:` URI. URIs can come from anywhere, so every field is checked. */
export function decodeContext(query: string): TemplateContext | undefined {
  let raw: any;
  try {
    raw = JSON.parse(query);
  } catch {
    return undefined;
  }
  const location = raw?.location;
  const origin = validOrigin(location?.origin);
  const self = validOrigin(raw?.self);
  if (!origin || !self || !isString(location.path) || !location.path.startsWith('/') || location.path.includes('..')) {
    return undefined;
  }
  const repos: Record<string, RepoResource> = {};
  for (const [alias, r] of Object.entries<any>(raw.repos && typeof raw.repos === 'object' ? raw.repos : {})) {
    if (r && isString(r.name) && isString(r.type)) {
      setOwn(repos, alias, { alias, name: r.name, type: r.type, ref: isString(r.ref) ? r.ref : undefined });
    }
  }
  return { location: { origin, path: location.path }, self, repos };
}

function validOrigin(o: any): Origin | undefined {
  if (o?.kind === 'remote' && isString(o.project) && isString(o.repo) && (o.ref === undefined || isString(o.ref))) {
    return { kind: 'remote', project: o.project, repo: o.repo, ref: o.ref };
  }
  // A local root must be (inside) a workspace folder: a crafted URI must not read YAML from elsewhere on disk.
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (o?.kind === 'local' && isString(o.root) && folders.some(f => f.uri.fsPath === o.root || isInside(o.root, f.uri.fsPath))) {
    return { kind: 'local', root: o.root };
  }
  return undefined;
}

/** Shows `ado-template:` documents (read-only templates from other repositories). */
export class TemplateContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly resolver: TemplateResolver) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ctx = decodeContext(uri.query);
    if (!ctx) {
      throw new Error('Invalid template link.');
    }
    return this.resolver.read(ctx.location);
  }
}

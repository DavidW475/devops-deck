import * as vscode from 'vscode';
import { AdoClient, AdoError } from '../client';
import { trimSlashes } from '../connection';
import { Wiki, WikiPage } from '../types';

export const WIKI_SCHEME = 'ado-wiki';

/** ado-wiki:/<wiki name>/<page path>.md?wiki=<id> */
export function wikiUri(wiki: Wiki, pagePath: string): vscode.Uri {
  const clean = pagePath === '/' ? '/Home' : pagePath;
  return vscode.Uri.from({ scheme: WIKI_SCHEME, path: `/${wiki.name}${clean}.md`, query: new URLSearchParams({ wiki: wiki.id }).toString() });
}

function parseWikiUri(uri: vscode.Uri): { wikiId: string; pagePath: string } {
  const wikiId = new URLSearchParams(uri.query).get('wiki') ?? '';
  const pagePath = uri.path.replace(/^\/[^/]+/, '').replace(/\.md$/, '') || '/';
  return { wikiId, pagePath };
}

/**
 * Wiki pages as Markdown files: reading loads the page, saving writes it back. The page's ETag is sent with
 * every save, so a page changed by someone else in the meantime is not overwritten.
 */
export class WikiFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly etags = new Map<string, string | undefined>();
  /** size and modification time per page as last read or written, so VS Code sees a stable file */
  private readonly stats = new Map<string, { size: number; mtime: number }>();

  constructor(private readonly client: AdoClient) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const known = this.stats.get(uri.toString()) ?? { size: 0, mtime: 0 };
    return { type: vscode.FileType.File, ctime: 0, ...known };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { wikiId, pagePath } = parseWikiUri(uri);
    try {
      const page = await this.client.getWikiPage(wikiId, pagePath);
      this.etags.set(uri.toString(), page.etag);
      const bytes = new TextEncoder().encode(page.content);
      const old = this.stats.get(uri.toString());
      // Keep the time when the content did not change, so an open editor is not reported as outdated.
      this.stats.set(uri.toString(), { size: bytes.length, mtime: old?.size === bytes.length ? old.mtime : Date.now() });
      return bytes;
    } catch (e) {
      if (e instanceof AdoError && e.status === 404) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw e;
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { wikiId, pagePath } = parseWikiUri(uri);
    const key = uri.toString();
    try {
      const etag = await this.client.saveWikiPage(wikiId, pagePath, new TextDecoder().decode(content), this.etags.get(key));
      this.etags.set(key, etag);
      this.stats.set(key, { size: content.length, mtime: Date.now() });
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (e) {
      if (e instanceof AdoError && (e.status === 409 || e.status === 412)) {
        throw vscode.FileSystemError.Unavailable('Someone else changed this page. Reopen it to get the latest version, then apply your changes again.');
      }
      throw e;
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Not supported for wiki pages.');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Delete wiki pages in the browser.');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Rename wiki pages in the browser.');
  }
}

/** Every page of the tree with its path, in wiki order. */
export function flattenPages(root: WikiPage): string[] {
  const out: string[] = [];
  const visit = (p: WikiPage) => {
    if (p.path !== '/') {
      out.push(p.path);
    }
    [...(p.subPages ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach(visit);
  };
  visit(root);
  return out;
}

const treeCache = new Map<string, { at: number; pages: Promise<string[]> }>();
const TREE_TTL = 5 * 60_000;

function pagesOf(client: AdoClient, wiki: Wiki, fresh: boolean): Promise<string[]> {
  const key = `${client.connection.orgUrl}/${wiki.id}`;
  const hit = treeCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < TREE_TTL) {
    return hit.pages;
  }
  const pages = client.getWikiPageTree(wiki.id).then(flattenPages);
  pages.catch(() => treeCache.delete(key));
  treeCache.set(key, { at: Date.now(), pages });
  return pages;
}

const EDIT: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit' };
const BROWSER: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open in browser' };

/** Quick open for wiki pages: Enter shows the rendered page, the pencil opens it for editing. */
export async function openWiki(client: AdoClient): Promise<void> {
  const wikis = await client.listWikis();
  if (!wikis.length) {
    void vscode.window.showInformationMessage('This project has no wiki yet.');
    return;
  }
  const wiki = wikis.length === 1 ? wikis[0]
    : (await vscode.window.showQuickPick(wikis.map(w => ({ label: w.name, description: w.type === 'codeWiki' ? 'code wiki' : 'project wiki', w })), { title: 'Wiki' }))?.w;
  if (!wiki) {
    return;
  }
  type Item = vscode.QuickPickItem & { path?: string; create?: boolean };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `${wiki.name} wiki`;
  qp.placeholder = 'Search page titles';
  qp.matchOnDescription = true;
  qp.busy = true;
  qp.show();
  const newPage: Item = { label: '$(add) New page…', alwaysShow: true, create: true };
  const load = (fresh: boolean) => pagesOf(client, wiki, fresh).then(pages => {
    qp.items = [...pages.map((p): Item => {
      const parts = p.split('/').filter(Boolean);
      return { label: `$(book) ${parts.at(-1)}`, description: parts.slice(0, -1).join(' / '), path: p, buttons: [EDIT, BROWSER] };
    }), newPage];
  }, e => { qp.placeholder = `Could not load pages: ${e instanceof Error ? e.message : e}`; }).finally(() => qp.busy = false);
  qp.buttons = [{ iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Reload pages' }];
  qp.onDidTriggerButton(() => { qp.busy = true; void load(true); });
  qp.onDidTriggerItemButton(e => {
    if (!e.item.path) {
      return;
    }
    qp.hide();
    if (e.button === EDIT) {
      void edit(wiki, e.item.path);
    } else {
      void vscode.env.openExternal(vscode.Uri.parse(wikiWebUrl(client, wiki, e.item.path)));
    }
  });
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (item?.create) {
      void createPage(client, wiki, qp.value);
    } else if (item?.path) {
      void vscode.commands.executeCommand('markdown.showPreview', wikiUri(wiki, item.path));
    }
  });
  qp.onDidHide(() => qp.dispose());
  void load(false);
}

async function edit(wiki: Wiki, pagePath: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(wikiUri(wiki, pagePath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function createPage(client: AdoClient, wiki: Wiki, typed: string): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: `New page in ${wiki.name}`, prompt: 'Page path, e.g. "Guides/Release process"', value: typed.trim(),
    validateInput: v => v.trim() ? undefined : 'Enter a page name',
  });
  if (!input) {
    return;
  }
  const pagePath = '/' + trimSlashes(input.trim());
  const title = pagePath.split('/').pop()!;
  await client.saveWikiPage(wiki.id, pagePath, `# ${title}\n`);
  treeCache.clear();
  await edit(wiki, pagePath);
}

function wikiWebUrl(client: AdoClient, wiki: Wiki, pagePath: string): string {
  const c = client.connection;
  return `${c.orgUrl}/${encodeURIComponent(c.project)}/_wiki/wikis/${encodeURIComponent(wiki.name)}?pagePath=${encodeURIComponent(pagePath)}`;
}

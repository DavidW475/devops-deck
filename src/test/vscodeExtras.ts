/*
 * Extra fakes on top of the vscode stub for tests of editor-facing modules (status bar, comments, quick picks,
 * git, text documents). Importing this file installs them into the stub of the current test process
 * (node:test runs every test file in its own process). Import it before the module under test.
 */
import * as stub from './vscodeStub';

type Listener = (e: any) => unknown;
const s = stub as any;
const noop = { dispose() { /* nothing to release */ } };

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c ?? 0, d ?? 0);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export class WorkspaceEdit {
  readonly inserts: { uri: unknown; at: Position; text: string }[] = [];
  readonly replaces: { uri: unknown; range: Range; text: string }[] = [];
  insert(uri: unknown, at: Position, text: string): void {
    this.inserts.push({ uri, at, text });
  }
  replace(uri: unknown, range: Range, text: string): void {
    this.replaces.push({ uri, range, text });
  }
}

/** Records listeners per event name so a test can fire them. */
export const listeners: Record<string, Listener[]> = {};
function event(name: string) {
  return (l: Listener) => {
    const list = listeners[name] ?? []; listeners[name] = list; list.push(l);
    return { dispose: () => { listeners[name] = listeners[name].filter(x => x !== l); } };
  };
}
export async function fire(name: string, e?: unknown): Promise<void> {
  await Promise.all((listeners[name] ?? []).map(l => l(e)));
}

/** Commands registered through commands.registerCommand, by id. */
export const registered = new Map<string, (...args: any[]) => any>();

export interface FakeQuickPick {
  items: any[];
  selectedItems: any[];
  activeItems: any[];
  buttons: any[];
  value: string;
  title?: string;
  placeholder?: string;
  busy: boolean;
  visible: boolean;
  disposed: boolean;
  fire(name: 'accept' | 'hide' | 'button' | 'itemButton', e?: unknown): void;
  [key: string]: any;
}
export const quickPicks: FakeQuickPick[] = [];

function createQuickPick(): FakeQuickPick {
  const handlers: Record<string, Listener[]> = {};
  const on = (name: string) => (l: Listener) => { const list = handlers[name] ?? []; handlers[name] = list; list.push(l); return noop; };
  const qp: FakeQuickPick = {
    items: [], selectedItems: [], activeItems: [], buttons: [], value: '', busy: false, visible: false, disposed: false,
    show() { qp.visible = true; },
    hide() { qp.visible = false; qp.fire('hide'); },
    dispose() { qp.disposed = true; },
    onDidAccept: on('accept'),
    onDidHide: on('hide'),
    onDidTriggerButton: on('button'),
    onDidTriggerItemButton: on('itemButton'),
    fire(name, e) { (handlers[name] ?? []).forEach(l => l(e)); },
  };
  quickPicks.push(qp);
  return qp;
}

export interface FakeThread {
  uri: any;
  range: any;
  comments: any[];
  label?: string;
  contextValue?: string;
  state?: number;
  collapsibleState?: number;
  canReply?: boolean;
  disposed: boolean;
  dispose(): void;
}
export const threads: FakeThread[] = [];
export const controllers: any[] = [];

function createCommentController(id: string, label: string) {
  const c: any = {
    id, label,
    createCommentThread(uri: unknown, range: unknown, comments: unknown[]): FakeThread {
      const t: FakeThread = { uri, range, comments, disposed: false, dispose() { t.disposed = true; } };
      threads.push(t);
      return t;
    },
    dispose() { /* stub */ },
  };
  controllers.push(c);
  return c;
}

/** Fake text document with the given lines. */
export function fakeDoc(uri: any, lines: string[], languageId = 'typescript') {
  const lineAt = (n: number) => ({
    text: lines[n], lineNumber: n, range: new Range(n, 0, n, lines[n].length),
  });
  return {
    uri, languageId, lineCount: lines.length, lineAt,
    getText(r?: Range): string {
      if (!r) {
        return lines.join('\n');
      }
      if (r.start.line === r.end.line) {
        return lines[r.start.line].slice(r.start.character, r.end.character);
      }
      const parts = lines.slice(r.start.line, r.end.line + 1);
      parts[0] = parts[0].slice(r.start.character);
      parts[parts.length - 1] = parts[parts.length - 1].slice(0, r.end.character);
      return parts.join('\n');
    },
  };
}

/** Fake editor showing a document with a selection (default: cursor at the start of the given line). */
export function fakeEditor(doc: ReturnType<typeof fakeDoc>, selection: Range = new Range(0, 0, 0, 0)) {
  return { document: doc, selection: Object.assign(selection, { active: selection.start }) };
}

/** Pretends the built-in git extension is active with these repositories. */
export function setGitRepositories(repos: unknown[] | undefined): void {
  s.extensions.getExtension = (id: string) => (id === 'vscode.git' && repos
    ? { isActive: true, activate: async () => undefined, exports: { getAPI: () => ({ repositories: repos, onDidOpenRepository: () => noop }) } }
    : undefined);
}

/** Fake git repository with an Azure Repos remote. */
export function fakeRepo(root: string, remoteUrl: string, branch?: string) {
  return {
    rootUri: { fsPath: root },
    state: { HEAD: branch ? { name: branch } : undefined, remotes: [{ name: 'origin', fetchUrl: remoteUrl }], refs: [] as any[], onDidChange: event(`repo:${root}`) },
    calls: [] as unknown[][],
  };
}

export const openedDocs: unknown[] = [];
export const shownDocs: unknown[] = [];
export const appliedEdits: WorkspaceEdit[] = [];

/** Clears what the extras recorded and resets the editor state. */
export function resetExtras(): void {
  quickPicks.length = 0;
  threads.length = 0;
  openedDocs.length = 0;
  shownDocs.length = 0;
  appliedEdits.length = 0;
  s.window.activeTextEditor = undefined;
  s.window.visibleTextEditors = [];
  s.workspace.textDocuments = [];
  s.window.state.focused = true;
  s.workspace.workspaceFolders = [];
  files.clear();
  providers.length = 0;
  setGitRepositories(undefined);
}

s.Position ??= Position;
s.Range ??= Range;
s.WorkspaceEdit ??= WorkspaceEdit;
s.CommentMode ??= { Editing: 0, Preview: 1 };
s.CommentThreadState ??= { Unresolved: 0, Resolved: 1 };
s.CommentThreadCollapsibleState ??= { Collapsed: 0, Expanded: 1 };
s.QuickPickItemKind ??= { Separator: -1, Default: 0 };
s.ProgressLocation ??= { SourceControl: 1, Window: 10, Notification: 15 };
s.Uri.from ??= (c: { scheme: string; path: string; query?: string }) => new stub.Uri(c.scheme, c.path, c.query ?? '');

Object.assign(s.window, {
  createQuickPick,
  onDidChangeActiveTextEditor: event('activeEditor'),
  onDidChangeWindowState: event('windowState'),
  registerWebviewViewProvider: () => noop,
  showTextDocument: async (doc: unknown) => { shownDocs.push(doc); return undefined; },
  createStatusBarItem: () => ({
    text: '', tooltip: undefined as unknown, command: undefined as unknown, name: '', visible: false,
    show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { /* stub */ },
  }),
});
s.window.withProgress ??= async (_o: unknown, task: (p: unknown) => Promise<unknown>) => task({ report() { /* stub */ } });
Object.assign(s.workspace, {
  onDidOpenTextDocument: event('openDoc'),
  onDidCloseTextDocument: event('closeDoc'),
  onDidChangeTextDocument: event('changeDoc'),
  onDidSaveTextDocument: event('saveDoc'),
  openTextDocument: async (uri: any) => { openedDocs.push(uri); return fakeDoc(uri, ['# Page']); },
  applyEdit: async (e: WorkspaceEdit) => { appliedEdits.push(e); return true; },
  getWorkspaceFolder: () => undefined,
  registerTextDocumentContentProvider: () => noop,
  registerFileSystemProvider: () => noop,
});
s.commands.registerCommand = (id: string, fn: (...args: any[]) => any) => {
  registered.set(id, fn);
  return { dispose: () => registered.delete(id) };
};
/** Diagnostic collections created through languages.createDiagnosticCollection, by name. */
export const diagnosticSets = new Map<string, Map<string, unknown[]>>();
/** Language providers registered through languages.register*Provider. */
export const providers: { kind: string; provider: any }[] = [];
/** Files served by workspace.fs.readFile / stat, by fsPath; findFiles returns those matching its pattern's extension. */
export const files = new Map<string, string>();
/** Adds a file to the fake file system. */
export function setFile(fsPath: string, text: string): void {
  files.set(fsPath, text);
}

class Diagnostic {
  source?: string;
  code?: unknown;
  tags?: number[];
  constructor(readonly range: unknown, readonly message: string, readonly severity: number) {}
}
class CompletionItem {
  insertText?: unknown;
  detail?: string;
  sortText?: string;
  documentation?: unknown;
  constructor(readonly label: string, readonly kind?: number) {}
}
class SnippetString {
  constructor(readonly value: string) {}
}
class Hover {
  constructor(readonly contents: unknown) {}
}
class Location {
  constructor(readonly uri: unknown, readonly range: unknown) {}
}
class CodeLens {
  constructor(readonly range: unknown, readonly command?: { title: string; command: string; arguments?: unknown[] }) {}
}
class RelativePattern {
  constructor(readonly base: string, readonly pattern: string) {}
}

function createDiagnosticCollection(name: string) {
  const set = new Map<string, unknown[]>();
  diagnosticSets.set(name, set);
  return {
    set: (uri: unknown, list: unknown[]) => set.set(String(uri), list),
    delete: (uri: unknown) => set.delete(String(uri)),
    get: (uri: unknown) => set.get(String(uri)),
    dispose() { set.clear(); },
  };
}
const register = (kind: string) => (_selector: unknown, provider: unknown) => {
  providers.push({ kind, provider });
  return noop;
};

s.languages = {
  registerCodeActionsProvider: register('codeAction'),
  setTextDocumentLanguage: async (d: unknown) => d,
  createDiagnosticCollection,
  registerCompletionItemProvider: register('completion'),
  registerHoverProvider: register('hover'),
  registerDefinitionProvider: register('definition'),
  registerCodeLensProvider: register('codeLens'),
};
s.Diagnostic ??= Diagnostic;
s.DiagnosticSeverity ??= { Error: 0, Warning: 1, Information: 2, Hint: 3 };
s.CompletionItem ??= CompletionItem;
s.CompletionItemKind ??= { Text: 0, File: 16, Module: 8, Property: 9, Constant: 20, EnumMember: 19, Snippet: 14 };
s.DiagnosticTag ??= { Unnecessary: 1, Deprecated: 2 };
s.SnippetString ??= SnippetString;
s.Hover ??= Hover;
s.Location ??= Location;
s.RelativePattern ??= RelativePattern;
s.CodeLens ??= CodeLens;
s.ViewColumn.Beside ??= -2;
const fileError = (p: string) => Object.assign(new Error(`not found: ${p}`), { code: 'FileNotFound' });
s.workspace.fs = {
  stat: async (u: { fsPath: string }) => {
    if (!files.has(u.fsPath) && ![...files.keys()].some(k => k.startsWith(u.fsPath + '/'))) {
      throw fileError(u.fsPath);
    }
    return { type: files.has(u.fsPath) ? 1 : 2 };
  },
  readFile: async (u: { fsPath: string }) => {
    if (!files.has(u.fsPath)) {
      throw fileError(u.fsPath);
    }
    return new TextEncoder().encode(files.get(u.fsPath));
  },
};
s.workspace.findFiles = async (pattern: string | RelativePattern) => {
  const base = typeof pattern === 'string' ? '' : pattern.base + '/';
  return [...files.keys()].filter(k => k.startsWith(base) && /\.ya?ml$/.test(k)).map(k => stub.Uri.file(k));
};
s.comments = { createCommentController };
resetExtras();

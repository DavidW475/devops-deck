/* Minimal stand-in for the 'vscode' module so extension code runs under node:test. Only what the tested code touches. */
import { FakeWebviewPanel, panels } from './fakeWebview';

type Listener<T> = (e: T) => void;
const noop = { dispose() { /* nothing to release */ } };

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (l: Listener<T>) => {
    this.listeners.push(l);
    return { dispose: () => { this.listeners = this.listeners.filter(x => x !== l); } };
  };
  fire(e?: T): void {
    for (const l of [...this.listeners]) {
      l(e as T);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  constructor(readonly scheme: string, readonly path: string, readonly query = '') {}
  static parse(s: string): Uri {
    const u = new URL(s);
    return new Uri(u.protocol.replace(':', ''), u.pathname, u.search.replace(/^\?/, ''));
  }
  static from(c: { scheme: string; path?: string; query?: string }): Uri {
    return new Uri(c.scheme, c.path ?? '', c.query ?? '');
  }
  static file(p: string): Uri {
    return new Uri('file', p);
  }
  static joinPath(u: Uri, ...parts: string[]): Uri {
    return new Uri(u.scheme, [u.path, ...parts].join('/'));
  }
  get fsPath(): string {
    return this.path;
  }
  with(change: { query?: string }): Uri {
    return new Uri(this.scheme, this.path, change.query ?? this.query);
  }
  toString(): string {
    return `${this.scheme}://${this.path}${this.query ? '?' + this.query : ''}`;
  }
}

export class TreeItem {
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  id?: string;
  constructor(readonly label: string, readonly collapsibleState = 0) {}
}
export class ThemeIcon {
  constructor(readonly id: string) {}
}
export class MarkdownString {
  constructor(readonly value = '') {}
}
export class CodeActionKind {
  static readonly QuickFix = new CodeActionKind('quickfix');
  constructor(readonly value: string) {}
}
export class CodeAction {
  command?: unknown;
  constructor(readonly title: string, readonly kind?: CodeActionKind) {}
}
export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    this.fn();
  }
}
export enum FileType { Unknown = 0, File = 1, Directory = 2 }
export enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }
export class FileSystemError extends Error {
  static FileNotFound(u?: unknown) { return new FileSystemError(`not found: ${u}`); }
  static NoPermissions(m?: string) { return new FileSystemError(m); }
  static Unavailable(m?: string) { return new FileSystemError(m); }
}
export enum TreeItemCollapsibleState { None, Collapsed, Expanded }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum ViewColumn { Active = -1, One = 1 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }

/** Settings by full key, e.g. 'azureDevOps.watchers'. */
export const settings: Record<string, unknown> = {};
const configListeners: Listener<{ affectsConfiguration(s: string): boolean }>[] = [];

/** Every message shown through window.show*Message. */
export const messages: string[] = [];
/** Every command run through commands.executeCommand. */
export const executed: unknown[][] = [];
/** Every terminal created through window.createTerminal. */
export const terminals: { options: unknown; shown: number }[] = [];
/** Every URI opened through env.openExternal (as string). */
export const opened: string[] = [];
/** Results returned by commands.executeCommand, by command name. */
export const commandResults: Record<string, unknown> = {};
/** Queued answers for showInputBox / showQuickPick / showSaveDialog / show*Message buttons (shifted per call; undefined when empty). */
export const answers: { inputBox: unknown[]; quickPick: unknown[]; saveDialog: unknown[]; message: unknown[] } = { inputBox: [], quickPick: [], saveDialog: [], message: [] };
/** Arguments of the last showQuickPick / showInputBox / showSaveDialog call. */
export const prompts: { quickPick?: unknown; inputBox?: unknown; saveDialog?: unknown } = {};

export const window = {
  state: { focused: true },
  showInformationMessage: async (m: string) => { messages.push(m); return answers.message.shift(); },
  showWarningMessage: async (m: string) => { messages.push(m); return answers.message.shift(); },
  showErrorMessage: async (m: string) => { messages.push(m); return answers.message.shift(); },
  setStatusBarMessage: () => noop,
  createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() { /* stub */ }, hide() { /* stub */ }, dispose() { /* stub */ } }),
  createOutputChannel: () => ({ info() { /* stub */ }, warn() { /* stub */ }, error() { /* stub */ }, appendLine() { /* stub */ }, dispose() { /* stub */ } }),
  createTreeView: () => ({ badge: undefined as unknown, description: undefined as unknown, onDidChangeVisibility: () => noop, dispose() { /* stub */ } }),
  onDidChangeWindowState: () => noop,
  createTerminal: (o: unknown) => {
    const t = { options: o, exitStatus: undefined as unknown, shown: 0, show() { t.shown++; }, dispose() { /* stub */ } };
    terminals.push(t);
    return t;
  },
  createWebviewPanel: (viewType: string, title: string, column: unknown, options?: unknown) => {
    const p = new FakeWebviewPanel(viewType, title, column, options);
    panels.push(p);
    return p;
  },
  showInputBox: async (o?: unknown) => { prompts.inputBox = o; return answers.inputBox.shift(); },
  showQuickPick: async (items: unknown, o?: unknown) => { prompts.quickPick = { items: await items, options: o }; return answers.quickPick.shift(); },
  showSaveDialog: async (o?: unknown) => { prompts.saveDialog = o; return answers.saveDialog.shift(); },
  withProgress: async <R>(_o: unknown, task: (p: { report(v: unknown): void }, t: { isCancellationRequested: boolean; onCancellationRequested: () => typeof noop }) => Promise<R>) =>
    task({ report() { /* stub */ } }, { isCancellationRequested: false, onCancellationRequested: () => noop }),
};

export const workspace = {
  workspaceFolders: [],
  getConfiguration: (section?: string) => {
    const full = (key: string) => (section ? `${section}.${key}` : key);
    return {
      get: <T>(key: string, def?: T): T => (full(key) in settings ? settings[full(key)] as T : def as T),
      inspect: (key: string) => ({ globalValue: settings[full(key)] }),
      update: async (key: string, value: unknown) => {
        settings[full(key)] = value;
        configListeners.forEach(l => l({ affectsConfiguration: (s: string) => full(key).startsWith(s) }));
      },
    };
  },
  onDidChangeConfiguration: (l: Listener<{ affectsConfiguration(s: string): boolean }>) => {
    configListeners.push(l);
    return { dispose: () => configListeners.splice(configListeners.indexOf(l), 1) };
  },
};

export const commands = {
  executeCommand: async (...args: unknown[]) => { executed.push(args); return commandResults[String(args[0])]; },
  registerCommand: () => noop,
};

export const env = { openExternal: async (u: unknown) => { opened.push(String(u)); return true; } };
export const authentication = { getSession: async () => undefined, onDidChangeSessions: () => noop };
/** Exports of active extensions by ID, e.g. extensionExports['vscode.git'] = { getAPI: () => fakeGit }. */
export const extensionExports: Record<string, unknown> = {};
export const extensions = {
  getExtension: (id: string) => (id in extensionExports ? { id, isActive: true, exports: extensionExports[id], activate: async () => extensionExports[id] } : undefined),
};

export function reset(): void {
  for (const k of Object.keys(settings)) {
    delete settings[k];
  }
  messages.length = 0;
  executed.length = 0;
  opened.length = 0;
  terminals.length = 0;
  for (const k of Object.keys(extensionExports)) {
    delete extensionExports[k];
  }
  panels.length = 0;
  for (const k of Object.keys(commandResults)) {
    delete commandResults[k];
  }
  answers.inputBox.length = 0;
  answers.quickPick.length = 0;
  answers.saveDialog.length = 0;
  answers.message.length = 0;
  delete prompts.quickPick;
  delete prompts.inputBox;
  delete prompts.saveDialog;
}

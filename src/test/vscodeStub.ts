/* Minimal stand-in for the 'vscode' module so extension code runs under node:test. Only what the tested code touches. */

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
export enum TreeItemCollapsibleState { None, Collapsed, Expanded }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum ViewColumn { Active = -1, One = 1 }

/** Settings by full key, e.g. 'azureDevOps.watchers'. */
export const settings: Record<string, unknown> = {};
const configListeners: Listener<{ affectsConfiguration(s: string): boolean }>[] = [];

/** Every message shown through window.show*Message. */
export const messages: string[] = [];
/** Every command run through commands.executeCommand. */
export const executed: unknown[][] = [];

export const window = {
  state: { focused: true },
  showInformationMessage: async (m: string) => { messages.push(m); return undefined; },
  showWarningMessage: async (m: string) => { messages.push(m); return undefined; },
  showErrorMessage: async (m: string) => { messages.push(m); return undefined; },
  setStatusBarMessage: () => noop,
  createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() { /* stub */ }, hide() { /* stub */ }, dispose() { /* stub */ } }),
  createOutputChannel: () => ({ info() { /* stub */ }, warn() { /* stub */ }, error() { /* stub */ }, appendLine() { /* stub */ }, dispose() { /* stub */ } }),
  createTreeView: () => ({ badge: undefined as unknown, description: undefined as unknown, onDidChangeVisibility: () => noop, dispose() { /* stub */ } }),
  onDidChangeWindowState: () => noop,
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
  executeCommand: async (...args: unknown[]) => { executed.push(args); return undefined; },
  registerCommand: () => noop,
};

export const env = { openExternal: async () => true };
export const authentication = { getSession: async () => undefined, onDidChangeSessions: () => noop };
export const extensions = { getExtension: () => undefined };

export function reset(): void {
  for (const k of Object.keys(settings)) {
    delete settings[k];
  }
  messages.length = 0;
  executed.length = 0;
}

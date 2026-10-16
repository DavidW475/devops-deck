/* Fake webview panels for tests. `window.createWebviewPanel` in the vscode stub returns a FakeWebviewPanel and records it in `panels`. */

type Handler = (m: unknown) => unknown;

/** The webview of a fake panel: records `html` and posted messages, and lets a test send messages from the "page". */
export class FakeWebview {
  html = '';
  options: unknown;
  readonly cspSource = 'vscode-webview://fake';
  /** Every message the extension posted to the page. */
  readonly posted: any[] = [];
  private readonly handlers: Handler[] = [];

  asWebviewUri(uri: { toString(): string }): { toString(): string } {
    return { toString: () => `vscode-webview://fake/${uri.toString()}` };
  }
  postMessage(m: unknown): Promise<boolean> {
    this.posted.push(m);
    return Promise.resolve(true);
  }
  onDidReceiveMessage(h: Handler): { dispose(): void } {
    this.handlers.push(h);
    return { dispose: () => { this.handlers.splice(this.handlers.indexOf(h), 1); } };
  }
  /** Sends a message from the page and waits for all handlers (they are usually async). */
  async send(m: unknown): Promise<void> {
    await Promise.all(this.handlers.map(h => h(m)));
    await flush();
  }
  /** Posted messages of one type. */
  ofType(type: string): any[] {
    return this.posted.filter(p => p?.type === type);
  }
  /** The last posted message of a type. */
  last(type: string): any {
    const all = this.ofType(type);
    return all.at(-1);
  }
}

/** A fake vscode.WebviewPanel. */
export class FakeWebviewPanel {
  readonly webview = new FakeWebview();
  disposed = false;
  revealed = 0;
  visible = true;
  active = true;
  iconPath: unknown;
  private readonly disposeHandlers: (() => void)[] = [];
  private readonly viewStateHandlers: ((e: unknown) => void)[] = [];

  constructor(readonly viewType: string, public title: string, readonly viewColumn: unknown, readonly options: unknown) {
    this.webview.options = options;
  }
  reveal(): void {
    this.revealed++;
  }
  onDidDispose(h: () => void): { dispose(): void } {
    this.disposeHandlers.push(h);
    return { dispose: () => { /* kept until dispose */ } };
  }
  onDidChangeViewState(h: (e: unknown) => void): { dispose(): void } {
    this.viewStateHandlers.push(h);
    return { dispose: () => { /* kept until dispose */ } };
  }
  /** Simulates the panel becoming visible or hidden. */
  setVisible(on: boolean): void {
    this.visible = on;
    this.viewStateHandlers.forEach(h => h({ webviewPanel: this }));
  }
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeHandlers.forEach(h => h());
  }
}

/** Every panel created through `window.createWebviewPanel` since the last `reset()`. */
export const panels: FakeWebviewPanel[] = [];

/** The most recently created panel. */
export function lastPanel(): FakeWebviewPanel {
  const p = panels.at(-1);
  if (!p) {
    throw new Error('no webview panel was created');
  }
  return p;
}

/** Lets pending promise callbacks and timers of 0 ms run. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise(r => setImmediate(r));
  }
}

/** The CSP nonce of a panel's HTML (`script-src 'nonce-…'`). */
export function cspNonce(html: string): string | undefined {
  const start = html.indexOf("'nonce-");
  if (start < 0) {
    return undefined;
  }
  const end = html.indexOf("'", start + 7);
  return html.slice(start + 7, end);
}

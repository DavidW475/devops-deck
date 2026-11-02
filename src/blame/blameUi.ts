import * as path from 'node:path';
import * as vscode from 'vscode';
import { AdoError } from '../client';
import { ConnectionManager, gitApi } from '../connection';
import { adoRemoteOf } from '../git';
import { errorMessage, showError } from '../util';
import { isFullSha } from './blameGit';
import { annotationText, HOVER_COMMANDS, hoverMarkdown, shortSha, stateMessage, traceRows } from './blameModel';
import type {
  AnnotationData, BlameDocument, BlameLookups, CommitLine, HoverData, LineLookup, PrLookup, TraceData, TraceRow, TraceWorkItem,
} from './blameTypes';

type Connections = Pick<ConnectionManager, 'current'>;
/** A lookup result that has a commit to show. */
type Traceable = Extract<LineLookup, { line: CommitLine }>;
type TraceItem = vscode.QuickPickItem & Pick<TraceRow, 'action'>;
type Mode = 'off' | 'statusBar' | 'inline' | 'both';

const SETTING = 'azureDevOps.blame.annotations';
const DEBOUNCE_MS = 400;
/** A document with unsaved changes is sent to git whole: wait longer after typing. */
const DIRTY_DEBOUNCE_MS = 2000;
const MODES: ReadonlySet<string> = new Set(['off', 'statusBar', 'inline', 'both']);
const HINT_TEXT = 'Another extension or VS Code already shows blame at the end of the line.';
const HINT_BUTTON = 'Use status bar instead';

const isAuth = (e: unknown): boolean => e instanceof AdoError && e.isAuthError;

const hasCommit = (lookup: LineLookup): lookup is Traceable =>
  lookup.state === 'commit' || lookup.state === 'shallow' || lookup.state === 'unpublished';

function toItem(row: TraceRow): TraceItem {
  if (row.kind === 'separator') {
    return { label: row.label, kind: vscode.QuickPickItemKind.Separator };
  }
  return { label: row.label, description: row.description, action: row.action };
}

/** The Markdown hover of a commit. Only the commands of the own links are trusted, never everything. */
function markdownOf(data: HoverData): vscode.MarkdownString {
  const md = new vscode.MarkdownString(hoverMarkdown(data, Date.now()), true);
  md.isTrusted = { enabledCommands: [...HOVER_COMMANDS] };
  md.supportHtml = false;
  return md;
}

function hoverData(lookup: LineLookup, pr?: PrLookup, workItems?: TraceWorkItem[]): HoverData | undefined {
  if (lookup.state !== 'commit' && lookup.state !== 'unpublished') {
    return undefined;
  }
  return { line: lookup.line, project: lookup.repo.project, repoName: lookup.repo.repoName, pr, workItems, unpublished: lookup.state === 'unpublished' };
}

/** The trace list (Quick Pick) and the commands around it. */
class TraceList {
  constructor(private readonly lookups: BlameLookups) {}

  /** Opens the list at once and fills it step by step. Resolves when it is filled or was closed. */
  async open(title: string, found: Traceable): Promise<void> {
    const qp = vscode.window.createQuickPick<TraceItem>();
    let closed = false;
    qp.title = title;
    qp.matchOnDescription = true;
    qp.busy = true;
    const data: TraceData = {
      line: found.line, project: found.repo.project, repoName: found.repo.repoName,
      unpublished: found.state === 'unpublished', shallow: found.state === 'shallow',
    };
    const render = (d: TraceData) => {
      if (!closed) {
        qp.items = traceRows(d, Date.now()).map(r => toItem(r));
      }
    };
    qp.onDidAccept(() => {
      const action = qp.selectedItems[0]?.action;
      if (action) {
        qp.hide();
        void vscode.commands.executeCommand(action.command, ...action.args);
      }
    });
    qp.onDidHide(() => {
      closed = true;
      qp.dispose();
    });
    render(data);
    qp.show();
    if (found.state === 'commit') {
      await this.fill(found, data, render, () => closed);
    }
    if (!closed) {
      qp.busy = false;
    }
  }

  private async fill(found: Traceable, data: TraceData, render: (d: TraceData) => void, isClosed: () => boolean): Promise<void> {
    const sha = found.line.sha;
    try {
      render({ ...data, loading: 'pr' });
      data.pr = await this.lookups.pullRequest(found.repo, sha);
      if (isClosed()) {
        return;
      }
      render({ ...data, loading: 'workItems' });
      data.workItems = await this.lookups.workItems(found.repo, sha, data.pr?.match);
      render(data);
    } catch (e) {
      if (isClosed()) {
        return;
      }
      render({ ...data, error: errorMessage(e) });
      if (isAuth(e)) {
        await showError(e);
      }
    }
  }
}

/**
 * Blame links: the command and list that trace a line to its pull request and work items, the link in the
 * built-in blame hover, and the opt-in annotation of the cursor line.
 */
export class BlameUi implements vscode.Disposable {
  private readonly list: TraceList;
  private readonly annotations: Annotations;
  private readonly disposables: vscode.Disposable[] = [];
  private started = false;

  constructor(private readonly lookups: BlameLookups, private readonly connections: Connections) {
    this.list = new TraceList(lookups);
    this.annotations = new Annotations(lookups);
  }

  /** Registers the hover link and applies the annotation setting. Safe to call twice. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.registerDetailsProvider();
    this.annotations.start();
  }

  /** Drops the caches and the silence after a failure. The extension calls it where the connection changes. */
  reset(): void {
    this.annotations.reset();
  }

  dispose(): void {
    this.annotations.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
  }

  private registerDetailsProvider(): void {
    const provider = {
      provideAvatar: () => undefined,
      provideMessageLinks: () => undefined,
      provideHoverCommands: (repository: any) => {
        if (!adoRemoteOf(repository, this.connections.current)) {
          return undefined;
        }
        return [{ title: '$(git-pull-request) Pull Request & Work Items', command: 'azureDevOps.blame.openForCommit', arguments: [repository.rootUri.fsPath] }];
      },
    };
    try {
      const registration = gitApi()?.registerSourceControlHistoryItemDetailsProvider?.(provider);
      if (registration) {
        this.disposables.push(registration);
      }
    } catch {
      // an older git extension: the link is optional
    }
  }

  /** The command: traces the line under the cursor. */
  async traceLine(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file first.');
      return;
    }
    const doc = editor.document;
    const line = editor.selection.active.line;
    const lookup = await this.lookups.lookupLine(doc, line, { explicit: true });
    const text = stateMessage(lookup, path.basename(doc.uri.fsPath), this.connections.current?.orgUrl);
    if (text || !hasCommit(lookup)) {
      await this.notify(lookup, text ?? '');
      return;
    }
    await this.list.open(`Line ${line + 1} of ${relativePath(doc.uri)}`, lookup);
  }

  /** The link in the built-in hover: traces a commit of a repository. */
  async openForCommit(root: unknown, sha: unknown): Promise<void> {
    const lookup = await this.lookups.lookupCommit(root, sha);
    const text = stateMessage(lookup, '', this.connections.current?.orgUrl);
    if (text || !hasCommit(lookup)) {
      await this.notify(lookup, text ?? '');
      return;
    }
    await this.list.open(`Commit ${shortSha(lookup.line.sha)}`, lookup);
  }

  /** Opens a commit in the browser. Arguments come from a link, so they are checked. */
  async openCommit(project: unknown, repoName: unknown, sha: unknown): Promise<void> {
    if (typeof project !== 'string' || !project || typeof repoName !== 'string' || !repoName || !isFullSha(sha)) {
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(this.lookups.commitUrl({ project, repoName }, sha)));
  }

  private async notify(lookup: LineLookup, text: string): Promise<void> {
    if (lookup.state !== 'error') {
      await vscode.window.showInformationMessage(text);
    } else {
      await vscode.window.showWarningMessage(text);
    }
  }
}

function relativePath(uri: vscode.Uri): string {
  const rel = typeof vscode.workspace.asRelativePath === 'function' ? vscode.workspace.asRelativePath(uri) : '';
  return rel || path.basename(uri.fsPath);
}

/** What the annotation currently shows. */
interface Shown {
  file: string;
  line: number;
  lookup: LineLookup;
  pr?: PrLookup;
  workItems?: TraceWorkItem[];
}

/** The opt-in annotation of the cursor line in the status bar and/or after the line. */
class Annotations {
  private mode: Mode = 'off';
  private item?: vscode.StatusBarItem;
  private decoration?: vscode.TextEditorDecorationType;
  private decorated?: vscode.TextEditor;
  private hoverReg?: vscode.Disposable;
  private shown?: Shown;
  private prCache?: { root: string; sha: string; pr: PrLookup };
  private readonly always: vscode.Disposable[] = [];
  private working: vscode.Disposable[] = [];
  private readonly hooked = new Set<unknown>();
  private readonly heads = new Map<unknown, string | undefined>();
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private seq = 0;
  private silenced = false;
  /** Files whose blame timed out or was too big: left alone until a reset, the others keep their annotations. */
  private readonly slowFiles = new Set<string>();
  private hintShown = false;

  constructor(private readonly lookups: BlameLookups) {}

  start(): void {
    this.always.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(SETTING)) {
        this.apply();
      }
    }));
    this.apply();
  }

  reset(): void {
    this.lookups.reset();
    this.silenced = false;
    this.slowFiles.clear();
    this.prCache = undefined;
    if (this.always.length) {
      this.apply();
    }
  }

  dispose(): void {
    this.teardown();
    this.always.forEach(d => d.dispose());
    this.always.length = 0;
  }

  private readMode(): Mode {
    const value = vscode.workspace.getConfiguration('azureDevOps').get<string>('blame.annotations', 'off');
    return MODES.has(value) ? value as Mode : 'off';
  }

  private get statusOn(): boolean {
    return this.mode === 'statusBar' || this.mode === 'both';
  }

  private get inlineOn(): boolean {
    return this.mode === 'inline' || this.mode === 'both';
  }

  /** Sets up or tears down what the current setting needs. */
  private apply(): void {
    this.mode = this.readMode();
    if (!this.statusOn && !this.inlineOn) {
      this.teardown();
      return;
    }
    if (!this.working.length) {
      this.listen();
    }
    if (!this.statusOn) {
      this.item?.hide();
    }
    if (this.inlineOn) {
      this.hoverReg ??= vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (d, p) => this.provideHover(d, p) });
      void this.collisionHint();
    } else {
      this.clearInline();
      this.hoverReg?.dispose();
      this.hoverReg = undefined;
    }
    this.schedule(0);
  }

  private teardown(): void {
    clearTimeout(this.timer);
    this.seq++;
    this.abort?.abort();
    this.working.forEach(d => d.dispose());
    this.working = [];
    this.hooked.clear();
    this.heads.clear();
    this.hoverReg?.dispose();
    this.hoverReg = undefined;
    this.clearInline();
    this.decoration?.dispose();
    this.decoration = undefined;
    this.item?.dispose();
    this.item = undefined;
    this.shown = undefined;
  }

  private listen(): void {
    this.working.push(
      vscode.window.onDidChangeTextEditorSelection(() => this.selectionChanged()),
      vscode.window.onDidChangeActiveTextEditor(() => this.moved()),
      vscode.window.onDidChangeWindowState(e => e.focused && this.schedule(0)),
      vscode.workspace.onDidChangeTextDocument(e => {
        // Saving fires this without changes (the dirty flag only): nothing moved, so nothing flickers.
        if (e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document) {
          this.moved();
        }
      }),
    );
  }

  /** Moving inside the annotated line changes nothing. */
  private selectionChanged(): void {
    const editor = vscode.window.activeTextEditor;
    const shown = this.shown;
    if (shown && editor?.document.uri.fsPath === shown.file && editor.selection.active.line === shown.line) {
      return;
    }
    this.moved();
  }

  /** The cursor or the text moved: whatever is shown is stale until the cursor rests again. */
  private moved(): void {
    this.invalidate();
    this.schedule(vscode.window.activeTextEditor?.document.isDirty ? DIRTY_DEBOUNCE_MS : DEBOUNCE_MS);
  }

  private invalidate(): void {
    this.seq++;
    this.abort?.abort();
    this.shown = undefined;
    this.item?.hide();
    this.clearInline();
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), ms);
  }

  /** Watches HEAD changes of every repository once. */
  private hookRepos(): void {
    for (const repo of gitApi()?.repositories ?? []) {
      if (!this.hooked.has(repo)) {
        this.hooked.add(repo);
        this.heads.set(repo, repo.state.HEAD?.commit);
        this.working.push(repo.state.onDidChange(() => {
          const head = repo.state.HEAD?.commit;
          if (head !== this.heads.get(repo)) {
            this.heads.set(repo, head);
            this.schedule(DEBOUNCE_MS);
          }
        }));
      }
    }
  }

  /** The editor to annotate: a file with exactly one selection. */
  private target(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== 'file' || (editor.selections?.length ?? 1) > 1) {
      return undefined;
    }
    return editor;
  }

  private async update(): Promise<void> {
    if (!this.statusOn && !this.inlineOn) {
      return;
    }
    const seq = ++this.seq;
    this.abort?.abort();
    this.hookRepos();
    const editor = this.target();
    if (!editor) {
      this.clearAll();
      return;
    }
    if (!vscode.window.state.focused) {
      return;
    }
    if (this.slowFiles.has(editor.document.uri.fsPath)) {
      this.clearAll();
      return;
    }
    const ac = new AbortController();
    this.abort = ac;
    const doc = editor.document;
    const line = editor.selection.active.line;
    const lookup = await this.lookups.lookupLine(doc as BlameDocument, line, { signal: ac.signal });
    if (seq !== this.seq) {
      return;
    }
    if (lookup.state === 'error') {
      this.onLookupError(lookup, doc.uri.fsPath);
      return;
    }
    const shown: Shown = { file: doc.uri.fsPath, line, lookup };
    await this.resolve(seq, editor, shown);
  }

  /** A timeout or a file too big for git's output buffer only costs that file its annotation, not every file. */
  private onLookupError(lookup: Extract<LineLookup, { state: 'error' }>, file: string): void {
    if (lookup.timedOut || lookup.tooLarge) {
      this.slowFiles.add(file);
    }
    this.clearAll();
  }

  /** Paints the local part at once and the pull request when it is known. */
  private async resolve(seq: number, editor: vscode.TextEditor, shown: Shown): Promise<void> {
    const lookup = shown.lookup;
    if (lookup.state !== 'commit' || this.silenced) {
      this.paint(editor, shown, false);
      return;
    }
    const cached = this.prCache;
    if (cached?.sha === lookup.line.sha && cached.root === lookup.repo.repo.rootUri.fsPath) {
      shown.pr = cached.pr;
      this.paint(editor, shown, false);
      return;
    }
    this.paint(editor, shown, true);
    try {
      shown.pr = await this.lookups.pullRequest(lookup.repo, lookup.line.sha, { background: true });
      if (shown.pr) {
        this.prCache = { root: lookup.repo.repo.rootUri.fsPath, sha: lookup.line.sha, pr: shown.pr };
      }
    } catch (e) {
      this.silenced = this.silenced || isAuth(e);
    }
    if (seq === this.seq) {
      this.paint(editor, shown, false);
    }
  }

  private paint(editor: vscode.TextEditor, shown: Shown, loading: boolean): void {
    const data: AnnotationData = { lookup: shown.lookup, pr: shown.pr };
    const text = annotationText(data, Date.now());
    if (text === undefined) {
      this.clearAll();
      return;
    }
    this.shown = shown;
    if (this.statusOn) {
      this.paintStatus(shown, text, loading);
    }
    if (this.inlineOn) {
      this.paintInline(editor, shown.line, text);
    }
  }

  private paintStatus(shown: Shown, text: string, loading: boolean): void {
    if (!this.item) {
      this.item = vscode.window.createStatusBarItem('azureDevOps.blame', vscode.StatusBarAlignment.Right, 199);
      this.item.name = 'DevOps Deck: Line Blame';
      this.item.command = { command: 'azureDevOps.blame.traceLine', title: 'Trace Line to Pull Request' };
    }
    this.item.text = `$(git-commit) ${text}${loading ? ' $(sync~spin)' : ''}`;
    const data = hoverData(shown.lookup, shown.pr);
    this.item.tooltip = data ? markdownOf(data) : text;
    this.item.show();
  }

  private paintInline(editor: vscode.TextEditor, line: number, text: string): void {
    this.decoration ??= vscode.window.createTextEditorDecorationType({
      after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    const end = editor.document.lineAt(line).range.end;
    editor.setDecorations(this.decoration, [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } }]);
    this.decorated = editor;
  }

  private clearInline(): void {
    if (this.decoration && this.decorated) {
      this.decorated.setDecorations(this.decoration, []);
    }
    this.decorated = undefined;
  }

  private clearAll(): void {
    this.shown = undefined;
    this.item?.hide();
    this.clearInline();
  }

  private async provideHover(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const shown = this.shown;
    if (!this.inlineOn || shown?.file !== doc.uri.fsPath || shown.line !== position.line) {
      return undefined;
    }
    if (position.character < doc.lineAt(position.line).text.length) {
      return undefined;
    }
    await this.loadWorkItems(shown);
    const data = hoverData(shown.lookup, shown.pr, shown.workItems);
    return data ? new vscode.Hover(markdownOf(data)) : undefined;
  }

  /** Work items load when the hover opens. A failure just leaves them out. */
  private async loadWorkItems(shown: Shown): Promise<void> {
    const lookup = shown.lookup;
    if (lookup.state !== 'commit' || this.silenced || shown.workItems) {
      return;
    }
    try {
      shown.workItems = await this.lookups.workItems(lookup.repo, lookup.line.sha, shown.pr?.match);
    } catch (e) {
      this.silenced = this.silenced || isAuth(e);
    }
  }

  /** Once per session: another extension may already show blame at the end of the line. */
  private async collisionHint(): Promise<void> {
    if (this.hintShown || !this.collides()) {
      return;
    }
    this.hintShown = true;
    const choice = await vscode.window.showInformationMessage(HINT_TEXT, HINT_BUTTON);
    if (choice === HINT_BUTTON) {
      try {
        await vscode.workspace.getConfiguration('azureDevOps').update('blame.annotations', 'statusBar', vscode.ConfigurationTarget.Global);
      } catch {
        // the setting stays as it is
      }
    }
  }

  private collides(): boolean {
    if (vscode.workspace.getConfiguration('git').get<boolean>('blame.editorDecoration.enabled')) {
      return true;
    }
    return !!vscode.extensions.getExtension('eamodio.gitlens') && !!vscode.workspace.getConfiguration('gitlens').get<boolean>('currentLine.enabled');
  }
}

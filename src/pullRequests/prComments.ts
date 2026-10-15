import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { PrComment, PrThread } from '../types';
import { guarded } from '../util';
import { PR_SCHEME, parsePrUri } from './prFiles';

const STATUS_NAMES = ['unknown', 'active', 'fixed', 'wontFix', 'closed', 'byDesign', 'pending'];
const STATUS_LABELS: Record<string, string> = {
  active: 'Active', fixed: 'Resolved', wontFix: "Won't fix", closed: 'Closed', byDesign: 'By design', pending: 'Pending',
};
const RESOLVED = new Set(['fixed', 'wontFix', 'closed', 'byDesign']);

function statusName(s: string | number | undefined): string {
  return typeof s === 'number' ? STATUS_NAMES[s] ?? 'unknown' : s ?? 'unknown';
}

/**
 * Azure DevOps code suggestions are fenced ```suggestion blocks holding the replacement for the commented lines.
 * VS Code doesn't know that language, so show them as a labelled code block in the file's language.
 */
function renderBody(raw: string, languageId?: string): vscode.MarkdownString {
  return new vscode.MarkdownString(raw.replace(/^([ \t]*)```suggestion[ \t]*$/gm, `$1**Suggested change:**\n$1\`\`\`${languageId ?? ''}`));
}

const suggestionText = (code: string) => '```suggestion\n' + code.replace(/\n$/, '') + '\n```';

class AdoComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  body: vscode.MarkdownString | string;
  author: vscode.CommentAuthorInformation;
  timestamp?: Date;
  /** 'ado-comment-mine' enables edit/delete in the comment's title menu, 'ado-comment-draft' is a suggestion not yet posted */
  contextValue?: string;
  /** markdown as stored in Azure DevOps (body holds the rendered form) */
  raw: string;

  constructor(c: Pick<PrComment, 'author' | 'content'> & { id?: number; publishedDate?: string }, readonly parent: vscode.CommentThread, meId?: string) {
    this.id = c.id;
    this.raw = c.content ?? '';
    this.body = renderBody(this.raw, languageOf(parent));
    this.author = { name: c.author.displayName };
    this.timestamp = c.publishedDate ? new Date(c.publishedDate) : undefined;
    this.contextValue = meId && c.author.id === meId ? 'ado-comment-mine' : undefined;
  }

  id?: number;
}

function languageOf(thread: vscode.CommentThread): string | undefined {
  return vscode.workspace.textDocuments.find(d => d.uri.toString() === thread.uri.toString())?.languageId;
}

const bodyText = (b: vscode.MarkdownString | string) => typeof b === 'string' ? b : b.value;

interface ThreadMeta {
  repo: string;
  pr: number;
  threadId?: number;
}

/** Shows Azure DevOps PR threads inline in diff editors and lets the user reply, start and resolve threads. */
export class PrCommentController implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('azureDevOps.pr', 'Azure DevOps Pull Request');
  private readonly threadsByDoc = new Map<string, vscode.CommentThread[]>();
  private readonly meta = new Map<vscode.CommentThread, ThreadMeta>();
  private readonly prThreads = new Map<string, Promise<PrThread[]>>();
  private readonly disposables: vscode.Disposable[] = [this.controller];

  constructor(private readonly client: AdoClient) {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: doc => doc.uri.scheme === PR_SCHEME && parsePrUri(doc.uri).obj
        ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)]
        : [],
    };
    this.controller.options = { prompt: 'Comment on Azure DevOps…', placeHolder: 'Markdown is supported' };
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(d => void this.loadDocument(d)),
      vscode.workspace.onDidCloseTextDocument(d => this.disposeDocument(d.uri.toString())),
      vscode.commands.registerCommand('azureDevOps.pr.submitComment', guarded((r: vscode.CommentReply) => this.submit(r))),
      vscode.commands.registerCommand('azureDevOps.pr.resolveThread', guarded((t: vscode.CommentThread) => this.setStatus(t, 2))),
      vscode.commands.registerCommand('azureDevOps.pr.reactivateThread', guarded((t: vscode.CommentThread) => this.setStatus(t, 1))),
      vscode.commands.registerCommand('azureDevOps.pr.addComment', guarded(() => this.startThreadAtSelection())),
      vscode.commands.registerCommand('azureDevOps.pr.suggestChange', guarded(() => this.startSuggestion())),
      vscode.commands.registerCommand('azureDevOps.pr.editComment', (c: AdoComment) => this.setMode(c, vscode.CommentMode.Editing)),
      vscode.commands.registerCommand('azureDevOps.pr.cancelEdit', (c: AdoComment) => this.setMode(c, vscode.CommentMode.Preview)),
      vscode.commands.registerCommand('azureDevOps.pr.saveComment', guarded((c: AdoComment) => this.saveEdit(c))),
      vscode.commands.registerCommand('azureDevOps.pr.deleteComment', guarded((c: AdoComment) => this.deleteComment(c))),
    );
    vscode.workspace.textDocuments.forEach(d => void this.loadDocument(d));
  }

  /** Drop cached threads (e.g. after a refresh) and reload open documents. */
  reload(): void {
    this.prThreads.clear();
    for (const key of [...this.threadsByDoc.keys()]) {
      this.disposeDocument(key);
    }
    vscode.workspace.textDocuments.forEach(d => void this.loadDocument(d));
  }

  private threadsFor(repo: string, pr: number): Promise<PrThread[]> {
    const key = `${repo}/${pr}`;
    let p = this.prThreads.get(key);
    if (!p) {
      p = this.client.getThreads(repo, pr);
      p.catch(() => this.prThreads.delete(key));
      this.prThreads.set(key, p);
    }
    return p;
  }

  private async loadDocument(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    if (doc.uri.scheme !== PR_SCHEME || this.threadsByDoc.has(key)) {
      return;
    }
    this.threadsByDoc.set(key, []);
    const q = parsePrUri(doc.uri);
    const filePath = doc.uri.path;
    let threads: PrThread[];
    let meId: string | undefined;
    try {
      threads = await this.threadsFor(q.repo, q.pr);
      meId = (await this.client.getMe().catch(() => undefined))?.id;
    } catch {
      this.threadsByDoc.delete(key);
      return;
    }
    const created: vscode.CommentThread[] = [];
    for (const t of threads) {
      const ctx = t.threadContext;
      if (!ctx || ctx.filePath !== filePath) {
        continue;
      }
      const start = q.side === 'right' ? ctx.rightFileStart : (!ctx.rightFileStart ? ctx.leftFileStart : undefined);
      const end = q.side === 'right' ? ctx.rightFileEnd : ctx.leftFileEnd;
      if (!start) {
        continue;
      }
      const comments = t.comments.filter(c => !c.isDeleted && c.commentType !== 'system' && c.commentType !== 3);
      if (!comments.length) {
        continue;
      }
      const range = new vscode.Range(start.line - 1, 0, Math.max(start.line, end?.line ?? start.line) - 1, 0);
      const thread = this.controller.createCommentThread(doc.uri, range, []);
      thread.comments = comments.map(c => new AdoComment(c, thread, meId));
      this.meta.set(thread, { repo: q.repo, pr: q.pr, threadId: t.id });
      this.applyStatus(thread, statusName(t.status));
      created.push(thread);
    }
    this.threadsByDoc.set(key, created);
  }

  private disposeDocument(key: string): void {
    for (const t of this.threadsByDoc.get(key) ?? []) {
      this.meta.delete(t);
      t.dispose();
    }
    this.threadsByDoc.delete(key);
  }

  private applyStatus(thread: vscode.CommentThread, status: string): void {
    const resolved = RESOLVED.has(status);
    thread.label = STATUS_LABELS[status] ?? undefined;
    thread.contextValue = resolved ? 'ado-thread-resolved' : 'ado-thread-active';
    thread.state = resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    thread.collapsibleState = resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
  }

  private async submit(reply: vscode.CommentReply): Promise<void> {
    const thread = reply.thread;
    const text = reply.text.trim();
    if (!text) {
      return;
    }
    const me = await this.client.getMe();
    const existing = this.meta.get(thread);
    if (existing?.threadId) {
      const c = await this.client.replyToThread(existing.repo, existing.pr, existing.threadId, text);
      thread.comments = [...thread.comments, new AdoComment({ ...c, author: c.author ?? me }, thread, me.id)];
      return;
    }

    await this.postNewThread(thread, text);
  }

  /** Creates the Azure DevOps thread for a comment thread started in the editor. */
  private async postNewThread(thread: vscode.CommentThread, text: string): Promise<void> {
    const me = await this.client.getMe();
    const q = parsePrUri(thread.uri);
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === thread.uri.toString());
    const endLen = doc ? doc.lineAt(Math.min(range.end.line, doc.lineCount - 1)).text.length : 0;
    const startPos = { line: range.start.line + 1, offset: 1 };
    const endPos = { line: range.end.line + 1, offset: endLen + 1 };
    const created = await this.client.createThread(q.repo, q.pr, {
      comments: [{ parentCommentId: 0, content: text, commentType: 1 }],
      status: 1,
      threadContext: q.side === 'right'
        ? { filePath: thread.uri.path, rightFileStart: startPos, rightFileEnd: endPos }
        : { filePath: thread.uri.path, leftFileStart: startPos, leftFileEnd: endPos },
      pullRequestThreadContext: {
        changeTrackingId: q.ct,
        iterationContext: { firstComparingIteration: 1, secondComparingIteration: q.iter },
      },
    });
    this.meta.set(thread, { repo: q.repo, pr: q.pr, threadId: created.id });
    const first = created.comments?.[0];
    thread.comments = [new AdoComment({ id: first?.id ?? 1, author: me, content: text, publishedDate: new Date().toISOString() }, thread, me.id)];
    this.applyStatus(thread, 'active');
    this.threadsByDoc.get(thread.uri.toString())?.push(thread);
    this.prThreads.delete(`${q.repo}/${q.pr}`);
  }

  /** The active PR diff editor and its selected whole lines, or undefined (with a hint) elsewhere. */
  private prSelection(): { editor: vscode.TextEditor; range: vscode.Range } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== PR_SCHEME || !parsePrUri(editor.document.uri).obj) {
      vscode.window.showInformationMessage('Open a pull request file diff from the Azure DevOps sidebar to comment on it.');
      return undefined;
    }
    const sel = editor.selection;
    const endLine = sel.end.line > sel.start.line && sel.end.character === 0 ? sel.end.line - 1 : sel.end.line;
    return { editor, range: new vscode.Range(sel.start.line, 0, endLine, 0) };
  }

  /** Opens an empty comment box on the selected lines of the active PR diff side. */
  private async startThreadAtSelection(): Promise<void> {
    const at = this.prSelection();
    if (!at) {
      return;
    }
    const thread = this.controller.createCommentThread(at.editor.document.uri, at.range, []);
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  /** Opens a draft comment prefilled with the selected lines as a ```suggestion block to edit and post. */
  private async startSuggestion(): Promise<void> {
    const at = this.prSelection();
    if (!at) {
      return;
    }
    const { editor, range } = at;
    if (parsePrUri(editor.document.uri).side !== 'right') {
      vscode.window.showInformationMessage('Code suggestions can only be made on the new version (right side) of the diff.');
      return;
    }
    const code = editor.document.getText(new vscode.Range(range.start, editor.document.lineAt(range.end.line).range.end));
    const me = await this.client.getMe();
    const thread = this.controller.createCommentThread(editor.document.uri, range, []);
    thread.canReply = false;
    thread.label = 'Suggest a change';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const draft = new AdoComment({ author: me, content: suggestionText(code) }, thread);
    draft.contextValue = 'ado-comment-draft';
    draft.mode = vscode.CommentMode.Editing;
    draft.body = draft.raw;
    thread.comments = [draft];
  }

  private setMode(comment: AdoComment, mode: vscode.CommentMode): void {
    const thread = comment.parent;
    if (comment.contextValue === 'ado-comment-draft') {
      thread.dispose();
      return;
    }
    comment.body = mode === vscode.CommentMode.Editing ? comment.raw : renderBody(comment.raw, languageOf(thread));
    comment.mode = mode;
    thread.comments = [...thread.comments];
  }

  private async saveEdit(comment: AdoComment): Promise<void> {
    const thread = comment.parent;
    const text = bodyText(comment.body).trim();
    if (!text) {
      return;
    }
    if (comment.contextValue === 'ado-comment-draft') {
      await this.postNewThread(thread, text);
      return;
    }
    const m = this.meta.get(thread);
    if (!m?.threadId || comment.id === undefined) {
      return;
    }
    await this.client.editComment(m.repo, m.pr, m.threadId, comment.id, text);
    comment.raw = text;
    comment.body = renderBody(text, languageOf(thread));
    comment.mode = vscode.CommentMode.Preview;
    thread.comments = [...thread.comments];
    this.prThreads.delete(`${m.repo}/${m.pr}`);
  }

  private async deleteComment(comment: AdoComment): Promise<void> {
    const thread = comment.parent;
    const m = this.meta.get(thread);
    if (!m?.threadId || comment.id === undefined) {
      return;
    }
    const ok = await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, 'Delete');
    if (ok !== 'Delete') {
      return;
    }
    await this.client.deleteComment(m.repo, m.pr, m.threadId, comment.id);
    thread.comments = thread.comments.filter(c => c !== comment);
    if (!thread.comments.length) {
      this.meta.delete(thread);
      const key = thread.uri.toString();
      this.threadsByDoc.set(key, (this.threadsByDoc.get(key) ?? []).filter(t => t !== thread));
      thread.dispose();
    }
    this.prThreads.delete(`${m.repo}/${m.pr}`);
  }

  private async setStatus(thread: vscode.CommentThread, status: number): Promise<void> {
    const m = this.meta.get(thread);
    if (!m?.threadId) {
      return;
    }
    await this.client.updateThreadStatus(m.repo, m.pr, m.threadId, status);
    this.applyStatus(thread, STATUS_NAMES[status]);
    this.prThreads.delete(`${m.repo}/${m.pr}`);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

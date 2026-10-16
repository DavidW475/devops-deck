import * as path from 'path';
import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { ConnectionManager, gitApi } from '../connection';
import { isInside, localAdoRepos } from '../git';

export async function changeWorkItemState(client: AdoClient, id: number, type: string): Promise<boolean> {
  const states = await client.getWorkItemStates(type);
  const pick = await vscode.window.showQuickPick(states.map(s => ({ label: s.name, description: s.category })),
    { title: `Change state of #${id}` });
  if (!pick) {
    return false;
  }
  await client.updateWorkItem(id, { 'System.State': pick.label });
  return true;
}

export async function assignWorkItemToMe(client: AdoClient, id: number): Promise<void> {
  const me = await client.getMe();
  await client.updateWorkItem(id, { 'System.AssignedTo': me.uniqueName ?? me.displayName });
}

export async function commentOnWorkItem(client: AdoClient, id: number): Promise<boolean> {
  const text = await vscode.window.showInputBox({ title: `Comment on #${id}`, prompt: 'Comment text' });
  if (!text) {
    return false;
  }
  await client.addWorkItemComment(id, text);
  return true;
}

export async function createWorkItem(client: AdoClient): Promise<number | undefined> {
  const type = await vscode.window.showQuickPick(client.getWorkItemTypes(), { title: 'New work item', placeHolder: 'Type' });
  if (!type) {
    return undefined;
  }
  const title = await vscode.window.showInputBox({ title: `New ${type}`, prompt: 'Title' });
  if (!title) {
    return undefined;
  }
  const assign = await vscode.window.showQuickPick(['Assign to me', 'Leave unassigned'], { title: `New ${type}` });
  if (!assign) {
    return undefined;
  }
  const fields: Record<string, unknown> = { 'System.Title': title };
  if (assign === 'Assign to me') {
    const me = await client.getMe();
    fields['System.AssignedTo'] = me.uniqueName ?? me.displayName;
  }
  const item = await client.createWorkItem(type, fields);
  void vscode.window.showInformationMessage(`Created ${type} #${item.id}.`);
  return item.id;
}

/** Creates and checks out a local branch named after the work item, e.g. "feature/1234-fix-login". */
export async function createBranchForWorkItem(client: AdoClient, connections: ConnectionManager, id: number): Promise<void> {
  const repo = await pickGitRepo(connections);
  if (!repo) {
    return;
  }
  const item = await client.getWorkItem(id);
  const slug = trimDashes(String(item.fields['System.Title']).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').slice(0, 40));
  const prefix = item.fields['System.WorkItemType'] === 'Bug' ? 'bugfix' : 'feature';
  const name = await vscode.window.showInputBox({ title: 'Create branch', value: `${prefix}/${id}-${slug}` });
  if (!name) {
    return;
  }
  await repo.createBranch(name, true);
  void vscode.window.showInformationMessage(`Switched to new branch ${name}. Mention #${id} in a commit or PR to link it.`);
}

/** The repository of the active file, the only one, or one the user picks; Azure Repos clones first. */
async function pickGitRepo(connections: ConnectionManager): Promise<any | undefined> {
  const all: any[] = gitApi()?.repositories ?? [];
  if (!all.length) {
    throw new Error('No open git repository.');
  }
  if (all.length === 1) {
    return all[0];
  }
  const file = vscode.window.activeTextEditor?.document.uri;
  const active = file?.scheme === 'file' ? all.find(r => isInside(file.fsPath, r.rootUri.fsPath)) : undefined;
  if (active) {
    return active;
  }
  const ado = new Set(localAdoRepos(connections.current).map(r => r.repo));
  const sorted = [...all].sort((a, b) => Number(ado.has(b)) - Number(ado.has(a)));
  const pick = await vscode.window.showQuickPick(sorted.map(r => ({
    label: path.basename(r.rootUri.fsPath), description: r.state.HEAD?.name, detail: r.rootUri.fsPath, r,
  })), { title: 'Create branch in…' });
  return pick?.r;
}

/** Markers of a to-do comment (the usual tags in upper case). */
const KEYWORD = /\b(TODO|FIXME|HACK|XXX|BUG)\b/;
/** Comment starts anywhere on a line, and those only valid at its start. */
const INLINE_MARKERS = ['//', '#', '/*', '<!--', '--'];
const LEADING_MARKERS = ['*', ';', "'", 'rem '];

function trimDashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '-') {
    end--;
  }
  return s.slice(0, end);
}

/** The line without leading comment markers and a trailing comment end. */
function stripCommentMarkers(line: string): string {
  let t = line.trim();
  for (let found = true; found;) {
    const marker = [...INLINE_MARKERS, ...LEADING_MARKERS].find(m => t.toLowerCase().startsWith(m));
    found = !!marker;
    t = marker ? t.slice(marker.length).trimStart() : t;
  }
  for (const end of ['*/', '-->']) {
    t = t.endsWith(end) ? t.slice(0, -end.length).trimEnd() : t;
  }
  return t;
}

/** Text after a to-do keyword: skips "(owner)" and ":" behind it. */
function afterKeyword(text: string, m: RegExpExecArray): string {
  let rest = text.slice(m.index + m[0].length).trimStart();
  if (rest.startsWith('(')) {
    const close = rest.indexOf(')');
    rest = close < 0 ? rest : rest.slice(close + 1).trimStart();
  }
  return rest.startsWith(':') ? rest.slice(1).trimStart() : rest;
}

/** Title for a work item made from a code line or selection: the to-do text without comment markers. */
export function titleFromCode(text: string): string {
  const first = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
  const noComment = stripCommentMarkers(first);
  const m = KEYWORD.exec(noComment);
  const title = (m ? afterKeyword(noComment, m) : noComment).trim();
  return title.length > 255 ? title.slice(0, 254) + '…' : title;
}

/** True for a comment whose text starts with one of the keywords in KEYWORD, right after the comment marker. */
export function isTodoLine(text: string): boolean {
  const m = KEYWORD.exec(text);
  if (!m) {
    return false;
  }
  // Only comment markers and spaces may stand between the marker and the keyword.
  const before = text.slice(0, m.index).trimEnd();
  const inline = INLINE_MARKERS.some(marker => before.endsWith(marker));
  const leading = LEADING_MARKERS.some(marker => before.trimStart().toLowerCase() === marker.trim());
  return inline || leading;
}

/**
 * Creates a work item from the selection or a to-do line: the title comes from the text, the description
 * holds the code and a link to the file in Azure Repos. A to-do comment gets the new ID right after its keyword, e.g. "(#123)".
 */
export async function createWorkItemFromCode(client: AdoClient, connections: ConnectionManager, uri?: vscode.Uri, line?: number): Promise<number | undefined> {
  const editor = vscode.window.activeTextEditor;
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
  if (!doc) {
    throw new Error('Open a file first.');
  }
  // From the context menu (uri, no line) or the palette: use the editor's selection; from the to-do light bulb: the line.
  const selection = line === undefined && editor && editor.document.uri.toString() === doc.uri.toString() && !editor.selection.isEmpty
    ? editor.selection : undefined;
  const range = selection ?? doc.lineAt(line ?? editor?.selection.active.line ?? 0).range;
  const code = doc.getText(range);
  const types = await client.getWorkItemTypes();
  const type = await vscode.window.showQuickPick([...types].sort((a, b) => Number(b === 'Task') - Number(a === 'Task') || Number(b === 'Bug') - Number(a === 'Bug')),
    { title: 'New work item from code', placeHolder: 'Type' });
  if (!type) {
    return undefined;
  }
  const title = await vscode.window.showInputBox({ title: `New ${type}`, prompt: 'Title', value: titleFromCode(code) });
  if (!title) {
    return undefined;
  }
  const where = codeLocation(connections, doc.uri, range.start.line + 1, range.end.line + 1);
  const link = where.webUrl ? ` (<a href="${escapeText(where.webUrl)}">open in Azure Repos</a>)` : '';
  const description = `<p>From <code>${escapeText(where.path)}:${range.start.line + 1}</code>${link}</p><pre><code>${escapeText(code)}</code></pre>`;
  const item = await client.createWorkItem(type, { 'System.Title': title, 'System.Description': description }, { hyperlink: where.webUrl });
  if (!selection && isTodoLine(code) && !/#\d+/.test(code)) {
    // Mark the to-do with its work item so it is not reported twice.
    const text = doc.lineAt(range.start.line).text;
    const m = KEYWORD.exec(text);
    if (m) {
      const edit = new vscode.WorkspaceEdit();
      const at = new vscode.Position(range.start.line, m.index + m[0].length);
      edit.insert(doc.uri, at, `(#${item.id})`);
      await vscode.workspace.applyEdit(edit);
    }
  }
  void vscode.window.showInformationMessage(`Created ${type} #${item.id}.`, 'Open').then(c => c && vscode.commands.executeCommand('azureDevOps.wi.open', item.id));
  return item.id;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Path relative to the repository and, for Azure Repos clones, a web link to the lines on the current branch. */
function codeLocation(connections: ConnectionManager, file: vscode.Uri, from: number, to: number): { path: string; webUrl?: string } {
  const local = localAdoRepos(connections.current).find(r => isInside(file.fsPath, r.repo.rootUri.fsPath));
  const root = local?.repo.rootUri.fsPath ?? vscode.workspace.getWorkspaceFolder(file)?.uri.fsPath;
  const rel = root ? path.relative(root, file.fsPath).split(path.sep).join('/') : path.basename(file.fsPath);
  const conn = connections.current;
  const branch = local?.repo.state.HEAD?.name;
  if (!local || !conn || !branch) {
    return { path: rel };
  }
  const q = new URLSearchParams({ path: `/${rel}`, version: `GB${branch}`, line: String(from), lineEnd: String(to + 1), lineStartColumn: '1', lineEndColumn: '1' });
  return { path: rel, webUrl: `${conn.orgUrl}/${encodeURIComponent(conn.project)}/_git/${encodeURIComponent(local.repoName)}?${q}` };
}

const ACTION_TITLE = 'Create work item from this comment';

/** Light bulb on to-do comments: "Create work item from this comment". */
export class TodoCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const line = doc.lineAt(range.start.line);
    if (!isTodoLine(line.text) || /#\d+/.test(line.text)) {
      return [];
    }
    const action = new vscode.CodeAction(ACTION_TITLE, vscode.CodeActionKind.QuickFix);
    action.command = { command: 'azureDevOps.wi.createFromCode', title: ACTION_TITLE, arguments: [doc.uri, line.lineNumber] };
    return [action];
  }
}

/**
 * Editing help for `- task: Name@Major` steps in pipeline YAML: completions (names, majors, `inputs:`, input names and
 * values), hovers, diagnostics (own collection `azureDevOps.tasks`) and quick fixes. The data comes from the task
 * catalog of the organization (`taskCatalog.ts`); the YAML logic is pure and lives in `taskRefs.ts` / `taskRules.ts`.
 * Nothing here starts a sign-in: when the catalog can't be read (no sign-in, no scope, offline) the checks stay quiet.
 */
import * as vscode from 'vscode';
import { Connection } from '../connection';
import { plural } from '../util';
import { yamlScalar } from './objectParams';
import { CatalogSnapshot, TaskCompletionContext, TaskInfo, TaskInput, TaskIndex, TaskIssue, TaskIssueCode, TaskStepRef } from './taskModel';
import { checkTaskStep, findTaskSteps, taskCompletionContext } from './taskRefs';
import { retirementOf } from './taskRetirement';
import { findInput, inputVisibility } from './taskRules';
import { mdEscape, snippetEscape } from './templateRefs';
import { isPipelineDoc, SELECTOR } from './yamlTemplates';

export const SOURCE = 'DevOps Deck';
export const REFRESH_COMMAND = 'azureDevOps.yaml.refreshTaskCatalog';
/** Microsoft's extension; it completes task names itself in `azure-pipelines` documents. */
export const OTHER_EXTENSION_ID = 'ms-azure-devops.azure-pipelines';
const DEBOUNCE_MS = 600;
const LOADING_MS = 3000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_HELP = 800;

/** What `YamlTaskSupport` needs from `TaskCatalog`, so tests can fake it. */
export interface TaskCatalogSource {
  readonly onDidChange: vscode.Event<void>;
  snapshot(): CatalogSnapshot;
  ensure(): Promise<CatalogSnapshot>;
  refreshForUnknownTask(): void;
}

const EMPTY_INDEX: TaskIndex = { all: () => [], find: () => undefined, majors: () => [], knowsName: () => false };

const ISSUE_CODES: ReadonlySet<string> = new Set<TaskIssueCode>(['missingInput', 'unknownInput', 'invalidValue', 'notInstalled', 'deprecated', 'retired', 'newerMajor']);

// ----- pure helpers -----

/** Text of a `helpMarkDown` without Markdown links and images: only the link text stays. Linear, no regexes. */
export function plainHelp(markdown: string): string {
  const s = markdown.slice(0, MAX_HELP * 2);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const link = s[i] === '!' && s[i + 1] === '[' ? linkAt(s, i + 1) : undefined;
    const text = s[i] === '[' ? linkAt(s, i) : undefined;
    if (link) {
      i = link.after;
    } else if (text) {
      out += s.slice(i + 1, text.close);
      i = text.after;
    } else {
      out += s[i];
      i++;
    }
  }
  return out.trim().slice(0, MAX_HELP);
}

/** `[text](url)` starting at `open`: where the text ends and what follows the link. */
function linkAt(s: string, open: number): { close: number; after: number } | undefined {
  const close = s.indexOf(']', open + 1);
  if (close < 0 || s[close + 1] !== '(') {
    return undefined;
  }
  const end = s.indexOf(')', close + 2);
  return end < 0 ? undefined : { close, after: end + 1 };
}

/** The link target when it is an `https:` URL, else undefined. Brackets and parentheses are escaped for Markdown. */
export function safeHelpUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.href.replaceAll('(', '%28').replaceAll(')', '%29').replaceAll('[', '%5B').replaceAll(']', '%5D') : undefined;
  } catch {
    return undefined;
  }
}

const leadingSpaces = (line: string) => line.length - line.trimStart().length;

/** The file's indentation step: the smallest indent of a non-blank, non-comment line (2 when there is none). */
export function indentUnit(lines: string[]): number {
  let unit = 0;
  for (const line of lines) {
    const t = line.trim();
    const n = leadingSpaces(line);
    if (t && !t.startsWith('#') && n > 0 && (unit === 0 || n < unit)) {
      unit = n;
    }
  }
  return Math.min(Math.max(unit, 2), 8);
}

export interface TextInsert {
  line: number;
  character: number;
  text: string;
}

function lastContentLine(lines: string[], from: number, to: number): number {
  for (let i = Math.min(to, lines.length) - 1; i > from; i--) {
    if (lines[i].trim()) {
      return i;
    }
  }
  return from;
}

/** The first line after the `inputs:` block that starts a sibling key. */
function inputsEnd(lines: string[], step: TaskStepRef): number {
  for (let i = step.inputsLine! + 1; i < step.end && i < lines.length; i++) {
    if (lines[i].trim() && leadingSpaces(lines[i]) <= step.keyCol) {
      return i;
    }
  }
  return Math.min(step.end, lines.length);
}

const hasInlineValue = (line: string, key: string) => {
  const rest = line.slice(line.indexOf(key) + key.length).trimStart();
  return rest.startsWith(':') && rest.slice(1).trim() !== '' && !rest.slice(1).trim().startsWith('#');
};

/**
 * Where and what to insert so that the step gets the input `issue.input`: a new line below the last line of its `inputs:`
 * block (same indentation as the inputs there), or an `inputs:` key with the input at the end of the step. Text is
 * inserted, never re-serialized; line breaks follow the file. Undefined when the step's inputs can't be extended (flow
 * style, expressions).
 */
export function addInputEdit(text: string, issue: TaskIssue): TextInsert | undefined {
  const step = findTaskSteps(text).find(s => s.line === issue.line);
  if (!step || !issue.input || step.dynamicInputs) {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = indentUnit(lines);
  const entry = `${issue.input}: `;
  if (step.inputsLine === undefined) {
    const last = lastContentLine(lines, step.line, step.end);
    const pad = ' '.repeat(step.keyCol);
    return { line: last, character: lines[last].length, text: `${eol}${pad}inputs:${eol}${pad}${' '.repeat(unit)}${entry}` };
  }
  if (hasInlineValue(lines[step.inputsLine], 'inputs')) {
    return undefined;
  }
  const own = step.inputs.filter(e => !e.conditional).map(e => e.start);
  const col = own.length ? Math.min(...own) : step.keyCol + unit;
  const last = lastContentLine(lines, step.inputsLine, inputsEnd(lines, step));
  return { line: last, character: lines[last].length, text: `${eol}${' '.repeat(col)}${entry}` };
}

/** Inputs that are required, have no default and show regardless of other inputs. */
function alwaysRequired(task: TaskInfo): TaskInput[] {
  return task.inputs.filter(i => i.required && (i.default ?? '') === '' && inputVisibility(task, i, new Map(), new Set()) === true);
}

/** `inputs:` with the always-required inputs as tab stops; `pad` is the indentation the editor does not add itself. */
function inputsSnippet(task: TaskInfo, pad: string, unit: number): string {
  const child = pad + ' '.repeat(unit);
  const lines = alwaysRequired(task).map((input, n) => `\n${child}${snippetEscape(input.yamlName)}: \${${n + 1}}`);
  return 'inputs:' + (lines.length ? lines.join('') : `\n${child}$0`);
}

function newestMajor(index: TaskIndex, name: string, major: number): number | undefined {
  for (const m of index.majors(name)) {
    const t = index.find(name, m);
    if (t && !t.deprecated && !t.preview) {
      return m > major ? m : undefined;
    }
  }
  return undefined;
}

const range = (line: number, start: number, end: number) => new vscode.Range(line, start, line, end);
const within = (col: number, start: number, end: number) => col >= start && col <= end;

function isSafeLabel(name: string): boolean {
  return name.length > 0 && [...name].every(c => /[\w.\-@]/.test(c));
}

/** Detail of a task name completion: title and category, or what is known about its end of life. */
function nameDetail(t: TaskInfo, index: TaskIndex): string {
  const retired = retirementOf(t.name, t.major);
  if (t.deprecated || retired) {
    return [t.deprecated ? 'deprecated' : undefined, retired ? `retires ${retired.retires}` : undefined].filter(Boolean).join(' · ');
  }
  const newer = newestMajor(index, t.name, t.major);
  return [t.title, t.category, newer === undefined ? undefined : 'older major'].filter(Boolean).join(' · ');
}

function plainDocs(text: string | undefined): vscode.MarkdownString | undefined {
  return text ? new vscode.MarkdownString(mdEscape(text)) : undefined;
}

// ----- the provider -----

export class YamlTaskSupport implements vscode.CompletionItemProvider, vscode.HoverProvider, vscode.CodeActionProvider, vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('azureDevOps.tasks');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly issues = new Map<string, TaskIssue[]>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly catalog: TaskCatalogSource, private readonly connections: { current?: Connection },
    private readonly loadingMs = LOADING_MS) {}

  /** Registers the providers and listeners; returns this for `context.subscriptions`. */
  register(): this {
    this.disposables.push(
      this.diagnostics,
      vscode.languages.registerCompletionItemProvider(SELECTOR, this, ' ', ':', '@'),
      vscode.languages.registerHoverProvider(SELECTOR, this),
      vscode.languages.registerCodeActionsProvider(SELECTOR, this, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
      vscode.workspace.onDidOpenTextDocument(d => this.schedule(d)),
      vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument(d => this.forget(d.uri)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('azureDevOps.yaml')) {
          this.scheduleAll();
        }
      }),
      this.catalog.onDidChange(() => this.scheduleAll()),
    );
    this.scheduleAll();
    return this;
  }

  dispose(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear();
    this.issues.clear();
    this.disposables.forEach(d => d.dispose());
  }

  private setting(key: string): boolean {
    return vscode.workspace.getConfiguration('azureDevOps').get<boolean>(`yaml.${key}`, true);
  }

  private active(doc: vscode.TextDocument): boolean {
    return isPipelineDoc(doc) && this.setting('taskSupport');
  }

  // ----- completions -----

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    if (!this.active(doc) || this.otherExtensionCompletes(doc)) {
      return undefined;
    }
    const text = doc.getText();
    const cc = taskCompletionContext(text, pos.line, pos.character);
    if (!cc) {
      return undefined;
    }
    const loaded = await this.load();
    if (!loaded.index) {
      return loaded.loading && cc.kind === 'taskName' ? [this.loadingItem(cc)] : undefined;
    }
    return completionItems(cc, loaded.index, text.split(/\r?\n/));
  }

  /** Microsoft's extension offers task names itself in `azure-pipelines` documents: skip ours to avoid duplicates. */
  private otherExtensionCompletes(doc: vscode.TextDocument): boolean {
    return doc.languageId === 'azure-pipelines' && vscode.extensions.getExtension(OTHER_EXTENSION_ID)?.isActive === true;
  }

  /** The catalog's data; after `loadingMs` without any data the answer says that the catalog is still loading. */
  private async load(): Promise<{ index?: TaskIndex; loading: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), this.loadingMs);
    });
    try {
      const snap = await Promise.race([this.catalog.ensure(), timeout]);
      if (snap) {
        return { index: snap.index, loading: false };
      }
      const now = this.catalog.snapshot();
      return { index: now.index, loading: !now.index };
    } finally {
      clearTimeout(timer);
    }
  }

  private loadingItem(cc: Extract<TaskCompletionContext, { kind: 'taskName' }>): vscode.CompletionItem {
    const org = this.connections.current?.orgUrl.split('/').pop() ?? 'the organization';
    const item = new vscode.CompletionItem(`Loading tasks of ${org} …`, vscode.CompletionItemKind.Text);
    item.insertText = '';
    item.filterText = cc.prefix;
    item.sortText = '￿';
    item.range = range(cc.line, cc.start, cc.end);
    return item;
  }

  // ----- hover -----

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const index = this.active(doc) ? this.catalog.snapshot().index : undefined;
    if (!index) {
      return undefined;
    }
    const step = findTaskSteps(doc.getText()).find(s => s.name !== undefined && s.major !== undefined && pos.line >= s.line && pos.line < s.end);
    const task = step && index.find(step.name!, step.major!);
    if (!step || !task) {
      return undefined;
    }
    if (pos.line === step.line) {
      return within(pos.character, step.valueStart, step.valueEnd)
        ? new vscode.Hover(this.taskMarkdown(task, step, index), range(step.line, step.valueStart, step.valueEnd)) : undefined;
    }
    const entry = step.inputs.find(e => e.line === pos.line && within(pos.character, e.start, e.end));
    const input = entry && findInput(task, entry.name);
    return entry && input ? new vscode.Hover(inputMarkdown(task, input, step), range(entry.line, entry.start, entry.end)) : undefined;
  }

  private taskMarkdown(task: TaskInfo, step: TaskStepRef, index: TaskIndex): vscode.MarkdownString {
    const head = [`${task.name}@${task.major}`, `installed ${mdEscape(task.version)}`, mdEscape(task.category)].filter(Boolean);
    const parts = [`**${mdEscape(task.title)}**  \`${head[0]}\`${head.length > 1 ? ' · ' + head.slice(1).join(' · ') : ''}`];
    if (task.description) {
      parts.push(mdEscape(task.description));
    }
    parts.push(...this.taskNotes(task, step, index));
    const url = safeHelpUrl(task.helpUrl);
    if (url) {
      parts.push(`[Learn more](${url})`);
    }
    return new vscode.MarkdownString(parts.join('\n\n'));
  }

  private taskNotes(task: TaskInfo, step: TaskStepRef, index: TaskIndex): string[] {
    const notes: string[] = [];
    const retired = retirementOf(task.name, task.major);
    if (task.deprecated) {
      notes.push('Note: this task is deprecated.');
    }
    if (retired) {
      const use = retired.replacement ? ` Use ${mdEscape(retired.replacement)}.` : '';
      notes.push(`Note: retires ${retired.retires}, removed ${retired.removed}.${use}`);
    }
    const newer = this.setting('taskVersionHints') ? newestMajor(index, task.name, step.major!) : undefined;
    if (newer !== undefined && !task.deprecated) {
      notes.push(`Note: a newer major version is available: @${newer}. Majors may break inputs.`);
    }
    return notes;
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

  private scheduleAll(): void {
    vscode.workspace.textDocuments.forEach(d => this.schedule(d));
  }

  private forget(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.clear(uri);
  }

  private clear(uri: vscode.Uri): void {
    this.diagnostics.delete(uri);
    this.issues.delete(uri.toString());
  }

  /** Marks the problems of every task step. Only a document with a task step reads the catalog (and may start its request). */
  async validate(doc: vscode.TextDocument): Promise<void> {
    if (!isPipelineDoc(doc)) {
      return;
    }
    if (!this.setting('taskSupport') || !this.setting('taskDiagnostics')) {
      this.clear(doc.uri);
      return;
    }
    const version = doc.version;
    const steps = findTaskSteps(doc.getText()).filter(s => s.name !== undefined && s.major !== undefined);
    if (!steps.length) {
      this.clear(doc.uri);
      return;
    }
    const snap = await this.catalog.ensure();
    if (doc.version !== version || doc.isClosed) {
      return;
    }
    const index = snap.index ?? EMPTY_INDEX;
    const fresh = !!snap.index && snap.status !== 'stale' && snap.fetchedAt !== undefined && Date.now() - snap.fetchedAt <= MAX_AGE_MS;
    const hints = this.setting('taskVersionHints');
    const found = steps.flatMap(s => checkTaskStep(s, index, { catalogFresh: fresh, versionHints: hints, retired: retirementOf(s.name!, s.major!) }));
    if (snap.index && steps.some(s => !index.knowsName(s.name!))) {
      this.catalog.refreshForUnknownTask();
    }
    this.issues.set(doc.uri.toString(), found);
    this.diagnostics.set(doc.uri, found.map(toDiagnostic));
  }

  // ----- quick fixes -----

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const known = this.active(doc) ? this.issues.get(doc.uri.toString()) : undefined;
    if (!known) {
      return [];
    }
    const text = doc.getText();
    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      const issue = d.source === SOURCE && ISSUE_CODES.has(String(d.code)) ? known.find(i => sameIssue(i, d)) : undefined;
      const action = issue && quickFix(doc, text, issue);
      if (action) {
        action.diagnostics = [d];
        actions.push(action);
      }
    }
    return actions;
  }
}

function sameIssue(i: TaskIssue, d: vscode.Diagnostic): boolean {
  return d.code === i.code && d.message === i.message && d.range.start.line === i.line && d.range.start.character === i.start;
}

function toDiagnostic(i: TaskIssue): vscode.Diagnostic {
  const severity = i.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
  const d = new vscode.Diagnostic(range(i.line, i.start, i.end), i.message, severity);
  d.source = SOURCE;
  d.code = i.code;
  if (i.code === 'deprecated' || i.code === 'retired') {
    d.tags = [vscode.DiagnosticTag.Deprecated];
  }
  return d;
}

function quickFix(doc: vscode.TextDocument, text: string, issue: TaskIssue): vscode.CodeAction | undefined {
  if (issue.code === 'notInstalled') {
    const action = new vscode.CodeAction('Refresh task catalog', vscode.CodeActionKind.QuickFix);
    action.command = { command: REFRESH_COMMAND, title: 'Refresh task catalog' };
    return action;
  }
  if (issue.code === 'missingInput') {
    const at = addInputEdit(text, issue);
    if (!at) {
      return undefined;
    }
    const action = new vscode.CodeAction(`Add input '${issue.input}'`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(doc.uri, new vscode.Position(at.line, at.character), at.text);
    return action;
  }
  if (issue.replacement && (issue.code === 'newerMajor' || issue.code === 'deprecated' || issue.code === 'retired')) {
    const action = new vscode.CodeAction(`Change to ${issue.replacement}`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(doc.uri, range(issue.line, issue.start, issue.end), issue.replacement);
    return action;
  }
  return undefined;
}

// ----- completion items -----

function completionItems(cc: TaskCompletionContext, index: TaskIndex, lines: string[]): vscode.CompletionItem[] | undefined {
  if (cc.kind === 'taskName') {
    return nameItems(cc, index, lines);
  }
  if (cc.kind === 'taskVersion') {
    return versionItems(cc, index);
  }
  const task = cc.step.name === undefined ? undefined : index.find(cc.step.name, cc.step.major!);
  if (!task) {
    return undefined;
  }
  if (cc.kind === 'inputsKey') {
    return [inputsKeyItem(task, lines)];
  }
  return cc.kind === 'inputName' ? inputNameItems(task, cc.step) : inputValueItems(task, cc.name);
}

function nameItems(cc: Extract<TaskCompletionContext, { kind: 'taskName' }>, index: TaskIndex, lines: string[]): vscode.CompletionItem[] {
  const seen = new Set<string>();
  const unit = indentUnit(lines);
  const step = cc.step;
  // The editor adds the indentation of the current line to every line of a snippet; the `- ` of the step is not part of it.
  const pad = step ? ' '.repeat(Math.max(step.keyCol - leadingSpaces(lines[cc.line] ?? ''), 0)) : undefined;
  const items: vscode.CompletionItem[] = [];
  for (const t of index.all()) {
    const label = `${t.name}@${t.major}`;
    if (!isSafeLabel(label) || seen.has(label.toLowerCase())) {
      continue;
    }
    seen.add(label.toLowerCase());
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Module);
    const ended = t.deprecated || !!retirementOf(t.name, t.major);
    item.range = range(cc.line, cc.start, cc.end);
    item.filterText = label;
    item.detail = nameDetail(t, index);
    item.sortText = `${ended ? '1' : '0'}${t.name.toLowerCase()}@${String(9999 - t.major).padStart(4, '0')}`;
    item.documentation = plainDocs(t.description);
    const withInputs = pad !== undefined && step?.inputsLine === undefined;
    item.insertText = withInputs ? new vscode.SnippetString(`${snippetEscape(label)}\n${pad}${inputsSnippet(t, pad, unit)}`) : label;
    items.push(item);
  }
  return items;
}

function versionItems(cc: Extract<TaskCompletionContext, { kind: 'taskVersion' }>, index: TaskIndex): vscode.CompletionItem[] {
  return index.majors(cc.name).map((major, n) => {
    const t = index.find(cc.name, major);
    const item = new vscode.CompletionItem(String(major), vscode.CompletionItemKind.Constant);
    item.range = range(cc.line, cc.start, cc.end);
    item.sortText = String(n).padStart(4, '0');
    item.detail = t ? [`installed ${t.version}`, t.deprecated ? 'deprecated' : undefined].filter(Boolean).join(' · ') : undefined;
    return item;
  });
}

function inputsKeyItem(task: TaskInfo, lines: string[]): vscode.CompletionItem {
  const item = new vscode.CompletionItem('inputs', vscode.CompletionItemKind.Snippet);
  const required = alwaysRequired(task);
  item.insertText = new vscode.SnippetString(inputsSnippet(task, '', indentUnit(lines)));
  item.detail = required.length ? `with the required ${plural(required.length, 'input')}` : `Inputs of ${task.name}@${task.major}`;
  return item;
}

function inputNameItems(task: TaskInfo, step: TaskStepRef): vscode.CompletionItem[] {
  const passed = new Map(step.inputs.map(e => [e.name, e.value] as [string, string]));
  const conditional = new Set(step.inputs.filter(e => e.conditional).map(e => e.name));
  const given = new Set(step.inputs.map(e => findInput(task, e.name)));
  return task.inputs.filter(i => !given.has(i) && inputVisibility(task, i, passed, conditional) !== false).map(input => {
    const item = new vscode.CompletionItem(input.yamlName, vscode.CompletionItemKind.Property);
    const choices = choicesOf(input);
    item.insertText = new vscode.SnippetString(`${snippetEscape(input.yamlName)}: $1`);
    if (choices.length) {
      item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest values' };
    }
    item.detail = input.required ? `${input.type} (required)` : input.type;
    item.sortText = (input.required ? '0' : '1') + input.yamlName.toLowerCase();
    item.documentation = plainDocs([input.label, plainHelp(input.help ?? '')].filter(Boolean).join('\n\n'));
    return item;
  });
}

function choicesOf(input: TaskInput): { value: string; label: string }[] {
  if (input.type === 'boolean') {
    return [{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }];
  }
  return input.options;
}

function inputValueItems(task: TaskInfo, name: string): vscode.CompletionItem[] | undefined {
  const input = findInput(task, name);
  if (!input) {
    return undefined;
  }
  return choicesOf(input).map((choice, n) => {
    const item = new vscode.CompletionItem(choice.value, vscode.CompletionItemKind.EnumMember);
    item.insertText = yamlScalar(choice.value);
    item.sortText = String(n).padStart(4, '0');
    item.detail = [choice.label === choice.value ? undefined : choice.label, choice.value === input.default ? 'default' : undefined].filter(Boolean).join(' · ') || undefined;
    return item;
  });
}

// ----- input hover -----

function ruleOf(task: TaskInfo, input: TaskInput): string {
  const group = task.groups.find(g => g.name === input.group)?.visibleRule;
  return [input.visibleRule, group].filter((r): r is string => !!r?.trim()).join(' and ');
}

function visibilityText(shown: boolean | undefined): string {
  if (shown === undefined) {
    return 'unknown';
  }
  return shown ? 'visible' : 'hidden';
}

function inputMarkdown(task: TaskInfo, input: TaskInput, step: TaskStepRef): vscode.MarkdownString {
  const passed = new Map(step.inputs.map(e => [e.name, e.value] as [string, string]));
  const conditional = new Set(step.inputs.filter(e => e.conditional).map(e => e.name));
  const shown = inputVisibility(task, input, passed, conditional);
  const state = visibilityText(shown);
  const rule = ruleOf(task, input);
  const parts = [`**${mdEscape(input.yamlName)}**  ${[mdEscape(input.label), mdEscape(input.type)].filter(Boolean).join(' · ')}`];
  if (rule) {
    parts.push(`${input.required ? 'Required' : 'Shown'} when ${mdEscape(rule)} (now: ${state})`);
  } else if (input.required) {
    parts.push('Required.');
  }
  if (input.default) {
    parts.push(`Default: ${mdEscape(input.default)}`);
  }
  const help = plainHelp(input.help ?? '');
  if (help) {
    parts.push(mdEscape(help));
  }
  return new vscode.MarkdownString(parts.join('\n\n'));
}

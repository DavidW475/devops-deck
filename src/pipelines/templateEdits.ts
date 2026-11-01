/**
 * Line edits for the pipeline designer: change, add and remove the parameters passed to a `template:` call, insert a
 * new call and add or update a `resources.repositories` entry. Pure functions on the document text: every edit
 * replaces whole lines, so formatting and comments elsewhere stay as they are, and the result maps 1:1 to
 * `WorkspaceEdit`s (native undo/redo and dirty state).
 */
import {
  defaultText, defaultValue, isBlockScalarText, normalizeText, paramLines, PassedValue, passedText, parseValueText, sameStructured, structureIssue,
  yamlScalar,
} from './objectParams';
import { TaskStepRef } from './taskModel';
import { findDisplayName } from './taskRefs';
import { ParamEntry, scanYaml, TemplateRef, YLine } from './templateRefs';
import { isBlockHeader, PipelineParameter, stripComment, unquote } from './yamlParameters';

export { yamlScalar } from './objectParams';

/** Replaces `deleteCount` whole lines starting at `line` (0-based) with `insert`. */
export interface LineEdit {
  line: number;
  deleteCount: number;
  insert: string[];
}

/** A text replacement in line/character coordinates, ready for `WorkspaceEdit.replace`. */
export interface RangeEdit {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  text: string;
}

export interface EditOptions {
  /** also write parameters whose value equals the template's default */
  writeDefaults: boolean;
}

export interface CallPlan {
  edits: LineEdit[];
  /** set when the designer must not change this call (the reason is shown to the user) */
  readOnly?: string;
}

/** The form control of a parameter; `raw` = no generic form (objects, steps, jobs, stages); `multiline` = task inputs like `inlineScript`. */
export type ControlKind = 'text' | 'number' | 'enum' | 'boolean' | 'multiline' | 'raw';

/** The key whose block holds the passed values: `parameters:` of a template call, `inputs:` of a task step. */
export type BlockKey = 'parameters' | 'inputs';

/** What a template provides, from its top-level keys. */
export type TemplateKind = 'stages' | 'jobs' | 'steps' | 'variables';

/** Where a new call can go: the end of a `stages:`, `jobs:`, `steps:` or `variables:` list. */
export interface InsertionPoint {
  kind: TemplateKind;
  /** line the new call is inserted at (after the list's last line) */
  line: number;
  /** column of the list items' dash */
  indent: number;
  /** e.g. `Stage Build › Job Compile › steps` */
  label: string;
  /** enclosing stage, if any */
  stage?: string;
}

/** Repository resource the designer writes. */
export interface RepoEntry {
  alias: string;
  name: string;
  type: string;
  /** undefined = the default branch (no `ref:` line) */
  ref?: string;
}

const KINDS = new Set<TemplateKind>(['stages', 'jobs', 'steps', 'variables']);
const pad = (n: number) => ' '.repeat(Math.max(n, 0));
const splitLines = (text: string) => text.split(/\r?\n/);
const isOwn = (o: object, k: string) => Object.hasOwn(o, k);
const indentOf = (s: string) => s.length - s.trimStart().length;

/** Text without line breaks at its end (a loop: no regex on user text). */
export function trimNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) {
    end--;
  }
  return text.slice(0, end);
}

export function controlOf(p: PipelineParameter): ControlKind {
  if (p.values?.length) {
    return 'enum';
  }
  const kinds: Record<string, ControlKind> = { string: 'text', number: 'number', boolean: 'boolean', multiline: 'multiline' };
  return isOwn(kinds, p.type) ? kinds[p.type] : 'raw';
}

/** A blank value of a task input that has no default: it means "not set", so no `opt: ''` line is written. */
const isUnset = (p: PipelineParameter, value: string) => p.unsetWhenBlank === true && value.trim() === '';

const isNumeric = (v: string) => v.trim() !== '' && Number.isFinite(Number(v));

/** A parameter value as it is written into the call: booleans and numbers unquoted, strings quoted when needed. */
export function formatValue(p: PipelineParameter, value: string): string {
  const control = controlOf(p);
  if (control === 'boolean' && /^(true|false)$/i.test(value)) {
    return value.toLowerCase();
  }
  if (control === 'number' && isNumeric(value)) {
    return value.trim();
  }
  return yamlScalar(value);
}

/** Whether two values mean the same for this parameter (`True` = `true` for booleans, `1.0` = `1` for numbers). */
export function sameValue(p: PipelineParameter, a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const control = controlOf(p);
  if (control === 'boolean') {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (control === 'number' && isNumeric(a) && isNumeric(b)) {
    return Number(a) === Number(b);
  }
  if (control === 'multiline') {
    return trimNewlines(a.replaceAll('\r\n', '\n')) === trimNewlines(b.replaceAll('\r\n', '\n'));
  }
  return a === b;
}

/** Most common indentation step of the document (2 when it can't tell). */
export function indentUnit(text: string): number {
  const counts = new Map<number, number>();
  let prev = 0;
  for (const l of scanYaml(text)) {
    if (l.blank) {
      continue;
    }
    const step = l.keyCol - prev;
    if (step > 0 && step <= 8 && !l.dash) {
      counts.set(step, (counts.get(step) ?? 0) + 1);
    }
    prev = l.keyCol;
  }
  let best = 2;
  let most = 0;
  counts.forEach((n, step) => {
    if (n > most) {
      best = step;
      most = n;
    }
  });
  return best;
}

/** End of the colon after a key that starts at `start` (quoted keys may contain colons). */
function colonAfter(text: string, start: number): number {
  let i = start;
  const q = text[i];
  if (q === '"' || q === "'") {
    const close = text.indexOf(q, i + 1);
    i = close < 0 ? i : close + 1;
  }
  return text.indexOf(':', i);
}

interface ValueSpan {
  /** column where the value starts */
  start: number;
  /** column after the value (before a trailing comment) */
  end: number;
}

/** Where the value of the `key: value` entry at column `keyCol` sits on its line. */
function valueSpan(text: string, keyCol: number): ValueSpan | undefined {
  const colon = colonAfter(text, keyCol);
  if (colon < 0) {
    return undefined;
  }
  const end = stripComment(text).trimEnd().length;
  let start = colon + 1;
  while (start < end && text[start] === ' ') {
    start++;
  }
  return { start, end: Math.max(end, start) };
}

/** The line with the value of `key` replaced; a trailing comment stays. */
export function withValue(text: string, keyCol: number, value: string): string {
  const span = valueSpan(text, keyCol);
  if (!span) {
    return text;
  }
  const head = text.slice(0, span.start).trimEnd();
  return `${head} ${value}${text.slice(span.end)}`;
}

/** True when the entry's value continues on the following lines (block scalar or nested collection). */
function isBlockValue(lines: YLine[], line: number, keyCol: number): boolean {
  const own = lines[line];
  if (own.rest && !isBlockScalarText(own.rest)) {
    return false;
  }
  const next = lines.slice(line + 1).find(l => !l.blank);
  return !!next && (next.indent > keyCol || own.rest !== '');
}

/** True when the passed parameter at (line, keyCol) has a block value (`|`, `>` or a nested collection). */
export function isBlockEntry(text: string, line: number, keyCol: number): boolean {
  const lines = scanYaml(text);
  return !!lines[line] && isBlockValue(lines, line, keyCol);
}

/** Last non-blank line nested under the key at lines[at] (the key line itself when nothing is nested). */
export function blockEnd(lines: YLine[], at: number): number {
  const col = lines[at].keyCol;
  let end = at;
  // Column of the key whose block scalar we are inside, if any.
  let scalarCol = isBlockHeader(lines[at].rest) ? col : undefined;
  for (let j = at + 1; j < lines.length && (lines[j].blank || lines[j].indent > col || (lines[j].indent === col && lines[j].dash && !lines[at].dash)); j++) {
    const l = lines[j];
    if (!l.blank) {
      end = j;
      scalarCol = isBlockHeader(l.rest) ? l.keyCol : undefined;
    } else if (l.indent > col) {
      // Lines of a block scalar (`script: |`) are scanned as blank but still belong to the block.
      end = j;
    } else if (scalarCol !== undefined && l.commentCol !== undefined && l.commentCol > scalarCol) {
      // A `# …` line inside a block scalar is text, not a comment.
      end = j;
    }
  }
  return end;
}

/** The passed value of an object/list parameter as YAML text, with the lines it spans. */
export function passedValue(text: string, entry: ParamEntry): PassedValue {
  const scanned = scanYaml(text);
  return passedText(splitLines(text), entry.line, scanned[entry.line].rest, blockEnd(scanned, entry.line));
}

export type LineMark = '+' | '~';

/** A merged edit with the mark of each inserted line. */
interface MarkedEdit extends LineEdit {
  marks: LineMark[];
}

/** Marks of one edit's inserted lines: the ones that take the place of a deleted line are changed (~), the others inserted (+). */
const marksOf = (e: LineEdit): LineMark[] => e.insert.map((_, k): LineMark => (k < e.deleteCount ? '~' : '+'));

/**
 * Sorts edits and merges the ones that touch. Inserts at the same line keep the order they were given in. This is the one
 * place that decides the order, so the preview (`applyLineEdits`) and the written text (`toRangeEdits`) agree.
 */
function mergeEdits(edits: LineEdit[]): MarkedEdit[] {
  const sorted = [...edits].sort((a, b) => a.line - b.line || b.deleteCount - a.deleteCount);
  const out: MarkedEdit[] = [];
  for (const e of sorted) {
    const last = out.at(-1);
    if (last && e.line <= last.line + last.deleteCount) {
      const extra = Math.max(0, e.line + e.deleteCount - (last.line + last.deleteCount));
      out[out.length - 1] = {
        line: last.line, deleteCount: last.deleteCount + extra, insert: [...last.insert, ...e.insert], marks: [...last.marks, ...marksOf(e)],
      };
    } else {
      out.push({ ...e, insert: [...e.insert], marks: marksOf(e) });
    }
  }
  return out;
}

/** Sorts edits and merges the ones that touch, so the result has no overlapping or adjacent ranges. */
export function normalizeEdits(edits: LineEdit[]): LineEdit[] {
  return mergeEdits(edits).map(({ line, deleteCount, insert }) => ({ line, deleteCount, insert }));
}

/**
 * Applies line edits; returns the new text and, per new line number, whether it was changed (~) or inserted (+).
 * The edits are merged like the ones written to the document (`toRangeEdits`), but each edit keeps its own marks, so a
 * removed line next to inserted ones does not turn them into "changed" lines.
 */
export function applyLineEdits(text: string, edits: LineEdit[]): { text: string; marks: Map<number, LineMark> } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rows: { text: string; mark?: LineMark }[] = splitLines(text).map(t => ({ text: t }));
  for (const e of mergeEdits(edits).reverse()) {
    rows.splice(e.line, e.deleteCount, ...e.insert.map((t, k): { text: string; mark: LineMark } => ({ text: t, mark: e.marks[k] })));
  }
  const marks = new Map<number, LineMark>();
  rows.forEach((r, n) => {
    if (r.mark) {
      marks.set(n, r.mark);
    }
  });
  return { text: rows.map(r => r.text).join(eol), marks };
}

/** Line edits as text replacements on a document with these lines (handles a last line without line break). */
export function toRangeEdits(text: string, edits: LineEdit[]): RangeEdit[] {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const n = lines.length;
  return normalizeEdits(edits).map(e => {
    const end = e.line + e.deleteCount;
    if (end < n) {
      return { startLine: e.line, startChar: 0, endLine: end, endChar: 0, text: e.insert.map(l => l + eol).join('') };
    }
    // Up to the end of the document: there is no line break after the last line to replace up to.
    const last = n - 1;
    if (e.line === 0) {
      return { startLine: 0, startChar: 0, endLine: last, endChar: lines[last].length, text: e.insert.join(eol) };
    }
    const from = Math.min(e.line, n) - 1;
    const body = e.insert.length ? eol + e.insert.join(eol) : '';
    return { startLine: from, startChar: lines[from].length, endLine: last, endChar: lines[last].length, text: body };
  });
}

/** Template kind from its top-level keys (the first of stages, jobs, steps, variables). */
export function templateKind(text: string): TemplateKind | undefined {
  const top = scanYaml(text).filter(l => !l.blank && l.indent === 0 && !l.dash && l.key);
  return top.map(l => l.key as TemplateKind).find(k => KINDS.has(k));
}

/** Column of the parameters under `parameters:` at lines[at], or undefined when the block is empty. */
function childCol(lines: YLine[], at: number): number | undefined {
  const next = lines.slice(at + 1).find(l => !l.blank);
  return next && next.indent > lines[at].keyCol ? next.keyCol : undefined;
}

interface CallScope {
  lines: string[];
  scanned: YLine[];
  ref: TemplateRef;
  unit: number;
  /** column of the parameter keys */
  col: number;
  edits: LineEdit[];
  /** line after which new parameter lines go */
  insertAt: number;
  added: string[];
  removed: number;
}

function addParam(s: CallScope, name: string, value: string): void {
  s.added.push(`${pad(s.col)}${yamlScalar(name)}: ${value}`);
}

/** A scalar value as text: a plain value, or the body of a block scalar (`|`, `|-`, `>`) without its indentation. */
export interface ScalarText {
  /** the block scalar header as written (`|-`); undefined for a value on the key's line */
  header?: string;
  text: string;
  /** last line of the value */
  end: number;
  /** column of the block's lines */
  childCol?: number;
}

/** The value of a passed key as text; undefined when it is a nested collection (not a scalar). */
export function scalarValue(text: string, entry: ParamEntry): ScalarText | undefined {
  return scalarOf(splitLines(text), scanYaml(text), entry);
}

function scalarOf(lines: string[], scanned: YLine[], entry: ParamEntry): ScalarText | undefined {
  const l = scanned[entry.line];
  if (!l) {
    return undefined;
  }
  if (l.rest && !isBlockScalarText(l.rest)) {
    return { text: entry.value, end: entry.line };
  }
  const end = blockEnd(scanned, entry.line);
  if (!l.rest) {
    return end > entry.line ? undefined : { text: '', end: entry.line };
  }
  const body = lines.slice(entry.line + 1, end + 1);
  const content = body.filter(x => x.trim());
  const childCol = content.length ? Math.min(...content.map(indentOf)) : undefined;
  const cut = childCol ?? 0;
  return { header: l.rest, text: trimNewlines(body.map(x => x.slice(Math.min(cut, indentOf(x))).trimEnd()).join('\n')), end, childCol };
}

/**
 * `|` with an indentation indicator when the first line starts with spaces (YAML would read them as the block's
 * indentation). The indicator is the body's column minus the key's column (1 to 9); the readers accept `|2-` and `|-2`.
 */
function blockHeader(header: string, text: string, keyCol: number, bodyCol: number): string {
  const indicator = bodyCol - keyCol;
  const written = /\d/.exec(header)?.[0];
  if (written !== undefined && Number(written) === indicator) {
    return header;
  }
  // A stale indicator (the body moved) is dropped; one is added only when the first line starts with spaces.
  const base = header.replace(/\d/, '');
  const first = text.split('\n').find(x => x.trim());
  return first?.startsWith(' ') && indicator >= 1 && indicator <= 9 ? `${base[0]}${indicator}${base.slice(1)}` : base;
}

/** Lines of a block scalar below an existing key line: the text indented at `col`, empty lines stay empty. */
function blockBody(text: string, col: number): string[] {
  return text.split('\n').map(x => (x ? pad(col) + x : ''));
}

/** `key: value` for a multi-line input: one line for a single line of text, else a `|` block scalar. */
function multilineLines(p: PipelineParameter, text: string, col: number, unit: number): string[] {
  if (!text.includes('\n')) {
    return [`${pad(col)}${yamlScalar(p.name)}: ${formatValue(p, text)}`];
  }
  return [`${pad(col)}${yamlScalar(p.name)}: ${blockHeader('|', text, col, col + unit)}`, ...blockBody(text, col + unit)];
}

/** A multi-line input (`inlineScript: |`): replace, remove or add it; an existing header (`|-`) and the key's spelling stay. */
function planMultiline(s: CallScope, p: PipelineParameter, entry: ParamEntry | undefined, pending: Record<string, string>, opts: EditOptions): void {
  if (!isOwn(pending, p.name)) {
    if (opts.writeDefaults && !entry && p.default) {
      s.added.push(...multilineLines(p, p.default, s.col, s.unit));
    }
    return;
  }
  const text = trimNewlines(pending[p.name].replaceAll('\r\n', '\n'));
  const write = (opts.writeDefaults || p.default === undefined || text !== trimNewlines(p.default)) && !isUnset(p, text);
  if (!entry) {
    if (write) {
      s.added.push(...multilineLines(p, text, s.col, s.unit));
    }
    return;
  }
  const current = scalarOf(s.lines, s.scanned, entry);
  if (!current) {
    return;
  }
  const deleteCount = current.end - entry.line + 1;
  if (!write) {
    s.edits.push({ line: entry.line, deleteCount, insert: [] });
    s.removed += s.scanned.slice(entry.line, current.end + 1).filter(l => !l.blank).length;
  } else if (text !== current.text) {
    const line = s.lines[entry.line];
    if (!current.header && !text.includes('\n')) {
      s.edits.push({ line: entry.line, deleteCount, insert: [withValue(line, entry.start, formatValue(p, text))] });
      return;
    }
    // An indicator needs a column 1 to 9 right of the key; else the body moves to the file's indentation.
    const near = current.childCol !== undefined && current.childCol > entry.start && current.childCol - entry.start <= 9;
    const bodyCol = near ? current.childCol! : entry.start + s.unit;
    const header = blockHeader(current.header ?? '|', text, entry.start, bodyCol);
    s.edits.push({ line: entry.line, deleteCount, insert: [withValue(line, entry.start, header), ...blockBody(text, bodyCol)] });
  }
}

/** One declared parameter: replace, remove or add its line as the pending value asks. */
function planParam(s: CallScope, p: PipelineParameter, pending: Record<string, string>, opts: EditOptions): void {
  if (s.ref.params.some(e => e.name === p.name && e.conditional)) {
    return;
  }
  const entry = s.ref.params.find(e => e.name === p.name);
  if (controlOf(p) === 'raw') {
    planStructured(s, p, entry, pending, opts);
    return;
  }
  if (controlOf(p) === 'multiline') {
    planMultiline(s, p, entry, pending, opts);
    return;
  }
  if (entry && isBlockValue(s.scanned, entry.line, entry.start)) {
    return;
  }
  if (!isOwn(pending, p.name)) {
    if (opts.writeDefaults && !entry && p.default !== undefined && !isUnset(p, p.default)) {
      addParam(s, p.name, formatValue(p, p.default));
    }
    return;
  }
  const value = pending[p.name];
  const write = (opts.writeDefaults || p.default === undefined || !sameValue(p, value, p.default)) && !isUnset(p, value);
  if (entry && write && !sameValue(p, entry.value, value)) {
    s.edits.push({ line: entry.line, deleteCount: 1, insert: [withValue(s.lines[entry.line], entry.start, formatValue(p, value))] });
  } else if (entry && !write) {
    s.edits.push({ line: entry.line, deleteCount: 1, insert: [] });
    s.removed++;
  } else if (!entry && write) {
    addParam(s, p.name, formatValue(p, value));
  }
}

/** True when an object/list value can be written: not empty and matching its type. */
const writable = (p: PipelineParameter, text: string) => !!normalizeText(text) && !structureIssue(p, text);

/** An object/list parameter: replace, remove or add its lines (the whole nested block) as the pending YAML text asks. */
function planStructured(s: CallScope, p: PipelineParameter, entry: ParamEntry | undefined, pending: Record<string, string>,
  opts: EditOptions): void {
  if (!isOwn(pending, p.name)) {
    const def = defaultText(p, s.unit);
    if (opts.writeDefaults && !entry && def !== undefined) {
      s.added.push(...paramLines(p.name, def, s.col, s.col + s.unit));
    }
    return;
  }
  const text = pending[p.name];
  if (!writable(p, text)) {
    return;
  }
  const def = defaultValue(p);
  const write = opts.writeDefaults || def === undefined || !sameStructured(parseValueText(text), def);
  if (!entry) {
    if (write) {
      s.added.push(...paramLines(p.name, text, s.col, s.col + s.unit));
    }
    return;
  }
  const passed = passedText(s.lines, entry.line, s.scanned[entry.line].rest, blockEnd(s.scanned, entry.line));
  const deleteCount = passed.end - entry.line + 1;
  if (write && passed.text !== normalizeText(text)) {
    s.edits.push({ line: entry.line, deleteCount, insert: paramLines(p.name, text, entry.start, passed.childCol ?? entry.start + s.unit) });
  } else if (!write) {
    s.edits.push({ line: entry.line, deleteCount, insert: [] });
    s.removed += s.scanned.slice(entry.line, passed.end + 1).filter(l => !l.blank).length;
  }
}

/** Why the designer can't edit the parameters (`inputs` of a task step) of this call, if it can't. */
export function callReadOnlyReason(text: string, ref: TemplateRef, blockKey: BlockKey = 'parameters'): string | undefined {
  if (!ref.target) {
    return blockKey === 'inputs'
      ? 'The task name is an expression: it is only known when the pipeline runs.'
      : 'The template path is an expression: it is only known when the pipeline runs.';
  }
  const lines = scanYaml(text);
  const paramsLine = ref.paramsLine === undefined ? undefined : lines[ref.paramsLine];
  const expressionKeys = paramsLine ? expressionKeysOf(lines, paramsLine) : [];
  if (paramsLine?.rest.startsWith('${{') || expressionKeys.some(k => !CONDITION_KEY.test(k))) {
    return `The ${blockKey} are built with expressions (\${{ }}): edit them in the text.`;
  }
  if (paramsLine?.rest) {
    return `The ${blockKey} are written as one flow mapping ({ … }): edit them in the text.`;
  }
  return undefined;
}

/** `${{ if … }}`, `${{ elseif … }}` and `${{ else }}`: the parameters under them are read-only, the others stay editable. */
const CONDITION_KEY = /^\$\{\{\s*(if|elseif|else)\b/;

/** Expression keys (`${{ … }}:`) directly under a `parameters:` key. */
function expressionKeysOf(lines: YLine[], paramsLine: YLine): string[] {
  const col = childCol(lines, paramsLine.n);
  const end = blockEnd(lines, paramsLine.n);
  return lines.slice(paramsLine.n + 1, end + 1).filter(l => !l.blank && l.keyCol === col && l.key?.includes('${{')).map(l => l.key!);
}

/**
 * Edits that make the parameters of an existing call match `pending` (name → value, only the parameters the user
 * changed). A value equal to the default removes the line unless `writeDefaults` is on; parameters under
 * `${{ if }}` / `${{ each }}` and non-scalar block values are never touched. `blockKey` is `inputs` for task steps
 * (`asTemplateRef` in `taskRefs.ts`).
 */
export function planCallEdits(text: string, ref: TemplateRef, declared: PipelineParameter[], pending: Record<string, string>,
  opts: EditOptions, blockKey: BlockKey = 'parameters'): CallPlan {
  const readOnly = callReadOnlyReason(text, ref, blockKey);
  if (readOnly) {
    return { edits: [], readOnly };
  }
  const scanned = scanYaml(text);
  const unit = indentUnit(text);
  const hasKey = ref.paramsLine !== undefined;
  const keyCol = hasKey ? scanned[ref.paramsLine!].keyCol : ref.keyCol;
  const firstParam = ref.params.find(e => !e.conditional);
  const col = firstParam?.start ?? (hasKey ? childCol(scanned, ref.paramsLine!) : undefined) ?? keyCol + unit;
  const s: CallScope = {
    lines: splitLines(text), scanned, ref, unit, col, edits: [], added: [], removed: 0,
    insertAt: (hasKey ? blockEnd(scanned, ref.paramsLine!) : ref.end) + 1,
  };
  declared.forEach(p => planParam(s, p, pending, opts));
  if (s.added.length) {
    s.edits.push({ line: s.insertAt, deleteCount: 0, insert: hasKey ? s.added : [`${pad(keyCol)}${blockKey}:`, ...s.added] });
  }
  const nested = hasKey ? scanned.slice(ref.paramsLine! + 1, s.insertAt).filter(l => !l.blank).length : 0;
  if (hasKey && !s.added.length && s.removed > 0 && s.removed === nested) {
    // Nothing left under the key: drop it as well.
    s.edits.push({ line: ref.paramsLine!, deleteCount: 1, insert: [] });
  }
  return { edits: s.edits.toSorted((a, b) => a.line - b.line) };
}

/**
 * The lines of a new `- template:` call at `indent`. Required parameters without a value are written as `''` so they
 * show up in the preview (the form reports them before anything is inserted); object/list parameters are written
 * when the form has a value for them.
 */
export function newCallLines(templatePath: string, declared: PipelineParameter[], pending: Record<string, string>, indent: number,
  unit: number, opts: EditOptions): string[] {
  const inner = indent + 2;
  const params: string[] = [];
  for (const p of declared) {
    if (controlOf(p) === 'raw') {
      params.push(...newStructuredLines(p, pending, inner + unit, unit, opts));
      continue;
    }
    const value = isOwn(pending, p.name) ? pending[p.name] : p.default;
    const write = opts.writeDefaults || p.default === undefined || !sameValue(p, value, p.default);
    if (write) {
      params.push(`${pad(inner + unit)}${yamlScalar(p.name)}: ${formatValue(p, value ?? '')}`);
    }
  }
  const head = `${pad(indent)}- template: ${yamlScalar(templatePath)}`;
  return params.length ? [head, `${pad(inner)}parameters:`, ...params] : [head];
}

/** An object/list parameter of a new call: the pending YAML text, or the default with "Write defaults". */
function newStructuredLines(p: PipelineParameter, pending: Record<string, string>, col: number, unit: number, opts: EditOptions): string[] {
  const def = defaultValue(p);
  if (!isOwn(pending, p.name)) {
    const text = opts.writeDefaults ? defaultText(p, unit) : undefined;
    return text === undefined ? [] : paramLines(p.name, text, col, col + unit);
  }
  const text = pending[p.name];
  const write = opts.writeDefaults || def === undefined || !sameStructured(parseValueText(text), def);
  return write && writable(p, text) ? paramLines(p.name, text, col, col + unit) : [];
}

/** `key: value` lines of a task input (a block scalar for multi-line text). */
function inputLines(p: PipelineParameter, value: string, col: number, unit: number): string[] {
  return controlOf(p) === 'multiline' ? multilineLines(p, trimNewlines(value), col, unit) : [`${pad(col)}${yamlScalar(p.name)}: ${formatValue(p, value)}`];
}

/**
 * The lines of a new `- task: Name@Major` step at `indent`: `displayName`, then `inputs:` with the inputs that differ from
 * their default (all with `writeDefaults`). Required inputs without a value are written as `''` so they show in the
 * preview; the form reports them before anything is inserted.
 */
export function newTaskLines(taskRef: string, declared: PipelineParameter[], pending: Record<string, string>, indent: number, unit: number,
  opts: EditOptions, displayName?: string): string[] {
  const inner = indent + 2;
  const out = [`${pad(indent)}- task: ${yamlScalar(taskRef)}`];
  const name = displayName?.trim();
  if (name) {
    out.push(`${pad(inner)}displayName: ${yamlScalar(name)}`);
  }
  const inputs: string[] = [];
  for (const p of declared) {
    const value = isOwn(pending, p.name) ? pending[p.name] : p.default;
    if ((opts.writeDefaults || p.default === undefined || !sameValue(p, value, p.default)) && !isUnset(p, value ?? '')) {
      inputs.push(...inputLines(p, value ?? '', inner + unit, unit));
    }
  }
  return inputs.length ? [...out, `${pad(inner)}inputs:`, ...inputs] : out;
}

/** Edit that moves a task step to another major version: only the `task:` line changes (a comment after it stays). */
export function planTaskVersion(text: string, step: TaskStepRef, major: number): LineEdit[] {
  const at = step.raw.indexOf('@');
  const next = `${step.raw.slice(0, Math.max(at, 0))}@${major}`;
  if (at < 1 || next === step.raw) {
    return [];
  }
  const line = splitLines(text)[step.line];
  return [{ line: step.line, deleteCount: 1, insert: [line.slice(0, step.valueStart) + next + line.slice(step.valueEnd)] }];
}

/** Edit for the `displayName:` of a step: set, change or (empty value) remove it. */
export function planDisplayName(text: string, step: TaskStepRef, value: string): LineEdit[] {
  const next = value.trim();
  const found = findDisplayName(text, step);
  if (!found) {
    return next ? [{ line: step.line + 1, deleteCount: 0, insert: [`${pad(step.keyCol)}displayName: ${yamlScalar(next)}`] }] : [];
  }
  if (found.value === next) {
    return [];
  }
  const insert = next ? [withValue(splitLines(text)[found.line], found.keyCol, yamlScalar(next))] : [];
  return [{ line: found.line, deleteCount: 1, insert }];
}

interface Where {
  stage?: string;
  job?: string;
}

function noteHead(out: Where, l: YLine): void {
  if (l.dash && l.key === 'stage') {
    out.stage ??= unquote(l.rest);
  } else if (l.dash && (l.key === 'job' || l.key === 'deployment')) {
    out.job ??= unquote(l.rest);
  }
}

/**
 * Names of the stage and job a line belongs to. Walks up: a line further left is an ancestor; a `- key:` line at the
 * current column is the head of the current mapping (e.g. `- job: Build` above its `steps:`).
 */
function enclosing(lines: YLine[], at: number): Where {
  const out: Where = {};
  const self = lines[at];
  let col = self.dash ? self.indent + 1 : self.keyCol;
  for (let j = at - 1; j >= 0 && col > 0; j--) {
    const l = lines[j];
    if (!l.blank && (l.keyCol < col || (l.keyCol === col && l.dash))) {
      noteHead(out, l);
      col = l.dash ? l.indent + 1 : l.keyCol;
    }
  }
  return out;
}

/** Stage and job of the line (for grouping template calls in the structure strip). */
export function locationOf(text: string, line: number): Where {
  const lines = scanYaml(text);
  return lines[line] ? enclosing(lines, line) : {};
}

function pointLabel(kind: TemplateKind, stage?: string, job?: string): string {
  const parts = [stage ? `Stage ${stage}` : '', job ? `Job ${job}` : '', kind].filter(Boolean);
  return parts.join(' › ');
}

/** Item column and last line of the list under the key at lines[i] (a `key:` with nothing after the colon). */
function listShape(lines: YLine[], i: number, unit: number): { indent: number; end: number } | undefined {
  const l = lines[i];
  const next = lines.slice(i + 1).find(x => !x.blank);
  const nestedList = next && next.dash && (next.indent > l.keyCol || (next.indent === l.keyCol && !l.dash));
  if (nestedList) {
    return { indent: next.indent, end: blockEnd(lines, i) };
  }
  const empty = !next || next.indent <= l.keyCol;
  return empty ? { indent: l.keyCol + unit, end: i } : undefined;
}

/** Every list a template of this kind can be added to, in document order (also lists passed as template parameters). */
export function findInsertionPoints(text: string, kind: TemplateKind): InsertionPoint[] {
  const lines = scanYaml(text);
  const unit = indentUnit(text);
  const out: (InsertionPoint & { keyLine: number })[] = [];
  for (const l of lines) {
    if (l.blank || l.key !== kind || l.rest) {
      continue;
    }
    const where = enclosing(lines, l.n);
    const shape = listShape(lines, l.n, unit);
    if (shape) {
      out.push({ kind, line: shape.end + 1, indent: shape.indent, label: pointLabel(kind, where.stage, where.job), stage: where.stage, keyLine: l.n });
    }
  }
  // Several lists in one job (e.g. canary / rolling / runOnce): tell them apart by line.
  return out.map(({ keyLine, ...p }) => (out.filter(o => o.label === p.label).length > 1 ? { ...p, label: `${p.label} (line ${keyLine + 1})` } : p));
}

/** Stage names of the document in order (`- stage: Name`). */
export function stageNames(text: string): string[] {
  return scanYaml(text).filter(l => !l.blank && l.dash && l.key === 'stage' && l.rest).map(l => unquote(l.rest));
}

interface RepoItem {
  start: number;
  end: number;
  /** column of the item's keys */
  keyCol: number;
  keys: Map<string, YLine>;
}

/** The items of `resources.repositories`, with the lines they span. */
function repositoryItems(lines: YLine[], reposAt: number): RepoItem[] {
  const end = blockEnd(lines, reposAt);
  const items: RepoItem[] = [];
  let itemIndent = -1;
  for (let j = reposAt + 1; j <= end; j++) {
    const l = lines[j];
    if (l.blank) {
      continue;
    }
    if (l.dash && (itemIndent < 0 || l.indent === itemIndent)) {
      itemIndent = l.indent;
      items.push({ start: j, end: j, keyCol: l.keyCol, keys: new Map() });
    }
    const item = items.at(-1);
    if (item) {
      item.end = j;
      if (l.keyCol === item.keyCol && l.key) {
        item.keys.set(l.key, l);
      }
    }
  }
  return items;
}

function topLevel(lines: YLine[], key: string): YLine | undefined {
  return lines.find(l => !l.blank && l.indent === 0 && !l.dash && l.key === key);
}

function childKey(lines: YLine[], parent: YLine, key: string): YLine | undefined {
  const end = blockEnd(lines, parent.n);
  const col = childCol(lines, parent.n);
  return lines.slice(parent.n + 1, end + 1).find(l => !l.blank && l.keyCol === col && !l.dash && l.key === key);
}

function repoItemLines(repo: RepoEntry, indent: number): string[] {
  const inner = pad(indent + 2);
  const out = [`${pad(indent)}- repository: ${yamlScalar(repo.alias)}`, `${inner}type: ${yamlScalar(repo.type)}`, `${inner}name: ${yamlScalar(repo.name)}`];
  return repo.ref ? [...out, `${inner}ref: ${yamlScalar(repo.ref)}`] : out;
}

/** Edits for an existing entry: set, change or remove its `ref:`. */
function updateRepoItem(src: string[], item: RepoItem, ref: string | undefined): LineEdit[] {
  const line = item.keys.get('ref');
  if (line && ref === undefined) {
    return [{ line: line.n, deleteCount: 1, insert: [] }];
  }
  if (line && ref !== undefined && unquote(line.rest) !== ref) {
    return [{ line: line.n, deleteCount: 1, insert: [withValue(src[line.n], line.keyCol, yamlScalar(ref))] }];
  }
  if (!line && ref !== undefined) {
    return [{ line: item.end + 1, deleteCount: 0, insert: [`${pad(item.keyCol)}ref: ${yamlScalar(ref)}`] }];
  }
  return [];
}

/** Line before which a new top-level `resources:` block goes: before stages/jobs/steps/extends, else at the end. */
function resourcesInsertLine(lines: YLine[]): number {
  const anchor = lines.find(l => !l.blank && l.indent === 0 && !l.dash && ['stages', 'jobs', 'steps', 'extends'].includes(l.key ?? ''));
  if (anchor) {
    return anchor.n;
  }
  const last = lines.findLastIndex(l => !l.blank);
  return last + 1;
}

/**
 * Adds the repository resource, or updates the `ref:` of the entry with the same alias (an undefined ref removes the
 * line: default branch). Creates `resources:` / `repositories:` when missing.
 */
export function planRepositoryEdits(text: string, repo: RepoEntry): LineEdit[] {
  const lines = scanYaml(text);
  const src = splitLines(text);
  const unit = indentUnit(text);
  const resources = topLevel(lines, 'resources');
  const repos = resources && childKey(lines, resources, 'repositories');
  if (repos && !repos.rest) {
    const items = repositoryItems(lines, repos.n);
    const own = items.find(i => unquote(i.keys.get('repository')?.rest ?? '') === repo.alias);
    if (own) {
      return updateRepoItem(src, own, repo.ref);
    }
    const indent = items[0] ? lines[items[0].start].indent : repos.keyCol + unit;
    return [{ line: blockEnd(lines, repos.n) + 1, deleteCount: 0, insert: repoItemLines(repo, indent) }];
  }
  if (repos) {
    // `repositories: []` or another flow value: write the list as a block.
    return [{ line: repos.n, deleteCount: 1, insert: [`${pad(repos.keyCol)}repositories:`, ...repoItemLines(repo, repos.keyCol)] }];
  }
  if (resources && !resources.rest) {
    const col = childCol(lines, resources.n) ?? unit;
    return [{ line: blockEnd(lines, resources.n) + 1, deleteCount: 0, insert: [`${pad(col)}repositories:`, ...repoItemLines(repo, col)] }];
  }
  const at = resourcesInsertLine(lines);
  const block = ['resources:', `${pad(unit)}repositories:`, ...repoItemLines(repo, unit)];
  const spaced = at < lines.length && !lines[at].blank ? [...block, ''] : block;
  return [{ line: at, deleteCount: 0, insert: at > 0 && !lines[at - 1].blank ? ['', ...spaced] : spaced }];
}

/** True when a ref names a branch (template changes take effect immediately), not a tag or commit. */
export function isBranchRef(ref: string | undefined): boolean {
  if (!ref) {
    return true;
  }
  return !ref.startsWith('refs/tags/') && !/^[0-9a-f]{40}$/i.test(ref);
}

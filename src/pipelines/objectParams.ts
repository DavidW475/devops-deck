/**
 * Object and list parameters (`object`, `step`, `stepList`, `job`, `jobList`, `stage`, `stageList`) in the pipeline
 * designer: the value as YAML text, a tree form for objects (and its way back to YAML), checks and the lines written
 * into the call. Pure functions.
 */
import { isExpression } from './templateRefs';
import { isRecord, parseYamlDocument, PipelineParameter, setOwn, splitKey, Value } from './yamlParameters';

/** One node of the object form. Keys stay strings (`${{ if … }}` / `${{ each … }}` keys included). */
export type TreeNode =
  | { kind: 'map'; entries: TreeEntry[] }
  | { kind: 'list'; items: TreeNode[] }
  | { kind: 'text'; text: string }
  | { kind: 'bool'; value: boolean };

export interface TreeEntry {
  key: string;
  value: TreeNode;
}

const PLAIN_UNSAFE_START = '!&*{}[],|>@`"\'%?-';
const PLAIN_UNSAFE_ANYWHERE = '*$:#';
const RESERVED = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~']);
const BLOCK_SCALAR = /^[|>][-+]?\d*$/;
const MAX_DEPTH = 40;
const MAX_NODES = 5000;

const pad = (n: number) => ' '.repeat(Math.max(n, 0));
const indentOf = (s: string) => s.length - s.trimStart().length;
const isComment = (s: string) => s.trimStart().startsWith('#');

/** True when a string can't be written as a plain YAML scalar without changing its meaning. */
function needsQuotes(s: string): boolean {
  if (s === '' || s.trim() !== s || RESERVED.has(s.toLowerCase()) || PLAIN_UNSAFE_START.includes(s[0])) {
    return true;
  }
  return [...s].some(c => PLAIN_UNSAFE_ANYWHERE.includes(c));
}

/** A string as a YAML scalar: plain when safe, else single-quoted (double-quoted when it spans lines). */
export function yamlScalar(s: string): string {
  if (s.includes('\n')) {
    return '"' + s.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`).replaceAll('\n', String.raw`\n`) + '"';
  }
  return needsQuotes(s) ? "'" + s.replaceAll("'", "''") + "'" : s;
}

/** Like `yamlScalar`, but expressions (`${{ if … }}`, `$(Build.BuildId)`) stay plain where YAML allows it. */
function treeScalar(s: string): string {
  const plainExpression = isExpression(s) && !s.includes('\n') && s.trim() === s && !s.includes(': ') && !s.includes(' #')
    && !s.endsWith(':') && !PLAIN_UNSAFE_START.includes(s[0]);
  return plainExpression ? s : yamlScalar(s);
}

/** The form tree of a parsed value. */
export function toTree(v: Value): TreeNode {
  if (Array.isArray(v)) {
    return { kind: 'list', items: v.map(i => toTree(i)) };
  }
  if (isRecord(v)) {
    return { kind: 'map', entries: Object.entries(v).map(([key, value]) => ({ key, value: toTree(value) })) };
  }
  return typeof v === 'boolean' ? { kind: 'bool', value: v } : { kind: 'text', text: v ?? '' };
}

/** Checks a tree posted by the webview; undefined when it is not one (or too large or too deep). */
export function asTree(x: unknown): TreeNode | undefined {
  const budget = { nodes: MAX_NODES };
  return checkNode(x, 0, budget);
}

function checkNode(x: unknown, depth: number, budget: { nodes: number }): TreeNode | undefined {
  if (!isRecord(x) || depth > MAX_DEPTH || --budget.nodes < 0) {
    return undefined;
  }
  if (x.kind === 'text') {
    return typeof x.text === 'string' ? { kind: 'text', text: x.text } : undefined;
  }
  if (x.kind === 'bool') {
    return typeof x.value === 'boolean' ? { kind: 'bool', value: x.value } : undefined;
  }
  if (x.kind === 'list' && Array.isArray(x.items)) {
    const items = x.items.map(i => checkNode(i, depth + 1, budget));
    return items.every(i => i !== undefined) ? { kind: 'list', items: items as TreeNode[] } : undefined;
  }
  if (x.kind === 'map' && Array.isArray(x.entries)) {
    const entries = x.entries.map(e => checkEntry(e, depth + 1, budget));
    return entries.every(e => e !== undefined) ? { kind: 'map', entries: entries as TreeEntry[] } : undefined;
  }
  return undefined;
}

function checkEntry(e: unknown, depth: number, budget: { nodes: number }): TreeEntry | undefined {
  if (!isRecord(e) || typeof e.key !== 'string') {
    return undefined;
  }
  const value = checkNode(e.value, depth, budget);
  return value ? { key: e.key, value } : undefined;
}

/** Empty or duplicate keys in the form (YAML would keep only one of them). */
export function treeIssue(node: TreeNode, at = ''): string | undefined {
  if (node.kind === 'list') {
    return firstOf(node.items, (item, i) => treeIssue(item, `${at}[${i}]`));
  }
  if (node.kind !== 'map') {
    return undefined;
  }
  const seen = new Set<string>();
  for (const e of node.entries) {
    const where = at ? `${at}.${e.key}` : e.key;
    if (!e.key.trim()) {
      return at ? `A key under '${at}' is empty.` : 'A key is empty.';
    }
    if (seen.has(e.key)) {
      return `The key '${where}' is there twice.`;
    }
    seen.add(e.key);
  }
  return firstOf(node.entries, e => treeIssue(e.value, at ? `${at}.${e.key}` : e.key));
}

function firstOf<T>(list: T[], fn: (item: T, i: number) => string | undefined): string | undefined {
  for (let i = 0; i < list.length; i++) {
    const issue = fn(list[i], i);
    if (issue) {
      return issue;
    }
  }
  return undefined;
}

const isCollection = (n: TreeNode) => (n.kind === 'map' && n.entries.length > 0) || (n.kind === 'list' && n.items.length > 0);

/** A multi-line string as a literal block (`|` / `|-`); undefined when it can't be one (leading spaces, trailing blanks). */
function literalBlock(s: string): { head: string; lines: string[] } | undefined {
  const body = s.endsWith('\n') ? s.slice(0, -1) : s;
  const lines = body.split('\n');
  if (body.endsWith('\n') || lines[0].startsWith(' ') || lines.some(l => l.endsWith(' ') || l.includes('\r'))) {
    return undefined;
  }
  return { head: s.endsWith('\n') ? '|' : '|-', lines };
}

const indentLines = (lines: string[], by: number) => lines.map(l => (l ? pad(by) + l : l));

/** The tree as YAML lines without indentation of their own (nested levels indented by `unit`). */
export function treeLines(node: TreeNode, unit: number): string[] {
  if (node.kind === 'map') {
    return node.entries.length ? node.entries.flatMap(e => entryLines(e, unit)) : ['{}'];
  }
  if (node.kind === 'list') {
    return node.items.length ? node.items.flatMap(i => itemLines(i, unit)) : ['[]'];
  }
  if (node.kind === 'bool') {
    return [String(node.value)];
  }
  const block = node.text.includes('\n') ? literalBlock(node.text) : undefined;
  return block ? [block.head, ...indentLines(block.lines, unit)] : [treeScalar(node.text)];
}

/** `treeLines` as one text: what the form sends as the pending value of a parameter. */
export function treeText(node: TreeNode, unit: number): string {
  return treeLines(node, unit).join('\n');
}

function entryLines(e: TreeEntry, unit: number): string[] {
  const key = treeScalar(e.key);
  const [first, ...rest] = treeLines(e.value, unit);
  if (isCollection(e.value)) {
    return [`${key}:`, ...indentLines([first, ...rest], unit)];
  }
  return [`${key}: ${first}`, ...rest];
}

function itemLines(n: TreeNode, unit: number): string[] {
  const [first, ...rest] = treeLines(n, unit);
  // A literal block's lines are indented by `unit` already; collections continue under the item's first key.
  return [`- ${first}`, ...(n.kind === 'text' ? rest : indentLines(rest, 2))];
}

/** Converts a parsed JSON default (numbers become strings, as the YAML parser reads them). */
function fromJson(x: unknown): Value {
  let value: Value;
  if (Array.isArray(x)) {
    value = x.map(i => fromJson(i));
  } else if (x && typeof x === 'object') {
    const out: Record<string, Value> = {};
    Object.entries(x).forEach(([k, v]) => setOwn(out, k, fromJson(v)));
    value = out;
  } else if (typeof x === 'string' || typeof x === 'boolean' || x === null) {
    value = x;
  } else {
    value = String(x);
  }
  return value;
}

/** The template's default of an object/list parameter as a value (the parameter list keeps it as JSON text). */
export function defaultValue(p: PipelineParameter): Value | undefined {
  if (p.default === undefined) {
    return undefined;
  }
  const d = p.default.trim();
  let value: Value | undefined;
  if (d.startsWith('[') || d.startsWith('{')) {
    try {
      value = fromJson(JSON.parse(d));
    } catch {
      // not JSON: a YAML flow collection
    }
  }
  return value ?? parseYamlDocument(p.default) ?? '';
}

/** The default as YAML text, as the form shows it and "Write defaults" writes it. */
export function defaultText(p: PipelineParameter, unit: number): string | undefined {
  const v = defaultValue(p);
  return v === undefined ? undefined : treeText(toTree(v), unit);
}

/** Same value, ignoring formatting (null and '' count as the same). */
export function sameStructured(a: Value | undefined, b: Value | undefined): boolean {
  const canon = (v: Value | undefined) => JSON.stringify(v ?? '', (_k, x) => x ?? '');
  return canon(a) === canon(b);
}

/** Lines without their common indentation (comments with less indentation are kept, just moved left). */
export function dedent(lines: string[]): string[] {
  const content = lines.filter(l => l.trim() && !isComment(l));
  const min = content.length ? Math.min(...content.map(indentOf)) : 0;
  return lines.map(l => l.slice(Math.min(min, indentOf(l))).trimEnd());
}

/** Normalized pending text: no common indentation, no trailing spaces or blank lines. */
export function normalizeText(text: string): string {
  const lines = dedent(text.split(/\r?\n/));
  while (lines.length && !lines.at(-1)) {
    lines.pop();
  }
  return lines.join('\n');
}

/** Parses the YAML text of an object/list value. */
export function parseValueText(text: string): Value | undefined {
  return parseYamlDocument(normalizeText(text));
}

export const isBlockScalarText = (text: string) => BLOCK_SCALAR.test(text.trimStart().split(/\r?\n/)[0].trim());

const SINGLE: Record<string, string> = { step: 'step', job: 'job', stage: 'stage' };

/** What is wrong with the YAML text of an object/list parameter, if anything. */
export function structureIssue(p: PipelineParameter, text: string): string | undefined {
  if (text.includes('\t')) {
    return 'Indent with spaces: YAML does not allow tabs.';
  }
  const t = normalizeText(text);
  if (!t || isBlockScalarText(t) || (isExpression(t) && !t.includes('\n'))) {
    return undefined;
  }
  const v = parseYamlDocument(t);
  if (p.type.endsWith('List') && !Array.isArray(v)) {
    return `'${p.name}' is a ${p.type}: start every item with '- '.`;
  }
  if (Object.hasOwn(SINGLE, p.type) && !isRecord(v)) {
    return `'${p.name}' is a single ${SINGLE[p.type]}: write it as keys and values.`;
  }
  return undefined;
}

/** True when the text fits after `key: ` on one line (scalar, flow collection or expression). */
function isInline(t: string): boolean {
  return t.startsWith('[') || t.startsWith('{') || (t !== '-' && !t.startsWith('- ') && !splitKey(t));
}

/**
 * The lines of `key: value` for an object/list value given as YAML text: inline when it is one scalar or flow
 * collection, else `key:` with the lines nested at `childCol`.
 */
export function paramLines(key: string, text: string, col: number, childCol: number): string[] {
  const body = normalizeText(text).split('\n');
  const head = `${pad(col)}${yamlScalar(key)}:`;
  const first = body[0].trim();
  if (body.length === 1 && isInline(first)) {
    return [`${head} ${first || "''"}`];
  }
  if (BLOCK_SCALAR.test(first)) {
    return [`${head} ${first}`, ...indentLines(dedent(body.slice(1)), Math.max(childCol, col + 1))];
  }
  return [head, ...indentLines(body, childCol)];
}

/** The passed value of the key at `line` as YAML text (dedented) and its last line. */
export interface PassedValue {
  text: string;
  end: number;
  /** column of the nested lines, when there are any */
  childCol?: number;
}

/** Reads a passed object/list value: the text after the colon, or the nested lines up to `end` (inclusive). */
export function passedText(lines: string[], line: number, rest: string, end: number): PassedValue {
  if (rest && !BLOCK_SCALAR.test(rest)) {
    return { text: rest, end: line };
  }
  const body = lines.slice(line + 1, end + 1);
  const content = body.filter(l => l.trim() && !isComment(l));
  const childCol = content.length ? Math.min(...content.map(indentOf)) : undefined;
  const nested = dedent(body);
  const text = rest ? [rest, ...indentLines(nested, 2)].join('\n') : nested.join('\n');
  return { text: normalizeText(text), end, childCol };
}

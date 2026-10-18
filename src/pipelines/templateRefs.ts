/**
 * Finds `template:` references (steps, jobs, stages, variables and `extends:`) in Azure Pipelines YAML together with
 * the parameters passed to them, and checks those parameters against what a template declares. Pure functions,
 * line based: the extension has no YAML dependency, and positions are needed for completions and diagnostics.
 */
import { isRecord, PipelineParameter, splitFlow, splitKey, stripComment, topLevelValue, unquote } from './yamlParameters';

/** `path@alias` of a template reference; alias undefined = same repository as the including file. */
export interface TemplatePath {
  path: string;
  alias?: string;
}

/** A parameter passed to a template. */
export interface ParamEntry {
  name: string;
  line: number;
  start: number;
  end: number;
  /** text after the colon (unquoted), '' for block values */
  value: string;
  /** set inside `${{ if }}` / `${{ each }}` (not checked for missing or unknown names) */
  conditional: boolean;
}

export interface TemplateRef {
  kind: 'template' | 'extends';
  line: number;
  /** column of the `template` key */
  keyCol: number;
  /** raw value text (comment stripped, quotes kept) */
  raw: string;
  valueStart: number;
  valueEnd: number;
  /** undefined when the path is empty or an expression (`${{ … }}`) */
  target?: TemplatePath;
  /** line of the sibling `parameters:` key */
  paramsLine?: number;
  params: ParamEntry[];
  /** `parameters:` is a single expression (`${{ parameters }}`) or uses `${{ }}` keys: names can't be checked completely */
  dynamicParams: boolean;
  /** last line that belongs to the mapping of this reference */
  end: number;
}

/** A repository resource (`resources.repositories[]`). */
export interface RepoResource {
  alias: string;
  type: string;
  name: string;
  ref?: string;
  endpoint?: string;
}

export interface ParamIssue {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  start: number;
  end: number;
}

export type CompletionContext =
  | { kind: 'path'; ref: TemplateRef; prefix: string }
  | { kind: 'name'; ref: TemplateRef }
  | { kind: 'value'; ref: TemplateRef; name: string }
  | { kind: 'parametersKey'; ref: TemplateRef };

interface YLine {
  n: number;
  blank: boolean;
  indent: number;
  dash: boolean;
  keyCol: number;
  key?: string;
  rest: string;
  restCol: number;
}

const isExpression = (s: string) => s.includes('${{') || s.includes('$[') || s.includes('$(');

/** Reads a `template:` value: `path`, `path@alias`, quoted or not. Expressions can't be resolved locally. */
export function parseTemplatePath(raw: string): TemplatePath | undefined {
  const text = unquote(raw);
  if (!text || isExpression(text)) {
    return undefined;
  }
  const at = text.lastIndexOf('@');
  if (at > 0 && at < text.length - 1) {
    return { path: text.slice(0, at).trim(), alias: text.slice(at + 1).trim() };
  }
  return { path: at > 0 ? text.slice(0, at) : text };
}

/** Joins a template path to the repository-relative path of the including file ('/' = repository root). */
export function joinTemplatePath(fromFile: string, target: string): string {
  const base = target.startsWith('/') ? [] : fromFile.split('/').slice(0, -1);
  const out: string[] = [];
  for (const part of [...base, ...target.split(/[/\\]/)]) {
    if (part === '..') {
      out.pop();
    } else if (part && part !== '.') {
      out.push(part);
    }
  }
  return '/' + out.join('/');
}

/** `resources.repositories` of a pipeline or template. */
export function parseRepositories(yaml: string): RepoResource[] {
  const resources = topLevelValue(yaml, 'resources');
  const list = isRecord(resources) ? resources.repositories : undefined;
  if (!Array.isArray(list)) {
    return [];
  }
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return list.filter(isRecord).flatMap(r => {
    const alias = text(r.repository);
    const name = text(r.name);
    return alias && name ? [{ alias, name, type: text(r.type) ?? 'git', ref: text(r.ref), endpoint: text(r.endpoint) }] : [];
  });
}

function scanLine(raw: string, n: number): YLine {
  const text = stripComment(raw).trimEnd();
  const indent = text.length - text.trimStart().length;
  let pos = indent;
  let dash = false;
  while (text[pos] === '-' && (pos + 1 === text.length || text[pos + 1] === ' ')) {
    dash = true;
    pos++;
    while (text[pos] === ' ') {
      pos++;
    }
  }
  const kv = splitKey(text.slice(pos));
  const rest = kv?.[1] ?? '';
  return { n, blank: !text.trim(), indent, dash, keyCol: pos, key: kv?.[0], rest, restCol: text.length - rest.length };
}

/** Scans every line; contents of block scalars (`script: |`) count as blank so their text is never read as keys. */
function scan(text: string): YLine[] {
  const lines = text.split(/\r?\n/).map(scanLine);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.key !== undefined && /^[|>][-+]?\d*$/.test(l.rest)) {
      for (let j = i + 1; j < lines.length && (lines[j].blank || lines[j].indent > l.keyCol); j++) {
        lines[j].blank = true;
      }
    }
  }
  return lines;
}

/** Nearest earlier line whose key sits left of `col` (the parent node). */
function parentOf(lines: YLine[], i: number, col: number): YLine | undefined {
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].blank && lines[j].keyCol < col) {
      return lines[j];
    }
  }
  return undefined;
}

/** Blank, more indented, or a list item that is the value of a key at the same column. */
const isNestedIn = (l: YLine, k: number) => l.blank || l.indent > k || (l.indent === k && l.dash);

/** Sibling keys above lines[i]; a mapping that starts with "- key:" has none above it. */
function siblingsBefore(lines: YLine[], i: number): YLine[] {
  const k = lines[i].keyCol;
  const out: YLine[] = [];
  for (let j = i - 1; j >= 0 && !lines[i].dash; j--) {
    const l = lines[j];
    if (isNestedIn(l, k)) {
      continue;
    }
    if (l.keyCol !== k || (l.indent < k && !l.dash)) {
      break;
    }
    out.push(l);
    if (l.dash) {
      break;
    }
  }
  return out;
}

/** Lines of the mapping that contains the key at lines[i]: sibling keys (same column) and nested content. */
function mappingOf(lines: YLine[], i: number): { siblings: YLine[]; end: number } {
  const k = lines[i].keyCol;
  const siblings = siblingsBefore(lines, i);
  let end = i;
  for (let j = i + 1; j < lines.length && (lines[j].blank || lines[j].indent >= k); j++) {
    const l = lines[j];
    if (!l.blank) {
      if (l.indent === k && !l.dash) {
        siblings.push(l);
      }
      end = j;
    }
  }
  return { siblings, end };
}

function flowParams(l: YLine): ParamEntry[] {
  const out: ParamEntry[] = [];
  let from = 0;
  for (const part of splitFlow(l.rest.slice(1, -1))) {
    const idx = part.indexOf(':');
    const name = unquote(idx > 0 ? part.slice(0, idx) : part);
    const found = l.rest.indexOf(name, from);
    const start = l.restCol + Math.max(found, 0);
    from = Math.max(found, 0) + name.length;
    out.push({ name, line: l.n, start, end: start + name.length, value: idx > 0 ? unquote(part.slice(idx + 1)) : '', conditional: false });
  }
  return out;
}

const entry = (l: YLine, conditional: boolean): ParamEntry =>
  ({ name: l.key!, line: l.n, start: l.keyCol, end: l.keyCol + l.key!.length, value: unquote(l.rest), conditional });

interface ParamScan {
  params: ParamEntry[];
  dynamic: boolean;
  childCol: number;
  /** inside an expression key: column of its keys once known (0 = not yet known), -1 = not inside one */
  conditionalCol: number;
}

function addParamLine(s: ParamScan, l: YLine & { key: string }): void {
  s.childCol = s.childCol < 0 ? l.keyCol : s.childCol;
  if (l.keyCol === s.childCol) {
    const expression = isExpression(l.key);
    s.dynamic ||= expression;
    s.conditionalCol = expression ? 0 : -1;
    if (!expression) {
      s.params.push(entry(l, false));
    }
  } else if (s.conditionalCol >= 0) {
    s.conditionalCol ||= l.keyCol;
    if (l.keyCol === s.conditionalCol) {
      s.params.push(entry(l, true));
    }
  }
}

/** Parameters passed in the block under `parameters:`; keys under `${{ if }}` / `${{ each }}` are taken one level deeper. */
function blockParams(lines: YLine[], p: YLine): { params: ParamEntry[]; dynamic: boolean } {
  const s: ParamScan = { params: [], dynamic: false, childCol: -1, conditionalCol: -1 };
  for (let j = p.n + 1; j < lines.length && (lines[j].blank || lines[j].indent > p.keyCol); j++) {
    const l = lines[j];
    if (!l.blank && l.key !== undefined && !l.dash) {
      addParamLine(s, l as YLine & { key: string });
    }
  }
  return { params: s.params, dynamic: s.dynamic };
}

/** Every `template:` reference of the document with the parameters passed to it. */
export function findTemplateRefs(text: string): TemplateRef[] {
  const lines = scan(text);
  const refs: TemplateRef[] = [];
  for (const l of lines) {
    if (l.blank || l.key !== 'template') {
      continue;
    }
    const { siblings, end } = mappingOf(lines, l.n);
    const parent = parentOf(lines, l.n, l.keyCol);
    const ref: TemplateRef = {
      kind: !l.dash && parent?.key === 'extends' && parent.indent === 0 ? 'extends' : 'template',
      line: l.n, keyCol: l.keyCol, raw: l.rest, valueStart: l.restCol, valueEnd: l.restCol + l.rest.length,
      target: parseTemplatePath(l.rest), params: [], dynamicParams: false, end,
    };
    const p = siblings.find(s => s.key === 'parameters');
    if (p) {
      ref.paramsLine = p.n;
      if (p.rest.startsWith('{') && p.rest.endsWith('}')) {
        ref.params = flowParams(p);
      } else if (p.rest) {
        ref.dynamicParams = true;
      } else {
        const block = blockParams(lines, p);
        ref.params = block.params;
        ref.dynamicParams = block.dynamic;
      }
    }
    refs.push(ref);
  }
  return refs;
}

/** What the user is typing at (line, col): a template path, a parameter name or value, or the `parameters` key. */
export function completionContext(text: string, line: number, col: number): CompletionContext | undefined {
  const lines = scan(text);
  const refs = findTemplateRefs(text);
  const here = lines[line];
  if (!here) {
    return undefined;
  }
  const own = refs.find(r => r.line === line);
  if (own && col >= own.valueStart) {
    return { kind: 'path', ref: own, prefix: unquote(text.split(/\r?\n/)[line].slice(own.valueStart, col)).replace(/^["']/, '') };
  }
  const typed = text.split(/\r?\n/)[line].slice(0, col);
  const indent = typed.length - typed.trimStart().length;
  const parent = parentOf(lines, line, indent);
  if (parent?.key === 'parameters' && !parent.rest) {
    const ref = refs.find(r => r.paramsLine === parent.n);
    if (!ref) {
      return undefined;
    }
    const colon = typed.indexOf(': ');
    return colon > indent ? { kind: 'value', ref, name: unquote(typed.slice(indent, colon)) } : { kind: 'name', ref };
  }
  const word = typed.trim();
  const sibling = refs.find(r => r.paramsLine === undefined && r.keyCol === indent && r.line < line && line <= r.end + 1);
  if (sibling && 'parameters'.startsWith(word) && !word.includes(':')) {
    return { kind: 'parametersKey', ref: sibling };
  }
  return undefined;
}

const isBoolean = (v: string) => /^(true|false)$/i.test(v);
const isNumber = (v: string) => v.trim() !== '' && Number.isFinite(Number(v));

function valueIssue(p: PipelineParameter, value: string): string | undefined {
  if (!value || isExpression(value)) {
    return undefined;
  }
  if (p.values?.length && !p.values.includes(value)) {
    return `'${value}' is not an allowed value of '${p.name}'. Allowed: ${p.values.join(', ')}`;
  }
  if (p.type === 'boolean' && !isBoolean(value)) {
    return `'${p.name}' is a boolean: use true or false.`;
  }
  if (p.type === 'number' && !isNumber(value)) {
    return `'${p.name}' is a number.`;
  }
  return undefined;
}

function entryIssue(e: ParamEntry, declared: PipelineParameter[]): ParamIssue | undefined {
  const at = { line: e.line, start: e.start, end: e.end };
  const p = declared.find(d => d.name === e.name);
  if (p) {
    const problem = valueIssue(p, e.value);
    return problem ? { severity: 'error', message: problem, ...at } : undefined;
  }
  if (e.conditional) {
    return undefined;
  }
  const known = declared.length ? `Declared: ${declared.map(d => d.name).join(', ')}` : 'The template declares no parameters.';
  return { severity: 'warning', message: `Unknown parameter '${e.name}'. ${known}`, ...at };
}

function missingIssue(ref: TemplateRef, declared: PipelineParameter[]): ParamIssue | undefined {
  const passed = new Set(ref.params.map(e => e.name));
  const missing = declared.filter(p => p.default === undefined && !passed.has(p.name)).map(p => p.name);
  if (ref.dynamicParams || !missing.length) {
    return undefined;
  }
  return {
    severity: 'error', message: `Missing required ${missing.length === 1 ? 'parameter' : 'parameters'}: ${missing.join(', ')}`,
    line: ref.line, start: ref.valueStart, end: ref.valueEnd,
  };
}

/** Unknown parameters, missing required ones (no default) and values that don't fit the declared type or values. */
export function checkTemplateParameters(ref: TemplateRef, declared: PipelineParameter[]): ParamIssue[] {
  return [...ref.params.map(e => entryIssue(e, declared)), missingIssue(ref, declared)].filter((i): i is ParamIssue => !!i);
}

/** Escapes text for a Markdown hover (no links, emphasis or HTML from template content). */
export function mdEscape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, c => '\\' + c);
}

/** Markdown summary of one parameter: type, default and allowed values. */
export function describeParameter(p: PipelineParameter): string {
  const parts = [inlineValue(p.type)];
  parts.push(p.default === undefined ? '**required**' : `default: ${inlineValue(p.default)}`);
  if (p.values?.length) {
    parts.push(`values: ${p.values.map(inlineValue).join(', ')}`);
  }
  const title = p.displayName ? ` — ${mdEscape(p.displayName)}` : '';
  return `**${mdEscape(p.name)}**${title}: ${parts.join(' · ')}`;
}

function inlineValue(v: string): string {
  const one = v.replace(/\s+/g, ' ');
  const short = one.length > 60 ? one.slice(0, 57) + '…' : one;
  return '`' + short.replace(/`/g, "'") + '`';
}

/** Snippet text for the parameters of a template: required ones first, each with a tab stop (choices for values/booleans). */
export function parameterSnippet(p: PipelineParameter, stop: number): string {
  const choices = p.type === 'boolean' && !p.values?.length ? ['true', 'false'] : p.values;
  if (choices?.length && choices.every(c => !/[\n,|$}\\]/.test(c))) {
    const ordered = p.default !== undefined && choices.includes(p.default) ? [p.default, ...choices.filter(c => c !== p.default)] : choices;
    return `${p.name}: \${${stop}|${ordered.join(',')}|}`;
  }
  const def = p.default !== undefined && !p.default.includes('\n') ? snippetEscape(p.default) : '';
  return `${p.name}: \${${stop}${def ? ':' + def : ''}}`;
}

function snippetEscape(s: string): string {
  return s.replace(/[$}\\]/g, c => '\\' + c);
}

/** Error locations in a pipeline preview error message: "/path.yml (Line: 3, Col: 5): message". */
export function parsePreviewErrors(message: string): { file: string; line: number; col: number; text: string }[] {
  const out: { file: string; line: number; col: number; text: string }[] = [];
  for (const raw of message.split(/\r?\n/)) {
    const at = raw.indexOf(' (Line: ');
    const close = raw.indexOf('): ', at);
    if (at < 0 || close < 0) {
      continue;
    }
    const [line, col] = raw.slice(at + 8, close).split(', Col: ').map(Number);
    if (Number.isInteger(line) && Number.isInteger(col)) {
      out.push({ file: raw.slice(0, at).trim(), line, col, text: raw.slice(close + 3).trim() });
    }
  }
  return out;
}

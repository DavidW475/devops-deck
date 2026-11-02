/**
 * Reads the runtime `parameters:` of an Azure Pipelines YAML file. The extension ships without
 * dependencies, so this is a small parser for the block/flow YAML subset parameter lists use.
 */

export interface PipelineParameter {
  name: string;
  displayName?: string;
  /** string | number | boolean | object | step | stepList | job | jobList | stage | stageList | … */
  type: string;
  /** default as the run API expects it: plain text, 'true'/'false', or JSON for structured values */
  default?: string;
  values?: string[];
  /** A task input without a default: an empty value means "not set" and is never written (`opt: ''`). */
  unsetWhenBlank?: boolean;
}

/** `|`, `>`, with an indentation indicator and a chomping indicator in either order (`|2-`, `|-2`). */
const BLOCK_HEADER = /^[|>](?:\d[-+]?|[-+]\d?)?$/;

/** True for a block scalar header such as `|`, `>-`, `|2-` or `|-2`. */
export const isBlockHeader = (rest: string): boolean => BLOCK_HEADER.test(rest);

interface Line {
  indent: number;
  text: string;
  /** 0-based line in the source */
  n: number;
  /** all source lines (block scalars are read from them, so comments, blank lines and `---` inside stay text) */
  src: string[];
}

/** Source line (0-based) of a parsed mapping or list, for "go to source". */
const lineOf = new WeakMap<object, number>();
export function yamlLine(v: unknown): number | undefined {
  return v && typeof v === 'object' ? lineOf.get(v) : undefined;
}

/**
 * Sets `key` as an own property, also for "__proto__" (a plain assignment would replace the object's prototype).
 * For mappings built from YAML or template output, whose keys anyone can write.
 */
export function setOwn<V>(obj: Record<string, V>, key: string, value: V): void {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

/** Lines `from` to `to` (exclusive) of `src` without comments and blank lines; `n` stays the index in `src`. */
function toLines(src: string[], from = 0, to = src.length): Line[] {
  const out: Line[] = [];
  for (let n = from; n < to; n++) {
    const text = stripComment(src[n]).trimEnd();
    if (text.trim() && text.trim() !== '---') {
      out.push({ indent: text.length - text.trimStart().length, text: text.trimStart(), n, src });
    }
  }
  return out;
}

/** Parses a whole document (the YAML subset pipelines use: block and flow collections, quoted and block scalars). */
export function parseYamlDocument(yaml: string): Value | undefined {
  const block = toLines(yaml.replace(/^\uFEFF/, '').split(/\r?\n/));
  return block.length ? parseBlock(block, 0, block[0].indent)[0] : undefined;
}

export function parsePipelineParameters(yaml: string): PipelineParameter[] {
  const value = topLevelValue(yaml, 'parameters');
  if (Array.isArray(value)) {
    return value.filter(isRecord).filter(p => typeof p.name === 'string').map(p => ({
      name: String(p.name),
      displayName: typeof p.displayName === 'string' ? p.displayName : undefined,
      type: typeof p.type === 'string' ? p.type : 'string',
      default: isNil(p.default) ? undefined : toParamText(p.default),
      values: Array.isArray(p.values) ? p.values.map(toParamText) : undefined,
    }));
  }
  // Legacy form: `parameters:` as a mapping of name → default.
  if (isRecord(value)) {
    return Object.entries(value).map(([name, d]) => ({ name, type: legacyType(d), default: isNil(d) ? undefined : toParamText(d) }));
  }
  return [];
}

/** Parses the value of a top-level key (`parameters`, `resources`, …); undefined when the key is missing or empty. */
export function topLevelValue(yaml: string, key: string): Value | undefined {
  const raw = yaml.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = raw.findIndex(l => isTopLevelKey(l, key));
  if (start < 0) {
    return undefined;
  }
  let end = start + 1;
  while (end < raw.length && !(/^\S/.test(raw[end]) && !raw[end].startsWith('-') && !raw[end].startsWith('#'))) {
    end++;
  }
  const block = toLines(raw, start + 1, end);
  return block.length ? parseBlock(block, 0, block[0].indent)[0] : undefined;
}

function isTopLevelKey(line: string, key: string): boolean {
  if (isSpace(line[0])) {
    return false;
  }
  const kv = splitKey(stripComment(line).trimEnd());
  return !!kv && kv[0] === key && !kv[1];
}

export type Value = string | boolean | null | Value[] | { [k: string]: Value };

export const isRecord = (v: unknown): v is Record<string, Value> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNil = (v: unknown): v is null | undefined => v === undefined || v === null;

function legacyType(d: Value): string {
  if (typeof d === 'boolean') {
    return 'boolean';
  }
  return typeof d === 'object' && d ? 'object' : 'string';
}

function toParamText(v: Value): string {
  if (typeof v === 'string') {
    return v;
  }
  return typeof v === 'boolean' ? String(v) : JSON.stringify(v, null, 2);
}

export function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = '';
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Parses the node starting at lines[i] (indented by `indent`); returns it and the next line index. */
function parseBlock(lines: Line[], i: number, indent: number): [Value, number] {
  const first = lines[i];
  if (!first) {
    return [null, i];
  }
  if (isListItem(first.text)) {
    return parseList(lines, i, indent);
  }
  if (isKeyLine(first.text)) {
    return parseMap(lines, i, indent);
  }
  return [scalar(first.text), i + 1];
}

const isListItem = (text: string) => text === '-' || text.startsWith('- ');

function parseList(lines: Line[], start: number, indent: number): [Value, number] {
  const items: Value[] = [];
  lineOf.set(items, lines[start].n);
  let i = start;
  while (i < lines.length && lines[i].indent === indent && isListItem(lines[i].text)) {
    const [v, next] = parseListItem(lines, i, indent);
    items.push(v);
    i = next;
  }
  return [items, i];
}

function parseListItem(lines: Line[], i: number, indent: number): [Value, number] {
  const rest = lines[i].text.slice(1).trimStart();
  if (!rest) {
    const next = lines[i + 1];
    return next && next.indent > indent ? parseBlock(lines, i + 1, next.indent) : [null, i + 1];
  }
  if (!isKeyLine(rest)) {
    return [scalar(rest), i + 1];
  }
  // "- key: value" opens a mapping whose further keys sit at the column after "- ".
  const inner = indent + (lines[i].text.length - rest.length);
  const copy = [...lines];
  copy[i] = { ...lines[i], indent: inner, text: rest };
  return parseBlock(copy, i, inner);
}

function parseMap(lines: Line[], start: number, indent: number): [Value, number] {
  const map: Record<string, Value> = {};
  lineOf.set(map, lines[start].n);
  let i = start;
  while (i < lines.length && lines[i].indent === indent && isKeyLine(lines[i].text)) {
    const [key, rest] = splitKey(lines[i].text)!;
    const [value, next] = parseMapValue(lines, i, indent, rest);
    setOwn(map, key, value);
    i = next;
  }
  return [map, i];
}

function parseMapValue(lines: Line[], i: number, indent: number, rest: string): [Value, number] {
  if (isBlockHeader(rest)) {
    return blockScalar(lines, i, indent, rest);
  }
  if (rest) {
    return [scalar(rest), i + 1];
  }
  const next = lines[i + 1];
  if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('-')))) {
    return parseBlock(lines, i + 1, next.indent);
  }
  return [null, i + 1];
}

/**
 * "key: |" or "key: >" followed by more indented lines, read from the source: "#", blank lines and "---" in there are
 * text, not comments or document markers. The scalar ends at the first non-blank line that is not indented deeper.
 */
function blockScalar(lines: Line[], i: number, indent: number, header: string): [Value, number] {
  const folded = header.startsWith('>');
  const explicit = /\d/.exec(header)?.[0];
  const { src, n } = lines[i];
  const body: string[] = [];
  for (let k = n + 1; k < src.length; k++) {
    const l = src[k].trimEnd();
    if (l && l.length - l.trimStart().length <= indent) {
      break;
    }
    body.push(l);
  }
  while (body.length && !body.at(-1)) {
    body.pop();
  }
  const end = n + 1 + body.length;
  let j = i + 1;
  while (j < lines.length && lines[j].n < end) {
    j++;
  }
  const detected = Math.min(...body.filter(Boolean).map(b => b.length - b.trimStart().length));
  // An indentation indicator is relative to the key's column; it keeps leading spaces of the first line.
  const min = explicit === undefined ? detected : Math.min(indent + Number(explicit), detected);
  const text = body.map(b => b.slice(min));
  return [folded ? fold(text) : text.join('\n'), j];
}

/** Folded scalar: neighbouring lines join with a space, a blank line becomes a line break. */
function fold(lines: string[]): string {
  let out = '';
  lines.forEach((l, k) => {
    if (!l) {
      out += '\n';
    } else {
      out += k > 0 && lines[k - 1] ? ' ' + l : l;
    }
  });
  return out;
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t';

/** "key: rest" → [key, rest]; undefined when the line is not a mapping entry. A scanner, no backtracking regex. */
export function splitKey(text: string): [string, string] | undefined {
  let colon: number;
  const q = text[0];
  if (q === '"' || q === "'") {
    const close = text.indexOf(q, 1);
    colon = close + 1;
    while (close > 0 && isSpace(text[colon])) {
      colon++;
    }
    if (close < 0 || text[colon] !== ':') {
      return undefined;
    }
  } else {
    colon = text.indexOf(':');
    if (colon < 1 || isSpace(q) || q === '[' || q === '{') {
      return undefined;
    }
  }
  if (colon + 1 < text.length && !isSpace(text[colon + 1])) {
    return undefined;
  }
  return [unquote(text.slice(0, colon)), text.slice(colon + 1).trim()];
}

function isKeyLine(text: string): boolean {
  return splitKey(text) !== undefined;
}

export function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t[0] === "'" ? t.slice(1, -1).replace(/''/g, "'") : t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  return t;
}

function scalar(s: string): Value {
  const t = s.trim();
  let value: Value = unquote(t);
  if (t.startsWith('[') && t.endsWith(']')) {
    value = splitFlow(t.slice(1, -1)).map(scalar);
  } else if (t.startsWith('{') && t.endsWith('}')) {
    value = flowMap(t.slice(1, -1));
  } else if (/^(true|false)$/i.test(t)) {
    value = t.toLowerCase() === 'true';
  } else if (t === '~' || t === 'null' || t === '') {
    value = null;
  }
  return value;
}

function flowMap(content: string): Value {
  const map: Record<string, Value> = {};
  for (const part of splitFlow(content)) {
    const idx = part.indexOf(':');
    if (idx > 0) {
      setOwn(map, unquote(part.slice(0, idx)), scalar(part.slice(idx + 1)));
    }
  }
  return map;
}

/** Splits flow-collection content on top-level commas. */
export function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const c of s) {
    if (quote) {
      if (c === quote) {
        quote = '';
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) {
    out.push(cur);
  }
  return out.map(x => x.trim()).filter(Boolean);
}

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
}

interface Line {
  indent: number;
  text: string;
}

export function parsePipelineParameters(yaml: string): PipelineParameter[] {
  const raw = yaml.replace(/^﻿/, '').split(/\r?\n/);
  const start = raw.findIndex(l => /^parameters\s*:\s*(#.*)?$/.test(l));
  if (start < 0) {
    return [];
  }
  const block: Line[] = [];
  for (const l of raw.slice(start + 1)) {
    if (/^\S/.test(l) && !l.startsWith('-') && !l.startsWith('#')) {
      break;
    }
    const text = stripComment(l).trimEnd();
    if (text.trim()) {
      block.push({ indent: text.length - text.trimStart().length, text: text.trimStart() });
    }
  }
  if (!block.length) {
    return [];
  }
  const [value] = parseBlock(block, 0, block[0].indent);
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

type Value = string | boolean | null | Value[] | { [k: string]: Value };

const isRecord = (v: unknown): v is Record<string, Value> => !!v && typeof v === 'object' && !Array.isArray(v);
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

function stripComment(line: string): string {
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
  copy[i] = { indent: inner, text: rest };
  return parseBlock(copy, i, inner);
}

function parseMap(lines: Line[], start: number, indent: number): [Value, number] {
  const map: Record<string, Value> = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent && isKeyLine(lines[i].text)) {
    const [key, rest] = splitKey(lines[i].text)!;
    [map[key], i] = parseMapValue(lines, i, indent, rest);
  }
  return [map, i];
}

function parseMapValue(lines: Line[], i: number, indent: number, rest: string): [Value, number] {
  if (/^[|>][-+]?$/.test(rest)) {
    return blockScalar(lines, i, indent, rest.startsWith('>'));
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

/** "key: |" or "key: >" followed by more indented lines. */
function blockScalar(lines: Line[], i: number, indent: number, folded: boolean): [Value, number] {
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length && lines[j].indent > indent) {
    body.push(' '.repeat(lines[j].indent) + lines[j].text);
    j++;
  }
  const min = Math.min(...body.map(b => b.length - b.trimStart().length));
  return [body.map(b => b.slice(min)).join(folded ? ' ' : '\n'), j];
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t';

/** "key: rest" → [key, rest]; undefined when the line is not a mapping entry. A scanner, no backtracking regex. */
function splitKey(text: string): [string, string] | undefined {
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

function unquote(s: string): string {
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
      map[unquote(part.slice(0, idx))] = scalar(part.slice(idx + 1));
    }
  }
  return map;
}

/** Splits flow-collection content on top-level commas. */
function splitFlow(s: string): string[] {
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

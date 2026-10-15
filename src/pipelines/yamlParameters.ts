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
      default: p.default === undefined || p.default === null ? undefined : toParamText(p.default),
      values: Array.isArray(p.values) ? p.values.map(toParamText) : undefined,
    }));
  }
  // Legacy form: `parameters:` as a mapping of name → default.
  if (isRecord(value)) {
    return Object.entries(value).map(([name, d]) => ({
      name, type: typeof d === 'boolean' ? 'boolean' : typeof d === 'object' && d ? 'object' : 'string',
      default: d === null ? undefined : toParamText(d),
    }));
  }
  return [];
}

type Value = string | boolean | null | Value[] | { [k: string]: Value };

const isRecord = (v: unknown): v is Record<string, Value> => !!v && typeof v === 'object' && !Array.isArray(v);

function toParamText(v: Value): string {
  return typeof v === 'string' ? v : typeof v === 'boolean' ? String(v) : JSON.stringify(v, null, 2);
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
  if (first.text === '-' || first.text.startsWith('- ')) {
    const items: Value[] = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text === '-' || lines[i].text.startsWith('- '))) {
      const rest = lines[i].text.slice(1).trimStart();
      if (!rest) {
        const [v, next] = i + 1 < lines.length && lines[i + 1].indent > indent ? parseBlock(lines, i + 1, lines[i + 1].indent) : [null, i + 1];
        items.push(v);
        i = next;
        continue;
      }
      // "- key: value" opens a mapping whose further keys sit at the column after "- ".
      const inner = indent + (lines[i].text.length - rest.length);
      const copy = [...lines];
      copy[i] = { indent: inner, text: rest };
      const [v, next] = isKeyLine(rest) ? parseBlock(copy, i, inner) : [scalar(rest), i + 1];
      items.push(v);
      i = next;
    }
    return [items, i];
  }
  if (isKeyLine(first.text)) {
    const map: Record<string, Value> = {};
    while (i < lines.length && lines[i].indent === indent && isKeyLine(lines[i].text)) {
      const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(lines[i].text)!;
      const key = unquote(m[1]);
      const rest = (m[2] ?? '').trim();
      const next = lines[i + 1];
      if (/^[|>][-+]?$/.test(rest)) {
        const body: string[] = [];
        let j = i + 1;
        while (j < lines.length && lines[j].indent > indent) {
          body.push(' '.repeat(lines[j].indent) + lines[j].text);
          j++;
        }
        const min = Math.min(...body.map(b => b.length - b.trimStart().length));
        map[key] = body.map(b => b.slice(min)).join(rest.startsWith('>') ? ' ' : '\n');
        i = j;
      } else if (rest) {
        map[key] = scalar(rest);
        i++;
      } else if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('-')))) {
        [map[key], i] = parseBlock(lines, i + 1, next.indent);
      } else {
        map[key] = null;
        i++;
      }
    }
    return [map, i];
  }
  return [scalar(first.text), i + 1];
}

function isKeyLine(text: string): boolean {
  return /^("[^"]*"|'[^']*'|[^\s"'[{][^:]*?)\s*:(\s|$)/.test(text);
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
  if (t.startsWith('[') && t.endsWith(']')) {
    return splitFlow(t.slice(1, -1)).map(scalar);
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const map: Record<string, Value> = {};
    for (const part of splitFlow(t.slice(1, -1))) {
      const idx = part.indexOf(':');
      if (idx > 0) {
        map[unquote(part.slice(0, idx))] = scalar(part.slice(idx + 1));
      }
    }
    return map;
  }
  if (/^(true|false)$/i.test(t)) {
    return t.toLowerCase() === 'true';
  }
  if (t === '~' || t === 'null' || t === '') {
    return null;
  }
  return unquote(t);
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

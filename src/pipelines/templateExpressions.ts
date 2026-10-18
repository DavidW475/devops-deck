/**
 * Compile-time template expressions of Azure Pipelines (`${{ ... }}`): literals, `parameters.x` / `variables['x']`
 * access, `each` loop variables and the expression functions. A small recursive-descent parser over a tokenizer
 * (no regex on the expression text), case-insensitive like Azure DevOps.
 */

export type EValue = string | number | boolean | null | EValue[] | { [k: string]: EValue };
export type Scope = Record<string, EValue>;

export class ExpressionError extends Error {}

/** Types a result as EValue (expression results are dynamically typed by design). */
export const asValue = (v: EValue): EValue => v;

type Token = { t: 'str'; v: string } | { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'p'; v: string };

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isIdStart = (c: string | undefined) => c !== undefined && (c === '_' || (c.toLowerCase() !== c.toUpperCase()));
const isIdPart = (c: string | undefined) => isIdStart(c) || isDigit(c) || c === '-';

function readString(s: string, i: number): [string, number] {
  let out = '';
  let j = i + 1;
  for (;;) {
    if (j >= s.length) {
      throw new ExpressionError('Unterminated string');
    }
    if (s[j] === "'") {
      if (s[j + 1] !== "'") {
        return [out, j + 1];
      }
      j++;
    }
    out += s[j++];
  }
}

function readWhile(s: string, i: number, ok: (c: string | undefined) => boolean): number {
  let j = i;
  while (ok(s[j])) {
    j++;
  }
  return j;
}

export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === "'") {
      const [v, next] = readString(s, i);
      out.push({ t: 'str', v });
      i = next;
    } else if (isDigit(c) || (c === '-' && isDigit(s[i + 1]))) {
      const end = readWhile(s, i + 1, ch => isDigit(ch) || ch === '.');
      out.push({ t: 'num', v: Number(s.slice(i, end)) });
      i = end;
    } else if (isIdStart(c)) {
      const end = readWhile(s, i + 1, isIdPart);
      out.push({ t: 'id', v: s.slice(i, end) });
      i = end;
    } else if ('()[],.'.includes(c)) {
      out.push({ t: 'p', v: c });
      i++;
    } else {
      throw new ExpressionError(`Unexpected '${c}'`);
    }
  }
  return out;
}

const isObject = (v: EValue | undefined): v is { [k: string]: EValue } => !!v && typeof v === 'object' && !Array.isArray(v);

/** Property of an object, case-insensitive like Azure DevOps. */
export function property(obj: EValue | undefined, name: string): EValue {
  if (isObject(obj)) {
    // Own keys only: "constructor" or "__proto__" must not reach Object.prototype.
    if (Object.hasOwn(obj, name)) {
      return obj[name];
    }
    const key = Object.keys(obj).find(k => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? null : obj[key];
  }
  if (Array.isArray(obj) && /^\d+$/.test(name)) {
    return obj[Number(name)] ?? null;
  }
  return null;
}

/** Truthiness as in Azure DevOps: false, 0, '', null and empty collections are false. */
export function truthy(v: EValue): boolean {
  if (Array.isArray(v)) {
    return v.length > 0;
  }
  if (isObject(v)) {
    return Object.keys(v).length > 0;
  }
  return !!v;
}

/** String form used when an expression is part of a longer text: booleans become True/False. */
export function toText(v: EValue): string {
  if (v === null) {
    return '';
  }
  if (typeof v === 'boolean') {
    return v ? 'True' : 'False';
  }
  if (typeof v === 'object') {
    throw new ExpressionError(`Unable to convert from ${Array.isArray(v) ? 'Array' : 'Object'} to String`);
  }
  return String(v);
}

function toNumber(v: EValue): number {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0;
  }
  const n = v === null || v === '' ? 0 : Number(v);
  return Number.isNaN(n) ? Number.NaN : n;
}

function toBool(v: EValue): boolean {
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) {
    return v.toLowerCase() === 'true';
  }
  return truthy(v);
}

/** Compares like Azure DevOps: the right side is converted to the type of the left; strings ignore case. */
function compare(a: EValue, b: EValue): number {
  if (typeof a === 'number') {
    return a - toNumber(b);
  }
  if (typeof a === 'boolean') {
    return Number(a) - Number(toBool(b));
  }
  if (a === null || typeof a === 'string') {
    const x = (a ?? '').toLowerCase();
    const y = typeof b === 'object' && b !== null ? JSON.stringify(b) : toText(b).toLowerCase();
    return x.localeCompare(y, 'en', { sensitivity: 'base' });
  }
  return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

const equal = (a: EValue, b: EValue) => compare(a, b) === 0;
const lower = (v: EValue) => toText(v).toLowerCase();

function format(args: EValue[]): string {
  const fmt = toText(args[0] ?? '');
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if ((c === '{' || c === '}') && fmt[i + 1] === c) {
      out += c;
      i += 2;
    } else if (c === '{') {
      const close = fmt.indexOf('}', i);
      const index = Number(fmt.slice(i + 1, close));
      if (close < 0 || !Number.isInteger(index)) {
        throw new ExpressionError(`Invalid format string '${fmt}'`);
      }
      out += toText(args[index + 1] ?? null);
      i = close + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function containsValue(haystack: EValue, needle: EValue): boolean {
  if (Array.isArray(haystack)) {
    return haystack.some(x => equal(needle, x));
  }
  return isObject(haystack) && Object.values(haystack).some(x => equal(needle, x));
}

function length(v: EValue): number {
  if (Array.isArray(v) || typeof v === 'string') {
    return v.length;
  }
  return isObject(v) ? Object.keys(v).length : 0;
}

function split(text: EValue, delimiters: EValue): string[] {
  const d = toText(delimiters);
  if (!d) {
    return [toText(text)];
  }
  return toText(text).split(d);
}

const FUNCTIONS: Record<string, (a: EValue[]) => EValue> = {
  and: a => a.every(truthy),
  or: a => a.some(truthy),
  not: a => !truthy(a[0]),
  xor: a => truthy(a[0]) !== truthy(a[1]),
  eq: a => equal(a[0], a[1]),
  ne: a => !equal(a[0], a[1]),
  gt: a => compare(a[0], a[1]) > 0,
  ge: a => compare(a[0], a[1]) >= 0,
  lt: a => compare(a[0], a[1]) < 0,
  le: a => compare(a[0], a[1]) <= 0,
  contains: a => (Array.isArray(a[0]) ? containsValue(a[0], a[1]) : lower(a[0]).includes(lower(a[1]))),
  containsvalue: a => containsValue(a[0], a[1]),
  startswith: a => lower(a[0]).startsWith(lower(a[1])),
  endswith: a => lower(a[0]).endsWith(lower(a[1])),
  in: a => a.slice(1).some(x => equal(a[0], x)),
  notin: a => !a.slice(1).some(x => equal(a[0], x)),
  coalesce: a => a.find(x => x !== null && x !== '') ?? null,
  iif: a => (truthy(a[0]) ? a[1] : a[2]) ?? null,
  format,
  join: a => (Array.isArray(a[1]) ? a[1].map(toText).join(toText(a[0])) : toText(a[1] ?? null)),
  length: a => length(a[0]),
  lower: a => lower(a[0]),
  upper: a => toText(a[0]).toUpperCase(),
  trim: a => toText(a[0]).trim(),
  replace: a => toText(a[0]).split(toText(a[1])).join(toText(a[2] ?? '')),
  split: a => split(a[0], a[1] ?? ''),
  converttojson: a => JSON.stringify(a[0] ?? null, null, 2),
};

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[], private readonly scope: Scope) {}

  parse(): EValue {
    const v = this.expr();
    if (this.i < this.tokens.length) {
      throw new ExpressionError('Unexpected text after the expression');
    }
    return v;
  }

  private peek(v: string): boolean {
    const t = this.tokens[this.i];
    return t?.t === 'p' && t.v === v;
  }

  private expect(v: string): void {
    if (!this.peek(v)) {
      throw new ExpressionError(`Expected '${v}'`);
    }
    this.i++;
  }

  private expr(): EValue {
    let v = this.primary();
    for (;;) {
      if (this.peek('.')) {
        this.i++;
        const t = this.tokens[this.i++];
        if (t?.t !== 'id' && t?.t !== 'num') {
          throw new ExpressionError('Expected a property name');
        }
        v = property(v, String(t.v));
      } else if (this.peek('[')) {
        this.i++;
        const key = this.expr();
        this.expect(']');
        v = property(v, toText(key));
      } else {
        return v;
      }
    }
  }

  private primary(): EValue {
    const t = this.tokens[this.i++];
    if (!t) {
      throw new ExpressionError('Unexpected end of expression');
    }
    if (t.t === 'str' || t.t === 'num') {
      return asValue(t.v);
    }
    if (t.t === 'p') {
      if (t.v !== '(') {
        throw new ExpressionError(`Unexpected '${t.v}'`);
      }
      const v = this.expr();
      this.expect(')');
      return v;
    }
    const name = t.v.toLowerCase();
    if (this.peek('(')) {
      return this.call(name);
    }
    const literals: Record<string, EValue> = { true: true, false: false, null: null };
    if (name in literals) {
      return literals[name];
    }
    return property(this.scope, t.v);
  }

  private call(name: string): EValue {
    const fn = FUNCTIONS[name];
    if (!fn) {
      throw new ExpressionError(`Unknown function '${name}' (or only available at runtime)`);
    }
    this.expect('(');
    const args: EValue[] = [];
    while (!this.peek(')')) {
      args.push(this.expr());
      if (!this.peek(')')) {
        this.expect(',');
      }
    }
    this.i++;
    return fn(args);
  }
}

export function evaluate(expr: string, scope: Scope): EValue {
  return new Parser(tokenize(expr), scope).parse();
}

/** Position of every `${{ … }}` in a text (quotes inside are respected, so `'}}'` does not end it). */
function expressionSpans(text: string): { start: number; end: number; expr: string }[] {
  const spans: { start: number; end: number; expr: string }[] = [];
  let from = 0;
  for (let start = text.indexOf('${{', from); start >= 0; start = text.indexOf('${{', from)) {
    let quote = false;
    let end = -1;
    for (let i = start + 3; i < text.length - 1; i++) {
      if (text[i] === "'") {
        quote = !quote;
      } else if (!quote && text[i] === '}' && text[i + 1] === '}') {
        end = i;
        break;
      }
    }
    if (end < 0) {
      throw new ExpressionError('Missing }} after ${{');
    }
    spans.push({ start, end: end + 2, expr: text.slice(start + 3, end).trim() });
    from = end + 2;
  }
  return spans;
}

/**
 * Replaces the expressions in a text. A text that is exactly one expression keeps the value's type
 * (so `${{ parameters.steps }}` can insert a list); otherwise the values are joined as text.
 */
export function substitute(text: string, scope: Scope): EValue {
  const spans = expressionSpans(text);
  if (!spans.length) {
    return asValue(text);
  }
  if (spans.length === 1 && spans[0].start === 0 && spans[0].end === text.length) {
    return evaluate(spans[0].expr, scope);
  }
  let out = '';
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start) + toText(evaluate(s.expr, scope));
    pos = s.end;
  }
  return asValue(out + text.slice(pos));
}

/** `${{ if x }}`, `${{ elseif x }}`, `${{ else }}`, `${{ each v in x }}`, `${{ insert }}` keys. */
export type Directive =
  | { kind: 'if' | 'elseif'; expr: string }
  | { kind: 'else' | 'insert' }
  | { kind: 'each'; name: string; expr: string };

export function directiveOf(key: string): Directive | undefined {
  const k = key.trim();
  if (!k.startsWith('${{') || !k.endsWith('}}')) {
    return undefined;
  }
  const body = k.slice(3, -2).trim();
  const [word] = body.split(/\s/, 1);
  const rest = body.slice(word.length).trim();
  switch (word.toLowerCase()) {
    case 'if':
    case 'elseif':
      return { kind: word.toLowerCase() as 'if' | 'elseif', expr: rest };
    case 'else':
    case 'insert':
      return { kind: word.toLowerCase() as 'else' | 'insert' };
    case 'each': {
      const at = rest.indexOf(' in ');
      return at > 0 ? { kind: 'each', name: rest.slice(0, at).trim(), expr: rest.slice(at + 4).trim() } : undefined;
    }
    default:
      return undefined;
  }
}

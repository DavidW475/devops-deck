/**
 * The `visibleRule` of task inputs and input groups (`scriptLocation = inlineScript`, `a == b && c != d`): a scanner
 * and a three-valued (Kleene) evaluator. No regular expressions, so no backtracking on server data.
 */
import { TaskInfo, TaskInput } from './taskModel';
import { isExpression } from './templateRefs';

export type RuleOp = '=' | '!=' | 'endswith' | 'notendswith';

export type RuleNode =
  | { kind: 'cmp'; name: string; op: RuleOp; value: string }
  | { kind: 'and' | 'or'; items: RuleNode[] }
  /** A construct that is understood but can't be decided (`&&` and `||` mixed without parentheses). */
  | { kind: 'unknown' };

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

class RuleScanner {
  pos = 0;
  constructor(readonly text: string) {}

  skipSpaces(): void {
    while (isSpace(this.text[this.pos])) {
      this.pos++;
    }
  }

  /** Consumes `&&` or `||` at the position, returning it. */
  takeLogic(): '&&' | '||' | undefined {
    this.skipSpaces();
    const two = this.text.slice(this.pos, this.pos + 2);
    if (two === '&&' || two === '||') {
      this.pos += 2;
      return two;
    }
    return undefined;
  }

  /** The input name: up to white space or the start of an operator. */
  name(): string {
    this.skipSpaces();
    const start = this.pos;
    while (this.pos < this.text.length && !isSpace(this.text[this.pos]) && !'=!()&|'.includes(this.text[this.pos])) {
      this.pos++;
    }
    return this.text.slice(start, this.pos);
  }

  op(): RuleOp | undefined {
    this.skipSpaces();
    const t = this.text;
    const symbols: [string, RuleOp][] = [['==', '='], ['=', '='], ['!=', '!=']];
    for (const [symbol, op] of symbols) {
      if (t.startsWith(symbol, this.pos)) {
        this.pos += symbol.length;
        return op;
      }
    }
    const start = this.pos;
    while (this.pos < t.length && !isSpace(t[this.pos]) && !'()&|=!'.includes(t[this.pos])) {
      this.pos++;
    }
    const word = t.slice(start, this.pos).toLowerCase();
    if (word === 'endswith' || word === 'notendswith') {
      return word;
    }
    return undefined;
  }

  /** The value reaches to the next `&&`, `||` or an unmatched `)`; it may hold spaces and balanced parentheses. */
  value(): string {
    const start = this.pos;
    let depth = 0;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      const two = this.text.slice(this.pos, this.pos + 2);
      if (two === '&&' || two === '||' || (c === ')' && depth === 0)) {
        break;
      }
      depth += c === '(' ? 1 : 0;
      depth -= c === ')' ? 1 : 0;
      this.pos++;
    }
    return this.text.slice(start, this.pos).trim();
  }
}

const MAX_DEPTH = 32;

function parseTerm(s: RuleScanner, depth: number): RuleNode | undefined {
  s.skipSpaces();
  if (s.text[s.pos] === '(') {
    if (depth >= MAX_DEPTH) {
      return undefined;
    }
    s.pos++;
    const inner = parseExpr(s, depth + 1);
    s.skipSpaces();
    if (!inner || s.text[s.pos] !== ')') {
      return undefined;
    }
    s.pos++;
    return inner;
  }
  const name = s.name();
  const op = name ? s.op() : undefined;
  return op ? { kind: 'cmp', name, op, value: s.value() } : undefined;
}

function parseExpr(s: RuleScanner, depth: number): RuleNode | undefined {
  const first = parseTerm(s, depth);
  if (!first) {
    return undefined;
  }
  const items = [first];
  const logic = new Set<string>();
  for (let op = s.takeLogic(); op; op = s.takeLogic()) {
    const term = parseTerm(s, depth);
    if (!term) {
      return undefined;
    }
    logic.add(op);
    items.push(term);
  }
  if (logic.size === 0) {
    return first;
  }
  return logic.size > 1 ? { kind: 'unknown' } : { kind: logic.has('&&') ? 'and' : 'or', items };
}

/** Parses a rule; undefined when it does not fit the grammar (the caller then treats visibility as unknown). */
export function parseVisibleRule(rule: string): RuleNode | undefined {
  const s = new RuleScanner(rule);
  const node = parseExpr(s, 0);
  s.skipSpaces();
  return node && s.pos >= rule.length ? node : undefined;
}

function compare(op: RuleOp, actual: string, expected: string): boolean {
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  switch (op) {
    case '=':
      return a === e;
    case '!=':
      return a !== e;
    case 'endswith':
      return a.endsWith(e);
    default:
      return !a.endsWith(e);
  }
}

/** Kleene logic: `undefined` is "unknown". */
export function evalRule(node: RuleNode, value: (name: string) => string | undefined): boolean | undefined {
  if (node.kind === 'unknown') {
    return undefined;
  }
  if (node.kind === 'cmp') {
    const actual = value(node.name);
    return actual === undefined ? undefined : compare(node.op, actual, node.value);
  }
  const decisive = node.kind === 'or';
  let unknown = false;
  for (const item of node.items) {
    const r = evalRule(item, value);
    if (r === decisive) {
      return decisive;
    }
    unknown ||= r === undefined;
  }
  return unknown ? undefined : !decisive;
}

/** Kleene AND of two optional results. */
function and3(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  if (a === false || b === false) {
    return false;
  }
  return a === undefined || b === undefined ? undefined : true;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The input a rule or a passed key refers to: by name or alias, case-insensitive. */
export function findInput(task: TaskInfo, key: string): TaskInput | undefined {
  return task.inputs.find(i => same(i.name, key) || i.aliases.some(a => same(a, key)));
}

const answersTo = (input: TaskInput, key: string) => same(input.name, key) || input.aliases.some(a => same(a, key));

interface Context {
  task: TaskInfo;
  passed: Map<string, string>;
  conditional: ReadonlySet<string>;
  /** inputs whose visibility is being computed (a rule cycle gives unknown) */
  open: Set<TaskInput>;
}

function passedValue(ctx: Context, input: TaskInput): { set: boolean; value?: string; conditional: boolean } {
  for (const [key, value] of ctx.passed) {
    if (answersTo(input, key)) {
      return { set: true, value, conditional: [...ctx.conditional].some(c => answersTo(input, c)) };
    }
  }
  return { set: false, conditional: [...ctx.conditional].some(c => answersTo(input, c)) };
}

/** The value a rule sees for the input named `name`: passed value, else its default; undefined when unknown. */
function ruleValue(ctx: Context, name: string): string | undefined {
  const input = findInput(ctx.task, name);
  if (!input || ctx.open.has(input)) {
    return undefined;
  }
  const given = passedValue(ctx, input);
  if (given.conditional || (given.set && isExpression(given.value ?? ''))) {
    return undefined;
  }
  if (visibilityOf(ctx, input) !== true) {
    return undefined;
  }
  return given.set ? given.value : (input.default ?? '');
}

function evalText(ctx: Context, rule: string | undefined): boolean | undefined {
  if (!rule?.trim()) {
    return true;
  }
  const node = parseVisibleRule(rule);
  return node ? evalRule(node, name => ruleValue(ctx, name)) : undefined;
}

function visibilityOf(ctx: Context, input: TaskInput): boolean | undefined {
  if (!input.visibleRule?.trim() && !input.group) {
    return true;
  }
  ctx.open.add(input);
  const group = input.group ? ctx.task.groups.find(g => g.name === input.group) : undefined;
  const result = and3(evalText(ctx, input.visibleRule), evalText(ctx, group?.visibleRule));
  ctx.open.delete(input);
  return result;
}

/**
 * Whether the input is shown for the values passed so far: its own rule AND its group's rule. `passed` maps the
 * written input names to values; `conditional` holds the names set under `${{ if }}` / `${{ each }}`. Unknown (undefined)
 * when a rule can't be parsed or reads an expression, a conditional input, an unknown name or a hidden input.
 */
export function inputVisibility(
  task: TaskInfo, input: TaskInput, passed: Map<string, string>, conditional: ReadonlySet<string>,
): boolean | undefined {
  return visibilityOf({ task, passed, conditional, open: new Set() }, input);
}

/**
 * Expands an Azure Pipelines YAML file locally, the way the server would at compile time: `extends`, `template:`
 * references (recursively, through `TemplateResolver`, so local clones and unsaved changes count), parameters with
 * types and defaults, and `${{ }}` expressions including `if` / `elseif` / `else`, `each` and `insert`.
 * Runtime parts (`$[ ]`, `$( )`, `condition:`) are kept as text. Every expanded mapping remembers its source.
 */
import { asValue, directiveOf, EValue, ExpressionError, property, Scope, substitute, truthy } from './templateExpressions';
import { parseTemplatePath } from './templateRefs';
import { ResolvedTemplate, TemplateContext, TemplateResolver, templateText } from './templateResolver';
import { parseYamlDocument, setOwn, yamlLine } from './yamlParameters';

export interface SourceRef {
  /** document URI (string) */
  uri: string;
  label: string;
  line: number;
}

export interface ExpandResult {
  doc: { [k: string]: EValue };
  sourceOf: (node: object) => SourceRef | undefined;
  warnings: string[];
  files: number;
}

/** Placeholder for a template that could not be read; shown as an error item in the preview. */
export const UNRESOLVED = '__unresolved';

const MAX_FILES = 100;
const MAX_DEPTH = 20;
const LIST_KEYS = ['stages', 'jobs', 'steps', 'variables'];

type Obj = { [k: string]: EValue };
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Copies the own keys of `from` onto `to` (Object.assign would treat a "__proto__" key as the prototype). */
function assignOwn(to: Obj, from: Obj): Obj {
  Object.entries(from).forEach(([k, v]) => setOwn(to, k, v));
  return to;
}

/** A value as text for comparisons and messages: scalars as they are, lists and mappings as JSON. */
function display(v: EValue): string {
  return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function without(o: Obj, ...keys: string[]): Obj {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
}

interface Frame {
  ctx: TemplateContext;
  uri: string;
  label: string;
  scope: Scope;
  depth: number;
}

interface DeclaredParam {
  name: string;
  type: string;
  default?: EValue;
  values?: EValue[];
}

/** Parameters a pipeline or template declares, with typed defaults (list form or the legacy mapping form). */
export function declaredParameters(doc: EValue | undefined): DeclaredParam[] {
  const p = isObj(doc) ? doc.parameters : undefined;
  if (Array.isArray(p)) {
    return p.filter(isObj).flatMap(x => (typeof x.name === 'string' ? [x as Obj & { name: string }] : [])).map(x => ({
      name: x.name, type: typeof x.type === 'string' ? x.type : 'string',
      default: x.default ?? undefined, values: Array.isArray(x.values) ? x.values : undefined,
    }));
  }
  return isObj(p) ? Object.entries(p).map(([name, d]) => ({ name, type: 'legacy', default: d })) : [];
}

/** Converts a passed value to the parameter type (`'true'` → true for booleans, text → number). */
export function coerce(p: DeclaredParam, v: EValue): EValue {
  if (p.type === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v.trim())) {
    return asValue(v.trim().toLowerCase() === 'true');
  }
  if (p.type === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return asValue(Number(v));
  }
  if (p.type === 'object' && typeof v === 'string' && /^\s*[[{]/.test(v)) {
    try {
      return JSON.parse(v) as EValue;
    } catch {
      return asValue(v);
    }
  }
  return v;
}

const sameValue = (a: EValue, b: EValue) => display(a).toLowerCase() === display(b).toLowerCase();

/** Binds passed values to declared parameters; problems become warnings, like the server's errors. */
export function bindParameters(declared: DeclaredParam[], passed: Obj, where: string, warn: (m: string) => void): Obj {
  const out: Obj = {};
  for (const p of declared) {
    const given = property(passed, p.name);
    const has = Object.keys(passed).some(k => k.toLowerCase() === p.name.toLowerCase());
    if (!has && p.default === undefined) {
      warn(`${where}: a value for the parameter '${p.name}' must be provided.`);
    }
    const value = coerce(p, has ? given : p.default ?? null);
    if (p.values?.length && has && !p.values.some(v => sameValue(v, value))) {
      warn(`${where}: '${display(value)}' is not an allowed value of '${p.name}'.`);
    }
    setOwn(out, p.name, value);
  }
  for (const k of Object.keys(passed)) {
    if (!declared.some(p => p.name.toLowerCase() === k.toLowerCase())) {
      warn(`${where}: unexpected parameter '${k}'.`);
    }
  }
  return out;
}

/** Variables known at compile time: literal `variables:` of the file plus a few predefined ones. */
export function staticVariables(doc: EValue | undefined, branch: string | undefined): Obj {
  const out: Obj = {
    'Build.Reason': 'Manual',
    'Build.SourceBranch': branch ? `refs/heads/${branch}` : '',
    'Build.SourceBranchName': branch?.split('/').pop() ?? '',
  };
  const v = isObj(doc) ? doc.variables : undefined;
  if (isObj(v)) {
    Object.entries(v).filter(([k]) => !k.startsWith('${{')).forEach(([k, x]) => setOwn(out, k, x));
  } else if (Array.isArray(v)) {
    for (const x of v.filter(isObj)) {
      if (typeof x.name === 'string') {
        setOwn(out, x.name, x.value ?? '');
      }
    }
  }
  return out;
}

export class TemplateExpander {
  private readonly sources = new WeakMap<object, SourceRef>();
  private readonly warnings: string[] = [];
  private files = 0;

  constructor(private readonly resolver: Pick<TemplateResolver, 'resolve'>) {}

  /** Expands the root document; `parameters` are runtime parameter values as entered (text). */
  async expand(ctx: TemplateContext, text: string, uri: string, label: string,
    opts: { parameters?: Record<string, string>; branch?: string } = {}): Promise<ExpandResult> {
    const doc = parseYamlDocument(text);
    if (!isObj(doc)) {
      throw new Error('The file is not a pipeline (no top-level mapping).');
    }
    const params = bindParameters(declaredParameters(doc), opts.parameters ?? {}, label, m => this.warn(m));
    const variables = staticVariables(doc, opts.branch);
    const frame: Frame = { ctx, uri, label, scope: { parameters: params, variables }, depth: 0 };
    const ext = doc.extends;
    let out = await this.expandMap(without(doc, 'parameters', 'extends'), frame, doc);
    if (isObj(ext)) {
      const template = await this.expandMap(ext, frame);
      const included = await this.load(template, frame);
      if (included) {
        const body = await this.expandMap(without(included.doc, 'parameters'), included.frame, included.doc);
        out = assignOwn(body, { ...out, ...body });
      }
    }
    const sources = this.sources;
    return { doc: out, sourceOf: n => sources.get(n), warnings: [...this.warnings], files: this.files };
  }

  private warn(m: string): void {
    if (!this.warnings.includes(m)) {
      this.warnings.push(m);
    }
  }

  private text(v: string, f: Frame): EValue {
    try {
      return substitute(v, f.scope);
    } catch (e) {
      if (e instanceof ExpressionError) {
        this.warn(`${f.label}: ${e.message} in '${v}'`);
        return asValue(v);
      }
      throw e;
    }
  }

  private condition(expr: string, f: Frame): boolean {
    return truthy(this.text('${{ ' + expr + ' }}', f));
  }

  /** `key` is the mapping key the value belongs to (`steps`, `jobs`, …), so templates insert the right kind of list. */
  private async value(v: EValue, f: Frame, key?: string): Promise<EValue> {
    if (typeof v === 'string') {
      return this.text(v, f);
    }
    if (Array.isArray(v)) {
      return this.expandList(v, f, key);
    }
    return isObj(v) ? this.expandMap(v, f) : v;
  }

  /**
   * Expands a mapping; `origin` is the parsed node whose line is remembered (defaults to `map`).
   * Mappings, lists and `each` expand one entry after another on purpose: an `if`/`elseif`/`else` chain depends on
   * the entries before it, the file budget (MAX_FILES) must cut the same templates on every run, and warnings keep
   * the order of the source.
   */
  private async expandMap(map: Obj, f: Frame, origin: object = map): Promise<Obj> {
    const out: Obj = {};
    this.remember(out, origin, f);
    let chain: boolean | undefined;
    for (const [key, v] of Object.entries(map)) {
      const d = directiveOf(key);
      if (!d) {
        chain = undefined;
        const k = this.text(key, f);
        setOwn(out, typeof k === 'string' ? k : key, await this.value(v, f, key)); // NOSONAR: sequential on purpose, see expandMap
        continue;
      }
      const parts = await this.directive(d, v, f, chain); // NOSONAR: sequential on purpose, see expandMap
      chain = parts.chain;
      for (const part of parts.values) {
        if (isObj(part)) {
          assignOwn(out, part);
        } else if (part !== null) {
          this.warn(`${f.label}: '${key}' must produce a mapping here.`);
        }
      }
    }
    return out;
  }

  /** Runs one directive; returns the expanded values and the state of the if/elseif/else chain. */
  private async directive(d: NonNullable<ReturnType<typeof directiveOf>>, body: EValue, f: Frame, chain: boolean | undefined, key?: string):
    Promise<{ values: EValue[]; chain: boolean | undefined }> {
    switch (d.kind) {
      case 'if': {
        const ok = this.condition(d.expr, f);
        return { values: ok ? [await this.value(body, f, key)] : [], chain: ok };
      }
      case 'elseif': {
        if (chain === undefined) {
          this.warn(`${f.label}: \${{ elseif }} without \${{ if }}.`);
        }
        const ok = chain === false && this.condition(d.expr, f);
        return { values: ok ? [await this.value(body, f, key)] : [], chain: chain || ok };
      }
      case 'else':
        return { values: chain === false ? [await this.value(body, f, key)] : [], chain: undefined };
      case 'insert':
        return { values: [await this.value(body, f, key)], chain: undefined };
      default:
        return { values: await this.each(d.name, d.expr, body, f, key), chain: undefined };
    }
  }

  private async each(name: string, expr: string, body: EValue, f: Frame, key?: string): Promise<EValue[]> {
    const collection = this.text('${{ ' + expr + ' }}', f);
    let items: EValue[] = [];
    if (Array.isArray(collection)) {
      items = collection;
    } else if (isObj(collection)) {
      items = Object.entries(collection).map(([key, value]) => ({ key, value }));
    }
    const out: EValue[] = [];
    for (const item of items) {
      out.push(await this.value(body, { ...f, scope: { ...f.scope, [name]: item } }, key)); // NOSONAR: sequential on purpose, see expandMap
    }
    return out;
  }

  private async expandList(list: EValue[], f: Frame, key?: string): Promise<EValue[]> {
    const out: EValue[] = [];
    let chain: boolean | undefined;
    for (const item of list) {
      const keys = isObj(item) ? Object.keys(item) : [];
      const d = keys.length === 1 ? directiveOf(keys[0]) : undefined;
      if (d && isObj(item)) {
        const parts = await this.directive(d, item[keys[0]], f, chain, key); // NOSONAR: sequential on purpose, see expandMap
        chain = parts.chain;
        parts.values.forEach(p => (Array.isArray(p) ? out.push(...p) : p !== null && out.push(p)));
        continue;
      }
      chain = undefined;
      if (isObj(item) && typeof item.template === 'string') {
        out.push(...await this.include(item, f, key)); // NOSONAR: sequential on purpose, see expandMap
        continue;
      }
      const value = await this.value(item, f); // NOSONAR: sequential on purpose, see expandMap
      // `- ${{ parameters.stages }}` inserts the items of a list parameter (stepList, stageList, …) in place.
      if (typeof item === 'string' && Array.isArray(value)) {
        out.push(...value);
      } else {
        out.push(value);
      }
    }
    return out;
  }

  /** A `- template:` item of a stage, job, step or variable list: the template's list, expanded. */
  private async include(item: Obj, f: Frame, listKey?: string): Promise<EValue[]> {
    const ref = await this.expandMap(item, f, item);
    const loaded = await this.load(ref, f);
    if (!loaded) {
      return [ref];
    }
    const has = LIST_KEYS.filter(k => Array.isArray(loaded.doc[k]));
    const key = listKey && LIST_KEYS.includes(listKey) ? listKey : has[0];
    if (!key || !has.includes(key)) {
      const found = has.length ? `contains ${has.join(', ')}` : 'contains no stages, jobs, steps or variables';
      this.warn(`${loaded.frame.label}: ${found}, but is used as a ${key ?? 'list'} template.`);
      return [];
    }
    return this.expandList(loaded.doc[key] as EValue[], loaded.frame, key);
  }

  /**
   * Reads the template a reference (`template` + `parameters`, already expanded) points to and binds its parameters.
   * Failures mark `ref` as unresolved (shown in the preview) and return undefined.
   */
  private async load(ref: Obj, f: Frame): Promise<{ doc: Obj; frame: Frame } | undefined> {
    const raw = typeof ref.template === 'string' ? ref.template : '';
    const target = parseTemplatePath(raw);
    const fail = (message: string) => {
      ref[UNRESOLVED] = message;
      this.warn(`${f.label}: ${message}`);
      return undefined;
    };
    if (!target) {
      return fail(`Template path '${raw}' can't be resolved.`);
    }
    if (f.depth >= MAX_DEPTH) {
      return fail(`${templateText(target)}: templates are nested deeper than ${MAX_DEPTH} levels.`);
    }
    if (++this.files > MAX_FILES) {
      return fail(`${templateText(target)}: more than ${MAX_FILES} template files.`);
    }
    let resolved: ResolvedTemplate;
    try {
      resolved = await this.resolver.resolve(f.ctx, target);
    } catch (e) {
      return fail(`${templateText(target)}: ${(e as Error).message}`);
    }
    const doc = parseYamlDocument(resolved.text);
    if (!isObj(doc)) {
      return fail(`${resolved.label} is empty or not a mapping.`);
    }
    const passed = isObj(ref.parameters) ? ref.parameters : {};
    const parameters = bindParameters(declaredParameters(doc), passed, resolved.label, m => this.warn(m));
    const frame: Frame = {
      ctx: resolved.context, uri: resolved.uri.toString(), label: resolved.label,
      scope: { parameters, variables: f.scope.variables }, depth: f.depth + 1,
    };
    return { doc, frame };
  }

  private remember(out: object, origin: object, f: Frame): void {
    this.sources.set(out, { uri: f.uri, label: f.label, line: yamlLine(origin) ?? 0 });
  }
}

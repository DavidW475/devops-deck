/**
 * Finds `- task: Name@Major` steps in Azure Pipelines YAML, works out what the user is typing there and checks a step
 * against the task catalog. Pure and line based like `templateRefs.ts`: positions are needed for completions and
 * diagnostics, and every YAML file reaches these functions, so they report only what is certain.
 */
import { RetiredTask, TaskCompletionContext, TaskInfo, TaskInput, TaskIssue, TaskIndex, TaskStepRef } from './taskModel';
import { findInput, inputVisibility } from './taskRules';
import { blockParams, flowParams, isExpression, mappingOf, ParamEntry, parentOf, scanYaml, TemplateRef, YLine } from './templateRefs';
import { PipelineParameter, unquote } from './yamlParameters';

const isDigits = (s: string) => s.length > 0 && [...s].every(c => c >= '0' && c <= '9');

/** `AzureCLI@2`, `GoTool@0.3.1` or `<guid>@1`; undefined for expressions and anything without `Name@Version`. */
export function parseTaskRef(raw: string): { name: string; major: number; pinned?: string } | undefined {
  const text = unquote(raw);
  const at = text.indexOf('@');
  if (at < 1 || isExpression(text) || [...text].some(c => c === ' ' || c === '\t')) {
    return undefined;
  }
  const name = text.slice(0, at);
  const version = text.slice(at + 1);
  const parts = version.split('.');
  if (!parts.every(isDigits)) {
    return undefined;
  }
  return { name, major: Number(parts[0]), pinned: parts.length > 1 ? version : undefined };
}

const isQuote = (c: string | undefined) => c === '"' || c === "'";

/** Start and end column of the value text inside its quotes. */
function valueSpan(l: YLine): { start: number; end: number } {
  const start = l.restCol;
  const end = l.restCol + l.rest.length;
  if (l.rest.length >= 2 && isQuote(l.rest[0]) && l.rest.at(-1) === l.rest[0]) {
    return { start: start + 1, end: end - 1 };
  }
  return { start, end };
}

/** End of the step's mapping, including the text of a block scalar (`script: |`) that scanYaml reads as blank. */
function stepEnd(lines: YLine[], raw: string[], end: number): number {
  let last = end;
  for (let j = end + 1; j < lines.length && lines[j].blank; j++) {
    const t = raw[j].trim();
    if (t && !t.startsWith('#')) {
      last = j;
    }
  }
  return last + 1;
}

function inputsOf(lines: YLine[], p: YLine): { inputs: ParamEntry[]; dynamic: boolean } {
  if (p.rest.startsWith('{') && p.rest.endsWith('}')) {
    return { inputs: flowParams(p), dynamic: false };
  }
  if (p.rest) {
    return { inputs: [], dynamic: true };
  }
  const block = blockParams(lines, p);
  return { inputs: block.params, dynamic: block.dynamic };
}

/** Every `- task:` step of the document (only list items with the key `task`; a task named in a script is no step). */
export function findTaskSteps(text: string): TaskStepRef[] {
  const raw = text.split(/\r?\n/);
  const lines = scanYaml(text);
  const steps: TaskStepRef[] = [];
  for (const l of lines) {
    if (l.blank || !l.dash || l.key !== 'task') {
      continue;
    }
    const { siblings, end } = mappingOf(lines, l.n);
    const span = valueSpan(l);
    const value = unquote(l.rest);
    const ref = parseTaskRef(value);
    const step: TaskStepRef = {
      line: l.n, keyCol: l.keyCol, raw: value, valueStart: span.start, valueEnd: span.end, end: stepEnd(lines, raw, end),
      name: ref?.name, major: ref?.major, pinned: ref?.pinned, dynamicInputs: false, inputs: [],
    };
    const p = siblings.find(s => s.key === 'inputs');
    if (p) {
      const found = inputsOf(lines, p);
      step.inputsLine = p.n;
      step.inputs = found.inputs;
      step.dynamicInputs = found.dynamic;
    }
    steps.push(step);
  }
  return steps;
}

/** `steps:` above, or a `parameters:` block (a stepList parameter): the places where a bare task name is expected. */
function inStepsContext(lines: YLine[], line: number, col: number): boolean {
  let at = parentOf(lines, line, col);
  while (at) {
    if (at.key === 'steps' || at.key === 'parameters') {
      return true;
    }
    at = parentOf(lines, at.n, at.keyCol);
  }
  return false;
}

/** Cursor on the value of a `- task:` line. */
function valueContext(lines: YLine[], step: TaskStepRef, rawLine: string, col: number): TaskCompletionContext | undefined {
  const colon = rawLine.indexOf(':', step.keyCol);
  let start = colon + 1;
  while (rawLine[start] === ' ') {
    start++;
  }
  start = isQuote(rawLine[start]) ? start + 1 : start;
  const end = Math.max(step.valueEnd, start);
  if (col < start || col > end || isExpression(step.raw)) {
    return undefined;
  }
  const value = rawLine.slice(start, end);
  const at = value.indexOf('@');
  const typed = rawLine.slice(start, col);
  if (at >= 0 && typed.includes('@')) {
    const name = value.slice(0, at);
    const from = start + at + 1;
    return { kind: 'taskVersion', step, name, prefix: rawLine.slice(from, col), start: from, end, line: step.line };
  }
  if (at < 0 && !inStepsContext(lines, step.line, step.keyCol)) {
    return undefined;
  }
  return { kind: 'taskName', step, prefix: typed, start, end: at >= 0 ? start + at : end, line: step.line };
}

/** Cursor on an empty or partly typed line beside or below a step: the `inputs` key, an input name or a value. */
function bodyContext(lines: YLine[], steps: TaskStepRef[], rawLine: string, line: number, col: number): TaskCompletionContext | undefined {
  const typed = rawLine.slice(0, col);
  const indent = typed.length - typed.trimStart().length;
  let parent = parentOf(lines, line, indent);
  while (parent?.key && isExpression(parent.key)) {
    parent = parentOf(lines, parent.n, parent.keyCol);
  }
  const owner = parent?.key === 'inputs' && !parent.rest ? steps.find(s => s.inputsLine === parent.n) : undefined;
  if (owner) {
    const colon = typed.indexOf(': ');
    return colon > indent ? { kind: 'inputValue', step: owner, name: unquote(typed.slice(indent, colon)) } : { kind: 'inputName', step: owner };
  }
  const word = typed.trim();
  const sibling = steps.find(s => s.inputsLine === undefined && s.keyCol === indent && s.line < line && line <= s.end);
  return sibling && 'inputs'.startsWith(word) && !word.includes(':') ? { kind: 'inputsKey', step: sibling } : undefined;
}

/**
 * What the user is typing at (line, col): the task name or version of a `- task:` line, the `inputs` key of a step,
 * an input name or an input value. A name without `@` is only offered below `steps:` or in a `parameters:` block.
 */
export function taskCompletionContext(text: string, line: number, col: number): TaskCompletionContext | undefined {
  const lines = scanYaml(text);
  const rawLines = text.split(/\r?\n/);
  const rawLine = rawLines[line];
  if (line < 0 || line >= rawLines.length || !lines[line]) {
    return undefined;
  }
  const steps = findTaskSteps(text);
  const own = steps.find(s => s.line === line);
  if (own) {
    return valueContext(lines, own, rawLine, col);
  }
  if (lines[line].blank && rawLine.trim() !== '') {
    return undefined;
  }
  return bodyContext(lines, steps, rawLine, line, col);
}

export interface TaskCheckOptions {
  /** The catalog is loaded and recent: only then is "not installed" reported. */
  catalogFresh: boolean;
  /** Report a newer, non-deprecated major version (information). */
  versionHints: boolean;
  /** The step's task appears on the retirement list. */
  retired?: RetiredTask;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The newest major that is neither deprecated nor a preview, when it is newer than `major`. */
export function newestMajor(index: TaskIndex, name: string, major: number): number | undefined {
  for (const m of index.majors(name)) {
    const t = index.find(name, m);
    if (t && !t.deprecated && !t.preview) {
      return m > major ? m : undefined;
    }
  }
  return undefined;
}

function versionIssue(step: TaskStepRef, task: TaskInfo | undefined, index: TaskIndex, opts: TaskCheckOptions, label: string): TaskIssue | undefined {
  const at = { line: step.line, start: step.valueStart, end: step.valueEnd };
  const newer = newestMajor(index, step.name!, step.major!);
  const to = newer === undefined ? undefined : `${step.name}@${newer}`;
  if (opts.retired) {
    const use = opts.retired.replacement ? ` Use ${opts.retired.replacement}` : '';
    const message = `${label} retires ${opts.retired.retires}, removed ${opts.retired.removed}.${use}`;
    return { code: 'retired', severity: 'warning', message, replacement: opts.retired.replacement, ...at };
  }
  if (task?.deprecated) {
    const use = to ? ` Use ${to}.` : '';
    return { code: 'deprecated', severity: 'warning', message: `${label} is deprecated.${use}`, replacement: to, ...at };
  }
  if (opts.versionHints && to) {
    return { code: 'newerMajor', severity: 'info', message: `${label}: newer major version @${newer} is available`, replacement: to, ...at };
  }
  return undefined;
}

const isBlockScalarHeader = (v: string) => /^[|>][+\-0-9]*$/.test(v);

/** Why the written value doesn't fit the input's type or static options; undefined when it fits or can't be judged. */
function valueProblem(input: TaskInput, e: ParamEntry): string | undefined {
  const v = e.value.trim();
  if (!v || isExpression(v) || isBlockScalarHeader(v)) {
    return undefined;
  }
  const type = input.type.toLowerCase();
  if (type === 'boolean') {
    return same(v, 'true') || same(v, 'false') ? undefined : `'${input.yamlName}' is a boolean: use true or false.`;
  }
  if (type === 'int') {
    return Number.isInteger(Number(v)) ? undefined : `'${input.yamlName}' is a whole number.`;
  }
  const choice = type === 'picklist' || type === 'radio';
  if (!choice || input.editable || input.multi || input.options.length === 0 || input.options.some(o => same(o.value, v))) {
    return undefined;
  }
  return `'${v}' is not an allowed value of ${input.yamlName}: ${input.options.map(o => o.value).join(', ')}`;
}

function suggestion(task: TaskInfo, written: string): string {
  const w = written.toLowerCase();
  const near = task.inputs.find(i => {
    const n = i.yamlName.toLowerCase();
    return n.includes(w) || w.includes(n);
  });
  return near ? ` Did you mean ${near.yamlName}?` : '';
}

function entryIssues(step: TaskStepRef, task: TaskInfo, label: string): TaskIssue[] {
  const out: TaskIssue[] = [];
  for (const e of step.inputs) {
    const at = { line: e.line, start: e.start, end: e.end, input: e.name, severity: 'warning' as const };
    const input = findInput(task, e.name);
    if (!input) {
      if (!e.conditional && !step.dynamicInputs) {
        out.push({ code: 'unknownInput', message: `Unknown input '${e.name}' of ${label}.${suggestion(task, e.name)}`, ...at });
      }
      continue;
    }
    const problem = valueProblem(input, e);
    if (problem) {
      out.push({ code: 'invalidValue', message: problem, ...at });
    }
  }
  return out;
}

function ruleText(task: TaskInfo, input: TaskInput): string {
  const group = task.groups.find(g => g.name === input.group)?.visibleRule;
  const rules = [input.visibleRule, group].filter((r): r is string => !!r?.trim());
  return rules.length ? ` (visible when ${rules.join(' and ')})` : '';
}

function missingIssues(step: TaskStepRef, task: TaskInfo, label: string): TaskIssue[] {
  if (step.dynamicInputs || step.pinned) {
    return [];
  }
  const passed = new Map(step.inputs.map(e => [e.name, e.value] as [string, string]));
  const conditional = new Set(step.inputs.filter(e => e.conditional).map(e => e.name));
  const out: TaskIssue[] = [];
  for (const input of task.inputs) {
    const given = step.inputs.some(e => findInput(task, e.name) === input);
    if (!input.required || (input.default ?? '') !== '' || given || inputVisibility(task, input, passed, conditional) !== true) {
      continue;
    }
    out.push({
      code: 'missingInput', severity: 'warning', input: input.yamlName, line: step.line, start: step.valueStart, end: step.valueEnd,
      message: `Missing required input '${input.yamlName}' of ${label}${ruleText(task, input)}.`,
    });
  }
  return out;
}

/**
 * Problems of one step: task not installed, retired or deprecated, newer major, unknown inputs, values outside static
 * options, missing required inputs. Everything that can't be decided from the source text is left out (see the
 * false-positive table of the concept). A major that the catalog lacks for a known task is not reported.
 */
export function checkTaskStep(step: TaskStepRef, index: TaskIndex, opts: TaskCheckOptions): TaskIssue[] {
  if (step.name === undefined || step.major === undefined) {
    return [];
  }
  const label = `${step.name}@${step.major}`;
  const task = index.find(step.name, step.major);
  const version = versionIssue(step, task, index, opts, label);
  const out: TaskIssue[] = version ? [version] : [];
  if (!task) {
    if (opts.catalogFresh && !index.knowsName(step.name)) {
      const at = { line: step.line, start: step.valueStart, end: step.valueEnd };
      out.push({ code: 'notInstalled', severity: 'warning', message: `Task '${label}' is not installed in this organization.`, ...at });
    }
    return out;
  }
  return [...out, ...entryIssues(step, task, label), ...missingIssues(step, task, label)];
}

/**
 * A task input as the parameter of a template, so the template edit functions (`planCallEdits`, `formatValue`,
 * `sameValue`, `paramViews`) work on task steps. Required inputs without a default have no default (the form asks for
 * a value); every other input defaults to '' (unset). Pick lists with static, non-editable options become enums.
 */
export function toParameter(input: TaskInput): PipelineParameter {
  const type = input.type.toLowerCase();
  const kinds: Record<string, string> = { boolean: 'boolean', int: 'number', multiline: 'multiline' };
  const choice = (type === 'picklist' || type === 'radio') && input.options.length > 0 && !input.editable && !input.multi;
  const given = input.default ?? '';
  return {
    name: input.yamlName,
    displayName: input.label,
    type: Object.hasOwn(kinds, type) ? kinds[type] : 'string',
    default: input.required && given === '' ? undefined : given,
    values: choice ? input.options.map(o => o.value) : undefined,
  };
}

/**
 * The step as a template reference: `inputs:` plays the role of `parameters:`. With the task, the written input names
 * are replaced by the input's `yamlName`, so an alias in the file (`connectedServiceNameARM`) finds its parameter;
 * the edits only replace values, so the file keeps its spelling.
 */
export function asTemplateRef(step: TaskStepRef, task?: TaskInfo): TemplateRef {
  const params = task ? step.inputs.map(e => ({ ...e, name: findInput(task, e.name)?.yamlName ?? e.name })) : step.inputs;
  return {
    kind: 'template', line: step.line, keyCol: step.keyCol, raw: step.raw, valueStart: step.valueStart, valueEnd: step.valueEnd,
    target: step.name === undefined ? undefined : { path: step.raw }, paramsLine: step.inputsLine, params, dynamicParams: step.dynamicInputs,
    end: step.end - 1,
  };
}

/** The `displayName:` line of a step, if it has one. */
export function findDisplayName(text: string, step: TaskStepRef): { line: number; keyCol: number; value: string } | undefined {
  const lines = scanYaml(text);
  const hit = mappingOf(lines, step.line).siblings.find(l => l.key === 'displayName');
  return hit ? { line: hit.n, keyCol: hit.keyCol, value: unquote(hit.rest) } : undefined;
}

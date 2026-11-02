/**
 * View model of the pipeline designer: the parameter form of a template call, the structure strip (stages with their
 * template calls), the YAML preview excerpt with change marks, ref choices and catalog items. Pure functions.
 */
import * as path from 'node:path';
import type { CatalogEntry } from './templateResolver';
import { defaultText, isBlockScalarText, normalizeText, parseValueText, structureIssue, toTree, TreeNode } from './objectParams';
import {
  controlOf, ControlKind, indentUnit, isBlockEntry, LineMark, locationOf, passedValue, sameValue, scalarValue, stageNames, TemplateKind,
} from './templateEdits';
import type { TaskStepRef } from './taskModel';
import { joinTemplatePath, ParamEntry, scanYaml, TemplatePath, TemplateRef, valueIssue } from './templateRefs';
import { PipelineParameter } from './yamlParameters';

export interface ParamView {
  name: string;
  label: string;
  type: string;
  control: ControlKind;
  values?: string[];
  default?: string;
  /** what the form shows: the pending value, else the file's, else the default */
  value: string;
  required: boolean;
  /** pending value differs from the file */
  unsaved: boolean;
  /** passed in the file */
  inFile: boolean;
  readOnly?: string;
  error?: string;
  /** 0-based line of the passed value */
  line?: number;
  /** object parameters: the value as a form tree (undefined when the YAML text doesn't parse into one) */
  tree?: TreeNode;
  /** task inputs: the input's own type (`filepath`), shown instead of the parameter type */
  typeLabel?: string;
  /** task inputs: the help text (plain text) */
  help?: string;
  /** task inputs: name of the group the input belongs to */
  group?: string;
  /** task inputs: the rule hides it, but the file sets it */
  hidden?: boolean;
  /** task inputs: optional without a default, so a value can be taken back (unset) */
  clearable?: boolean;
}

export interface StructureItem {
  label: string;
  title: string;
  /** a template call or a task step */
  kind: 'template' | 'task';
  /** index into the document's template references (kind `template`) or task steps (kind `task`); undefined for the new call */
  index?: number;
  isNew: boolean;
  selected: boolean;
}

export interface StructureGroup {
  name: string;
  items: StructureItem[];
}

export interface PreviewLine {
  /** 1-based line number in the previewed text; undefined for a gap */
  no?: number;
  text: string;
  mark?: LineMark;
}

export interface RefOption {
  /** full ref name as written to `ref:` */
  name: string;
  label: string;
  kind: 'tag' | 'branch' | 'other';
}

export interface CatalogItem {
  path: string;
  folder: string;
  file: string;
  kind?: TemplateKind;
  params: number;
  used: boolean;
  selected: boolean;
}

const isOwn = (o: object, k: string) => Object.hasOwn(o, k);

const CONDITIONAL = 'Set inside ${{ if }} / ${{ each }}: edit it in the text.';

function readOnlyReason(entry: TemplateRef['params'][number] | undefined, block: boolean): string | undefined {
  if (entry?.conditional) {
    return CONDITIONAL;
  }
  return block ? 'Multi-line value: edit it in the text.' : undefined;
}

/** Form row of an object/list parameter: its value as YAML text (from the file, pending or the default) and a tree for objects. */
function structuredView(text: string, p: PipelineParameter, entry: TemplateRef['params'][number] | undefined, pending: Record<string, string>,
  callReadOnly: string | undefined): ParamView {
  const readOnly = callReadOnly ?? (entry?.conditional ? CONDITIONAL : undefined);
  // Conditional entries show the value written in the file as well (read-only), like scalar rows do.
  const fileText = entry ? passedValue(text, entry).text : undefined;
  const base = fileText ?? defaultText(p, indentUnit(text)) ?? '';
  const touched = isOwn(pending, p.name) && !readOnly;
  const value = touched ? pending[p.name] : base;
  const required = p.default === undefined;
  let error: string | undefined;
  if (!readOnly && !entry?.conditional) {
    error = structuredIssue(p, value, required, !!entry);
  }
  let tree: TreeNode | undefined;
  if (p.type === 'object' && !error && !isBlockScalarText(value)) {
    tree = normalizeText(value) ? toTree(parseValueText(value) ?? '') : { kind: 'map', entries: [] };
  }
  return {
    name: p.name, label: p.displayName || p.name, type: p.type, control: 'raw', default: p.default, value, required,
    unsaved: touched && normalizeText(value) !== normalizeText(base), inFile: !!entry, readOnly, error, line: entry?.line, tree,
  };
}

function structuredIssue(p: PipelineParameter, value: string, required: boolean, inFile: boolean): string | undefined {
  if (!normalizeText(value)) {
    if (required && !inFile) {
      return 'Required: the template has no default.';
    }
    return inFile ? "Enter a value: '[]' is an empty list, '{}' an empty object." : undefined;
  }
  return structureIssue(p, value);
}

/** Form row of a multi-line input (`inlineScript: |`): the text of the block scalar without its header and indentation. */
function multilineView(text: string, p: PipelineParameter, entry: ParamEntry | undefined, pending: Record<string, string>,
  callReadOnly: string | undefined): ParamView {
  const scalar = entry ? scalarValue(text, entry) : undefined;
  let readOnly = callReadOnly;
  if (!readOnly && entry?.conditional) {
    readOnly = CONDITIONAL;
  } else if (!readOnly && entry && !scalar) {
    readOnly = 'Nested value: edit it in the text.';
  }
  const fileValue = scalar?.text;
  const touched = isOwn(pending, p.name) && !readOnly;
  const value = touched ? pending[p.name] : fileValue ?? p.default ?? '';
  const required = p.default === undefined;
  const error = !readOnly && !entry && required && !value.trim() ? 'Required: the template has no default.' : undefined;
  return scalarRow(p, pending, { entry, value, fileValue, touched, readOnly, error });
}

/** What a scalar form row needs besides the parameter. */
interface RowState {
  entry?: ParamEntry;
  value: string;
  fileValue?: string;
  touched: boolean;
  readOnly?: string;
  error?: string;
}

function scalarRow(p: PipelineParameter, pending: Record<string, string>, r: RowState): ParamView {
  return {
    name: p.name, label: p.displayName || p.name, type: p.type, control: controlOf(p), values: p.values, default: p.default, value: r.value,
    required: p.default === undefined, unsaved: r.touched && !sameValue(p, pending[p.name], r.fileValue ?? p.default), inFile: !!r.entry,
    readOnly: r.readOnly, error: r.error, line: r.entry?.line,
  };
}

/** Form rows for the declared parameters of a call (`ref` undefined for a new call). */
export function paramViews(text: string, declared: PipelineParameter[], ref: TemplateRef | undefined, pending: Record<string, string>,
  callReadOnly?: string): ParamView[] {
  return declared.map(p => {
    const entry = ref?.params.find(e => e.name === p.name);
    if (controlOf(p) === 'raw') {
      return structuredView(text, p, entry, pending, callReadOnly);
    }
    if (controlOf(p) === 'multiline') {
      return multilineView(text, p, entry, pending, callReadOnly);
    }
    const block = !!entry && isBlockEntry(text, entry.line, entry.start);
    const readOnly = callReadOnly ?? readOnlyReason(entry, block);
    const fileValue = entry && !block ? entry.value : undefined;
    const touched = isOwn(pending, p.name) && !readOnly;
    const value = touched ? pending[p.name] : fileValue ?? p.default ?? '';
    const required = p.default === undefined;
    let error: string | undefined;
    if (!readOnly && !(entry?.conditional)) {
      error = required && !entry && !value.trim() ? 'Required: the template has no default.' : valueIssue(p, value);
    }
    return scalarRow(p, pending, { entry, value, fileValue, touched, readOnly, error });
  });
}

/** Parameters passed to the call that the template does not declare. */
export function unknownParams(ref: TemplateRef | undefined, declared: PipelineParameter[]): string[] {
  const names = new Set(declared.map(p => p.name));
  return (ref?.params ?? []).filter(e => !e.conditional && !names.has(e.name)).map(e => e.name);
}

/** A call or step as a line range (inclusive). */
interface Span {
  line: number;
  last: number;
}

/**
 * What a line belongs to: the call or task step that starts on it, else the first one whose range contains it, else the
 * nearest one above it, else the first one of the document.
 */
export function itemAt(calls: Span[], steps: Span[], line: number): { kind: 'call' | 'task'; index: number } | undefined {
  const all = [
    ...calls.map((c, index) => ({ kind: 'call' as const, index, ...c })),
    ...steps.map((c, index) => ({ kind: 'task' as const, index, ...c })),
  ].toSorted((a, b) => a.line - b.line);
  const hit = all.find(a => a.line === line) ?? all.find(a => a.line <= line && line <= a.last) ?? all.findLast(a => a.line <= line) ?? all[0];
  return hit && { kind: hit.kind, index: hit.index };
}

/** Short label of a reference: file name and alias, e.g. `dotnet.yml@templates`. */
export function refLabel(ref: TemplateRef): string {
  if (!ref.target) {
    return ref.raw || '(empty)';
  }
  const file = path.posix.basename(ref.target.path);
  return ref.target.alias ? `${file}@${ref.target.alias}` : file;
}

/**
 * Stages with the template calls inside them, in document order. Calls outside a stage are grouped under
 * "Pipeline", `extends:` under "Extends". A new (not yet inserted) call shows in the group of its target.
 */
export function structure(text: string, refs: TemplateRef[], selected: number | undefined, newItem?: { label: string; stage?: string; kind?: 'template' | 'task' },
  tasks?: { steps: TaskStepRef[]; selected?: number }): StructureGroup[] {
  const groups = new Map<string, (StructureItem & { line: number })[]>();
  const group = (name: string) => {
    const list = groups.get(name) ?? [];
    groups.set(name, list);
    return list;
  };
  group('Pipeline');
  stageNames(text).forEach(s => group(s));
  refs.forEach((ref, index) => {
    const name = ref.kind === 'extends' ? 'Extends' : locationOf(text, ref.line).stage ?? 'Pipeline';
    group(name).push({ label: refLabel(ref), title: ref.raw, kind: 'template', index, isNew: false, selected: index === selected, line: ref.line });
  });
  (tasks?.steps ?? []).forEach((step, index) => {
    const stage = locationOf(text, step.line).stage ?? 'Pipeline';
    group(stage).push({ label: step.raw || '(no task)', title: `Task step, line ${step.line + 1}`, kind: 'task', index, isNew: false, selected: index === tasks?.selected, line: step.line });
  });
  if (newItem) {
    group(newItem.stage ?? 'Pipeline').push({ label: newItem.label, title: 'New (not inserted yet)', kind: newItem.kind ?? 'template', isNew: true, selected: true, line: Infinity });
  }
  return [...groups].filter(([name, items]) => items.length || name !== 'Pipeline')
    .map(([name, items]) => ({ name, items: items.toSorted((a, b) => a.line - b.line).map(i => ({ label: i.label, title: i.title, kind: i.kind, index: i.index, isNew: i.isNew, selected: i.selected })) }));
}

/** First and last line of a top-level key's block (`resources:` …), or undefined when the key is missing. */
export function topLevelBlock(text: string, key: string): [number, number] | undefined {
  const lines = scanYaml(text);
  const start = lines.findIndex(l => !l.blank && l.indent === 0 && !l.dash && l.key === key);
  if (start < 0) {
    return undefined;
  }
  let end = start;
  for (let j = start + 1; j < lines.length && (lines[j].blank || lines[j].indent > 0 || lines[j].dash); j++) {
    if (!lines[j].blank) {
      end = j;
    }
  }
  return [start, end];
}

/** Lines of `text` around the focus ranges and every marked line; skipped parts become one gap line. */
export function excerpt(text: string, marks: Map<number, LineMark>, focus: [number, number][], context = 2): PreviewLine[] {
  const lines = text.split(/\r?\n/);
  const ranges = [...focus, ...[...marks.keys()].map((n): [number, number] => [n, n])]
    .map(([a, b]): [number, number] => [Math.max(0, a - context), Math.min(lines.length - 1, b + context)])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([...r]);
    }
  }
  const out: PreviewLine[] = [];
  merged.forEach(([a, b], k) => {
    if (a > 0 || k > 0) {
      out.push({ text: '⋮' });
    }
    for (let n = a; n <= b; n++) {
      out.push({ no: n + 1, text: lines[n], mark: marks.get(n) });
    }
  });
  if (merged.length && merged.at(-1)![1] < lines.length - 1) {
    out.push({ text: '⋮' });
  }
  return out;
}

/** Every line with its mark (the "YAML only" view), at most `max` lines. */
export function fullPreview(text: string, marks: Map<number, LineMark>, max = 5000): PreviewLine[] {
  return text.split(/\r?\n/).slice(0, max).map((t, n) => ({ no: n + 1, text: t, mark: marks.get(n) }));
}

const shortRef = (name: string) => name.replace(/^refs\/(heads|tags)\//, '');

/** Ref choices: newest tags first, then branches (main/master first); the declared ref is always included. */
export function refOptions(refs: { tags: string[]; branches: string[] }, declared?: string, max = 30): RefOption[] {
  const tags = [...refs.tags].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, max);
  const main = (b: string) => (/^refs\/heads\/(main|master)$/.test(b) ? 0 : 1);
  const branches = [...refs.branches].sort((a, b) => main(a) - main(b) || a.localeCompare(b)).slice(0, max);
  const out: RefOption[] = [
    ...tags.map((name): RefOption => ({ name, label: shortRef(name), kind: 'tag' })),
    ...branches.map((name): RefOption => ({ name, label: shortRef(name), kind: 'branch' })),
  ];
  if (declared && !out.some(o => o.name === declared || shortRef(o.name) === declared)) {
    out.unshift({ name: declared, label: shortRef(declared), kind: declared.startsWith('refs/tags/') ? 'tag' : 'other' });
  }
  return out;
}

/** Repository path (`/build/dotnet.yml`) a reference points to in the repository with this alias, if it does. */
export function targetPathIn(target: TemplatePath | undefined, alias: string, pipelinePath: string): string | undefined {
  if (!target) {
    return undefined;
  }
  if (alias === 'self') {
    if (target.alias === 'self') {
      return joinTemplatePath('/', target.path);
    }
    return target.alias ? undefined : joinTemplatePath(pipelinePath, target.path);
  }
  return target.alias === alias ? joinTemplatePath('/', target.path) : undefined;
}

/** The `template:` value for a catalog entry: `path@alias`, or a path relative to the pipeline for `self`. */
export function templatePathFor(entryPath: string, alias: string, pipelinePath: string): string {
  if (alias !== 'self') {
    return `${entryPath.replace(/^\//, '')}@${alias}`;
  }
  return path.posix.relative(path.posix.dirname(pipelinePath), entryPath);
}

/** Catalog rows with "in pipeline" flags. */
export function catalogItems(entries: CatalogEntry[], used: Set<string>, selected?: string): CatalogItem[] {
  return entries.map(e => {
    const folder = path.posix.dirname(e.path).replace(/^\//, '');
    return {
      path: e.path, folder, file: path.posix.basename(e.path), kind: e.kind, params: e.parameters.length,
      used: used.has(e.path.toLowerCase()), selected: e.path === selected,
    };
  });
}

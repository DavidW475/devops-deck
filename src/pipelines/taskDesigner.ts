/**
 * Pure helpers of the task part of the pipeline designer: the short task list for the catalog, the age and state texts,
 * the form of a task step (inputs shown by their `visibleRule`, grouped, with help) and the line edits that write it
 * back. Task steps reuse the template edit functions: `toParameter` / `asTemplateRef` (`taskRefs.ts`) map them, and
 * `blockKey: 'inputs'` tells `planCallEdits` where the values go. Nothing here re-serializes YAML.
 */
import { ParamView, paramViews } from './designerModel';
import { CatalogSnapshot, TaskIndex, TaskInfo, TaskInput, TaskStepRef } from './taskModel';
import { asTemplateRef, newestMajor, toParameter } from './taskRefs';
import { plainHelp, safeHelpUrl } from './taskHelp';
import { retirementOf } from './taskRetirement';
import { findInput, inputVisibility } from './taskRules';
import { EditOptions, LineEdit, newTaskLines, planCallEdits, planDisplayName, planTaskVersion, scalarValue } from './templateEdits';
import { isExpression, TemplateRef } from './templateRefs';
import { isBlockHeader, PipelineParameter } from './yamlParameters';

const MAX_DESCRIPTION = 160;

export interface TaskListVersion {
  major: number;
  /** installed version, e.g. `2.282.2` */
  version: string;
  /** flagged by the server or listed in the retirement table */
  deprecated: boolean;
  /** ISO date from which Microsoft retires the task, if it is on the list */
  retires?: string;
}

/** One task of the catalog list: short, the full definitions stay in the extension host. */
export interface TaskListItem {
  /** task GUID: what the page sends back to pick it */
  id: string;
  name: string;
  title: string;
  category: string;
  description: string;
  /** installed majors, highest first */
  versions: TaskListVersion[];
}

export interface TaskListState {
  state: 'loading' | 'ready' | 'stale' | 'error';
  items: TaskListItem[];
  /** how old the data is, e.g. `2 h ago` */
  age: string;
  /** a refresh runs while old data is shown */
  refreshing: boolean;
  error?: string;
  /** organization name for the footer */
  org: string;
}

const listCache = new WeakMap<TaskIndex, TaskListItem[]>();

/** The tasks of the catalog as short list items: one per task, majors highest first, sorted by title. */
export function taskListItems(index: TaskIndex): TaskListItem[] {
  const cached = listCache.get(index);
  if (cached) {
    return cached;
  }
  const items = buildItems(index);
  listCache.set(index, items);
  return items;
}

function buildItems(index: TaskIndex): TaskListItem[] {
  const byId = new Map<string, TaskInfo[]>();
  for (const t of index.all()) {
    byId.set(t.id, [...(byId.get(t.id) ?? []), t]);
  }
  const items = [...byId.values()].map((list): TaskListItem => {
    const sorted = list.toSorted((a, b) => b.major - a.major);
    const top = sorted[0];
    return {
      id: top.id, name: top.name, title: top.title, category: top.category || 'Other', description: top.description.slice(0, MAX_DESCRIPTION),
      versions: sorted.map((t): TaskListVersion => {
        const retired = retirementOf(t.name, t.major);
        return { major: t.major, version: t.version, deprecated: t.deprecated || !!retired, retires: retired?.retires };
      }),
    };
  });
  return items.toSorted((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));
}

/** `just now`, `5 min ago`, `2 h ago`, `6 days ago`. */
export function ageText(fetchedAt: number | undefined, now: number): string {
  if (fetchedAt === undefined) {
    return 'never';
  }
  const minutes = Math.floor(Math.max(0, now - fetchedAt) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} days ago`;
}

/** `https://dev.azure.com/contoso` and `https://contoso.visualstudio.com` both give `contoso`. */
export function orgLabel(orgUrl: string | undefined): string {
  if (!orgUrl) {
    return '';
  }
  try {
    const u = new URL(orgUrl);
    if (u.hostname === 'dev.azure.com') {
      return u.pathname.split('/').find(Boolean) ?? u.hostname;
    }
    return u.hostname.replace(/\.visualstudio\.com$/, '');
  } catch {
    return '';
  }
}

/** What the catalog panel shows: loading, error (without any data), ready, or stale (offline with old data). */
export function taskListState(snap: CatalogSnapshot, now: number, orgUrl: string | undefined, refreshing: boolean, withItems = true): TaskListState {
  const org = orgLabel(orgUrl);
  const age = ageText(snap.fetchedAt, now);
  if (snap.index) {
    const busy = refreshing || snap.status === 'loading';
    return { state: snap.status === 'stale' ? 'stale' : 'ready', items: withItems ? taskListItems(snap.index) : [], age, refreshing: busy, org };
  }
  if (snap.status === 'error') {
    return { state: 'error', items: [], age, refreshing: false, error: snap.error ?? 'Loading the tasks failed.', org };
  }
  if (snap.status === 'empty' && !orgUrl) {
    return { state: 'error', items: [], age, refreshing: false, error: 'No Azure DevOps organization is configured.', org };
  }
  return { state: 'loading', items: [], age, refreshing: false, org };
}

// ----- the form of a task step -----

export interface TaskNote {
  level: 'warn' | 'info';
  text: string;
}

/** What the form shows about the task and its version. */
export interface TaskSummary {
  name: string;
  major: number;
  title: string;
  category: string;
  /** installed version of this major */
  version: string;
  deprecated: boolean;
  majors: { major: number; version: string; deprecated: boolean }[];
  note?: TaskNote;
  /** `https:` help link only */
  helpUrl?: string;
}

/** The note under the version: retirement, deprecation or a newer major (a hint, not a warning). */
export function versionNote(index: TaskIndex, info: TaskInfo, hints: boolean): TaskNote | undefined {
  const retired = retirementOf(info.name, info.major);
  const newer = newestMajor(index, info.name, info.major);
  if (retired) {
    const use = retired.replacement ? ` Use ${retired.replacement}.` : '';
    return { level: 'warn', text: `Retires ${retired.retires}, removed ${retired.removed}.${use}` };
  }
  if (info.deprecated) {
    const use = newer === undefined ? '' : ` Use @${newer}.`;
    return { level: 'warn', text: `This task is deprecated.${use}` };
  }
  return hints && newer !== undefined ? { level: 'info', text: `@${newer} is available (majors may break inputs)` } : undefined;
}

export function taskSummary(index: TaskIndex, info: TaskInfo, hints: boolean): TaskSummary {
  const majors = index.majors(info.name).map(m => index.find(info.name, m)).filter((t): t is TaskInfo => !!t);
  return {
    name: info.name, major: info.major, title: info.title, category: info.category, version: info.version,
    deprecated: info.deprecated || !!retirementOf(info.name, info.major),
    majors: majors.map(t => ({ major: t.major, version: t.version, deprecated: t.deprecated || !!retirementOf(t.name, t.major) })),
    note: versionNote(index, info, hints), helpUrl: safeHelpUrl(info.helpUrl),
  };
}

export interface TaskForm {
  /** the inputs the form shows, as parameters (visible by their rule, or written in the file) */
  declared: PipelineParameter[];
  rows: ParamView[];
  groups: { name: string; label: string; count: number }[];
  /** inputs written in the file that the task does not have */
  unknown: string[];
}

/** Written input values (by `yamlName`) with the pending ones on top, for the `visibleRule`s. */
function passedInputs(text: string, info: TaskInfo, step: TaskStepRef | undefined, pending: Record<string, string>) {
  const values = new Map<string, string>();
  const conditional = new Set<string>();
  for (const e of step?.inputs ?? []) {
    const key = findInput(info, e.name)?.yamlName ?? e.name;
    if (e.conditional) {
      conditional.add(key);
    } else {
      // A block scalar (`script: |`) or a value on the following lines: the rules compare the text, not the header.
      values.set(key, e.value === '' || isBlockHeader(e.value) ? (scalarValue(text, e)?.text ?? '') : e.value);
    }
  }
  for (const [key, value] of Object.entries(pending)) {
    values.set(key, value);
  }
  return { values, conditional };
}

/** Why the value is not valid for the input; undefined when it is or can't be judged (expressions, empty optional values). */
function inputError(p: PipelineParameter, v: ParamView): string | undefined {
  const value = v.value.trim();
  if (!value) {
    return p.default === undefined && (!v.inFile || v.unsaved) ? 'A value is required.' : undefined;
  }
  if (isExpression(value)) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (p.type === 'boolean' && lower !== 'true' && lower !== 'false') {
    return `'${value}' is a boolean: use true or false.`;
  }
  if (p.type === 'number' && !Number.isInteger(Number(value))) {
    return `'${value}' is not a whole number.`;
  }
  if (p.values?.length && !p.values.some(o => o.toLowerCase() === lower)) {
    return `'${value}' is not an allowed value: ${p.values.join(', ')}`;
  }
  return undefined;
}

function taskRow(view: ParamView, input: TaskInput, hidden: boolean, p: PipelineParameter): ParamView {
  const simple = view.control === 'boolean' || view.control === 'enum' || view.control === 'number';
  const error = view.readOnly || hidden ? undefined : inputError(p, view);
  const control = simple && isExpression(view.value) ? 'text' : view.control;
  return {
    ...view, control, error, default: view.default === '' ? undefined : view.default, typeLabel: input.type, help: plainHelp(input.help ?? ''),
    group: input.group || undefined, hidden: hidden || undefined,
  };
}

/**
 * The form rows of a task step (`step` undefined for a new one). Inputs hidden by a rule stay when the file sets them
 * (marked `hidden`, never removed automatically); a rule that can't be decided shows the input.
 */
export function buildTaskForm(text: string, info: TaskInfo, step: TaskStepRef | undefined, ref: TemplateRef | undefined,
  pending: Record<string, string>, readOnly?: string): TaskForm {
  const passed = passedInputs(text, info, step, pending);
  const shown: { input: TaskInput; hidden: boolean; undecided: boolean }[] = [];
  for (const input of info.inputs) {
    const visible = inputVisibility(info, input, passed.values, passed.conditional);
    const written = !!step?.inputs.some(e => findInput(info, e.name) === input);
    if (visible !== false || written) {
      shown.push({ input, hidden: visible === false, undecided: visible === undefined });
    }
  }
  // Like the diagnostics, a required input is only required when its rule says it is shown: an undecidable rule asks for nothing.
  const declared = shown.map(s => (s.undecided && s.input.required ? { ...toParameter(s.input), default: '', unsetWhenBlank: true } : toParameter(s.input)));
  const rows = paramViews(text, declared, ref, pending, readOnly).map((v, i) => taskRow(v, shown[i].input, shown[i].hidden, declared[i]));
  const groups: TaskForm['groups'] = [];
  for (const row of rows) {
    const known = groups.find(g => g.name === row.group);
    if (row.group && known) {
      known.count++;
    } else if (row.group) {
      groups.push({ name: row.group, label: info.groups.find(g => g.name === row.group)?.label || row.group, count: 1 });
    }
  }
  const unknown = (step?.inputs ?? []).filter(e => !e.conditional && !findInput(info, e.name)).map(e => e.name);
  return { declared, rows, groups, unknown };
}

export interface TaskEditInput {
  step: TaskStepRef;
  info: TaskInfo;
  form: TaskForm;
  text: string;
  pending: Record<string, string>;
  opts: EditOptions;
  /** pending `displayName` (undefined = untouched) */
  displayName?: string;
  /** pending major (undefined = unchanged) */
  major?: number;
}

/** Edits for an existing step: the version on the `task:` line, `displayName`, and the inputs under `inputs:`. */
export function planTaskStep(o: TaskEditInput): LineEdit[] {
  const edits: LineEdit[] = [];
  if (o.major !== undefined) {
    edits.push(...planTaskVersion(o.text, o.step, o.major));
  }
  if (o.displayName !== undefined) {
    edits.push(...planDisplayName(o.text, o.step, o.displayName));
  }
  edits.push(...planCallEdits(o.text, asTemplateRef(o.step, o.info), o.form.declared, o.pending, o.opts, 'inputs').edits);
  return edits;
}

/** Where a new step goes: line `at`, its `indent` and the file's indent `unit`. */
export interface NewTaskPlace {
  at: number;
  indent: number;
  unit: number;
}

/** The edit that inserts a new step at line `at`. */
export function planNewTask(info: TaskInfo, form: TaskForm, pending: Record<string, string>, where: NewTaskPlace,
  opts: EditOptions, displayName?: string): LineEdit {
  return { line: where.at, deleteCount: 0, insert: newTaskLines(`${info.name}@${info.major}`, form.declared, pending, where.indent, where.unit, opts, displayName) };
}

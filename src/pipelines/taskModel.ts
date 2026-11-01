/**
 * Shared types of the task support in pipeline YAML (`- task: AzureCLI@2`): the task catalog (`taskCatalog.ts`), the
 * pure YAML logic (`taskRefs.ts`, `taskRules.ts`) and the editor providers (`yamlTasks.ts`).
 */
import { ParamEntry } from './templateRefs';

export interface TaskInput {
  /** The input's name in `task.json`, e.g. `connectedServiceNameARM`. */
  name: string;
  /** The name to write in new YAML: the first alias, else `name`, e.g. `azureSubscription`. */
  yamlName: string;
  aliases: string[];
  label: string;
  required: boolean;
  /** Lower case: `string`, `boolean`, `picklist`, `radio`, `filepath`, `multiline`, `int`, `connectedservice:azurerm`, ... */
  type: string;
  default?: string;
  help?: string;
  visibleRule?: string;
  group?: string;
  /** Static choices. Empty for dynamic pick lists, whose values must not be checked. */
  options: { value: string; label: string }[];
  /** `properties.EditableOptions`: any value is allowed, the options are only suggestions. */
  editable: boolean;
  /** `MultiSelect` / `MultiSelectFlatList`: the value can hold several options. */
  multi: boolean;
}

/** One major version of a task, reduced to what the editor needs. */
export interface TaskInfo {
  id: string;
  name: string;
  /** `publisher.extension.name`, when the server names the extension contribution. */
  fullName?: string;
  title: string;
  description: string;
  category: string;
  major: number;
  /** Highest installed version of this major, e.g. `2.282.2`. */
  version: string;
  deprecated: boolean;
  preview: boolean;
  helpUrl?: string;
  groups: { name: string; label: string; visibleRule?: string }[];
  inputs: TaskInput[];
}

/** Look-ups over the tasks of one organization. Names compare case-insensitively; a task id (GUID) works as a name. */
export interface TaskIndex {
  all(): TaskInfo[];
  /** The task at this major, undefined when the name or major is unknown. */
  find(name: string, major: number): TaskInfo | undefined;
  /** Installed majors of a task, highest first; empty for an unknown name. */
  majors(name: string): number[];
  knowsName(name: string): boolean;
}

export type CatalogStatus = 'empty' | 'loading' | 'ready' | 'stale' | 'error';

export interface CatalogSnapshot {
  status: CatalogStatus;
  /** Undefined until any data is available (memory or file). */
  index?: TaskIndex;
  /** When the data in `index` was fetched (ms since the epoch). */
  fetchedAt?: number;
  /** Why the last refresh failed. */
  error?: string;
}

/** A `- task:` step found in YAML text. Lines and columns are 0-based. */
export interface TaskStepRef {
  line: number;
  /** Column of the `task` key. */
  keyCol: number;
  /** The value as written, without quotes and comment. */
  raw: string;
  valueStart: number;
  valueEnd: number;
  /** First line after the step's mapping. */
  end: number;
  /** Undefined when the value is an expression or has no `Name@Version` form. */
  name?: string;
  major?: number;
  /** The full version of `GoTool@0.3.1`: the step is pinned, so required inputs are not checked. */
  pinned?: string;
  inputsLine?: number;
  /** `inputs: ${{ ... }}` or an `${{ each }}` key: the input names can't be checked. */
  dynamicInputs: boolean;
  inputs: ParamEntry[];
}

export type TaskCompletionContext =
  | { kind: 'taskName'; step?: TaskStepRef; prefix: string; start: number; end: number; line: number }
  | { kind: 'taskVersion'; step: TaskStepRef; name: string; prefix: string; start: number; end: number; line: number }
  | { kind: 'inputsKey'; step: TaskStepRef }
  | { kind: 'inputName'; step: TaskStepRef }
  | { kind: 'inputValue'; step: TaskStepRef; name: string };

/** Machine-readable reason, which the quick fixes use. */
export type TaskIssueCode = 'missingInput' | 'unknownInput' | 'invalidValue' | 'notInstalled' | 'deprecated' | 'retired' | 'newerMajor';

export interface TaskIssue {
  code: TaskIssueCode;
  severity: 'warning' | 'info';
  message: string;
  line: number;
  start: number;
  end: number;
  /** The input this is about (`missingInput`, `unknownInput`, `invalidValue`). */
  input?: string;
  /** The version to move to (`newerMajor`, `deprecated`, `retired`), e.g. `AzureCLI@3`. */
  replacement?: string;
}

/** A task on Microsoft's retirement list (`taskRetirement.ts`). */
export interface RetiredTask {
  name: string;
  major: number;
  /** ISO date from which the task is retired. */
  retires: string;
  /** ISO date from which pipelines using it fail. */
  removed: string;
  replacement?: string;
}

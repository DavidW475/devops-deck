/**
 * The task catalog of an organization (`distributedtask/tasks`): reduces the server's definitions to `TaskInfo`, indexes them
 * and keeps them in memory and in a file per organization (stale-while-revalidate). The response is not documented and was
 * not verified against a real organization, so `toTaskInfo` trusts nothing. `helpUrl`, `iconUrl` and `packageLocation` are
 * never fetched.
 */
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { AdoClient } from '../client';
import type { Connection } from '../connection';
import * as T from '../types';
import { CatalogSnapshot, CatalogStatus, MAX_AGE_MS, TaskIndex, TaskInfo, TaskInput } from './taskModel';

const SCHEMA = 1;
export { MAX_AGE_MS };
/** An unknown task starts a refresh at most this often. */
export const UNKNOWN_TASK_INTERVAL_MS = 10 * 60 * 1000;
/** After a failed refresh, automatic refreshes wait this long (doubling per failure, up to the maximum). */
export const FAILURE_BACKOFF_MS = 30 * 1000;
export const MAX_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

interface CacheFile {
  schema: number;
  orgUrl: string;
  fetchedAt: number;
  tasks: TaskInfo[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Task names end up in snippets and YAML: only letters, digits, `.`, `_` and `-` are allowed. */
function isSafeName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  for (const ch of name) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '-';
    if (!ok) {
      return false;
    }
  }
  return true;
}

function nonNegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** Case-insensitive property lookup in the `properties` map of an input. */
function property(props: unknown, key: string): string | undefined {
  if (!isObject(props)) {
    return undefined;
  }
  const found = Object.keys(props).find(k => k.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : str(props[found]);
}

function toOptions(raw: unknown): { value: string; label: string }[] {
  if (!isObject(raw)) {
    return [];
  }
  const out: { value: string; label: string }[] = [];
  for (const [value, label] of Object.entries(raw)) {
    out.push({ value, label: str(label) ?? value });
  }
  return out;
}

function toInput(raw: unknown): TaskInput | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  const name = str(raw.name);
  if (!name) {
    return undefined;
  }
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === 'string' && a.length > 0) : [];
  const def = str(raw.defaultValue);
  return {
    name,
    yamlName: aliases[0] ?? name,
    aliases,
    label: str(raw.label) ?? name,
    required: raw.required === true,
    type: (str(raw.type) ?? 'string').toLowerCase(),
    default: def || undefined,
    help: str(raw.helpMarkDown) || undefined,
    visibleRule: str(raw.visibleRule) || undefined,
    group: str(raw.groupName) || undefined,
    options: toOptions(raw.options),
    editable: property(raw.properties, 'EditableOptions')?.toLowerCase() === 'true',
    multi: ['MultiSelect', 'MultiSelectFlatList'].some(k => property(raw.properties, k)?.toLowerCase() === 'true'),
  };
}

function toGroup(raw: unknown): { name: string; label: string; visibleRule?: string } | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  const name = str(raw.name);
  if (!name) {
    return undefined;
  }
  return { name, label: str(raw.displayName) ?? name, visibleRule: str(raw.visibleRule) || undefined };
}

function list<R>(raw: unknown, map: (item: unknown) => R | undefined): R[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: R[] = [];
  for (const item of raw) {
    const r = map(item);
    if (r !== undefined) {
      out.push(r);
    }
  }
  return out;
}

function fullNameOf(contribution: unknown, name: string): string | undefined {
  const c = str(contribution);
  if (!c) {
    return undefined;
  }
  const full = `${c}.${name}`;
  return isSafeName(full) ? full : undefined;
}

/** Reduces one server definition to what the editor needs. Never throws; undefined for an unusable definition. */
export function toTaskInfo(def: T.TaskDefinition): TaskInfo | undefined {
  if (!isObject(def)) {
    return undefined;
  }
  const id = str(def.id);
  const name = str(def.name);
  const version = isObject(def.version) ? def.version : undefined;
  const major = nonNegInt(version?.major);
  if (!id || !name || major === undefined || !isSafeName(name)) {
    return undefined;
  }
  const helpUrl = str(def.helpUrl);
  return {
    id,
    name,
    fullName: fullNameOf(def.contributionIdentifier, name),
    title: str(def.friendlyName) || name,
    description: str(def.description) ?? '',
    category: str(def.category) ?? '',
    major,
    version: `${major}.${nonNegInt(version?.minor) ?? 0}.${nonNegInt(version?.patch) ?? 0}`,
    deprecated: def.deprecated === true,
    preview: def.preview === true,
    helpUrl: helpUrl?.startsWith('https:') ? helpUrl : undefined,
    groups: list(def.groups, toGroup),
    inputs: list(def.inputs, toInput),
  };
}

/** Compares `major.minor.patch` strings numerically. */
function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

/** One entry per task id and major: the highest version wins. */
export function keepHighest(tasks: TaskInfo[]): TaskInfo[] {
  const best = new Map<string, TaskInfo>();
  for (const t of tasks) {
    const key = `${t.id.toLowerCase()}@${t.major}`;
    const old = best.get(key);
    if (!old || compareVersions(t.version, old.version) > 0) {
      best.set(key, t);
    }
  }
  return [...best.values()];
}

/** Builds the look-ups. Names and ids compare case-insensitively; on a clash of names the higher version wins. */
export function buildIndex(tasks: TaskInfo[]): TaskIndex {
  const all = keepHighest(tasks);
  const byName = new Map<string, Map<number, TaskInfo>>();
  const add = (key: string, t: TaskInfo): void => {
    const k = key.toLowerCase();
    let majors = byName.get(k);
    if (!majors) {
      majors = new Map();
      byName.set(k, majors);
    }
    const old = majors.get(t.major);
    if (!old || compareVersions(t.version, old.version) > 0) {
      majors.set(t.major, t);
    }
  };
  for (const t of all) {
    add(t.name, t);
    add(t.id, t);
    if (t.fullName) {
      add(t.fullName, t);
    }
  }
  return {
    all: () => [...all],
    find: (name, major) => byName.get(name.toLowerCase())?.get(major),
    majors: name => [...(byName.get(name.toLowerCase())?.keys() ?? [])].sort((a, b) => b - a),
    knowsName: name => byName.has(name.toLowerCase()),
  };
}

function isCachedTask(t: unknown): t is TaskInfo {
  return isObject(t) && typeof t.id === 'string' && typeof t.name === 'string' && isSafeName(t.name) && nonNegInt(t.major) !== undefined
    && typeof t.version === 'string' && Array.isArray(t.inputs) && Array.isArray(t.groups);
}

function parseCache(text: string, orgUrl: string): CacheFile | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(data) || data.schema !== SCHEMA || data.orgUrl !== orgUrl || typeof data.fetchedAt !== 'number' || !Array.isArray(data.tasks)) {
    return undefined;
  }
  const tasks = data.tasks.filter(isCachedTask);
  return tasks.length > 0 ? { schema: SCHEMA, orgUrl, fetchedAt: data.fetchedAt, tasks } : undefined;
}

export function cacheFileName(orgUrl: string): string {
  return `tasks-${createHash('sha256').update(orgUrl).digest('hex')}.json`;
}

interface Data {
  index: TaskIndex;
  tasks: TaskInfo[];
  fetchedAt: number;
}

export class TaskCatalog implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.emitter.event;
  private data?: Data;
  private status: CatalogStatus = 'empty';
  private error?: string;
  private orgUrl?: string;
  /** Bumped by `reset`: results of work started before it are dropped. */
  private generation = 0;
  private ensured = false;
  private loading?: Promise<void>;
  private inflight?: Promise<CatalogSnapshot>;
  private lastUnknown?: number;
  /** Consecutive failed refreshes and the time before which automatic refreshes are skipped. */
  private failures = 0;
  private retryAfter = 0;

  constructor(private readonly client: AdoClient, private readonly connections: { current?: Connection },
    private readonly storageUri: vscode.Uri | undefined) {}

  snapshot(): CatalogSnapshot {
    this.sync();
    return { status: this.status, index: this.data?.index, fetchedAt: this.data?.fetchedAt, error: this.error };
  }

  /** Data at once when there is any (a refresh then runs in the background when it is old); waits only without data. */
  async ensure(): Promise<CatalogSnapshot> {
    this.sync();
    if (!this.orgUrl) {
      return this.snapshot();
    }
    this.ensured = true;
    await this.load();
    if (!this.data) {
      return this.autoRefresh();
    }
    if (Date.now() - this.data.fetchedAt > MAX_AGE_MS) {
      void this.autoRefresh();
    }
    return this.snapshot();
  }

  /** Explicit refresh (the user asked): always tries now, callers share one request. Resolves with the snapshot, also when the request failed (see `error`). */
  refresh(): Promise<CatalogSnapshot> {
    this.sync();
    if (!this.orgUrl) {
      return Promise.resolve(this.snapshot());
    }
    if (this.inflight) {
      return this.inflight;
    }
    const run: Promise<CatalogSnapshot> = this.doRefresh(this.orgUrl, this.generation).finally(() => {
      if (this.inflight === run) {
        this.inflight = undefined;
      }
    });
    this.inflight = run;
    return run;
  }

  /** Refresh started by the editor itself: skipped while a failed refresh is backing off, so a broken connection does not loop. */
  private autoRefresh(): Promise<CatalogSnapshot> {
    if (Date.now() < this.retryAfter) {
      return Promise.resolve(this.snapshot());
    }
    return this.refresh();
  }

  /** A document uses a task the catalog doesn't know: it may be new, so reload, but at most every 10 minutes. */
  refreshForUnknownTask(): void {
    this.sync();
    if (!this.ensured || !this.orgUrl) {
      return;
    }
    const now = Date.now();
    if (this.lastUnknown !== undefined && now - this.lastUnknown < UNKNOWN_TASK_INTERVAL_MS) {
      return;
    }
    this.lastUnknown = now;
    void this.autoRefresh();
  }

  /** The connection changed: forget the memory. Files stay, they belong to their organization. */
  reset(): void {
    const changed = this.status !== 'empty';
    this.generation++;
    this.data = undefined;
    this.status = 'empty';
    this.error = undefined;
    this.orgUrl = this.connections.current?.orgUrl;
    this.ensured = false;
    this.loading = undefined;
    this.inflight = undefined;
    this.lastUnknown = undefined;
    this.failures = 0;
    this.retryAfter = 0;
    if (changed) {
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.generation++;
    this.emitter.dispose();
  }

  /** Notices a changed organization even when nobody called `reset`. */
  private sync(): void {
    const org = this.connections.current?.orgUrl;
    if (org !== this.orgUrl) {
      this.reset();
    }
  }

  private load(): Promise<void> {
    this.loading ??= this.readFile(this.orgUrl!, this.generation);
    return this.loading;
  }

  private async readFile(orgUrl: string, generation: number): Promise<void> {
    if (!this.storageUri) {
      return;
    }
    let cache: CacheFile | undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.storageUri, cacheFileName(orgUrl)));
      cache = parseCache(new TextDecoder().decode(bytes), orgUrl);
    } catch {
      return;
    }
    if (cache && generation === this.generation && !this.data) {
      this.setData(cache.tasks, cache.fetchedAt);
      this.emitter.fire();
    }
  }

  private setData(tasks: TaskInfo[], fetchedAt: number): void {
    const index = buildIndex(tasks);
    this.data = { tasks: index.all(), index, fetchedAt };
    this.status = 'ready';
    this.error = undefined;
  }

  private async doRefresh(orgUrl: string, generation: number): Promise<CatalogSnapshot> {
    await this.load();
    if (!this.data && generation === this.generation) {
      this.status = 'loading';
      this.emitter.fire();
    }
    try {
      const defs = await this.client.listTaskDefinitions();
      const tasks = list<TaskInfo>(defs, d => toTaskInfo(d as T.TaskDefinition));
      if (tasks.length === 0) {
        // A filtered or empty catalog would flag every task as not installed.
        throw new Error('The server returned no usable task definitions.');
      }
      if (generation !== this.generation) {
        return this.snapshot();
      }
      this.failures = 0;
      this.retryAfter = 0;
      this.setData(tasks, Date.now());
      await this.writeFile(orgUrl);
    } catch (e) {
      if (generation === this.generation) {
        this.failures++;
        this.retryAfter = Date.now() + Math.min(FAILURE_BACKOFF_MS * 2 ** (this.failures - 1), MAX_FAILURE_BACKOFF_MS);
        this.error = e instanceof Error ? e.message : 'Loading the tasks failed.';
        this.status = this.data ? 'stale' : 'error';
      }
    }
    if (generation === this.generation) {
      this.emitter.fire();
    }
    return this.snapshot();
  }

  /** The cache is an optimization: a failing write must not turn good data into an error. */
  private async writeFile(orgUrl: string): Promise<void> {
    if (!this.storageUri || !this.data) {
      return;
    }
    const file: CacheFile = { schema: SCHEMA, orgUrl, fetchedAt: this.data.fetchedAt, tasks: this.data.tasks };
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.storageUri, cacheFileName(orgUrl)), new TextEncoder().encode(JSON.stringify(file)));
    } catch { /* memory only */ }
  }
}

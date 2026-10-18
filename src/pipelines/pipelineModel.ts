/**
 * Turns an expanded pipeline document (from the server's preview or the local expander) into stages, jobs and
 * steps for the pipeline preview. Pure; sources are passed in as a lookup.
 */
import { EValue } from './templateExpressions';
import { SourceRef, UNRESOLVED } from './templateExpander';
import { stageColumns } from './stageGraph';

export interface PreviewStep {
  name: string;
  kind: string;
  detail?: string;
  /** deployment lifecycle hook (`deploy`, `preDeploy`, `on.failure`, …) */
  hook?: string;
  condition?: string;
  error?: string;
  source?: number;
}

export interface PreviewJob {
  id: string;
  name: string;
  kind: 'job' | 'deployment' | 'template';
  dependsOn: string[];
  condition?: string;
  pool?: string;
  environment?: string;
  strategy?: string;
  steps: PreviewStep[];
  error?: string;
  source?: number;
}

export interface PreviewStage {
  id: string;
  name: string;
  dependsOn: string[];
  column: number;
  condition?: string;
  pool?: string;
  jobs: PreviewJob[];
  error?: string;
  source?: number;
}

export interface PipelineModel {
  stages: PreviewStage[];
  sources: SourceRef[];
  counts: { stages: number; jobs: number; steps: number };
}

type Obj = { [k: string]: EValue };
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: EValue | undefined): string | undefined => {
  if (v === undefined || v === null || typeof v === 'object') {
    return undefined;
  }
  return String(v);
};
const STEP_KINDS = ['task', 'script', 'bash', 'pwsh', 'powershell', 'checkout', 'download', 'downloadBuild', 'publish', 'getPackage', 'reviewApp', 'template'];
const HOOKS = ['preDeploy', 'deploy', 'routeTraffic', 'postRouteTraffic'];

function list(v: EValue | undefined): string[] {
  if (Array.isArray(v)) {
    return v.map(str).filter((x): x is string => !!x);
  }
  const s = str(v);
  return s ? [s] : [];
}

/** `pool: name` or `pool: { name, vmImage }` as text. */
export function poolText(v: EValue | undefined): string | undefined {
  if (isObj(v)) {
    const name = str(v.name);
    const image = str(v.vmImage);
    return [name, image].filter(Boolean).join(' · ') || undefined;
  }
  return str(v);
}

function firstLine(s: string): string {
  const line = s.split('\n').find(l => l.trim()) ?? '';
  return line.length > 80 ? line.slice(0, 77) + '…' : line.trim();
}

function strategyText(v: EValue | undefined): string | undefined {
  if (!isObj(v)) {
    return undefined;
  }
  if (isObj(v.matrix)) {
    return `matrix: ${Object.keys(v.matrix).join(', ')}`;
  }
  if (str(v.matrix)) {
    return 'matrix (expression)';
  }
  if ('parallel' in v) {
    return `parallel: ${str(v.parallel)}`;
  }
  return ['runOnce', 'rolling', 'canary'].find(k => k in v);
}

class Builder {
  readonly sources: SourceRef[] = [];
  private readonly index = new Map<string, number>();

  constructor(private readonly sourceOf: (n: object) => SourceRef | undefined) {}

  source(n: object): number | undefined {
    const s = this.sourceOf(n);
    if (!s) {
      return undefined;
    }
    const key = `${s.uri}#${s.line}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.sources.push(s) - 1;
      this.index.set(key, i);
    }
    return i;
  }

  step(s: EValue, hook?: string): PreviewStep {
    if (!isObj(s)) {
      return { name: str(s) ?? '(empty)', kind: 'other', hook };
    }
    const kind = STEP_KINDS.find(k => k in s) ?? 'other';
    const raw = str(s[kind]) ?? '';
    const detail = kind === 'task' || kind === 'template' ? raw : firstLine(raw);
    const error = str(s[UNRESOLVED]);
    return {
      name: str(s.displayName) ?? (kind === 'task' || kind === 'template' ? raw : `${kind}: ${detail}`),
      kind, detail: str(s.displayName) ? detail : undefined, hook, condition: str(s.condition), error, source: this.source(s),
    };
  }

  steps(job: Obj): PreviewStep[] {
    if (Array.isArray(job.steps)) {
      return job.steps.map(s => this.step(s));
    }
    const strategy = isObj(job.strategy) ? job.strategy : undefined;
    const kind = strategy && ['runOnce', 'rolling', 'canary'].find(k => isObj(strategy[k]));
    const hooks = kind ? strategy[kind] as Obj : undefined;
    if (!hooks) {
      return [];
    }
    const out: PreviewStep[] = [];
    const add = (name: string, h: EValue | undefined) => {
      if (isObj(h) && Array.isArray(h.steps)) {
        out.push(...h.steps.map(s => this.step(s, name)));
      }
    };
    HOOKS.forEach(h => add(h, hooks[h]));
    if (isObj(hooks.on)) {
      add('on.failure', hooks.on.failure);
      add('on.success', hooks.on.success);
    }
    return out;
  }

  job(j: EValue, i: number, stagePool?: string): PreviewJob {
    if (!isObj(j)) {
      return { id: `job${i}`, name: '(invalid job)', kind: 'job', dependsOn: [], steps: [] };
    }
    const error = str(j[UNRESOLVED]);
    if (error || (typeof j.template === 'string' && !j.job && !j.deployment)) {
      return { id: `template${i}`, name: str(j.template) ?? '(template)', kind: 'template', dependsOn: [], steps: [], error, source: this.source(j) };
    }
    const id = str(j.job) ?? str(j.deployment) ?? `Job${i + 1}`;
    const env = isObj(j.environment) ? str(j.environment.name) : str(j.environment);
    return {
      id, name: str(j.displayName) ?? id, kind: 'deployment' in j ? 'deployment' : 'job', dependsOn: list(j.dependsOn),
      condition: str(j.condition), pool: poolText(j.pool) ?? stagePool, environment: env, strategy: strategyText(j.strategy),
      steps: this.steps(j), source: this.source(j),
    };
  }

  stage(s: EValue, i: number, previous: string | undefined, rootPool?: string): PreviewStage {
    if (!isObj(s)) {
      return { id: `stage${i}`, name: '(invalid stage)', dependsOn: [], column: 0, jobs: [] };
    }
    const error = str(s[UNRESOLVED]);
    if (error || (typeof s.template === 'string' && !s.stage)) {
      return { id: `template${i}`, name: str(s.template) ?? '(template)', dependsOn: previous ? [previous] : [], column: 0, jobs: [], error, source: this.source(s) };
    }
    const id = str(s.stage) ?? `Stage${i + 1}`;
    const pool = poolText(s.pool) ?? rootPool;
    const jobs = Array.isArray(s.jobs) ? s.jobs.map((j, k) => this.job(j, k, pool)) : [];
    let dependsOn = list(s.dependsOn);
    if (!('dependsOn' in s)) {
      dependsOn = previous ? [previous] : [];
    }
    return { id, name: str(s.displayName) ?? id, dependsOn, column: 0, condition: str(s.condition), pool, jobs, source: this.source(s) };
  }
}

/** Stages (an implicit one for `jobs:` or `steps:` pipelines) with their graph column, jobs and steps. */
export function buildModel(doc: Obj, sourceOf: (n: object) => SourceRef | undefined = () => undefined): PipelineModel {
  const b = new Builder(sourceOf);
  const rootPool = poolText(doc.pool);
  let stages: PreviewStage[] = [];
  if (Array.isArray(doc.stages)) {
    let previous: string | undefined;
    stages = doc.stages.map((s, i) => {
      const stage = b.stage(s, i, previous, rootPool);
      previous = stage.id;
      return stage;
    });
  } else if (Array.isArray(doc.jobs) || Array.isArray(doc.steps)) {
    const jobs = Array.isArray(doc.jobs) ? doc.jobs.map((j, k) => b.job(j, k, rootPool))
      : [{ id: 'Job', name: 'Job', kind: 'job' as const, dependsOn: [], pool: rootPool, steps: b.steps(doc), source: b.source(doc) }];
    stages = [{ id: '__default', name: 'Pipeline', dependsOn: [], column: 0, pool: rootPool, jobs }];
  }
  const ids = new Set(stages.map(s => s.id));
  const deps = new Map(stages.map(s => [s.id, s.dependsOn.filter(d => ids.has(d))]));
  const columns = stageColumns(stages.map(s => s.id), deps);
  stages.forEach(s => { s.column = columns.get(s.id) ?? 0; });
  const jobs = stages.flatMap(s => s.jobs);
  return { stages, sources: b.sources, counts: { stages: stages.length, jobs: jobs.length, steps: jobs.reduce((n, j) => n + j.steps.length, 0) } };
}

import { glob } from '../watchers/watchers';
import type { Approval, Build, IdentityRef, PullRequest, WorkItem } from '../types';
import { shortRef } from '../util';
import { rankItem } from './rank';
import type { MyDayAction, MyDayItem, RankFacts } from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function ms(iso: string | undefined): number | undefined {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? undefined : t;
}

/** `5m`, `6h`, `3d`. */
function ageShort(iso: string | undefined, now: number): string {
  const t = ms(iso);
  if (t === undefined) {
    return '';
  }
  const diff = Math.max(0, now - t);
  if (diff < HOUR) {
    return `${Math.floor(diff / MIN)}m`;
  }
  return diff < DAY ? `${Math.floor(diff / HOUR)}h` : `${Math.floor(diff / DAY)}d`;
}

function agoText(iso: string | undefined, now: number): string {
  const t = ms(iso);
  if (t === undefined) {
    return '';
  }
  return now - t < MIN ? 'just now' : `${ageShort(iso, now)} ago`;
}

function rank(item: Omit<MyDayItem, 'score' | 'tier' | 'reasons'>, facts: RankFacts, now: number): MyDayItem {
  return { ...item, ...rankItem(facts, now) };
}

export function reviewItem(pr: PullRequest, me: IdentityRef, project: string, now: number): MyDayItem | undefined {
  const own = pr.reviewers.find(r => r.id === me.id);
  if (pr.isDraft || pr.createdBy.id === me.id || own?.vote !== 0 || own.hasDeclined) {
    return undefined;
  }
  const required = own.isRequired === true;
  const repoId = pr.repository.id;
  const id = pr.pullRequestId;
  const meta = [`!${id}`, pr.createdBy.displayName];
  if (required) {
    meta.push('required');
  }
  meta.push(ageShort(pr.creationDate, now));
  const actions: MyDayAction[] = [
    { icon: 'pr', title: 'Open overview', cmd: 'azureDevOps.pr.openOverview', args: [repoId, id], primary: true },
    { icon: 'check', title: 'Vote', cmd: 'azureDevOps.pr.vote', args: [repoId, id, project], style: 'accent', primary: true },
    { icon: 'branch', title: 'Check out', cmd: 'azureDevOps.pr.checkout', args: [repoId, id] },
    { icon: 'external', title: 'Open in browser', cmd: 'azureDevOps.pr.openInBrowser', args: [pr.repository.name, id, project] },
  ];
  return rank({
    key: `pr:${repoId}:${id}`,
    source: 'reviews',
    icon: 'pr',
    iconClass: 'queued',
    title: pr.title,
    meta: meta.filter(Boolean),
    project,
    since: pr.creationDate,
    fingerprint: pr.lastMergeSourceCommit?.commitId ?? '',
    actions,
  }, { kind: 'review', required, creationDate: pr.creationDate, conflicts: pr.mergeStatus === 'conflicts' }, now);
}

/** The run is the pipeline's owner; `pipeline.id` is the definition. */
function runIdOf(a: Approval): number | undefined {
  const id = a.pipeline?.owner?.id;
  return Number.isInteger(id) ? id : undefined;
}

export function approvalItem(a: Approval, me: IdentityRef, project: string, now: number): MyDayItem | undefined {
  const steps = a.steps ?? [];
  const mine = steps.some(s => s.status === 'pending' && s.assignedApprover.id === me.id);
  if (!mine || (a.blockedApprovers ?? []).some(b => b.id === me.id)) {
    return undefined;
  }
  const openSteps = steps.filter(s => s.status === 'pending').length;
  const approved = steps.filter(s => s.status === 'approved').length;
  const stillNeeded = a.minRequiredApprovers === undefined ? openSteps : Math.max(0, a.minRequiredApprovers - approved);
  const owner = a.pipeline?.owner?.name;
  const runId = runIdOf(a);
  const actions: MyDayAction[] = [
    { icon: 'check', title: 'Approve', cmd: 'azureDevOps.pipelines.approve', args: [a.id, 'approved', project], style: 'accent', primary: true },
    { icon: 'x', title: 'Reject', cmd: 'azureDevOps.pipelines.approve', args: [a.id, 'rejected', project], style: 'danger', primary: true },
  ];
  if (runId !== undefined) {
    actions.push({ icon: 'play', title: 'Open run', cmd: 'azureDevOps.pipelines.openRun', args: [runId, project], primary: true });
  }
  const waiting = ageShort(a.createdOn, now);
  return rank({
    key: `approval:${a.id}`,
    source: 'approvals',
    icon: 'hand',
    iconClass: 'queued',
    title: owner ? `${a.pipeline?.name || 'Pipeline'} #${owner}` : a.pipeline?.name || 'Pipeline',
    meta: waiting ? ['Approval', `waiting ${waiting}`] : ['Approval'],
    project,
    since: a.createdOn,
    fingerprint: a.id,
    actions,
    ...(a.instructions ? { instructions: a.instructions } : {}),
  }, { kind: 'approval', createdOn: a.createdOn, openSteps, stillNeeded }, now);
}

function branchLabel(ref: string): string {
  const m = /^refs\/pull\/(\d+)\//.exec(ref);
  return m ? `PR ${m[1]}` : shortRef(ref);
}

function isImportant(b: Build, patterns: string[]): boolean {
  const branch = shortRef(b.sourceBranch);
  const def = shortRef(b.repository?.defaultBranch);
  return (def !== '' && def === branch) || patterns.some(p => glob(shortRef(p), branch));
}

function finishedAt(b: Build): number {
  return ms(b.finishTime) ?? 0;
}

function newerRun(a: Build, b: Build): boolean {
  return finishedAt(a) > finishedAt(b) || (finishedAt(a) === finishedAt(b) && a.id > b.id);
}

function runItem(b: Build, project: string, patterns: string[], now: number): MyDayItem {
  const failed = b.result === 'failed';
  const title = `${b.definition.name} #${b.buildNumber}`;
  const actions: MyDayAction[] = [
    { icon: 'play', title: 'Open run', cmd: 'azureDevOps.pipelines.openRun', args: [b.id, project], primary: true },
    { icon: 'terminal', title: 'Stream logs', cmd: 'azureDevOps.pipelines.streamLogs', args: [b.id, title, project] },
  ];
  if (!b.sourceBranch.startsWith('refs/pull/')) {
    actions.push({ icon: 'rerun', title: 'Run again', cmd: 'azureDevOps.pipelines.rerun', args: [b.definition.id, b.sourceBranch, project] });
  }
  actions.push({ icon: 'external', title: 'Open in browser', cmd: 'azureDevOps.pipelines.openInBrowser', args: [b.id, project] });
  return rank({
    key: `run:${project}:${b.id}`,
    source: 'runs',
    icon: failed ? 'fail' : 'warn',
    iconClass: failed ? 'fail' : 'warn',
    title,
    meta: [failed ? 'Failed' : 'Partially succeeded', branchLabel(b.sourceBranch), agoText(b.finishTime, now)].filter(Boolean),
    project,
    since: b.finishTime,
    fingerprint: b.finishTime ?? '',
    actions,
  }, { kind: 'run', result: b.result ?? '', important: isImportant(b, patterns), finishTime: b.finishTime }, now);
}

export function runItems(builds: Build[], project: string, importantBranches: string[], now: number): MyDayItem[] {
  const newest = new Map<string, Build>();
  for (const b of builds) {
    const k = `${b.definition.id}|${b.sourceBranch}`;
    const cur = newest.get(k);
    if (!cur || newerRun(b, cur)) {
      newest.set(k, b);
    }
  }
  return [...newest.values()]
    .filter(b => b.result === 'failed' || b.result === 'partiallySucceeded')
    .map(b => runItem(b, project, importantBranches, now));
}

export function workItemItem(w: WorkItem, stateCategory: string | undefined, sprintFinish: string | undefined, now: number): MyDayItem | undefined {
  if (stateCategory === 'Completed' || stateCategory === 'Removed') {
    return undefined;
  }
  const f = w.fields;
  const project = String(f['System.TeamProject'] ?? '');
  const type = String(f['System.WorkItemType'] ?? '');
  const state = String(f['System.State'] ?? '');
  const iteration = String(f['System.IterationPath'] ?? '');
  const prio = Number(f['Microsoft.VSTS.Common.Priority']);
  const priority = Number.isFinite(prio) && prio > 0 ? prio : undefined;
  const since = f['System.ChangedDate'] ? String(f['System.ChangedDate']) : undefined;
  const meta = [state, priority === undefined ? '' : `P${priority}`, iteration.split('\\').pop() ?? ''].filter(Boolean);
  const actions: MyDayAction[] = [
    { icon: 'board', title: 'Open', cmd: 'azureDevOps.wi.open', args: [w.id], primary: true },
    { icon: 'swap', title: 'Change state', cmd: 'azureDevOps.wi.changeState', args: [w.id, type, project], primary: true },
    { icon: 'comment', title: 'Comment', cmd: 'azureDevOps.wi.comment', args: [w.id, project] },
    { icon: 'branch', title: 'Create branch', cmd: 'azureDevOps.wi.createBranch', args: [w.id] },
    { icon: 'external', title: 'Open in browser', cmd: 'azureDevOps.wi.openInBrowser', args: [w.id, project] },
  ];
  return rank({
    key: `wi:${w.id}`,
    source: 'workItems',
    icon: 'board',
    iconClass: 'muted',
    title: `#${w.id} ${String(f['System.Title'] ?? '')}`,
    meta,
    project,
    since,
    fingerprint: `${state}|${priority ?? ''}|${iteration}`,
    actions,
  }, { kind: 'workItem', stateCategory, priority, type, sprintFinish }, now);
}

/** Keeps the first item per key. */
export function dedupe(items: MyDayItem[]): MyDayItem[] {
  const seen = new Set<string>();
  return items.filter(i => {
    if (seen.has(i.key)) {
      return false;
    }
    seen.add(i.key);
    return true;
  });
}

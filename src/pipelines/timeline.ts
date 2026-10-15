import { Build, TimelineRecord } from '../types';
import { shortRef } from '../util';

export function buildDto(b: Build) {
  return {
    id: b.id,
    number: b.buildNumber,
    status: b.status,
    result: b.result,
    definitionId: b.definition.id,
    definitionName: b.definition.name,
    branch: shortRef(b.sourceBranch).replace(/^refs\/pull\/(\d+)\/merge$/, 'PR $1'),
    requestedFor: b.requestedFor?.displayName,
    queueTime: b.queueTime,
    startTime: b.startTime,
    finishTime: b.finishTime,
    reason: b.reason,
    commit: b.sourceVersion?.slice(0, 8),
  };
}

export interface TimelineNode {
  id: string;
  name: string;
  type: string;
  state?: string;
  result?: string | null;
  start?: string | null;
  finish?: string | null;
  logId?: number;
  errors: string[];
  warningCount: number;
  /** set on stages blocked by approvals or checks */
  waiting?: boolean;
  children: TimelineNode[];
}

/** Stage → Job → Task tree; "Phase" records and the implicit "__default" stage are flattened away. */
export function timelineTree(records: TimelineRecord[]): TimelineNode[] {
  const byParent = new Map<string | null, TimelineRecord[]>();
  for (const r of records) {
    const key = r.parentId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), r]);
  }
  const children = (parentId: string | null): TimelineNode[] => (byParent.get(parentId) ?? [])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .flatMap(r => r.type.startsWith('Checkpoint') ? [] : r.type === 'Phase' || r.name === '__default' ? children(r.id) : [{
      id: r.id,
      name: r.name,
      type: r.type,
      state: r.state,
      result: r.result,
      start: r.startTime,
      finish: r.finishTime,
      logId: r.log?.id,
      errors: (r.issues ?? []).filter(i => i.type === 'error').map(i => i.message).slice(0, 3),
      warningCount: r.warningCount ?? 0,
      waiting: (byParent.get(r.id) ?? []).some(c => c.type.startsWith('Checkpoint') && c.state === 'inProgress') || undefined,
      children: children(r.id),
    }]);
  return children(null);
}

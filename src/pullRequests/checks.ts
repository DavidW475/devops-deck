import { PolicyEvaluation } from '../types';

export type CheckKind = 'fail' | 'expired' | 'running' | 'queued' | 'ok';

export interface Check {
  name: string;
  kind: CheckKind;
  required: boolean;
  /** run of a build policy, if one was queued */
  buildId?: number;
  definitionName?: string;
}

export interface ChecksSummary {
  /** 'none' when no required policy applies */
  state: 'ok' | 'fail' | 'pending' | 'none';
  failing: number;
  pending: number;
  checks: Check[];
}

const ORDER: CheckKind[] = ['fail', 'expired', 'running', 'queued', 'ok'];

function kindOf(e: PolicyEvaluation): CheckKind {
  if (e.status === 'approved') {
    return 'ok';
  }
  if (e.status === 'rejected' || e.status === 'broken') {
    return 'fail';
  }
  if (e.context?.isExpired) {
    return 'expired';
  }
  return e.status === 'running' ? 'running' : 'queued';
}

function nameOf(e: PolicyEvaluation): string {
  const s = e.configuration.settings;
  return s?.displayName || e.context?.buildDefinitionName || s?.defaultDisplayName || s?.statusName || e.configuration.type.displayName;
}

/** Enabled, applicable branch policies with failing ones first; required before optional. */
export function summarizeChecks(evaluations: PolicyEvaluation[]): ChecksSummary {
  const checks = evaluations
    .filter(e => e.configuration.isEnabled && e.status !== 'notApplicable')
    .map((e): Check => ({
      name: nameOf(e),
      kind: kindOf(e),
      required: e.configuration.isBlocking,
      buildId: e.context?.buildId,
      definitionName: e.context?.buildDefinitionName,
    }))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || Number(b.required) - Number(a.required));
  const required = checks.filter(c => c.required);
  const failing = required.filter(c => c.kind === 'fail' || c.kind === 'expired').length;
  const pending = required.filter(c => c.kind === 'running' || c.kind === 'queued').length;
  let state: 'fail' | 'pending' | 'ok' | 'none' = required.length ? 'ok' : 'none';
  if (failing) {
    state = 'fail';
  } else if (pending) {
    state = 'pending';
  }
  return { state, failing, pending, checks };
}

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approvalItem, dedupe, reviewItem, runItems, workItemItem } from '../myDay/model';
import type { MyDayItem } from '../myDay/types';
import type { Approval, Build, IdentityRef, PullRequest, WorkItem } from '../types';

/** Wednesday, 4 November 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ME: IdentityRef = { id: 'me-1', displayName: 'Erika Muster' };
const LENA: IdentityRef = { id: 'lena-1', displayName: 'Lena H.' };
const PROJECT = 'Contoso Web';

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    pullRequestId: 482, title: 'Refactor checkout totals', status: 'active', createdBy: LENA, creationDate: '2026-10-30T09:00:00Z',
    sourceRefName: 'refs/heads/feature/totals', targetRefName: 'refs/heads/main',
    repository: { id: 'repo-1', name: 'fabrikam-shop' },
    reviewers: [{ ...ME, vote: 0, isRequired: true }],
    lastMergeSourceCommit: { commitId: 'abc123' },
    ...over,
  };
}

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: 'ap-1', status: 'pending', createdOn: ago(6 * HOUR), instructions: 'Check the staging smoke test first.',
    minRequiredApprovers: 1,
    steps: [{ assignedApprover: ME, status: 'pending' }],
    pipeline: { id: 7, name: 'Release Web', owner: { id: 114, name: '2026.114' } },
    ...over,
  };
}

function build(over: Partial<Build> = {}): Build {
  return {
    id: 871, buildNumber: '2026.871', status: 'completed', result: 'failed', definition: { id: 7, name: 'Web Shop CI' },
    sourceBranch: 'refs/heads/main', finishTime: ago(40 * 60_000), ...over,
  };
}

function wi(fields: Record<string, unknown> = {}, id = 1207): WorkItem {
  return {
    id, rev: 3,
    fields: {
      'System.Title': 'Basket export story', 'System.State': 'Active', 'System.WorkItemType': 'User Story',
      'System.TeamProject': PROJECT, 'System.IterationPath': 'Contoso Web\\Sprint 12', 'Microsoft.VSTS.Common.Priority': 2,
      'System.ChangedDate': '2026-11-03T10:00:00Z', ...fields,
    },
  };
}

function assertNamespace(item: MyDayItem): void {
  assert.ok(item.actions.length > 0);
  for (const a of item.actions) {
    assert.ok(a.cmd.startsWith('azureDevOps.'), a.cmd);
  }
}

describe('reviewItem', () => {
  it('builds the card', () => {
    const i = reviewItem(pr(), ME, PROJECT, NOW)!;
    assert.equal(i.key, 'pr:repo-1:482');
    assert.equal(i.source, 'reviews');
    assert.deepEqual([i.icon, i.iconClass, i.project, i.title], ['pr', 'queued', PROJECT, 'Refactor checkout totals']);
    assert.deepEqual(i.meta, ['!482', 'Lena H.', 'required', '5d']);
    assert.equal(i.fingerprint, 'abc123');
    assert.equal(i.since, '2026-10-30T09:00:00Z');
    assert.equal(i.score, 65);
    assert.equal(i.tier, 'today');
    assert.equal(i.reasons.reduce((s, r) => s + r.points, 0), i.score);
    assertNamespace(i);
  });

  it('has the commands with their argument order', () => {
    const a = reviewItem(pr(), ME, PROJECT, NOW)!.actions;
    assert.deepEqual(a.map(x => [x.cmd, x.args]), [
      ['azureDevOps.pr.openOverview', ['repo-1', 482]],
      ['azureDevOps.pr.vote', ['repo-1', 482, PROJECT]],
      ['azureDevOps.pr.checkout', ['repo-1', 482]],
      ['azureDevOps.pr.openInBrowser', ['fabrikam-shop', 482, PROJECT]],
    ]);
    assert.deepEqual(a.map(x => x.primary === true), [true, true, false, false]);
    assert.equal(a[1].style, 'accent');
  });

  it('leaves out "required" and uses an empty fingerprint without a source commit', () => {
    const i = reviewItem(pr({ reviewers: [{ ...ME, vote: 0 }], lastMergeSourceCommit: undefined }), ME, PROJECT, NOW)!;
    assert.deepEqual(i.meta, ['!482', 'Lena H.', '5d']);
    assert.equal(i.fingerprint, '');
  });

  it('subtracts for conflicts', () => {
    const i = reviewItem(pr({ mergeStatus: 'conflicts' }), ME, PROJECT, NOW)!;
    assert.equal(i.score, 55);
  });

  it('filters', () => {
    assert.equal(reviewItem(pr({ isDraft: true }), ME, PROJECT, NOW), undefined);
    assert.equal(reviewItem(pr({ createdBy: ME }), ME, PROJECT, NOW), undefined);
    assert.equal(reviewItem(pr({ reviewers: [] }), ME, PROJECT, NOW), undefined);
    assert.equal(reviewItem(pr({ reviewers: [{ ...LENA, vote: 0 }] }), ME, PROJECT, NOW), undefined);
    assert.equal(reviewItem(pr({ reviewers: [{ ...ME, vote: 10 }] }), ME, PROJECT, NOW), undefined);
    assert.equal(reviewItem(pr({ reviewers: [{ ...ME, vote: -5 }] }), ME, PROJECT, NOW), undefined);
    assert.equal(reviewItem(pr({ reviewers: [{ ...ME, vote: 0, hasDeclined: true }] }), ME, PROJECT, NOW), undefined);
  });

  it('formats short ages', () => {
    assert.equal(reviewItem(pr({ creationDate: ago(5 * 60_000) }), ME, PROJECT, NOW)!.meta.at(-1), '5m');
    assert.equal(reviewItem(pr({ creationDate: ago(3 * HOUR) }), ME, PROJECT, NOW)!.meta.at(-1), '3h');
    assert.deepEqual(reviewItem(pr({ creationDate: 'bad' }), ME, PROJECT, NOW)!.meta, ['!482', 'Lena H.', 'required']);
  });
});

describe('approvalItem', () => {
  it('builds the card', () => {
    const i = approvalItem(approval(), ME, PROJECT, NOW)!;
    assert.equal(i.key, 'approval:ap-1');
    assert.equal(i.source, 'approvals');
    assert.deepEqual([i.icon, i.iconClass, i.title], ['hand', 'queued', 'Release Web #2026.114']);
    assert.deepEqual(i.meta, ['Approval', 'waiting 6h']);
    assert.equal(i.instructions, 'Check the staging smoke test first.');
    assert.equal(i.fingerprint, 'ap-1');
    assert.equal(i.score, 90);
    assert.equal(i.tier, 'now');
    assertNamespace(i);
  });

  it('has Approve, Reject and Open run', () => {
    const a = approvalItem(approval(), ME, PROJECT, NOW)!.actions;
    assert.deepEqual(a.map(x => [x.title, x.cmd, x.args, x.style, x.primary]), [
      ['Approve', 'azureDevOps.pipelines.approve', ['ap-1', 'approved', PROJECT], 'accent', true],
      ['Reject', 'azureDevOps.pipelines.approve', ['ap-1', 'rejected', PROJECT], 'danger', true],
      ['Open run', 'azureDevOps.pipelines.openRun', [114, PROJECT], undefined, true],
    ]);
  });

  it('opens the run only with a numeric run id', () => {
    const none = approvalItem(approval({ pipeline: { name: 'Release Web' } }), ME, PROJECT, NOW)!;
    assert.deepEqual(none.actions.map(a => a.title), ['Approve', 'Reject']);
    const definitionOnly = approvalItem(approval({ pipeline: { id: 7 } }), ME, PROJECT, NOW)!;
    assert.equal(definitionOnly.actions.length, 2);
    const run = approvalItem(approval({ pipeline: { id: 7, owner: { id: 55 } } }), ME, PROJECT, NOW)!;
    assert.deepEqual(run.actions[2].args, [55, PROJECT]);
  });

  it('falls back to "Pipeline" and omits missing parts', () => {
    const i = approvalItem(approval({ pipeline: undefined, instructions: undefined, createdOn: undefined }), ME, PROJECT, NOW)!;
    assert.equal(i.title, 'Pipeline');
    assert.deepEqual(i.meta, ['Approval']);
    assert.equal('instructions' in i, false);
    assert.equal(approvalItem(approval({ pipeline: { name: 'Release Web' } }), ME, PROJECT, NOW)!.title, 'Release Web');
  });

  it('counts the needed approvals', () => {
    const two = approval({
      minRequiredApprovers: 3,
      steps: [{ assignedApprover: ME, status: 'pending' }, { assignedApprover: LENA, status: 'pending' }, { assignedApprover: LENA, status: 'approved' }],
    });
    assert.equal(approvalItem(two, ME, PROJECT, NOW)!.score, 90);
    const more = approval({
      minRequiredApprovers: 1,
      steps: [{ assignedApprover: ME, status: 'pending' }, { assignedApprover: LENA, status: 'pending' }],
    });
    assert.equal(approvalItem(more, ME, PROJECT, NOW)!.score, 85);
    const unknown = approval({
      minRequiredApprovers: undefined,
      steps: [{ assignedApprover: ME, status: 'pending' }, { assignedApprover: LENA, status: 'pending' }],
    });
    assert.equal(approvalItem(unknown, ME, PROJECT, NOW)!.score, 90);
    // 0 means that every approver has to approve: two open steps are both still needed.
    const everyone = approval({
      minRequiredApprovers: 0,
      steps: [{ assignedApprover: ME, status: 'pending' }, { assignedApprover: LENA, status: 'pending' }],
    });
    assert.ok(approvalItem(everyone, ME, PROJECT, NOW)!.reasons.some(r => r.rule === 'A3'), 'A3: your approval is required');
    assert.equal(approvalItem(everyone, ME, PROJECT, NOW)!.score, 90);
  });

  it('filters', () => {
    assert.equal(approvalItem(approval({ steps: [{ assignedApprover: LENA, status: 'pending' }] }), ME, PROJECT, NOW), undefined);
    assert.equal(approvalItem(approval({ steps: [{ assignedApprover: ME, status: 'approved' }] }), ME, PROJECT, NOW), undefined);
    assert.equal(approvalItem(approval({ steps: undefined }), ME, PROJECT, NOW), undefined);
    assert.equal(approvalItem(approval({ blockedApprovers: [ME] }), ME, PROJECT, NOW), undefined);
    assert.ok(approvalItem(approval({ blockedApprovers: [LENA] }), ME, PROJECT, NOW));
  });
});

describe('runItems', () => {
  it('builds a failed run on an important branch', () => {
    const [i] = runItems([build()], PROJECT, ['main'], NOW);
    assert.equal(i.key, 'run:Contoso Web:871');
    assert.equal(i.source, 'runs');
    assert.deepEqual([i.icon, i.iconClass, i.title], ['fail', 'fail', 'Web Shop CI #2026.871']);
    assert.deepEqual(i.meta, ['Failed', 'main', '40m ago']);
    assert.equal(i.fingerprint, build().finishTime);
    assert.equal(i.since, build().finishTime);
    assert.equal(i.score, 80);
    assert.equal(i.tier, 'now');
    assertNamespace(i);
  });

  it('uses the default branch of the repository', () => {
    const b = build({ sourceBranch: 'refs/heads/develop', repository: { defaultBranch: 'refs/heads/develop' } });
    assert.equal(runItems([b], PROJECT, [], NOW)[0].score, 80);
  });

  it('matches the patterns by short names', () => {
    const b = build({ sourceBranch: 'refs/heads/release/2.1' });
    assert.equal(runItems([b], PROJECT, ['release/*'], NOW)[0].score, 80);
    assert.equal(runItems([b], PROJECT, ['refs/heads/release/*'], NOW)[0].score, 80);
    assert.equal(runItems([b], PROJECT, ['main'], NOW)[0].score, 55);
  });

  it('a feature branch is today', () => {
    const [i] = runItems([build({ sourceBranch: 'refs/heads/feature/login', finishTime: ago(2 * HOUR) })], PROJECT, ['main'], NOW);
    assert.deepEqual([i.score, i.tier], [55, 'today']);
    assert.deepEqual(i.meta, ['Failed', 'feature/login', '2h ago']);
  });

  it('partially succeeded gets the warning icon', () => {
    const [i] = runItems([build({ result: 'partiallySucceeded', sourceBranch: 'refs/heads/feature/x' })], PROJECT, [], NOW);
    assert.deepEqual([i.icon, i.iconClass, i.meta[0], i.score], ['warn', 'warn', 'Partially succeeded', 35]);
  });

  it('a newer success displaces the failure, a newer failure displaces an older one', () => {
    const failed = build({ id: 1, finishTime: ago(5 * HOUR) });
    const ok = build({ id: 2, result: 'succeeded', finishTime: ago(HOUR) });
    assert.deepEqual(runItems([failed, ok], PROJECT, [], NOW), []);
    assert.deepEqual(runItems([ok, failed], PROJECT, [], NOW), []);
    const older = build({ id: 3, result: 'succeeded', finishTime: ago(9 * HOUR) });
    assert.deepEqual(runItems([older, failed], PROJECT, [], NOW).map(i => i.key), ['run:Contoso Web:1']);
    const newerFail = build({ id: 4, finishTime: ago(HOUR) });
    assert.deepEqual(runItems([failed, newerFail], PROJECT, [], NOW).map(i => i.key), ['run:Contoso Web:4']);
  });

  it('keeps definitions and branches apart, and breaks ties by id', () => {
    const a = build({ id: 10 });
    const b = build({ id: 11, definition: { id: 8, name: 'Contoso API CI' } });
    const c = build({ id: 12, sourceBranch: 'refs/heads/other' });
    assert.equal(runItems([a, b, c], PROJECT, [], NOW).length, 3);
    const same = build({ id: 13, result: 'succeeded' });
    assert.deepEqual(runItems([a, same], PROJECT, [], NOW), []);
    const noFinish = build({ id: 14, finishTime: undefined });
    assert.equal(runItems([noFinish], PROJECT, [], NOW)[0].fingerprint, '');
  });

  it('has the commands with their argument order', () => {
    const [i] = runItems([build()], PROJECT, [], NOW);
    assert.deepEqual(i.actions.map(a => [a.cmd, a.args]), [
      ['azureDevOps.pipelines.openRun', [871, PROJECT]],
      ['azureDevOps.pipelines.streamLogs', [871, 'Web Shop CI #2026.871', PROJECT]],
      ['azureDevOps.pipelines.rerun', [7, 'refs/heads/main', PROJECT]],
      ['azureDevOps.pipelines.openInBrowser', [871, PROJECT]],
    ]);
    assert.equal(i.actions[0].primary, true);
  });

  it('offers no rerun for pull request runs', () => {
    const [i] = runItems([build({ sourceBranch: 'refs/pull/482/merge' })], PROJECT, ['main'], NOW);
    assert.ok(!i.actions.some(a => a.cmd.endsWith('.rerun')));
    assert.equal(i.meta[1], 'PR 482');
    assertNamespace(i);
  });
});

describe('workItemItem', () => {
  it('builds the card', () => {
    const i = workItemItem(wi(), 'InProgress', undefined, NOW)!;
    assert.equal(i.key, 'wi:1207');
    assert.equal(i.source, 'workItems');
    assert.deepEqual([i.icon, i.iconClass, i.project, i.title], ['board', 'muted', PROJECT, '#1207 Basket export story']);
    assert.deepEqual(i.meta, ['Active', 'P2', 'Sprint 12']);
    assert.equal(i.fingerprint, 'Active|2|Contoso Web\\Sprint 12');
    assert.equal(i.since, '2026-11-03T10:00:00Z');
    assert.equal(i.score, 10 + 20 + 10);
    assert.equal(i.tier, 'today');
    assertNamespace(i);
  });

  it('has the commands with their argument order', () => {
    const a = workItemItem(wi(), undefined, undefined, NOW)!.actions;
    assert.deepEqual(a.map(x => [x.cmd, x.args]), [
      ['azureDevOps.wi.open', [1207]],
      ['azureDevOps.wi.changeState', [1207, 'User Story', PROJECT]],
      ['azureDevOps.wi.comment', [1207, PROJECT]],
      ['azureDevOps.wi.createBranch', [1207]],
      ['azureDevOps.wi.openInBrowser', [1207, PROJECT]],
    ]);
    assert.deepEqual(a.map(x => x.primary === true), [true, true, false, false, false]);
  });

  it('is undefined for completed and removed items', () => {
    assert.equal(workItemItem(wi(), 'Completed', undefined, NOW), undefined);
    assert.equal(workItemItem(wi(), 'Removed', undefined, NOW), undefined);
    assert.ok(workItemItem(wi(), 'Resolved', undefined, NOW));
  });

  it('ranks bugs, priority and sprint', () => {
    const i = workItemItem(wi({ 'System.WorkItemType': 'Bug', 'Microsoft.VSTS.Common.Priority': 1 }), 'InProgress', '2026-11-03T00:00:00Z', NOW)!;
    assert.deepEqual([i.score, i.tier], [95, 'now']);
  });

  it('copes with missing fields', () => {
    const i = workItemItem({ id: 5, rev: 1, fields: {} }, undefined, undefined, NOW)!;
    assert.deepEqual([i.title, i.project, i.meta, i.since, i.fingerprint], ['#5 ', '', [], undefined, '||']);
    assert.deepEqual([i.score, i.tier], [10, 'later']);
  });
});

describe('dedupe', () => {
  it('keeps the first item per key', () => {
    const a = reviewItem(pr(), ME, PROJECT, NOW)!;
    const b = { ...a, title: 'duplicate' };
    const c = workItemItem(wi(), undefined, undefined, NOW)!;
    assert.deepEqual(dedupe([a, c, b]).map(i => i.title), ['Refactor checkout totals', '#1207 Basket export story']);
  });
});

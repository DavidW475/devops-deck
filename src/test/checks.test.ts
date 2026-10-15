import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeChecks } from '../pullRequests/checks';
import { PolicyEvaluation } from '../types';

const ev = (type: string, status: string, isBlocking = true, extra: Partial<PolicyEvaluation> = {}): PolicyEvaluation => ({
  evaluationId: type, status, configuration: { isEnabled: true, isBlocking, type: { id: type, displayName: type } }, ...extra,
});

describe('summarizeChecks', () => {
  it('is ok when every required policy passed, even if an optional one failed', () => {
    const s = summarizeChecks([ev('Build', 'approved'), ev('Reviewers', 'approved'), ev('Status', 'rejected', false)]);
    assert.equal(s.state, 'ok');
    assert.equal(s.failing, 0);
  });

  it('is pending while required policies run or wait', () => {
    const s = summarizeChecks([ev('Build', 'running'), ev('Reviewers', 'queued'), ev('Comments', 'approved')]);
    assert.equal(s.state, 'pending');
    assert.equal(s.pending, 2);
  });

  it('counts rejected, broken and expired required policies as failing and lists them first', () => {
    const s = summarizeChecks([
      ev('A', 'approved'),
      ev('Build', 'queued', true, { context: { buildId: 5, buildDefinitionName: 'CI', isExpired: true } }),
      ev('Comments', 'rejected'),
      ev('Broken', 'broken'),
    ]);
    assert.equal(s.state, 'fail');
    assert.equal(s.failing, 3);
    assert.deepEqual(s.checks.map(c => c.kind), ['fail', 'fail', 'expired', 'ok']);
    const build = s.checks.find(c => c.kind === 'expired')!;
    assert.equal(build.name, 'CI', 'build policies are named after their pipeline');
    assert.equal(build.buildId, 5);
  });

  it('ignores disabled and not applicable policies; none when nothing is required', () => {
    const disabled = ev('Off', 'rejected');
    disabled.configuration.isEnabled = false;
    const s = summarizeChecks([disabled, ev('N/A', 'notApplicable'), ev('Optional', 'approved', false)]);
    assert.equal(s.state, 'none');
    assert.deepEqual(s.checks.map(c => c.name), ['Optional']);
  });

  it('prefers configured display names', () => {
    const s = summarizeChecks([ev('Status', 'approved', true, {
      configuration: { isEnabled: true, isBlocking: true, type: { id: 's', displayName: 'Status' }, settings: { defaultDisplayName: 'SonarCloud gate' } },
    })]);
    assert.equal(s.checks[0].name, 'SonarCloud gate');
  });
});

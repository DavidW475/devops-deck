import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RETIREMENT_AS_OF, RETIREMENT_SOURCE, retirementOf } from '../pipelines/taskRetirement';

describe('taskRetirement', () => {
  it('finds an entry case-insensitively with its dates and replacement', () => {
    assert.deepEqual(retirementOf('azurecli', 0), { name: 'AzureCLI', major: 0, retires: '2026-11-24', removed: '2027-03-15', replacement: 'AzureCLI@3' });
  });

  it('distinguishes the major version', () => {
    assert.equal(retirementOf('AzureCLI', 2), undefined);
    assert.equal(retirementOf('Maven', 4), undefined);
    assert.equal(retirementOf('Maven', 1)?.replacement, 'Maven@4');
  });

  it('has no replacement where Microsoft names none or several', () => {
    assert.equal(retirementOf('NuGetPublisher', 0)?.replacement, undefined);
    assert.equal(retirementOf('XamarinLicense', 1)?.replacement, undefined);
  });

  it('returns undefined for an unknown task', () => {
    assert.equal(retirementOf('ContosoDeploy', 1), undefined);
  });

  it('names its source and date', () => {
    assert.ok(RETIREMENT_SOURCE.startsWith('https://learn.microsoft.com/'));
    assert.match(RETIREMENT_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  });
});

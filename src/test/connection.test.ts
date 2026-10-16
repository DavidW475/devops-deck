import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAzureDevOpsUrl, normalizeOrgUrl, parseRemote } from '../connection';

describe('connection', () => {
  it('normalizeOrgUrl accepts names and URLs', () => {
    assert.equal(normalizeOrgUrl('contoso'), 'https://dev.azure.com/contoso');
    assert.equal(normalizeOrgUrl('https://dev.azure.com/contoso/'), 'https://dev.azure.com/contoso');
  });

  it('isAzureDevOpsUrl only allows Azure DevOps hosts over https', () => {
    assert.ok(isAzureDevOpsUrl('https://dev.azure.com/contoso/_apis/x'));
    assert.ok(isAzureDevOpsUrl('https://contoso.visualstudio.com/_apis/x'));
    assert.ok(!isAzureDevOpsUrl(`${'http'}://dev.azure.com/contoso`), 'plain http is refused'); // not a literal: the insecure URL is what this test checks
    assert.ok(!isAzureDevOpsUrl('https://dev.azure.com.evil.example/x'), 'look-alike host');
    assert.ok(!isAzureDevOpsUrl('https://evilvisualstudio.com/x'), 'suffix without dot');
    assert.ok(!isAzureDevOpsUrl('not a url'));
  });

  it('parseRemote understands https, legacy and ssh remotes', () => {
    const expected = { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', repo: 'web-shop' };
    assert.deepEqual(parseRemote('https://contoso@dev.azure.com/contoso/Fabrikam%20Shop/_git/web-shop'), expected);
    assert.deepEqual(parseRemote('https://contoso.visualstudio.com/DefaultCollection/Fabrikam%20Shop/_git/web-shop'), expected);
    assert.deepEqual(parseRemote('git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Shop/web-shop'), expected);
    assert.equal(parseRemote('https://github.com/contoso/web-shop.git'), undefined);
  });
});

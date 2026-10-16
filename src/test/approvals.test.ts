import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdoClient } from '../client';
import { answerApproval } from '../pipelines/approvals';
import { Approval } from '../types';
import * as vscode from './vscodeStub';

const realStatus = vscode.window.setStatusBarMessage;

describe('answerApproval', () => {
  let approval: Approval;
  let updates: unknown[][];
  let status: string[];
  const client = {
    getApproval: async () => approval,
    updateApproval: async (...args: unknown[]) => { updates.push(args); },
  } as unknown as AdoClient;

  beforeEach(() => {
    vscode.reset();
    approval = { id: 'ap-1', status: 'pending', pipeline: { name: 'Fabrikam Shop CI', owner: { id: 99, name: '20261016.1' } } };
    updates = [];
    status = [];
    vscode.window.setStatusBarMessage = ((m: string) => { status.push(m); return { dispose() { /* stub */ } }; }) as never;
  });
  afterEach(() => { vscode.window.setStatusBarMessage = realStatus; });

  it('reports approvals that are no longer pending', async () => {
    approval.status = 'approved';
    assert.equal(await answerApproval(client, 'ap-1'), true);
    assert.deepEqual(vscode.messages, ['This approval is already approved.']);
    assert.equal(updates.length, 0);
  });

  it('approves with the given status and a comment', async () => {
    vscode.answers.inputBox.push('Looks good');
    assert.equal(await answerApproval(client, 'ap-1', 'approved'), true);
    assert.deepEqual(updates, [['ap-1', 'approved', 'Looks good']]);
    const box = vscode.prompts.inputBox as { title: string; prompt: string };
    assert.equal(box.title, 'Approve Fabrikam Shop CI #20261016.1');
    assert.equal(box.prompt, 'Comment (optional)');
    assert.deepEqual(status, ['$(check) Approved Fabrikam Shop CI #20261016.1']);
  });

  it('lets the user choose and shows the instructions', async () => {
    approval = { id: 'ap-2', status: 'pending', instructions: 'Check the release notes' };
    vscode.answers.quickPick.push({ label: 'Reject', value: 'rejected' });
    vscode.answers.inputBox.push('');
    assert.equal(await answerApproval(client, 'ap-2'), true);
    const pick = vscode.prompts.quickPick as { options: { title: string; placeHolder: string } };
    assert.equal(pick.options.title, 'Approval for pipeline run');
    assert.equal(pick.options.placeHolder, 'Check the release notes');
    const box = vscode.prompts.inputBox as { title: string; prompt: string };
    assert.equal(box.title, 'Reject pipeline run');
    assert.equal(box.prompt, 'Instructions: Check the release notes');
    assert.deepEqual(updates, [['ap-2', 'rejected', '']]);
    assert.deepEqual(status, ['$(close) Rejected']);
  });

  it('returns false when the choice or the comment is cancelled', async () => {
    assert.equal(await answerApproval(client, 'ap-1'), false);
    const pick = vscode.prompts.quickPick as { options: { placeHolder: string } };
    assert.equal(pick.options.placeHolder, 'Approve or reject this stage');
    assert.equal(await answerApproval(client, 'ap-1', 'rejected'), false);
    assert.equal(updates.length, 0);
  });
});

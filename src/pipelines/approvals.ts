import * as vscode from 'vscode';
import { AdoClient } from '../client';

/**
 * Approves or rejects a pending approval of a pipeline stage, with an optional comment.
 * Without `status` the user chooses. Returns false when cancelled.
 */
export async function answerApproval(client: AdoClient, approvalId: string, status?: 'approved' | 'rejected'): Promise<boolean> {
  const approval = await client.getApproval(approvalId);
  if (approval.status !== 'pending') {
    void vscode.window.showInformationMessage(`This approval is already ${approval.status}.`);
    return true;
  }
  const what = [approval.pipeline?.name, approval.pipeline?.owner?.name ? `#${approval.pipeline.owner.name}` : ''].filter(Boolean).join(' ');
  let decision = status;
  if (!decision) {
    const pick = await vscode.window.showQuickPick([
      { label: '$(check) Approve', value: 'approved' as const },
      { label: '$(close) Reject', value: 'rejected' as const },
    ], { title: `Approval for ${what || 'pipeline run'}`, placeHolder: approval.instructions || 'Approve or reject this stage' });
    if (!pick) {
      return false;
    }
    decision = pick.value;
  }
  const comment = await vscode.window.showInputBox({
    title: `${decision === 'approved' ? 'Approve' : 'Reject'} ${what || 'pipeline run'}`,
    prompt: approval.instructions ? `Instructions: ${approval.instructions}` : 'Comment (optional)',
    placeHolder: 'Comment (optional)',
  });
  if (comment === undefined) {
    return false;
  }
  await client.updateApproval(approvalId, decision, comment);
  vscode.window.setStatusBarMessage(`$(check) ${decision === 'approved' ? 'Approved' : 'Rejected'} ${what}`, 3000);
  return true;
}

import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { gitApi } from '../connection';

export async function changeWorkItemState(client: AdoClient, id: number, type: string): Promise<boolean> {
  const states = await client.getWorkItemStates(type);
  const pick = await vscode.window.showQuickPick(states.map(s => ({ label: s.name, description: s.category })),
    { title: `Change state of #${id}` });
  if (!pick) {
    return false;
  }
  await client.updateWorkItem(id, { 'System.State': pick.label });
  return true;
}

export async function assignWorkItemToMe(client: AdoClient, id: number): Promise<void> {
  const me = await client.getMe();
  await client.updateWorkItem(id, { 'System.AssignedTo': me.uniqueName ?? me.displayName });
}

export async function commentOnWorkItem(client: AdoClient, id: number): Promise<boolean> {
  const text = await vscode.window.showInputBox({ title: `Comment on #${id}`, prompt: 'Comment text' });
  if (!text) {
    return false;
  }
  await client.addWorkItemComment(id, text);
  return true;
}

export async function createWorkItem(client: AdoClient): Promise<number | undefined> {
  const type = await vscode.window.showQuickPick(client.getWorkItemTypes(), { title: 'New work item', placeHolder: 'Type' });
  if (!type) {
    return undefined;
  }
  const title = await vscode.window.showInputBox({ title: `New ${type}`, prompt: 'Title' });
  if (!title) {
    return undefined;
  }
  const assign = await vscode.window.showQuickPick(['Assign to me', 'Leave unassigned'], { title: `New ${type}` });
  if (!assign) {
    return undefined;
  }
  const fields: Record<string, unknown> = { 'System.Title': title };
  if (assign === 'Assign to me') {
    const me = await client.getMe();
    fields['System.AssignedTo'] = me.uniqueName ?? me.displayName;
  }
  const item = await client.createWorkItem(type, fields);
  void vscode.window.showInformationMessage(`Created ${type} #${item.id}.`);
  return item.id;
}

/** Creates and checks out a local branch named after the work item, e.g. "feature/1234-fix-login". */
export async function createBranchForWorkItem(client: AdoClient, id: number): Promise<void> {
  const repo = gitApi()?.repositories[0];
  if (!repo) {
    throw new Error('No open git repository.');
  }
  const item = await client.getWorkItem(id);
  const slug = String(item.fields['System.Title']).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').slice(0, 40).replace(/-+$/, '');
  const prefix = item.fields['System.WorkItemType'] === 'Bug' ? 'bugfix' : 'feature';
  const name = await vscode.window.showInputBox({ title: 'Create branch', value: `${prefix}/${id}-${slug}` });
  if (!name) {
    return;
  }
  await repo.createBranch(name, true);
  void vscode.window.showInformationMessage(`Switched to new branch ${name}. Mention #${id} in a commit or PR to link it.`);
}

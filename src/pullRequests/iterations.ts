import * as path from 'node:path';
import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { openPrDiff } from './prFiles';

/**
 * Lets the user pick a file that changed between two updates (iterations) of a pull request and opens its diff.
 * `base` 0 compares with the target branch.
 */
export async function compareIterations(client: AdoClient, repoId: string, prId: number, base?: number, target?: number): Promise<void> {
  const iterations = await client.getIterations(repoId, prId);
  if (!iterations.length) {
    throw new Error(`Pull request !${prId} has no updates yet.`);
  }
  const latest = Math.max(...iterations.map(i => i.id));
  const to = target && target <= latest ? target : latest;
  let from = base;
  if (from === undefined || Number.isNaN(from)) {
    const pick = await vscode.window.showQuickPick([
      { label: 'Target branch', description: 'all changes of the pull request', id: 0 },
      ...[...iterations].sort((a, b) => b.id - a.id).filter(i => i.id < to).map(i => ({
        label: `Update ${i.id}`, description: i.description ?? '', detail: i.createdDate ? new Date(i.createdDate).toLocaleString() : undefined, id: i.id,
      })),
    ], { title: `PR !${prId}: compare update ${to} with…` });
    if (!pick) {
      return;
    }
    from = pick.id;
  }
  const changes = await client.getIterationChanges(repoId, prId, to, from);
  if (!changes.length) {
    void vscode.window.showInformationMessage(`No file changed between update ${from} and ${to}.`);
    return;
  }
  const open = (change: typeof changes[number]) =>
    openPrDiff({ repoId, prId, iteration: to, change, baseIteration: from || undefined });
  if (changes.length === 1) {
    await open(changes[0]);
    return;
  }
  const picked = await vscode.window.showQuickPick(changes.map(c => ({
    label: path.posix.basename(c.item.path), description: path.posix.dirname(c.item.path), detail: c.changeType, c,
  })), { title: from ? `PR !${prId}: ${changes.length} files changed from update ${from} to ${to}` : `PR !${prId}: ${changes.length} files changed`, matchOnDescription: true });
  if (picked) {
    await open(picked.c);
  }
}

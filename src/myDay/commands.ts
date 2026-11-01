import * as vscode from 'vscode';
import type { AdoClient } from '../client';
import { VOTE_LABELS } from '../util';
import type { DeferEntry, MyDayItem, SnoozeChoice } from './types';
import { snoozeUntil } from './defers';

export interface DeferTarget {
  itemByKey(key: string): MyDayItem | undefined;
  applyDefer(item: MyDayItem, kind: DeferEntry['kind'], until?: number): Promise<void>;
}

interface DeferPick extends vscode.QuickPickItem {
  defer: DeferEntry['kind'];
  choice?: SnoozeChoice;
}

const SNOOZES: DeferPick[] = [
  { label: 'In 2 hours', defer: 'snooze', choice: 'twoHours' },
  { label: 'Tomorrow morning', defer: 'snooze', choice: 'tomorrow' },
  { label: 'Next Monday', defer: 'snooze', choice: 'monday' },
];
const PERMANENT: DeferPick[] = [
  { label: 'Done until it changes', defer: 'done' },
  { label: 'Hide permanently', defer: 'hide' },
];

/** Defers the item of the given key. The title and fingerprint come from the model, never from the page. */
export async function deferItem(target: DeferTarget, key: unknown): Promise<void> {
  if (typeof key !== 'string') {
    return;
  }
  const item = target.itemByKey(key);
  if (!item) {
    return;
  }
  // An approval is only snoozed: it cannot be "done" or hidden, the run waits for it.
  const picks = item.source === 'approvals' ? SNOOZES : [...SNOOZES, ...PERMANENT];
  const pick = await vscode.window.showQuickPick(picks, { title: item.title, placeHolder: 'Defer this item' });
  if (!pick) {
    return;
  }
  await target.applyDefer(item, pick.defer, pick.choice ? snoozeUntil(pick.choice, Date.now()) : undefined);
}

const VOTES: { label: string; vote: number }[] = [
  { label: 'Approve', vote: 10 },
  { label: 'Approve with suggestions', vote: 5 },
  { label: 'Wait for author', vote: -5 },
  { label: 'Reject', vote: -10 },
];

/** Asks for a vote on a pull request and casts it. Returns false when the arguments are invalid or the user cancelled. */
export async function voteOnPullRequest(client: Pick<AdoClient, 'vote'>, repoId: unknown, prId: unknown): Promise<boolean> {
  if (typeof repoId !== 'string' || repoId === '' || typeof prId !== 'number' || !Number.isInteger(prId) || prId <= 0) {
    return false;
  }
  const pick = await vscode.window.showQuickPick(
    VOTES.map(v => ({ label: v.label, vote: v.vote })),
    { title: `Vote on pull request ${prId}`, placeHolder: 'Your vote' });
  if (!pick || !Object.hasOwn(VOTE_LABELS, String(pick.vote))) {
    return false;
  }
  await client.vote(repoId, prId, pick.vote);
  vscode.window.setStatusBarMessage(`$(check) Voted: ${VOTE_LABELS[String(pick.vote)]}`, 3000);
  return true;
}

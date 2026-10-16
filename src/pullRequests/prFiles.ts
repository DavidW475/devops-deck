import * as vscode from 'vscode';
import * as path from 'node:path';
import { AdoClient } from '../client';
import { gitApi, trimSlashes } from '../connection';
import { GitChange, PrChange, PullRequest } from '../types';
import { shortRef } from '../util';
import { assertBranchName } from '../git';

export const PR_SCHEME = 'ado-pr';

export interface PrFileQuery {
  repo: string;
  pr: number;
  obj: string;
  side: 'left' | 'right';
  ct: number;
  iter: number;
  /** iteration the left side belongs to: 1 when diffing against the target branch, else an earlier iteration */
  base: number;
}

export function makePrUri(filePath: string, q: PrFileQuery): vscode.Uri {
  const query = new URLSearchParams({ ...q, pr: String(q.pr), ct: String(q.ct), iter: String(q.iter), base: String(q.base) }).toString();
  return vscode.Uri.from({ scheme: PR_SCHEME, path: filePath.startsWith('/') ? filePath : '/' + filePath, query });
}

export function parsePrUri(uri: vscode.Uri): PrFileQuery {
  const p = new URLSearchParams(uri.query);
  return {
    repo: p.get('repo') ?? '',
    pr: Number(p.get('pr')),
    obj: p.get('obj') ?? '',
    side: p.get('side') === 'left' ? 'left' : 'right',
    ct: Number(p.get('ct')),
    iter: Number(p.get('iter')),
    base: Number(p.get('base')) || 1,
  };
}

/** Serves file contents of a PR by git blob id, so both diff sides are immutable and cacheable. */
export class PrContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly client: AdoClient) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Works for both schemes: ado-pr and ado-git URIs carry the repository and blob id.
    const p = new URLSearchParams(uri.query);
    const repo = p.get('repo') ?? '';
    const obj = p.get('obj') ?? '';
    if (!obj) {
      return Promise.resolve('');
    }
    let text = this.cache.get(obj);
    if (!text) {
      text = this.client.getBlobText(repo, obj);
      text.catch(() => this.cache.delete(obj));
      this.cache.set(obj, text);
    }
    return text;
  }
}

export interface PrFileArgs {
  repoId: string;
  prId: number;
  iteration: number;
  change: PrChange;
  /** compare with this earlier iteration instead of the target branch */
  baseIteration?: number;
}

export async function openPrDiff(args: PrFileArgs): Promise<void> {
  const { change } = args;
  const rightPath = change.item.path;
  const leftPath = change.originalPath ?? rightPath;
  const base = { repo: args.repoId, pr: args.prId, ct: change.changeTrackingId, iter: args.iteration, base: args.baseIteration ?? 1 };
  const left = makePrUri(leftPath, { ...base, obj: change.item.originalObjectId ?? '', side: 'left' });
  const right = makePrUri(rightPath, { ...base, obj: change.changeType.includes('delete') ? '' : change.item.objectId ?? '', side: 'right' });
  const title = args.baseIteration
    ? `${path.posix.basename(rightPath)} (PR !${args.prId}, update ${args.baseIteration} → ${args.iteration})`
    : `${path.posix.basename(rightPath)} (PR !${args.prId})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

export const GIT_SCHEME = 'ado-git';

/** Read-only file at a git blob, for branch comparisons outside of pull requests. */
export function makeBlobUri(repoId: string, filePath: string, objectId: string | undefined, ref: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_SCHEME, path: filePath.startsWith('/') ? filePath : '/' + filePath,
    query: new URLSearchParams({ repo: repoId, obj: objectId ?? '', ref }).toString(),
  });
}

/** Diff of one file between two branches. */
export async function openBranchDiff(repoId: string, change: GitChange, base: string, target: string): Promise<void> {
  const rightPath = change.item.path;
  const left = makeBlobUri(repoId, change.originalPath ?? rightPath, change.changeType.includes('add') ? '' : change.item.originalObjectId, base);
  const right = makeBlobUri(repoId, rightPath, change.changeType.includes('delete') ? '' : change.item.objectId, target);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(rightPath)} (${base} ↔ ${target})`, { preview: true });
}

/** Fetches the PR source branch in the matching local git repository and checks it out. */
export async function checkoutPullRequest(pr: PullRequest): Promise<void> {
  const git = gitApi();
  if (!git) {
    throw new Error('The built-in Git extension is not available.');
  }
  const repoName = pr.repository.name.toLowerCase();
  const matchesRemote = (url?: string) => {
    if (!url) {
      return false;
    }
    const clean = trimSlashes(decodeURIComponent(url).toLowerCase().replace(/\.git$/, ''), false);
    return clean.endsWith('/' + repoName);
  };
  for (const repo of git.repositories) {
    const remote = repo.state.remotes.find((r: any) => matchesRemote(r.fetchUrl) || matchesRemote(r.pushUrl));
    if (!remote) {
      continue;
    }
    const branch = assertBranchName(shortRef(pr.sourceRefName));
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking out ${branch}…` }, async () => {
      await repo.fetch(remote.name, branch);
      const exists = repo.state.refs.some((r: any) => r.type === 0 && r.name === branch);
      if (exists) {
        await repo.checkout(branch);
        await repo.pull().catch(() => undefined);
      } else {
        await repo.createBranch(branch, true, `${remote.name}/${branch}`);
        await repo.setBranchUpstream?.(branch, `${remote.name}/${branch}`).catch(() => undefined);
      }
    });
    void vscode.window.showInformationMessage(`Checked out ${branch} in ${path.basename(repo.rootUri.fsPath)}.`);
    return;
  }
  throw new Error(`No open git repository has a remote pointing to "${pr.repository.name}".`);
}

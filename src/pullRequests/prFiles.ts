import * as vscode from 'vscode';
import * as path from 'path';
import { AdoClient } from '../client';
import { gitApi } from '../connection';
import { PrChange, PullRequest } from '../types';
import { shortRef } from '../util';

export const PR_SCHEME = 'ado-pr';

export interface PrFileQuery {
  repo: string;
  pr: number;
  obj: string;
  side: 'left' | 'right';
  ct: number;
  iter: number;
}

export function makePrUri(filePath: string, q: PrFileQuery): vscode.Uri {
  const query = new URLSearchParams({ ...q, pr: String(q.pr), ct: String(q.ct), iter: String(q.iter) }).toString();
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
  };
}

/** Serves file contents of a PR by git blob id, so both diff sides are immutable and cacheable. */
export class PrContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly client: AdoClient) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = parsePrUri(uri);
    if (!q.obj) {
      return Promise.resolve('');
    }
    let text = this.cache.get(q.obj);
    if (!text) {
      text = this.client.getBlobText(q.repo, q.obj);
      text.catch(() => this.cache.delete(q.obj));
      this.cache.set(q.obj, text);
    }
    return text;
  }
}

export interface PrFileArgs {
  repoId: string;
  prId: number;
  iteration: number;
  change: PrChange;
}

export async function openPrDiff(args: PrFileArgs): Promise<void> {
  const { change } = args;
  const rightPath = change.item.path;
  const leftPath = change.originalPath ?? rightPath;
  const base = { repo: args.repoId, pr: args.prId, ct: change.changeTrackingId, iter: args.iteration };
  const left = makePrUri(leftPath, { ...base, obj: change.item.originalObjectId ?? '', side: 'left' });
  const right = makePrUri(rightPath, { ...base, obj: change.changeType.includes('delete') ? '' : change.item.objectId ?? '', side: 'right' });
  const title = `${path.posix.basename(rightPath)} (PR !${args.prId})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
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
    const clean = decodeURIComponent(url).toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
    return clean.endsWith('/' + repoName);
  };
  for (const repo of git.repositories) {
    const remote = repo.state.remotes.find((r: any) => matchesRemote(r.fetchUrl) || matchesRemote(r.pushUrl));
    if (!remote) {
      continue;
    }
    const branch = shortRef(pr.sourceRefName);
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

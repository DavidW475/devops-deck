import * as path from 'node:path';
import * as vscode from 'vscode';
import { Connection, gitApi, parseRemote } from './connection';

/** A local git repository whose remote points to a repository of the configured Azure DevOps project. */
export interface LocalRepo {
  /** the built-in git extension's Repository object */
  repo: any;
  remoteName: string;
  /** Azure Repos repository name */
  repoName: string;
  /** project of the repository (one of the selected projects) */
  project: string;
}

const sameText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** Local repositories with a remote in the current organization and one of the selected projects. */
export function localAdoRepos(conn: Connection | undefined): LocalRepo[] {
  if (!conn) {
    return [];
  }
  const out: LocalRepo[] = [];
  for (const repo of gitApi()?.repositories ?? []) {
    const remotes: any[] = [...repo.state.remotes].sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
    for (const remote of remotes) {
      const parsed = parseRemote(remote.fetchUrl ?? remote.pushUrl ?? '');
      const project = parsed && sameText(parsed.orgUrl, conn.orgUrl) ? (conn.projects ?? [conn.project]).find(p => sameText(p, parsed.project)) : undefined;
      if (parsed && project) {
        out.push({ repo, remoteName: remote.name, repoName: parsed.repo, project });
        break;
      }
    }
  }
  return out;
}

/** The repository of the active editor, the only one, or one the user picks. */
export async function pickLocalRepo(conn: Connection | undefined, title: string): Promise<LocalRepo | undefined> {
  const repos = localAdoRepos(conn);
  if (repos.length <= 1) {
    return repos[0];
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    const hit = repos.filter(r => isInside(active.fsPath, r.repo.rootUri.fsPath))
      .sort((a, b) => b.repo.rootUri.fsPath.length - a.repo.rootUri.fsPath.length)[0];
    if (hit) {
      return hit;
    }
  }
  const pick = await vscode.window.showQuickPick(repos.map(r => ({
    label: path.basename(r.repo.rootUri.fsPath), description: r.repoName, detail: currentBranch(r.repo), r,
  })), { title, placeHolder: 'Repository' });
  return pick?.r;
}

export function isInside(file: string, folder: string): boolean {
  const rel = path.relative(folder, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Name of the checked-out branch, undefined when detached. */
export function currentBranch(repo: any): string | undefined {
  return repo?.state?.HEAD?.name || undefined;
}

/** Work item IDs mentioned in a branch name, e.g. "feature/1234-login" → [1234]. */
export function workItemIdsFromBranch(branch: string): number[] {
  const ids = [...branch.matchAll(/(?:^|[/_-])(\d{2,7})(?=[/_-]|$)/g)].map(m => Number(m[1]));
  return [...new Set(ids)];
}

/** Work item IDs mentioned as "#123" or "AB#123" in commit messages. */
export function workItemIdsFromText(text: string): number[] {
  const ids = [...text.matchAll(/(?:^|[\s(,;[])(?:AB)?#(\d{1,7})\b/g)].map(m => Number(m[1]));
  return [...new Set(ids)];
}

/** "feature/1234-fix-login_page" → "Fix login page". */
export function titleFromBranch(branch: string): string {
  const last = branch.split('/').pop() ?? branch;
  const words = last.replace(/^\d+[-_]?/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : branch;
}

/** Suggested PR title and description from the commits that are new on the branch (newest first). */
export function describeCommits(branch: string, messages: string[]): { title: string; description: string } {
  const subjects = messages.map(m => m.split('\n')[0].trim()).filter(Boolean);
  if (messages.length === 1) {
    const [subject, ...rest] = messages[0].split('\n');
    return { title: subject.trim(), description: rest.join('\n').trim() };
  }
  return {
    title: titleFromBranch(branch),
    description: subjects.length ? [...subjects].reverse().map(s => `- ${s}`).join('\n') : '',
  };
}

/**
 * Refuses branch names git would misread: a leading "-" is taken as an option, and names that
 * `git check-ref-format` rejects would fail later with a less helpful message.
 */
export function assertBranchName(name: string): string {
  const bad = !name || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')
    || name.endsWith('.lock') || name.includes('..') || name.includes('//') || name.includes('@{')
    || [...name].some(ch => ch <= ' ' || ch === '\x7f' || '~^:?*[\\'.includes(ch));
  if (bad) {
    throw new Error(`"${name}" is not a valid branch name.`);
  }
  return name;
}

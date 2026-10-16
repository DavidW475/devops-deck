import * as vscode from 'vscode';

export interface Connection {
  orgUrl: string;
  /** the primary project: settings, watchers, saved queries and new items use it */
  project: string;
  /** every selected project of the organization, the primary one first */
  projects: string[];
  /** true when org/project were detected from a git remote instead of settings */
  detected: boolean;
}

export class ConnectionManager implements vscode.Disposable {
  current?: Connection;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  async resolve(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('azureDevOps');
    let org = cfg.get<string>('organization', '').trim();
    let project = cfg.get<string>('project', '').trim();
    let detected = false;
    if (!org || !project) {
      const fromGit = detectFromGit();
      if (fromGit) {
        detected = !org;
        org ||= fromGit.orgUrl;
        project ||= fromGit.project;
      }
    }
    const extra = cfg.get<string[]>('additionalProjects', []).map(p => String(p).trim()).filter(Boolean);
    const projects = project ? [...new Set([project, ...extra.filter(p => p.toLowerCase() !== project.toLowerCase())])] : [];
    const next = org && project ? { orgUrl: normalizeOrgUrl(org), project, projects, detected } : undefined;
    const changed = next?.orgUrl !== this.current?.orgUrl || next?.project !== this.current?.project
      || next?.projects.join('\n') !== this.current?.projects.join('\n');
    this.current = next;
    await vscode.commands.executeCommand('setContext', 'azureDevOps.configured', !!next);
    if (changed) {
      this.emitter.fire();
    }
  }

  /** Re-resolve when git repositories show up (the git extension opens them lazily). */
  async watchGit(): Promise<void> {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) {
      return;
    }
    if (!ext.isActive) {
      await ext.activate();
    }
    const git = gitApi();
    if (git) {
      this.disposables.push(git.onDidOpenRepository(() => this.resolve()));
      await this.resolve();
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.emitter.dispose();
  }
}

export function normalizeOrgUrl(org: string): string {
  return trimSlashes(org.includes('://') ? org : `https://dev.azure.com/${org}`, false);
}

/** Removes trailing (and with `leading`, also leading) slashes; a loop instead of a backtracking regex. */
export function trimSlashes(s: string, leading = true): string {
  let start = 0;
  let end = s.length;
  while (leading && start < end && s[start] === '/') {
    start++;
  }
  while (end > start && s[end - 1] === '/') {
    end--;
  }
  return s.slice(start, end);
}

/**
 * Whether credentials may be sent to this URL. Organization settings can come from a cloned
 * repository's .vscode/settings.json, so only Azure DevOps Services hosts over https qualify.
 */
export function isAzureDevOpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'dev.azure.com' || u.hostname.endsWith('.visualstudio.com'));
  } catch {
    return false;
  }
}

export function gitApi(): any | undefined {
  const ext = vscode.extensions.getExtension('vscode.git');
  return ext?.isActive ? ext.exports.getAPI(1) : undefined;
}

export function parseRemote(url: string): { orgUrl: string; project: string; repo: string } | undefined {
  const patterns: [RegExp, (m: RegExpExecArray) => { orgUrl: string; project: string; repo: string }][] = [
    [/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i,
      m => ({ orgUrl: `https://dev.azure.com/${m[1]}`, project: m[2], repo: m[3] })],
    [/^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i,
      m => ({ orgUrl: `https://dev.azure.com/${m[1]}`, project: m[2], repo: m[3] })],
    [/^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):(?:\d+\/)?v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i,
      m => ({ orgUrl: `https://dev.azure.com/${m[1]}`, project: m[2], repo: m[3] })],
  ];
  for (const [re, map] of patterns) {
    const m = re.exec(url.trim());
    if (m) {
      const r = map(m);
      return { orgUrl: r.orgUrl, project: decodeURIComponent(r.project), repo: decodeURIComponent(r.repo) };
    }
  }
  return undefined;
}

function detectFromGit(): { orgUrl: string; project: string } | undefined {
  for (const repo of gitApi()?.repositories ?? []) {
    for (const remote of repo.state.remotes) {
      const parsed = parseRemote(remote.fetchUrl ?? remote.pushUrl ?? '');
      if (parsed) {
        return parsed;
      }
    }
  }
  return undefined;
}

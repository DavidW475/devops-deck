import * as vscode from 'vscode';
import { AdoClient, AdoError } from '../client';
import { ConnectionManager, normalizeOrgUrl } from '../connection';
import { buildDto, timelineTree } from '../pipelines/timeline';
import { summarizeChecks } from '../pullRequests/checks';
import { changeVersion, ReviewedFiles } from '../pullRequests/reviewed';
import { PullRequest, WorkItem, WorkItemState } from '../types';
import { errorMessage, nonce, shortRef } from '../util';

export interface BuiltinQuery {
  name: string;
  wiql: string;
}

const DEFAULT_QUERIES: BuiltinQuery[] = [
  { name: 'Assigned to me', wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed') ORDER BY [System.ChangedDate] DESC" },
  { name: 'Recently updated by me', wiql: 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.ChangedBy] = @Me AND [System.ChangedDate] >= @Today - 14 ORDER BY [System.ChangedDate] DESC' },
  { name: 'Created by me', wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.CreatedBy] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed') ORDER BY [System.CreatedDate] DESC" },
];

/** The sidebar dashboard: a single webview with tabs for pull requests, work items and pipelines. */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly stateCache = new Map<string, Promise<WorkItemState[]>>();

  constructor(
    private readonly client: AdoClient,
    private readonly connections: ConnectionManager,
    private readonly reviewed: ReviewedFiles,
    private readonly extensionUri: vscode.Uri,
  ) {
    reviewed.onDidChange(e => void this.view?.webview.postMessage({ type: 'reviewed', ...e }));
    vscode.window.onDidChangeWindowState(e => void this.view?.webview.postMessage({ type: 'focus', focused: e.focused }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const n = nonce();
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${n}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage(m => this.onMessage(m));
  }

  refresh(): void {
    this.stateCache.clear();
    void this.view?.webview.postMessage({ type: 'refresh' });
  }

  private async onMessage(m: any): Promise<void> {
    if (m.type === 'command') {
      // Only our own commands: anything else (e.g. terminal commands) must not be reachable from the webview.
      if (typeof m.name === 'string' && m.name.startsWith('azureDevOps.')) {
        await vscode.commands.executeCommand(m.name, ...(Array.isArray(m.args) ? m.args : []));
      }
      return;
    }
    if (m.type !== 'rpc') {
      return;
    }
    try {
      const result = await this.rpc(m.method, m.params ?? {});
      void this.view?.webview.postMessage({ type: 'rpc', id: m.id, result });
    } catch (e) {
      const auth = e instanceof AdoError && e.isAuthError;
      void this.view?.webview.postMessage({ type: 'rpc', id: m.id, error: { message: errorMessage(e), auth } });
    }
  }

  private async rpc(method: string, p: any): Promise<unknown> {
    const c = this.client;
    switch (method) {
      case 'context': {
        const conn = this.connections.current;
        const cfg = vscode.workspace.getConfiguration('azureDevOps');
        return {
          configured: !!conn,
          orgUrl: conn?.orgUrl,
          org: conn?.orgUrl.split('/').pop(),
          project: conn?.project,
          authMethod: cfg.get('authMethod'),
          refreshInterval: cfg.get<number>('pipelines.refreshInterval', 10),
          autoRefreshInterval: cfg.get<number>('refreshInterval', 60),
          focused: vscode.window.state.focused,
        };
      }
      case 'projects':
        return c.listProjects(p.org ? normalizeOrgUrl(String(p.org).trim()) : undefined);
      case 'setProject': {
        // Saved per workspace; the configuration listener re-resolves the connection and refreshes the view.
        const cfg = vscode.workspace.getConfiguration('azureDevOps');
        const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await cfg.update('organization', normalizeOrgUrl(String(p.org).trim()), target);
        await cfg.update('project', String(p.project), target);
        return null;
      }
      case 'me':
        return c.getMe();
      case 'prs': {
        const me = await c.getMe();
        const criteria = p.filter === 'mine' ? { creatorId: me.id } : p.filter === 'review' ? { reviewerId: me.id } : {};
        const prs = await c.listPullRequests(criteria);
        // Policy status per PR; a PR whose policies cannot be read just shows no checks.
        const checks = await Promise.all(prs.map(pr => pr.repository.project?.id
          ? c.getPolicyEvaluations(pr.repository.project.id, pr.pullRequestId).then(summarizeChecks, () => undefined)
          : undefined));
        return prs.map((pr, i) => ({ ...this.prDto(pr, me.id), checks: checks[i] }));
      }
      case 'prFiles': {
        const iteration = await c.getLatestIteration(p.repoId, p.prId);
        const changes = await c.getIterationChanges(p.repoId, p.prId, iteration);
        return {
          iteration,
          files: changes.sort((a, b) => a.item.path.localeCompare(b.item.path))
            .map(change => {
              const version = changeVersion(change);
              const reviewed = this.reviewed.isReviewed(p.repoId, p.prId, change.item.path, version);
              return { path: change.item.path, changeType: change.changeType, change, version, reviewed };
            }),
        };
      }
      case 'setReviewed':
        await this.reviewed.set(p.repoId, Number(p.prId), String(p.path), String(p.version), !!p.reviewed);
        return null;
      case 'queries': {
        const saved = await c.listSavedQueries().catch(() => []);
        return {
          builtin: this.builtinQueries().map((q, i) => ({ key: `builtin:${i}`, name: q.name })),
          saved: saved.map(q => ({ key: `saved:${q.id}`, name: q.name, path: q.path })),
        };
      }
      case 'workItems': {
        const key = String(p.query ?? 'builtin:0');
        const ids = key.startsWith('saved:')
          ? await c.runSavedQuery(key.slice(6))
          : await c.queryWiql((this.builtinQueries()[Number(key.slice(8))] ?? this.builtinQueries()[0]).wiql);
        const items = await c.getWorkItems(ids.slice(0, 200));
        return Promise.all(items.map(w => this.workItemDto(w)));
      }
      case 'builds': {
        const requestedFor = p.filter === 'mine' ? (await c.getMe()).id : undefined;
        return (await c.listBuilds({ requestedFor, top: 30 })).map(buildDto);
      }
      case 'definitions':
        return (await c.listDefinitions()).map(d => ({
          id: d.id, name: d.name, path: d.path === '\\' ? '' : d.path.replace(/^\\/, '').replace(/\\/g, ' / '),
          folder: d.path.split('\\').filter(Boolean),
          latest: d.latestBuild ? buildDto(d.latestBuild) : undefined,
        }));
      case 'definitionBuilds':
        return (await c.listBuilds({ definitionId: p.id, top: 10 })).map(buildDto);
      case 'timeline':
        return timelineTree(await c.getTimeline(p.buildId));
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  private builtinQueries(): BuiltinQuery[] {
    const custom = vscode.workspace.getConfiguration('azureDevOps').get<BuiltinQuery[]>('workItems.queries', []);
    return custom.length ? custom : DEFAULT_QUERIES;
  }

  private prDto(pr: PullRequest, meId: string) {
    return {
      id: pr.pullRequestId,
      repoId: pr.repository.id,
      repoName: pr.repository.name,
      title: pr.title,
      isDraft: !!pr.isDraft,
      author: pr.createdBy.displayName,
      created: pr.creationDate,
      source: shortRef(pr.sourceRefName),
      target: shortRef(pr.targetRefName),
      mergeStatus: pr.mergeStatus,
      myVote: pr.reviewers.find(r => r.id === meId)?.vote ?? 0,
      reviewers: pr.reviewers.map(r => ({ name: r.displayName, vote: r.vote, isContainer: !!r.isContainer, isRequired: !!r.isRequired })),
    };
  }

  private async workItemDto(w: WorkItem) {
    const f = w.fields;
    const type = f['System.WorkItemType'];
    let states = this.stateCache.get(type);
    if (!states) {
      states = this.client.getWorkItemStates(type).catch(() => []);
      this.stateCache.set(type, states);
    }
    const state = (await states).find(s => s.name === f['System.State']);
    return {
      id: w.id,
      title: f['System.Title'],
      type,
      state: f['System.State'],
      stateColor: state ? `#${state.color}` : undefined,
      stateCategory: state?.category,
      assignedTo: f['System.AssignedTo']?.displayName,
      changed: f['System.ChangedDate'],
      priority: f['Microsoft.VSTS.Common.Priority'],
      iteration: String(f['System.IterationPath'] ?? '').split('\\').pop(),
      tags: String(f['System.Tags'] ?? '').split(';').map(t => t.trim()).filter(Boolean),
    };
  }
}

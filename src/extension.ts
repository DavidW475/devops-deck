import * as vscode from 'vscode';
import { AdoClient, PAT_SECRET_KEY } from './client';
import { ConnectionManager, normalizeOrgUrl } from './connection';
import { BuildLogTerminal, LOG_SCHEME, LogDocumentProvider, makeLogUri } from './pipelines/logs';
import { RunPipelinePanel } from './pipelines/runPanel';
import { RunViewPanel } from './pipelines/runView';
import { PrCommentController } from './pullRequests/prComments';
import { checkoutPullRequest, openPrDiff, PR_SCHEME, PrContentProvider, PrFileArgs } from './pullRequests/prFiles';
import { PullRequestPanel } from './pullRequests/prPanel';
import { ReviewedFiles } from './pullRequests/reviewed';
import { SidebarProvider } from './sidebar/sidebarProvider';
import { guarded, shortRef } from './util';
import { assignWorkItemToMe, changeWorkItemState, commentOnWorkItem, createBranchForWorkItem, createWorkItem } from './workItems/wiCommands';
import { readWatchers, WatchEvent, Watchers, writeWatchers } from './watchers/watchers';
import { WatchersPanel } from './watchers/watchersPanel';
import { WatchersTree } from './watchers/watchersTree';
import { WorkItemPanel } from './workItems/wiPanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const connections = new ConnectionManager();
  const client = new AdoClient(context.secrets, connections);
  const reviewed = new ReviewedFiles(context.globalState, connections);
  const sidebar = new SidebarProvider(client, connections, reviewed, context.extensionUri);
  const comments = new PrCommentController(client);
  const watchers = new Watchers(client, connections);
  const refresh = () => sidebar.refresh();

  const command = (id: string, fn: (...args: any[]) => Promise<unknown>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, guarded(fn)));
  /** Commands that change data on the server refresh the sidebar afterwards. */
  const mutation = (id: string, fn: (...args: any[]) => Promise<unknown>) =>
    command(id, async (...args) => {
      if ((await fn(...args)) !== false) {
        refresh();
      }
    });

  context.subscriptions.push(
    connections,
    comments,
    watchers,
    new WatchersTree(watchers),
    reviewed,
    vscode.window.registerWebviewViewProvider('azureDevOps.dashboard', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PR_SCHEME, new PrContentProvider(client)),
    vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, new LogDocumentProvider(client)),
    connections.onDidChange(() => {
      client.reset();
      refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('azureDevOps')) {
        client.reset();
        void connections.resolve().then(refresh);
      }
    }),
    vscode.authentication.onDidChangeSessions(e => {
      if (e.provider.id === 'microsoft') {
        client.reset();
        refresh();
      }
    }),
  );

  // ----- general -----
  command('azureDevOps.refresh', async () => {
    comments.reload();
    refresh();
  });
  command('azureDevOps.signIn', async () => {
    await vscode.workspace.getConfiguration('azureDevOps').update('authMethod', 'microsoft', vscode.ConfigurationTarget.Global);
    await client.signIn();
    refresh();
  });
  command('azureDevOps.setPat', async () => {
    const pat = await vscode.window.showInputBox({
      title: 'Azure DevOps Personal Access Token',
      prompt: 'Scopes needed: Code (Read & Write), Work Items (Read & Write), Build (Read & Execute)',
      password: true,
      ignoreFocusOut: true,
    });
    if (!pat) {
      return;
    }
    await context.secrets.store(PAT_SECRET_KEY, pat.trim());
    await vscode.workspace.getConfiguration('azureDevOps').update('authMethod', 'pat', vscode.ConfigurationTarget.Global);
    client.reset();
    refresh();
  });
  command('azureDevOps.configure', async () => {
    const cfg = vscode.workspace.getConfiguration('azureDevOps');
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    let orgUrl = connections.current?.orgUrl ?? (cfg.get<string>('organization', '').trim() || undefined);
    for (;;) {
      if (!orgUrl) {
        const org = await vscode.window.showInputBox({
          title: 'Azure DevOps organization',
          prompt: 'Organization name or URL, e.g. "contoso" or "https://dev.azure.com/contoso"',
          ignoreFocusOut: true,
        });
        if (!org?.trim()) {
          return;
        }
        orgUrl = normalizeOrgUrl(org.trim());
      }
      const picked = await pickProject(orgUrl);
      if (picked === undefined) {
        return;
      }
      if (picked === CHANGE_ORG) {
        orgUrl = undefined;
        continue;
      }
      await cfg.update('organization', orgUrl, target);
      await cfg.update('project', picked, target);
      await connections.resolve();
      refresh();
      return;
    }
  });

  const CHANGE_ORG = Symbol('changeOrg');
  /** Dropdown of the organization's projects; falls back to free text if they can't be listed. */
  async function pickProject(orgUrl: string): Promise<string | typeof CHANGE_ORG | undefined> {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { project?: string }>();
    qp.title = `Azure DevOps project — ${orgUrl.split('/').pop()}`;
    qp.placeholder = 'Select a project';
    qp.ignoreFocusOut = true;
    qp.busy = true;
    const changeOrg = { label: '$(organization) Change organization…', alwaysShow: true };
    qp.items = [changeOrg];
    qp.show();
    client.listProjects(orgUrl).then(projects => {
      const current = connections.current?.orgUrl === orgUrl ? connections.current.project : undefined;
      const items = projects.map(p => ({ label: p, project: p, description: p === current ? 'current' : undefined }));
      qp.items = [...items, { label: '', kind: vscode.QuickPickItemKind.Separator }, changeOrg];
      qp.activeItems = items.filter(i => i.project === current);
    }, () => {
      qp.placeholder = 'Could not list projects — type the project name and press Enter';
    }).finally(() => qp.busy = false);
    return new Promise(resolve => {
      qp.onDidAccept(() => {
        const sel = qp.selectedItems[0];
        resolve(sel === changeOrg ? CHANGE_ORG : sel?.project ?? (qp.value.trim() || undefined));
        qp.hide();
      });
      qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
    });
  }

  // ----- pull requests -----
  command('azureDevOps.pr.openOverview', async (repoId: string, prId: number) =>
    PullRequestPanel.show(client, context.extensionUri, repoId, prId, refresh));
  command('azureDevOps.pr.openDiff', async (args: PrFileArgs) => openPrDiff(args));
  command('azureDevOps.pr.checkout', async (repoId: string, prId: number) =>
    checkoutPullRequest(await client.getPullRequest(repoId, prId)));
  command('azureDevOps.pr.openInBrowser', async (repoName: string, prId: number) =>
    vscode.env.openExternal(vscode.Uri.parse(client.webUrl('pr', repoName, prId))));

  // ----- work items -----
  command('azureDevOps.watchers.checkNow', () => watchers.checkNow());
  command('azureDevOps.watchers.showEvents', () => watchers.showEvents());
  command('azureDevOps.watchers.configure', async () => WatchersPanel.show(client, context.extensionUri));
  command('azureDevOps.watchers.create', async () => WatchersPanel.show(client, context.extensionUri, 'new'));
  command('azureDevOps.watchers.edit', async (node?: { index: number }) => WatchersPanel.show(client, context.extensionUri, node?.index));
  command('azureDevOps.watchers.openEvent', async (e: WatchEvent) => watchers.open(e));
  const setPaused = async (node: { index: number }, paused: boolean) => {
    const list = readWatchers();
    if (list[node.index]) {
      list[node.index] = { ...list[node.index], enabled: paused ? false : undefined };
      await writeWatchers(list);
    }
  };
  command('azureDevOps.watchers.pause', async (node: { index: number }) => setPaused(node, true));
  command('azureDevOps.watchers.resume', async (node: { index: number }) => setPaused(node, false));
  command('azureDevOps.watchers.delete', async (node: { index: number }) => {
    const list = readWatchers();
    const w = list[node.index];
    if (w && await vscode.window.showWarningMessage(`Delete the watcher "${w.name}"?`, { modal: true }, 'Delete') === 'Delete') {
      list.splice(node.index, 1);
      await writeWatchers(list);
    }
  });
  command('azureDevOps.wi.open', async (id: number) => WorkItemPanel.show(client, context.extensionUri, id, refresh));
  command('azureDevOps.wi.openById', async () => {
    const id = await vscode.window.showInputBox({ title: 'Open work item', prompt: 'Work item ID', validateInput: v => /^\d+$/.test(v.trim().replace(/^#/, '')) ? undefined : 'Enter a number' });
    if (id) {
      WorkItemPanel.show(client, context.extensionUri, Number(id.trim().replace(/^#/, '')), refresh);
    }
  });
  command('azureDevOps.wi.openInBrowser', async (id: number) =>
    vscode.env.openExternal(vscode.Uri.parse(client.webUrl('workItem', id))));
  mutation('azureDevOps.wi.changeState', (id: number, type: string) => changeWorkItemState(client, id, type));
  mutation('azureDevOps.wi.assignToMe', async (id: number) => {
    await assignWorkItemToMe(client, id);
    void vscode.window.setStatusBarMessage(`$(check) #${id} assigned to you`, 3000);
  });
  mutation('azureDevOps.wi.comment', (id: number) => commentOnWorkItem(client, id));
  mutation('azureDevOps.wi.create', async () => {
    const id = await createWorkItem(client);
    if (id === undefined) {
      return false;
    }
    WorkItemPanel.show(client, context.extensionUri, id, refresh);
  });
  command('azureDevOps.wi.createBranch', (id: number) => createBranchForWorkItem(client, id));

  // ----- pipelines -----
  command('azureDevOps.pipelines.run', async (definitionId?: number) =>
    RunPipelinePanel.show(client, context.extensionUri, definitionId, refresh));
  mutation('azureDevOps.pipelines.rerun', async (definitionId: number, branch: string) => {
    const def = await client.getDefinition(definitionId);
    return queue(definitionId, def.name, branch);
  });
  mutation('azureDevOps.pipelines.cancel', async (buildId: number) => {
    const ok = await vscode.window.showWarningMessage(`Cancel run ${buildId}?`, { modal: true }, 'Cancel run');
    if (ok !== 'Cancel run') {
      return false;
    }
    await client.cancelBuild(buildId);
  });
  command('azureDevOps.pipelines.openRun', async (buildId: number) =>
    RunViewPanel.show(client, context.extensionUri, buildId, refresh));
  command('azureDevOps.pipelines.streamLogs', async (buildId: number, title?: string) =>
    BuildLogTerminal.show(client, buildId, title ?? `Build ${buildId}`));
  command('azureDevOps.pipelines.openLog', async (buildId: number, logId: number, name: string) => {
    const doc = await vscode.workspace.openTextDocument(makeLogUri(buildId, logId, name));
    await vscode.languages.setTextDocumentLanguage(doc, 'log');
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  command('azureDevOps.pipelines.openInBrowser', async (buildId: number) =>
    vscode.env.openExternal(vscode.Uri.parse(client.webUrl('build', buildId))));
  command('azureDevOps.pipelines.openDefinition', async (definitionId: number) =>
    vscode.env.openExternal(vscode.Uri.parse(client.webUrl('definition', definitionId))));

  async function queue(definitionId: number, name: string, branch: string): Promise<void> {
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    const build = await client.queueBuild(definitionId, ref);
    void vscode.window.showInformationMessage(`Queued ${name} #${build.buildNumber}.`, 'Stream logs').then(choice => {
      if (choice) {
        BuildLogTerminal.show(client, build.id, `${name} #${build.buildNumber}`);
      }
    });
  }

  await connections.resolve();
  void connections.watchGit();
}

export function deactivate(): void {}

import * as vscode from 'vscode';
import { AdoClient, PAT_SECRET_KEY } from './client';
import { ConnectionManager, normalizeOrgUrl } from './connection';
import { BuildLogTerminal, LOG_SCHEME, LogDocumentProvider, makeLogUri } from './pipelines/logs';
import { answerApproval } from './pipelines/approvals';
import { RunPipelinePanel } from './pipelines/runPanel';
import { RunViewPanel } from './pipelines/runView';
import { DesignerCodeLens, DesignerHost, PipelineDesignerPanel } from './pipelines/designerPanel';
import { PipelinePreviewPanel, PreviewMode } from './pipelines/previewPanel';
import { TaskCatalog } from './pipelines/taskCatalog';
import { YamlTaskSupport } from './pipelines/yamlTasks';
import { YamlTemplateSupport } from './pipelines/yamlTemplates';
import { PrCommentController } from './pullRequests/prComments';
import { CreatePullRequestPanel } from './pullRequests/createPrPanel';
import { compareIterations } from './pullRequests/iterations';
import { checkoutPullRequest, GIT_SCHEME, openPrDiff, PR_SCHEME, PrContentProvider, PrFileArgs } from './pullRequests/prFiles';
import { PullRequestPanel } from './pullRequests/prPanel';
import { PrStatusBar } from './pullRequests/prStatusBar';
import { ReviewedFiles } from './pullRequests/reviewed';
import { ReposPanel } from './repos/reposPanel';
import { SidebarProvider } from './sidebar/sidebarProvider';
import { openWiki, WIKI_SCHEME, WikiFileSystem } from './wiki/wiki';
import { guarded, plural } from './util';
import {
  assignWorkItemToMe, changeWorkItemState, commentOnWorkItem, createBranchForWorkItem, createWorkItem, createWorkItemFromCode, TodoCodeActions,
} from './workItems/wiCommands';
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
  const prStatus = new PrStatusBar(client, connections);
  const logDocs = new LogDocumentProvider(client);
  const yamlTemplates = new YamlTemplateSupport(client, connections).register();
  const taskCatalog = new TaskCatalog(client, connections, context.globalStorageUri);
  const yamlTasks = new YamlTaskSupport(taskCatalog, connections).register();
  PullRequestPanel.useStore(context.globalState);
  PipelinePreviewPanel.useStore(context.globalState);
  const designerLens = new DesignerCodeLens();
  const designerHost: DesignerHost = {
    resolver: yamlTemplates.resolver,
    expandOnServer: (doc, params, definitionId, text) => yamlTemplates.expandOnServer(doc, params, definitionId, text),
    client,
    tasks: taskCatalog,
    orgUrl: () => connections.current?.orgUrl,
  };
  const refresh = () => {
    sidebar.refresh();
    prStatus.refresh();
  };

  /** Client for the project a sidebar item belongs to (passed as the last command argument when several are selected). */
  const at = (project: unknown) => client.forProject(typeof project === 'string' && project ? project : undefined);
  const command = (id: string, fn: (...args: any[]) => unknown) =>
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
    prStatus,
    yamlTemplates,
    taskCatalog,
    yamlTasks,
    designerLens,
    vscode.languages.registerCodeLensProvider([{ language: 'yaml', scheme: 'file' }, { language: 'azure-pipelines', scheme: 'file' }], designerLens),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new TodoCodeActions(), { providedCodeActionKinds: TodoCodeActions.kinds }),
    vscode.window.registerWebviewViewProvider('azureDevOps.dashboard', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PR_SCHEME, new PrContentProvider(client)),
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new PrContentProvider(client)),
    vscode.workspace.registerFileSystemProvider(WIKI_SCHEME, new WikiFileSystem(client), { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, logDocs),
    connections.onDidChange(() => {
      client.reset();
      taskCatalog.reset();
      refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('azureDevOps.yaml.designerCodeLens') || e.affectsConfiguration('azureDevOps.yaml.taskSupport')) {
        designerLens.refresh();
      }
      if (e.affectsConfiguration('azureDevOps')) {
        client.reset();
        void connections.resolve().then(refresh);
      }
    }),
    vscode.authentication.onDidChangeSessions(e => {
      if (e.provider.id === 'microsoft') {
        client.reset();
        taskCatalog.reset();
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
    taskCatalog.reset();
    refresh();
  });
  command('azureDevOps.setPat', async () => {
    const pat = await vscode.window.showInputBox({
      title: 'Azure DevOps Personal Access Token',
      prompt: 'Scopes: Code (Read & Write), Work Items (Read & Write), Build (Read & Execute), Wiki (Read & Write), Project and Team (Read), Identity (Read), Test Management (Read), Agent Pools (Read, for the task catalog)',
      password: true,
      ignoreFocusOut: true,
    });
    if (!pat) {
      return;
    }
    await context.secrets.store(PAT_SECRET_KEY, pat.trim());
    await vscode.workspace.getConfiguration('azureDevOps').update('authMethod', 'pat', vscode.ConfigurationTarget.Global);
    client.reset();
    taskCatalog.reset();
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
  command('azureDevOps.pr.create', async (repoName?: string, source?: string) =>
    CreatePullRequestPanel.show(client, connections, context.extensionUri,
      { repoName: typeof repoName === 'string' ? repoName : undefined, source: typeof source === 'string' ? source : undefined }, refresh));
  command('azureDevOps.pr.compareIterations', async (repoId: string, prId: number, base?: number, target?: number) =>
    compareIterations(client, repoId, prId, base, target));
  command('azureDevOps.pr.openInBrowser', async (repoName: string, prId: number, project?: string) =>
    vscode.env.openExternal(vscode.Uri.parse(client.webUrl('pr', repoName, prId, at(project).connection.project))));

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
  command('azureDevOps.wi.openInBrowser', async (id: number, project?: string) =>
    vscode.env.openExternal(vscode.Uri.parse(client.webUrl('workItem', id, undefined, at(project).connection.project))));
  mutation('azureDevOps.wi.changeState', (id: number, type: string, project?: string) => changeWorkItemState(at(project), id, type));
  mutation('azureDevOps.wi.assignToMe', async (id: number) => {
    await assignWorkItemToMe(client, id);
    vscode.window.setStatusBarMessage(`$(check) #${id} assigned to you`, 3000);
  });
  mutation('azureDevOps.wi.comment', (id: number, project?: string) => commentOnWorkItem(at(project), id));
  mutation('azureDevOps.wi.create', async () => {
    const id = await createWorkItem(client);
    if (id === undefined) {
      return false;
    }
    WorkItemPanel.show(client, context.extensionUri, id, refresh);
  });
  command('azureDevOps.wi.createBranch', (id: number) => createBranchForWorkItem(client, connections, id));
  mutation('azureDevOps.wi.createFromCode', async (uri?: vscode.Uri, line?: number) =>
    (await createWorkItemFromCode(client, connections, uri instanceof vscode.Uri ? uri : undefined, typeof line === 'number' ? line : undefined)) !== undefined);

  // ----- repositories and wiki -----
  command('azureDevOps.repos.open', () => ReposPanel.show(client, connections, context.extensionUri, refresh));
  command('azureDevOps.wiki.open', () => openWiki(client));

  // ----- pipelines -----
  command('azureDevOps.pipelines.run', (definitionId?: number, project?: string) =>
    RunPipelinePanel.show(at(project), context.extensionUri, typeof definitionId === 'number' ? definitionId : undefined, refresh));
  mutation('azureDevOps.pipelines.rerun', async (definitionId: number, branch: string, project?: string) => {
    const def = await at(project).getDefinition(definitionId);
    return queue(at(project), definitionId, def.name, branch);
  });
  mutation('azureDevOps.pipelines.cancel', async (buildId: number, project?: string) => {
    const ok = await vscode.window.showWarningMessage(`Cancel run ${buildId}?`, { modal: true }, 'Cancel run');
    if (ok !== 'Cancel run') {
      return false;
    }
    await at(project).cancelBuild(buildId);
  });
  command('azureDevOps.pipelines.openRun', (buildId: number, project?: string) =>
    RunViewPanel.show(at(project), context.extensionUri, buildId, refresh));
  command('azureDevOps.pipelines.streamLogs', (buildId: number, title?: string, project?: string) =>
    BuildLogTerminal.show(at(project), buildId, title ?? `Build ${buildId}`));
  command('azureDevOps.pipelines.openLog', async (buildId: number, logId: number, name: string, project?: string) => {
    const uri = makeLogUri(buildId, logId, name, at(project).connection.project);
    if (vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString())) {
      logDocs.refresh(uri);
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'log');
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  mutation('azureDevOps.pipelines.approve', (approvalId: string, status?: 'approved' | 'rejected', project?: string) =>
    answerApproval(at(project), approvalId, status === 'approved' || status === 'rejected' ? status : undefined));
  command('azureDevOps.pipelines.openInBrowser', async (buildId: number, project?: string) =>
    vscode.env.openExternal(vscode.Uri.parse(at(project).webUrl('build', buildId))));
  command('azureDevOps.pipelines.openDefinition', async (definitionId: number, project?: string) =>
    vscode.env.openExternal(vscode.Uri.parse(at(project).webUrl('definition', definitionId))));
  command('azureDevOps.yaml.showTemplates', (uri?: vscode.Uri) => yamlTemplates.showTemplates(uri instanceof vscode.Uri ? uri : undefined));
  command('azureDevOps.yaml.showPreview', async (uri?: vscode.Uri, mode?: PreviewMode) => {
    const doc = uri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!doc) {
      void vscode.window.showInformationMessage('Open an Azure Pipelines YAML file first.');
      return;
    }
    PipelinePreviewPanel.show(yamlTemplates, context.extensionUri, doc, mode === 'local' || mode === 'server' ? mode : undefined);
  });
  command('azureDevOps.yaml.openDesigner', async (uri?: vscode.Uri, line?: number) => {
    const editor = vscode.window.activeTextEditor;
    const doc = uri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
    if (!doc) {
      void vscode.window.showInformationMessage('Open an Azure Pipelines YAML file first.');
      return;
    }
    const cursor = editor?.document.uri.toString() === doc.uri.toString() ? editor.selection.active.line : undefined;
    PipelineDesignerPanel.show(designerHost, context.extensionUri, doc, typeof line === 'number' && Number.isInteger(line) ? line : cursor);
  });
  command('azureDevOps.yaml.refreshTaskCatalog', async () => {
    const snap = await taskCatalog.refresh();
    if (snap.status === 'ready' && snap.index) {
      void vscode.window.showInformationMessage(`Task catalog refreshed: ${plural(snap.index.all().length, 'task')}.`);
    } else if (snap.status === 'empty') {
      void vscode.window.showInformationMessage('Configure an Azure DevOps organization first.');
    } else {
      const why = snap.error ? ` (${snap.error})` : '';
      void vscode.window.showWarningMessage(`Could not read the tasks of the organization${why}. Sign in again, or give the PAT the scope Agent Pools (Read).`);
    }
  });
  command('azureDevOps.yaml.previewPipeline', (uri?: vscode.Uri) => yamlTemplates.previewPipeline(uri instanceof vscode.Uri ? uri : undefined));

  async function queue(api: AdoClient, definitionId: number, name: string, branch: string): Promise<void> {
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    const build = await api.queueBuild(definitionId, ref);
    void vscode.window.showInformationMessage(`Queued ${name} #${build.buildNumber}.`, 'Stream logs').then(choice => {
      if (choice) {
        BuildLogTerminal.show(api, build.id, `${name} #${build.buildNumber}`);
      }
    });
  }

  await connections.resolve();
  void connections.watchGit();
}

export function deactivate(): void {}

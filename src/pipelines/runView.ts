import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { Build, TestRun, TimelineRecord } from '../types';
import { errorMessage, guarded, panelHtml } from '../util';
import { BuildLogTerminal, stripControl } from './logs';
import { parseStageDependencies, stageDependencies, YamlStageDeps } from './stageGraph';
import { buildDto, timelineTree } from './timeline';

/** Expanded YAML stage dependencies per build; a run's YAML never changes, so this is fetched once. */
const yamlCache = new Map<number, Promise<YamlStageDeps | undefined>>();
const YAML_CACHE_SIZE = 50;

/**
 * Run summary like the Azure DevOps stage view: the stage graph with real dependencies, jobs and steps,
 * an inline log viewer (also for finished runs), approvals, test results, stage retries and artifacts.
 */
export class RunViewPanel {
  private static readonly panels = new Map<number, RunViewPanel>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private title = '';
  private wasRunning = false;
  private yamlDeps?: YamlStageDeps;
  private testRuns?: Promise<TestRun[]>;

  static show(client: AdoClient, extensionUri: vscode.Uri, buildId: number, onChange: () => void): void {
    const existing = RunViewPanel.panels.get(buildId);
    if (existing) {
      existing.panel.reveal();
      void existing.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel('azureDevOps.run', `Run ${buildId}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const view = new RunViewPanel(panel, client, buildId, onChange);
    RunViewPanel.panels.set(buildId, view);
    panel.onDidDispose(() => {
      view.disposed = true;
      clearTimeout(view.timer);
      RunViewPanel.panels.delete(buildId);
    });
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'Run', BODY, '', 'runView.js');
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: AdoClient,
    private readonly buildId: number,
    private readonly onChange: () => void,
  ) {
    panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)));
  }

  private get project(): string {
    return this.client.connection.project;
  }

  private post(m: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(m);
    }
  }

  private async handle(m: any): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        await this.load();
        return;
      case 'log':
        await this.sendLog(Number(m.logId), Number(m.have) || 0);
        return;
      case 'openLog':
        await vscode.commands.executeCommand('azureDevOps.pipelines.openLog', this.buildId, m.logId, m.name, this.project);
        return;
      case 'stream':
        BuildLogTerminal.show(this.client, this.buildId, this.title);
        return;
      case 'browser':
        await vscode.env.openExternal(vscode.Uri.parse(this.client.webUrl('build', this.buildId)));
        return;
      case 'cancel':
        await vscode.commands.executeCommand('azureDevOps.pipelines.cancel', this.buildId, this.project);
        await this.load();
        return;
      case 'rerun':
        await vscode.commands.executeCommand('azureDevOps.pipelines.run', m.definitionId, this.project);
        return;
      case 'approve':
        await vscode.commands.executeCommand('azureDevOps.pipelines.approve', String(m.approvalId), undefined, this.project);
        await this.load();
        return;
      case 'retryStage':
        await this.retryStage(String(m.identifier), String(m.name ?? m.identifier));
        return;
      case 'tests':
        await this.sendTestResults(Number(m.runId));
        return;
      case 'artifacts':
        await this.sendArtifacts();
        return;
      case 'download':
        await this.download(String(m.name));
        return;
    }
  }

  /** Fetches run + timeline, pushes them to the page, and keeps polling while the run is active. */
  private async load(): Promise<void> {
    clearTimeout(this.timer);
    try {
      const [build, records] = await Promise.all([
        this.client.getBuild(this.buildId),
        this.client.getTimeline(this.buildId).catch(() => [] as TimelineRecord[]),
      ]);
      if (this.disposed) {
        return;
      }
      const run = buildDto(build);
      this.title = `${run.definitionName} #${run.number}`;
      this.panel.title = this.title;
      const stages = timelineTree(records);
      const running = run.status !== 'completed';
      this.post({
        type: 'data', run, stages, deps: this.deps(stages),
        showTimestamps: vscode.workspace.getConfiguration('azureDevOps').get<boolean>('pipelines.showTimestamps', false),
      });
      if (!this.yamlDeps) {
        void this.loadYaml(build, stages);
      }
      if (!running) {
        void this.sendTestRuns();
      }
      if (running) {
        const seconds = Math.max(5, vscode.workspace.getConfiguration('azureDevOps').get<number>('pipelines.refreshInterval', 10));
        this.timer = setTimeout(() => void this.load(), seconds * 1000);
      } else if (this.wasRunning) {
        this.onChange();
      }
      this.wasRunning = running;
    } catch (e) {
      this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  private deps(stages: ReturnType<typeof timelineTree>): Record<string, string[]> {
    const real = stages.filter(s => s.type === 'Stage');
    if (!real.length) {
      return {};
    }
    const infos = real.map(s => ({ id: s.id, identifier: s.identifier, start: s.start, finish: s.finish }));
    return Object.fromEntries(stageDependencies(infos, this.yamlDeps));
  }

  /** Stage dependencies from the run's expanded YAML; arrives after the first render and redraws the graph. */
  private async loadYaml(build: Build, stages: ReturnType<typeof timelineTree>): Promise<void> {
    if (stages.filter(s => s.type === 'Stage').length < 2) {
      return;
    }
    let p = yamlCache.get(build.id);
    if (!p) {
      p = this.resolveYaml(build);
      yamlCache.set(build.id, p);
      if (yamlCache.size > YAML_CACHE_SIZE) {
        yamlCache.delete(yamlCache.keys().next().value!);
      }
    }
    const deps = await p;
    if (deps && !this.disposed) {
      this.yamlDeps = deps;
      this.post({ type: 'deps', deps: this.deps(stages) });
    }
  }

  private async resolveYaml(build: Build): Promise<YamlStageDeps | undefined> {
    const defId = build.definition.id;
    try {
      // Preferred: the server expands templates exactly as for the run.
      const run = await this.client.getPipelineRun(defId, build.id);
      const self = run.resources?.repositories?.self;
      const yaml = await this.client.previewPipeline(defId, self?.refName ?? build.sourceBranch, self?.version ?? build.sourceVersion, run.templateParameters);
      const deps = parseStageDependencies(yaml);
      if (deps) {
        return deps;
      }
    } catch { /* classic pipeline, or preview not possible: try the file itself */ }
    try {
      const def = await this.client.getDefinition(defId);
      if (def.process?.type !== 2 || def.repository?.type !== 'TfsGit' || !def.repository.id || !def.process.yamlFilename || !build.sourceVersion) {
        return undefined;
      }
      return parseStageDependencies(await this.client.getFileTextAtCommit(def.repository.id, def.process.yamlFilename, build.sourceVersion));
    } catch {
      return undefined;
    }
  }

  /** Log lines from `have` on; finished logs are complete, running ones are fetched again by the page. */
  private async sendLog(logId: number, have: number): Promise<void> {
    try {
      const lines = await this.client.getLogLines(this.buildId, logId);
      this.post({ type: 'log', logId, from: Math.min(have, lines.length), lines: lines.slice(have).map(stripControl), total: lines.length });
    } catch (e) {
      this.post({ type: 'log', logId, error: errorMessage(e) });
    }
  }

  private async retryStage(identifier: string, name: string): Promise<void> {
    const pick = await vscode.window.showWarningMessage(`Run stage "${name}" again?`, { modal: true, detail: 'Failed and canceled jobs run again; succeeded jobs keep their results.' },
      'Rerun failed jobs', 'Rerun all jobs');
    if (!pick) {
      return;
    }
    await this.client.retryStage(this.buildId, identifier, pick === 'Rerun all jobs');
    this.testRuns = undefined;
    vscode.window.setStatusBarMessage(`$(sync) Stage ${name} queued again`, 3000);
    this.onChange();
    await this.load();
  }

  private async sendTestRuns(): Promise<void> {
    this.testRuns ??= this.client.listTestRuns(this.buildId).catch(() => [] as TestRun[]);
    const runs = await this.testRuns;
    this.post({
      type: 'testRuns',
      runs: runs.map(r => {
        const total = r.totalTests ?? 0;
        const passed = r.passedTests ?? 0;
        const other = (r.notApplicableTests ?? 0) + (r.incompleteTests ?? 0);
        return { id: r.id, name: r.name, total, passed, failed: Math.max(0, total - passed - other), other };
      }),
    });
  }

  private async sendTestResults(runId: number): Promise<void> {
    try {
      const results = await this.client.listFailedTestResults(runId);
      this.post({
        type: 'testResults', runId,
        results: results.map(r => ({
          id: r.id, name: r.testCaseTitle ?? r.automatedTestName ?? `Test ${r.id}`, fullName: r.automatedTestName,
          error: r.errorMessage, stack: r.stackTrace, duration: r.durationInMs,
        })),
      });
    } catch (e) {
      this.post({ type: 'testResults', runId, error: errorMessage(e) });
    }
  }

  private async sendArtifacts(): Promise<void> {
    try {
      const list = await this.client.listArtifacts(this.buildId);
      this.post({ type: 'artifacts', items: list.map(a => ({ name: a.name, type: a.resource?.type, downloadable: !!a.resource?.downloadUrl })) });
    } catch (e) {
      this.post({ type: 'artifacts', error: errorMessage(e) });
    }
  }

  private async download(name: string): Promise<void> {
    const artifact = (await this.client.listArtifacts(this.buildId)).find(a => a.name === name);
    const url = artifact?.resource?.downloadUrl;
    if (!url) {
      throw new Error(`Artifact "${name}" cannot be downloaded.`);
    }
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      title: `Download artifact ${name}`,
      defaultUri: base ? vscode.Uri.joinPath(base, `${name.replace(/[\\/:*?"<>|]/g, '_')}.zip`) : undefined,
      filters: { 'Zip archive': ['zip'] },
    });
    if (!target) {
      return;
    }
    if (target.scheme !== 'file') {
      throw new Error('Artifacts can only be saved to a local folder.');
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${name}…` },
      () => this.client.downloadTo(url, target.fsPath));
    const pick = await vscode.window.showInformationMessage(`Downloaded ${name}.`, 'Reveal');
    if (pick) {
      await vscode.commands.executeCommand('revealFileInOS', target);
    }
  }
}

const BODY = `<div id="root" class="rv">
  <header id="head" class="rv-head"><div class="loading"><div class="spinner"></div></div></header>
  <div id="graphWrap" class="graph-wrap" hidden><div id="graph" class="graph"></div></div>
  <div id="empty" class="rv-empty" hidden></div>
  <div class="rv-body">
    <section id="jobs" class="jobs"></section>
    <section id="log" class="logpane" hidden></section>
  </div>
  <section id="tests" class="tests" hidden></section>
</div>`;

import * as vscode from 'vscode';
import { AdoClient } from '../client';
import { TimelineRecord } from '../types';
import { duration, errorMessage } from '../util';

export const LOG_SCHEME = 'ado-log';

const ESC = '\x1b[';
const C = { reset: `${ESC}0m`, dim: `${ESC}2m`, bold: `${ESC}1m`, red: `${ESC}31m`, green: `${ESC}32m`, yellow: `${ESC}33m`, blue: `${ESC}34m`, magenta: `${ESC}35m`, cyan: `${ESC}36m`, gray: `${ESC}90m` };

const TIMESTAMP = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?/;

function showTimestamps(): boolean {
  return vscode.workspace.getConfiguration('azureDevOps').get<boolean>('pipelines.showTimestamps', false);
}

/** Plain-text log line for the read-only log document. */
export function plainLine(raw: string): string {
  return showTimestamps() ? raw : raw.replace(TIMESTAMP, '');
}

/**
 * Build output is controlled by whoever can push code that runs in the pipeline. Keep color codes,
 * drop every other control sequence (OSC links/titles, cursor movement, C1 controls) before it reaches the terminal.
 */
export function stripControl(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x1b) {
      // Keep "ESC[...m" (colors) only.
      if (COLOR_SEQUENCE.test(raw.slice(i + 1, i + 24))) {
        out += raw[i];
      }
    } else if (!isControl(c)) {
      out += raw[i];
    }
  }
  return out;
}

const COLOR_SEQUENCE = /^\[[0-9;]*m/;

/** C0 and C1 control characters except tab and line feed. */
function isControl(c: number): boolean {
  return c <= 0x08 || (c >= 0x0b && c <= 0x1f) || (c >= 0x7f && c <= 0x9f);
}

/** ANSI-colored log line for the live terminal; returns undefined for lines that should be hidden. */
export function ansiLine(input: string): string | undefined {
  const raw = stripControl(input);
  const m = TIMESTAMP.exec(raw);
  let line = m ? raw.slice(m[0].length) : raw;
  const ts = m && showTimestamps() ? `${C.gray}${m[1].substring(11, 19)}${C.reset} ` : '';
  const tag = /^##\[(\w+)\]/.exec(line);
  if (tag) {
    line = line.slice(tag[0].length);
    switch (tag[1]) {
      case 'section': return ts + `${C.magenta}${C.bold}${line}${C.reset}`;
      case 'error': return ts + `${C.red}✖ ${line}${C.reset}`;
      case 'warning': return ts + `${C.yellow}⚠ ${line}${C.reset}`;
      case 'command': return ts + `${C.blue}${line}${C.reset}`;
      case 'debug': return ts + `${C.dim}${line}${C.reset}`;
      case 'group': return ts + `${C.cyan}▸ ${line}${C.reset}`;
      case 'endgroup': return undefined;
    }
  }
  return ts + line;
}

export function recordPath(rec: TimelineRecord, byId: Map<string, TimelineRecord>): string {
  const parts: string[] = [];
  for (let r: TimelineRecord | undefined = rec; r; r = r.parentId ? byId.get(r.parentId) : undefined) {
    if (r.type !== 'Phase' && r.name !== '__default') {
      parts.unshift(r.name);
    }
  }
  return parts.join(' › ');
}

export function makeLogUri(buildId: number, logId: number, name: string, project?: string): vscode.Uri {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  const query = new URLSearchParams({ build: String(buildId), log: String(logId), ...(project ? { project } : {}) }).toString();
  return vscode.Uri.from({ scheme: LOG_SCHEME, path: `/Build ${buildId}/${safe}.log`, query });
}

/** Read-only documents for single step logs, so the editor's search, folding and selection work on them. */
export class LogDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly client: AdoClient) {}

  /** Loads an already open log again (it may have grown since). */
  refresh(uri: vscode.Uri): void {
    this.changed.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const p = new URLSearchParams(uri.query);
    const lines = await this.client.forProject(p.get('project') ?? undefined).getLogLines(Number(p.get('build')), Number(p.get('log')));
    return lines.map(plainLine).join('\n');
  }
}

const RESULT_STYLE: Record<string, [string, string]> = {
  succeeded: [C.green, '✔'], succeededWithIssues: [C.yellow, '⚠'], partiallySucceeded: [C.yellow, '⚠'],
  failed: [C.red, '✖'], canceled: [C.gray, '⊘'], skipped: [C.gray, '↷'], abandoned: [C.gray, '⊘'],
};

/**
 * Streams a build's console output into a terminal. Azure DevOps uploads step logs as the agent
 * flushes them, so the timeline and the log line counts are polled and only new lines are printed.
 */
export class BuildLogTerminal implements vscode.Pseudoterminal {
  private static readonly open = new Map<number, vscode.Terminal>();
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private closed = false;
  private readonly printed = new Map<number, number>();
  private readonly started = new Set<string>();
  private readonly finished = new Set<string>();
  private lastHeader?: string;
  private gracePolls = 0;

  static show(client: AdoClient, buildId: number, title: string): void {
    const existing = BuildLogTerminal.open.get(buildId);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      return;
    }
    const pty = new BuildLogTerminal(client, buildId, title);
    const terminal = vscode.window.createTerminal({ name: `⚡ ${title}`, pty, iconPath: new vscode.ThemeIcon('rocket') });
    BuildLogTerminal.open.set(buildId, terminal);
    terminal.show();
  }

  private constructor(private readonly client: AdoClient, private readonly buildId: number, private readonly title: string) {}

  open(): void {
    this.write(`${C.bold}${C.cyan}${this.title}${C.reset}  ${C.gray}(build ${this.buildId} — live, close the terminal to stop)${C.reset}`);
    void this.loop();
  }

  close(): void {
    this.closed = true;
    BuildLogTerminal.open.delete(this.buildId);
  }

  private write(line: string): void {
    this.writeEmitter.fire(line.replace(/\r?\n/g, '\r\n') + '\r\n');
  }

  private header(path: string): void {
    if (this.lastHeader !== path) {
      this.write('');
      this.write(`${C.bold}${C.cyan}━━ ${path} ${C.reset}`);
      this.lastHeader = path;
    }
  }

  private async loop(): Promise<void> {
    const interval = () => vscode.workspace.getConfiguration('azureDevOps').get<number>('pipelines.logPollInterval', 3) * 1000;
    let failures = 0;
    while (!this.closed) {
      try {
        const done = await this.poll();
        failures = 0;
        if (done) {
          return;
        }
      } catch (e) {
        if (++failures >= 5) {
          this.write(`${C.red}Stopped streaming: ${errorMessage(e)}${C.reset}`);
          return;
        }
      }
      await new Promise(r => setTimeout(r, interval()));
    }
  }

  private announceStart(step: TimelineRecord, path: string): void {
    if (this.started.has(step.id)) {
      return;
    }
    this.started.add(step.id);
    if (step.state === 'inProgress') {
      this.header(path);
      this.write(`${C.gray}▶ started${C.reset}`);
    }
  }

  /** Prints the lines of a step's log that are new since the last poll. */
  private async printNewLines(step: TimelineRecord, logId: number, path: string, available: number): Promise<void> {
    const have = this.printed.get(logId) ?? 0;
    const mustFetch = available > have || (step.state === 'completed' && !this.finished.has(step.id) && have === 0);
    if (!mustFetch) {
      return;
    }
    const lines = await this.client.getLogLines(this.buildId, logId);
    if (lines.length > have) {
      this.header(path);
      for (const raw of lines.slice(have)) {
        const out = ansiLine(raw);
        if (out !== undefined) {
          this.write(out);
        }
      }
    }
    this.printed.set(logId, Math.max(have, lines.length));
  }

  private announceFinish(step: TimelineRecord, path: string): void {
    if (step.state !== 'completed' || this.finished.has(step.id) || (!step.log && step.result !== 'skipped')) {
      return;
    }
    this.finished.add(step.id);
    if (step.result !== 'skipped') {
      const [color, icon] = RESULT_STYLE[step.result ?? ''] ?? [C.gray, '•'];
      this.header(path);
      this.write(`${color}${icon} ${step.result} ${C.gray}(${duration(step.startTime, step.finishTime)})${C.reset}`);
    }
  }

  /** Returns true once the build has completed and every log has been printed. */
  private async poll(): Promise<boolean> {
    const [build, records, logs] = await Promise.all([
      this.client.getBuild(this.buildId),
      this.client.getTimeline(this.buildId),
      this.client.getBuildLogs(this.buildId).catch(() => []),
    ]);
    const lineCounts = new Map(logs.map(l => [l.id, l.lineCount ?? 0]));
    const byId = new Map(records.map(r => [r.id, r]));
    const steps = records
      .filter(r => r.type === 'Task' && r.state !== 'pending')
      .sort((a, b) => (a.startTime ?? '9999').localeCompare(b.startTime ?? '9999') || (a.order ?? 0) - (b.order ?? 0));

    let pendingLogs = false;
    for (const step of steps) {
      if (this.closed) {
        return true;
      }
      const path = recordPath(step, byId);
      this.announceStart(step, path);
      if (step.log) {
        await this.printNewLines(step, step.log.id, path, lineCounts.get(step.log.id) ?? 0);
      } else if (step.state === 'completed' && step.result !== 'skipped') {
        pendingLogs = true;
      }
      this.announceFinish(step, path);
    }

    // Steps that were cancelled may never get a log; don't wait for them forever.
    if (build.status === 'completed' && (!pendingLogs || ++this.gracePolls > 5)) {
      const [color, icon] = RESULT_STYLE[build.result ?? ''] ?? [C.gray, '•'];
      this.write('');
      this.write(`${C.bold}${color}${icon} Build ${build.result} ${C.reset}${C.gray}in ${duration(build.startTime, build.finishTime)}${C.reset}`);
      return true;
    }
    return false;
  }
}

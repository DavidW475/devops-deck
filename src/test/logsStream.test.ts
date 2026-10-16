import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AdoClient } from '../client';
import { ansiLine, BuildLogTerminal, LOG_SCHEME, LogDocumentProvider, makeLogUri, plainLine } from '../pipelines/logs';
import { Build, BuildLog, TimelineRecord } from '../types';
import * as vscode from './vscodeStub';

interface Poll { build: Partial<Build>; records: TimelineRecord[]; logs: BuildLog[] }

/** A client that answers each poll from the next entry of `polls` (the last one repeats) and serves log lines by id. */
function fakeClient(polls: Poll[], lines: Record<number, string[]>, fail?: Error) {
  let n = 0;
  const current = () => polls[Math.min(n, polls.length - 1)];
  const lineRequests: number[] = [];
  const client = {
    getBuild: async () => {
      if (fail) {
        throw fail;
      }
      return current().build;
    },
    getTimeline: async () => current().records,
    getBuildLogs: async () => {
      const logs = current().logs;
      n++;
      return logs;
    },
    getLogLines: async (_build: number, id: number) => {
      lineRequests.push(id);
      return lines[id] ?? [];
    },
  };
  return { client: client as unknown as AdoClient, lineRequests };
}

interface Pty { open(): void; close(): void; onDidWrite(l: (s: string) => void): unknown }

/** Opens the terminal of `buildId` and collects its output until `until` matches (or 200 turns pass). */
async function stream(client: AdoClient, buildId: number, until: RegExp): Promise<{ text: string; pty: Pty }> {
  BuildLogTerminal.show(client, buildId, 'CI #20261016.1');
  const pty = (vscode.terminals.at(-1)!.options as { pty: Pty }).pty;
  let text = '';
  pty.onDidWrite(s => { text += s; });
  pty.open();
  for (let i = 0; i < 200 && !until.test(text); i++) {
    await new Promise(r => setTimeout(r, 1));
  }
  pty.close();
  return { text, pty };
}

const step = (id: string, extra: Partial<TimelineRecord>): TimelineRecord => ({ id, parentId: 'job', type: 'Task', name: id, ...extra });
const JOB: TimelineRecord = { id: 'job', type: 'Job', name: 'Build' };

describe('pipeline log streaming', () => {
  beforeEach(() => {
    vscode.reset();
    vscode.settings['azureDevOps.pipelines.logPollInterval'] = 0;
  });

  it('prints new lines per step, step results and the build result', async () => {
    const start = '2026-10-16T10:00:00Z';
    const { client, lineRequests } = fakeClient([
      {
        build: { status: 'inProgress' },
        records: [JOB, step('restore', { state: 'inProgress', startTime: start, log: { id: 1 } }), step('later', { state: 'pending' })],
        logs: [{ id: 1, lineCount: 1 }],
      },
      {
        build: { status: 'completed', result: 'succeeded', startTime: start, finishTime: '2026-10-16T10:02:05Z' },
        records: [
          JOB,
          step('restore', { state: 'completed', result: 'succeeded', startTime: start, finishTime: '2026-10-16T10:00:30Z', log: { id: 1 } }),
          step('lint', { state: 'completed', result: 'skipped', startTime: '2026-10-16T10:01:00Z' }),
          step('test', { state: 'completed', result: 'failed', startTime: '2026-10-16T10:01:00Z', order: 2, log: { id: 2 } }),
        ],
        logs: [{ id: 1, lineCount: 2 }, { id: 2 }],
      },
    ], { 1: ['npm ci', '##[endgroup]', 'added 12 packages'], 2: ['##[error]1 test failed'] });

    const { text } = await stream(client, 99, /Build succeeded/);
    assert.match(text, /CI #20261016\.1/);
    assert.match(text, /━━ Build › restore/);
    assert.match(text, /▶ started/);
    assert.equal(text.match(/npm ci/g)?.length, 1, 'lines are printed once');
    assert.match(text, /added 12 packages/);
    assert.match(text, /✔ succeeded .*\(30s\)/);
    assert.match(text, /✖ 1 test failed/);
    assert.match(text, /✖ failed/);
    assert.doesNotMatch(text, /skipped/);
    assert.match(text, /Build succeeded .*in 2m 5s/);
    assert.ok(text.includes('\r\n'));
    assert.ok(lineRequests.includes(2), 'a finished step without line count is fetched');
  });

  it('stops waiting for logs of cancelled steps after a few polls', async () => {
    const { client } = fakeClient([{
      build: { status: 'completed', result: 'canceled' },
      records: [step('deploy', { state: 'completed', result: 'canceled' })],
      logs: [],
    }], {});
    const { text } = await stream(client, 100, /Build canceled/);
    assert.match(text, /⊘ Build canceled/);
  });

  it('gives up after repeated failures', async () => {
    const { client } = fakeClient([{ build: {}, records: [], logs: [] }], {}, new Error('TF400813: not authorized'));
    const { text } = await stream(client, 101, /Stopped streaming/);
    assert.match(text, /Stopped streaming: TF400813: not authorized/);
  });

  it('reuses the open terminal of a build', () => {
    const { client } = fakeClient([{ build: { status: 'inProgress' }, records: [], logs: [] }], {});
    BuildLogTerminal.show(client, 102, 'CI');
    BuildLogTerminal.show(client, 102, 'CI');
    assert.equal(vscode.terminals.length, 1);
    assert.equal(vscode.terminals[0].shown, 2);
    const pty = (vscode.terminals[0].options as { pty: Pty }).pty;
    pty.close();
    BuildLogTerminal.show(client, 102, 'CI');
    assert.equal(vscode.terminals.length, 2, 'a closed terminal is replaced');
    (vscode.terminals[1].options as { pty: Pty }).pty.close();
  });

  it('ansiLine shows timestamps when enabled and styles more tags', () => {
    vscode.settings['azureDevOps.pipelines.showTimestamps'] = true;
    assert.match(ansiLine('2026-01-01T10:11:12.5Z ##[section]Starting')!, /10:11:12.*Starting/);
    assert.match(ansiLine('##[command]npm test')!, /npm test/);
    assert.match(ansiLine('##[debug]details')!, /details/);
    assert.equal(ansiLine('##[unknown]text'), 'text');
    assert.equal(plainLine('2026-01-01T10:11:12Z hello'), '2026-01-01T10:11:12Z hello');
    vscode.settings['azureDevOps.pipelines.showTimestamps'] = false;
    assert.equal(plainLine('﻿2026-01-01T10:11:12Z hello'), 'hello');
  });

  it('makeLogUri names the document after the step and keeps the project', () => {
    const uri = makeLogUri(99, 4, 'Build: a/b', 'Fabrikam Shop');
    assert.equal(uri.scheme, LOG_SCHEME);
    assert.equal(uri.path, '/Build 99/Build_ a_b.log');
    const q = new URLSearchParams(uri.query);
    assert.deepEqual([q.get('build'), q.get('log'), q.get('project')], ['99', '4', 'Fabrikam Shop']);
    assert.equal(new URLSearchParams(makeLogUri(1, 2, 'x').query).has('project'), false);
  });

  it('LogDocumentProvider loads the log of the URI\'s project and fires refreshes', async () => {
    const seen: unknown[] = [];
    const client = {
      forProject: (p?: string) => {
        seen.push(p);
        return { getLogLines: async (b: number, l: number) => [`2026-01-01T00:00:00Z build ${b}`, `log ${l}`] };
      },
    } as unknown as AdoClient;
    const provider = new LogDocumentProvider(client);
    assert.equal(await provider.provideTextDocumentContent(makeLogUri(99, 4, 'x', 'Northwind') as never), 'build 99\nlog 4');
    await provider.provideTextDocumentContent(makeLogUri(99, 4, 'x') as never);
    assert.deepEqual(seen, ['Northwind', undefined]);
    const fired: unknown[] = [];
    provider.onDidChange(u => fired.push(u));
    const uri = makeLogUri(1, 1, 'y');
    provider.refresh(uri as never);
    assert.deepEqual(fired, [uri]);
  });
});

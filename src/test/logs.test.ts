import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ansiLine, recordPath, stripControl } from '../pipelines/logs';
import { TimelineRecord } from '../types';

describe('pipeline logs', () => {
  it('stripControl keeps colors but drops other escape sequences and control characters', () => {
    assert.equal(stripControl('\x1b[31mred\x1b[0m'), '\x1b[31mred\x1b[0m');
    assert.equal(stripControl('a\x1b]8;;https://evil\x07link\x1b]8;;\x07b'), 'a]8;;https://evillink]8;;b');
    assert.equal(stripControl('x\x1b[2Jy\x00z'), 'x[2Jyz');
  });

  it('ansiLine hides timestamps by default and styles ##[...] tags', () => {
    assert.equal(ansiLine('2026-01-01T10:00:00.1234567Z hello'), 'hello');
    assert.match(ansiLine('##[error]Build failed')!, /✖ Build failed/);
    assert.match(ansiLine('##[warning]careful')!, /⚠ careful/);
    assert.match(ansiLine('##[group]Restore')!, /▸ Restore/);
    assert.equal(ansiLine('##[endgroup]'), undefined);
  });

  it('recordPath joins names and skips phases and the default stage', () => {
    const recs: TimelineRecord[] = [
      { id: 's', type: 'Stage', name: '__default' },
      { id: 'p', parentId: 's', type: 'Phase', name: 'Phase 1' },
      { id: 'j', parentId: 'p', type: 'Job', name: 'Build' },
      { id: 't', parentId: 'j', type: 'Task', name: 'npm ci' },
    ];
    const byId = new Map(recs.map(r => [r.id, r]));
    assert.equal(recordPath(recs[3], byId), 'Build › npm ci');
  });
});

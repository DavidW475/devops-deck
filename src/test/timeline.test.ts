import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDto, timelineTree } from '../pipelines/timeline';
import { Build, TimelineRecord } from '../types';

describe('timeline', () => {
  it('buildDto shortens branches and pull request refs', () => {
    const b: Build = { id: 1, buildNumber: '20260101.1', status: 'completed', result: 'succeeded', definition: { id: 7, name: 'CI' },
      sourceBranch: 'refs/pull/42/merge', sourceVersion: '0123456789abcdef' };
    const dto = buildDto(b);
    assert.equal(dto.branch, 'PR 42');
    assert.equal(dto.commit, '01234567');
    assert.equal(buildDto({ ...b, sourceBranch: 'refs/heads/main' }).branch, 'main');
  });

  it('timelineTree nests stage → job → task, flattens phases and sorts by order', () => {
    const recs: TimelineRecord[] = [
      { id: 's1', type: 'Stage', name: 'Build', order: 1 },
      { id: 'p1', parentId: 's1', type: 'Phase', name: 'Phase', order: 1 },
      { id: 'j1', parentId: 'p1', type: 'Job', name: 'Compile', order: 1 },
      { id: 't2', parentId: 'j1', type: 'Task', name: 'Second', order: 2 },
      { id: 't1', parentId: 'j1', type: 'Task', name: 'First', order: 1, log: { id: 9 },
        issues: [{ type: 'error', message: 'e1' }, { type: 'warning', message: 'w' }] },
    ];
    const [stage] = timelineTree(recs);
    assert.equal(stage.name, 'Build');
    const [job] = stage.children;
    assert.equal(job.name, 'Compile');
    assert.deepEqual(job.children.map(t => t.name), ['First', 'Second']);
    assert.equal(job.children[0].logId, 9);
    assert.deepEqual(job.children[0].errors, ['e1']);
  });

  it('timelineTree hides the implicit __default stage and marks stages waiting for approval', () => {
    const recs: TimelineRecord[] = [
      { id: 's', type: 'Stage', name: '__default' },
      { id: 'j', parentId: 's', type: 'Job', name: 'Only job' },
      { id: 'prod', type: 'Stage', name: 'Production', state: 'pending' },
      { id: 'cp', parentId: 'prod', type: 'Checkpoint', name: 'Checkpoint', state: 'inProgress' },
    ];
    const nodes = timelineTree(recs);
    assert.deepEqual(nodes.map(n => n.name), ['Only job', 'Production']);
    assert.equal(nodes[1].waiting, true);
    assert.deepEqual(nodes[1].children, [], 'checkpoints are not shown');
  });
});

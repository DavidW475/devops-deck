import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeCommits, titleFromBranch, workItemIdsFromBranch, workItemIdsFromText } from '../git';
import { loadByPerson, sprintStructure, workingDays } from '../workItems/sprint';
import { isTodoLine, titleFromCode } from '../workItems/wiCommands';
import { editableFields, hierarchyOf, historyEntries, joinTags, relationId, splitTags } from '../workItems/wiModel';
import { flattenPages } from '../wiki/wiki';

describe('git helpers', () => {
  it('finds work item ids in branch names and commit messages', () => {
    assert.deepEqual(workItemIdsFromBranch('feature/1234-login'), [1234]);
    assert.deepEqual(workItemIdsFromBranch('users/ana/42_fix-77'), [42, 77]);
    assert.deepEqual(workItemIdsFromBranch('release/v2'), []);
    assert.deepEqual(workItemIdsFromText('Fix crash #12, see AB#345 and (#6)'), [12, 345, 6]);
    assert.deepEqual(workItemIdsFromText('color: #fff'), []);
  });

  it('suggests a PR title and description', () => {
    assert.equal(titleFromBranch('feature/1234-fix-login_page'), 'Fix login page');
    assert.deepEqual(describeCommits('feature/x', ['Add export\n\nCSV and JSON']), { title: 'Add export', description: 'CSV and JSON' });
    assert.deepEqual(describeCommits('feature/1-add-export', ['Second', 'First']), { title: 'Add export', description: '- First\n- Second' });
  });
});

describe('work item from code', () => {
  it('takes the TODO text without comment markers', () => {
    assert.equal(titleFromCode('  // TODO: handle Contoso timeouts'), 'handle Contoso timeouts');
    assert.equal(titleFromCode('# FIXME(ana): retry'), 'retry');
    assert.equal(titleFromCode('/* HACK remove after migration */'), 'remove after migration');
    assert.equal(titleFromCode('const x = 1;'), 'const x = 1;');
    assert.ok(isTodoLine('// TODO: x'));
    assert.ok(!isTodoLine('const todo = "TODO";'));
    assert.ok(!isTodoLine('// fix the bug in the parser'), 'lower-case words are not tags');
    assert.ok(!isTodoLine('i--; const BUG = x;'), 'the tag must start the comment');
    assert.ok(isTodoLine('x = 1; # TODO tune'));
    assert.ok(isTodoLine(' * FIXME: later'));
  });
});

describe('work item model', () => {
  const rel = (r: string, id: number) => ({ rel: r, url: `https://dev.azure.com/contoso/_apis/wit/workItems/${id}` });
  it('reads the hierarchy from relations', () => {
    const w = { id: 1, rev: 1, fields: {}, relations: [rel('System.LinkTypes.Hierarchy-Reverse', 7), rel('System.LinkTypes.Hierarchy-Forward', 8),
      rel('System.LinkTypes.Hierarchy-Forward', 9), rel('System.LinkTypes.Related', 10), { rel: 'ArtifactLink', url: 'vstfs:///Git/Commit/x' }] };
    assert.deepEqual(hierarchyOf(w), { parent: 7, children: [8, 9], related: [10] });
    assert.equal(relationId('vstfs:///Git/Commit/x'), undefined);
  });

  it('offers only the planning fields a type has', () => {
    const fields = editableFields([
      { referenceName: 'Microsoft.VSTS.Common.Priority', name: 'Priority', allowedValues: ['1', '2', '3', '4'] },
      { referenceName: 'Microsoft.VSTS.Scheduling.RemainingWork', name: 'Remaining Work' },
      { referenceName: 'System.Title', name: 'Title' },
    ]);
    assert.deepEqual(fields.map(f => [f.ref, f.kind]), [['Microsoft.VSTS.Common.Priority', 'choice'], ['Microsoft.VSTS.Scheduling.RemainingWork', 'number']]);
  });

  it('normalizes tags', () => {
    assert.deepEqual(splitTags('a; b ;;c'), ['a', 'b', 'c']);
    assert.equal(joinTags(['a', ' b', 'a', '']), 'a; b');
  });

  it('builds a readable history without noise fields', () => {
    const h = historyEntries([
      { id: 1, rev: 1, revisedBy: { id: 'u', displayName: 'Ana' }, fields: { 'System.Rev': { newValue: 1 }, 'System.State': { newValue: 'New' } } },
      { id: 2, rev: 2, revisedBy: { id: 'u', displayName: 'Ana' }, fields: { 'System.ChangedDate': { newValue: '2026-01-01' } } },
      { id: 3, rev: 3, revisedBy: { id: 'v', displayName: 'Ben' }, fields: { 'System.AssignedTo': { oldValue: { displayName: 'Ana' }, newValue: { displayName: 'Ben' } } },
        relations: { added: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://x/_apis/wit/workItems/5' }] } },
    ]);
    assert.equal(h.length, 2, 'the revision with only noise is left out');
    assert.equal(h[0].by, 'Ben');
    assert.deepEqual(h[0].changes, [{ field: 'Assigned to', from: 'Ana', to: 'Ben' }]);
    assert.deepEqual(h[0].links, ['Added parent #5']);
    assert.deepEqual(h[1].changes, [{ field: 'State', from: '∅', to: 'New' }]);
  });
});

describe('sprint', () => {
  it('counts working days without weekends and days off', () => {
    // 2026-03-02 is a Monday.
    assert.equal(workingDays('2026-03-02', '2026-03-13'), 10);
    assert.equal(workingDays('2026-03-02', '2026-03-13', [{ start: '2026-03-04', end: '2026-03-05' }]), 8);
    assert.equal(workingDays('2026-03-07', '2026-03-08'), 0);
  });

  it('reads parents from the iteration links', () => {
    const { ids, parentOf } = sprintStructure([
      { rel: null, source: null, target: { id: 1 } },
      { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 1 }, target: { id: 2 } },
      { rel: null, source: null, target: { id: 3 } },
    ]);
    assert.deepEqual(ids, [1, 2, 3]);
    assert.equal(parentOf.get(2), 1);
    assert.equal(parentOf.has(3), false);
  });

  it('compares remaining work with capacity', () => {
    const load = loadByPerson(
      [{ assignedTo: 'Ana', remaining: 10, done: false }, { assignedTo: 'Ana', remaining: 4, done: true }, { remaining: 3, done: false }],
      [{ teamMember: { id: 'a', displayName: 'Ana' }, activities: [{ capacityPerDay: 6 }], daysOff: [] }],
      [], new Date('2026-03-12T09:00:00Z'), '2026-03-13');
    assert.deepEqual(load, [{ name: 'Ana', remaining: 10, capacity: 12 }, { name: 'Unassigned', remaining: 3 }]);
  });
});

describe('wiki', () => {
  it('flattens the page tree in wiki order', () => {
    assert.deepEqual(flattenPages({ path: '/', subPages: [
      { path: '/B', order: 1, subPages: [{ path: '/B/Child', order: 0 }] },
      { path: '/A', order: 0 },
    ] }), ['/A', '/B', '/B/Child']);
  });
});

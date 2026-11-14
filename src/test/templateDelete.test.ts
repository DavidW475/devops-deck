import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskInfo, TaskInput } from '../pipelines/taskModel';
import { asTemplateRef, findTaskSteps, toParameter } from '../pipelines/taskRefs';
import { applyLineEdits, callReadOnlyReason, deleteLines, normalizeEdits, planCallEdits, planDisplayName } from '../pipelines/templateEdits';
import { scanYaml } from '../pipelines/templateRefs';

const field: TaskInput = {
  name: 'a', yamlName: 'a', aliases: [], label: 'a', required: false, type: 'string', options: [], editable: false, multi: false,
};
const task: TaskInfo = {
  id: '00000000-0000-0000-0000-000000000001', name: 'T', title: 'T', description: '', category: 'Deploy', major: 1, version: '1.0.0',
  deprecated: false, preview: false, groups: [], inputs: [field],
};

const clearName = (yaml: string) => applyLineEdits(yaml, planDisplayName(yaml, findTaskSteps(yaml)[0], '')).text;
const clearInputs = (yaml: string) => {
  const step = findTaskSteps(yaml)[0];
  const edits = planCallEdits(yaml, asTemplateRef(step, task), [toParameter(field)], { a: '' }, { writeDefaults: false }, 'inputs').edits;
  return applyLineEdits(yaml, edits).text;
};

describe('deleting the first key of a list item keeps the dash', () => {
  it('moves the dash to the next key when Display name is cleared', () => {
    assert.equal(clearName('steps:\n- displayName: Build\n  task: T@1\n  inputs:\n    a: b'), 'steps:\n- task: T@1\n  inputs:\n    a: b');
  });

  it('keeps a comment line between and works with the dash indented', () => {
    assert.equal(clearName('steps:\n  - displayName: Build\n    # why\n    task: T@1'), 'steps:\n    # why\n  - task: T@1');
  });

  it('keeps a block scalar display name together with its lines out of the result', () => {
    assert.equal(clearName('steps:\n- displayName: >-\n    Build\n  task: T@1'), 'steps:\n- task: T@1');
  });

  it('moves the dash when the inputs key leads and all inputs are removed', () => {
    assert.equal(clearInputs('steps:\n- inputs:\n    a: b\n  task: T@1'), 'steps:\n- task: T@1');
  });

  it('removes a leading inputs key with a comment after it', () => {
    assert.equal(clearInputs('steps:\n- inputs:\n    a: b\n  # note\n  task: T@1'), 'steps:\n  # note\n- task: T@1');
  });

  it('leaves a valid empty item when no key is left', () => {
    const yaml = 'steps:\n- displayName: Build\n- task: T@1';
    assert.equal(applyLineEdits(yaml, deleteLines(yaml.split('\n'), scanYaml(yaml), 1, 1)).text, 'steps:\n- {}\n- task: T@1');
  });

  it('leaves a valid empty item when the edits leave no key line at all', () => {
    const yaml = 'steps:\n- displayName: Build';
    assert.equal(applyLineEdits(yaml, [{ line: 1, deleteCount: 1, insert: [], dash: { indent: 0, keyCol: 2 } }]).text, 'steps:\n- {}');
  });

  it('still deletes a plain key line', () => {
    assert.equal(clearName('steps:\n- task: T@1\n  displayName: Build\n  inputs:\n    a: b'), 'steps:\n- task: T@1\n  inputs:\n    a: b');
  });
});

describe('moving the dash of a deleted first key', () => {
  const dash = { indent: 0, keyCol: 2 };
  const marks = (r: { marks: Map<number, string> }) => [...r.marks.entries()];

  it('leaves comment and blank lines on the way unmarked and unwritten', () => {
    const yaml = 'steps:\n- displayName: gone\n  # note\n\n  task: B@1';
    const edits = [{ line: 1, deleteCount: 1, insert: [], dash }];
    const r = applyLineEdits(yaml, edits);
    assert.equal(r.text, 'steps:\n  # note\n\n- task: B@1');
    assert.deepEqual(marks(r), [[3, '~']]);
    assert.deepEqual(normalizeEdits(edits, yaml.split('\n')), [
      { line: 1, deleteCount: 1, insert: [] },
      { line: 4, deleteCount: 1, insert: ['- task: B@1'] },
    ]);
  });

  it('stops at a line left of the keys and writes an empty item', () => {
    const yaml = 'jobs:\n- job: A\n  steps:\n  - displayName: gone\n  pool: x';
    const r = applyLineEdits(yaml, [{ line: 3, deleteCount: 1, insert: [], dash: { indent: 2, keyCol: 4 } }]);
    assert.equal(r.text, 'jobs:\n- job: A\n  steps:\n  - {}\n  pool: x');
  });

  it('stops at the next item behind a comment', () => {
    const yaml = 'steps:\n- displayName: gone\n  # c\n- task: T@1';
    assert.equal(applyLineEdits(yaml, [{ line: 1, deleteCount: 1, insert: [], dash }]).text, 'steps:\n- {}\n  # c\n- task: T@1');
  });

  it('does not hand the dash to an adjacent edit of the previous item', () => {
    const yaml = 'steps:\n- task: A@1\n  displayName: a\n- displayName: gone\n  task: B@1';
    const edits = [{ line: 2, deleteCount: 1, insert: ['  displayName: b'] }, { line: 3, deleteCount: 1, insert: [], dash }];
    assert.equal(applyLineEdits(yaml, edits).text, 'steps:\n- task: A@1\n  displayName: b\n- task: B@1');
  });

  it('puts the dash on a key inserted by a later edit', () => {
    const yaml = 'steps:\n- displayName: gone\n  # c\n  task: A@1';
    const edits = [{ line: 1, deleteCount: 1, insert: [], dash }, { line: 3, deleteCount: 1, insert: ['  task: A@2'] }];
    assert.equal(applyLineEdits(yaml, edits).text, 'steps:\n  # c\n- task: A@2');
  });

  it('writes an empty item when a later edit ends the item', () => {
    const yaml = 'steps:\n- displayName: gone\n  # c\n  task: A@1';
    const edits = [{ line: 1, deleteCount: 1, insert: [], dash }, { line: 3, deleteCount: 1, insert: ['- task: A@2'] }];
    assert.equal(applyLineEdits(yaml, edits).text, 'steps:\n- {}\n  # c\n- task: A@2');
  });

  it('writes an empty item before a line of its own edit that ends the item', () => {
    const yaml = 'steps:\n- displayName: gone';
    const edits = [{ line: 1, deleteCount: 1, insert: ['- task: A@1'], dash }];
    assert.equal(applyLineEdits(yaml, edits).text, 'steps:\n- {}\n- task: A@1');
  });

  it('passes lines of a later edit that neither end the item nor hold a key', () => {
    const yaml = 'steps:\n- displayName: gone\n  # a\n  # b\n  # c\n  task: A@1';
    const edits = [{ line: 1, deleteCount: 1, insert: [], dash }, { line: 3, deleteCount: 1, insert: ['  # B'] }];
    assert.equal(applyLineEdits(yaml, edits).text, 'steps:\n  # a\n  # B\n  # c\n- task: A@1');
  });

  it('joins the dashed line to the edits it touches', () => {
    const yaml = 'steps:\n- displayName: x\n  task: A@1\n  inputs: y';
    const edits = [{ line: 1, deleteCount: 1, insert: [], dash }, { line: 3, deleteCount: 1, insert: ['  inputs: z'] }];
    assert.deepEqual(normalizeEdits(edits, yaml.split('\n')), [{ line: 1, deleteCount: 3, insert: ['- task: A@1', '  inputs: z'] }]);
    const apart = 'steps:\n- displayName: x\n  # c\n  task: A@1\n  inputs: y';
    assert.deepEqual(normalizeEdits(edits.map(e => (e.dash ? e : { ...e, line: 4 })), apart.split('\n')), [
      { line: 1, deleteCount: 1, insert: [] },
      { line: 3, deleteCount: 2, insert: ['- task: A@1', '  inputs: z'] },
    ]);
  });

  it('moves the dash of a following item that a join takes in', () => {
    const yaml = 'steps:\n- a: 1\n  b: 2\n- c: 3\n  d: 4';
    const edits = [{ line: 1, deleteCount: 1, insert: [], dash }, { line: 3, deleteCount: 1, insert: [], dash }];
    assert.equal(applyLineEdits(yaml, edits).text, 'steps:\n- b: 2\n- d: 4');
  });

  it('keeps the dash position of a later edit when the dashed line is joined in front of it', () => {
    const yaml = 'steps:\n- a: 1\n  # c\n  b: 2\n- c: 3\n  d: 4';
    const edits = [{ line: 1, deleteCount: 1, insert: [], dash }, { line: 4, deleteCount: 1, insert: [], dash }];
    assert.equal(applyLineEdits(yaml, edits).text, 'steps:\n  # c\n- b: 2\n- d: 4');
  });
});

describe('callReadOnlyReason', () => {
  const reason = (body: string) => {
    const yaml = `steps:\n- task: T@1\n  inputs:\n${body}`;
    return callReadOnlyReason(yaml, asTemplateRef(findTaskSteps(yaml)[0], task), 'inputs');
  };

  it('keeps inputs under an if editable', () => {
    assert.equal(reason('    ${{ if eq(1, 1) }}:\n      a: b'), undefined);
  });

  it('is read-only for an each nested in an if, like dynamicInputs of the step', () => {
    const yaml = 'steps:\n- task: T@1\n  inputs:\n    ${{ if eq(1, 1) }}:\n      ${{ each k in params.m }}:\n        a: b';
    assert.equal(findTaskSteps(yaml)[0].dynamicInputs, true);
    assert.match(reason('    ${{ if eq(1, 1) }}:\n      ${{ each k in params.m }}:\n        a: b') ?? '', /built with expressions/);
  });
});

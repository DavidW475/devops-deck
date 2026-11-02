import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskInfo, TaskInput } from '../pipelines/taskModel';
import { asTemplateRef, findTaskSteps, toParameter } from '../pipelines/taskRefs';
import { applyLineEdits, callReadOnlyReason, deleteLines, planCallEdits, planDisplayName } from '../pipelines/templateEdits';
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

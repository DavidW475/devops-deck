import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskInfo, TaskInput } from '../pipelines/taskModel';
import { evalRule, inputVisibility, parseVisibleRule } from '../pipelines/taskRules';

const values = (map: Record<string, string>) => (name: string) => map[name];
const rule = (text: string, map: Record<string, string>) => {
  const node = parseVisibleRule(text);
  assert.ok(node, text);
  return evalRule(node, values(map));
};

function input(name: string, extra: Partial<TaskInput> = {}): TaskInput {
  return {
    name, yamlName: name, aliases: [], label: name, required: false, type: 'string', options: [], editable: false, multi: false, ...extra,
  };
}

function task(inputs: TaskInput[], groups: TaskInfo['groups'] = []): TaskInfo {
  return {
    id: '00000000-0000-0000-0000-000000000001', name: 'ContosoDeploy', title: 'Contoso deploy', description: '', category: 'Deploy',
    major: 1, version: '1.0.0', deprecated: false, preview: false, groups, inputs,
  };
}

describe('parseVisibleRule and evalRule', () => {
  it('reads the comparison operators', () => {
    assert.equal(rule('a = x', { a: 'x' }), true);
    assert.equal(rule('a == x', { a: 'y' }), false);
    assert.equal(rule('a != x', { a: 'y' }), true);
    assert.equal(rule('a EndsWith .zip', { a: 'pkg.ZIP' }), true);
    assert.equal(rule('a NotEndsWith .zip', { a: 'pkg.zip' }), false);
    assert.equal(rule('a notendswith .zip', { a: 'pkg.tar' }), true);
  });

  it('allows spaces in values and compares case-insensitively', () => {
    assert.equal(rule('ScriptType == Inline Script', { ScriptType: 'inline script' }), true);
    assert.equal(rule('a = ', { a: '' }), true);
  });

  it('handles && || and parentheses', () => {
    assert.equal(rule('a = 1 && b = 2', { a: '1', b: '2' }), true);
    assert.equal(rule('a = 1 && b = 2', { a: '1', b: '3' }), false);
    assert.equal(rule('a = 1 || b = 2', { a: '0', b: '2' }), true);
    assert.equal(rule('(a = 1 || b = 2) && c = 3', { a: '1', b: '0', c: '3' }), true);
    assert.equal(rule('((a = 1))', { a: '1' }), true);
    assert.equal(rule('a = f(x) && b = 1', { a: 'f(x)', b: '1' }), true);
  });

  it('is three-valued: unknown names give undefined unless the other side decides', () => {
    assert.equal(rule('x = 1', {}), undefined);
    assert.equal(rule('x = 1 && a = 1', { a: '0' }), false);
    assert.equal(rule('x = 1 && a = 1', { a: '1' }), undefined);
    assert.equal(rule('x = 1 || a = 1', { a: '1' }), true);
    assert.equal(rule('x = 1 || a = 1', { a: '0' }), undefined);
  });

  it('treats mixed && and || without parentheses as unknown', () => {
    assert.equal(rule('a = 1 && b = 2 || c = 3', { a: '1', b: '2', c: '3' }), undefined);
    assert.equal(rule('a = 1 && (b = 2 || c = 3)', { a: '1', b: '0', c: '3' }), true);
  });

  it('returns undefined for broken rules', () => {
    for (const bad of ['', 'a', 'a =', '= x', '(a = 1', 'a = 1)', 'a = 1 &&', 'a Contains b', '&& a = 1', '()']) {
      if (bad === 'a =') {
        assert.ok(parseVisibleRule(bad));
      } else {
        assert.equal(parseVisibleRule(bad), undefined, bad);
      }
    }
  });

  it('copes with hostile input in linear time', () => {
    const deep = '('.repeat(5000) + 'a = 1' + ')'.repeat(5000);
    assert.equal(parseVisibleRule(deep), undefined);
    const long = 'a = 1 &&'.repeat(20000) + ' a = 1';
    assert.ok(parseVisibleRule(long));
    assert.ok(parseVisibleRule('a = ' + ' '.repeat(100000) + 'b'));
  });
});

describe('inputVisibility', () => {
  const t = task(
    [
      input('scriptLocation', { default: 'inlineScript' }),
      input('inlineScript', { visibleRule: 'scriptLocation = inlineScript' }),
      input('scriptPath', { visibleRule: 'scriptLocation = scriptPath' }),
      input('args', { group: 'advanced' }),
      input('deep', { visibleRule: 'inlineScript = x' }),
      input('azureSub', { aliases: ['azureSubscription'] }),
      input('byAlias', { visibleRule: 'azureSub = prod' }),
      input('loopA', { visibleRule: 'loopB = 1' }),
      input('loopB', { visibleRule: 'loopA = 1' }),
      input('ghost', { visibleRule: 'nothing = 1' }),
      input('broken', { visibleRule: 'a ~ b' }),
    ],
    [{ name: 'advanced', label: 'Advanced', visibleRule: 'scriptLocation = scriptPath' }],
  );
  const vis = (name: string, passed: Record<string, string> = {}, conditional: string[] = []) =>
    inputVisibility(t, t.inputs.find(i => i.name === name)!, new Map(Object.entries(passed)), new Set(conditional));

  it('is true without a rule', () => {
    assert.equal(vis('scriptLocation'), true);
  });

  it('uses the default of an input that is not set', () => {
    assert.equal(vis('inlineScript'), true);
    assert.equal(vis('scriptPath'), false);
  });

  it('uses the passed value, matching by name or alias, case-insensitively', () => {
    assert.equal(vis('inlineScript', { scriptlocation: 'scriptPath' }), false);
    assert.equal(vis('scriptPath', { SCRIPTLOCATION: 'ScriptPath' }), true);
    assert.equal(vis('byAlias', { AzureSubscription: 'prod' }), true);
    assert.equal(vis('byAlias', { azureSub: 'dev' }), false);
  });

  it('ands the group rule', () => {
    assert.equal(vis('args', { scriptLocation: 'scriptPath' }), true);
    assert.equal(vis('args'), false);
  });

  it('is unknown for expressions, conditional inputs, unknown names and broken rules', () => {
    assert.equal(vis('inlineScript', { scriptLocation: '${{ parameters.loc }}' }), undefined);
    assert.equal(vis('inlineScript', { scriptLocation: '$(loc)' }), undefined);
    assert.equal(vis('inlineScript', {}, ['scriptLocation']), undefined);
    assert.equal(vis('inlineScript', { scriptlocation: 'x' }, ['ScriptLocation']), undefined);
    assert.equal(vis('ghost'), undefined);
    assert.equal(vis('broken'), undefined);
  });

  it('is unknown when the rule reads a hidden input and survives rule cycles', () => {
    assert.equal(vis('deep', { inlineScript: 'x' }), true);
    assert.equal(vis('deep', { inlineScript: 'x', scriptLocation: 'scriptPath' }), undefined);
    assert.equal(vis('loopA'), undefined);
  });

  it('a hidden group rule wins over a visible input rule', () => {
    assert.equal(vis('args', { scriptLocation: 'inlineScript' }), false);
  });
});

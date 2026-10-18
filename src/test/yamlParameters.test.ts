import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePipelineParameters, parseYamlDocument, setOwn } from '../pipelines/yamlParameters';

describe('parsePipelineParameters', () => {
  it('reads the list form with types, defaults and allowed values', () => {
    const yaml = [
      'trigger: none',
      '',
      'parameters:',
      '- name: environment # where to deploy',
      '  displayName: Environment',
      '  type: string',
      '  default: staging',
      '  values:',
      '  - staging',
      '  - production',
      '- name: runTests',
      '  type: boolean',
      '  default: true',
      '- name: regions',
      '  type: object',
      '  default:',
      '    - westeurope',
      '    - northeurope',
      '- name: retries',
      '  type: number',
      '  default: 3',
      '  values: [1, 3, 5]',
      '',
      'stages:',
      '- stage: Build',
    ].join('\n');
    const params = parsePipelineParameters(yaml);
    assert.deepEqual(params.map(p => p.name), ['environment', 'runTests', 'regions', 'retries']);
    assert.deepEqual(params[0], { name: 'environment', displayName: 'Environment', type: 'string', default: 'staging', values: ['staging', 'production'] });
    assert.equal(params[1].default, 'true');
    assert.deepEqual(JSON.parse(params[2].default!), ['westeurope', 'northeurope']);
    assert.deepEqual(params[3].values, ['1', '3', '5']);
  });

  it('handles quoted values containing # and colons', () => {
    const params = parsePipelineParameters([
      'parameters:',
      '- name: message',
      "  default: 'build #1: done' # comment",
    ].join('\n'));
    assert.equal(params[0].default, 'build #1: done');
  });

  it('reads the legacy mapping form', () => {
    const params = parsePipelineParameters('parameters:\n  image: ubuntu-latest\n  debug: false\n');
    assert.deepEqual(params.map(p => [p.name, p.type, p.default]), [['image', 'string', 'ubuntu-latest'], ['debug', 'boolean', 'false']]);
  });

  it('returns nothing without a parameters block', () => {
    assert.deepEqual(parsePipelineParameters('trigger:\n- main\n'), []);
  });

  it('reads block scalars, flow maps and quoted keys', () => {
    const params = parsePipelineParameters([
      '\uFEFFparameters:  # runtime parameters',
      '- name: script',
      '  type: string',
      '  default: |',
      '    echo one',
      '      echo two',
      '- name: notes',
      '  default: >-',
      '    first',
      '    second',
      '- name: settings',
      '  type: object',
      "  default: { region: westeurope, 'tier': \"gold\", nested: [a, {b: c}], bad }",
      '- "name" : quoted',
      '  displayName: "Say \\"hi\\"\\nnow"',
      "  default: 'it''s'",
      '- name: empty',
      '  default:',
      '- name: nothing',
      '  default: ~',
      '- name: flag',
      '  default: TRUE',
    ].join('\r\n'));
    const byName = Object.fromEntries(params.map(p => [p.name, p]));
    assert.equal(byName.script.default, 'echo one\n  echo two');
    assert.equal(byName.notes.default, 'first second');
    assert.deepEqual(JSON.parse(byName.settings.default!), { region: 'westeurope', tier: 'gold', nested: ['a', { b: 'c' }] });
    assert.equal(byName.quoted.displayName, 'Say "hi"\nnow');
    assert.equal(byName.quoted.default, "it's");
    assert.equal(byName.quoted.type, 'string', 'type defaults to string');
    assert.equal(byName.empty.default, undefined);
    assert.equal(byName.nothing.default, undefined);
    assert.equal(byName.flag.default, 'true');
  });

  it('reads nested list items and skips entries without a name', () => {
    const params = parsePipelineParameters([
      'parameters:',
      '-',
      '  name: stages',
      '  type: stageList',
      '  default:',
      '  - stage: A',
      '  - stage: B',
      '- type: string',
      '- just text',
      '-',
      '- name: last',
    ].join('\n'));
    assert.deepEqual(params.map(p => p.name), ['stages', 'last']);
    assert.deepEqual(JSON.parse(params[0].default!), [{ stage: 'A' }, { stage: 'B' }]);
  });

  it('reads legacy objects and ignores scalars and lines that are not keys', () => {
    const legacy = parsePipelineParameters('parameters:\n  pools:\n    linux: ubuntu-latest\n  empty:\n');
    assert.deepEqual(legacy.map(p => [p.name, p.type, p.default]), [['pools', 'object', '{\n  "linux": "ubuntu-latest"\n}'], ['empty', 'string', undefined]]);
    assert.deepEqual(parsePipelineParameters('parameters:\n  just a value\n'), []);
    assert.deepEqual(parsePipelineParameters('parameters:\n\n# only a comment\n'), []);
    assert.deepEqual(parsePipelineParameters('parameters:\n  "unclosed: x\n'), []);
    assert.deepEqual(parsePipelineParameters('parameters:\n  url:https://x\n'), []);
    assert.deepEqual(parsePipelineParameters('parameters:\n  "k" x: y\n'), []);
  });
});

describe('parseYamlDocument', () => {
  it('keeps "#", blank lines and "---" inside block scalars', () => {
    const doc = parseYamlDocument([
      'steps:',
      '- script: |',
      '    echo "build #1" # not a comment',
      '',
      '    ---',
      '    echo done',
      '  displayName: Build',
      '# a real comment',
      '- bash: >',
      '    one',
      '    two',
      '',
      '    three',
      '',
      'pool: contoso-linux',
    ].join('\n')) as any;
    assert.deepEqual(doc.steps, [
      { script: 'echo "build #1" # not a comment\n\n---\necho done', displayName: 'Build' },
      { bash: 'one two\nthree' },
    ]);
    assert.equal(doc.pool, 'contoso-linux');
    assert.deepEqual(parseYamlDocument('a: |\nb: 1\n'), { a: '', b: '1' });
  });

  it('keeps "__proto__" as an own key instead of changing the prototype', () => {
    const doc = parseYamlDocument('a: 1\n__proto__:\n  injected: yes\nflow: { __proto__: x }\n') as any;
    assert.deepEqual(Object.keys(doc), ['a', '__proto__', 'flow']);
    assert.equal(Object.getPrototypeOf(doc), Object.prototype);
    assert.equal(doc.injected, undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptor(doc.flow, '__proto__')?.value, 'x');
    const o: Record<string, string> = {};
    setOwn(o, '__proto__', 'v');
    setOwn(o, 'k', 'w');
    assert.deepEqual(Object.entries(o), [['__proto__', 'v'], ['k', 'w']]);
  });
});

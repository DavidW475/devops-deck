import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePipelineParameters } from '../pipelines/yamlParameters';

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
});

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStageDependencies, stageColumns, stageDependencies } from '../pipelines/stageGraph';

const YAML = `
trigger: none
stages:
- stage: Build
  jobs:
  - job: A
    steps:
    - script: echo "dependsOn: nope"
- stage: Lint   # runs next to Build
  dependsOn: []
- stage: Test
  dependsOn:
    - Build
    - 'Lint'
- stage: Deploy
  displayName: Deploy to Contoso
- stage: Docs
  dependsOn: [Build]
`;

describe('stage graph', () => {
  it('reads stage names and dependsOn in all forms', () => {
    const deps = parseStageDependencies(YAML)!;
    assert.deepEqual([...deps.keys()], ['Build', 'Lint', 'Test', 'Deploy', 'Docs']);
    assert.equal(deps.get('Build'), null);
    assert.deepEqual(deps.get('Lint'), []);
    assert.deepEqual(deps.get('Test'), ['Build', 'Lint']);
    assert.equal(deps.get('Deploy'), null);
    assert.deepEqual(deps.get('Docs'), ['Build']);
  });

  it('handles an indented list and gives up on templates', () => {
    const indented = 'stages:\n  - stage: A\n  - stage: B\n    dependsOn: A\nvariables:\n  x: 1\n';
    assert.deepEqual([...parseStageDependencies(indented)!.entries()], [['A', null], ['B', ['A']]]);
    assert.equal(parseStageDependencies('stages:\n- template: stages.yml\n'), undefined);
    const sameIndent = 'stages:\n- stage: A\n- stage: B\n- stage: C\n  dependsOn:\n  - A\n  - B\n  jobs: []\n';
    assert.deepEqual(parseStageDependencies(sameIndent)!.get('C'), ['A', 'B']);
    assert.equal(parseStageDependencies('jobs:\n- job: A\n'), undefined);
  });

  it('maps YAML dependencies to stage ids; no dependsOn means the previous stage', () => {
    const stages = ['Build', 'Lint', 'Test', 'Deploy', 'Docs'].map(n => ({ id: n.toLowerCase(), identifier: n }));
    const deps = stageDependencies(stages, parseStageDependencies(YAML));
    assert.deepEqual(Object.fromEntries(deps), { build: [], lint: [], test: ['build', 'lint'], deploy: ['test'], docs: ['build'] });
    const cols = stageColumns(stages.map(s => s.id), deps);
    assert.deepEqual(Object.fromEntries(cols), { build: 0, lint: 0, test: 1, deploy: 2, docs: 1 });
  });

  it('infers parallel stages from times when there is no YAML', () => {
    const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 10, m)).toISOString();
    const stages = [
      { id: 'a', start: t(0), finish: t(5) },
      { id: 'b', start: t(0), finish: t(3) },
      { id: 'c', start: t(6), finish: t(8) },
      { id: 'd' },
    ];
    const deps = stageDependencies(stages);
    assert.deepEqual(Object.fromEntries(deps), { a: [], b: [], c: ['a', 'b'], d: ['c'] });
    const sequential = [{ id: 'x', start: t(0), finish: t(1) }, { id: 'y', start: t(2), finish: t(3) }, { id: 'z', start: t(4), finish: t(5) }];
    assert.deepEqual(Object.fromEntries(stageDependencies(sequential)), { x: [], y: ['x'], z: ['y'] });
  });
});

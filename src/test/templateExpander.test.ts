import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as vscode from './vscodeStub';
import { buildModel, poolText } from '../pipelines/pipelineModel';
import { bindParameters, coerce, declaredParameters, staticVariables, TemplateExpander, UNRESOLVED } from '../pipelines/templateExpander';
import { TemplateContext } from '../pipelines/templateResolver';
import { parseYamlDocument, yamlLine } from '../pipelines/yamlParameters';

const origin = { kind: 'local' as const, root: '/work/contoso-app' };
const ctx = (p = '/azure-pipelines.yml'): TemplateContext => ({ location: { origin, path: p }, self: origin, repos: {} });

/** Resolves `path` and `path@alias` from a map; the alias becomes part of the key. */
function fakeResolver(files: Record<string, string>) {
  return {
    resolve: async (_c: TemplateContext, t: { path: string; alias?: string }) => {
      const key = t.alias ? `${t.path}@${t.alias}` : t.path;
      if (!(key in files)) {
        throw new Error(`${key} does not exist.`);
      }
      return {
        context: ctx('/' + t.path), uri: vscode.Uri.file('/work/' + key) as any, text: files[key], parameters: [], label: key,
      };
    },
  };
}

const expand = async (root: string, files: Record<string, string> = {}, parameters?: Record<string, string>) =>
  new TemplateExpander(fakeResolver(files)).expand(ctx(), root, 'file:///work/contoso-app/azure-pipelines.yml', 'azure-pipelines.yml', { parameters, branch: 'feature/cart' });

const FILES: Record<string, string> = {
  'stages/pipeline.yml@templates': [
    'parameters:',
    '- name: environments',
    '  type: object',
    '  default: [staging]',
    '- name: runTests',
    '  type: boolean',
    '  default: true',
    'pool:',
    '  name: docker-local',
    'stages:',
    '- stage: Build',
    '  jobs:',
    '  - template: jobs/build.yml',
    '    parameters:',
    '      mode: production',
    '- ${{ if parameters.runTests }}:',
    '  - stage: Test',
    '    jobs:',
    '    - job: Test',
    '      steps:',
    '      - script: npm test',
    '- ${{ each env in parameters.environments }}:',
    '  - stage: Deploy_${{ env }}',
    '    displayName: Deploy to ${{ env }}',
    '    dependsOn: Build',
    '    jobs:',
    '    - deployment: Deploy',
    '      environment: contoso-${{ env }}',
    '      strategy:',
    '        runOnce:',
    '          preDeploy:',
    '            steps:',
    '            - script: echo pre',
    '          deploy:',
    '            steps:',
    '            - task: UseNode@1',
    '            - template: steps/smoke.yml',
    '          on:',
    '            failure:',
    '              steps:',
    '              - script: echo rollback',
  ].join('\n'),
  'jobs/build.yml': [
    'parameters:',
    '- name: mode',
    '  values: [development, production]',
    'jobs:',
    '- job: Build',
    '  displayName: Build (${{ parameters.mode }})',
    '  steps:',
    '  - checkout: self',
    '  - ${{ if eq(parameters.mode, \'production\') }}:',
    '    - script: npm run build -- --prod',
    '  - ${{ elseif eq(parameters.mode, \'test\') }}:',
    '    - script: never',
    '  - ${{ else }}:',
    '    - script: npm run build',
  ].join('\n'),
  'steps/smoke.yml': 'steps:\n- script: |\n    node dist/server.js --smoke\n    echo done\n  displayName: Smoke test\n  condition: succeeded()\n',
};

const ROOT = [
  'parameters:',
  '- name: environments',
  '  type: object',
  '  default:',
  '  - staging',
  '  - production',
  '- name: runTests',
  '  type: boolean',
  '  default: false',
  'variables:',
  '  appName: contoso-api',
  'extends:',
  '  template: stages/pipeline.yml@templates',
  '  parameters:',
  '    environments: ${{ parameters.environments }}',
  '    runTests: ${{ parameters.runTests }}',
].join('\n');

describe('TemplateExpander', () => {
  it('expands extends, nested templates, if/elseif/else and each, with the source of every item', async () => {
    const res = await expand(ROOT, FILES);
    assert.deepEqual(res.warnings, []);
    assert.equal(res.files, 4, "smoke.yml once per environment");
    const m = buildModel(res.doc, res.sourceOf);
    assert.deepEqual(m.stages.map(s => [s.id, s.name, s.dependsOn, s.column, s.pool]), [
      ['Build', 'Build', [], 0, 'docker-local'],
      ['Deploy_staging', 'Deploy to staging', ['Build'], 1, 'docker-local'],
      ['Deploy_production', 'Deploy to production', ['Build'], 1, 'docker-local'],
    ]);
    const build = m.stages[0].jobs[0];
    assert.equal(build.name, 'Build (production)');
    assert.deepEqual(build.steps.map(s => s.name), ['checkout: self', 'script: npm run build -- --prod']);
    assert.equal(m.sources[build.source!].label, 'jobs/build.yml');
    assert.equal(m.sources[build.steps[1].source!].line, 9);
    const deploy = m.stages[1].jobs[0];
    assert.deepEqual([deploy.kind, deploy.environment, deploy.strategy], ['deployment', 'contoso-staging', 'runOnce']);
    assert.deepEqual(deploy.steps.map(s => [s.hook, s.name, s.detail, s.condition]), [
      ['preDeploy', 'script: echo pre', undefined, undefined],
      ['deploy', 'UseNode@1', undefined, undefined],
      ['deploy', 'Smoke test', 'node dist/server.js --smoke', 'succeeded()'],
      ['on.failure', 'script: echo rollback', undefined, undefined],
    ]);
    assert.equal(m.sources[deploy.steps[2].source!].label, 'steps/smoke.yml');
    assert.deepEqual(m.counts, { stages: 3, jobs: 3, steps: 10 });
  });

  it('takes runtime parameters from the preview form', async () => {
    const res = await expand(ROOT, FILES, { runTests: 'true', environments: '["dev"]' });
    assert.deepEqual(buildModel(res.doc).stages.map(s => s.id), ['Build', 'Test', 'Deploy_dev']);
  });

  it('warns about parameter problems, missing templates and bad expressions', async () => {
    const root = [
      'parameters:',
      '- name: required',
      'steps:',
      '- template: steps/missing.yml',
      '- template: jobs/build.yml',
      '  parameters:',
      '    mode: fast',
      '    extra: 1',
      '- template: ${{ parameters.nothing }}',
      "- script: echo ${{ counter('x', 1) }}",
      '- ${{ elseif true }}:',
      '  - script: orphan',
      '- template: steps/smoke.yml',
      '  parameters:',
      '    ${{ if true }}: plain text',
    ].join('\n');
    const res = await expand(root, FILES);
    assert.deepEqual(res.warnings, [
      "azure-pipelines.yml: a value for the parameter 'required' must be provided.",
      'azure-pipelines.yml: steps/missing.yml: steps/missing.yml does not exist.',
      "jobs/build.yml: 'fast' is not an allowed value of 'mode'.",
      "jobs/build.yml: unexpected parameter 'extra'.",
      'jobs/build.yml: contains jobs, but is used as a steps template.',
      "azure-pipelines.yml: Template path '' can't be resolved.",
      "azure-pipelines.yml: Unknown function 'counter' (or only available at runtime) in 'echo ${{ counter('x', 1) }}'",
      'azure-pipelines.yml: ${{ elseif }} without ${{ if }}.',
      "azure-pipelines.yml: '${{ if true }}' must produce a mapping here.",
    ]);
    const steps = buildModel(res.doc).stages[0].jobs[0].steps;
    assert.deepEqual(steps.map(s => [s.kind, s.error ?? s.name]), [
      ['template', 'steps/missing.yml: steps/missing.yml does not exist.'],
      ['template', "Template path '' can't be resolved."],
      ['script', "script: echo ${{ counter('x', 1) }}"],
      ['script', 'Smoke test'],
    ]);
  });

  it('stops at the nesting limit and rejects documents without a mapping', async () => {
    const res = await expand('steps:\n- template: loop.yml\n', { 'loop.yml': 'steps:\n- template: loop.yml\n' });
    assert.match(res.warnings[0], /nested deeper than 20 levels/);
    await assert.rejects(expand('- just a list\n'), /not a pipeline/);
    const empty = await expand('steps:\n- template: empty.yml\n', { 'empty.yml': '' });
    assert.match(empty.warnings[0], /empty or not a mapping/);
  });

  it('expands insert, each over mappings and expressions in keys', async () => {
    const root = [
      'parameters:',
      '- name: tags',
      '  type: object',
      '  default: { team: web, tier: gold }',
      'variables:',
      '  ${{ each t in parameters.tags }}:',
      '    tag_${{ t.key }}: ${{ t.value }}',
      '  ${{ insert }}:',
      '    inserted: yes',
      'jobs:',
      '- job: A',
      "  condition: eq(variables['Build.Reason'], 'Manual')",
      '  pool:',
      '    vmImage: ubuntu-latest',
      '  strategy:',
      '    matrix:',
      '      node20: { v: 20 }',
      '      node22: { v: 22 }',
      '  steps:',
      "  - script: echo ${{ variables['Build.SourceBranchName'] }}",
      '- job: B',
      '  dependsOn: A',
      '  strategy:',
      '    parallel: 3',
    ].join('\n');
    const res = await expand(root);
    assert.deepEqual(res.doc.variables, { tag_team: 'web', tag_tier: 'gold', inserted: 'yes' });
    const [stage] = buildModel(res.doc).stages;
    assert.equal(stage.id, '__default');
    assert.deepEqual(stage.jobs.map(j => [j.id, j.pool, j.strategy, j.dependsOn, j.condition]), [
      ['A', 'ubuntu-latest', 'matrix: node20, node22', [], "eq(variables['Build.Reason'], 'Manual')"],
      ['B', undefined, 'parallel: 3', ['A'], undefined],
    ]);
    assert.equal(stage.jobs[0].steps[0].name, 'script: echo cart');
  });
});

describe('parameter helpers', () => {
  it('reads declared parameters in both forms and converts passed values', () => {
    const list = declaredParameters(parseYamlDocument('parameters:\n- name: a\n  type: boolean\n- name: b\n  values: [x, y]\n- other\n'));
    assert.deepEqual(list, [{ name: 'a', type: 'boolean', default: undefined, values: undefined }, { name: 'b', type: 'string', default: undefined, values: ['x', 'y'] }]);
    assert.deepEqual(declaredParameters(parseYamlDocument('parameters:\n  image: ubuntu\n')), [{ name: 'image', type: 'legacy', default: 'ubuntu' }]);
    assert.deepEqual(declaredParameters(undefined), []);
    assert.equal(coerce({ name: 'a', type: 'boolean' }, ' TRUE '), true);
    assert.equal(coerce({ name: 'n', type: 'number' }, '42'), 42);
    assert.equal(coerce({ name: 'n', type: 'number' }, 'many'), 'many');
    assert.deepEqual(coerce({ name: 'o', type: 'object' }, '{"a":1}'), { a: 1 });
    assert.equal(coerce({ name: 'o', type: 'object' }, '[broken'), '[broken');
    const warnings: string[] = [];
    assert.deepEqual(bindParameters([{ name: 'Env', type: 'string', default: 'dev', values: ['dev', 'prod'] }], { env: 'PROD' }, 'x', w => warnings.push(w)), { Env: 'PROD' });
    assert.deepEqual(warnings, []);
  });

  it('knows compile-time variables', () => {
    assert.deepEqual(staticVariables(parseYamlDocument('variables:\n- name: a\n  value: 1\n- group: shared\n'), 'release/1.0'), {
      'Build.Reason': 'Manual', 'Build.SourceBranch': 'refs/heads/release/1.0', 'Build.SourceBranchName': '1.0', a: '1',
    });
    assert.equal(staticVariables(undefined, undefined)['Build.SourceBranch'], '');
  });

  it('keeps "__proto__" keys as own keys', async () => {
    const vars = staticVariables(parseYamlDocument('variables:\n  __proto__: x\n'), undefined);
    assert.equal(Object.getOwnPropertyDescriptor(vars, '__proto__')?.value, 'x');
    const list = staticVariables(parseYamlDocument('variables:\n- name: __proto__\n  value: y\n'), undefined);
    assert.equal(Object.getOwnPropertyDescriptor(list, '__proto__')?.value, 'y');
    const bound = bindParameters([{ name: '__proto__', type: 'string', default: 'd' }], {}, 'x', () => undefined);
    assert.deepEqual(Object.entries(bound), [['__proto__', 'd']]);
    const res = await expand('steps:\n- script: echo hi\n  __proto__: a\n  ${{ if true }}:\n    __proto__: b\n');
    const step = (res.doc.steps as any[])[0];
    assert.equal(Object.getPrototypeOf(step), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(step, '__proto__')?.value, 'b');
  });
});

describe('buildModel', () => {
  it('builds a single job for a steps-only pipeline and shows unresolved stage and job templates', () => {
    const steps = buildModel({ pool: 'docker-local', steps: [{ bash: 'echo hi' }, 'odd'] });
    assert.deepEqual(steps.stages[0].jobs.map(j => [j.name, j.pool, j.steps.map(s => s.name)]), [['Job', 'docker-local', ['bash: echo hi', 'odd']]]);
    const m = buildModel({
      stages: [
        { template: 'stages/x.yml', [UNRESOLVED]: 'stages/x.yml does not exist.' },
        { stage: 'B', dependsOn: [], jobs: [{ template: 'jobs/y.yml' }, 'bad', { job: 'J', environment: { name: 'contoso-prod' }, strategy: { matrix: '${{ x }}' } }] },
        'bad',
      ],
    });
    assert.deepEqual(m.stages.map(s => [s.id, s.error, s.dependsOn]), [
      ['template0', 'stages/x.yml does not exist.', []], ['B', undefined, []], ['stage2', undefined, []],
    ]);
    assert.deepEqual(m.stages[1].jobs.map(j => [j.kind, j.name, j.environment, j.strategy]), [
      ['template', 'jobs/y.yml', undefined, undefined], ['job', '(invalid job)', undefined, undefined], ['job', 'J', 'contoso-prod', 'matrix (expression)'],
    ]);
    assert.deepEqual(buildModel({ trigger: 'none' }).stages, []);
    assert.equal(poolText({ name: 'docker-local', vmImage: 'x' }), 'docker-local · x');
    assert.equal(poolText({}), undefined);
    assert.equal(buildModel({ steps: [{ script: 'x'.repeat(100) }] }).stages[0].jobs[0].steps[0].name.length, 86);
    assert.equal(buildModel({ jobs: [{ job: 'A', strategy: { other: 1 } }, { deployment: 'D', strategy: { runOnce: {} } }] }).stages[0].jobs[1].steps.length, 0);
  });

  it('remembers parsed lines', () => {
    const doc = parseYamlDocument('a: 1\nlist:\n- x: 1\n') as any;
    assert.equal(yamlLine(doc), 0);
    assert.equal(yamlLine(doc.list), 2);
    assert.equal(yamlLine(doc.list[0]), 2);
    assert.equal(yamlLine('text'), undefined);
    assert.equal(parseYamlDocument('# only a comment\n'), undefined);
  });
});

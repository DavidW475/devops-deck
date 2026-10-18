import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkTemplateParameters, completionContext, describeParameter, findTemplateRefs, joinTemplatePath, mdEscape, parameterSnippet,
  parsePreviewErrors, parseRepositories, parseTemplatePath,
} from '../pipelines/templateRefs';
import { PipelineParameter } from '../pipelines/yamlParameters';

const pipeline = [
  'trigger: none',
  'resources:',
  '  repositories:',
  '  - repository: templates',
  '    type: git',
  '    name: Fabrikam Shop/pipeline-templates',
  '    ref: refs/tags/v2',
  '  - repository: tools',
  '    type: github',
  '    name: contoso/build-tools',
  '    endpoint: contoso-github',
  'extends:',
  '  template: stages/deploy.yml@templates # shared',
  '  parameters:',
  '    environment: staging',
  '    runTests: true',
  '    regions:',
  '    - westeurope',
  '    ${{ if eq(variables.full, true) }}:',
  '      verbose: true',
  'steps:',
  '- script: |',
  '    echo template: not-a-ref.yml',
  '- template: steps/build.yml',
  '  parameters: { configuration: Release, "platform": x64 }',
  '- template: ${{ parameters.extra }}',
  '- template: /steps/test.yml',
  '  parameters: ${{ parameters.testArgs }}',
].join('\n');

const declared: PipelineParameter[] = [
  { name: 'environment', type: 'string', values: ['staging', 'production'] },
  { name: 'runTests', type: 'boolean', default: 'false' },
  { name: 'regions', type: 'object', default: '[]' },
  { name: 'retries', type: 'number', default: '3' },
  { name: 'serviceConnection', type: 'string' },
];

describe('parseTemplatePath', () => {
  it('splits path and alias and skips expressions', () => {
    assert.deepEqual(parseTemplatePath('stages/deploy.yml@templates'), { path: 'stages/deploy.yml', alias: 'templates' });
    assert.deepEqual(parseTemplatePath("'steps/build.yml'"), { path: 'steps/build.yml' });
    assert.deepEqual(parseTemplatePath('steps/build.yml@'), { path: 'steps/build.yml' });
    assert.equal(parseTemplatePath('${{ parameters.file }}'), undefined);
    assert.equal(parseTemplatePath(''), undefined);
  });
});

describe('joinTemplatePath', () => {
  it('resolves relative to the including file and absolute to the repository root', () => {
    assert.equal(joinTemplatePath('/pipelines/ci.yml', 'steps/build.yml'), '/pipelines/steps/build.yml');
    assert.equal(joinTemplatePath('/pipelines/ci.yml', '../shared/./x.yml'), '/shared/x.yml');
    assert.equal(joinTemplatePath('/pipelines/ci.yml', '/steps/test.yml'), '/steps/test.yml');
    assert.equal(joinTemplatePath('/a.yml', '../../../etc/x.yml'), '/etc/x.yml');
  });
});

describe('parseRepositories', () => {
  it('reads repository resources with defaults', () => {
    assert.deepEqual(parseRepositories(pipeline), [
      { alias: 'templates', type: 'git', name: 'Fabrikam Shop/pipeline-templates', ref: 'refs/tags/v2', endpoint: undefined },
      { alias: 'tools', type: 'github', name: 'contoso/build-tools', ref: undefined, endpoint: 'contoso-github' },
    ]);
    assert.deepEqual(parseRepositories('resources:\n  repositories:\n  - repository: x\n    name: Contoso Web\n  - name: noAlias\n'),
      [{ alias: 'x', type: 'git', name: 'Contoso Web', ref: undefined, endpoint: undefined }]);
    assert.deepEqual(parseRepositories('resources:\n  pipelines: []\n'), []);
    assert.deepEqual(parseRepositories('steps: []\n'), []);
  });
});

describe('findTemplateRefs', () => {
  const refs = findTemplateRefs(pipeline);

  it('finds every reference but not text inside block scalars', () => {
    assert.deepEqual(refs.map(r => [r.kind, r.line, r.raw]), [
      ['extends', 12, 'stages/deploy.yml@templates'],
      ['template', 23, 'steps/build.yml'],
      ['template', 25, '${{ parameters.extra }}'],
      ['template', 26, '/steps/test.yml'],
    ]);
    assert.equal(refs[0].valueStart, 12);
    assert.equal(refs[0].valueEnd, 39);
    assert.equal(refs[2].target, undefined);
  });

  it('reads block parameters, including keys under conditions', () => {
    const r = refs[0];
    assert.equal(r.paramsLine, 13);
    assert.equal(r.dynamicParams, true);
    assert.deepEqual(r.params.map(p => [p.name, p.value, p.conditional, p.line, p.start]), [
      ['environment', 'staging', false, 14, 4],
      ['runTests', 'true', false, 15, 4],
      ['regions', '', false, 16, 4],
      ['verbose', 'true', true, 19, 6],
    ]);
    assert.equal(r.end, 19);
  });

  it('reads flow parameters with positions and marks expression parameters as dynamic', () => {
    assert.deepEqual(refs[1].params.map(p => [p.name, p.value, p.start]), [['configuration', 'Release', 16], ['platform', 'x64', 41]]);
    assert.equal(refs[3].dynamicParams, true);
    assert.deepEqual(refs[3].params, []);
  });

  it('finds parameters written before the template key', () => {
    const [r] = findTemplateRefs('extends:\n  parameters:\n    a: 1\n  template: x.yml\n');
    assert.equal(r.kind, 'extends');
    assert.deepEqual(r.params.map(p => p.name), ['a']);
  });

  it('keeps sibling list items apart', () => {
    const r = findTemplateRefs('jobs:\n- template: a.yml\n  parameters:\n    x: 1\n- template: b.yml\n  parameters:\n    y: 2\n');
    assert.deepEqual(r.map(t => t.params.map(p => p.name)), [['x'], ['y']]);
  });
});

describe('completionContext', () => {
  const doc = [
    'steps:',
    '- template: steps/build.yml@templ',
    '  parameters:',
    '    configuration: Rel',
    '    ',
    '- template: steps/test.yml',
    '  ',
  ].join('\n');

  it('detects path, name, value and parameters-key positions', () => {
    assert.deepEqual(pick(completionContext(doc, 1, 33)), { kind: 'path', prefix: 'steps/build.yml@templ' });
    assert.deepEqual(pick(completionContext(doc, 3, 22)), { kind: 'value', name: 'configuration' });
    assert.deepEqual(pick(completionContext(doc, 4, 4)), { kind: 'name' });
    assert.deepEqual(pick(completionContext(doc, 3, 8)), { kind: 'name' });
    assert.deepEqual(pick(completionContext(doc, 6, 2)), { kind: 'parametersKey' });
    assert.equal(completionContext(doc, 0, 3), undefined);
    assert.equal(completionContext(doc, 99, 0), undefined);
  });

  it('ignores parameters blocks that do not belong to a template', () => {
    assert.equal(completionContext('parameters:\n  \n', 1, 2), undefined);
  });
});

function pick(c: ReturnType<typeof completionContext>) {
  if (!c) {
    return undefined;
  }
  const rest: Partial<typeof c> = { ...c };
  delete rest.ref;
  return rest;
}

describe('checkTemplateParameters', () => {
  it('reports unknown, missing and wrong values', () => {
    const [ref] = findTemplateRefs([
      '- template: deploy.yml',
      '  parameters:',
      '    environment: dev',
      '    runTests: maybe',
      '    retries: many',
      '    colour: blue',
      '    regions: ${{ parameters.regions }}',
    ].join('\n'));
    const issues = checkTemplateParameters(ref, declared);
    assert.deepEqual(issues.map(i => [i.severity, i.line, i.message]), [
      ['error', 2, "'dev' is not an allowed value of 'environment'. Allowed: staging, production"],
      ['error', 3, "'runTests' is a boolean: use true or false."],
      ['error', 4, "'retries' is a number."],
      ['warning', 5, "Unknown parameter 'colour'. Declared: environment, runTests, regions, retries, serviceConnection"],
      ['error', 0, 'Missing required parameter: serviceConnection'],
    ]);
  });

  it('skips the missing check for dynamic parameters and names templates without parameters', () => {
    const [ref] = findTemplateRefs('- template: x.yml\n  parameters:\n    ${{ insert }}: ${{ parameters }}\n');
    assert.deepEqual(checkTemplateParameters(ref, declared), []);
    const [plain] = findTemplateRefs('- template: x.yml\n  parameters:\n    a: 1\n');
    assert.match(checkTemplateParameters(plain, [])[0].message, /declares no parameters/);
    const [none] = findTemplateRefs('- template: x.yml\n');
    assert.equal(checkTemplateParameters(none, declared)[0].message, 'Missing required parameters: environment, serviceConnection');
  });
});

describe('describing parameters', () => {
  it('formats hover text and escapes Markdown', () => {
    assert.equal(mdEscape('[a](command:x) *b*'), '\\[a\\]\\(command:x\\) \\*b\\*');
    assert.equal(describeParameter(declared[0]), '**environment**: `string` · **required** · values: `staging`, `production`');
    assert.equal(describeParameter({ name: 'n', displayName: 'Name', type: 'string', default: 'x'.repeat(70) }),
      `**n** — Name: \`string\` · default: \`${'x'.repeat(57)}…\``);
    assert.equal(describeParameter({ name: 't', type: 'a` [x](https://contoso.com) `b', default: 'd' }),
      "**t**: `a' [x](https://contoso.com) 'b` · default: `d`");
  });

  it('builds snippets with choices or the default', () => {
    assert.equal(parameterSnippet(declared[0], 1), 'environment: ${1|staging,production|}');
    assert.equal(parameterSnippet(declared[1], 2), 'runTests: ${2|false,true|}');
    assert.equal(parameterSnippet(declared[3], 1), 'retries: ${1:3}');
    assert.equal(parameterSnippet(declared[4], 1), 'serviceConnection: ${1}');
    assert.equal(parameterSnippet({ name: 'p', type: 'string', default: '$(Build.Id)' }, 1), 'p: ${1:\\$(Build.Id)}');
    assert.equal(parameterSnippet({ name: 'o', type: 'object', default: '[\n  1\n]' }, 1), 'o: ${1}');
  });
});

describe('parsePreviewErrors', () => {
  it('reads file, line, column and message', () => {
    const msg = 'Encountered error(s) while parsing pipeline YAML:\n/azure-pipelines.yml (Line: 12, Col: 7): Unexpected value \'foo\'\n'
      + '/templates/x.yml@templates (Line: 3, Col: 1): A mapping was not expected\nno location here';
    assert.deepEqual(parsePreviewErrors(msg), [
      { file: '/azure-pipelines.yml', line: 12, col: 7, text: "Unexpected value 'foo'" },
      { file: '/templates/x.yml@templates', line: 3, col: 1, text: 'A mapping was not expected' },
    ]);
    assert.deepEqual(parsePreviewErrors('x (Line: a, Col: b): y'), []);
  });
});

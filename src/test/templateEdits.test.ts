import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyLineEdits, callReadOnlyReason, controlOf, findInsertionPoints, formatValue, indentUnit, isBranchRef, locationOf, newCallLines,
  normalizeEdits, planCallEdits, planRepositoryEdits, sameValue, stageNames, templateKind, toRangeEdits, yamlScalar,
} from '../pipelines/templateEdits';
import { findTemplateRefs } from '../pipelines/templateRefs';
import { PipelineParameter } from '../pipelines/yamlParameters';

const P = (name: string, extra: Partial<PipelineParameter> = {}): PipelineParameter => ({ name, type: 'string', ...extra });
const DECLARED: PipelineParameter[] = [
  P('projectPath', { default: '**/*.csproj' }),
  P('configuration', { values: ['Debug', 'Release'], default: 'Release' }),
  P('dotnetVersion', { values: ['8.0.x', '9.0.x', '10.0.x'], default: '10.0.x' }),
  P('runTests', { type: 'boolean', default: 'true' }),
  P('coverage', { type: 'number', default: '80' }),
  P('artifactName', { default: 'drop' }),
  P('appName'),
  P('extraSteps', { type: 'stepList', default: '[]' }),
];

const PIPELINE = [
  'trigger:',
  '- main',
  '',
  'resources:',
  '  repositories:',
  '  - repository: templates',
  '    type: git',
  '    name: Platform/pipeline-templates',
  '    ref: refs/tags/v2.1   # pinned',
  '',
  'stages:',
  '- stage: Build',
  '  jobs:',
  '  - job: Compile',
  '    pool:',
  '      vmImage: ubuntu-latest',
  '    steps:',
  '    - template: build/dotnet.yml@templates',
  '      parameters:',
  "        projectPath: 'src/Contoso.Api/Contoso.Api.csproj'  # the API",
  '        dotnetVersion: 9.0.x',
  '        artifactName: contoso-api',
  '    - script: echo done',
  '- stage: Deploy',
  '  jobs:',
  '  - deployment: Web',
  '    environment: contoso-staging',
  '    strategy:',
  '      runOnce:',
  '        deploy:',
  '          steps:',
  '          - template: deploy/app-service.yml@templates',
  '',
].join('\n');

const apply = (text: string, edits: Parameters<typeof applyLineEdits>[1]) => applyLineEdits(text, edits).text;
const firstRef = (text: string) => findTemplateRefs(text)[0];

describe('yamlScalar / formatValue', () => {
  it('quotes only when needed', () => {
    assert.equal(yamlScalar('drop'), 'drop');
    assert.equal(yamlScalar('8.0.x'), '8.0.x');
    assert.equal(yamlScalar(''), "''");
    assert.equal(yamlScalar('**/*.csproj'), "'**/*.csproj'");
    assert.equal(yamlScalar('$(Build.BuildId)'), "'$(Build.BuildId)'");
    assert.equal(yamlScalar('a: b'), "'a: b'");
    assert.equal(yamlScalar('# not a comment'), "'# not a comment'");
    assert.equal(yamlScalar(' padded'), "' padded'");
    assert.equal(yamlScalar("it's"), "it's");
    assert.equal(yamlScalar("'quoted'"), "'''quoted'''");
    assert.equal(yamlScalar('true'), "'true'");
    assert.equal(yamlScalar('-x'), "'-x'");
    assert.equal(yamlScalar('two\nlines "x" \\'), String.raw`"two\nlines \"x\" \\"`);
  });

  it('writes booleans and numbers unquoted', () => {
    assert.equal(formatValue(P('b', { type: 'boolean' }), 'True'), 'true');
    assert.equal(formatValue(P('b', { type: 'boolean' }), 'maybe'), 'maybe');
    assert.equal(formatValue(P('n', { type: 'number' }), ' 42 '), '42');
    assert.equal(formatValue(P('n', { type: 'number' }), 'many'), 'many');
    assert.equal(formatValue(P('s'), 'true'), "'true'");
  });

  it('compares values by type', () => {
    assert.equal(sameValue(P('b', { type: 'boolean' }), 'True', 'true'), true);
    assert.equal(sameValue(P('n', { type: 'number' }), '80', '80.0'), true);
    assert.equal(sameValue(P('n', { type: 'number' }), 'x', 'x'), true);
    assert.equal(sameValue(P('s'), 'a', 'A'), false);
    assert.equal(sameValue(P('s'), undefined, undefined), true);
    assert.equal(sameValue(P('s'), undefined, ''), false);
  });

  it('maps types to controls', () => {
    assert.deepEqual(DECLARED.map(controlOf), ['text', 'enum', 'enum', 'boolean', 'number', 'text', 'text', 'raw']);
    assert.equal(controlOf(P('o', { type: 'object' })), 'raw');
  });
});

describe('planCallEdits', () => {
  const ref = () => findTemplateRefs(PIPELINE)[0];

  it('changes a value and keeps quotes, comments and other lines', () => {
    const plan = planCallEdits(PIPELINE, ref(), DECLARED, { projectPath: 'src/Contoso.Web/*.csproj', dotnetVersion: '9.0.x' }, { writeDefaults: false });
    assert.equal(plan.readOnly, undefined);
    assert.deepEqual(plan.edits, [{ line: 19, deleteCount: 1, insert: ["        projectPath: 'src/Contoso.Web/*.csproj'  # the API"] }]);
  });

  it('adds parameters under the existing block and removes values equal to the default', () => {
    const plan = planCallEdits(PIPELINE, ref(), DECLARED, { dotnetVersion: '10.0.x', runTests: 'false', appName: 'contoso-api' }, { writeDefaults: false });
    const out = applyLineEdits(PIPELINE, plan.edits);
    const lines = out.text.split('\n');
    assert.deepEqual(lines.slice(17, 24), [
      '    - template: build/dotnet.yml@templates',
      '      parameters:',
      "        projectPath: 'src/Contoso.Api/Contoso.Api.csproj'  # the API",
      '        artifactName: contoso-api',
      '        runTests: false',
      '        appName: contoso-api',
      '    - script: echo done',
    ]);
    assert.deepEqual([...out.marks], [[21, '+'], [22, '+']], 'the removed line is gone, the new ones are marked');
  });

  it('writes defaults explicitly when asked', () => {
    const plan = planCallEdits(PIPELINE, ref(), DECLARED, { dotnetVersion: '10.0.x' }, { writeDefaults: true });
    const added = applyLineEdits(PIPELINE, plan.edits).text.split('\n').slice(20, 27);
    assert.deepEqual(added, [
      '        dotnetVersion: 10.0.x',
      '        artifactName: contoso-api',
      '        configuration: Release',
      '        runTests: true',
      '        coverage: 80',
      '        extraSteps: []',
      '    - script: echo done',
    ]);
  });

  it('adds a parameters key to a call without one and removes it again when empty', () => {
    const deploy = findTemplateRefs(PIPELINE)[1];
    const declared = [P('environment', { values: ['dev', 'staging'], default: 'dev' }), P('appName')];
    const plan = planCallEdits(PIPELINE, deploy, declared, { environment: 'staging', appName: 'contoso-web' }, { writeDefaults: false });
    const text = apply(PIPELINE, plan.edits);
    assert.deepEqual(text.split('\n').slice(31, 35), [
      '          - template: deploy/app-service.yml@templates',
      '            parameters:',
      '              environment: staging',
      '              appName: contoso-web',
    ]);
    const back = planCallEdits(text, findTemplateRefs(text)[1], declared, { environment: 'dev', appName: 'contoso-web' }, { writeDefaults: false });
    const again = apply(text, back.edits);
    assert.match(again, /parameters:\n {14}appName: contoso-web\n$/);
    const none = planCallEdits(again, findTemplateRefs(again)[1], [P('appName', { default: 'x' })], { appName: 'x' }, { writeDefaults: false });
    assert.equal(apply(again, none.edits), PIPELINE);
  });

  it('leaves conditional and block parameters alone and edits the others', () => {
    const text = [
      'steps:',
      '- template: steps.yml',
      '  parameters:',
      '    name: |',
      '      multi',
      '      line',
      "    ${{ if eq(variables['Build.Reason'], 'PullRequest') }}:",
      '      flag: true',
      '    ${{ else }}:',
      '      flag: false',
      '    extraSteps:',
      '    - script: echo',
      '- script: done',
    ].join('\n');
    const declared = [P('name', { default: 'x' }), P('flag', { type: 'boolean', default: 'false' }), P('extraSteps', { type: 'stepList', default: '[]' }),
      P('level', { values: ['low', 'high'], default: 'low' })];
    const r = firstRef(text);
    assert.equal(r.dynamicParams, true);
    assert.equal(callReadOnlyReason(text, r), undefined, 'if/else keys only make their own parameters read-only');
    const plan = planCallEdits(text, r, declared, { name: 'y', flag: 'true', extraSteps: '- script: echo', level: 'high' }, { writeDefaults: false });
    assert.deepEqual(plan.edits, [{ line: 12, deleteCount: 0, insert: ['    level: high'] }], 'an unchanged step list stays as it is');
    const reset = planCallEdits(text, r, declared, { extraSteps: '[]' }, { writeDefaults: false });
    assert.deepEqual(reset.edits, [{ line: 10, deleteCount: 2, insert: [] }], 'the default value removes the whole block');
  });

  it('keeps calls with each, insert or expression keys read-only', () => {
    for (const key of ['${{ each p in parameters.list }}', '${{ insert }}', '${{ parameters.name }}']) {
      const text = `steps:\n- template: a.yml\n  parameters:\n    ${key}:\n      x: 1\n`;
      assert.match(callReadOnlyReason(text, firstRef(text)) ?? '', /expressions/, key);
    }
  });

  it('refuses calls it cannot edit', () => {
    assert.match(planCallEdits('steps:\n- template: ${{ parameters.t }}\n', firstRef('steps:\n- template: ${{ parameters.t }}\n'), [], {}, { writeDefaults: false }).readOnly ?? '', /expression/);
    const flow = 'steps:\n- template: a.yml\n  parameters: { x: 1 }\n';
    assert.match(planCallEdits(flow, firstRef(flow), [P('x')], { x: '2' }, { writeDefaults: false }).readOnly ?? '', /flow mapping/);
    const dynamic = 'steps:\n- template: a.yml\n  parameters: ${{ parameters }}\n';
    assert.match(callReadOnlyReason(dynamic, firstRef(dynamic)) ?? '', /expressions/);
  });

  it('fills an empty parameters key and a null value', () => {
    const text = 'steps:\n- template: a.yml\n  parameters:\n- script: echo\n';
    const plan = planCallEdits(text, firstRef(text), [P('x')], { x: 'v' }, { writeDefaults: false });
    assert.equal(apply(text, plan.edits), 'steps:\n- template: a.yml\n  parameters:\n    x: v\n- script: echo\n');
    const nul = 'steps:\n- template: a.yml\n  parameters:\n    x:\n';
    const plan2 = planCallEdits(nul, firstRef(nul), [P('x')], { x: 'v' }, { writeDefaults: false });
    assert.equal(apply(nul, plan2.edits), 'steps:\n- template: a.yml\n  parameters:\n    x: v\n');
  });

  it('works on extends and with four-space indentation', () => {
    const text = 'extends:\n    template: base.yml@templates\n    parameters:\n        pool: linux\n';
    assert.equal(indentUnit(text), 4);
    const plan = planCallEdits(text, firstRef(text), [P('pool'), P('stage', { default: 'all' })], { stage: 'build' }, { writeDefaults: false });
    assert.equal(apply(text, plan.edits), 'extends:\n    template: base.yml@templates\n    parameters:\n        pool: linux\n        stage: build\n');
  });
});

describe('planCallEdits for object and list parameters', () => {
  const CALL = [
    'stages:',
    '- template: deploy/web-app.yml@templates',
    '  parameters:',
    '    environment: dev',
    '    appSettings:',
    '      ASPNETCORE_ENVIRONMENT: Development',
    '      AllowedHosts:',
    '      - dev.contoso.example',
    '    preDeploySteps:',
    '    - script: dotnet ef database update',
    '    - script: |',
    '        echo "warming up"',
    '        curl --fail https://dev.contoso.example/warmup',
    '- stage: After',
  ].join('\n');
  const declared = [
    P('environment', { default: 'dev' }),
    P('appSettings', { type: 'object', default: '{}' }),
    P('preDeploySteps', { type: 'stepList', default: '[]' }),
    P('slots', { type: 'object' }),
  ];
  const plan = (text: string, pending: Record<string, string>, writeDefaults = false, decl = declared) =>
    planCallEdits(text, firstRef(text), decl, pending, { writeDefaults });
  const lines = (text: string) => text.split('\n');

  it('replaces a nested block, including a trailing script block', () => {
    const out = apply(CALL, plan(CALL, { preDeploySteps: '- script: echo contoso' }).edits);
    assert.deepEqual(lines(out).slice(8), ['    preDeploySteps:', '    - script: echo contoso', '- stage: After'], 'the script lines go with the block');
    const obj = apply(CALL, plan(CALL, { appSettings: 'ASPNETCORE_ENVIRONMENT: Production\nAllowedHosts:\n- dev.contoso.example' }).edits);
    assert.deepEqual(lines(obj).slice(4, 9), [
      '    appSettings:', '      ASPNETCORE_ENVIRONMENT: Production', '      AllowedHosts:', '      - dev.contoso.example', '    preDeploySteps:',
    ]);
    assert.deepEqual(plan(CALL, { appSettings: '  ASPNETCORE_ENVIRONMENT: Development\n  AllowedHosts:\n  - dev.contoso.example\n' }).edits, [],
      'the same text, differently indented, changes nothing');
  });

  it('keeps a list at the key column and writes inline values on one line', () => {
    const text = 'steps:\n- template: a.yml\n  parameters:\n    steps:\n    - script: a\n    x: 1\n';
    const decl = [P('steps', { type: 'stepList' }), P('x')];
    assert.equal(apply(text, plan(text, { steps: '- script: b\n- script: c' }, false, decl).edits),
      'steps:\n- template: a.yml\n  parameters:\n    steps:\n    - script: b\n    - script: c\n    x: 1\n');
    assert.equal(apply(text, plan(text, { steps: '${{ parameters.steps }}' }, false, decl).edits),
      'steps:\n- template: a.yml\n  parameters:\n    steps: ${{ parameters.steps }}\n    x: 1\n');
    const inline = 'steps:\n- template: a.yml\n  parameters:\n    steps: []\n';
    assert.equal(apply(inline, plan(inline, { steps: '- script: b' }, false, decl).edits),
      'steps:\n- template: a.yml\n  parameters:\n    steps:\n      - script: b\n');
  });

  it('removes a value equal to the default, and parameters: when nothing is left', () => {
    const out = apply(CALL, plan(CALL, { preDeploySteps: '[]', appSettings: '{}' }).edits);
    assert.deepEqual(lines(out), ['stages:', '- template: deploy/web-app.yml@templates', '  parameters:', '    environment: dev', '- stage: After']);
    const last = apply(out, plan(out, { environment: 'dev' }).edits);
    assert.equal(last, 'stages:\n- template: deploy/web-app.yml@templates\n- stage: After');
    const objOnly = 'steps:\n- template: a.yml\n  parameters:\n    steps:\n    - script: |\n        echo\n';
    assert.equal(apply(objOnly, plan(objOnly, { steps: '[]' }, false, [P('steps', { type: 'stepList', default: '[]' })]).edits), 'steps:\n- template: a.yml\n');
  });

  it('adds object values to a call, with or without parameters:', () => {
    const out = apply(CALL, plan(CALL, { slots: '- name: staging\n  swap: true' }).edits);
    assert.deepEqual(lines(out).slice(10, 17), [
      '    - script: |', '        echo "warming up"', '        curl --fail https://dev.contoso.example/warmup',
      '    slots:', '      - name: staging', '        swap: true', '- stage: After',
    ], 'new lines go after the script block');
    const bare = 'stages:\n- template: a.yml\n- stage: B\n';
    assert.equal(apply(bare, plan(bare, { slots: 'blue: 1' }).edits), 'stages:\n- template: a.yml\n  parameters:\n    slots:\n      blue: 1\n- stage: B\n');
    assert.equal(apply(bare, plan(bare, { appSettings: '{}' }).edits), bare, 'the default is not written');
  });

  it('writes object defaults on request and leaves invalid, empty and conditional values alone', () => {
    const bare = 'stages:\n- template: a.yml\n';
    const decl = [P('appSettings', { type: 'object', default: '{"Logging": {"Level": "Debug"}}' }), P('steps', { type: 'stepList', default: '[]' }), P('none', { type: 'object' })];
    assert.equal(apply(bare, plan(bare, {}, true, decl).edits),
      'stages:\n- template: a.yml\n  parameters:\n    appSettings:\n      Logging:\n        Level: Debug\n    steps: []\n');
    assert.equal(apply(bare, plan(bare, { steps: '[]' }, true, decl).edits), 'stages:\n- template: a.yml\n  parameters:\n    appSettings:\n      Logging:\n        Level: Debug\n    steps: []\n');
    assert.deepEqual(plan(CALL, { preDeploySteps: 'script: x' }).edits, [], 'a step list without dashes is not written');
    assert.deepEqual(plan(CALL, { preDeploySteps: '\n' }).edits, [], 'an empty value is not written');
    assert.deepEqual(plan(CALL, { appSettings: 'a:\n\tb: 1' }).edits, []);
    const cond = [
      'steps:', '- template: a.yml', '  parameters:', '    ${{ if eq(parameters.hotfix, true) }}:', '      steps:', '      - script: hotfix', '    x: 1',
    ].join('\n');
    const decl2 = [P('steps', { type: 'stepList', default: '[]' }), P('x')];
    assert.deepEqual(plan(cond, { steps: '- script: other', x: '2' }, false, decl2).edits, [{ line: 6, deleteCount: 1, insert: ['    x: 2'] }]);
  });

  it('inserts a scalar parameter after a block that ends in a script block', () => {
    const out = apply(CALL, plan(CALL, { environment: 'prod' }, false, [...declared, P('region', { default: 'westeurope' })]).edits);
    assert.equal(lines(out)[3], '    environment: prod');
    const added = apply(CALL, plan(CALL, { region: 'northeurope' }, false, [...declared, P('region', { default: 'westeurope' })]).edits);
    assert.deepEqual(lines(added).slice(11, 15), ['        echo "warming up"', '        curl --fail https://dev.contoso.example/warmup', '    region: northeurope', '- stage: After']);
  });

  it('writes object values into new calls', () => {
    const decl = [P('appSettings', { type: 'object', default: '{"Level": "Info"}' }), P('steps', { type: 'stepList' }), P('bad', { type: 'stepList' })];
    assert.deepEqual(newCallLines('a.yml', decl, { steps: '- script: echo', bad: 'script: x' }, 2, 2, { writeDefaults: false }),
      ['  - template: a.yml', '    parameters:', '      steps:', '        - script: echo']);
    assert.deepEqual(newCallLines('a.yml', decl, { appSettings: 'Level: Info' }, 0, 2, { writeDefaults: false }), ['- template: a.yml'], 'equal to the default');
    assert.deepEqual(newCallLines('a.yml', decl, {}, 0, 2, { writeDefaults: true }), ['- template: a.yml', '  parameters:', '    appSettings:', '      Level: Info']);
    assert.deepEqual(newCallLines('a.yml', decl, { appSettings: 'Level: Info' }, 0, 2, { writeDefaults: true }),
      ['- template: a.yml', '  parameters:', '    appSettings:', '      Level: Info']);
  });
});

describe('new calls and insertion points', () => {
  it('builds the lines of a new call', () => {
    const lines = newCallLines('build/node.yml@templates', [P('workingDirectory'), P('nodeVersion', { values: ['20.x', '22.x'], default: '22.x' }),
      P('runLint', { type: 'boolean', default: 'true' }), P('extra', { type: 'object' })], { runLint: 'false' }, 4, 2, { writeDefaults: false });
    assert.deepEqual(lines, ['    - template: build/node.yml@templates', '      parameters:', "        workingDirectory: ''", '        runLint: false']);
    assert.deepEqual(newCallLines('a.yml', [P('x', { default: '1' })], {}, 0, 2, { writeDefaults: false }), ['- template: a.yml']);
    assert.deepEqual(newCallLines('a.yml', [P('x', { default: '1' })], {}, 0, 2, { writeDefaults: true }), ['- template: a.yml', '  parameters:', '    x: 1']);
  });

  it('finds the lists a template can go to, with stage and job labels', () => {
    assert.deepEqual(findInsertionPoints(PIPELINE, 'steps').map(p => [p.line, p.indent, p.label, p.stage]), [
      [23, 4, 'Stage Build › Job Compile › steps', 'Build'],
      [32, 10, 'Stage Deploy › Job Web › steps', 'Deploy'],
    ]);
    assert.deepEqual(findInsertionPoints(PIPELINE, 'stages').map(p => [p.line, p.indent, p.label]), [[32, 0, 'stages']]);
    assert.deepEqual(findInsertionPoints('jobs:\n', 'jobs').map(p => [p.line, p.indent]), [[1, 2]]);
    assert.deepEqual(findInsertionPoints('steps: []\n', 'steps'), []);
    assert.deepEqual(findInsertionPoints('steps:\n  name: x\n', 'steps'), []);
    const strategies = 'jobs:\n- deployment: Web\n  strategy:\n    canary:\n      deploy:\n        steps:\n        - script: a\n    runOnce:\n      deploy:\n        steps:\n        - script: b\n';
    assert.deepEqual(findInsertionPoints(strategies, 'steps').map(p => p.label), ['Job Web › steps (line 6)', 'Job Web › steps (line 10)']);
    assert.deepEqual(stageNames(PIPELINE), ['Build', 'Deploy']);
    assert.deepEqual(locationOf(PIPELINE, 17), { stage: 'Build', job: 'Compile' });
    assert.deepEqual(locationOf(PIPELINE, 99), {});
  });

  it('inserts a call at the end of a list', () => {
    const point = findInsertionPoints(PIPELINE, 'steps')[0];
    const lines = newCallLines('test/unit-tests.yml@templates', [P('testProjects', { default: '**/*Tests.csproj' })], {}, point.indent, 2, { writeDefaults: false });
    const out = applyLineEdits(PIPELINE, [{ line: point.line, deleteCount: 0, insert: lines }]);
    assert.equal(out.text.split('\n')[23], '    - template: test/unit-tests.yml@templates');
    assert.deepEqual([...out.marks], [[23, '+']]);
  });

  it('reads the kind of a template', () => {
    assert.equal(templateKind('parameters:\n- name: x\nsteps:\n- script: a\n'), 'steps');
    assert.equal(templateKind('parameters: []\nstages:\n- stage: A\n'), 'stages');
    assert.equal(templateKind('parameters: []\n'), undefined);
  });
});

describe('planRepositoryEdits', () => {
  const repo = { alias: 'templates', name: 'Platform/pipeline-templates', type: 'git' };

  it('changes, adds and removes the ref of an existing entry', () => {
    const changed = apply(PIPELINE, planRepositoryEdits(PIPELINE, { ...repo, ref: 'refs/heads/main' }));
    assert.equal(changed.split('\n')[8], '    ref: refs/heads/main   # pinned');
    assert.deepEqual(planRepositoryEdits(PIPELINE, { ...repo, ref: 'refs/tags/v2.1' }), []);
    const removed = apply(PIPELINE, planRepositoryEdits(PIPELINE, repo));
    assert.equal(removed.split('\n')[8], '');
    const added = apply(removed, planRepositoryEdits(removed, { ...repo, ref: 'refs/tags/v3.0' }));
    assert.equal(added.split('\n')[8], '    ref: refs/tags/v3.0');
  });

  it('appends a new entry to the list', () => {
    const out = apply(PIPELINE, planRepositoryEdits(PIPELINE, { alias: 'tools', name: 'build-tools', type: 'git', ref: 'refs/tags/v1' }));
    assert.deepEqual(out.split('\n').slice(8, 14), [
      '    ref: refs/tags/v2.1   # pinned', '  - repository: tools', '    type: git', '    name: build-tools', '    ref: refs/tags/v1', '',
    ]);
  });

  it('creates repositories and resources when missing', () => {
    const noRepos = 'resources:\n  pipelines:\n  - pipeline: ci\n    source: Contoso CI\nsteps:\n- script: echo\n';
    assert.equal(apply(noRepos, planRepositoryEdits(noRepos, repo)),
      'resources:\n  pipelines:\n  - pipeline: ci\n    source: Contoso CI\n  repositories:\n  - repository: templates\n    type: git\n    name: Platform/pipeline-templates\nsteps:\n- script: echo\n');
    const none = 'trigger:\n- main\nstages:\n- stage: A\n';
    assert.equal(apply(none, planRepositoryEdits(none, { ...repo, ref: 'refs/tags/v1' })),
      'trigger:\n- main\n\nresources:\n  repositories:\n  - repository: templates\n    type: git\n    name: Platform/pipeline-templates\n    ref: refs/tags/v1\n\nstages:\n- stage: A\n');
    assert.equal(apply('', planRepositoryEdits('', repo)), 'resources:\n  repositories:\n  - repository: templates\n    type: git\n    name: Platform/pipeline-templates\n');
    const flow = 'resources:\n  repositories: []\n';
    assert.equal(apply(flow, planRepositoryEdits(flow, repo)), 'resources:\n  repositories:\n  - repository: templates\n    type: git\n    name: Platform/pipeline-templates\n');
  });

  it('tells branches from tags and commits', () => {
    assert.equal(isBranchRef('refs/heads/main'), true);
    assert.equal(isBranchRef('main'), true);
    assert.equal(isBranchRef(undefined), true);
    assert.equal(isBranchRef('refs/tags/v2.1'), false);
    assert.equal(isBranchRef('0123456789abcdef0123456789abcdef01234567'), false);
  });
});

describe('edit plumbing', () => {
  it('merges touching edits', () => {
    assert.deepEqual(normalizeEdits([{ line: 3, deleteCount: 0, insert: ['b'] }, { line: 2, deleteCount: 1, insert: ['a'] }]),
      [{ line: 2, deleteCount: 1, insert: ['a', 'b'] }]);
    assert.deepEqual(normalizeEdits([{ line: 5, deleteCount: 0, insert: ['x'] }, { line: 1, deleteCount: 1, insert: [] }]).length, 2);
  });

  it('converts to range edits, also at the end of the document and with CRLF', () => {
    assert.deepEqual(toRangeEdits('a\nb\nc', [{ line: 1, deleteCount: 1, insert: ['B'] }]), [{ startLine: 1, startChar: 0, endLine: 2, endChar: 0, text: 'B\n' }]);
    assert.deepEqual(toRangeEdits('a\nb', [{ line: 1, deleteCount: 1, insert: ['B', 'C'] }]), [{ startLine: 0, startChar: 1, endLine: 1, endChar: 1, text: '\nB\nC' }]);
    assert.deepEqual(toRangeEdits('a\nb', [{ line: 2, deleteCount: 0, insert: ['c'] }]), [{ startLine: 1, startChar: 1, endLine: 1, endChar: 1, text: '\nc' }]);
    assert.deepEqual(toRangeEdits('a\nb', [{ line: 1, deleteCount: 1, insert: [] }]), [{ startLine: 0, startChar: 1, endLine: 1, endChar: 1, text: '' }]);
    assert.deepEqual(toRangeEdits('a', [{ line: 0, deleteCount: 1, insert: ['x'] }]), [{ startLine: 0, startChar: 0, endLine: 0, endChar: 1, text: 'x' }]);
    assert.deepEqual(toRangeEdits('a\r\nb\r\n', [{ line: 1, deleteCount: 0, insert: ['x'] }]), [{ startLine: 1, startChar: 0, endLine: 1, endChar: 0, text: 'x\r\n' }]);
    assert.equal(applyLineEdits('a\r\nb', [{ line: 1, deleteCount: 0, insert: ['x'] }]).text, 'a\r\nx\r\nb');
  });
});

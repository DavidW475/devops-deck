import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  catalogItems, excerpt, fullPreview, paramViews, refLabel, refOptions, structure, targetPathIn, templatePathFor, topLevelBlock, unknownParams,
} from '../pipelines/designerModel';
import { findTemplateRefs } from '../pipelines/templateRefs';

const TEXT = [
  'parameters:',
  '- name: env',
  '  default: dev',
  'extends:',
  '  template: base.yml@templates',
  '  parameters:',
  '    pool: linux',
  '    oldName: x',
  '    note: |',
  '      long',
  "    ${{ if eq(parameters.env, 'prod') }}:",
  '      approvals: true',
].join('\n');

describe('designer model', () => {
  it('builds form rows with read-only reasons and errors', () => {
    const ref = findTemplateRefs(TEXT)[0];
    const declared = [
      { name: 'pool', type: 'string', values: ['linux', 'windows'], default: 'linux' },
      { name: 'note', type: 'string', default: '' },
      { name: 'approvals', type: 'boolean', default: 'false' },
      { name: 'retries', type: 'number', displayName: 'Retries' },
      { name: 'stages', type: 'stageList' },
    ];
    const rows = paramViews(TEXT, declared, ref, { pool: 'mac', retries: 'x' });
    assert.deepEqual(rows.map(r => [r.name, r.value, r.readOnly !== undefined, r.error, r.unsaved]), [
      ['pool', 'mac', false, "'mac' is not an allowed value of 'pool'. Allowed: linux, windows", true],
      ['note', '', true, undefined, false],
      ['approvals', 'true', true, undefined, false],
      ['retries', 'x', false, "'retries' is a number.", true],
      ['stages', '', false, 'Required: the template has no default.', false],
    ]);
    assert.equal(rows[3].label, 'Retries');
    assert.equal(rows[0].line, 6);
    assert.match(rows[1].readOnly!, /Multi-line/);
    assert.match(rows[2].readOnly!, /if/);
    assert.deepEqual(unknownParams(ref, declared), ['oldName']);
    assert.deepEqual(unknownParams(undefined, declared), []);
    const blank = paramViews(TEXT, [{ name: 'required', type: 'string' }], undefined, {});
    assert.equal(blank[0].error, 'Required: the template has no default.');
    assert.equal(paramViews(TEXT, declared, ref, { pool: 'mac' }, 'read only')[0].value, 'linux', 'pending values are ignored on read-only calls');
  });

  it('builds rows for object and list parameters from the file, the default or the pending YAML', () => {
    const text = [
      'stages:',
      '- template: deploy/web-app.yml@templates',
      '  parameters:',
      '    appSettings:',
      '      ASPNETCORE_ENVIRONMENT: Development',
      '      AllowedHosts:',
      '      - contoso.example',
      '    preDeploySteps:',
      '    # migrations first',
      '    - script: |',
      '        echo warm up',
      '    note: |',
      '      text',
      '    stages: []',
      '    empty:',
      '    ${{ if eq(parameters.hotfix, true) }}:',
      '      hotfixSteps:',
      "      - script: echo 'hotfix'",
    ].join('\n');
    const ref = findTemplateRefs(text)[0];
    const declared = [
      { name: 'appSettings', type: 'object' },
      { name: 'preDeploySteps', type: 'stepList', default: '[]' },
      { name: 'note', type: 'object' },
      { name: 'stages', type: 'stageList' },
      { name: 'empty', type: 'object' },
      { name: 'hotfixSteps', type: 'stepList', default: '[]' },
      { name: 'tags', type: 'object', default: '{"team": "webshop"}' },
      { name: 'job', type: 'job' },
    ];
    const rows = paramViews(text, declared, ref, {});
    const row = (name: string) => rows.find(r => r.name === name)!;
    assert.equal(row('appSettings').value, 'ASPNETCORE_ENVIRONMENT: Development\nAllowedHosts:\n- contoso.example');
    assert.deepEqual(row('appSettings').tree, { kind: 'map', entries: [
      { key: 'ASPNETCORE_ENVIRONMENT', value: { kind: 'text', text: 'Development' } },
      { key: 'AllowedHosts', value: { kind: 'list', items: [{ kind: 'text', text: 'contoso.example' }] } },
    ] });
    assert.equal(row('appSettings').control, 'raw');
    assert.equal(row('appSettings').line, 3);
    assert.equal(row('preDeploySteps').value, '# migrations first\n- script: |\n    echo warm up', 'comments and script blocks stay');
    assert.equal(row('preDeploySteps').tree, undefined, 'lists of steps are YAML text only');
    assert.equal(row('note').value, '|\n  text');
    assert.equal(row('note').tree, undefined, 'no tree for a block scalar');
    assert.equal(row('stages').value, '[]');
    assert.equal(row('stages').error, undefined);
    assert.equal(row('empty').error, "Enter a value: '[]' is an empty list, '{}' an empty object.");
    assert.equal(row('empty').tree, undefined);
    assert.equal(row('hotfixSteps').readOnly, 'Set inside ${{ if }} / ${{ each }}: edit it in the text.');
    assert.equal(row('hotfixSteps').value, "- script: echo 'hotfix'", 'a conditional entry shows the value written in the file');
    assert.equal(row('hotfixSteps').error, undefined);
    assert.equal(row('tags').value, 'team: webshop', 'the default, as YAML');
    assert.equal(row('tags').inFile, false);
    assert.equal(row('job').error, 'Required: the template has no default.');
    assert.ok(rows.every(r => !r.unsaved));

    const pending = paramViews(text, declared, ref, { appSettings: 'Logging:\n  LogLevel: Debug', stages: 'stage: Build', tags: '  team: webshop\n', job: '' });
    const prow = (name: string) => pending.find(r => r.name === name)!;
    assert.equal(prow('appSettings').unsaved, true);
    assert.deepEqual(prow('appSettings').tree, { kind: 'map', entries: [
      { key: 'Logging', value: { kind: 'map', entries: [{ key: 'LogLevel', value: { kind: 'text', text: 'Debug' } }] } },
    ] });
    assert.equal(prow('stages').error, "'stages' is a stageList: start every item with '- '.");
    assert.equal(prow('tags').unsaved, false, 'indentation and trailing lines do not count as a change');
    assert.equal(prow('job').error, 'Required: the template has no default.');
    const blank = paramViews(text, [{ name: 'extra', type: 'object', default: '{}' }], ref, { extra: '' });
    assert.deepEqual(blank[0].tree, { kind: 'map', entries: [] }, 'an empty optional object starts as an empty form');
    assert.equal(blank[0].error, undefined);
    const ro = paramViews(text, declared, ref, { appSettings: 'x: 1' }, 'read only');
    assert.equal(ro[0].value, 'ASPNETCORE_ENVIRONMENT: Development\nAllowedHosts:\n- contoso.example', 'pending values are ignored on read-only calls');
    assert.equal(ro[0].error, undefined);
  });

  it('groups calls by stage and labels them', () => {
    const text = 'stages:\n- template: a.yml\n- stage: Build\n  jobs:\n  - template: jobs/b.yml@tools\n- stage: Empty\n';
    const refs = findTemplateRefs(text);
    assert.deepEqual(structure(text, refs, 1).map(g => [g.name, g.items.map(i => [i.label, i.selected])]), [
      ['Pipeline', [['a.yml', false]]], ['Build', [['b.yml@tools', true]]], ['Empty', []],
    ]);
    const ext = findTemplateRefs(TEXT);
    assert.deepEqual(structure(TEXT, ext, undefined, { label: 'new.yml' }).map(g => [g.name, g.items.map(i => i.label)]), [
      ['Pipeline', ['new.yml']], ['Extends', ['base.yml@templates']],
    ]);
    assert.equal(refLabel(findTemplateRefs('steps:\n- template: ${{ parameters.t }}\n')[0]), '${{ parameters.t }}');
    assert.equal(refLabel(findTemplateRefs('steps:\n- template:\n')[0]), '(empty)');
  });

  it('cuts an excerpt around focus ranges and marks', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const lines = excerpt(text, new Map([[10, '+'], [11, '~']]), [[0, 1]], 1);
    assert.deepEqual(lines.map(l => l.no ?? '⋮'), [1, 2, 3, '⋮', 10, 11, 12, 13, '⋮']);
    assert.equal(lines.find(l => l.no === 11)!.mark, '+');
    assert.deepEqual(excerpt(text, new Map(), [[18, 19]], 1).map(l => l.no ?? '⋮'), ['⋮', 18, 19, 20]);
    assert.deepEqual(excerpt(text, new Map(), []), []);
    assert.equal(fullPreview(text, new Map([[0, '~']]), 3).length, 3);
    assert.deepEqual(topLevelBlock('a: 1\nresources:\n  repositories:\n  - repository: x\n\nsteps:\n', 'resources'), [1, 3]);
    assert.equal(topLevelBlock('steps:\n', 'resources'), undefined);
  });

  it('orders ref choices and keeps the declared ref', () => {
    const refs = { tags: ['refs/tags/v2.0', 'refs/tags/v10.1', 'refs/tags/v2.1'], branches: ['refs/heads/dev', 'refs/heads/master', 'refs/heads/main'] };
    assert.deepEqual(refOptions(refs).map(r => r.label), ['v10.1', 'v2.1', 'v2.0', 'main', 'master', 'dev']);
    assert.deepEqual(refOptions(refs, 'refs/tags/v1.0', 1).map(r => [r.label, r.kind]), [['v1.0', 'tag'], ['v10.1', 'tag'], ['main', 'branch']]);
    assert.equal(refOptions(refs, 'main').length, 6, 'a short branch name matches refs/heads/main');
    assert.equal(refOptions(refs, 'release')[0].kind, 'other');
  });

  it('maps references to catalog paths and back', () => {
    assert.equal(targetPathIn({ path: 'build/a.yml', alias: 'templates' }, 'templates', '/ci/azure-pipelines.yml'), '/build/a.yml');
    assert.equal(targetPathIn({ path: 'build/a.yml', alias: 'tools' }, 'templates', '/x.yml'), undefined);
    assert.equal(targetPathIn({ path: 'steps.yml' }, 'self', '/ci/azure-pipelines.yml'), '/ci/steps.yml');
    assert.equal(targetPathIn({ path: '/t/steps.yml', alias: 'self' }, 'self', '/ci/azure-pipelines.yml'), '/t/steps.yml');
    assert.equal(targetPathIn({ path: 'a.yml', alias: 'templates' }, 'self', '/x.yml'), undefined);
    assert.equal(targetPathIn(undefined, 'self', '/x.yml'), undefined);
    assert.equal(templatePathFor('/build/a.yml', 'templates', '/x.yml'), 'build/a.yml@templates');
    assert.equal(templatePathFor('/templates/a.yml', 'self', '/ci/azure-pipelines.yml'), '../templates/a.yml');
    const items = catalogItems([{ path: '/a.yml', parameters: [] }, { path: '/build/B.yml', kind: 'steps', parameters: [{ name: 'x', type: 'string' }] }],
      new Set(['/build/b.yml']), '/a.yml');
    assert.deepEqual(items.map(i => [i.folder, i.file, i.params, i.used, i.selected]), [['', 'a.yml', 0, false, true], ['build', 'B.yml', 1, true, false]]);
  });
});

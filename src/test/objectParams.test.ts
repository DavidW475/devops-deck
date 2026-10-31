import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  asTree, dedent, defaultText, defaultValue, isBlockScalarText, normalizeText, paramLines, passedText, parseValueText, sameStructured, structureIssue,
  toTree, TreeNode, treeIssue, treeLines, treeText, yamlScalar,
} from '../pipelines/objectParams';
import { PipelineParameter } from '../pipelines/yamlParameters';

const P = (name: string, type: string, extra: Partial<PipelineParameter> = {}): PipelineParameter => ({ name, type, ...extra });
const text = (s: string): TreeNode => ({ kind: 'text', text: s });
const map = (...entries: [string, TreeNode][]): TreeNode => ({ kind: 'map', entries: entries.map(([key, value]) => ({ key, value })) });
const list = (...items: TreeNode[]): TreeNode => ({ kind: 'list', items });

const SERVICES = [
  '- name: contoso-web',
  '  port: 8080',
  '  public: true',
  '  tags:',
  '  - frontend',
  '  - edge',
  "- name: 'contoso-api'",
  '  env:',
  '    ASPNETCORE_ENVIRONMENT: Production',
  "    ${{ if eq(parameters.region, 'westeurope') }}:",
  '      REGION: weu',
].join('\n');

describe('object parameters: tree and YAML text', () => {
  it('writes scalars plain where YAML allows it', () => {
    assert.equal(yamlScalar('contoso'), 'contoso');
    assert.deepEqual(treeLines(text('${{ parameters.region }}'), 2), ['${{ parameters.region }}']);
    assert.deepEqual(treeLines(text('build-$(Build.BuildId)'), 2), ['build-$(Build.BuildId)']);
    assert.deepEqual(treeLines(text('$(Build.BuildId)'), 2), ['$(Build.BuildId)']);
    assert.deepEqual(treeLines(text("${{ if eq(parameters.env, 'prod') }}"), 2), ["${{ if eq(parameters.env, 'prod') }}"]);
    assert.deepEqual(treeLines(text('${{ x }}: y'), 2), ["'${{ x }}: y'"], 'a colon inside still needs quotes');
    assert.deepEqual(treeLines(text('${{ x }} #1'), 2), ["'${{ x }} #1'"]);
    assert.deepEqual(treeLines(text(' ${{ x }}'), 2), ["' ${{ x }}'"]);
    assert.deepEqual(treeLines(text('true'), 2), ["'true'"], 'the string true stays a string');
    assert.deepEqual(treeLines(text(''), 2), ["''"]);
    assert.deepEqual(treeLines(text('8080'), 2), ['8080']);
    assert.deepEqual(treeLines({ kind: 'bool', value: false }, 2), ['false']);
  });

  it('writes multi-line text as a literal block, else double-quoted', () => {
    assert.deepEqual(treeLines(text('echo one\necho two'), 2), ['|-', '  echo one', '  echo two']);
    assert.deepEqual(treeLines(text('echo one\necho two\n'), 4), ['|', '    echo one', '    echo two']);
    assert.deepEqual(treeLines(text('  indented\nx'), 2), [String.raw`"  indented\nx"`]);
    assert.deepEqual(treeLines(text('trailing \nx'), 2), [String.raw`"trailing \nx"`]);
    assert.deepEqual(treeLines(text('two blank\n\n'), 2), [String.raw`"two blank\n\n"`]);
    assert.deepEqual(treeLines(map(['script', text('a\nb')]), 2), ['script: |-', '  a', '  b']);
    assert.deepEqual(treeLines(list(text('a\nb')), 2), ['- |-', '  a', '  b']);
  });

  it('turns parsed values into trees and back without changing them', () => {
    const value = parseValueText(SERVICES);
    const tree = toTree(value!);
    assert.equal(tree.kind, 'list');
    const back = treeText(tree, 2);
    assert.equal(back, [
      '- name: contoso-web',
      '  port: 8080',
      '  public: true',
      '  tags:',
      '    - frontend',
      '    - edge',
      '- name: contoso-api',
      '  env:',
      '    ASPNETCORE_ENVIRONMENT: Production',
      "    ${{ if eq(parameters.region, 'westeurope') }}:",
      '      REGION: weu',
    ].join('\n'));
    assert.ok(sameStructured(parseValueText(back), value));
    const nested = list(list(text('a'), text('b')), map(), list());
    assert.deepEqual(treeLines(nested, 2), ['- - a', '  - b', '- {}', '- []']);
    assert.deepEqual(treeLines(map(['empty', map()], ['none', list()]), 2), ['empty: {}', 'none: []']);
    assert.deepEqual(treeLines(map(), 2), ['{}']);
    assert.deepEqual(treeLines(list(), 2), ['[]']);
    assert.deepEqual(toTree(null), text(''));
    assert.deepEqual(toTree(true), { kind: 'bool', value: true });
  });

  it('accepts only well-formed trees from the webview', () => {
    const good = map(['a', list(text('x'), { kind: 'bool', value: true })]);
    assert.deepEqual(asTree(JSON.parse(JSON.stringify(good))), good);
    assert.deepEqual(asTree({ kind: 'text', text: 'x', extra: 1 }), text('x'));
    for (const bad of [undefined, null, 'x', [], { kind: 'text' }, { kind: 'bool', value: 'yes' }, { kind: 'list', items: [1] },
      { kind: 'map', entries: [{ key: 1, value: text('x') }] }, { kind: 'map', entries: [{ key: 'k' }] }, { kind: 'map', entries: [7] },
      { kind: 'list' }, { kind: 'other' }]) {
      assert.equal(asTree(bad), undefined, JSON.stringify(bad));
    }
    let deep: TreeNode = text('x');
    for (let i = 0; i < 45; i++) {
      deep = list(deep);
    }
    assert.equal(asTree(deep), undefined, 'too deep');
    assert.equal(asTree(list(...Array.from({ length: 6000 }, () => text('x')))), undefined, 'too many nodes');
  });

  it('reports empty and duplicate keys with their path', () => {
    assert.equal(treeIssue(map(['a', text('1')])), undefined);
    assert.equal(treeIssue(text('x')), undefined);
    assert.equal(treeIssue(map(['', text('1')])), 'A key is empty.');
    assert.equal(treeIssue(map(['a', text('1')], ['a', text('2')])), "The key 'a' is there twice.");
    assert.equal(treeIssue(map(['env', map(['x', text('1')], [' ', text('2')])])), "A key under 'env' is empty.");
    assert.equal(treeIssue(map(['env', map(['x', text('1')], ['x', text('2')])])), "The key 'env.x' is there twice.");
    assert.equal(treeIssue(list(map(['ok', text('1')]), map(['k', text('1')], ['k', text('1')]))), "The key '[1].k' is there twice.");
    assert.equal(treeIssue(map(['svc', list(map(['', text('1')]))])), "A key under 'svc[0]' is empty.");
  });
});

describe('object parameters: defaults, checks and lines', () => {
  it('reads defaults from JSON, YAML flow and plain text', () => {
    assert.deepEqual(defaultValue(P('o', 'object', { default: '{\n  "replicas": 3,\n  "debug": false,\n  "tags": ["a", null]\n}' })),
      { replicas: '3', debug: false, tags: ['a', null] });
    assert.deepEqual(defaultValue(P('o', 'object', { default: '{"__proto__": {"x": 1}}' })), JSON.parse('{"__proto__": {"x": "1"}}'));
    assert.deepEqual(defaultValue(P('o', 'object', { default: '[a, b]' })), ['a', 'b'], 'not JSON: read as a YAML flow list');
    assert.equal(defaultValue(P('o', 'object', { default: 'contoso' })), 'contoso');
    assert.equal(defaultValue(P('o', 'object', { default: '' })), '');
    assert.equal(defaultValue(P('o', 'object')), undefined);
    assert.equal(defaultText(P('o', 'object', { default: '{"pool": {"vmImage": "ubuntu-latest"}}' }), 4), 'pool:\n    vmImage: ubuntu-latest');
    assert.equal(defaultText(P('s', 'stepList', { default: '[]' }), 2), '[]');
    assert.equal(defaultText(P('s', 'stepList'), 2), undefined);
  });

  it('compares values regardless of formatting', () => {
    assert.ok(sameStructured(parseValueText('a: 1\nb: [x]'), parseValueText('a: 1\nb:\n- x')));
    assert.ok(sameStructured(null, ''));
    assert.ok(sameStructured(undefined, ''));
    assert.ok(!sameStructured(parseValueText('a: 1'), parseValueText('a: 2')));
  });

  it('removes common indentation and trailing blank lines', () => {
    assert.deepEqual(dedent(['    a: 1', '  # note', '      b: 2  ', '']), ['a: 1', '# note', '  b: 2', '']);
    assert.deepEqual(dedent(['', '  # only a comment']), ['', '  # only a comment'], 'nothing to align comments with');
    assert.equal(normalizeText('\n    a: 1\n    b:\n      - x\n\n\n'), '\na: 1\nb:\n  - x');
    assert.equal(normalizeText(''), '');
    assert.ok(isBlockScalarText('|\n  text'));
    assert.ok(isBlockScalarText('  >-'));
    assert.ok(!isBlockScalarText('a: |'));
  });

  it('checks the YAML text against the parameter type', () => {
    assert.match(structureIssue(P('o', 'object'), 'a:\n\tb: 1') ?? '', /tabs/);
    assert.equal(structureIssue(P('o', 'object'), ''), undefined);
    assert.equal(structureIssue(P('o', 'object'), 'just text'), undefined);
    assert.equal(structureIssue(P('s', 'stepList'), '- script: echo'), undefined);
    assert.equal(structureIssue(P('s', 'stepList'), '${{ parameters.steps }}'), undefined, 'an expression passes the value through');
    assert.equal(structureIssue(P('s', 'stepList'), '|\n  text'), undefined);
    assert.equal(structureIssue(P('s', 'stepList'), 'script: echo'), "'s' is a stepList: start every item with '- '.");
    assert.equal(structureIssue(P('j', 'jobList'), 'job: A'), "'j' is a jobList: start every item with '- '.");
    assert.equal(structureIssue(P('st', 'step'), 'script: echo'), undefined);
    assert.equal(structureIssue(P('st', 'step'), '- script: echo'), "'st' is a single step: write it as keys and values.");
    assert.equal(structureIssue(P('stage', 'stage'), 'Build'), "'stage' is a single stage: write it as keys and values.");
  });

  it('writes values inline or as a nested block', () => {
    assert.deepEqual(paramLines('steps', '[]', 4, 6), ['    steps: []']);
    assert.deepEqual(paramLines('config', '{ a: 1 }', 4, 6), ['    config: { a: 1 }']);
    assert.deepEqual(paramLines('steps', '${{ parameters.steps }}', 4, 6), ['    steps: ${{ parameters.steps }}']);
    assert.deepEqual(paramLines('name', '', 0, 2), ["name: ''"]);
    assert.deepEqual(paramLines('steps', '- script: echo', 4, 4), ['    steps:', '    - script: echo'], 'a list can stay at the key column');
    assert.deepEqual(paramLines('pool', '  vmImage: ubuntu-latest\n\n  demands: []\n', 2, 4),
      ['  pool:', '    vmImage: ubuntu-latest', '', '    demands: []']);
    assert.deepEqual(paramLines('note', '|\n  line one\n  line two', 2, 2), ['  note: |', '   line one', '   line two'],
      'block scalar lines go right of the key');
    assert.deepEqual(paramLines('note', '|-\n    deeper', 0, 4), ['note: |-', '    deeper']);
    assert.deepEqual(paramLines('my key', '-', 0, 2), ['my key:', '  -']);
    assert.deepEqual(paramLines('a: b', 'x', 0, 2), ["'a: b': x"]);
  });

  it('reads the passed value of a key', () => {
    const lines = ['  parameters:', '    services:', '    - name: contoso-web', '      # port below', '      port: 8080', '    flag: true'];
    assert.deepEqual(passedText(lines, 1, '', 4), { text: '- name: contoso-web\n  # port below\n  port: 8080', end: 4, childCol: 4 });
    assert.deepEqual(passedText(lines, 5, 'true', 5), { text: 'true', end: 5 });
    const block = ['x:', '  note: |', '    one', '    two'];
    assert.deepEqual(passedText(block, 1, '|', 3), { text: '|\n  one\n  two', end: 3, childCol: 4 });
    assert.deepEqual(passedText(['a:', '  b:'], 1, '', 1), { text: '', end: 1, childCol: undefined });
  });
});

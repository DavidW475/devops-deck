import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RetiredTask, TaskCompletionContext, TaskIndex, TaskInfo, TaskInput, TaskStepRef } from '../pipelines/taskModel';
import { asTemplateRef, checkTaskStep, findDisplayName, findTaskSteps, newestMajor, parseTaskRef, taskCompletionContext, toParameter } from '../pipelines/taskRefs';

function input(name: string, extra: Partial<TaskInput> = {}): TaskInput {
  return {
    name, yamlName: extra.aliases?.[0] ?? name, aliases: [], label: name, required: false, type: 'string', options: [], editable: false,
    multi: false, ...extra,
  };
}

function info(major: number, inputs: TaskInput[], extra: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: '00000000-0000-0000-0000-00000000000' + major, name: 'ContosoDeploy', title: 'Contoso deploy', description: '', category: 'Deploy',
    major, version: major + '.0.0', deprecated: false, preview: false, groups: [], inputs, ...extra,
  };
}

function fakeIndex(tasks: TaskInfo[]): TaskIndex {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return {
    all: () => tasks,
    find: (name, major) => tasks.find(t => (same(t.name, name) || same(t.id, name)) && t.major === major),
    majors: name => tasks.filter(t => same(t.name, name)).map(t => t.major).sort((a, b) => b - a),
    knowsName: name => tasks.some(t => same(t.name, name)),
  };
}

const deployInputs = [
  input('environment', { required: true }),
  input('mode', { type: 'picklist', options: [{ value: 'fast', label: 'Fast' }, { value: 'safe', label: 'Safe' }], default: 'fast' }),
  input('subscription', { aliases: ['azureSubscription'], required: true }),
  input('scriptLocation', { type: 'radio', options: [{ value: 'inline', label: 'Inline' }, { value: 'path', label: 'Path' }], default: 'inline' }),
  input('script', { required: true, visibleRule: 'scriptLocation = inline' }),
  input('retries', { type: 'int' }),
  input('verbose', { type: 'boolean' }),
  input('region', { type: 'picklist', options: [{ value: 'north', label: 'North' }], editable: true }),
  input('tags', { type: 'picklist', options: [{ value: 'a', label: 'A' }], multi: true }),
  input('dynamicList', { type: 'picklist' }),
  input('withDefault', { required: true, default: 'x' }),
];
const index = fakeIndex([info(1, deployInputs), info(2, [input('x')]), info(3, [input('x')], { preview: true })]);
const fresh = { catalogFresh: true, versionHints: false };

const stepOf = (yaml: string): TaskStepRef => {
  const steps = findTaskSteps(yaml);
  assert.equal(steps.length, 1);
  return steps[0];
};
const check = (yaml: string, opts: Partial<Parameters<typeof checkTaskStep>[2]> = {}, idx = index) =>
  checkTaskStep(stepOf(yaml), idx, { ...fresh, ...opts });

const complete = (marked: string): TaskCompletionContext | undefined => {
  const text = marked.replace('|', '');
  const offset = marked.indexOf('|');
  const before = text.slice(0, offset).split('\n');
  return taskCompletionContext(text, before.length - 1, before.at(-1)!.length);
};

describe('parseTaskRef', () => {
  it('reads name and major', () => {
    assert.deepEqual(parseTaskRef('AzureCLI@2'), { name: 'AzureCLI', major: 2, pinned: undefined });
    assert.deepEqual(parseTaskRef("'AzureCLI@2'"), { name: 'AzureCLI', major: 2, pinned: undefined });
  });
  it('reads a pinned version and a GUID', () => {
    assert.equal(parseTaskRef('GoTool@0.3.1')?.pinned, '0.3.1');
    assert.equal(parseTaskRef('GoTool@0.3.1')?.major, 0);
    assert.equal(parseTaskRef('9c3e8943-130d-4c78-ac63-8af81df62dfb@1')?.major, 1);
  });
  it('rejects expressions and other forms', () => {
    for (const bad of ['${{ parameters.t }}', 'Task@${{ x }}', '$(t)@1', 'AzureCLI', '@2', 'A@', 'A@x', 'A@1.', 'A B@1', '']) {
      assert.equal(parseTaskRef(bad), undefined, bad);
    }
  });
});

describe('findTaskSteps', () => {
  it('finds steps with their inputs, quoted values and comments', () => {
    const steps = findTaskSteps([
      'steps:',
      '- task: "ContosoDeploy@1" # deploy',
      '  displayName: Deploy',
      '  inputs:',
      '    environment: staging # comment',
      '    mode: "safe"',
      '- script: echo',
      "- task: 'ContosoDeploy@2'",
    ].join('\n'));
    assert.equal(steps.length, 2);
    const [a, b] = steps;
    assert.equal(a.name, 'ContosoDeploy');
    assert.equal(a.major, 1);
    assert.equal(a.raw, 'ContosoDeploy@1');
    assert.equal(a.line, 1);
    assert.equal(a.keyCol, 2);
    assert.equal(a.valueStart, 9);
    assert.equal(a.valueEnd, 24);
    assert.equal(a.inputsLine, 3);
    assert.equal(a.end, 6);
    assert.deepEqual(a.inputs.map(e => [e.name, e.value]), [['environment', 'staging'], ['mode', 'safe']]);
    assert.equal(b.line, 7);
    assert.equal(b.inputsLine, undefined);
  });

  it('handles CRLF', () => {
    const steps = findTaskSteps('steps:\r\n- task: ContosoDeploy@1\r\n  inputs:\r\n    environment: dev\r\n');
    assert.equal(steps[0].inputs[0].value, 'dev');
    assert.equal(steps[0].raw, 'ContosoDeploy@1');
  });

  it('ignores a task inside a block scalar and a plain key without dash', () => {
    const steps = findTaskSteps([
      'steps:',
      '- script: |',
      '    - task: ContosoDeploy@1',
      '    echo done',
      'task: ContosoDeploy@1',
    ].join('\n'));
    assert.equal(steps.length, 0);
  });

  it('includes a trailing block scalar in the step', () => {
    const steps = findTaskSteps(['- task: ContosoDeploy@1', '  inputs:', '    script: |', '      echo a', '', '      echo b', '- script: x'].join('\n'));
    assert.equal(steps[0].end, 6);
  });

  it('reads flow inputs', () => {
    const [s] = findTaskSteps('- task: ContosoDeploy@1\n  inputs: { environment: dev, "mode": safe }');
    assert.deepEqual(s.inputs.map(e => [e.name, e.value]), [['environment', 'dev'], ['mode', 'safe']]);
    assert.equal(s.dynamicInputs, false);
  });

  it('marks an expression as inputs dynamic', () => {
    const [s] = findTaskSteps('- task: ContosoDeploy@1\n  inputs: ${{ parameters.inputs }}');
    assert.equal(s.dynamicInputs, true);
    assert.deepEqual(s.inputs, []);
  });

  it('marks an each key as dynamic and takes conditional keys', () => {
    const [s] = findTaskSteps([
      '- task: ContosoDeploy@1',
      '  inputs:',
      '    environment: dev',
      '    ${{ if eq(parameters.fast, true) }}:',
      '      mode: fast',
      '    ${{ each p in parameters.more }}:',
      '      ${{ p.key }}: ${{ p.value }}',
    ].join('\n'));
    assert.equal(s.dynamicInputs, true);
    const mode = s.inputs.find(e => e.name === 'mode');
    assert.equal(mode?.conditional, true);
    assert.equal(s.inputs.find(e => e.name === 'environment')?.conditional, false);
  });

  it('keeps the expression task without a name', () => {
    const [s] = findTaskSteps('- task: ${{ parameters.task }}');
    assert.equal(s.name, undefined);
    assert.equal(s.raw, '${{ parameters.task }}');
  });

  it('finds the task of a stepList parameter and under an if', () => {
    const steps = findTaskSteps([
      'parameters:',
      '- name: extra',
      '  type: stepList',
      '  default:',
      '  - task: ContosoDeploy@1',
      'steps:',
      '- ${{ if eq(1, 1) }}:',
      '  - task: ContosoDeploy@2',
      '    inputs:',
      '      x: 1',
    ].join('\n'));
    assert.deepEqual(steps.map(s => s.major), [1, 2]);
    assert.equal(steps[1].inputs[0].name, 'x');
  });

  it('reports a pinned version', () => {
    assert.equal(stepOf('- task: GoTool@0.3.1').pinned, '0.3.1');
  });
});

describe('taskCompletionContext', () => {
  it('offers names for a bare new line, before any @, under steps', () => {
    const c = complete('steps:\n- task: Azu|');
    assert.equal(c?.kind, 'taskName');
    assert.ok(c?.kind === 'taskName');
    assert.equal(c.prefix, 'Azu');
    assert.equal(c.start, 8);
    assert.equal(c.end, 11);
    assert.equal(c.line, 1);
    assert.equal(c.step?.raw, 'Azu');
  });

  it('offers names on an empty value', () => {
    const c = complete('steps:\n- task: |');
    assert.ok(c?.kind === 'taskName');
    assert.equal(c.prefix, '');
    assert.equal(c.start, 8);
  });

  it('offers names inside quotes', () => {
    const c = complete("steps:\n- task: 'Azu|'");
    assert.ok(c?.kind === 'taskName');
    assert.equal(c.start, 9);
    assert.equal(c.end, 12);
  });

  it('offers names inside a parameters block (stepList) but not in arbitrary YAML', () => {
    assert.equal(complete('parameters:\n- name: s\n  type: stepList\n  default:\n  - task: Az|')?.kind, 'taskName');
    assert.equal(complete('- task: Az|'), undefined);
    assert.equal(complete('other:\n- task: Az|'), undefined);
  });

  it('offers versions after @, with or without steps', () => {
    const c = complete('- task: ContosoDeploy@|');
    assert.ok(c?.kind === 'taskVersion');
    assert.equal(c.name, 'ContosoDeploy');
    assert.equal(c.prefix, '');
    assert.equal(c.start, 22);
    const d = complete('steps:\n- task: ContosoDeploy@1|0');
    assert.ok(d?.kind === 'taskVersion');
    assert.equal(d.prefix, '1');
    assert.equal(d.end, 24);
  });

  it('completes the name when the cursor is left of an existing @', () => {
    const c = complete('steps:\n- task: Contoso|Deploy@1');
    assert.ok(c?.kind === 'taskName');
    assert.equal(c.end, 21);
  });

  it('is undefined on the key, in the comment and for expressions', () => {
    assert.equal(complete('steps:\n- ta|sk: A@1'), undefined);
    assert.equal(complete('steps:\n- task: A@1 # no|te'), undefined);
    assert.equal(complete('steps:\n- task: ${{ par|ameters.t }}'), undefined);
  });

  it('offers the inputs key beside a step without inputs', () => {
    const c = complete('steps:\n- task: ContosoDeploy@1\n  displayName: x\n  in|');
    assert.equal(c?.kind, 'inputsKey');
    assert.equal(complete('steps:\n- task: ContosoDeploy@1\n  |')?.kind, 'inputsKey');
    assert.equal(complete('steps:\n- task: ContosoDeploy@1\n  inputs:\n    a: b\n  |'), undefined);
    assert.equal(complete('steps:\n- task: ContosoDeploy@1\n  zz|'), undefined);
  });

  it('offers input names and values below inputs, also under an if', () => {
    const base = 'steps:\n- task: ContosoDeploy@1\n  inputs:\n';
    assert.equal(complete(base + '    |')?.kind, 'inputName');
    assert.equal(complete(base + '    env|')?.kind, 'inputName');
    const v = complete(base + '    mode: |');
    assert.ok(v?.kind === 'inputValue');
    assert.equal(v.name, 'mode');
    const q = complete(base + '    "mode": sa|');
    assert.ok(q?.kind === 'inputValue');
    assert.equal(q.name, 'mode');
    const nested = complete(base + '    ${{ if eq(1, 1) }}:\n      |');
    assert.equal(nested?.kind, 'inputName');
  });

  it('stays silent inside a block scalar, a comment and outside the step', () => {
    const base = 'steps:\n- task: ContosoDeploy@1\n  inputs:\n    script: >\n';
    assert.equal(complete(base + '      echo |'), undefined);
    assert.equal(complete('steps:\n- task: ContosoDeploy@1\n  inputs:\n    # no|te'), undefined);
    assert.equal(complete('steps:\n- script: x\n  inputs:\n    |'), undefined);
    assert.equal(taskCompletionContext('a: b', 5, 0), undefined);
  });
});

describe('checkTaskStep', () => {
  const ok = '- task: ContosoDeploy@1\n  inputs:\n    environment: dev\n    azureSubscription: sub\n    script: echo\n';

  it('has no findings for a complete step', () => {
    assert.deepEqual(check(ok), []);
  });

  it('has no findings for an expression task or a bare value', () => {
    assert.deepEqual(check('- task: ${{ parameters.t }}'), []);
    assert.deepEqual(check('- task: Azu'), []);
  });

  describe('missing input', () => {
    it('reports a required input without default', () => {
      const issues = check('- task: ContosoDeploy@1\n  inputs:\n    environment: dev\n    script: echo');
      assert.equal(issues.length, 1);
      assert.equal(issues[0].code, 'missingInput');
      assert.equal(issues[0].severity, 'warning');
      assert.equal(issues[0].input, 'azureSubscription');
      assert.equal(issues[0].line, 0);
      assert.equal(issues[0].start, 8);
    });

    it('reports a step without inputs and names the rule of a visible conditional input', () => {
      const issues = check('- task: ContosoDeploy@1');
      assert.deepEqual(issues.map(i => i.input), ['environment', 'azureSubscription', 'script']);
      assert.match(issues[2].message, /visible when scriptLocation = inline/);
    });

    it('counts an alias or other casing as set', () => {
      assert.deepEqual(check('- task: ContosoDeploy@1\n  inputs:\n    ENVIRONMENT: dev\n    subscription: s\n    script: x'), []);
    });

    it('skips an input with a default', () => {
      assert.ok(!check('- task: ContosoDeploy@1').some(i => i.input === 'withDefault'));
    });

    it('skips an input whose rule is false or unknown', () => {
      const hidden = check('- task: ContosoDeploy@1\n  inputs:\n    environment: dev\n    subscription: s\n    scriptLocation: path');
      assert.deepEqual(hidden, []);
      const unknown = check('- task: ContosoDeploy@1\n  inputs:\n    environment: dev\n    subscription: s\n    scriptLocation: $(loc)');
      assert.deepEqual(unknown, []);
    });

    it('skips a step with dynamic inputs', () => {
      assert.deepEqual(check('- task: ContosoDeploy@1\n  inputs: ${{ parameters.i }}'), []);
    });

    it('skips an input set under an if and one whose visibility depends on it', () => {
      const yaml = ['- task: ContosoDeploy@1', '  inputs:', '    environment: dev', '    subscription: s',
        '    ${{ if eq(1, 1) }}:', '      scriptLocation: path', '      script: x'].join('\n');
      assert.deepEqual(check(yaml), []);
      const dep = ['- task: ContosoDeploy@1', '  inputs:', '    environment: dev', '    subscription: s',
        '    ${{ if eq(1, 1) }}:', '      scriptLocation: path'].join('\n');
      assert.deepEqual(check(dep), []);
    });

    it('skips a pinned version', () => {
      assert.deepEqual(check('- task: ContosoDeploy@1.0.0').filter(i => i.code === 'missingInput'), []);
    });

    it('counts an expression value as set', () => {
      assert.deepEqual(check('- task: ContosoDeploy@1\n  inputs:\n    environment: ${{ parameters.env }}\n    subscription: $(sub)\n    script: $[ x ]'), []);
    });
  });

  describe('unknown input', () => {
    it('reports it with a suggestion', () => {
      const issues = check(ok + '    subscr: x');
      assert.equal(issues.length, 1);
      assert.equal(issues[0].code, 'unknownInput');
      assert.equal(issues[0].input, 'subscr');
      assert.match(issues[0].message, /Did you mean azureSubscription/);
      assert.equal(issues[0].line, 5);
    });

    it('reports without suggestion', () => {
      const issues = check(ok + '    qqq: x');
      assert.doesNotMatch(issues[0].message, /Did you mean/);
    });

    it('skips conditional entries and dynamic inputs', () => {
      assert.deepEqual(check(ok + '    ${{ if eq(1, 1) }}:\n      qqq: x'), []);
      assert.deepEqual(check('- task: ContosoDeploy@1\n  inputs:\n    ${{ each p in parameters.i }}:\n      ${{ p.key }}: 1\n    qqq: x'), []);
    });

    it('is not reported for an unknown task or major', () => {
      assert.deepEqual(check('- task: Other@1\n  inputs:\n    qqq: x', { catalogFresh: false }), []);
      assert.deepEqual(check('- task: ContosoDeploy@9\n  inputs:\n    qqq: x'), []);
    });
  });

  describe('invalid value', () => {
    it('reports a value outside a static list, case-insensitively', () => {
      const issues = check(ok + '    mode: slow');
      assert.equal(issues[0].code, 'invalidValue');
      assert.equal(issues[0].input, 'mode');
      assert.match(issues[0].message, /'slow' is not an allowed value of mode: fast, safe/);
      assert.deepEqual(check(ok + '    mode: FAST'), []);
      assert.deepEqual(check(ok + '    scriptLocation: Inline'), []);
    });

    it('reports boolean and int types', () => {
      assert.equal(check(ok + '    verbose: maybe')[0].code, 'invalidValue');
      assert.deepEqual(check(ok + '    verbose: TRUE'), []);
      assert.equal(check(ok + '    retries: many')[0].code, 'invalidValue');
      assert.deepEqual(check(ok + '    retries: 3'), []);
    });

    it('skips empty values, expressions, block scalars, editable, multi and dynamic lists', () => {
      assert.deepEqual(check(ok + '    mode:'), []);
      assert.deepEqual(check(ok + '    mode: ${{ parameters.m }}'), []);
      assert.deepEqual(check(ok + '    mode: $(m)'), []);
      assert.deepEqual(check(ok + '    verbose: $[ variables.v ]'), []);
      assert.deepEqual(check(ok + '    mode: |\n      slow'), []);
      assert.deepEqual(check(ok + '    region: elsewhere'), []);
      assert.deepEqual(check(ok + '    tags: a,b'), []);
      assert.deepEqual(check(ok + '    dynamicList: whatever'), []);
    });

    it('also checks values under an if', () => {
      assert.equal(check(ok + '    ${{ if eq(1, 1) }}:\n      mode: slow')[0].code, 'invalidValue');
    });
  });

  describe('not installed', () => {
    it('reports an unknown name when the catalog is fresh', () => {
      const issues = check('- task: Missing@1');
      assert.equal(issues.length, 1);
      assert.equal(issues[0].code, 'notInstalled');
      assert.equal(issues[0].severity, 'warning');
      assert.equal(issues[0].start, 8);
      assert.equal(issues[0].end, 17);
    });
    it('stays quiet when the catalog is stale', () => {
      assert.deepEqual(check('- task: Missing@1', { catalogFresh: false }), []);
    });
    it('does not report a major that is not in the catalog', () => {
      assert.deepEqual(check('- task: ContosoDeploy@9'), []);
    });
    it('finds a task by GUID and ignores case', () => {
      assert.deepEqual(check('- task: contosodeploy@2'), []);
      assert.deepEqual(check('- task: 00000000-0000-0000-0000-000000000002@2'), []);
    });
  });

  describe('deprecated and retired', () => {
    const dep = fakeIndex([info(1, [], { deprecated: true }), info(2, []), info(3, [], { preview: true }), info(4, [], { deprecated: true })]);
    it('reports a deprecated task with the highest stable major', () => {
      const issues = check('- task: ContosoDeploy@1', {}, dep);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].code, 'deprecated');
      assert.equal(issues[0].severity, 'warning');
      assert.equal(issues[0].replacement, 'ContosoDeploy@2');
      assert.match(issues[0].message, /ContosoDeploy@1 is deprecated\. Use ContosoDeploy@2\./);
    });
    it('has no replacement when none is newer', () => {
      const issues = check('- task: ContosoDeploy@4', {}, dep);
      assert.equal(issues[0].replacement, undefined);
      assert.equal(issues[0].message, 'ContosoDeploy@4 is deprecated.');
    });
    const retired: RetiredTask = { name: 'ContosoDeploy', major: 1, retires: '2026-11-24', removed: '2027-03-15', replacement: 'ContosoDeploy@3' };
    it('reports a retired task once, with the replacement of the list', () => {
      const issues = check('- task: ContosoDeploy@1', { retired }, dep);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].code, 'retired');
      assert.equal(issues[0].replacement, 'ContosoDeploy@3');
      assert.equal(issues[0].message, 'ContosoDeploy@1 retires 2026-11-24, removed 2027-03-15. Use ContosoDeploy@3');
    });
    it('reports retired without replacement and for a major missing from the catalog', () => {
      const issues = check('- task: ContosoDeploy@0', { retired: { ...retired, major: 0, replacement: undefined } }, dep);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].message, 'ContosoDeploy@0 retires 2026-11-24, removed 2027-03-15.');
    });
    it('reports retired together with not installed', () => {
      const codes = check('- task: Gone@1', { retired: { ...retired, name: 'Gone' } }).map(i => i.code);
      assert.deepEqual(codes, ['retired', 'notInstalled']);
    });
  });

  describe('newer major', () => {
    it('is information and skips preview majors', () => {
      const issues = check(ok, { versionHints: true });
      assert.equal(issues.length, 1);
      assert.equal(issues[0].code, 'newerMajor');
      assert.equal(issues[0].severity, 'info');
      assert.equal(issues[0].replacement, 'ContosoDeploy@2');
      assert.equal(issues[0].message, 'ContosoDeploy@1: newer major version @2 is available');
    });
    it('can be switched off', () => {
      assert.deepEqual(check(ok, { versionHints: false }), []);
    });
    it('is not reported on the newest stable major', () => {
      assert.deepEqual(check('- task: ContosoDeploy@2', { versionHints: true }), []);
    });
    it('is not reported when the newer major is deprecated', () => {
      const idx = fakeIndex([info(1, []), info(2, [], { deprecated: true })]);
      assert.deepEqual(check('- task: ContosoDeploy@1', { versionHints: true }, idx), []);
    });
    it('does not repeat when the task is already deprecated', () => {
      const idx = fakeIndex([info(1, [], { deprecated: true }), info(2, [])]);
      assert.deepEqual(check('- task: ContosoDeploy@1', { versionHints: true }, idx).map(i => i.code), ['deprecated']);
    });
  });
});

describe('designer mapping: toParameter, asTemplateRef, findDisplayName', () => {
  const task = info(2, deployInputs);

  it('maps the step to a template reference with inputs as parameters', () => {
    const text = 'steps:\n- task: ContosoDeploy@2\n  displayName: x\n  inputs:\n    azureSubscription: A\n    mode: fast\n- script: echo\n';
    const step = findTaskSteps(text)[0];
    const ref = asTemplateRef(step, task);
    assert.deepEqual([ref.kind, ref.line, ref.keyCol, ref.raw, ref.paramsLine, ref.end, ref.dynamicParams], ['template', 1, 2, 'ContosoDeploy@2', 3, 5, false]);
    assert.deepEqual(ref.target, { path: 'ContosoDeploy@2' });
    assert.deepEqual(ref.params.map(e => e.name), ['azureSubscription', 'mode']);
    assert.equal(ref.end, step.end - 1, 'the step end is exclusive, the reference end inclusive');
  });

  it('names the inputs by their yamlName so an alias in the file finds its parameter', () => {
    const text = '- task: ContosoDeploy@2\n  inputs:\n    subscription: A\n    Mode: fast\n    other: 1\n';
    const ref = asTemplateRef(findTaskSteps(text)[0], task);
    assert.deepEqual(ref.params.map(e => e.name), ['azureSubscription', 'mode', 'other']);
    assert.deepEqual(asTemplateRef(findTaskSteps(text)[0]).params.map(e => e.name), ['subscription', 'Mode', 'other'], 'without the task names stay as written');
  });

  it('has no target for an expression name and keeps dynamic inputs', () => {
    const step = findTaskSteps('- task: ${{ parameters.t }}\n  inputs: ${{ parameters.i }}\n')[0];
    const ref = asTemplateRef(step);
    assert.equal(ref.target, undefined);
    assert.equal(ref.dynamicParams, true);
  });

  it('finds the display name beside the task', () => {
    const text = '- task: A@1\n  inputs:\n    a: b\n  displayName: "Deploy: web"\n- task: B@1\n';
    const steps = findTaskSteps(text);
    assert.deepEqual(findDisplayName(text, steps[0]), { line: 3, keyCol: 2, value: 'Deploy: web' });
    assert.equal(findDisplayName(text, steps[1]), undefined);
  });

  it('turns inputs into parameters', () => {
    const p = toParameter(deployInputs[2]);
    assert.deepEqual([p.name, p.type, p.default], ['azureSubscription', 'string', undefined]);
  });

  it('finds the newest stable major above a given one', () => {
    const idx = fakeIndex([info(1, []), info(2, []), info(3, [], { preview: true })]);
    assert.equal(newestMajor(idx, 'ContosoDeploy', 1), 2);
    assert.equal(newestMajor(idx, 'ContosoDeploy', 2), undefined);
  });
});

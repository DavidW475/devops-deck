import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { directiveOf, evaluate, ExpressionError, property, substitute, tokenize, toText, truthy } from '../pipelines/templateExpressions';

const scope = {
  parameters: { environment: 'Staging', runTests: true, retries: 3, regions: ['westeurope', 'northeurope'], app: { name: 'contoso-api', port: 8080 }, empty: '' },
  variables: { 'Build.SourceBranch': 'refs/heads/main', system: 'linux' },
  item: { key: 'k1', value: 'v1' },
};
const ev = (e: string) => evaluate(e, scope);

describe('template expressions', () => {
  it('reads only own properties', () => {
    assert.equal(property({ a: 1 } as any, 'constructor'), null);
    assert.equal(property({ a: 1 } as any, '__proto__'), null);
    assert.equal(evaluate('parameters.toString', { parameters: { a: '1' } }), null);
    assert.equal(property({ Constructor: 'x' } as any, 'constructor'), 'x');
  });

  it('tokenizes strings with escaped quotes, numbers and punctuation', () => {
    assert.deepEqual(tokenize("eq('it''s', -1.5)").map(t => t.v), ['eq', '(', "it's", ',', -1.5, ')']);
    assert.throws(() => tokenize("'open"), /Unterminated/);
    assert.throws(() => tokenize('a + b'), /Unexpected '\+'/);
  });

  it('reads parameters and variables, case-insensitive, with dots and indexes', () => {
    assert.equal(ev('parameters.environment'), 'Staging');
    assert.equal(ev('Parameters.ENVIRONMENT'), 'Staging');
    assert.equal(ev("variables['Build.SourceBranch']"), 'refs/heads/main');
    assert.equal(ev('parameters.regions[1]'), 'northeurope');
    assert.equal(ev('parameters.regions.0'), 'westeurope');
    assert.equal(ev('parameters.app.name'), 'contoso-api');
    assert.equal(ev('parameters.missing'), null);
    assert.equal(ev('item.value'), 'v1');
    assert.equal(property('text', 'x'), null);
    assert.equal(ev('(parameters.retries)'), 3);
    assert.deepEqual([ev('true'), ev('False'), ev('null')], [true, false, null]);
  });

  it('compares like Azure DevOps', () => {
    assert.equal(ev("eq(parameters.environment, 'staging')"), true);
    assert.equal(ev("ne(parameters.environment, 'production')"), true);
    assert.equal(ev("eq(parameters.retries, '3')"), true);
    assert.equal(ev("eq(parameters.runTests, 'true')"), true);
    assert.equal(ev('gt(parameters.retries, 2)'), true);
    assert.equal(ev('ge(parameters.retries, 3)'), true);
    assert.equal(ev('lt(parameters.retries, 3)'), false);
    assert.equal(ev('le(parameters.retries, 3)'), true);
    assert.equal(ev("eq(parameters.regions, parameters.regions)"), true);
    assert.equal(ev("eq(parameters.missing, '')"), true);
    assert.equal(ev("eq(parameters.environment, parameters.app)"), false);
    assert.equal(ev("eq(false, 0)"), true);
  });

  it('implements the logical, string and collection functions', () => {
    assert.equal(ev("and(parameters.runTests, eq(variables.system, 'Linux'))"), true);
    assert.equal(ev('or(false, parameters.empty)'), false);
    assert.equal(ev('not(parameters.empty)'), true);
    assert.equal(ev('xor(true, false)'), true);
    assert.equal(ev("contains(parameters.environment, 'TAG')"), true);
    assert.equal(ev("contains(parameters.regions, 'WestEurope')"), true);
    assert.equal(ev("containsValue(parameters.app, 8080)"), true);
    assert.equal(ev("containsValue(parameters.app, 9090)"), false);
    assert.equal(ev("containsValue(parameters.app, 'contoso-api')"), true);
    assert.equal(ev("containsValue(parameters.environment, 'x')"), false);
    assert.equal(ev("startsWith(variables['Build.SourceBranch'], 'refs/heads/')"), true);
    assert.equal(ev("endsWith(parameters.environment, 'ING')"), true);
    assert.equal(ev("in(parameters.environment, 'dev', 'staging')"), true);
    assert.equal(ev("notIn(parameters.environment, 'dev')"), true);
    assert.equal(ev("coalesce(parameters.empty, parameters.missing, 'fallback')"), 'fallback');
    assert.equal(ev("coalesce(parameters.empty)"), null);
    assert.equal(ev("iif(parameters.runTests, 'yes', 'no')"), 'yes');
    assert.equal(ev("format('{0}-{1} {{x}}', parameters.app.name, parameters.runTests)"), 'contoso-api-True {x}');
    assert.equal(ev("join(', ', parameters.regions)"), 'westeurope, northeurope');
    assert.equal(ev("join(',', 'single')"), 'single');
    assert.deepEqual([ev('length(parameters.regions)'), ev('length(parameters.app)'), ev("length('abc')"), ev('length(3)')], [2, 2, 3, 0]);
    assert.deepEqual([ev("lower('ABC')"), ev("upper('abc')"), ev("trim('  x ')"), ev("replace('a-b-c', '-', '_')")], ['abc', 'ABC', 'x', 'a_b_c']);
    assert.deepEqual(ev("split('a;b;c', ';')"), ['a', 'b', 'c']);
    assert.deepEqual(ev("split('abc', '')"), ['abc']);
    assert.equal(ev('convertToJson(parameters.regions)'), '[\n  "westeurope",\n  "northeurope"\n]');
  });

  it('reports what it cannot evaluate', () => {
    assert.throws(() => ev("counter('x', 1)"), ExpressionError);
    assert.throws(() => ev("format('{x}')"), /Invalid format/);
    assert.throws(() => ev('eq(1, 2'), /Expected ','/);
    assert.throws(() => ev('parameters.'), /property name/);
    assert.throws(() => ev('parameters.a b'), /after the expression/);
    assert.throws(() => ev(''), /end of expression/);
    assert.throws(() => ev(')'), /Unexpected '\)'/);
    assert.throws(() => ev('parameters[1'), /Expected '\]'/);
  });

  it('substitutes expressions in text and keeps the type of a whole-value expression', () => {
    assert.equal(substitute('no expressions', scope), 'no expressions');
    assert.deepEqual(substitute('${{ parameters.regions }}', scope), ['westeurope', 'northeurope']);
    assert.equal(substitute('Deploy ${{ parameters.app.name }} (${{ parameters.runTests }}, ${{ parameters.missing }}) ${{ parameters.retries }}', scope),
      'Deploy contoso-api (True, ) 3');
    assert.equal(substitute("${{ format('{0}}}', 'a') }}", scope), 'a}');
    assert.throws(() => substitute('x ${{ parameters.regions }}', scope), /Array to String/);
    assert.throws(() => substitute('x ${{ parameters.app }}', scope), /Object to String/);
    assert.throws(() => substitute('${{ open', scope), /Missing \}\}/);
    assert.equal(toText(false), 'False');
  });

  it('knows Azure truthiness', () => {
    assert.deepEqual([truthy(''), truthy('false'), truthy(0), truthy([]), truthy({}), truthy({ a: 1 }), truthy([1]), truthy(null)],
      [false, true, false, false, false, true, true, false]);
  });

  it('recognizes directives', () => {
    assert.deepEqual(directiveOf("${{ if eq(parameters.a, 'b') }}"), { kind: 'if', expr: "eq(parameters.a, 'b')" });
    assert.deepEqual(directiveOf('${{ ELSEIF x }}'), { kind: 'elseif', expr: 'x' });
    assert.deepEqual(directiveOf('${{ else }}'), { kind: 'else' });
    assert.deepEqual(directiveOf('${{ insert }}'), { kind: 'insert' });
    assert.deepEqual(directiveOf('${{ each region in parameters.regions }}'), { kind: 'each', name: 'region', expr: 'parameters.regions' });
    assert.equal(directiveOf('${{ each broken }}'), undefined);
    assert.equal(directiveOf('${{ parameters.x }}'), undefined);
    assert.equal(directiveOf('plainKey'), undefined);
  });
});

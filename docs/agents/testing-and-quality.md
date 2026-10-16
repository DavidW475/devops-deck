# Testing and code quality

## Unit tests

- Runner: Node's built-in `node:test` with `node:assert/strict`. No test framework dependency.
- `npm test` = `tsc -p ./` (strict, `noUnusedLocals`, `noUnusedParameters`) + `node --test --enable-source-maps --require ./out/test/setup.js "out/test/**/*.test.js"`.
- Tests live in `src/test/*.test.ts` and are compiled to `out/test/` (excluded from the package).

### The vscode stub

- `src/test/setup.ts` is loaded with `--require` and hooks `Module._load`, so every `import 'vscode'` gets `src/test/vscodeStub.ts`.
- The stub is minimal: `EventEmitter`, `Uri`, `TreeItem`, `ThemeIcon`, `MarkdownString`, `CodeAction(Kind)`, `Disposable`, `FileSystemError`, a few enums, and `window`, `workspace`, `commands`, `env`, `authentication`, `extensions`. Settings are read from the exported `settings` object (`settings['azureDevOps.authMethod'] = 'pat'`); `messages` and `executed` record notifications and commands; `reset()` clears them.
- When a module you import in a test uses more of the vscode API **at load time** (top-level calls, class fields, constructors you run), extend the stub with just what is needed. Otherwise the test fails with "undefined is not a function".

### What is tested

| Test file | Covers |
| --- | --- |
| `client.test.ts` | URL building, api-version, auth headers, error mapping, `fieldOps`, PR artifact URLs (replaces `globalThis.fetch`) |
| `connection.test.ts` | `isAzureDevOpsUrl`, `normalizeOrgUrl`, `parseRemote` |
| `util.test.ts` | formatting helpers, `escapeHtml`, `sanitizeHtml`, `mapLimit` |
| `features.test.ts` | `git.ts` helpers, work item from code, `wiModel.ts`, `sprint.ts`, wiki `flattenPages` |
| `stageGraph.test.ts`, `timeline.test.ts`, `logs.test.ts`, `yamlParameters.test.ts` | pipeline logic |
| `checks.test.ts` | `summarizeChecks` |
| `watchers.test.ts` | watcher matching, events, the `Watchers` engine with a fake client |

### How to write tests

- Put logic in **pure functions in their own modules** without UI calls (`wiModel.ts`, `sprint.ts`, `stageGraph.ts`, `timeline.ts`, `git.ts` helpers, `checks.ts`) and test those. Panels and `media/*.js` are not unit tested.
- For client calls, stub `fetch` as `client.test.ts` does and assert the request.
- Use fictitious data only: `https://dev.azure.com/contoso`, project `Fabrikam Shop`, made-up people.

### Coverage

`npm run test:coverage` runs the tests with `--experimental-test-coverage` (excluding `out/test/**`) and writes `coverage/lcov.info` (spec output on stdout). `coverage/` is excluded from the package.

## SonarQube

- `sonar-project.properties`: project key `DavidW475_devops-deck`, organization `davidw475`, sources `src,media`, tests `src/test`, coverage from `coverage/lcov.info`, `media/**` excluded from coverage.
- CI (`.github/workflows/build.yml`, job `sonar`): runs only when the `SONAR_TOKEN` secret is set (and not for PRs from forks); it runs `npm ci && npm run test:coverage`, then `SonarSource/sonarqube-scan-action` against `vars.SONAR_HOST_URL` or `https://sonarcloud.io`. So far no analysis has run on SonarCloud, so check locally.

### Running the SonarJS rules locally (no new dependencies)

Do this in a scratch directory outside the repository. `eslint-plugin-sonarjs` is **LGPL**: never add it (or ESLint) to `package.json`.

```bash
mkdir -p /tmp/sonar-lint && cd /tmp/sonar-lint
npm init -y >/dev/null
npm i eslint eslint-plugin-sonarjs typescript-eslint globals jscpd
ln -s /workspaces/ado-extension repo     # files must be below the config directory
```

`eslint.config.mjs`:

```js
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { files: ['repo/src/**/*.ts'], languageOptions: { parser: tseslint.parser,
      parserOptions: { project: './repo/tsconfig.json', tsconfigRootDir: import.meta.dirname } } },
  { files: ['repo/media/**/*.js'], languageOptions: { globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } } },
  sonarjs.configs.recommended,
];
```

```bash
npx eslint "repo/src/**/*.ts" "repo/media/**/*.js"
npx jscpd repo/src repo/media --min-tokens 50     # duplicated blocks
```

## Code style that keeps Sonar clean

- No nested ternaries. Use `if`/`else`, a lookup table or a small helper.
- No nested template literals. Extract the inner part into a variable or helper first.
- Cognitive complexity ≤ 15 per function. Split functions; use table-driven handlers (`Record<string, ...>` maps, `switch` that delegates to methods).
- No backtracking-prone regexes on untrusted input (server data, settings, user text). Use small scanners instead, e.g. `trimSlashes` (`src/connection.ts`), `splitKey` (`yamlParameters.ts`), the attribute scanner in `sanitizeHtml`.
- `void` only in front of promises (fire-and-forget), never on non-promise values.
- Pluralize with `plural(n, word)` from `src/util.ts`, not hand-written `n === 1 ? … : …`.
- Do not write the words TODO or FIXME in comments (Sonar flags them). Say "to-do" or describe the limitation.

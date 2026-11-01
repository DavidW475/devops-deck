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
| `templateRefs.test.ts`, `yamlTemplates.test.ts`, `templateExpressions.test.ts`, `templateExpander.test.ts`, `previewPanel.test.ts` | template references, parameter checks, completion context; `TemplateResolver` (local, Azure Repos, clones, recursion, URIs) and the YAML providers and commands; expression functions, local expansion and the preview model; the preview panel with a fake `YamlTemplateSupport` |
| `templateEdits.test.ts`, `designerModel.test.ts`, `designerPanel.test.ts` | designer line edits (values, add/remove, quoting, indentation, new calls, insertion points, repository resources, range conversion; task steps: `blockKey: 'inputs'`, alias spelling, multi-line blocks, `newTaskLines`, `planTaskVersion`, display name, CRLF and last line without break); its view model (structure with task steps, `itemAt`, multi-line rows); the designer panel and CodeLens with a fake `DesignerHost` (with a fake task catalog) and a document that applies `WorkspaceEdit`s: every task message, invalid ids ignored without rendering, catalog states, settings |
| `taskDesigner.test.ts` | the short task list, ages, catalog states, version notes, the task form (visibility, groups, errors, expression values) and the edit plans |
| `taskRules.test.ts`, `taskRefs.test.ts`, `taskCatalog.test.ts`, `taskRetirement.test.ts`, `yamlTasks.test.ts` | task support: `visibleRule` grammar and visibility, step finding, completion context and `checkTaskStep`, the catalog cache and refresh rules, the retirement table; `YamlTaskSupport` with a fake catalog (completion, hover, diagnostics, quick fixes, silence without data, settings, duplicate avoidance, injection in server text) |
| `watchers.test.ts` | watcher matching, events, the `Watchers` engine with a fake client |
| `clientApi.test.ts` | every `AdoClient` API method (method, path, query, body, mapping), paging, auth, `isSafeApiPath` |
| `git.test.ts`, `logsStream.test.ts`, `approvals.test.ts`, `utilUi.test.ts`, `securityHelpers.test.ts` | local repos and `ConnectionManager`, live log terminal, approvals, UI helpers, `assertBranchName` / `glob` / watcher command guard |
| `extension.test.ts` | `activate()` registers every command from `package.json`; runs many commands |
| `prPanel`, `createPrPanel`, `wiPanel`, `reposPanel`, `runView`, `runPanel`, `watchersPanel`, `sidebarProvider` `.test.ts` | panels through the fake webview: rendered HTML (escaping, CSP nonce) and every message type |
| `prFiles`, `prComments`, `prStatusBar`, `iterations`, `reviewed`, `wiki`, `wiCommands`, `watchersTree` `.test.ts` | the remaining feature modules |

### Test helpers

- `src/test/fakeWebview.ts`: `createWebviewPanel` in the stub returns a `FakeWebviewPanel`. Its webview records `html` and `posted` messages; `send(msg)` runs the panel's message handlers and waits for them; `last(type)`, `ofType(type)`, `lastPanel()`, `flush()`, `cspNonce(html)`; `htmlWrites` counts html assignments and `content` is the html of the last `update` message (else the page), for panels using `LivePanel`; `inlineScript(html)` returns the inline page script.
- The stub answers dialogs from queues (`answers.inputBox`, `answers.quickPick`, `answers.saveDialog`, `answers.message`), returns `commandResults[name]` from `executeCommand`, records `opened` URLs and `terminals`, and fakes extensions via `extensionExports[id]` (e.g. `vscode.git`).
- `src/test/vscodeExtras.ts`: more fakes (quick pick, comment controller, editor and document events, diagnostics and language providers (`diagnosticSets`, `providers`), a file map for `workspace.fs` / `findFiles` (`files`), git repositories via `setGitRepositories`/`fakeRepo`, `fakeDoc`, `fakeEditor`) for the feature module tests.

### How to write tests

- Put logic in **pure functions in their own modules** without UI calls (`wiModel.ts`, `sprint.ts`, `stageGraph.ts`, `timeline.ts`, `git.ts` helpers, `checks.ts`) and test those. Panels and `media/*.js` are not unit tested.
- For client calls, stub `fetch` as `client.test.ts` does and assert the request.
- Use fictitious data only: `https://dev.azure.com/contoso`, project `Fabrikam Shop`, made-up people.

### Coverage

**Required: at least 80 % line coverage on new code.** This is the SonarCloud quality gate; a pull request below it fails. Write tests together with the code, including for panels (drive them through the fake webview in the vscode stub). Note that Node's coverage report lists only files a test imports, while SonarCloud counts every file under `src/` (except `src/test/`), so a module without any test counts as 0 %.

`npm run test:coverage` runs the tests with `--experimental-test-coverage` (excluding `out/test/**`) and writes `coverage/lcov.info` (spec output on stdout). `coverage/` is excluded from the package.

## SonarQube

- `sonar-project.properties`: project key `DavidW475_devops-deck`, organization `davidw475`, sources `src,media`, tests `src/test`, coverage from `coverage/lcov.info`, `media/**` excluded from coverage.
- CI (`.github/workflows/build.yml`, job `sonar`): runs only when the `SONAR_TOKEN` secret is set (and not for PRs from forks); it runs `npm ci && npm run test:coverage`, then `SonarSource/sonarqube-scan-action` against `vars.SONAR_HOST_URL` or `https://sonarcloud.io`.
- **Rule: no open issues.** Every issue SonarCloud reports on a pull request's new code is fixed before the PR is done: bugs, vulnerabilities, code smells of every severity (also *minor* and *info*) and security hotspots. Passing the quality gate is not enough.
- **Suppressing** is the exception: only where a rule does not apply, with `// NOSONAR: <reason>` on the line of the issue (the reason can also live in the function's doc comment). Example: the template expander awaits in loops on purpose, because `if`/`else` chains, the file budget and the order of warnings depend on it. Do not suppress to save work, and never mark issues as accepted on SonarCloud instead of fixing them.

### Reading the issues of a pull request

The project is public, so the Web API needs no token:

```bash
PR=5
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=DavidW475_devops-deck&pullRequest=$PR&resolved=false&ps=100" \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log("total",d.total);for(const i of d.issues)console.log(i.severity,i.rule,i.component.split(":").pop()+":"+i.line,"-",i.message)'
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=DavidW475_devops-deck&pullRequest=$PR&ps=100"   # hotspots
curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=DavidW475_devops-deck&pullRequest=$PR"   # gate
```

Line numbers refer to the analysed commit; after a push, wait for the new analysis before checking again. The local ESLint run below covers most, but not all, SonarCloud rules (e.g. not `S9382` or the CSS rules), so always check the PR as well.

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
- `replaceAll('x', 'y')` instead of `replace(/x/g, 'y')` for plain strings.
- Do not pass a named function straight to `.map()` / `.forEach()` (`.map(scanLine)`): wrap it, `.map((line, n) => scanLine(line, n))`, so extra callback arguments are explicit.
- No `String(v)` or template interpolation on values that may be objects (prints `[object Object]`); narrow the type first or format objects explicitly (e.g. `JSON.stringify`).
- No `await` inside loops: run independent calls with `Promise.all` / `mapLimit` (results keep their order). When the order really matters, say why and add `// NOSONAR`.
- CSS in `media/panel.css` is shared by all editor panels: no selector twice, and scope panel-specific rules under the panel's own class (e.g. `.pv-head .seg`) instead of redefining a shared one.

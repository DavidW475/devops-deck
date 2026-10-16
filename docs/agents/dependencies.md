# Dependency policy

These rules apply to npm packages, GitHub Actions, the devcontainer image and any other third-party code.

## 1. Always use the latest stable versions

- When adding or touching a dependency, check the current release (`npm outdated`, `npm view <pkg> version`, the action's releases page) and update to it.
- No pre-releases (`beta`, `rc`, `next`, `insiders`, `dev`).
- Before a major bump, read its breaking changes and adapt the code.
- **Exception:** `@types/vscode` must not be newer than `engines.vscode` in `package.json`, because vsce refuses to package otherwise. Bump both together.
- **GitHub Actions:** use the latest major tag (e.g. `actions/checkout@v7`). CI and the devcontainer use the current Node.js LTS.

## 2. Only reputable, official packages

- Prefer packages published by the vendor itself: Microsoft / `@vscode/*`, `typescript`, DefinitelyTyped `@types/*`, `actions/*`, SonarSource.
- Before adding anything else, check: maintainer and source repository, download numbers, recent maintenance, no typosquatting.
- Install only from `registry.npmjs.org`.

## 3. Licenses must be compatible with MIT

- Allowed without asking: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0.
- Ask the maintainer before adding anything else: copyleft (GPL/LGPL/AGPL), proprietary, "SEE LICENSE IN …", or no license.
- Build-only tools that are never shipped in the `.vsix` (e.g. `@vscode/vsce` and its dependencies) are less critical but still need a check.
- Tools you only run locally in a scratch directory (see the SonarJS recipe in [testing-and-quality.md](testing-and-quality.md)) never go into `package.json`. `eslint-plugin-sonarjs` is LGPL, so it must not be added.

## 4. No runtime dependencies unless there is no reasonable alternative

- The extension ships with zero `dependencies`. Everything in `node_modules` is dev-only and excluded from the `.vsix` (`.vscodeignore` has `node_modules/**`).
- Keep it that way. Write small, focused code instead, e.g. the YAML parameter parser in `src/pipelines/yamlParameters.ts`, the stage `dependsOn` reader in `src/pipelines/stageGraph.ts` and the HTML sanitizer in `src/util.ts`.
- If a runtime dependency becomes unavoidable, it must meet rules 1–3 and its license must be included in the package.

Current dev dependencies (`package.json`): `@types/node`, `@types/vscode`, `@vscode/vsce`, `typescript`.

## 5. Keep it clean

- `package-lock.json` is committed and `npm ci` must work.
- `npm audit` must report 0 vulnerabilities.
- `npm outdated` should print nothing.
- Check `npx vsce ls` to see what goes into the package: only `out/`, `media/` (no screenshots), README, CHANGELOG, LICENSE, `package.json`. New top-level folders that are not meant for the package must be added to `.vscodeignore` (e.g. `docs/**`).

## Where versions live

| What | File |
| --- | --- |
| npm packages, `engines.vscode` | `package.json`, `package-lock.json` |
| GitHub Actions, Node.js version for CI | `.github/workflows/build.yml` |
| Devcontainer image | `.devcontainer/devcontainer.json` |

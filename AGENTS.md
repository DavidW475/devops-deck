# AGENTS.md

Guidance for AI coding agents and contributors working on DevOps Deck.

## Dependency policy

These rules apply to npm packages, GitHub Actions, the devcontainer image and any other third-party code.

1. **Always use the latest stable versions.** When adding or touching a dependency, check the current release (`npm outdated`, `npm view <pkg> version`, the action's releases page) and update to it. No pre-releases (`beta`, `rc`, `next`, `insiders`, `dev`). Before a major bump, read its breaking changes and adapt the code.
   - Exception: `@types/vscode` must not be newer than `engines.vscode` in `package.json`, because vsce refuses to package otherwise. Bump both together.
   - GitHub Actions: use the latest major tag (e.g. `actions/checkout@v7`). CI and the devcontainer use the current Node.js LTS.
2. **Only reputable, official packages.** Prefer packages published by the vendor itself (Microsoft / `@vscode/*`, `typescript`, DefinitelyTyped `@types/*`, `actions/*`, SonarSource). Before adding anything else, check: maintainer and source repository, download numbers, recent maintenance, no typosquatting. Install only from `registry.npmjs.org`.
3. **Licenses must be compatible with MIT.** Allowed without asking: MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0. Ask the maintainer before adding anything else (copyleft such as GPL/LGPL/AGPL, proprietary, "SEE LICENSE IN …", no license). Build-only tools that are never shipped in the `.vsix` (e.g. `@vscode/vsce` and its dependencies) are less critical but still need a check.
4. **No runtime dependencies unless there is no reasonable alternative.** The extension currently ships with zero `dependencies`; everything in `node_modules` is dev-only and excluded from the `.vsix`. Keep it that way (see the small YAML parser in `src/pipelines/yamlParameters.ts`). If a runtime dependency becomes unavoidable, it must meet rules 1–3 and its license must be included in the package.
5. **Keep it clean.** `package-lock.json` is committed and `npm ci` must work. `npm audit` must report 0 vulnerabilities. Check `npx vsce ls` to see what goes into the package.

## Checks before finishing a change

```bash
npm ci
npm test            # compile (strict, no unused locals/parameters) + unit tests
npm outdated        # should print nothing
npm audit           # 0 vulnerabilities
npx vsce ls         # only out/, media/ (no screenshots), README, CHANGELOG, LICENSE, package.json
```

## Other conventions

- Credentials may only be sent to `https://dev.azure.com` and `https://*.visualstudio.com` (`isAzureDevOpsUrl` in `src/connection.ts`). Do not loosen this check.
- Webviews: all server data must be escaped (`escapeHtml` / `esc`), scripts only with the CSP nonce, and commands from webviews only within the `azureDevOps.` namespace.
- Screenshots and examples only use fictitious data (Contoso, Fabrikam, made-up names), never real organizations, people or customer data.
- "Azure DevOps" is a Microsoft trademark: keep the "not affiliated with or endorsed by Microsoft" notice in the README and do not use Microsoft logos.

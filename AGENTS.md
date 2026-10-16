# AGENTS.md

Guidance for AI coding agents and contributors working on DevOps Deck.

DevOps Deck is a VS Code extension (TypeScript, strict mode) for Azure DevOps Services: pull requests (overview, review, create), work items and sprints, pipelines (run view, live logs, approvals), watchers, wiki and repositories. It talks to the Azure DevOps REST API through one client (`src/client.ts`), shows a webview dashboard in the sidebar plus editor webview panels, and ships with **zero runtime dependencies**.

## Non-negotiable rules

- **Dependencies:** latest stable versions only, reputable vendor packages, MIT-compatible licenses, no runtime `dependencies`, committed `package-lock.json`, `npm audit` clean. `@types/vscode` must not be newer than `engines.vscode`. Details: [docs/agents/dependencies.md](docs/agents/dependencies.md).
- **Credentials** may only be sent to `https://dev.azure.com` and `https://*.visualstudio.com` (`isAzureDevOpsUrl` in `src/connection.ts`). Do not loosen this check.
- **Webviews:** escape all server data (`escapeHtml` / `esc`); user-written HTML/Markdown goes through `sanitizeHtml` (or `renderMarkdown`, which sanitizes).
- **Webviews:** scripts only with the CSP nonce (`panelHtml` / the sidebar's own CSP).
- **Webviews:** commands requested by a webview are executed only within the `azureDevOps.` namespace.
- **Fictitious data only** in screenshots, examples, tests and docs (Contoso, Fabrikam, made-up names), never real organizations, people or customer data.
- **Trademark:** "Azure DevOps" is a Microsoft trademark. Keep the "not affiliated with or endorsed by Microsoft" notice in the README and do not use Microsoft logos.

## Checks before finishing a change

```bash
npm ci
npm test            # compile (strict, no unused locals/parameters) + unit tests
npm outdated        # should print nothing
npm audit           # 0 vulnerabilities
npx vsce ls         # only out/, media/ (no screenshots), README, CHANGELOG, LICENSE, package.json
```

## Read this when…

| You are about to… | Read |
| --- | --- |
| add, update or remove a package, GitHub Action or the devcontainer image | [docs/agents/dependencies.md](docs/agents/dependencies.md) |
| add a command, a module, a panel or touch activation / multi-project handling | [docs/agents/architecture.md](docs/agents/architecture.md) |
| call a new Azure DevOps REST endpoint or change auth / routes | [docs/agents/azure-devops-api.md](docs/agents/azure-devops-api.md) |
| write or change webview HTML, CSS or scripts (`media/`, `panelHtml`) | [docs/agents/webviews.md](docs/agents/webviews.md) |
| write tests, check coverage or keep SonarQube clean | [docs/agents/testing-and-quality.md](docs/agents/testing-and-quality.md) |
| find where a user feature lives or learn its known pitfalls | [docs/agents/features.md](docs/agents/features.md) |

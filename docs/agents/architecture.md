# Architecture

## Module map

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | `activate()`: creates the shared services, registers providers and every command. |
| `src/connection.ts` | `ConnectionManager` (org + projects from settings or a git remote), `normalizeOrgUrl`, `trimSlashes`, `isAzureDevOpsUrl`, `parseRemote`, `gitApi`. |
| `src/client.ts` | `AdoClient`: every Azure DevOps REST call, auth, URL building. Also `fieldOps`, `refName`, `prArtifactUrl`/`parsePrArtifact`. See [azure-devops-api.md](azure-devops-api.md). |
| `src/types.ts` | REST response types. |
| `src/util.ts` | `escapeHtml`, `sanitizeHtml`, `renderMarkdown`, `panelHtml`, `nonce`, `guarded`/`showError`, link picker, `mapLimit`, `plural`, time/duration formatting, avatars. |
| `src/git.ts` | Local git repositories that belong to the selected projects (`localAdoRepos`, `pickLocalRepo`), work item IDs from branch names / commit text, PR title suggestions. |
| `src/sidebar/sidebarProvider.ts` + `media/sidebar.js`, `media/sidebar.css` | The "Dashboard" webview view: tabs for pull requests, work items, sprint, pipelines. |
| `src/pullRequests/` | `prPanel.ts` (overview), `createPrPanel.ts`, `prStatusBar.ts`, `iterations.ts` (compare updates), `prComments.ts` (inline threads in diffs), `prFiles.ts` (`ado-pr:` / `ado-git:` content, diff, checkout), `reviewed.ts` (local "reviewed" marks), `checks.ts` (policy summary). |
| `src/workItems/` | `wiPanel.ts` (detail panel), `wiCommands.ts` (state, assign, comment, create, branch, from code + `TodoCodeActions`), `wiModel.ts` and `sprint.ts` (pure logic). |
| `src/pipelines/` | `runView.ts` + `media/runView.js` (run overview), `runPanel.ts` (run form), `logs.ts` (log terminal, `ado-log:` documents), `timeline.ts`, `stageGraph.ts`, `yamlParameters.ts`, `approvals.ts`. |
| `src/watchers/` | `watchers.ts` (polling engine), `watchersPanel.ts` (editor), `watchersTree.ts` (tree view). |
| `src/wiki/wiki.ts` | `WikiFileSystem` (`ado-wiki:` scheme), page picker. |
| `src/repos/reposPanel.ts` + `media/repos.js` | Repositories and branches panel. |
| `media/panel.css` | Shared styles of all editor panels. |
| `src/test/` | Unit tests, see [testing-and-quality.md](testing-and-quality.md). |

## Activation flow (`src/extension.ts`)

Activation event is `onStartupFinished`.

1. Creates one instance each of `ConnectionManager`, `AdoClient`, `ReviewedFiles`, `SidebarProvider`, `PrCommentController`, `Watchers`, `PrStatusBar`, `LogDocumentProvider`; `PullRequestPanel.useStore(globalState)`.
2. Registers disposables: the code action provider, the `azureDevOps.dashboard` webview view (`retainContextWhenHidden`), content providers for `ado-pr`, `ado-git`, `ado-log`, the `ado-wiki` file system provider.
3. Listeners: connection change, `azureDevOps.*` configuration change and Microsoft session change call `client.reset()` and `refresh()` (sidebar + PR status bar).
4. Registers all commands (below).
5. `await connections.resolve()`, then `connections.watchGit()` (re-resolves when the git extension opens repositories).

## Registering commands

Every command must also be declared in `package.json` (`contributes.commands`, menus).

- `command(id, fn)` registers `fn` wrapped in `guarded()`: any thrown error becomes a notification (auth errors offer "Sign In" / "Use PAT").
- `mutation(id, fn)` is for commands that change server data: after `fn` it calls `refresh()`, unless `fn` returned `false` (e.g. the user cancelled).
- `at(project)` returns `client.forProject(project)` when `project` is a non-empty string, else the primary client. Use it for every project-bound command.

```ts
mutation('azureDevOps.pipelines.cancel', async (buildId: number, project?: string) => { /* ... */ await at(project).cancelBuild(buildId); });
```

Commands are also invoked from webviews with JSON arguments, so validate types (`typeof x === 'number' ? x : undefined`, `uri instanceof vscode.Uri`).

## Sidebar: webview ↔ SidebarProvider

The sidebar has its own HTML (not `panelHtml`) with a nonce CSP and loads `media/sidebar.js`. Two message types from the page:

- `{ type: 'rpc', id, method, params }`: `SidebarProvider.rpc()` answers with `{ type: 'rpc', id, result }` or `{ type: 'rpc', id, error: { message, auth } }`. Methods: `context`, `projects`, `setProject`, `me`, `prs`, `prFiles`, `setReviewed`, `queries`, `workItems`, `builds`, `definitions`, `definitionBuilds`, `timeline`, `teams`, `sprint`, `approvals`. Unknown methods throw. In `sidebar.js`: `rpc(method, params)` returns a promise.
- `{ type: 'command', name, args }`: executed only if `name` starts with `azureDevOps.`. In `sidebar.js`: `command(name, ...args)` or a `data-cmd` / `data-args` attribute.

Extension → page: `refresh`, `focus` (window focus state), `reviewed` (check mark changed elsewhere).

To add data to the sidebar: add a `case` to `rpc()` returning a small DTO (not the raw REST object), then call `rpc('name')` from `sidebar.js`.

## Editor panels

Pattern used by `PullRequestPanel`, `WorkItemPanel`, `RunViewPanel`, `CreatePullRequestPanel`, `RunPipelinePanel`, `ReposPanel`, `WatchersPanel`:

- A static `show(...)` is the only entry point. It reveals an existing panel instead of opening a second one: a static `Map` keyed by PR (`repoId/prId`), work item ID or build ID, or a single `static current` for the create-PR, run-pipeline, repos and watchers panels.
- The constructor is private. It only wires `onDidReceiveMessage(guarded(m => this.handle(m)))` and sets a placeholder (`panelHtml(..., 'Loading', spinner)`).
- `show` stores the instance, then starts the first `render()` / `load()`. Never start async rendering in the constructor.
- `onDidDispose` removes the instance from the map / `current` and clears timers.
- Panels that keep their script in `media/` (`runView.js`, `repos.js`) set the HTML once and the page posts `ready`; data then flows as messages.

## Multi-project model

- `Connection` (`src/connection.ts`): `orgUrl`, `project` (primary), `projects` (primary first, then `azureDevOps.additionalProjects`, deduplicated case-insensitively), `detected` (from git remote).
- `AdoClient.forProject(project)` returns a cached child client whose `connection.project` is that project; it returns the root client for no project or the primary one. `client.reset()` clears the cache.
- Sidebar lists aggregate with `perProject(fn)`: runs `fn` for each project (at most 4 at a time via `mapLimit`), tags results with `project` when there are several, skips failing projects unless all fail.
- The item's project travels to commands as the **last argument** (e.g. `[b.id, b.project]` in `sidebar.js`), and the command uses `at(project)`.
- Saved queries, settings, watchers and newly created items use the primary project. Built-in/custom WIQL queries run in every selected project.
- Repository calls by GUID and work item calls by ID use organization routes, so they work for any project (see [azure-devops-api.md](azure-devops-api.md)).

# Features and where they live

Short map from user features to code, plus pitfalls found while building them. Commands are registered in `src/extension.ts` (see [architecture.md](architecture.md)).

## Pull requests (`src/pullRequests/`)

| Feature | Code |
| --- | --- |
| Sidebar list with required-check state and file list with reviewed marks | `SidebarProvider.pullRequests` / `prFiles`, `checks.ts` (`summarizeChecks`) |
| Overview panel: description, reviewers, votes, threads, auto-complete, complete/draft/abandon, linked work items, checkout | `prPanel.ts` (`PullRequestPanel`) |
| "New since your last visit": newest iteration remembered on close | `PullRequestPanel.useStore` (globalState key `prVisit:...`) |
| Compare updates (iterations) | `iterations.ts` (`compareIterations`), command `azureDevOps.pr.compareIterations` |
| Diffs and inline comment threads (reply, resolve, suggestions, edit/delete) | `prFiles.ts` (`ado-pr:` content by blob ID), `prComments.ts` |
| Reviewed files (local, per file version) | `reviewed.ts` (`ReviewedFiles`, `changeVersion`) |
| Create PR: title/description from commits, work item IDs from branch name and commit text, reviewers, existing-PR check | `createPrPanel.ts`, helpers in `src/git.ts` |
| Status bar: PR of the checked-out branch with checks, latest run of the branch, or "Create pull request" | `prStatusBar.ts` |

## Work items (`src/workItems/`)

| Feature | Code |
| --- | --- |
| Sidebar list from built-in, custom (`azureDevOps.workItems.queries`) or saved queries | `SidebarProvider.rpc('workItems')` |
| Detail panel: title, state, assignee, editable planning fields, tags, hierarchy (parent/children/related, add child), linked PRs, comments, history | `wiPanel.ts`; field/hierarchy/history logic in `wiModel.ts` (`editableFields`, `hierarchyOf`, `historyEntries`) |
| Change state, assign to me, comment, create, create branch | `wiCommands.ts` |
| Work item from code: selection or to-do comment, light bulb, new ID written back into the comment | `wiCommands.ts` (`createWorkItemFromCode`, `TodoCodeActions`, `titleFromCode`, `isTodoLine`) |
| Sprint tab: team, iteration, items with hierarchy, remaining work vs capacity, working days left | `SidebarProvider.sprint`, `sprint.ts` (`sprintStructure`, `loadByPerson`, `workingDays`) |

## Pipelines (`src/pipelines/`)

| Feature | Code |
| --- | --- |
| Run view: stage graph, jobs and steps, inline log viewer, approvals, tests, stage retry, artifact download | `runView.ts` (`RunViewPanel`) + `media/runView.js`; `stageGraph.ts`, `timeline.ts` |
| Live log terminal and read-only step log documents | `logs.ts` (`BuildLogTerminal`, `LogDocumentProvider`, `stripControl`) |
| Run form: branch, commit, YAML runtime parameters or classic queue-time variables | `runPanel.ts`, `yamlParameters.ts` (`parsePipelineParameters`) |
| Approve / reject a pending approval | `approvals.ts` (`answerApproval`), sidebar "approvals" filter |
| YAML editing: parameter completions, hover, go to definition, diagnostics for `template:` / `extends:` | `yamlTemplates.ts` (`YamlTemplateSupport`), logic in `templateRefs.ts` |
| Templates of repository resources, recursive resolution, `ado-template:` read-only documents | `templateResolver.ts` (`TemplateResolver`, `decodeContext`, `uriOf`) |
| Template tree, server preview with local YAML | `YamlTemplateSupport.showTemplates` / `previewPipeline` (`yamlOverride`) |
| Pipeline preview panel (Local / Azure DevOps buttons, runtime parameters, stage graph, jobs, steps, sources) | `previewPanel.ts` (`PipelinePreviewPanel`) + `media/pipelinePreview.js`; model in `pipelineModel.ts`; local expansion in `templateExpander.ts` and `templateExpressions.ts` |

## Other

| Feature | Code |
| --- | --- |
| Watchers for work items, pull requests and pipelines; notifications, open, command actions | `src/watchers/watchers.ts`, `watchersPanel.ts`, `watchersTree.ts` |
| Wiki pages as editable Markdown files (`ado-wiki:`) with a page picker and "New page" | `src/wiki/wiki.ts` |
| Repositories panel: branches with ahead/behind, compare, create, delete, checkout, clone, create PR | `src/repos/reposPanel.ts` + `media/repos.js` |

Code search is not a feature; see [azure-devops-api.md](azure-devops-api.md#code-search-is-intentionally-not-supported).

## Pitfalls and decisions

- **Template resolution:** paths without alias are relative to the including file (`/` = repository root) and stay in that file's repository; `@self` is the root pipeline's repository; `@alias` looks in the declarations inherited from the including files first (root wins), then the file's own `resources.repositories`, then any YAML file in the workspace. The context travels in the `ado-template:` URI query (`TemplateContext` as JSON); `decodeContext` validates it and only accepts local roots inside a workspace folder.
- **Template sources:** Azure Repos (`type: git`) through `AdoClient` (same auth as everything else); a local clone (matched with `localAdoRepos`, else a workspace folder with the repository's name) wins while `azureDevOps.yaml.preferLocalRepositories` is on. GitHub/Bitbucket repositories are never fetched (credentials only go to Azure DevOps), only read from a local clone.
- **Local expansion** (`TemplateExpander`) follows the server's compile-time rules: parameters are bound with types and defaults (problems become warnings, not errors), whole-value expressions keep their type, booleans become `True`/`False` in text, a `- template:` item inserts the template's list of the same kind as the surrounding key (`steps`, `jobs`, `stages`, `variables`), at most 100 files and 20 levels. Unreadable templates stay in the result marked with `__unresolved` and show as error items. Sources are kept in a `WeakMap` from expanded mappings to file + line (`yamlLine` from the parser).
- **Preview panel:** the mode is remembered in `globalState` (`pipelinePreview.mode`); local previews re-render 700 ms after any YAML edit, server previews on save of the file. The page opens sources only by index into the list the panel sent.
- **Template diagnostics** are debounced (600 ms) and skip expression values, `${{ if }}` keys and parameters passed as one expression; auth and "not configured" errors are silent. Remote files are cached for 30 s; saving a YAML file clears the cache.
- **Stage dependencies:** the build timeline has no dependency information. `RunViewPanel.resolveYaml` asks the pipelines preview endpoint (`previewPipeline`, `previewRun: true`) for the expanded YAML with the run's ref, commit and template parameters, then reads `stages[].dependsOn` (`parseStageDependencies`; no `dependsOn` = previous stage). Fallback: the YAML file at the run's commit. If neither works, `stageDependencies` infers edges from start and finish times. The YAML arrives after the first render and redraws the graph (`deps` message).
- **Jobs stay open:** jobs opened automatically (failed, running or once running) stay open after the run finishes, so steps and logs remain visible. Explicit user choices are kept in webview state.
- **Log completeness:** the page decides it at request time. If the step was no longer active when the log was requested, the answer is the complete log; otherwise the page asks again (only for lines after `have`).
- **Log content is untrusted:** `stripControl` keeps color codes and drops other control sequences before output reaches the terminal; the run view escapes lines.
- **Watchers baseline:** every watcher starts with a silent baseline on its first check (and after a configuration change), so old changes do not flood in. Queries look back 2 minutes further (`OVERLAP_MS`) to tolerate clock skew. Minimum interval 60 s, default 300 s.
- **Own changes:** work item and PR watchers skip changes made by the signed-in user unless `ignoreOwnChanges: false`. Pipeline watchers report own runs by default and skip them only with `ignoreOwnChanges: true`.
- **Watcher command actions:** commands outside `azureDevOps.` run only for watchers in user settings; watchers from workspace or folder settings (`watchersInWorkspaceSettings`) skip them with a warning in the output channel, because a cloned repository could otherwise run commands with text from PRs and work items. Branch and title filters use the linear `glob` matcher, not a regular expression.
- **Branch names before git:** names from webviews or PRs go through `assertBranchName` (`src/git.ts`) before `fetch`/`checkout`/`createBranch`; a leading `-` would be read as an option.
- **Watcher settings are restricted** in untrusted workspaces (`capabilities.untrustedWorkspaces` in `package.json`), together with organization, project, additional projects, tenant and queries.
- **Wiki saves** send the page ETag; a conflict (409/412) tells the user to reopen the page instead of overwriting someone else's change. Delete and rename are not supported (done in the browser).
- **Reviewed marks** are stored locally because the web UI's storage is not public API; a mark disappears when a later iteration changes the file.
- **Approvals** are answered with the project of the run (`at(project)`); an approval that is no longer pending only shows a message.

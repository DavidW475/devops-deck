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

## Other

| Feature | Code |
| --- | --- |
| Watchers for work items, pull requests and pipelines; notifications, open, command actions | `src/watchers/watchers.ts`, `watchersPanel.ts`, `watchersTree.ts` |
| Wiki pages as editable Markdown files (`ado-wiki:`) with a page picker and "New page" | `src/wiki/wiki.ts` |
| Repositories panel: branches with ahead/behind, compare, create, delete, checkout, clone, create PR | `src/repos/reposPanel.ts` + `media/repos.js` |

Code search is not a feature; see [azure-devops-api.md](azure-devops-api.md#code-search-is-intentionally-not-supported).

## Pitfalls and decisions

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

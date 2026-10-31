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
| Pipeline designer: parameter form, template catalog (repository + ref), structure strip, YAML preview with change marks, server validation; CodeLens *Open in Designer* | `designerPanel.ts` (`PipelineDesignerPanel`, `DesignerCodeLens`) + `media/pipelineDesigner.js`; view model in `designerModel.ts`; line edits in `templateEdits.ts`; object/list values in `objectParams.ts`; catalog and refs in `TemplateResolver.catalog` / `refsOf` |
| Pipeline preview panel (Local / Azure DevOps buttons, runtime parameters, stage graph, jobs, steps, sources) | `previewPanel.ts` (`PipelinePreviewPanel`) + `media/pipelinePreview.js`; model in `pipelineModel.ts`; local expansion in `templateExpander.ts` and `templateExpressions.ts` |

## Other

| Feature | Code |
| --- | --- |
| Watchers for work items, pull requests and pipelines; notifications, open, command actions | `src/watchers/watchers.ts`, `watchersPanel.ts`, `watchersTree.ts` |
| Wiki pages as editable Markdown files (`ado-wiki:`) with a page picker and "New page" | `src/wiki/wiki.ts` |
| Repositories panel: branches with ahead/behind, compare, create, delete, checkout, clone, create PR | `src/repos/reposPanel.ts` + `media/repos.js` |

Code search is not a feature; see [azure-devops-api.md](azure-devops-api.md#code-search-is-intentionally-not-supported).

## Pitfalls and decisions

- **Sidebar rendering (`media/sidebar.js`):** the list is updated with `patchList` (keyed by `data-key`, else tag + class; matching children are morphed, others added or removed), the toolbar with `patchHtml` and one card with `renderCard` (both morph). Identical HTML is skipped, so background refreshes and pipeline polling touch only what changed and keep hover, focus, open dropdowns and running spinners. Give every new top-level list element a stable `data-key`; attach listeners by delegation on `#app` (select `change` goes through `CHANGES`), never on elements inside morphed areas; animate opened sections with `rise()` (Web Animations), not a CSS class, because a morph rewrites `class`. The tab bar is built once (`renderTabs` toggles classes and badges, the indicator is measured in `requestAnimationFrame`), search filtering runs once per frame, and CSS keyframes animate only `transform`/`opacity` (checked in `sidebarProvider.test.ts`).
- **Template resolution:** paths without alias are relative to the including file (`/` = repository root) and stay in that file's repository; `@self` is the root pipeline's repository; `@alias` looks in the declarations inherited from the including files first (root wins), then the file's own `resources.repositories`, then any YAML file in the workspace. The context travels in the `ado-template:` URI query (`TemplateContext` as JSON); `decodeContext` validates it and only accepts local roots inside a workspace folder.
- **Template sources:** Azure Repos (`type: git`) through `AdoClient` (same auth as everything else); a local clone (matched with `localAdoRepos`, else a workspace folder with the repository's name) wins while `azureDevOps.yaml.preferLocalRepositories` is on. GitHub/Bitbucket repositories are never fetched (credentials only go to Azure DevOps), only read from a local clone.
- **Local expansion** (`TemplateExpander`) follows the server's compile-time rules: parameters are bound with types and defaults (problems become warnings, not errors), whole-value expressions keep their type, booleans become `True`/`False` in text, a `- template:` item inserts the template's list of the same kind as the surrounding key (`steps`, `jobs`, `stages`, `variables`), a list item that is only an expression returning a list (`- ${{ parameters.stages }}`) inserts its items, at most 100 files and 20 levels. Unreadable templates stay in the result marked with `__unresolved` and show as error items. Sources are kept in a `WeakMap` from expanded mappings to file + line (`yamlLine` from the parser).
- **Preview panel:** the mode is remembered in `globalState` (`pipelinePreview.mode`); local previews re-render 700 ms after any YAML edit, server previews on save of the file. The page opens sources only by index into the list the panel sent.
- **Designer edits are line edits:** `templateEdits.ts` never re-serializes YAML. It plans `LineEdit`s (replace whole lines) against the current document text; `toRangeEdits` merges touching edits into non-overlapping `WorkspaceEdit` ranges, and `applyLineEdits` computes the preview with `+`/`~` marks from the unmerged edits. Only parameters the user changed are written (`pending`); a value equal to the default removes its line unless *Write defaults* is on, and an emptied `parameters:` key is removed too. Calls with an expression path, `parameters: ${{ … }}`, a flow mapping or `${{ each }}` / `${{ insert }}` / other expression keys are read-only (`callReadOnlyReason`). `${{ if }}` / `${{ elseif }}` / `${{ else }}` keys only make the parameters under them read-only; the rest of the call stays editable (new parameters go after the conditional blocks). Also read-only: scalar parameters with block values (`|`, `>`). Note that `TemplateRef.dynamicParams` is also true for if/else keys; it means "names can't be checked completely" (diagnostics), not "read-only".
- **Designer object/list parameters:** `raw` parameters (object, step/job/stage and their lists) carry their value as YAML text in `pending`: dedented, read by `passedValue` (the whole nested block through `blockEnd`) or built from the JSON default (`defaultText`). `planStructured` replaces the parameter line plus its block with `paramLines` (inline for scalars, flow collections and expressions, else nested at the file's child column) and removes it when the value equals the default (`sameStructured`). Object parameters also get a `TreeNode` form. The webview posts the tree, the panel turns it into text with `treeText` and keeps the tree (`trees`), so empty and duplicate keys stay visible and are reported (`treeIssue`) instead of collapsing in the parsed text. Pitfalls: the form round trip drops comments inside the block and orders integer-like keys first (JS objects); the YAML field keeps the text as written. Booleans and quoted `'true'` strings stay distinct (`bool` vs `text` nodes); numbers stay strings. Lines of a block scalar are scanned as blank, so `blockEnd` counts lines indented deeper than the key as part of the block (otherwise inserts land inside a `script: |`).
- **Designer state:** the panel works on the open document (closed ones are reopened) and re-renders 300 ms after any edit of it. The selection is kept by the call's raw path and nearest line. New calls go to the end of a list found by `findInsertionPoints` (default: the last one; the user picks another). The catalog reads at most 300 YAML files with a top-level `parameters:` per repository and caches remote listings 5 minutes per repository + ref (the ↻ button forces a reload); refs come from the Refs API (tags first, newest first, then branches). Validation passes the pending text to `expandOnServer(…, text)`; error lines are only linked when there are no pending changes.
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

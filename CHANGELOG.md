# Changelog

## 1.2.0

### Added

- My Day: a tab with a ranked list of what needs you now (approvals waiting for you, your failed runs, pull requests to review, assigned work items), the reason for each rank and quick actions. Items can be snoozed, marked done until they change or hidden, and restored. A badge on the view shows the count. New commands *Defer* and *Restore* for items and *Vote on Pull Request*, and the setting `azureDevOps.myDay.importantBranches`
- Task support in pipeline YAML: completion of `- task:` names (deprecated and retiring ones last), majors, `inputs:`, input names (required first, hidden inputs left out) and values; hover with description, version, deprecation or retirement, newer major, input type, visibility condition and help; checks for tasks that are not installed, missing required inputs, unknown inputs, values outside the allowed ones, deprecated and retired tasks (Microsoft retires many built-in tasks on 2026-11-24) and newer major versions; quick fixes add an input, raise the version or refresh the catalog. The tasks come from the organization (cached 24 hours, refreshed in the background). New command *Refresh Task Catalog* and settings `azureDevOps.yaml.taskSupport`, `.taskDiagnostics` and `.taskVersionHints`
- Pipeline designer for task steps: *Open in Designer* above `- task:` lines, task steps in the structure strip, and a form with the version, display name and inputs in groups. Inputs show and hide with the task's `visibleRule` as values change (a hidden input that the file sets stays, marked), multi-line inputs such as `inlineScript` are text areas that keep the block scalar header, and help texts are plain text. Changes are written as line edits like for templates; changing the version edits only the `task:` line. Steps with expression-built inputs are read-only
- Pipeline designer task catalog: a *Templates* / *Tasks* switch lists the tasks of the organization by category with version chips and a collapsible *Deprecated* list, with loading, error (naming the Agent Pools scope) and offline states, the age of the list and a reload button. A picked task opens a new-step form with a choice of the `steps:` list and a preview; *Insert into pipeline* writes the step
- Trace a line to its pull request and work items: the command *Trace Line to Pull Request* (editor context menu), a *Pull Request & Work Items* link in the blame hover of VS Code, and opt-in annotations in the status bar and after the cursor line. Settings `azureDevOps.blame.annotations`, `.ignoreWhitespace` and `.detectCopies`. Runs `git blame` locally (not in untrusted workspaces)

### Changed

- Personal access tokens need the scope **Agent Pools** (Read) for the task catalog; without it, only the task help is missing
- Sidebar: long lists render in pages of 40 cards (the next page loads while scrolling), icons share one sprite, and the layout follows the VS Code theme more closely (flatter cards, underline tabs, high contrast borders). Pull request checks are reused for 15 seconds instead of being requested again on every list load

## 1.1.0

### Added

- Pipeline designer: a form for the parameters of `template:` and `extends:` calls (text, number, choices, switches; required and changed values marked, type and allowed-value errors shown). Inserts or updates the call with targeted line edits, so formatting and comments stay, undo works and the file shows as unsaved; values equal to the default are left out unless *Write defaults* is on
- Template catalog in the designer: the templates of a repository resource (or of the pipeline's own repository) at a tag or branch, with an "in pipeline" mark; pick one to insert a new call at the end of a chosen `steps:`, `jobs:` or `stages:` list. The `ref:` of the repository resource can be switched (warns when it points to a branch), and *Add repository…* declares another repository of the project
- Structure strip with the stages and their template calls, YAML preview with the pending changes marked (`+` inserted, `~` changed), and *Validate*, which lets Azure DevOps expand the pipeline with the pending changes and lists its errors
- Calls with parameters under `${{ if }}` / `${{ else }}` stay editable: only the conditional parameters are read-only
- Object parameters in the designer: a tree form (keys, values, list items; text, yes/no, mapping or list; `${{ if }}` / `${{ each }}` keys stay keys) with a switch to YAML text. Step, job and stage parameters (`stepList`, `jobList`, `stageList`, `step`, `job`, `stage`) get a YAML field with the block as written, comments included. Writing back replaces only that parameter's block, with the file's indentation, and drops a value equal to the default unless *Write defaults* is on. Values under `${{ if }}` stay read-only
- Opens with *Open in Designer* above every call (`azureDevOps.yaml.designerCodeLens`), the command *Open Pipeline Designer* or the *Designer* button of the pipeline preview

### Changed

- Smoother UI: the pull request and work item panels update in place after an action instead of reloading the page (no flash; scroll position, focus, open sections and drafts stay), with a thin progress bar while the action runs
- Sidebar: refreshes and pipeline polling change only what differs, so hover, focus, open cards and dropdowns stay; open cards no longer flash "Loading…" on refresh; the tab indicator slides; search filters once per frame
- Run view, pipeline preview, designer and repositories rewrite only changed sections (open artifact menu, scroll positions and the field being edited stay); animations use only transform and opacity
- Screenshots of the pipeline designer (parameter form and object parameters) and the pipeline preview in the README

### Fixed

- Pipeline preview: the job count in the stage cards lines up with the stage name instead of being indented
- Designer: a new parameter added after a parameter whose block ends with a multi-line script (`script: |`) goes after the script instead of into it
- Local pipeline preview: a list item that is only an expression returning a list (`- ${{ parameters.stages }}`, typical in extends templates) inserts its items instead of a nested list

## 1.0.0

### Added

- Pipeline YAML: suggestions for the parameters of `template:` and `extends:` references (names with type, default and allowed values, values, a block with all required parameters), hover, go to definition and checks for unknown, missing and invalid parameters
- Templates from repository resources (`file.yml@alias`) are read from Azure Repos at the resource's `ref` or from a clone in the workspace, recursively through templates that include templates from further repositories
- Pipeline preview: stage graph, jobs and steps of what the templates produce, expanded locally (with the template file and line of every item, unsaved changes included) or by Azure DevOps; runtime parameters can be changed in the preview
- *Show Pipeline Templates* lists every template a pipeline includes; *Validate and Preview Expanded Pipeline* lets Azure DevOps expand the pipeline with the local file content and marks its errors

### Fixed

- Runtime parameters: multi-line defaults (`|`, `>`) keep `#`, blank lines and `---` instead of dropping them

## 0.2.1

### Fixed

- Run overview: finished runs of pipelines with stages show their stage graph and jobs again instead of only the "Finalize build" job

## 0.2.0

### Added

- Several projects at once: tick more projects in the project picker (`azureDevOps.additionalProjects`); the dashboard lists their pull requests, work items, sprints, pipelines and approvals together
- Pull requests: create pull requests (prefilled from the branch and its commits, reviewers, work items, draft, auto-complete, pushes unpushed branches), add and remove reviewers, set or cancel auto-complete, list updates and commits, review the changes since your last visit, status bar entry for the checked-out branch
- Work items: edit assignee, iteration, area, priority and other planning fields and tags; parent, children and related items; add child tasks; history; create work items from selected code or to-do comments (light bulb)
- Sprint tab: a team's sprint with progress, working days left, remaining work against capacity per person, grouped by state, parent or person
- Pipelines: stage graph with real dependencies (parallel stages side by side), log viewer inside the run overview (also for finished runs), approve or reject pending approvals (also listed under *Approvals*), rerun failed stages, failed tests with error and stack trace, artifact downloads
- Pipeline watchers: notifications for failed, succeeded, canceled or started runs, filtered by pipeline, branch and who started them
- Repositories and branches: ahead/behind, compare with the default branch, create, delete, check out, clone
- Wiki: search page titles, read rendered pages, edit and create pages with conflict protection

### Fixed

- Run overview: stages that do not depend on each other are no longer drawn as a chain
- Run overview: steps and their logs no longer disappear when a run finishes
- *Create branch* for a work item uses the repository of the active file (or asks) instead of always the first one
- A pull request without iterations no longer causes an empty file list error
- Run overview: the close button of the log pane closes the log instead of moving it below the jobs
- Sidebar views have an icon when they are moved to another view container

### Security

- Work item descriptions and comments, and rendered pull request Markdown, are sanitized before they are shown
- Branch names are validated before they are passed to git (checkout from the repositories panel and of pull requests)
- Request paths with empty, `.` or `..` segments or with `?`, `#` or `\` are refused, so ids from webviews cannot reach other API routes
- Watcher command actions from workspace settings only run DevOps Deck commands; other commands need a watcher in user settings
- Watcher wildcard filters are matched without regular expressions

### Changed

- Live build logs in the terminal load the logs of several steps in parallel; work item watchers load revision details in parallel
- Sidebar tabs show the label of the active tab only, so four tabs fit a narrow sidebar; work item card actions float on hover instead of making every card tall
- Editor panels use icon buttons for refresh and open in browser; work item details use a two-column layout with short iteration and area names
- New and updated screenshots in the README
- Policy states of pull requests are loaded with at most six requests at a time; the sprint tab loads only when opened
- Code reworked to pass the SonarQube (SonarJS) rules without findings

## 0.1.0

Initial release.

- Sidebar dashboard with pull requests, work items and pipelines
- Pull request review: native diffs, inline comments, code suggestions, votes, complete/abandon, reviewed-file check marks
- Pull request checks: branch policy status on every card, with failing policies and links to their pipeline runs
- Work items: built-in and saved queries, detail view, state changes, comments, linking pull requests, branch creation
- Pipelines: run overview with stages/jobs/steps, live log streaming, run form with runtime parameters and variables
- Watchers: configurable background checks for work items and pull requests with notifications, auto-open or custom commands
- Sign-in with Microsoft (Entra ID) or Personal Access Token

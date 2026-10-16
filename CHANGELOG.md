# Changelog

## Unreleased

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

### Security

- Work item descriptions and comments, and rendered pull request Markdown, are sanitized before they are shown

### Changed

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

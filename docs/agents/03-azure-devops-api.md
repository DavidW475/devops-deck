# Azure DevOps REST API (`src/client.ts`)

All REST traffic goes through `AdoClient`. Do not call `fetch` elsewhere.

## Request pipeline

- `url(scope, path, query, project?)` builds `<orgUrl>/_apis/<path>` (`scope: 'org'`) or `<orgUrl>/<project>/_apis/<path>` (`'project'`), sets query params (undefined values are skipped) and adds `api-version=7.1` unless the query already sets one.
- `url()` and `teamUrl()` refuse paths with an empty, `.` or `..` segment (also percent-encoded) or with `?`, `#` or `\` (`isSafeApiPath`), because ids from webviews and API responses are put into paths. Encode string segments with `encodeURIComponent`.
- `get(scope, path, query)` is the shortcut for JSON GETs.
- `request<R>(method, url, body?, opts)` returns parsed JSON, `undefined` for 204, or text with `raw: true`.
- `send(...)` is the low-level call that returns the `Response` (used for headers such as ETags and for binary downloads). It:
  - refuses any URL where `isAzureDevOpsUrl(url)` is false (credentials only to `https://dev.azure.com` and `https://*.visualstudio.com`; **do not loosen**),
  - sets `Authorization`, `Accept`, `X-TFS-FedAuthRedirect: Suppress`, and `Content-Type` (default `application/json`) when there is a body,
  - aborts after `REQUEST_TIMEOUT_MS` (60 s) or `opts.timeoutMs`, so polling loops never hang,
  - turns 401, 203 or an HTML answer into `AdoError(..., 401, isAuthError = true)` and other non-2xx answers into `AdoError(message, status)`.
- Errors in command handlers are shown by `guarded()`; auth errors offer sign-in.

## Authentication

- Setting `azureDevOps.authMethod`: `microsoft` (default) or `pat`.
- Microsoft: `vscode.authentication.getSession('microsoft', ['499b84ac-1321-427f-aa17-267ca6975798/.default', optional 'VSCODE_TENANT:<azureDevOps.tenantId>'])`, sent as `Bearer`. Requests never prompt; only `signIn()` is interactive.
- PAT: stored in secret storage under `azureDevOps.pat` (`PAT_SECRET_KEY`), sent as `Basic base64(':' + pat)`.
- PAT scopes (setPat prompt in `extension.ts` and README): Code (Read & Write), Work Items (Read & Write), Build (Read & Execute), Wiki (Read & Write), Project and Team (Read), Identity (Read), Test Management (Read), Agent Pools (Read, task catalog). A new endpoint that needs another scope must update both places.
- `getMe()` uses `<org>/_apis/connectionData`, cached on the root client.

## API versions

Default `7.1`. These calls pass a preview version explicitly:

| Call | api-version |
| --- | --- |
| `getPolicyEvaluations` (`policy/evaluations`) | `7.1-preview.1` |
| `getWorkItemComments`, `addWorkItemComment` | `7.1-preview.4` |
| `searchIdentities` (`IdentityPicker/Identities`) | `7.1-preview.1` |
| `listPendingApprovals`, `getApproval`, `updateApproval` (`pipelines/approvals`) | `7.1-preview.1` |

`previewPipeline` (`POST pipelines/{id}/preview` with `previewRun: true`, api-version `7.1-preview.1`) is the pipelines "preview run" endpoint. With `yamlOverride` it expands the given YAML instead of the committed root file (used by *Validate and Preview Expanded Pipeline* and the designer's *Validate*, which sends its pending, unsaved text); other files still come from the server.

## Org vs project routes

- Organization routes: work items by ID (`wit/workitems`, updates, relations), `git/pullrequests/{id}`, `projects/{project}/teams`, identity picker, `connectionData`, `_apis/projects`.
- Project routes: WIQL, saved queries, work item types/states/fields/comments, builds, pipelines, approvals, tests, wiki, repository lists.
- `REPO_BY_ID`: any path starting with `git/repositories/<GUID>` is sent to the **organization** route even when called with `'project'`. Repository IDs are unique in the org, so PR and repository calls work for repositories of any selected project. Calls by repository *name* (`getRepository(name)`) stay project-scoped.
- `getPolicyEvaluations(projectId, prId)` puts the PR's own project ID into the route.
- Team routes (`teamUrl`): `<org>/<project>/<team>/_apis/work/teamsettings/...` for iterations, iteration work items, capacities, team days off.

## Work items

- Writes use JSON Patch with `contentType: 'application/json-patch+json'`.
- `fieldOps(fields)`: `add /fields/<ref>` per field; `null` or `undefined` becomes `remove` (clears the field). `updateWorkItem(id, { 'System.Tags': null })` clears tags.
- Relation removal (`removeWorkItemRelation`, `unlinkPullRequest`) sends `{ op: 'test', path: '/rev', value: rev }` first to guard against concurrent edits.
- Parent link on create: `System.LinkTypes.Hierarchy-Reverse` relation.
- PR ↔ work item links are `ArtifactLink` relations with `vstfs:///Git/PullRequestId/<projectId>%2F<repoId>%2F<prId>` (`prArtifactUrl` / `parsePrArtifact`).
- `getWorkItems` batches 200 IDs per request with `errorPolicy: 'omit'`.
- WIQL text built from user input escapes `'` as `''` (`searchWorkItems`).

## Other conventions

- **Identity picker:** `searchIdentities` posts to `IdentityPicker/Identities` (users and groups, `ims` + `source` scopes) and maps `localId` to `id`.
- **Wiki ETag:** `getWikiPage` returns the page and its `ETag` header; `saveWikiPage` sends `If-Match: <etag>` when updating (no ETag = create) and returns the new ETag. 409/412 means someone else changed the page.
- **Artifacts:** `download(url)` uses `send` with `binary: true` and a 30 minute timeout. `fetch` drops the `Authorization` header on cross-origin redirects (e.g. to blob storage), so credentials do not leak.
- **Paging:** `getIterationChanges` follows `nextSkip`; `diffBranches` pages with `$skip` while `allChangesIncluded === false`.
- **Web links:** `webUrl(kind, ...)` builds browser URLs for PRs, work items, builds, definitions and repos.

## Files at a ref

`getFileTextAtRef(repoId, path, ref?)` maps a repository resource `ref` to a version descriptor: `refs/tags/x` → tag, a 40-character SHA → commit, `refs/heads/x` or a plain name → branch, none → the repository's default branch. `listYamlDefinitions(repoId)` lists the YAML pipelines of a repository (`includeAllProperties` for `process.yamlFilename`). For the designer's catalog, `listFilePaths(repoId, ref?)` lists every file at the same kind of ref (Git Items API, `scopePath=/`, `recursionLevel=Full`; folders dropped) and `listRefNames(repoId)` reads tags and branches (`git/repositories/{id}/refs` with `filter=tags/` and `filter=heads/`, 500 each).

## Task catalog (undocumented route)

`listTaskDefinitions()` reads `GET <org>/_apis/distributedtask/tasks` (api-version 7.1). The route is **not in the REST reference** (Learn has no page for it); it is known from the generated Microsoft client (`getTaskDefinitions`) and from `OPTIONS _apis`. It is the only source with `visibleRule`, `helpMarkDown` and input defaults, so the YAML task support (`taskCatalog.ts`) depends on it. Pitfalls:

- Scope: the PAT needs **Agent Pools (Read)** (`vso.agentpools`); inferred, not verified. A missing scope probably arrives as 401 and cannot be told apart from an expired token (`isAuthError`), so the background never prompts for a sign-in and never shows an error: the catalog snapshot carries `status: 'error'` and `error`, and `YamlTaskSupport` stays quiet (no task completion, no "not installed" marks; retirement checks need no catalog and keep working).
- Fallback: the response is reduced to `TaskInfo` and cached per organization in `globalStorageUri`; failures keep the old data (`stale`/`error` status). If the route disappears, task help degrades to nothing rather than wrong warnings. A planned fallback is `distributedtask/yamlschema` (documented, but without `visibleRule`, help and defaults).
- Not verified against a real organization: whether every major version is returned, `deprecationMessage` / `removalDate`, response size.
- Server text (titles, help, options) is untrusted: hovers use `mdEscape`, `MarkdownString` is neither trusted nor HTML, `helpUrl` is only linked for `https:` and never fetched.

## Code search is intentionally not supported

Azure DevOps Code Search is only served from `almsearch.dev.azure.com`, which `isAzureDevOpsUrl` rejects on purpose. The maintainer decided not to offer code search rather than loosen the credential host check. Do not re-add it without asking the maintainer.

## Adding an endpoint

1. Add a method to `AdoClient` in the matching section; return typed data (add types to `src/types.ts`).
2. Choose `'org'` or `'project'` scope deliberately; pass a preview `api-version` only if 7.1 does not exist for it.
3. Add a unit test in `src/test/client.test.ts`: it replaces `globalThis.fetch` and asserts the URL, method, headers and body. Use fictitious data (`https://dev.azure.com/contoso`, project `Fabrikam Shop`).

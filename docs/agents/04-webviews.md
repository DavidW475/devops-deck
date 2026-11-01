# Webviews

Two kinds: the sidebar dashboard (`SidebarProvider` + `media/sidebar.js`) and editor panels (see [01-architecture.md](01-architecture.md#editor-panels)). Webviews run with `enableScripts: true` and `localResourceRoots` limited to `media/`.

## CSP and nonce

- Editor panels use `panelHtml(webview, extensionUri, title, body, script, scriptFile?)` from `src/util.ts`. It creates a fresh `nonce()`, sets the CSP (`default-src 'none'`, `script-src 'nonce-…'`, `img-src` webview + `https:` + `data:`, styles from the webview source plus inline), links `media/panel.css`, runs `script` inline after `const vscode = acquireVsCodeApi();` and optionally loads `media/<scriptFile>` with the same nonce.
- Use an external `scriptFile` for large page scripts (`runView.js`, `repos.js`); smaller panels pass the script as a string.
- The sidebar builds its own document with the same kind of CSP and loads `media/sidebar.js` with a nonce.
- Never add `'unsafe-inline'` or `'unsafe-eval'` to `script-src`, and never put inline event handlers (`onclick=`) in HTML: they are blocked anyway. Use delegated listeners with `data-*` attributes.

## Escaping and sanitizing

- **Server data in HTML:** always `escapeHtml(x)` (extension side) or `esc(x)` (page scripts: `sidebar.js`, `runView.js`, `LINK_PICKER_SCRIPT`). This covers titles, names, branch names, log lines, error messages, attribute values.
- **User-written HTML / Markdown:** work item descriptions and HTML fields, work item comments, PR descriptions and PR comments are written by anyone in the project. Render them with:
  - `sanitizeHtml(html)` for HTML (work item fields and comments in `wiPanel.ts`),
  - `renderMarkdown(text)` for Markdown (PR description and comments in `prPanel.ts`); it renders with `markdown.api.render` and sanitizes the result, falling back to escaped `<pre>`.
- `sanitizeHtml` is an allowlist scanner: known formatting tags only, a few attributes, `href`/`src` only `http:`, `https:`, `mailto:` (and `data:image/...` for `src`), drops `script`/`style`/`iframe`/`svg`/forms and their content, removes event handlers, styles and ids, adds `rel="noreferrer noopener"` to links, keeps only disabled checkboxes. It is linear (no backtracking regex) so large descriptions stay fast. The CSP is the second line of defence, not the first.
- Put sanitized content inside a `.md` container (`<div class="md">` / `<div class="md html">`). Page click handlers ignore clicks inside `.md` (`el.closest('.md')`), so look-alike buttons or `data-*` attributes in user content cannot trigger actions. `LINK_PICKER_SCRIPT` skips `.md` too.

## Messages

- Page → extension messages are untrusted. Convert every field: `Number(m.id)`, `String(m.text ?? '')`, `!!m.enabled`, `Array.isArray(...)`. Unknown `type`s fall through and are ignored.
- Commands requested by a page are executed only when the name starts with `azureDevOps.` (sidebar `command` message, watchers panel `open`). Prefer handling a specific message type over forwarding command names.
- Wrap the handler: `panel.webview.onDidReceiveMessage(guarded(m => this.handle(m)))`.
- Post through a helper that checks `disposed` (see `RunViewPanel.post`, `LivePanel.post`).
- Request/response pairs that can race (search boxes) carry a `seq`; the page drops answers whose `seq` is not the latest.

## Link picker (`src/util.ts`)

- `linkPickerHtml(placeholder, picker = 'link')` renders a search box; name it when a page has several (`'link'`, `'reviewer'`).
- `LINK_PICKER_SCRIPT` (add it to the panel's script) posts `linkSearch {text, seq, picker}` (debounced 200 ms), `link {key, picker}` and `unlink {key}` (for `[data-unlink]` buttons). Its listeners are delegated to the document, so boxes keep working after an in-place update; on live panels `link`/`unlink` go through `postAction`.
- The extension answers with `{ type: 'linkResults', seq, picker, items: LinkCandidate[] }` or `{ ..., error }`. `key` is opaque to the page.

## Styling

- `media/panel.css` for all editor panels, `media/sidebar.css` for the dashboard. No other stylesheets.
- Colors come from VS Code theme variables (`var(--vscode-…)`), mapped to local tokens in `:root` (`--fg`, `--muted`, `--bg`, `--card`, `--border`, `--primary`, `--ok`, `--bad`, `--warn`, `--info`). Use the tokens, so light, dark and high-contrast themes work. Hard-coded colors only for data (work item type colors, state colors from the server).

## Performance rules used in the code

- **In-place updates (`LivePanel` in `src/util.ts`):** the PR overview and the work item panel never reassign `webview.html` after the first render (that reloads the page: white flash, scroll to top, lost focus and drafts). `LivePanel.show(title, body)` writes the document once (body inside `<div id="root">`, `LIVE_UPDATE_SCRIPT` before the panel script) and afterwards posts `{ type: 'update', title, html }`; the HTML is the same escaped/sanitized `bodyHtml` output. The page swaps `#root` and keeps the scroll position, open `<details>` (by `id`), focus and caret, and drafts in fields with an `id` or `name` (not disabled, not part of a form submitted since the last update, so a sent comment is cleared), sets `document.title` and dispatches `panel:updated`. Page actions that re-render use `postAction(message, el)`: it sets `body.updating` and marks `el` (fields disabled, others `.busy`) until the answer. Every action ends in an `update` or `{ type: 'idle' }` (cancelled, failed, unknown; `LivePanel.action(run)` posts it, `render` posts it on errors), which re-enables the marked controls. Navigation-only messages use plain `vscode.postMessage`. Bind page listeners on `document` (delegated), never on elements inside `#root`.
- **Partial re-render (sidebar):** `patchList` updates `#list` keyed by `data-key` (else tag + class): matching children are morphed in place, others added or removed, identical HTML is skipped. `patchHtml` morphs the toolbar and `renderCard(key)` morphs a single card, so refreshes and polling keep hover, focus, open `<select>`s and running spinners. Give every new top-level list element a stable `data-key`, attach listeners by delegation on `#app`, and use `element.animate` (`rise()`) instead of CSS classes for one-off animations (a morph rewrites `class`). The tab bar is built once; switching only toggles classes and layout reads (`offsetLeft`) happen in `requestAnimationFrame`. Search input and resize run at most once per frame. `runView.js` renders head, graph, jobs, log pane and tests separately, so polling keeps scroll position, open jobs and the open log.
- **Skip unchanged DOM writes:** page scripts keep the last HTML written per section and skip the write when it is equal: `write(key, el, html)` in `runView.js` (ticking durations are left out of the comparison; a skipped section still clears `.busy`), `write(id, html, key)` in `pipelinePreview.js`, and in `pipelineDesigner.js` parts marked `data-sec`, filled through `<template data-sec>` slots by `patch()`; YAML preview lines are diffed by `patchCode()`. The designer does not replace a row whose only change is the value of the focused field (keeps caret, undo, IME). Do not go back to rewriting a whole page with `app.innerHTML` per message.
- **Frame-batched work:** resize, edge drawing and filter renders run in `requestAnimationFrame` and/or after a debounce. The run view's 1 s duration ticker pauses while the panel is hidden.
- **Animations:** `transform` and `opacity` only, never animated `background-position`, `left`/`top` or `box-shadow` (fade a shadow on a pseudo-element instead). Both stylesheets end with a `prefers-reduced-motion` block that every animation must respect. `body.updating` shows a thin progress bar (`panel.css`, after 0.2 s).
- **Long lists:** `content-visibility: auto` with `contain-intrinsic-size: auto <px>` on list rows (`.chunk`, `.thread`, `.hist`, `.branch-row`) and `contain: content` on scroll boxes; not on rows with absolutely positioned popups or sticky children.
- **Chunked logs:** `runView.js` appends log lines in blocks of 2000 (`CHUNK`); each `.chunk` has `content-visibility: auto` (`panel.css`) so off-screen blocks are skipped. New lines are appended, not re-rendered (except the first batch or while filtering). The extension sends only lines after `have`.
- **Lazy loading:** on start the sidebar loads the visible tab first and the other tabs in the background for their badges, except the sprint tab (several requests), which loads only when opened; its teams are loaded once. Run view: test run summaries only after the run completes (cached per panel), failed test results only when a test run is expanded, artifacts only when the menu opens, YAML stage dependencies after the first render.
- **Concurrency:** `mapLimit(items, limit, fn)` for fan-out (6 policy evaluations at a time in the PR list, 4 projects at a time in `perProject`).
- **Caches with limits:** run view YAML deps (max 50 builds), wiki page tree (5 minute TTL), work item panel lists (until refresh), work item states per project + type in the sidebar (cleared on refresh), PR blob contents by object ID (immutable). Failed promises are removed from caches.
- **Polling when unfocused:** the sidebar background refresh (`azureDevOps.refreshInterval`) runs only for the visible tab and only while the window has focus; it catches up on focus. The PR status bar skips updates while unfocused and refreshes when focus returns. Running pipeline runs poll every `azureDevOps.pipelines.refreshInterval` seconds (minimum 5).

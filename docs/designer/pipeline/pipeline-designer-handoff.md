# Pipeline Designer – Handoff

Context for implementing a form-based editor for `template:` calls in DevOps Deck.
Written from a design conversation; the mock is in `pipeline-designer-mock.dc.html` (see "About the mock file" at the end).

## Goal

Let developers configure calls to shared pipeline templates (living in a central template repo, referenced via
`resources.repositories` + `path@alias`) through a generated form instead of hand-written YAML.

MVP scope: **consuming** templates — pick a template, fill its parameters, insert or update the call, validate.
Not in scope for the MVP: a free visual editor for stages/jobs/steps, authoring templates.

## Decisions

- **Lives in DevOps Deck**, under `src/pipelines/`, not as a separate extension. Auth, client, template resolution,
  parameter parsing and server preview already exist there.
- **No new dependencies.** Keep the line-based approach the extension already uses.
- **Write back with targeted `WorkspaceEdit`s** on the lines `findTemplateRefs` reports, never by re-serializing the
  whole document. Keeps formatting and comments, and gives native undo/redo and dirty state.
- Optional feature: entry points only; users who prefer text never see it unless they open it.

## UI (as in the mock)

1. **Template catalog** (left)
   - Template repo name + project, alias.
   - `ref` selector (tags and branches, e.g. `v2.1`, `v2.0`, `main`).
   - Filter field; folder tree of template files; badge "in pipeline" for templates already called.
2. **Pipeline structure** (top strip)
   - Stages as cards with the template calls inside; clicking a call selects it.
   - A template selected from the catalog but not yet used shows as a dashed "new" item in its target stage.
3. **Parameter form** (center), generated from the template's `parameters:` block
   - `string` → text input, `number` → number input, `values: [...]` → segmented buttons, `boolean` → switch.
   - Badges: type, "required" (no default), "unsaved" (differs from the file).
   - Inline errors: required without value, number not numeric (later: everything `checkTemplateParameters` reports).
   - Help line: `displayName`/description + default.
   - Actions: **Insert into pipeline** / **Update in pipeline**, **Validate**, **Reset to defaults**.
4. **YAML preview** (right)
   - Excerpt of `azure-pipelines.yml` with the `resources` block and the call in its context.
   - Diff markers: `~` changed line, `+` inserted line.
   - Parameters equal to their default are omitted unless "Write defaults" is checked.
   - A changed `ref` is marked as well.
5. **Validation panel** (bottom)
   - Idle / running / ok / error states; uses the server preview (`previewRun` + `yamlOverride`).
   - Errors mapped to file/line via `parsePreviewErrors`.
   - Warning when `ref` points to a branch (`refs/heads/...`): template changes take effect immediately.
6. View toggle **Designer / YAML only**.

## What already exists (reuse)

| Need | Where |
| --- | --- |
| Resolve `path@alias`, other repos via REST or local clone, recursively | `src/pipelines/templateResolver.ts` (`TemplateResolver`) |
| Read a template's parameters (type, default, values) | `src/pipelines/yamlParameters.ts` (`parsePipelineParameters`) |
| Find calls + passed params with line/column positions, conditional flag | `src/pipelines/templateRefs.ts` (`findTemplateRefs`, `ParamEntry`) |
| Check passed params against declared ones | `templateRefs.ts` (`checkTemplateParameters`) |
| Repository resources of a pipeline | `templateRefs.ts` (`parseRepositories`) |
| Server preview | `src/client.ts` (`previewPipeline`), `yamlTemplates.ts`, `previewPanel.ts` (server mode) |
| Local expansion | `src/pipelines/templateExpander.ts` |
| Stages/jobs/steps model and graph | `src/pipelines/pipelineModel.ts`, `stageGraph.ts` |
| Webview scaffolding | `panelHtml` in `src/util.ts`; patterns in `previewPanel.ts`, `runPanel.ts` |
| Form for runtime parameters (similar UI) | `src/pipelines/runPanel.ts` |

## What is new

- `src/pipelines/templateEdits.ts` — **pure** functions, unit-tested with the existing Node test runner:
  - input: document text, a `TemplateRef` (or an insertion point), declared parameters, new values, options
    (`writeDefaults`);
  - output: text edits (replace value, add parameter line, remove line, add `parameters:` key, insert whole call,
    add/update the `resources.repositories` entry incl. `ref`);
  - detect indentation from the surrounding lines; quote values that need it (`*`, `$`, `:`, `#`, leading/trailing
    spaces, empty string → `''`).
- `src/pipelines/designerPanel.ts` — webview panel; talks to the document via messages, applies edits with
  `WorkspaceEdit`, re-reads refs after each change.
- **Template catalog listing** — the client currently reads single files. Needs a recursive listing of the template
  repo (Git Items API with recursion) at a given ref, filtered to YAML files that declare `parameters:`. Cache per
  repo + ref.
- **Entry points**
  - CodeLens "Open in Designer" above each `template:` / `extends:`.
  - Command, e.g. `azureDevOps.yaml.openDesigner`.
  - Button in the existing pipeline preview panel.
  - Setting to turn the CodeLens off.

## Edge cases

- Parameters inside `${{ if }}` / `${{ each }}` (`ParamEntry.conditional`): show read-only, link to the text.
- `parameters:` given as a single expression, or keys with `${{ }}`: designer read-only for that call.
- Template paths built from expressions: not resolvable (already a known limitation).
- `object`, `step`, `stepList`, `job(List)`, `stage(List)` parameters: no generic form; show a raw YAML field or
  "edit in text".
- Block values (`|`, `>`, nested mappings) as passed values: replace the whole block range, or read-only for the MVP.
- Unsaved document changes: always work on the current `TextDocument` text, not on disk.
- External edits while the panel is open: listen to `onDidChangeTextDocument`, refresh the model.
- `extends:` templates behave like `template:` for the form.
- Untrusted workspaces and webview content: keep the existing restrictions and sanitizing.

## Suggested milestones

1. `templateEdits.ts` + tests (update existing values, add/remove params, quoting, indentation).
2. Panel showing the form for the call under the cursor; apply edits; CodeLens + command.
3. Validation via server preview, errors in the panel.
4. Template catalog (listing, `ref` switch, insert new calls incl. `resources` entry).
5. Structure strip from `pipelineModel`.

## Open questions

- Insert position for a new call: always end of the selected job's `steps:` / end of `stages:`, or let the user pick?
- How to list refs for the selector (tags only, or tags + branches)?
- Should "Reset to defaults" remove the lines or write the defaults explicitly?

## About the mock file

`pipeline-designer-mock.dc.html` is the source of the interactive mock. It is written in a component format for the
design canvas it was built in, so it does not run on its own in a browser. As a reference it is still fully readable:

- the markup shows layout and styling (`{{name}}` are bindings, `<sc-for>` loops, `<sc-if>` conditionals);
- the `<script type="text/x-dc">` block holds the sample data (templates, parameters, current pipeline values),
  the YAML preview generation (`buildYaml`) and the interactions (`setVal`, `validate`, `apply`).

All names (organization, project, repos, service connections) are invented sample data.
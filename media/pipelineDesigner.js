// @ts-check
/* Pipeline designer: template catalog, structure strip, parameter form, YAML preview and validation. The extension
   sends the whole state; this page renders it and posts the user's actions. Plain DOM; every text is escaped. */
(function () {
  /* global vscode */
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const post = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));

  const saved = vscode.getState() || {};
  let view = saved.view === 'yaml' ? 'yaml' : 'designer';
  let filter = typeof saved.filter === 'string' ? saved.filter : '';
  /** Form or YAML per object parameter. @type {Record<string, string>} */
  const modes = saved.modes && typeof saved.modes === 'object' ? Object.assign(Object.create(null), saved.modes) : Object.create(null);
  /** @type {any} */
  let state;
  /** Pending posts of text fields, one timer per field. @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** Field to focus after the next render (a row just added to an object form). @type {string | undefined} */
  let focusNext;

  function remember() {
    vscode.setState({ view, filter, modes: Object.assign({}, modes) });
  }

  function debounce(key, ms, fn) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms));
  }

  const badge = (text, cls) => `<span class="pd-badge ${cls || ''}">${esc(text)}</span>`;

  // ---------- catalog ----------
  function refSelect(repo) {
    if (!repo.canPickRef) return '';
    const groups = { tag: 'Tags', branch: 'Branches', other: 'Other' };
    const options = Object.keys(groups).map((kind) => {
      const list = repo.refs.filter((r) => r.kind === kind);
      if (!list.length) return '';
      const items = list.map((r) => `<option value="${esc(r.name)}"${r.name === repo.ref ? ' selected' : ''}>${esc(r.label)}</option>`).join('');
      return `<optgroup label="${groups[kind]}">${items}</optgroup>`;
    }).join('');
    const def = `<option value=""${repo.ref ? '' : ' selected'}>(default branch)</option>`;
    const changed = repo.refChanged ? badge('changed', 'warn') : '';
    const loading = repo.refsLoading ? '<span class="muted small">loading…</span>' : '';
    const error = repo.refsError ? `<div class="pd-err small">${esc(repo.refsError)}</div>` : '';
    return `<label class="pd-label" for="ref">ref ${changed} ${loading}</label><select id="ref" class="pd-select">${def}${options}</select>${error}`;
  }

  function catalogTree(catalog) {
    if (catalog.loading) return '<p class="muted small">Reading templates…</p>';
    if (catalog.error) return `<p class="pd-err small">${esc(catalog.error)}</p>`;
    const q = filter.trim().toLowerCase();
    const items = catalog.items.filter((i) => !q || i.path.toLowerCase().includes(q));
    if (!items.length) return `<p class="muted small">${catalog.items.length ? 'No template matches the filter.' : 'No YAML files with parameters: found.'}</p>`;
    const folders = [...new Set(items.map((i) => i.folder))];
    const more = catalog.truncated ? '<p class="muted small">Only the first 300 YAML files are read.</p>' : '';
    return folders.map((f) => {
      const rows = items.filter((i) => i.folder === f).map((i) => {
        const used = i.used ? badge('in pipeline', 'ok') : '';
        return `<button class="pd-file${i.selected ? ' selected' : ''}" data-pick="${esc(i.path)}" title="${esc(i.path)} · ${i.params} parameters"><span class="pd-file-name">${esc(i.file)}</span>${used}</button>`;
      }).join('');
      return `<div class="pd-folder"><div class="pd-folder-name">${esc(f || '/')}</div>${rows}</div>`;
    }).join('') + more;
  }

  /** The catalog without its file list (the part `tree`) and without the filter text (set after each render). */
  function renderCatalog(s) {
    const repos = s.repos.map((r) => `<option value="${esc(r.alias)}"${r.alias === s.repo.alias ? ' selected' : ''}>${esc(r.label)}</option>`).join('');
    return `<aside class="pd-catalog card" data-sec="catalog">
      <div class="pd-row"><h2>Templates</h2><span class="spacer"></span><button class="link" id="addRepo" title="Declare another repository of the project as a template repository">Add repository…</button></div>
      <label class="pd-label" for="repo">Repository</label><select id="repo" class="pd-select">${repos}</select>
      <div class="muted small pd-source">${esc(s.repo.source)}</div>
      ${refSelect(s.repo)}
      <div class="pd-row pd-filter"><input id="filter" type="text" placeholder="Filter templates"><button class="btn small ghost" id="reloadCatalog" title="Read the template list again">↻</button></div>
      ${slot('tree')}
    </aside>`;
  }

  const treeHtml = (catalog) => `<div class="pd-tree" data-sec="tree">${catalogTree(catalog)}</div>`;

  // ---------- structure strip ----------
  function renderStructure(groups) {
    if (!groups.length) return slot('structure');
    const cards = groups.map((g) => {
      const items = g.items.map((i) => {
        const cls = ['pd-call', i.selected ? 'selected' : '', i.isNew ? 'new' : ''].join(' ');
        const attr = i.index === undefined ? '' : ` data-select="${i.index}"`;
        const tag = i.isNew ? badge('new', 'ok') : '';
        return `<button class="${cls}"${attr} title="${esc(i.title)}">${esc(i.label)}${tag}</button>`;
      }).join('') || '<span class="muted small">no template calls</span>';
      return `<div class="pd-stage"><div class="pd-stage-name">${esc(g.name)}</div>${items}</div>`;
    }).join('<span class="pd-arrow" aria-hidden="true">→</span>');
    return `<div class="pd-structure" data-sec="structure">${cards}</div>`;
  }

  // ---------- parameter form ----------
  function enumControl(p, disabled) {
    if (p.values.length > 6) {
      const options = p.values.map((v) => `<option${v === p.value ? ' selected' : ''}>${esc(v)}</option>`).join('');
      return `<select class="pd-select" id="p-${esc(p.name)}" data-param="${esc(p.name)}"${disabled}>${options}</select>`;
    }
    return '<div class="pd-seg" role="group">' + p.values.map((v) =>
      `<button class="pd-opt${v === p.value ? ' on' : ''}" data-param="${esc(p.name)}" data-val="${esc(v)}" aria-pressed="${v === p.value}"${disabled}>${esc(v)}</button>`).join('') + '</div>';
  }

  function control(p) {
    const disabled = p.readOnly ? ' disabled' : '';
    if (p.control === 'enum') return enumControl(p, disabled);
    if (p.control === 'boolean') {
      const on = String(p.value).toLowerCase() === 'true';
      return `<button class="pd-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" data-param="${esc(p.name)}" data-val="${on ? 'false' : 'true'}"${disabled}><span></span></button><span class="mono small">${on}</span>`;
    }
    if (p.control === 'raw') return structuredControl(p, disabled);
    const kind = p.control === 'number' ? ' inputmode="decimal"' : '';
    const placeholder = p.default === undefined ? 'value' : p.default;
    return `<input type="text" class="mono${p.error ? ' invalid' : ''}" id="p-${esc(p.name)}" data-param="${esc(p.name)}" data-text="1" value="${esc(p.value)}" placeholder="${esc(placeholder)}"${kind}${disabled}>`;
  }

  // ---------- object and list parameters ----------
  const KINDS = [['text', 'text'], ['bool', 'yes/no'], ['map', 'mapping'], ['list', 'list']];
  const tid = (name, path, part) => ['t', name].concat(path, [part]).join('-');
  const treeAttrs = (p, path) => `data-tree="${esc(p.name)}" data-path="${path.join('.')}"`;

  /** Objects: form (tree) or YAML text; steps, jobs and stages: YAML text only. */
  function paramMode(p) {
    if (p.type !== 'object' || !p.tree) return 'yaml';
    return modes[p.name] === 'yaml' ? 'yaml' : 'form';
  }

  function structuredControl(p, disabled) {
    const mode = paramMode(p);
    const toggle = p.type === 'object' ? modeToggle(p, mode) : '';
    const body = mode === 'form' ? treeForm(p, disabled) : yamlArea(p);
    return `<div class="pd-struct">${toggle}${body}</div>`;
  }

  function modeToggle(p, mode) {
    const formTitle = p.tree ? 'Edit as a form' : 'The form needs YAML it can read: fix the text first.';
    const name = esc(p.name);
    const form = `<button data-mode="form" data-param="${name}" aria-pressed="${mode === 'form'}" title="${esc(formTitle)}"${p.tree ? '' : ' disabled'}>Form</button>`;
    const yaml = `<button data-mode="yaml" data-param="${name}" aria-pressed="${mode === 'yaml'}" title="Edit as YAML text (keeps comments)">YAML</button>`;
    return `<div class="seg pd-mode" role="group" aria-label="Edit ${name} as">${form}${yaml}</div>`;
  }

  function yamlArea(p) {
    const lines = String(p.value).split('\n').length;
    const rows = Math.min(Math.max(lines + 1, 3), 24);
    const cls = p.error ? 'mono pd-yaml invalid' : 'mono pd-yaml';
    const placeholder = p.type.endsWith('List') ? '- script: echo hello' : 'key: value';
    const ro = p.readOnly ? ' readonly' : '';
    return `<textarea class="${cls}" id="p-${esc(p.name)}" data-param="${esc(p.name)}" data-yaml="1" rows="${rows}" spellcheck="false" placeholder="${placeholder}"${ro}>${esc(p.value)}</textarea>`;
  }

  function treeForm(p, disabled) {
    return `<div class="pd-tn-root">${treeBody(p, p.tree, [], disabled)}</div>`;
  }

  function treeBody(p, node, path, disabled) {
    if (node.kind === 'map') return mapBody(p, node, path, disabled);
    if (node.kind === 'list') return listBody(p, node, path, disabled);
    return `<div class="pd-tn">${treeItem(p, node, path, '', disabled)}</div>`;
  }

  function mapBody(p, node, path, disabled) {
    const rows = node.entries.map((e, i) => {
      const at = path.concat(i);
      const expr = e.key.startsWith('${{') ? ' expr' : '';
      const key = `<input type="text" class="mono pd-tn-key${expr}" id="${esc(tid(p.name, at, 'k'))}" ${treeAttrs(p, at)} data-part="key" value="${esc(e.key)}" placeholder="key" aria-label="Key"${disabled}>`;
      return treeItem(p, e.value, at, key, disabled);
    }).join('');
    const empty = rows ? '' : '<span class="muted small">no keys</span>';
    return `<div class="pd-tn">${rows}${empty}${addButton(p, path, 'key', disabled)}</div>`;
  }

  function listBody(p, node, path, disabled) {
    const rows = node.items.map((item, i) => treeItem(p, item, path.concat(i), '<span class="pd-tn-dash" aria-hidden="true">-</span>', disabled)).join('');
    const empty = rows ? '' : '<span class="muted small">no items</span>';
    return `<div class="pd-tn">${rows}${empty}${addButton(p, path, 'item', disabled)}</div>`;
  }

  function addButton(p, path, what, disabled) {
    return `<button class="link pd-tn-add" data-tree-add="${what}" ${treeAttrs(p, path)}${disabled}>+ ${what}</button>`;
  }

  /** One row: key or dash, the value (input, switch or summary), kind and remove; collections nest below. */
  function treeItem(p, node, path, lead, disabled) {
    const remove = path.length ? `<button class="pd-tn-del" data-tree-del="1" ${treeAttrs(p, path)} title="Remove" aria-label="Remove"${disabled}>×</button>` : '';
    const child = node.kind === 'map' || node.kind === 'list' ? `<div class="pd-tn-child">${treeBody(p, node, path, disabled)}</div>` : '';
    return `<div class="pd-tn-item"><div class="pd-tn-row">${lead}${valueInline(p, node, path, disabled)}${kindSelect(p, node, path, disabled)}${remove}</div>${child}</div>`;
  }

  function valueInline(p, node, path, disabled) {
    if (node.kind === 'text') {
      return `<input type="text" class="mono pd-tn-val" id="${esc(tid(p.name, path, 'v'))}" ${treeAttrs(p, path)} data-part="text" value="${esc(node.text)}" aria-label="Value"${disabled}>`;
    }
    if (node.kind === 'bool') {
      return `<button class="pd-switch${node.value ? ' on' : ''}" role="switch" aria-checked="${node.value}" data-tree-bool="1" ${treeAttrs(p, path)}${disabled}><span></span></button><span class="mono small pd-tn-val">${node.value}</span>`;
    }
    const count = node.kind === 'map' ? node.entries.length : node.items.length;
    const unit = node.kind === 'map' ? 'key' : 'item';
    return `<span class="pd-tn-sum pd-tn-val">${count} ${unit}${count === 1 ? '' : 's'}</span>`;
  }

  function kindSelect(p, node, path, disabled) {
    const options = KINDS.map(([k, label]) => `<option value="${k}"${k === node.kind ? ' selected' : ''}>${label}</option>`).join('');
    return `<select class="pd-select pd-tn-kind" id="${esc(tid(p.name, path, 't'))}" data-tree-kind="1" ${treeAttrs(p, path)} aria-label="Kind"${disabled}>${options}</select>`;
  }

  function paramRow(p, key) {
    const badges = [badge(p.control === 'enum' ? p.type + ' · values' : p.type), p.required ? badge('required', 'bad') : '',
      p.unsaved ? badge('unsaved', 'info') : ''].join('');
    const def = p.default === undefined ? 'no default' : 'default: ' + p.default;
    const help = (p.label === p.name ? '' : esc(p.label) + ' · ') + esc(def.length > 80 ? def.slice(0, 77) + '…' : def);
    const open = p.line === undefined ? '' : `<button class="link" data-open="${p.line}">line ${p.line + 1}</button>`;
    const error = p.error ? `<div class="pd-err small">${esc(p.error)}</div>` : '';
    const ro = p.readOnly ? `<div class="muted small">${esc(p.readOnly)}</div>` : '';
    return `<div class="pd-param${p.readOnly ? ' ro' : ''}" data-sec="${key}">
      <div class="pd-param-head"><span class="mono pd-param-name">${esc(p.name)}</span>${badges}<span class="spacer"></span>${open}</div>
      <div class="pd-param-control">${control(p)}</div>${error}${ro}
      <div class="muted small">${help}</div></div>`;
  }

  function targetPicker(call) {
    if (!call.isNew || call.points.length < 2) return '';
    const options = call.points.map((label, i) => `<option value="${i}"${i === call.point ? ' selected' : ''}>${esc(label)}</option>`).join('');
    return `<label class="pd-label" for="target">Insert into</label><select id="target" class="pd-select">${options}</select>`;
  }

  /** The form as parts: the frame, its head, one part per parameter and the actions, so typing changes only one row. */
  function formParts(s) {
    const call = s.call;
    if (!call) {
      const text = s.empty ? 'This pipeline has no template calls yet. Pick a template on the left to insert one.' : 'Select a template call above or pick a template on the left.';
      return [['form', `<section class="pd-form card" data-sec="form"><p class="muted">${text}</p></section>`]];
    }
    const names = call.unknown.map((n) => esc(n)).join(', ');
    const unknown = call.unknown.length ? `<div class="pd-warn small">Passed but not declared by the template: ${names}</div>` : '';
    const problem = call.error || call.readOnly;
    const noteClass = call.error ? 'pd-err' : 'pd-warn';
    const note = problem ? `<div class="${noteClass} small">${esc(problem)}</div>` : '';
    const open = call.line === undefined ? '' : `<button class="link" data-open="${call.line}">Edit in text</button>`;
    const keys = call.params.map((_, i) => 'param:' + i);
    const params = keys.map(slot).join('') || (problem ? '' : '<p class="muted small">This template declares no parameters.</p>');
    const disabled = call.blocking ? ' disabled' : '';
    return [
      ['form', `<section class="pd-form card" data-sec="form">${slot('form-top')}<div class="pd-params">${params}</div>${slot('form-actions')}</section>`],
      ['form-top', `<div data-sec="form-top">
      <div class="pd-row"><h2 class="pd-call-title" title="${esc(call.title)}">${esc(call.title)}</h2>${call.kind ? badge(call.kind + ' template') : ''}<span class="spacer"></span>${open}</div>
      <div class="muted small">${esc(call.status)}</div>
      ${targetPicker(call)}${note}${unknown}</div>`],
      ...call.params.map((p, i) => [keys[i], paramRow(p, keys[i])]),
      ['form-actions', `<div class="pd-actions" data-sec="form-actions">
        <button class="btn primary" id="apply"${disabled} title="${esc(call.blocking || '')}">${esc(call.applyLabel)}</button>
        <button class="btn" id="validate">Validate</button>
        <button class="btn ghost" id="reset">Reset to defaults</button>
        <span class="spacer"></span>
        <label class="pd-check"><input type="checkbox" id="writeDefaults"${s.writeDefaults ? ' checked' : ''}> Write defaults</label>
      </div>`],
    ];
  }

  // ---------- preview, validation, notices ----------
  /** One element per line, so the code view can replace just the lines that changed (see patchCode). */
  function codeLine(l) {
    if (l.no === undefined) return `<div class="pd-line gap"><span class="no"></span><span class="mk"></span><span class="tx">${esc(l.text)}</span></div>`;
    let mark = '';
    if (l.mark) mark = l.mark === '+' ? ' mark-add' : ' mark-chg';
    return `<div class="pd-line${mark}"><span class="no">${l.no}</span><span class="mk">${esc(l.mark || '')}</span><span class="tx">${esc(l.text) || ' '}</span></div>`;
  }

  function changeSummary(p) {
    const parts = [];
    if (p.added) parts.push(`<span class="pd-add">+${p.added} inserted</span>`);
    if (p.changed) parts.push(`<span class="pd-chg">~${p.changed} changed</span>`);
    if (p.removed) parts.push(`<span class="pd-del">−${p.removed} removed</span>`);
    return parts.join(' · ') || '<span class="muted">No pending changes</span>';
  }

  /** The preview frame; the change summary is the part `summary`, the lines are patched into `[data-code]`. */
  function renderPreview(s) {
    return `<section class="pd-preview card" data-sec="preview">
      <div class="pd-row"><h2>${esc(s.title)}</h2><span class="spacer"></span>${slot('summary')}</div>
      <div class="pd-code mono" data-code="1"></div>
    </section>`;
  }

  function renderValidation(v) {
    const problems = v.problems.map((p) => {
      const open = p.line === undefined ? '' : ` <button class="link" data-open="${p.line}">open</button>`;
      return `<li>${esc(p.label)}${open}</li>`;
    }).join('');
    const detail = v.detail ? '<div class="small muted">' + esc(v.detail) + '</div>' : '';
    const list = problems ? '<ul class="small">' + problems + '</ul>' : '';
    return `<div class="pd-val level-${esc(v.level)} state-${esc(v.state)}"><span class="pd-dot"></span><div><div class="pd-val-title">${esc(v.title)}</div>${detail}${list}</div></div>`;
  }

  function renderNotices(s) {
    return [renderValidation(s.validation), ...s.notices.map((n) => renderValidation({ ...n, state: 'notice', problems: [] }))].join('');
  }

  // ---------- render: only the parts that changed ----------
  /*
   * The page is a fixed frame per view with parts (`data-sec`) in it. Every state renders each part to HTML, and only a
   * part whose HTML changed is replaced, so typing in one field leaves the catalog, the other rows and the scroll
   * positions alone. A part's HTML holds empty slots for the parts nested in it; they are filled right after it.
   */
  /** HTML each part shows. @type {Map<string, string>} */
  const shown = new Map();
  /** HTML of each line in a code view. @type {WeakMap<Element, string[]>} */
  const codeShown = new WeakMap();
  /** The view the frame was built for. */
  let layout = '';
  function slot(key) {
    return `<template data-sec="${key}"></template>`;
  }
  const FRAMES = {
    designer: `${slot('head')}<div class="pd-body">${slot('catalog')}<main class="pd-main">${slot('structure')}${slot('form')}</main>${slot('preview')}</div>${slot('notices')}`,
    yaml: `${slot('head')}<div class="pd-body yaml">${slot('preview')}</div>${slot('notices')}`,
  };

  function headHtml(s) {
    const toggle = ['designer', 'yaml'].map((v) => `<button aria-pressed="${view === v}" data-view="${v}">${v === 'yaml' ? 'YAML only' : 'Designer'}</button>`).join('');
    return `<header class="pd-head" data-sec="head"><div><h1>${esc(s.title)}</h1><div class="muted small">Pipeline designer</div></div><span class="spacer"></span><div class="seg" role="group" aria-label="View">${toggle}</div></header>`;
  }

  /** Every part of the current view as [key, HTML], parents before the parts in their slots. */
  function parts(s) {
    const list = [['head', headHtml(s)]];
    if (view !== 'yaml') {
      list.push(['catalog', renderCatalog(s)], ['tree', treeHtml(s.catalog)], ['structure', renderStructure(s.structure)], ...formParts(s));
    }
    list.push(['preview', renderPreview(s)], ['summary', `<span class="small" data-sec="summary">${changeSummary(s.preview)}</span>`],
      ['notices', `<footer class="pd-notices" data-sec="notices">${renderNotices(s)}</footer>`]);
    return list;
  }

  const sameShell = (a, b) => a.tagName === b.tagName && a.attributes.length === b.attributes.length
    && [...b.attributes].every((x) => a.getAttribute(x.name) === x.value);

  /** Replaces the part `key` when its HTML changed; an element with the same tag and attributes keeps itself (and its scroll position). */
  function patch(key, html) {
    if (shown.get(key) === html) return;
    const old = app.querySelector(`[data-sec="${key}"]`);
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const next = tpl.content.firstElementChild;
    if (!old || !next) return;
    shown.set(key, html);
    if (onlyTypedTextDiffers(old, next)) return;
    next.querySelectorAll('[data-sec]').forEach((el) => shown.delete(/** @type {HTMLElement} */ (el).dataset.sec || ''));
    if (sameShell(old, next)) old.replaceChildren(...next.childNodes);
    else old.replaceWith(next);
  }

  /**
   * True when the part differs only in the value of the field being typed in. The typed text wins over the state's value
   * anyway (see restoreFocus), so the field stays as it is and keeps its caret, undo history and IME composition.
   */
  function onlyTypedTextDiffers(old, next) {
    const active = /** @type {HTMLInputElement} */ (document.activeElement);
    if (!active?.id || !isTextField(active) || active.readOnly || !old.contains(active)) return false;
    const twin = next.querySelector('#' + CSS.escape(active.id));
    if (!twin) return false;
    if (twin.tagName === 'TEXTAREA') twin.textContent = active.defaultValue;
    else if (active.hasAttribute('value')) twin.setAttribute('value', active.getAttribute('value') || '');
    else twin.removeAttribute('value');
    return next.outerHTML === old.outerHTML;
  }

  /** Replaces only the lines between the unchanged start and end of a code view. */
  function patchCode(lines) {
    const box = app.querySelector('[data-code]');
    if (!box) return;
    const next = lines.map(codeLine);
    const prev = codeShown.get(box);
    codeShown.set(box, next);
    if (!prev) {
      box.innerHTML = next.join('');
      return;
    }
    let start = 0;
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
    let endPrev = prev.length;
    let endNext = next.length;
    while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
      endPrev--;
      endNext--;
    }
    for (let i = endPrev - 1; i >= start; i--) box.children[i].remove();
    if (endNext > start) {
      const tpl = document.createElement('template');
      tpl.innerHTML = next.slice(start, endNext).join('');
      box.insertBefore(tpl.content, box.children[start] || null);
    }
  }

  function render() {
    if (!state) return;
    const s = state;
    const focus = captureFocus();
    if (layout !== view) {
      layout = view;
      shown.clear();
      app.innerHTML = FRAMES[view];
    }
    for (const [key, html] of parts(s)) patch(key, html);
    patchCode(view === 'yaml' ? s.preview.full : s.preview.lines);
    const filterInput = /** @type {HTMLInputElement | null} */ (document.getElementById('filter'));
    if (filterInput && filterInput.value !== filter) filterInput.value = filter;
    const next = focusNext ? document.getElementById(focusNext) : null;
    focusNext = undefined;
    if (next) next.focus();
    else restoreFocus(focus);
  }

  const isTextField = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text');

  /**
   * Keeps the caret and the typed text in a field across re-renders: the state comes back after every keystroke and may
   * be older than what was typed since.
   */
  function captureFocus() {
    const el = /** @type {HTMLInputElement | null} */ (document.activeElement);
    if (!el || !el.id) return undefined;
    return { id: el.id, start: el.selectionStart, end: el.selectionEnd, value: isTextField(el) ? el.value : undefined };
  }

  function restoreFocus(f) {
    const el = f && /** @type {HTMLInputElement | null} */ (document.getElementById(f.id));
    if (!el) return;
    if (el === document.activeElement) {
      // Kept by the render: the new state's tree may not have the text typed since the last send yet.
      if (el.dataset.tree && el.dataset.part && isTextField(el) && !el.readOnly) applyTreeInput(el);
      return;
    }
    if (f.value !== undefined && isTextField(el) && !el.readOnly && el.value !== f.value) {
      el.value = f.value;
      // The new state's tree may not have the text typed since the last send yet.
      if (el.dataset.tree && el.dataset.part) applyTreeInput(el);
    }
    el.focus();
    if (typeof f.start === 'number' && typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(f.start, f.end); } catch { /* not a text field */ }
    }
  }

  // ---------- events ----------
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'state') {
      state = m;
      render();
    } else if (m.type === 'validation' && state) {
      state.validation = m.validation;
      render();
    }
  });

  // ---------- object form edits (the tree in `state` is changed in place, then sent) ----------
  const parsePath = (s) => (s ? s.split('.').map(Number) : []);

  function nodeAt(tree, path) {
    let node = tree;
    for (const i of path) {
      if (!node) return undefined;
      node = node.kind === 'map' ? node.entries[i]?.value : node.items?.[i];
    }
    return node;
  }

  /** The parameter and path an element of the object form belongs to. */
  function treeTarget(el) {
    const p = state?.call?.params.find((x) => x.name === el.dataset.tree);
    const path = parsePath(el.dataset.path);
    const node = p?.tree ? nodeAt(p.tree, path) : undefined;
    return node ? { p, path, node } : undefined;
  }

  function sendTree(p) {
    clearTimeout(timers.get('tree:' + p.name));
    timers.delete('tree:' + p.name);
    post('value', { name: p.name, tree: p.tree });
  }

  /** Structural change: show it at once, send it at once. */
  function commitTree(p) {
    sendTree(p);
    render();
  }

  function replaceNode(p, path, node) {
    if (!path.length) {
      p.tree = node;
      return;
    }
    const parent = nodeAt(p.tree, path.slice(0, -1));
    const i = path.at(-1);
    if (parent.kind === 'map') parent.entries[i].value = node;
    else parent.items[i] = node;
  }

  function convert(node, kind) {
    if (node.kind === kind) return node;
    if (kind === 'bool') return { kind: 'bool', value: node.kind === 'text' && node.text.trim().toLowerCase() === 'true' };
    if (kind === 'text') return { kind: 'text', text: node.kind === 'bool' ? String(node.value) : '' };
    return kind === 'map' ? { kind: 'map', entries: [] } : { kind: 'list', items: [] };
  }

  function addRow(el) {
    const t = treeTarget(el);
    if (!t) return;
    if (t.node.kind === 'map') {
      t.node.entries.push({ key: '', value: { kind: 'text', text: '' } });
      focusNext = tid(t.p.name, t.path.concat(t.node.entries.length - 1), 'k');
    } else if (t.node.kind === 'list') {
      t.node.items.push({ kind: 'text', text: '' });
      focusNext = tid(t.p.name, t.path.concat(t.node.items.length - 1), 'v');
    }
    commitTree(t.p);
  }

  function removeRow(el) {
    const t = treeTarget(el);
    const parent = t && nodeAt(t.p.tree, t.path.slice(0, -1));
    if (!parent) return;
    const list = parent.kind === 'map' ? parent.entries : parent.items;
    list.splice(t.path.at(-1), 1);
    commitTree(t.p);
  }

  function toggleBool(el) {
    const t = treeTarget(el);
    if (t?.node.kind !== 'bool') return;
    t.node.value = !t.node.value;
    commitTree(t.p);
  }

  function changeKind(el) {
    const t = treeTarget(el);
    if (!t) return;
    replaceNode(t.p, t.path, convert(t.node, el.value));
    commitTree(t.p);
  }

  /** Writes a key or value field into the tree in `state`. */
  function applyTreeInput(el) {
    const t = treeTarget(el);
    if (!t) return undefined;
    if (el.dataset.part === 'key') {
      const parent = nodeAt(t.p.tree, t.path.slice(0, -1));
      parent.entries[t.path.at(-1)].key = el.value;
    } else if (t.node.kind === 'text') {
      t.node.text = el.value;
    }
    return t;
  }

  /** Typing in a key or value field: change the tree now, send after a pause. */
  function typeInTree(el) {
    const t = applyTreeInput(el);
    if (t) debounce('tree:' + t.p.name, 250, () => sendTree(t.p));
  }

  function setMode(el) {
    const name = el.dataset.param;
    if (!name) return;
    modes[name] = el.dataset.mode === 'yaml' ? 'yaml' : 'form';
    remember();
    render();
  }

  /** @type {Record<string, (el: HTMLElement) => void>} */
  const clicks = {
    'data-view': (el) => { view = el.dataset.view === 'yaml' ? 'yaml' : 'designer'; remember(); render(); },
    'data-mode': setMode,
    'data-tree-add': addRow,
    'data-tree-del': removeRow,
    'data-tree-bool': toggleBool,
    'data-pick': (el) => post('pick', { path: el.dataset.pick }),
    'data-select': (el) => post('select', { index: Number(el.dataset.select) }),
    'data-open': (el) => post('open', { line: Number(el.dataset.open) }),
    'data-val': (el) => post('value', { name: el.dataset.param, value: el.dataset.val }),
  };
  const buttons = { apply: 'apply', validate: 'validate', reset: 'reset', addRepo: 'addRepo', reloadCatalog: 'reloadCatalog' };

  document.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    for (const attr of Object.keys(clicks)) {
      const el = /** @type {HTMLElement | null} */ (t.closest(`[${attr}]`));
      if (el && !(/** @type {HTMLButtonElement} */ (el).disabled)) {
        clicks[attr](el);
        return;
      }
    }
    const button = /** @type {HTMLButtonElement | null} */ (t.closest('button[id]'));
    if (button && !button.disabled && Object.hasOwn(buttons, button.id)) {
      post(buttons[button.id]);
    }
  });

  document.addEventListener('input', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id === 'filter') {
      filter = t.value;
      // One list update after a short pause in typing, not one per key.
      debounce('filter', 100, () => {
        remember();
        if (state && view !== 'yaml') patch('tree', treeHtml(state.catalog));
      });
    } else if (t.dataset.tree && t.dataset.part) {
      typeInTree(t);
    } else if (t.dataset.text) {
      debounce('text:' + t.dataset.param, 250, () => post('value', { name: t.dataset.param, value: t.value }));
    } else if (t.dataset.yaml) {
      debounce('yaml:' + t.dataset.param, 400, () => post('value', { name: t.dataset.param, value: t.value }));
    }
  });

  document.addEventListener('change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id === 'repo') post('repo', { alias: t.value });
    else if (t.id === 'ref') post('ref', { ref: t.value });
    else if (t.id === 'target') post('target', { index: Number(t.value) });
    else if (t.id === 'writeDefaults') post('writeDefaults', { on: t.checked });
    else if (t.dataset.treeKind) changeKind(t);
    else if (t.dataset.param && t.tagName === 'SELECT') post('value', { name: t.dataset.param, value: t.value });
  });

  post('ready');
})();

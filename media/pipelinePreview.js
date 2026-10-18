// @ts-check
/* Pipeline preview: what the templates of a pipeline produce (stages, jobs, steps), from the local expander or
   from Azure DevOps. Plain DOM; every text from the YAML is escaped. */
(function () {
  /* global vscode */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  const HINT = {
    local: 'Expanded here: templates come from local files and clones in the workspace, unsaved changes included. Runtime expressions ($[ ], $( )) and conditions are shown as written.',
    server: 'Expanded by Azure DevOps with the content of this file; other files are read from the server at the checked-out branch. Updates when you save.',
  };

  const saved = vscode.getState() || {};
  let selected = saved.selected;
  /** @type {any} */
  let state = { mode: 'local', model: undefined };

  function remember() {
    vscode.setState({ selected });
  }

  function sourceLink(i) {
    const s = state.model && typeof i === 'number' ? state.model.sources[i] : undefined;
    return s ? `<button class="pv-src" data-src="${i}" title="Open ${esc(s.label)} at line ${s.line}">${esc(s.label.split(' · ')[0])}:${s.line}</button>` : '';
  }

  const chip = (label, value) => (value ? `<span class="pv-chip"><span class="muted">${esc(label)}</span> ${esc(value)}</span>` : '');

  // ---------- header, parameters, messages ----------
  function renderHead(m) {
    $('title').textContent = m.title || 'Pipeline';
    $('info').textContent = m.info || '';
    $('hint').textContent = HINT[m.mode] || '';
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.mode === m.mode));
  }

  function paramControl(p) {
    const id = 'p-' + p.name;
    if (p.type === 'boolean' && !(p.values && p.values.length)) {
      const on = String(p.value).toLowerCase() === 'true';
      return `<input type="checkbox" id="${esc(id)}" data-param="${esc(p.name)}"${on ? ' checked' : ''}>`;
    }
    if (p.values && p.values.length) {
      const options = p.values.map((v) => '<option' + (v === p.value ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
      return `<select id="${esc(id)}" data-param="${esc(p.name)}">${options}</select>`;
    }
    if (p.type === 'object' || /^(step|job|stage)(List)?$/.test(p.type)) {
      return `<textarea id="${esc(id)}" data-param="${esc(p.name)}" rows="3" spellcheck="false">${esc(p.value)}</textarea>`;
    }
    return `<input type="${p.type === 'number' ? 'number' : 'text'}" id="${esc(id)}" data-param="${esc(p.name)}" value="${esc(p.value)}">`;
  }

  function paramRow(p) {
    const required = p.default === undefined ? ' · required' : '';
    return `<label for="p-${esc(p.name)}">${esc(p.displayName || p.name)}<span class="muted small">${esc(p.type)}${required}</span></label>${paramControl(p)}`;
  }

  function renderParams(params) {
    const el = $('params');
    if (!params || !params.length) {
      el.innerHTML = '';
      return;
    }
    const reset = params.some((p) => p.changed) ? '<button class="link" id="resetParams">Reset</button>' : '';
    const rows = params.map(paramRow).join('');
    el.innerHTML = `<details class="card pv-params" open><summary>Runtime parameters <span class="count">${params.length}</span>${reset}</summary>
      <div class="pv-grid">${rows}</div></details>`;
  }

  function renderMessages(m) {
    const parts = [];
    if (m.error) parts.push(`<div class="pv-error">${esc(m.error)}</div>`);
    if (m.mode === 'server' && !m.error) parts.push('<div class="pv-note small"><button class="link" id="pickPipeline">Expand as another pipeline…</button></div>');
    if (m.warnings && m.warnings.length) {
      const open = m.warnings.length <= 3 ? ' open' : '';
      const items = m.warnings.map((w) => '<li>' + esc(w) + '</li>').join('');
      parts.push(`<details class="pv-warn"${open}><summary>${plural(m.warnings.length, 'warning')}</summary><ul>${items}</ul></details>`);
    }
    $('messages').innerHTML = parts.join('');
  }

  // ---------- stage graph ----------
  function stageCard(s) {
    const jobs = s.jobs.length ? plural(s.jobs.length, 'job') : 'no jobs';
    const conditional = s.condition ? ' · conditional' : '';
    const sub = s.error ? '<div class="stage-err">' + esc(s.error) + '</div>' : '<div class="stage-sub">' + jobs + conditional + '</div>';
    const kind = s.error ? 'fail' : 'queued';
    return `<div class="stage pv-stage st-card-${kind}${s.id === selected ? ' selected' : ''}" data-stage="${esc(s.id)}" role="button" tabindex="0" title="${esc(s.condition ? 'condition: ' + s.condition : s.name)}">
      <div class="stage-top"><span class="stage-name">${esc(s.name)}</span></div>${sub}</div>`;
  }

  function renderGraph() {
    const stages = state.model ? state.model.stages : [];
    const wrap = $('graphWrap');
    wrap.hidden = !stages.length;
    if (wrap.hidden) return;
    const count = Math.max(0, ...stages.map((s) => s.column)) + 1;
    const cols = Array.from({ length: count }, (_, i) => stages.filter((s) => s.column === i));
    $('graph').innerHTML = '<svg class="edges" aria-hidden="true"></svg>' + cols.map((c) => '<div class="col">' + c.map(stageCard).join('') + '</div>').join('');
    requestAnimationFrame(() => drawEdges(stages));
  }

  /** Bezier from the right edge of one card to the left edge of the next. */
  function curve(from, to, box) {
    const start = { x: from.right - box.left, y: from.top + from.height / 2 - box.top };
    const end = { x: to.left - box.left, y: to.top + to.height / 2 - box.top };
    const bend = Math.max(16, (end.x - start.x) / 2);
    return '<path class="edge" d="M' + start.x + ' ' + start.y + ' C' + (start.x + bend) + ' ' + start.y + ', ' + (end.x - bend) + ' ' + end.y + ', ' + end.x + ' ' + end.y + '"/>';
  }

  function drawEdges(stages) {
    const graph = $('graph');
    const svg = graph.querySelector('svg.edges');
    if (!svg) return;
    const box = graph.getBoundingClientRect();
    /** @type {Map<string, DOMRect>} */
    const rects = new Map();
    graph.querySelectorAll('[data-stage]').forEach((el) => rects.set(/** @type {HTMLElement} */ (el).dataset.stage || '', el.getBoundingClientRect()));
    Object.entries({ width: graph.scrollWidth, height: graph.scrollHeight }).forEach(([k, v]) => svg.setAttribute(k, String(v)));
    const pairs = stages.flatMap((s) => s.dependsOn.map((d) => [rects.get(d), rects.get(s.id)]));
    svg.innerHTML = pairs.filter(([a, b]) => a && b).map(([a, b]) => curve(a, b, box)).join('');
  }

  // ---------- jobs and steps ----------
  function stepHtml(st) {
    const hook = st.hook ? `<span class="pill muted">${esc(st.hook)}</span>` : '';
    const cond = st.condition ? `<span class="pill info" title="${esc(st.condition)}">if</span>` : '';
    const detail = st.detail ? `<span class="muted mono small pv-detail">${esc(st.detail)}</span>` : '';
    const error = st.error ? `<div class="step-errors">${esc(st.error)}</div>` : '';
    return `<li class="step"><div class="step-row"><span class="pv-kind">${esc(st.kind)}</span>${hook}<span class="step-name">${esc(st.name)}</span>${detail}${cond}
      <span class="spacer"></span>${sourceLink(st.source)}</div>${error}</li>`;
  }

  const metaRow = (meta) => (meta ? '<div class="pv-meta">' + meta + '</div>' : '');

  function jobHtml(j) {
    const meta = [chip('pool', j.pool), chip('environment', j.environment), chip('strategy', j.strategy),
      chip('depends on', j.dependsOn.join(', ')), chip('condition', j.condition)].join('');
    const error = j.error ? `<div class="step-errors">${esc(j.error)}</div>` : '';
    const steps = j.steps.length ? `<ol class="steps">${j.steps.map(stepHtml).join('')}</ol>` : '';
    return `<div class="job open"><div class="job-head pv-job-head"><span class="pill${j.kind === 'deployment' ? ' info' : ''}">${esc(j.kind)}</span>
        <span class="job-name">${esc(j.name)}</span><span class="muted small">${plural(j.steps.length, 'step')}</span>
        <span class="spacer"></span>${sourceLink(j.source)}</div>
      ${metaRow(meta)}${error}${steps}</div>`;
  }

  function renderJobs() {
    const stages = state.model ? state.model.stages : [];
    const stage = stages.find((s) => s.id === selected) || stages[0];
    if (!stage) {
      $('jobs').innerHTML = state.model ? '<p class="muted">The expanded pipeline has no stages, jobs or steps.</p>' : '';
      return;
    }
    const meta = [chip('pool', stage.pool), chip('depends on', stage.dependsOn.join(', ') || 'none'), chip('condition', stage.condition)].join('');
    const c = state.model.counts;
    $('jobs').innerHTML = `<div class="pv-stage-head"><h2>${esc(stage.name)}</h2><span class="spacer"></span>${sourceLink(stage.source)}</div>
      <div class="pv-meta">${meta}</div>
      ${stage.error ? `<div class="step-errors">${esc(stage.error)}</div>` : ''}
      ${stage.jobs.map(jobHtml).join('') || '<p class="muted">No jobs.</p>'}
      <p class="muted small">${plural(c.stages, 'stage')} · ${plural(c.jobs, 'job')} · ${plural(c.steps, 'step')} in total</p>`;
  }

  function render(m) {
    renderHead(m);
    renderParams(m.params);
    renderMessages(m);
    renderGraph();
    renderJobs();
  }

  // ---------- events ----------
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'busy') {
      document.body.classList.add('pv-busy');
      renderHead(m);
    } else if (m.type === 'model' || m.type === 'error') {
      document.body.classList.remove('pv-busy');
      state = { mode: m.mode, model: m.type === 'model' ? m.model : undefined };
      render({ ...m, error: m.type === 'error' ? m.message : undefined });
    }
  });

  document.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const mode = t.closest('[data-mode]');
    const src = t.closest('[data-src]');
    const stage = t.closest('[data-stage]');
    if (mode) {
      vscode.postMessage({ type: 'mode', mode: /** @type {HTMLElement} */ (mode).dataset.mode });
    } else if (src) {
      vscode.postMessage({ type: 'open', source: Number(/** @type {HTMLElement} */ (src).dataset.src) });
    } else if (stage) {
      selected = /** @type {HTMLElement} */ (stage).dataset.stage;
      remember();
      renderGraph();
      renderJobs();
    } else if (t.id === 'refresh') {
      vscode.postMessage({ type: 'refresh' });
    } else if (t.id === 'resetParams') {
      e.preventDefault();
      vscode.postMessage({ type: 'resetParams' });
    } else if (t.id === 'pickPipeline') {
      vscode.postMessage({ type: 'pipeline' });
    }
  });

  document.addEventListener('keydown', (e) => {
    const stage = /** @type {HTMLElement} */ (e.target).closest('[data-stage]');
    if (stage && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      /** @type {HTMLElement} */ (stage).click();
    }
  });

  document.addEventListener('change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.dataset && t.dataset.param) {
      vscode.postMessage({ type: 'param', name: t.dataset.param, value: t.type === 'checkbox' ? String(t.checked) : t.value });
    }
  });

  window.addEventListener('resize', () => state.model && drawEdges(state.model.stages));
  vscode.postMessage({ type: 'ready' });
})();

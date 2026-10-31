// @ts-check
/* Run overview: stage graph, jobs and steps, inline log viewer, tests and artifacts. Plain DOM, no framework.
   Each part re-renders on its own so polling keeps scroll positions, open jobs and the open log. */
(function () {
  /* global vscode */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const ICONS = {
    ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    fail: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    skip: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    spin: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    commit: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    rerun: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    flask: '<path d="M10 2v7.31"/><path d="M14 9.3V1.99"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.52 16h12.96"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    down: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  };
  const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

  // ---------- status helpers ----------
  function kindOf(result) {
    switch (result) {
      case 'succeeded': return 'ok';
      case 'failed': return 'fail';
      case 'succeededWithIssues': case 'partiallySucceeded': return 'warn';
      case 'canceled': case 'abandoned': return 'canceled';
      case 'skipped': return 'skipped';
      default: return 'queued';
    }
  }
  function kind(state, result, waiting) {
    if (waiting) return 'waiting';
    if (state === 'inProgress' || state === 'cancelling') return 'running';
    if (state === 'pending' || state === 'notStarted' || state === 'postponed' || !state) return result ? kindOf(result) : 'queued';
    return kindOf(result);
  }
  const KIND_ICON = { ok: 'ok', fail: 'fail', warn: 'warn', canceled: 'ban', skipped: 'skip', queued: 'clock', running: 'spin', waiting: 'hand' };
  const KIND_LABEL = { ok: 'Succeeded', fail: 'Failed', warn: 'Succeeded with issues', canceled: 'Canceled', skipped: 'Skipped', queued: 'Not started', running: 'Running', waiting: 'Waiting for approval' };
  const badge = (k, cls = '') => `<span class="st st-${k} ${cls}" title="${KIND_LABEL[k]}">${icon(KIND_ICON[k], k === 'running' ? 'spin' : '')}</span>`;
  const nodeKind = (n) => kind(n.state, n.result, n.waiting);
  const isActive = (k) => k === 'running' || k === 'queued' || k === 'waiting';

  function dur(start, end) {
    if (!start) return '';
    const s = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  function ago(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(iso).toLocaleString();
  }
  const plural = (n, word) => `${n} ${n === 1 ? word : word + 's'}`;
  /** ` name="value"`, or nothing without a value. */
  const attrIf = (name, value) => (value ? ' ' + name + '="' + esc(value) + '"' : '');
  /** A duration that keeps ticking while `end` is not set. */
  const live = (start, end) => (start ? `<span data-live="${esc(start)}"${attrIf('data-end', end)}>${dur(start, end)}</span>` : '');

  // ---------- DOM writes only for changed parts ----------
  /** HTML last written per part, without the text of ticking durations (the 1 s ticker keeps those current). */
  const written = new Map();
  /** Ticking durations, found again after a part is rewritten. @type {HTMLElement[] | null} */
  let liveEls = null;
  const liveText = /(<span data-live="[^"<>]*">)[^<]*/g;

  /**
   * Writes `html` into `el` unless the part shows the same already, so a poll that changes nothing keeps hover, text
   * selection, open menus and running animations. Returns whether it wrote. A part that is skipped still loses its
   * busy buttons, as a rewrite would have done.
   */
  function write(key, el, html) {
    const shape = html.replaceAll(liveText, '$1');
    if (written.get(key) === shape) {
      el.querySelectorAll('.busy').forEach((b) => b.classList.remove('busy'));
      return false;
    }
    written.set(key, shape);
    el.innerHTML = html;
    liveEls = null;
    return true;
  }

  // ---------- state ----------
  const saved = vscode.getState() || {};
  /** @type {any} */
  let data = null;
  let deps = {};
  let selected = saved.selected ?? null;
  let userPicked = !!saved.userPicked;
  /** explicit open/closed choices per job; otherwise failed, running or once-running jobs are open */
  const jobChoice = new Map(Object.entries(saved.jobChoice || {}));
  const seenRunning = new Set(saved.seenRunning || []);
  /** the log shown in the log pane: { logId, name, lines: string[], complete, stepId } */
  let log = saved.log ? { ...saved.log, lines: [], complete: false } : null;
  let userPickedLog = !!saved.userPickedLog;
  let follow = true;
  let filter = '';
  const persist = () => vscode.setState({
    selected, userPicked, jobChoice: Object.fromEntries(jobChoice), seenRunning: [...seenRunning].slice(-200),
    log: log && { logId: log.logId, name: log.name, stepId: log.stepId }, userPickedLog,
  });

  /** Pipelines without stages have jobs at the top; show them as one implicit stage. */
  function stagesOf(nodes) {
    if (nodes.length && nodes.every((n) => n.type === 'Stage')) return nodes;
    if (!nodes.length) return [];
    const r = data.run;
    return [{ id: '__jobs', name: 'Jobs', type: 'Stage', state: r.status === 'completed' ? 'completed' : 'inProgress', result: r.result, start: r.startTime, finish: r.finishTime, errors: [], warningCount: 0, children: nodes }];
  }
  const jobsOf = (stage) => stage.children.filter((c) => c.type === 'Job');

  function defaultStage(stages) {
    return (stages.find((s) => nodeKind(s) === 'running' || nodeKind(s) === 'waiting')
      || stages.find((s) => nodeKind(s) === 'fail')
      || stages.filter((s) => nodeKind(s) !== 'queued' && nodeKind(s) !== 'skipped').pop()
      || stages[0])?.id;
  }

  // ---------- header ----------
  function renderHead() {
    const r = data.run;
    const RUN_STATE = { completed: 'completed', notStarted: 'pending' };
    const runKind = kind(RUN_STATE[r.status] || 'inProgress', r.result);
    const running = r.status !== 'completed';
    let timing = '';
    if (r.startTime) timing = ' · started ' + ago(r.startTime) + ' · ' + live(r.startTime, r.finishTime);
    else if (r.queueTime) timing = ' · queued ' + ago(r.queueTime);
    const commit = r.commit ? `<span class="chip mono">${icon('commit')}${esc(r.commit)}</span>` : '';
    const who = r.requestedFor ? `<span class="chip">${icon('user')}${esc(r.requestedFor)}</span>` : '';
    const stopOrRerun = running
      ? `<button class="btn danger" data-act="cancel">${icon('stop')}Cancel</button>`
      : `<button class="btn" data-act="rerun" data-def="${r.definitionId}">${icon('rerun')}Run again</button>`;
    const head = $('head');
    const headClass = `rv-head rv-${runKind}`;
    if (head.className !== headClass) head.className = headClass;
    write('head', head, `
      <div class="rv-title">${badge(runKind, 'big')}
        <div><h1>${esc(r.definitionName)} <span class="muted">#${esc(r.number)}</span></h1>
          <div class="rv-meta">
            <span class="chip">${icon('branch')}${esc(r.branch)}</span>
            ${commit}
            ${who}
            <span class="muted">${esc(KIND_LABEL[runKind])}${timing}</span>
          </div></div></div>
      <div class="rv-actions">
        <button class="btn primary" data-act="stream">${icon('terminal')}${running ? 'Stream live logs' : 'All logs'}</button>
        ${stopOrRerun}
        <span class="artifacts-wrap"><button class="btn ghost" data-act="artifacts" title="Artifacts">${icon('box')}Artifacts</button><div id="artifacts" class="artifact-menu" hidden></div></span>
        <button class="btn ghost icon-only" data-act="refresh" title="Refresh">${icon('refresh')}</button>
        <button class="btn ghost icon-only" data-act="browser" title="Open in browser">${icon('external')}</button>
      </div>`);
  }

  // ---------- stage graph ----------
  function stageCard(s, completed) {
    const k = nodeKind(s);
    const jobs = jobsOf(s);
    const done = jobs.filter((j) => !isActive(nodeKind(j))).length;
    const SUB = { waiting: 'Waiting for approval', queued: 'Not started', skipped: 'Skipped' };
    const progress = jobs.length ? `${done}/${plural(jobs.length, 'job')}` : '';
    const sub = SUB[k] || progress + (s.start ? ' · ' + live(s.start, s.finish) : '');
    const approve = (s.approvals || []).map((id) => `<button class="btn small primary" data-approve="${esc(id)}">${icon('hand')}Review</button>`).join('');
    const canRetry = completed && s.identifier && (k === 'fail' || k === 'canceled');
    const retry = canRetry
      ? `<button class="btn small ghost" data-retry="${esc(s.identifier)}" data-name="${esc(s.name)}" title="Run the failed jobs of this stage again">${icon('rerun')}Rerun</button>` : '';
    const errors = s.errors.length ? `<div class="stage-err">${icon('fail')}${plural(s.errors.length, 'error')}</div>` : '';
    const actions = approve || retry ? `<div class="stage-actions">${approve}${retry}</div>` : '';
    return `<div class="stage st-card-${k}${s.id === selected ? ' selected' : ''}" data-stage="${esc(s.id)}" role="button" tabindex="0">
      <div class="stage-top">${badge(k)}<span class="stage-name" title="${esc(s.name)}">${esc(s.name)}</span></div>
      <div class="stage-sub">${sub}</div>
      ${errors}
      ${actions}
    </div>`;
  }

  /** Column of each stage: one right of its deepest dependency. */
  function columns(stages) {
    const col = new Map();
    const visit = (id, guard) => {
      if (col.has(id)) return col.get(id);
      if (guard.has(id)) return 0;
      guard.add(id);
      const ds = (deps[id] || []).filter((d) => stages.some((s) => s.id === d));
      const c = ds.length ? Math.max(...ds.map((d) => visit(d, guard))) + 1 : 0;
      col.set(id, c);
      return c;
    };
    stages.forEach((s) => visit(s.id, new Set()));
    return col;
  }

  /** Dependencies the edges were last drawn for. */
  let drawnDeps = '';

  function renderGraph(stages) {
    const wrap = $('graphWrap');
    const wasHidden = wrap.hidden;
    wrap.hidden = !stages.length || (stages.length === 1 && stages[0].id === '__jobs');
    if (wrap.hidden) return;
    const graph = $('graph');
    const col = columns(stages);
    const count = Math.max(0, ...col.values()) + 1;
    const cols = Array.from({ length: count }, (_, i) => stages.filter((s) => col.get(s.id) === i));
    const completed = data.run.status === 'completed';
    const html = `<svg class="edges" aria-hidden="true"></svg>` + cols.map((c) => `<div class="col">${c.map((s) => stageCard(s, completed)).join('')}</div>`).join('');
    const scroll = wrap.scrollLeft;
    const wrote = write('graph', graph, html);
    if (wrote) wrap.scrollLeft = scroll;
    const depsKey = JSON.stringify(deps);
    if (!wrote && !wasHidden && depsKey === drawnDeps) return;
    drawnDeps = depsKey;
    requestAnimationFrame(() => drawEdges(stages));
  }

  /** Connects every stage with its dependencies; drawn after layout, so it follows the real card positions. */
  function drawEdges(stages) {
    const graph = $('graph');
    const svg = graph.querySelector('svg.edges');
    if (!svg) return;
    const box = graph.getBoundingClientRect();
    const cards = new Map([...graph.querySelectorAll('[data-stage]')].map((el) => [/** @type {HTMLElement} */ (el).dataset.stage, el.getBoundingClientRect()]));
    svg.setAttribute('width', String(graph.scrollWidth));
    svg.setAttribute('height', String(graph.scrollHeight));
    let paths = '';
    for (const s of stages) {
      const to = cards.get(s.id);
      if (!to) continue;
      for (const d of deps[s.id] || []) {
        const from = cards.get(d);
        const dep = stages.find((x) => x.id === d);
        if (!from || !dep) continue;
        const x1 = from.right - box.left, y1 = from.top + from.height / 2 - box.top;
        const x2 = to.left - box.left, y2 = to.top + to.height / 2 - box.top;
        const dx = Math.max(16, (x2 - x1) / 2);
        paths += `<path class="edge edge-${nodeKind(dep)}" d="M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"/>`;
      }
    }
    svg.innerHTML = paths;
  }

  // ---------- jobs ----------
  function jobOpen(j, stage) {
    const k = nodeKind(j);
    if (k === 'running') seenRunning.add(j.id);
    if (jobChoice.has(j.id)) return jobChoice.get(j.id);
    // Stay open once opened automatically, so finishing a run does not hide its steps and logs.
    return k === 'fail' || k === 'running' || seenRunning.has(j.id) || jobsOf(stage).length <= 3;
  }

  function stepHtml(j, s) {
    const sk = nodeKind(s);
    const cls = ['step', 'step-' + sk, s.logId ? 'has-log' : '', log && log.logId === s.logId ? 'active' : ''].filter(Boolean).join(' ');
    const logAttrs = s.logId ? ' data-log="' + s.logId + '" data-step="' + esc(s.id) + '" data-name="' + esc(j.name + ' › ' + s.name) + '" title="Show log"' : '';
    const warnings = s.warningCount ? `<span class="pill warn-pill">${s.warningCount}</span>` : '';
    const errors = s.errors.length ? '<div class="step-errors">' + s.errors.map((e) => '<div>' + esc(e) + '</div>').join('') + '</div>' : '';
    return `<li class="${cls}"${logAttrs}>
      <div class="step-row">${badge(sk)}<span class="step-name">${esc(s.name)}</span>
        ${warnings}
        <span class="spacer"></span><span class="muted mono small">${live(s.start, s.finish)}</span></div>
      ${errors}
    </li>`;
  }

  function jobHtml(j, stage) {
    const k = nodeKind(j);
    const open = jobOpen(j, stage);
    const steps = j.children.filter((c) => c.type === 'Task');
    const warnings = j.warningCount ? `<span class="pill warn-pill">${plural(j.warningCount, 'warning')}</span>` : '';
    const logButton = j.logId
      ? `<button class="btn ghost small" data-log="${j.logId}" data-step="${esc(j.id)}" data-name="${esc(j.name)}" title="Show the whole job log">${icon('file')}Log</button>` : '';
    const stepList = steps.map((s) => stepHtml(j, s)).join('') || '<li class="muted small step-empty">No steps yet.</li>';
    return `<div class="job${open ? ' open' : ''}">
      <div class="job-head" data-job="${esc(j.id)}">${icon('chevron', 'caret')}${badge(k)}
        <span class="job-name">${esc(j.name)}</span>
        ${warnings}
        <span class="spacer"></span><span class="muted mono small">${live(j.start, j.finish)}</span>
        ${logButton}
      </div>
      ${open ? '<ol class="steps">' + stepList + '</ol>' : ''}
    </div>`;
  }

  function renderJobs(stage) {
    write('jobs', $('jobs'), stage ? `<h2>${esc(stage.name)}</h2>${jobsOf(stage).map((j) => jobHtml(j, stage)).join('') || '<p class="muted">No jobs in this stage yet.</p>'}` : '');
  }

  // ---------- log viewer ----------
  const CHUNK = 2000;
  const tsRe = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
  const ansiRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

  function lineHtml(raw, n) {
    let line = raw.replace(ansiRe, '');
    let ts = '';
    const m = tsRe.exec(line);
    if (m) { line = line.slice(m[0].length); if (data?.showTimestamps) ts = `<span class="ts">${esc(m[0].slice(11, 19))}</span>`; }
    let cls = '';
    const tag = /^##\[(\w+)\]/.exec(line);
    if (tag) {
      line = line.slice(tag[0].length);
      cls = { error: 'l-err', warning: 'l-warn', section: 'l-sec', command: 'l-cmd', debug: 'l-dbg', group: 'l-grp', endgroup: 'l-end' }[tag[1]] || '';
    }
    if (cls === 'l-end') return '';
    return `<div class="ln ${cls}"><span class="no">${n}</span>${ts}<span class="tx">${esc(line) || ' '}</span></div>`;
  }

  /** Appends lines in chunks of CHUNK; each chunk is its own block so the browser can skip off-screen ones. */
  function appendLines(body, lines, startNo) {
    for (let i = 0; i < lines.length; i += CHUNK) {
      const block = document.createElement('div');
      block.className = 'chunk';
      block.innerHTML = lines.slice(i, i + CHUNK).map((l, k) => lineHtml(l, startNo + i + k)).join('');
      body.appendChild(block);
    }
  }

  function renderLogPane() {
    const pane = $('log');
    pane.hidden = !log;
    document.querySelector('.rv-body')?.classList.toggle('with-log', !!log);
    if (!log) return;
    pane.innerHTML = `<div class="log-head">${icon('file')}<strong class="log-title" title="${esc(log.name)}">${esc(log.name)}</strong>
        <span class="spacer"></span>
        <label class="log-search">${icon('search')}<input id="logFilter" placeholder="Filter lines…" value="${esc(filter)}" spellcheck="false"></label>
        <label class="log-follow" title="Scroll to new lines"><input type="checkbox" id="follow" ${follow ? 'checked' : ''}>Follow</label>
        <button class="btn ghost small" data-act="openLogEditor" title="Open in editor">${icon('external')}</button>
        <button class="btn ghost small icon-only" data-act="closeLog" title="Close">${icon('x')}</button></div>
      <div class="log-body" id="logBody"><div class="mini-loading">Loading log…</div></div>`;
    const input = /** @type {HTMLInputElement} */ ($('logFilter'));
    let t = 0;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { filter = input.value; renderLogBody(); }, 200); });
    $('follow').addEventListener('change', (e) => { follow = /** @type {HTMLInputElement} */ (e.target).checked; });
    if (log.lines.length) renderLogBody();
  }

  function renderLogBody() {
    const body = $('logBody');
    if (!body || !log) return;
    body.innerHTML = '';
    if (log.error) { body.innerHTML = `<div class="run-alert">${esc(log.error)}</div>`; return; }
    if (filter) {
      const q = filter.toLowerCase();
      const hits = [];
      for (let i = 0; i < log.lines.length && hits.length < 5000; i++) if (log.lines[i].toLowerCase().includes(q)) hits.push(i);
      body.innerHTML = hits.length ? hits.map((i) => lineHtml(log.lines[i], i + 1)).join('') : '<div class="muted pad">No matching lines.</div>';
      return;
    }
    if (!log.lines.length) { body.innerHTML = `<div class="muted pad">${log.complete ? 'This log is empty.' : 'Waiting for output…'}</div>`; return; }
    appendLines(body, log.lines, 1);
    if (follow) body.scrollTop = body.scrollHeight;
  }

  function openLog(logId, name, stepId, picked) {
    if (log && log.logId === logId && !log.error) return;
    log = { logId, name, stepId, lines: [], complete: false };
    if (picked) userPickedLog = true;
    filter = '';
    persist();
    renderLogPane();
    markActiveStep();
    requestLog();
  }

  /** Asks for the lines we do not have yet; a log requested after its step ended is complete. */
  function requestLog() {
    if (!log || !data) return;
    const step = findStep(log.stepId);
    log.requestedDone = !step || !isActive(nodeKind(step));
    log.inFlight = true;
    vscode.postMessage({ type: 'log', logId: log.logId, have: log.lines.length });
  }

  function markActiveStep() {
    document.querySelectorAll('.step.active').forEach((el) => el.classList.remove('active'));
    if (log) document.querySelectorAll(`[data-log="${log.logId}"].step`).forEach((el) => el.classList.add('active'));
  }

  /** The step that owns the open log, found again after each poll. */
  function findStep(stepId) {
    for (const s of stagesOf(data.stages)) for (const j of jobsOf(s)) {
      if (j.id === stepId) return j;
      for (const t of j.children) if (t.id === stepId) return t;
    }
    return undefined;
  }

  /** Opens a useful log by itself: the running step, else the first failed one. The user's choice wins. */
  function autoLog(stage) {
    if (userPickedLog) return; // the user opened or closed a log themselves
    const steps = stage ? jobsOf(stage).flatMap((j) => j.children.filter((c) => c.type === 'Task' && c.logId).map((t) => ({ j, t }))) : [];
    const pick = steps.find(({ t }) => nodeKind(t) === 'running') || steps.find(({ t }) => nodeKind(t) === 'fail');
    if (pick) openLog(pick.t.logId, `${pick.j.name} › ${pick.t.name}`, pick.t.id, false);
  }

  // ---------- tests ----------
  let testRuns = [];
  const testResults = new Map();
  function testRunHtml(r) {
    const res = testResults.get(r.id);
    let body = '<p class="muted small pad">No failed tests.</p>';
    if (r.failed) body = res ? testList(res) : '<div class="mini-loading">Loading failed tests…</div>';
    const failedText = r.failed ? ' · ' + r.failed + ' failed' : '';
    return `<details class="test-run" data-test-run="${r.id}" ${res ? 'open' : ''}>
      <summary>${badge(r.failed ? 'fail' : 'ok')}<span class="grow">${esc(r.name)}</span><span class="muted small">${r.passed}/${r.total} passed${failedText}</span></summary>
      ${body}
    </details>`;
  }

  function renderTests() {
    const el = $('tests');
    el.hidden = !testRuns.length;
    if (!testRuns.length) return;
    const total = testRuns.reduce((s, r) => s + r.total, 0);
    const passed = testRuns.reduce((s, r) => s + r.passed, 0);
    const failed = testRuns.reduce((s, r) => s + r.failed, 0);
    const pill = failed ? `<span class="pill bad">${failed} failed</span>` : '<span class="pill ok">all passed</span>';
    el.innerHTML = `<h2>${icon('flask')}Tests ${pill}<span class="muted small">${passed}/${total} passed</span></h2>` + testRuns.map(testRunHtml).join('');
  }

  function testHtml(t) {
    const duration = t.duration ? '<span class="muted small">' + Math.round(t.duration) + ' ms</span>' : '';
    const error = t.error ? '<pre class="test-error">' + esc(t.error) + '</pre>' : '';
    const stack = t.stack ? '<pre class="test-stack">' + esc(t.stack) + '</pre>' : '';
    return `<li><details><summary>${badge('fail')}<span class="grow" title="${esc(t.fullName || t.name)}">${esc(t.name)}</span>${duration}</summary>${error}${stack}</details></li>`;
  }

  function testList(res) {
    if (res.error) return `<div class="run-alert">${esc(res.error)}</div>`;
    return `<ul class="test-results">${res.results.map(testHtml).join('')}</ul>`;
  }

  // ---------- render ----------
  function render() {
    if (!data) return;
    const stages = stagesOf(data.stages);
    if (!userPicked || !stages.some((s) => s.id === selected)) selected = defaultStage(stages);
    const stage = stages.find((s) => s.id === selected);
    renderHead();
    renderGraph(stages);
    const empty = $('empty');
    empty.hidden = !!stages.length;
    const emptyText = data.run.status === 'completed' ? 'No stages or jobs were recorded for this run.' : 'Waiting for an agent to pick up the run…';
    if (empty.textContent !== emptyText) empty.textContent = emptyText;
    renderJobs(stage);
    autoLog(stage);
    markActiveStep();
    persist();
  }

  /** Keeps a log of a running step growing; a finished step's log is fetched once more to be complete. */
  function pollLog() {
    if (log && !log.complete && !log.inFlight) requestLog();
  }

  // ---------- events ----------
  /** Clicks on elements with one of these data attributes; each returns nothing. */
  const CLICK = {
    approve: (el, d, e) => { e.stopPropagation(); el.classList.add('busy'); vscode.postMessage({ type: 'approve', approvalId: d.approve }); },
    retry: (el, d, e) => { e.stopPropagation(); vscode.postMessage({ type: 'retryStage', identifier: d.retry, name: d.name }); },
    download: (el, d) => { vscode.postMessage({ type: 'download', name: d.download }); $('artifacts').hidden = true; },
    log: (el, d, e) => { e.stopPropagation(); openLog(Number(d.log), d.name, d.step, true); },
    stage: (el, d) => { selected = d.stage; userPicked = true; render(); },
    job: (el, d) => { jobChoice.set(d.job, !el.parentElement?.classList.contains('open')); persist(); render(); },
  };
  const ACTIONS = {
    closeLog: () => { log = null; userPickedLog = true; persist(); renderLogPane(); markActiveStep(); },
    openLogEditor: () => { if (log) vscode.postMessage({ type: 'openLog', logId: log.logId, name: log.name }); },
    artifacts: () => {
      const menu = $('artifacts');
      menu.hidden = !menu.hidden;
      if (!menu.hidden) {
        menu.innerHTML = '<div class="mini-loading">Loading…</div>';
        vscode.postMessage({ type: 'artifacts' });
      }
    },
  };

  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const el = /** @type {HTMLElement | null} */ (target.closest('[data-act],[data-stage],[data-log],[data-job],[data-approve],[data-retry],[data-download]'));
    if (!el) {
      const menu = $('artifacts');
      if (menu && !target.closest('.artifacts-wrap')) menu.hidden = true;
      return;
    }
    const d = el.dataset;
    const key = Object.keys(CLICK).find((k) => d[k]);
    if (key) { CLICK[key](el, d, e); return; }
    if (ACTIONS[d.act]) { ACTIONS[d.act](); return; }
    if (d.act === 'refresh' || d.act === 'cancel') el.classList.add('busy');
    vscode.postMessage({ type: d.act, definitionId: Number(d.def) });
  });
  document.addEventListener('keydown', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if ((e.key === 'Enter' || e.key === ' ') && el.dataset?.stage) { e.preventDefault(); el.click(); }
  });
  document.addEventListener('toggle', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const runId = Number(t.dataset?.testRun);
    if (runId && /** @type {HTMLDetailsElement} */ (t).open && !testResults.has(runId)) vscode.postMessage({ type: 'tests', runId });
  }, true);

  /** Ticks running durations between polls; looks them up again only after a part was rewritten. */
  function tick() {
    if (document.hidden) return;
    liveEls ??= /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-live]:not([data-end])')]);
    for (const el of liveEls) {
      const text = dur(el.dataset.live);
      if (el.textContent !== text) el.textContent = text;
    }
  }
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', tick);
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => requestAnimationFrame(() => data && drawEdges(stagesOf(data.stages))), 100);
  });

  /** New lines of the open log: appended in place, or a full render for the first batch or while filtering. */
  function onLog(m) {
    if (!log || m.logId !== log.logId) return;
    log.inFlight = false;
    if (m.error) { log.error = m.error; renderLogBody(); return; }
    const recovered = !!log.error;
    delete log.error;
    const fresh = m.lines.slice(log.lines.length - m.from);
    const first = !log.lines.length;
    log.lines.push(...fresh);
    if (log.requestedDone) log.complete = true;
    const body = $('logBody');
    if (!body) { renderLogPane(); return; }
    if (first || filter || recovered) { renderLogBody(); return; }
    if (!fresh.length) return;
    body.querySelector('.muted.pad')?.remove();
    appendLines(body, fresh, log.lines.length - fresh.length + 1);
    if (follow) body.scrollTop = body.scrollHeight;
  }

  function onArtifacts(m) {
    const menu = $('artifacts');
    const item = (a) => `<button class="artifact" data-download="${esc(a.name)}" ${a.downloadable ? '' : 'disabled'}>${icon('down')}<span>${esc(a.name)}</span></button>`;
    if (m.error) menu.innerHTML = `<div class="run-alert">${esc(m.error)}</div>`;
    else menu.innerHTML = m.items.length ? m.items.map(item).join('') : '<div class="muted pad">No artifacts.</div>';
  }

  const MESSAGES = {
    data: (m) => { data = m; deps = m.deps || {}; render(); pollLog(); },
    deps: (m) => { deps = m.deps || {}; if (data) renderGraph(stagesOf(data.stages)); },
    log: onLog,
    testRuns: (m) => { testRuns = m.runs; renderTests(); },
    testResults: (m) => { testResults.set(m.runId, m); renderTests(); },
    artifacts: onArtifacts,
    error: (m) => {
      if (!data) write('head', $('head'), `<div class="run-alert">${esc(m.message)}</div>`);
      document.querySelectorAll('.busy').forEach((b) => b.classList.remove('busy'));
    },
  };
  window.addEventListener('message', ({ data: m }) => MESSAGES[m.type]?.(m));

  if (log) renderLogPane();
  vscode.postMessage({ type: 'ready' });
})();

// @ts-check
/* Azure DevOps sidebar dashboard. Plain DOM + template strings, no framework. */
(function () {
  const vscode = acquireVsCodeApi();

  // ---------- icons (Lucide, ISC license) ----------
  const ICONS = {
    pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
    board: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
    rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    building: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    rerun: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    user: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
    swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    fail: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    skip: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    spinner: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>',
    repo: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    prPlus: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="M13 6h3a2 2 0 0 1 2 2v3"/><path d="M18 15v6"/><path d="M21 18h-6"/>',
  };
  const icon = (name, cls = '') =>
    `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const attr = (v) => esc(JSON.stringify(v));
  const plural = (n, word) => `${n} ${n === 1 ? word : word + 's'}`;
  const selectedIf = (on) => (on ? 'selected' : '');

  function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }
  function duration(start, end) {
    if (!start) return '';
    const s = Math.max(0, Math.round(((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  function initials(name) {
    const parts = String(name || '?').replace(/[[\]()]/g, '').split(/[\s.@_\\-]+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function hue(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }
  const avatar = (name, cls = '') => `<span class="avatar ${cls}" style="--hue:${hue(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;
  /** Project of an item, shown only when several projects are selected. */
  const projChip = (p) => (p ? `<span class="proj" title="Project ${esc(p)}">${esc(p)}</span>` : '');
  const branchName = (b) => `<span class="branch" title="${esc(b)}">${icon('branch')}<span>${esc(b)}</span></span>`;

  function statusIcon(state, result) {
    if (state === 'inProgress' || state === 'cancelling') return `<span class="status running">${icon('spinner', 'spin')}</span>`;
    if (state === 'notStarted' || state === 'pending' || state === 'postponed') return `<span class="status queued">${icon('clock')}</span>`;
    switch (result) {
      case 'succeeded': return `<span class="status ok">${icon('ok')}</span>`;
      case 'failed': return `<span class="status fail">${icon('fail')}</span>`;
      case 'partiallySucceeded':
      case 'succeededWithIssues': return `<span class="status warn">${icon('warn')}</span>`;
      case 'canceled':
      case 'abandoned': return `<span class="status muted">${icon('ban')}</span>`;
      case 'skipped': return `<span class="status muted">${icon('skip')}</span>`;
    }
    return `<span class="status muted">${icon('dot')}</span>`;
  }
  const isRunning = (b) => b && (b.status === 'inProgress' || b.status === 'notStarted' || b.status === 'cancelling');

  const TYPE_COLORS = {
    Bug: '#cc293d', Task: '#f2cb1d', 'User Story': '#009ccc', 'Product Backlog Item': '#009ccc', Requirement: '#009ccc',
    Feature: '#773b93', Epic: '#ff7b00', Issue: '#b4009e', Impediment: '#b4009e', 'Test Case': '#004b50',
  };
  const typeColor = (t) => TYPE_COLORS[t] || '#8a8a8a';

  // ---------- rpc ----------
  let seq = 0;
  const pending = new Map();
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      vscode.postMessage({ type: 'rpc', id, method, params });
    });
  }
  const command = (name, ...args) => vscode.postMessage({ type: 'command', name, args });

  // ---------- state ----------
  const saved = vscode.getState() || {};
  const S = {
    tab: saved.tab || 'prs',
    prFilter: saved.prFilter || 'review',
    wiQuery: saved.wiQuery || 'builtin:0',
    buildFilter: saved.buildFilter || 'recent',
    sprintTeam: saved.sprintTeam || null,
    sprintIteration: saved.sprintIteration || null,
    sprintGroup: saved.sprintGroup || 'state',
    teams: null,
    /** open folder in the pipelines "Folders" view, as path segments */
    folder: Array.isArray(saved.folder) ? saved.folder : [],
    search: '',
    ctx: null,
    me: null,
    data: {},
    errors: {},
    loading: {},
    counts: {},
    /** last successful load per tab, for the background refresh */
    loadedAt: {},
    /** whether the VS Code window has focus; background refresh pauses without it */
    focused: true,
    req: { prs: 0, wis: 0, sprint: 0, pipelines: 0 },
    expanded: new Set(),
    details: new Map(),
    queries: null,
    /** project dropdown: null when closed, else { org, projects, loading, error, filter, saving } */
    picker: null,
  };
  const persist = () => vscode.setState({
    tab: S.tab, prFilter: S.prFilter, wiQuery: S.wiQuery, buildFilter: S.buildFilter, folder: S.folder,
    sprintTeam: S.sprintTeam, sprintIteration: S.sprintIteration, sprintGroup: S.sprintGroup,
  });

  const TABS = [
    { id: 'prs', label: 'Pull Requests', icon: 'pr' },
    { id: 'wis', label: 'Work Items', icon: 'board' },
    { id: 'sprint', label: 'Sprint', icon: 'calendar' },
    { id: 'pipelines', label: 'Pipelines', icon: 'rocket' },
  ];
  const PR_FILTERS = [['review', 'To review'], ['mine', 'Mine'], ['all', 'All active']];
  const BUILD_FILTERS = [['recent', 'Recent'], ['mine', 'Mine'], ['defs', 'Pipelines'], ['folders', 'Folders'], ['approvals', 'Approvals']];
  const SPRINT_GROUPS = [['state', 'By state'], ['parent', 'By parent'], ['person', 'By person']];
  const usesDefinitions = () => S.buildFilter === 'defs' || S.buildFilter === 'folders';

  // ---------- data loading ----------
  async function load(tab, silent = false) {
    if (!S.ctx?.configured) return;
    const req = ++S.req[tab];
    if (!silent) {
      S.loading[tab] = true;
      if (tab === S.tab) renderList();
    }
    try {
      const data = await fetchTab(tab);
      if (req !== S.req[tab]) return;
      S.data[tab] = data;
      if (!silent) S.animate = true;
      S.errors[tab] = null;
      S.counts[tab] = tab === 'sprint' ? data.items.filter((i) => i.stateCategory !== 'Completed').length : data.length;
      S.loadedAt[tab] = Date.now();
    } catch (e) {
      if (req !== S.req[tab]) return;
      S.errors[tab] = e;
    }
    S.loading[tab] = false;
    renderTabs();
    if (tab === S.tab) renderList();
  }

  /** The data of a tab for its current filter. */
  function fetchTab(tab) {
    if (tab === 'prs') return rpc('prs', { filter: S.prFilter });
    if (tab === 'wis') return rpc('workItems', { query: S.wiQuery });
    if (tab === 'sprint') return loadSprint();
    if (S.buildFilter === 'approvals') return rpc('approvals');
    return usesDefinitions() ? rpc('definitions') : rpc('builds', { filter: S.buildFilter });
  }

  /** Teams are loaded once; the first one (own teams come first) is the default. */
  async function loadSprint() {
    if (!S.teams) {
      S.teams = await rpc('teams');
      if (S.tab === 'sprint') renderToolbar();
    }
    const teamKey = (t) => JSON.stringify([t.project || '', t.name]);
    if (!S.sprintTeam || !S.teams.some((t) => teamKey(t) === S.sprintTeam)) { S.sprintTeam = S.teams[0] ? teamKey(S.teams[0]) : null; S.sprintIteration = null; persist(); }
    if (!S.sprintTeam) return { iterations: [], items: [], people: [] };
    const [project, team] = JSON.parse(S.sprintTeam);
    const data = await rpc('sprint', { team, project: project || undefined, iteration: S.sprintIteration });
    if (S.tab === 'sprint') setTimeout(renderToolbar);
    return data;
  }

  async function loadDetail(key, method, params, silent = false) {
    // Reopening shows the cached details at once and refreshes them in the background.
    const cached = S.details.get(key);
    if (!silent && !cached?.data) {
      S.details.set(key, { loading: true });
      renderCard(key);
    }
    try {
      S.details.set(key, { data: await rpc(method, params) });
    } catch (e) {
      if (cached?.data) return;
      S.details.set(key, { error: e });
    }
    if (S.expanded.has(key)) renderCard(key);
  }

  /** Re-renders a single expandable card in place instead of the whole list. */
  function renderCard(key) {
    const el = [...document.querySelectorAll('[data-toggle]')].find((x) => x instanceof HTMLElement && x.dataset.toggle === key);
    const [kind, a, b] = key.split(':');
    const items = S.data[kind === 'pr' ? 'prs' : 'pipelines'] || [];
    let html;
    if (kind === 'pr') { const pr = items.find((x) => x.repoId === a && x.id === Number(b)); html = pr && prCard(pr); }
    else if (kind === 'build') { const r = items.find((x) => x.definitionName !== undefined && x.id === Number(a)); html = r && buildCard(r); }
    else if (kind === 'def') { const d = items.find((x) => x.definitionName === undefined && x.id === Number(a) && (x.project || '') === (b || '')); html = d && defCard(d); }
    if (!el || !html) { renderList(); return; }
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const next = tpl.content.firstElementChild;
    if (!next) return;
    const wasOpen = !!el.querySelector('.expand');
    const expand = next.querySelector('.expand');
    if (expand && !wasOpen) expand.classList.add('entering');
    const focused = document.activeElement === el;
    el.replaceWith(next);
    if (focused && next instanceof HTMLElement) next.focus();
  }

  async function init() {
    S.ctx = await rpc('context');
    S.focused = S.ctx.focused !== false;
    S.details.clear();
    renderShell();
    if (!S.ctx.configured) return;
    rpc('me').then((me) => { S.me = me; renderHeader(); }).catch(() => undefined);
    await load(S.tab);
    // Background loads for the tab badges; the sprint (several requests) waits until it is opened.
    for (const t of TABS) if (t.id !== S.tab && t.id !== 'sprint') load(t.id, true);
    if (!S.queries) rpc('queries').then((q) => { S.queries = q; renderToolbar(); }).catch(() => undefined);
  }

  // ---------- rendering ----------
  const app = document.getElementById('app');

  function renderShell() {
    if (!S.ctx.configured) {
      app.innerHTML = `
        <div class="onboarding">
          <div class="hero-logo">${icon('rocket')}</div>
          <h2>Connect to Azure DevOps</h2>
          <p>Review pull requests, manage work items and watch pipelines without leaving VS Code.</p>
          <div class="picker inline" id="picker"></div>
          <div class="row-gap">
            <button class="btn subtle" data-cmd="azureDevOps.signIn">${icon('login')} Sign in with Microsoft</button>
            <button class="btn subtle" data-cmd="azureDevOps.setPat">${icon('key')} Use a PAT</button>
          </div>
          <p class="hint">Tip: open a repository cloned from Azure DevOps and the organization is detected automatically.</p>
        </div>`;
      if (!S.picker) openPicker(S.ctx.orgUrl || '');
      renderPicker();
      return;
    }
    app.innerHTML = `
      <header class="topbar" id="topbar"></header>
      <nav class="tabs" role="tablist" id="tabs"></nav>
      <div class="toolbar">
        <label class="search">${icon('search')}<input id="search" type="search" placeholder="Filter…" autocomplete="off" spellcheck="false"></label>
        <div class="filters" id="filters"></div>
      </div>
      <main id="list" class="list"></main>`;
    const input = /** @type {HTMLInputElement} */ (document.getElementById('search'));
    input.value = S.search;
    input.addEventListener('input', () => { S.search = input.value.trim().toLowerCase(); renderList(); });
    renderHeader();
    renderTabs();
    renderToolbar();
    renderList();
  }

  function renderHeader() {
    const el = document.getElementById('topbar');
    if (!el) return;
    el.innerHTML = `
      <button class="project ${S.picker ? 'open' : ''}" data-act="picker" title="${esc(S.ctx.orgUrl)} — switch project" aria-haspopup="listbox" aria-expanded="${!!S.picker}">
        <span class="project-logo" style="--hue:${hue(S.ctx.project)}">${esc(initials(S.ctx.project))}</span>
        <span class="project-text"><strong>${esc(S.ctx.project)}${(S.ctx.projects || []).length > 1 ? ` <span class="more-proj">+${S.ctx.projects.length - 1}</span>` : ''}</strong><small>${esc(S.ctx.org)}</small></span>
        ${icon('chevronDown', 'project-caret')}
      </button>
      <div class="top-actions">
        <button class="icon-btn" data-cmd="azureDevOps.repos.open" title="Repositories & branches">${icon('repo')}</button>
        <button class="icon-btn" data-cmd="azureDevOps.wiki.open" title="Wiki">${icon('book')}</button>
        ${S.me ? avatar(S.me.displayName, 'me') : ''}
        <button class="icon-btn" data-act="refresh" title="Refresh">${icon('refresh')}</button>
      </div>
      ${S.picker ? '<div class="picker popover" id="picker"></div>' : ''}`;
    renderPicker();
  }

  // ---------- project dropdown ----------
  function openPicker(org) {
    // `multi`: projects ticked to be shown together; starts with the current selection of this organization.
    const current = S.ctx?.configured && normOrg(S.ctx.orgUrl) === normOrg(org || '') ? (S.ctx.projects || [S.ctx.project]) : [];
    S.picker = { org, projects: null, loading: false, error: null, filter: '', saving: null, multi: [...current] };
    if (org) loadProjects(org);
  }
  function closePicker() {
    if (!S.picker || !S.ctx?.configured) return;
    S.picker = null;
    renderHeader();
  }
  async function loadProjects(org) {
    const p = S.picker;
    if (!p) return;
    Object.assign(p, { org, projects: null, loading: true, error: null });
    renderPicker();
    try {
      const projects = await rpc('projects', { org });
      if (S.picker !== p || p.org !== org) return;
      p.projects = projects;
    } catch (e) {
      if (S.picker !== p || p.org !== org) return;
      p.error = e;
    }
    p.loading = false;
    renderPicker();
  }
  async function selectProject(project) {
    const p = S.picker;
    if (!p || p.saving) return;
    if (project === currentProjectIn(p.org)) { closePicker(); return; }
    p.saving = project;
    renderPickerList();
    try {
      await rpc('setProject', { org: p.org, projects: [project] });
      // The extension refreshes the view once the new settings are resolved.
    } catch (e) {
      p.saving = null;
      p.error = e;
      renderPickerList();
    }
  }

  /** Saves the ticked projects; the current primary project stays first. */
  async function applyProjects() {
    const p = S.picker;
    if (!p || p.saving || !p.multi.length) return;
    const primary = currentProjectIn(p.org);
    const list = primary && p.multi.includes(primary) ? [primary, ...p.multi.filter((x) => x !== primary)] : p.multi;
    p.saving = list[0];
    renderPickerList();
    try {
      await rpc('setProject', { org: p.org, projects: list });
    } catch (e) {
      p.saving = null;
      p.error = e;
      renderPickerList();
    }
  }

  function renderPicker() {
    const el = document.getElementById('picker');
    const p = S.picker;
    if (!el || !p) return;
    el.innerHTML = `
      <form class="picker-org" id="pickerOrgForm">
        <label class="search">${icon('building')}<input id="pickerOrg" placeholder="Organization, e.g. contoso" value="${esc(p.org)}" autocomplete="off" spellcheck="false"></label>
        <button class="btn subtle" type="submit">Load</button>
      </form>
      <label class="search">${icon('search')}<input id="pickerFilter" type="search" placeholder="Search projects…" value="${esc(p.filter)}" autocomplete="off" spellcheck="false"></label>
      <ul class="picker-list" id="pickerList" role="listbox"></ul>
      <div class="picker-foot" id="pickerFoot"></div>`;
    const orgInput = /** @type {HTMLInputElement} */ (document.getElementById('pickerOrg'));
    const filter = /** @type {HTMLInputElement} */ (document.getElementById('pickerFilter'));
    document.getElementById('pickerOrgForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (orgInput.value.trim()) loadProjects(orgInput.value.trim());
    });
    filter.addEventListener('input', () => { p.filter = filter.value; renderPickerList(); });
    filter.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = visibleProjects()[0];
      if (first) selectProject(first);
    });
    renderPickerList();
    (p.org ? filter : orgInput).focus();
  }

  const trimSlashes = (s) => {
    let e = s.length;
    while (e > 0 && s[e - 1] === '/') e--;
    return s.slice(0, e);
  };
  const normOrg = (o) => trimSlashes(o.includes('://') ? o : `https://dev.azure.com/${o}`).toLowerCase();
  const currentProjectIn = (org) => (S.ctx?.configured && normOrg(S.ctx.orgUrl) === normOrg(org) ? S.ctx.project : null);

  function visibleProjects() {
    const p = S.picker;
    const q = p?.filter.trim().toLowerCase() || '';
    return (p?.projects || []).filter((name) => name.toLowerCase().includes(q));
  }

  function renderPickerList() {
    const el = document.getElementById('pickerList');
    const p = S.picker;
    if (!el || !p) return;
    if (!p.org) { el.innerHTML = `<li class="picker-note">Enter your organization to list its projects.</li>`; return; }
    if (p.loading) { el.innerHTML = `<li class="picker-note">${icon('spinner', 'spin')} Loading projects…</li>`; return; }
    if (p.error) { el.innerHTML = pickerError(p.error); return; }
    const items = visibleProjects();
    if (!items.length) { el.innerHTML = `<li class="picker-note">No matching projects.</li>`; return; }
    const current = currentProjectIn(p.org);
    el.innerHTML = items.map((name) => pickerItem(name, current, p)).join('');
    const foot = document.getElementById('pickerFoot');
    const selected = S.ctx?.configured && normOrg(S.ctx.orgUrl) === normOrg(p.org) ? (S.ctx.projects || []) : [];
    const changed = p.multi.length && (p.multi.length !== selected.length || p.multi.some((x) => !selected.includes(x)));
    if (foot) foot.innerHTML = changed ? `<button class="btn primary" data-act="applyProjects">Show ${plural(p.multi.length, 'project')}</button>` : '';
  }

  function pickerError(err) {
    const signIn = err.auth ? `<li class="picker-note row-gap"><button class="btn primary" data-cmd="azureDevOps.signIn">${icon('login')} Sign in</button>
        <button class="btn subtle" data-cmd="azureDevOps.setPat">${icon('key')} Use PAT</button></li>` : '';
    return `<li class="picker-note error">${icon(err.auth ? 'key' : 'warn')} ${esc(err.message)}</li>${signIn}`;
  }

  /** One project: click shows only it; the tick adds it to the projects shown together. */
  function pickerItem(name, current, p) {
    const ticked = p.multi.includes(name);
    const tickTitle = (ticked ? 'Remove from' : 'Add to') + ' the projects shown together';
    return `
      <li role="option" class="picker-item ${name === current ? 'current' : ''}" data-project="${esc(name)}" aria-selected="${name === current}" tabindex="0" title="Show only ${esc(name)}">
        <span class="project-logo small" style="--hue:${hue(name)}">${esc(initials(name))}</span>
        <span class="picker-name">${esc(name)}</span>
        ${p.saving === name ? icon('spinner', 'spin') : ''}
        <button class="tick ${ticked ? 'on' : ''}" data-tick="${esc(name)}" role="checkbox" aria-checked="${ticked}" title="${tickTitle}">${ticked ? icon('check') : ''}</button>
      </li>`;
  }

  function renderTabs() {
    const el = document.getElementById('tabs');
    if (!el) return;

    el.innerHTML = `<span class="tab-indicator"></span>` + TABS.map((t) => `
      <button role="tab" class="tab ${t.id === S.tab ? 'active' : ''}" data-tab="${t.id}" aria-selected="${t.id === S.tab}" title="${t.label}">
        ${icon(t.icon)}<span class="tab-label">${t.label}</span>${S.counts[t.id] === undefined ? '' : '<span class="badge">' + S.counts[t.id] + '</span>'}
      </button>`).join('');
    placeIndicator(el);
  }

  /** Moves the highlight under the active tab (tabs have different widths). */
  function placeIndicator(el) {
    const active = el.querySelector('.tab.active');
    if (!(active instanceof HTMLElement)) return;
    el.style.setProperty('--x', `${active.offsetLeft - 3}px`);
    el.style.setProperty('--w', `${active.offsetWidth}px`);
  }

  function chips(list, active, kind) {
    const chip = ([v, l]) => `<button class="chip ${v === active ? 'active' : ''}" data-filter="${kind}" data-value="${v}">${l}</button>`;
    return '<div class="chips">' + list.map(chip).join('') + '</div>';
  }

  function renderToolbar() {
    const el = document.getElementById('filters');
    if (!el) return;
    if (S.tab === 'prs') {
      el.innerHTML = `<div class="select-row">${chips(PR_FILTERS, S.prFilter, 'prFilter')}
        <button class="icon-btn accent" data-cmd="azureDevOps.pr.create" title="Create pull request">${icon('prPlus')}</button></div>`;
    } else if (S.tab === 'sprint') {
      renderSprintToolbar(el);
    } else if (S.tab === 'wis') {
      const q = S.queries;
      const builtin = q ? q.builtin : [{ key: 'builtin:0', name: 'Assigned to me' }];
      const option = (o) => `<option value="${esc(o.key)}" ${selectedIf(o.key === S.wiQuery)} title="${esc(o.path || o.name)}">${esc(o.name)}</option>`;
      const options = builtin.map(option).join('');
      const savedOpts = q && q.saved.length ? '<optgroup label="Saved queries">' + q.saved.map(option).join('') + '</optgroup>' : '';
      el.innerHTML = `<div class="select-row">
          <label class="select">${icon('board')}<select id="wiQuery">${options}${savedOpts}</select></label>
          <button class="icon-btn" data-cmd="azureDevOps.wi.openById" title="Open by ID">${icon('hash')}</button>
          <button class="icon-btn accent" data-cmd="azureDevOps.wi.create" title="New work item">${icon('plus')}</button>
        </div>`;
      document.getElementById('wiQuery')?.addEventListener('change', (e) => {
        S.wiQuery = /** @type {HTMLSelectElement} */ (e.target).value;
        persist();
        load('wis');
      });
    } else {
      el.innerHTML = `<div class="select-row">${chips(BUILD_FILTERS, S.buildFilter, 'buildFilter')}
        <button class="icon-btn accent" data-cmd="azureDevOps.pipelines.run" title="Run pipeline">${icon('play')}</button></div>`;
    }
  }

  function renderSprintToolbar(el) {
    const teams = S.teams || [];
    const teamKey = (t) => JSON.stringify([t.project || '', t.name]);
    const d = S.data.sprint;
    const its = d?.iterations || [];
    const current = d?.iteration?.id;
    const itLabel = (i) => i.name + (i.timeFrame === 'current' ? ' (current)' : '');
    const teamLabel = (t) => (t.project ? t.project + ' / ' + t.name : t.name);
    const teamOption = (t) => `<option value="${esc(teamKey(t))}" ${selectedIf(teamKey(t) === S.sprintTeam)}>${esc(teamLabel(t))}</option>`;
    const itOption = (i) => `<option value="${esc(i.id)}" ${selectedIf(i.id === current)}>${esc(itLabel(i))}</option>`;
    el.innerHTML = `<div class="select-row">
        <label class="select">${icon('user')}<select id="sprintTeam" title="Team">${teams.map(teamOption).join('')}</select></label>
        <label class="select">${icon('calendar')}<select id="sprintIteration" title="Sprint">${its.map(itOption).join('')}</select></label>
      </div>${chips(SPRINT_GROUPS, S.sprintGroup, 'sprintGroup')}`;
    document.getElementById('sprintTeam')?.addEventListener('change', (e) => {
      S.sprintTeam = /** @type {HTMLSelectElement} */ (e.target).value; S.sprintIteration = null; persist(); S.data.sprint = null; load('sprint');
    });
    document.getElementById('sprintIteration')?.addEventListener('change', (e) => {
      S.sprintIteration = /** @type {HTMLSelectElement} */ (e.target).value; persist(); S.data.sprint = null; load('sprint');
    });
  }

  function renderList() {
    const el = document.getElementById('list');
    if (!el) return;
    const tab = S.tab;
    const data = S.data[tab];
    if (S.loading[tab] && !data) { el.innerHTML = skeleton(); return; }
    if (S.errors[tab]) { el.innerHTML = errorState(S.errors[tab]); return; }
    if (!data) { el.innerHTML = skeleton(); return; }
    const progress = S.loading[tab] ? '<div class="progress"></div>' : '';
    el.classList.toggle('animate', !!S.animate);
    S.animate = false;
    if (tab === 'sprint') { el.innerHTML = progress + sprintView(data); return; }
    if (tab === 'pipelines' && S.buildFilter === 'folders') { el.innerHTML = progress + folderView(data); return; }
    const filtered = data.filter((item) => !S.search || haystack(tab, item).includes(S.search));
    el.innerHTML = progress + (filtered.length ? filtered.map(cardRenderer(tab)).join('') : emptyState(tab));
  }

  function cardRenderer(tab) {
    if (tab === 'prs') return prCard;
    if (tab === 'wis') return wiCard;
    if (S.buildFilter === 'approvals') return approvalCard;
    return S.buildFilter === 'defs' ? defCard : buildCard;
  }

  function haystack(tab, i) {
    if (tab === 'prs') return `${i.id} ${i.title} ${i.repoName} ${i.author} ${i.source} ${i.target} ${i.project || ''}`.toLowerCase();
    if (tab === 'wis') return `${i.id} ${i.title} ${i.type} ${i.state} ${i.assignedTo || ''} ${i.tags.join(' ')} ${i.project || ''}`.toLowerCase();
    if (i.definitionName) return `${i.number} ${i.definitionName} ${i.branch} ${i.requestedFor || ''}`.toLowerCase();
    if (i.approvers) return `${i.pipeline || ''} ${i.run || ''} ${i.instructions || ''}`.toLowerCase();
    return `${i.name} ${i.path}`.toLowerCase();
  }

  function skeleton() {
    return Array.from({ length: 5 }, () => `
      <div class="card skeleton"><span class="sk sk-avatar"></span>
        <div class="sk-lines"><span class="sk sk-line w80"></span><span class="sk sk-line w50"></span><span class="sk sk-line w30"></span></div></div>`).join('');
  }

  function emptyState(tab) {
    const msg = S.search ? 'Nothing matches your filter.' : emptyMessage(tab);
    return `<div class="empty">${icon(S.search ? 'search' : 'inbox')}<p>${esc(msg)}</p></div>`;
  }

  function emptyMessage(tab) {
    if (tab === 'prs') return S.prFilter === 'review' ? 'No pull requests waiting for your review. Enjoy the calm.' : 'No active pull requests.';
    if (tab === 'wis') return 'No work items in this query.';
    if (tab === 'sprint') return 'No work items in this sprint.';
    return S.buildFilter === 'approvals' ? 'No approvals are waiting.' : 'No pipeline runs yet.';
  }

  function errorState(e) {
    return `<div class="error-card">
      <div class="error-title">${icon(e.auth ? 'key' : 'warn')}<strong>${e.auth ? 'Authentication needed' : 'Something went wrong'}</strong></div>
      <p>${esc(e.message)}</p>
      <div class="row-gap">
        ${e.auth ? signInButtons() : ''}
        <button class="btn subtle" data-act="refresh">${icon('refresh')} Retry</button>
      </div></div>`;
  }

  function signInButtons() {
    return `<button class="btn primary" data-cmd="azureDevOps.signIn">${icon('login')} Sign in</button>
        <button class="btn subtle" data-cmd="azureDevOps.setPat">${icon('key')} Use PAT</button>`;
  }

  function actionBtn(iconName, title, cmd, args, cls = '') {
    return `<button class="icon-btn ${cls}" title="${esc(title)}" data-cmd="${cmd}" data-args="${attr(args)}">${icon(iconName)}</button>`;
  }

  // ----- pull requests -----
  const VOTE = { 10: ['ok', 'check', 'Approved'], 5: ['ok', 'check', 'Approved with suggestions'], '-5': ['warn', 'clock', 'Waiting for author'], '-10': ['fail', 'x', 'Rejected'] };

  function prCard(pr) {
    const key = `pr:${pr.repoId}:${pr.id}`;
    const open = S.expanded.has(key);
    const reviewer = (r) => {
      const v = VOTE[r.vote];
      const badge = v ? '<span class="vote ' + v[0] + '">' + icon(v[1]) + '</span>' : '';
      return `<span class="reviewer" title="${esc(r.name)} — ${v ? v[2] : 'No vote'}">${avatar(r.name, r.isContainer ? 'group' : '')}${badge}</span>`;
    };
    const more = pr.reviewers.length > 5 ? '<span class="more">+' + (pr.reviewers.length - 5) + '</span>' : '';
    const reviewers = pr.reviewers.slice(0, 5).map(reviewer).join('') + more;
    const myVote = VOTE[pr.myVote];
    const myVotePill = myVote ? `<span class="pill ${myVote[0]}">${icon(myVote[1])}${esc(myVote[2])}</span>` : '';
    const expand = open ? '<div class="expand">' + prChecks(pr) + prFiles(key, pr) + '</div>' : '';
    // Ready to merge: every required policy passed (incl. reviewer policies), no conflicts, not a draft.
    const ready = pr.checks?.state === 'ok' && !pr.isDraft && pr.mergeStatus !== 'conflicts';
    return `
      <article class="card pr ${open ? 'open' : ''} ${ready ? 'ready' : ''}" data-toggle="${esc(key)}" tabindex="0">
        <div class="card-row">
          ${avatar(pr.author, 'lg')}
          <div class="card-body">
            <div class="card-title">${pr.isDraft ? '<span class="tag draft">Draft</span>' : ''}${pr.mergeStatus === 'conflicts' ? '<span class="tag danger">Conflicts</span>' : ''}${esc(pr.title)}</div>
            <div class="meta">${projChip(pr.project)}<span class="mono">!${pr.id}</span><span class="sep"></span><span>${esc(pr.repoName)}</span><span class="sep"></span><span>${esc(pr.author.split(' ')[0])}</span><span class="sep"></span><span>${timeAgo(pr.created)}</span></div>
            <div class="branches">${branchName(pr.source)}${icon('arrow', 'arrow')}${branchName(pr.target)}</div>
            <div class="card-foot">
              <div class="reviewers">${reviewers}</div>
              ${checksPill(pr.checks)}
              ${myVotePill}
            </div>
          </div>
          <div class="card-actions">
            ${actionBtn('eye', 'Overview & review', 'azureDevOps.pr.openOverview', [pr.repoId, pr.id], 'accent')}
            ${actionBtn('branch', 'Checkout branch', 'azureDevOps.pr.checkout', [pr.repoId, pr.id])}
            ${actionBtn('external', 'Open in browser', 'azureDevOps.pr.openInBrowser', [pr.repoName, pr.id, pr.project])}
          </div>
        </div>
        ${expand}
      </article>`;
  }

  // ----- branch policies -----
  const CHECK = {
    fail: ['Failed', 'completed', 'failed'], expired: ['Expired', 'completed', 'partiallySucceeded'],
    running: ['Running', 'inProgress'], queued: ['Pending', 'notStarted'], ok: ['Passed', 'completed', 'succeeded'],
  };

  /** Collapsed card: just whether the required policies are green, red or still pending. */
  function checksPill(c) {
    if (!c || c.state === 'none') return '';
    if (c.state === 'fail') return `<span class="pill fail" title="Required checks failing">${icon('fail')}${c.failing} failing</span>`;
    if (c.state === 'pending') return `<span class="pill info" title="Required checks pending">${icon('clock')}${c.pending} pending</span>`;
    return `<span class="pill ok" title="All required checks passed">${icon('ok')}Checks</span>`;
  }

  /** Expanded card: every policy, failing first; build policies open their run. */
  function prChecks(pr) {
    const c = pr.checks;
    if (!c || !c.checks.length) return '';
    const SUMMARY = {
      fail: '<span class="checks-fail">' + c.failing + ' required failing</span>',
      pending: c.pending + ' required pending',
      ok: '<span class="all-reviewed">all required passed</span>',
    };
    const summary = SUMMARY[c.state] ? ' · ' + SUMMARY[c.state] : '';
    const row = (x) => {
      const [label, state, result] = CHECK[x.kind];
      const run = x.buildId ? ' data-cmd="azureDevOps.pipelines.openRun" data-args="' + attr([x.buildId, pr.project]) + '" title="Open run overview"' : '';
      return `<li class="file check check-${x.kind} ${x.buildId ? '' : 'static'}"${run}>${statusIcon(state, result)}
          <span class="file-name">${esc(x.name)}</span>${x.required ? '' : '<span class="tag">optional</span>'}
          <span class="grow"></span><span class="check-state">${label}</span></li>`;
    };
    return `<div class="files-head"><span>Checks${summary}</span></div><ul class="files checks">${c.checks.map(row).join('')}</ul>`;
  }

  function prFiles(key, pr) {
    const d = S.details.get(key);
    if (!d || d.loading) return '<div class="mini-loading"><span class="dot-pulse"></span>Loading changes…</div>';
    if (d.error) return `<div class="inline-error">${esc(d.error.message)}</div>`;
    const files = d.data.files;
    const done = files.filter((f) => f.reviewed).length;
    const LETTERS = [['add', 'A', 'add'], ['delete', 'D', 'del'], ['rename', 'R', 'ren']];
    const letter = (t) => (LETTERS.find(([k]) => t.includes(k)) || [null, 'M', 'mod']).slice(1);
    return `<div class="files-head"><span>${plural(files.length, 'file')} changed · <span class="${done === files.length ? 'all-reviewed' : ''}">${done}/${files.length} reviewed</span></span>
        <button class="link" data-cmd="azureDevOps.pr.openOverview" data-args="${attr([pr.repoId, pr.id])}">Open review ${icon('arrow')}</button></div>
      <ul class="files">${files.map((f) => {
        const [l, cls] = letter(f.changeType);
        const parts = f.path.split('/');
        const name = parts.pop();
        return `<li class="file ${f.reviewed ? 'reviewed' : ''}" data-cmd="azureDevOps.pr.openDiff" data-args="${attr([{ repoId: pr.repoId, prId: pr.id, iteration: d.data.iteration, change: f.change }])}" title="${esc(f.path)}">
          <button class="review-check" role="checkbox" aria-checked="${!!f.reviewed}" title="${f.reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}"
            data-act="reviewed" data-args="${attr({ repoId: pr.repoId, prId: pr.id, path: f.path, version: f.version, reviewed: !f.reviewed })}">${f.reviewed ? icon('check') : ''}</button>
          <span class="change ${cls}">${l}</span><span class="file-name">${esc(name)}</span><span class="file-dir">${esc(parts.join('/').slice(parts[0] === '' ? 1 : 0))}</span></li>`;
      }).join('')}</ul>`;
  }

  // ----- work items -----
  function wiCard(w) {
    const color = typeColor(w.type);
    const stateColor = w.stateColor || 'var(--muted)';
    return `
      <article class="card wi" style="--type:${color}" data-cmd="azureDevOps.wi.open" data-args="${attr([w.id])}" tabindex="0">
        <div class="card-row">
          <div class="card-body">
            <div class="meta top"><span class="type-dot"></span><span class="type">${esc(w.type)}</span><span class="mono">#${w.id}</span>${projChip(w.project)}
              ${w.priority ? `<span class="prio p${esc(w.priority)}">P${esc(w.priority)}</span>` : ''}</div>
            <div class="card-title">${esc(w.title)}</div>
            <div class="card-foot">
              <span class="state" style="--state:${esc(stateColor)}"><span class="state-dot"></span>${esc(w.state)}</span>
              ${wiExtras(w)}
              <span class="grow"></span>
              ${w.assignedTo ? avatar(w.assignedTo, 'sm') : '<span class="avatar sm empty" title="Unassigned">?</span>'}
            </div>
            ${w.tags.length ? '<div class="tags">' + w.tags.slice(0, 4).map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' : ''}
          </div>
          <div class="card-actions">
            ${actionBtn('swap', 'Change state', 'azureDevOps.wi.changeState', [w.id, w.type, w.project], 'accent')}
            ${actionBtn('user', 'Assign to me', 'azureDevOps.wi.assignToMe', [w.id])}
            ${actionBtn('comment', 'Add comment', 'azureDevOps.wi.comment', [w.id, w.project])}
            ${actionBtn('branch', 'Create branch', 'azureDevOps.wi.createBranch', [w.id])}
            ${actionBtn('external', 'Open in browser', 'azureDevOps.wi.openInBrowser', [w.id, w.project])}
          </div>
        </div>
      </article>`;
  }

  /** Iteration (outside the sprint tab), remaining hours and points of a work item card. */
  function wiExtras(w) {
    const parts = [];
    if (w.iteration && S.tab !== 'sprint') parts.push(`<span class="muted small">${esc(w.iteration)}</span>`);
    if (w.remaining) parts.push(`<span class="muted small" title="Remaining work">${esc(w.remaining)}h</span>`);
    if (w.points) parts.push(`<span class="points" title="Story points / effort">${esc(w.points)}</span>`);
    return parts.join('');
  }

  // ----- sprint -----
  const CATEGORY_ORDER = ['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed'];
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
  const hours = (n) => `${Math.round(n * 10) / 10}h`;

  /** Remaining work of one person against their capacity (when the team plans capacity). */
  function loadRow(p) {
    const hasCapacity = p.capacity !== undefined;
    const over = hasCapacity && p.remaining > p.capacity;
    const w = p.capacity ? Math.min(100, Math.round((p.remaining / p.capacity) * 100)) : 100;
    const of = hasCapacity ? ' of ' + hours(p.capacity) + ' capacity' : '';
    const total = hasCapacity ? ' / ' + hours(p.capacity) : '';
    return `<div class="load ${over ? 'over' : ''}" title="${esc(p.name)}: ${hours(p.remaining)} remaining${of}">
        ${avatar(p.name, 'sm')}<span class="load-name">${esc(p.name)}</span>
        <span class="load-bar"><span style="width:${w}%"></span></span>
        <span class="load-num">${hours(p.remaining)}${total}</span></div>`;
  }

  function sprintHeader(d) {
    const it = d.iteration;
    const items = d.items;
    const done = items.filter((i) => i.stateCategory === 'Completed').length;
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    const remaining = items.filter((i) => i.stateCategory !== 'Completed').reduce((s, i) => s + (i.remaining || 0), 0);
    const elapsed = d.daysTotal ? Math.round(((d.daysTotal - d.daysLeft) / d.daysTotal) * 100) : 0;
    const people = d.people.map(loadRow).join('');
    const left = it.timeFrame === 'past' ? 'finished' : plural(d.daysLeft, 'working day') + ' left';
    const rest = remaining ? '<span class="sep"></span><span>' + hours(remaining) + ' remaining</span>' : '';
    const openAttr = S.loadsOpen ? 'open' : '';
    const loads = people ? `<details class="loads" ${openAttr}><summary>Work by person</summary>${people}</details>` : '';
    return `<div class="sprint-head">
        <div class="sprint-title"><strong>${esc(it.name)}</strong><span class="muted small">${fmtDate(it.start)} – ${fmtDate(it.finish)}</span></div>
        <div class="meta"><span>${done}/${items.length} done</span><span class="sep"></span><span>${left}</span>${rest}</div>
        <div class="bar" title="${pct}% of the items done, ${elapsed}% of the sprint over"><span class="bar-done" style="width:${pct}%"></span><span class="bar-time" style="left:${elapsed}%"></span></div>
        ${loads}
      </div>`;
  }

  /** Groups of sprint items by person, by parent backlog item, or by state (in workflow order). */
  function sprintGroups(items) {
    const groups = new Map();
    const add = (key, label, item, extra) => {
      if (!groups.has(key)) groups.set(key, { label, items: [], ...extra });
      groups.get(key).items.push(item);
    };
    if (S.sprintGroup === 'person') {
      for (const i of items) add(i.assignedTo || '~', i.assignedTo || 'Unassigned', i);
      return [...groups.values()].sort((a, b) => (a.label === 'Unassigned') - (b.label === 'Unassigned') || a.label.localeCompare(b.label));
    }
    if (S.sprintGroup === 'parent') return groupByParent(items, groups, add);
    for (const i of items) add(i.state, i.state, i, { color: i.stateColor, order: CATEGORY_ORDER.indexOf(i.stateCategory) });
    const rank = (g) => (g.order < 0 ? 99 : g.order);
    return [...groups.values()].sort((a, b) => rank(a) - rank(b));
  }

  /** Parents that have children in the sprint head their group; other items go to "Other items". */
  function groupByParent(items, groups, add) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const parents = new Set(items.filter((i) => i.parent && byId.has(i.parent)).map((i) => i.parent));
    for (const i of items) {
      if (parents.has(i.id)) {
        if (groups.has(i.id)) groups.get(i.id).parentItem = i;
        else groups.set(i.id, { label: '', parentItem: i, items: [] });
      } else if (i.parent && byId.has(i.parent)) {
        add(i.parent, '', i);
      } else {
        add('~', 'Other items', i);
      }
    }
    return [...groups.values()];
  }

  function groupHead(g) {
    if (g.parentItem) {
      const p = g.parentItem;
      const done = g.items.filter((i) => i.stateCategory === 'Completed').length;
      return `<div class="group-head parent" data-cmd="azureDevOps.wi.open" data-args="${attr([p.id])}"><span class="type-dot" style="--type:${typeColor(p.type)}"></span>
            <span class="grow">#${p.id} ${esc(p.title)}</span><span class="state-dot" style="--state:${esc(p.stateColor || 'var(--muted)')}"></span><span class="count">${done}/${g.items.length}</span></div>`;
    }
    const dot = g.color ? '<span class="state-dot" style="--state:' + esc(g.color) + '"></span>' : '';
    return `<div class="group-head">${dot}<span class="grow">${esc(g.label)}</span><span class="count">${g.items.length}</span></div>`;
  }

  function sprintView(d) {
    if (!S.sprintTeam) return `<div class="empty">${icon('calendar')}<p>This project has no teams.</p></div>`;
    if (!d.iteration) return `<div class="empty">${icon('calendar')}<p>This team has no sprints yet.</p></div>`;
    const items = d.items.filter((i) => !S.search || haystack('wis', i).includes(S.search));
    const groups = sprintGroups(items);
    const body = groups.map((g) => `<section class="group">${groupHead(g)}${g.items.map(wiCard).join('')}</section>`).join('');
    return sprintHeader(d) + (body || emptyState('sprint'));
  }

  // ----- approvals -----
  function approvalCard(a) {
    const waiting = a.approvers.filter((x) => x.status === 'pending').map((x) => x.name);
    const open = a.runId ? 'data-cmd="azureDevOps.pipelines.openRun" data-args="' + attr([a.runId, a.project]) + '"' : '';
    const run = a.run ? ' <span class="mono muted">#' + esc(a.run) + '</span>' : '';
    const others = waiting.length > 2 ? ' +' + (waiting.length - 2) : '';
    const who = waiting.length ? `<span class="sep"></span><span title="${esc(waiting.join(', '))}">${esc(waiting.slice(0, 2).join(', '))}${others}</span>` : '';
    const instructions = a.instructions ? '<div class="instructions">' + esc(a.instructions) + '</div>' : '';
    return `
      <article class="card approval ${a.mine ? 'mine' : ''}" ${open} tabindex="0">
        <div class="card-row">
          <div class="build-status"><span class="status queued">${icon('hand')}</span></div>
          <div class="card-body">
            <div class="card-title">${esc(a.pipeline || 'Pipeline')}${run}</div>
            <div class="meta">${projChip(a.project)}<span>waiting ${timeAgo(a.created)}</span>${who}</div>
            ${instructions}
          </div>
          <div class="card-actions">
            ${actionBtn('check', 'Approve', 'azureDevOps.pipelines.approve', [a.id, 'approved', a.project], 'accent')}
            ${actionBtn('x', 'Reject', 'azureDevOps.pipelines.approve', [a.id, 'rejected', a.project], 'danger')}
          </div>
        </div>
      </article>`;
  }

  // ----- pipelines -----
  function buildCard(b, compact = false) {
    const running = isRunning(b);
    let time = timeAgo(b.finishTime || b.queueTime) + ' · ' + duration(b.startTime, b.finishTime);
    if (running) time = b.startTime ? 'running ' + duration(b.startTime) : 'queued';
    return `
      <article class="card build ${running ? 'is-running' : ''} r-${esc(b.result || b.status)}" data-cmd="azureDevOps.pipelines.openRun" data-args="${attr([b.id, b.project])}" title="Open run overview" tabindex="0">
        <div class="card-row">
          <div class="build-status">${statusIcon(b.status, b.result)}</div>
          <div class="card-body">
            <div class="card-title">${esc(b.definitionName)}</div>
            <div class="meta">${projChip(b.project)}<span class="mono">#${esc(b.number)}</span><span class="sep"></span><span>${esc(time)}</span></div>
            <div class="branches">${branchName(b.branch)}${b.requestedFor ? `<span class="grow"></span>${avatar(b.requestedFor, 'sm')}` : ''}</div>
          </div>
          <div class="card-actions">
            ${actionBtn('terminal', running ? 'Stream live logs' : 'Show logs', 'azureDevOps.pipelines.streamLogs', [b.id, `${b.definitionName} #${b.number}`, b.project], 'accent')}
            ${running ? actionBtn('stop', 'Cancel run', 'azureDevOps.pipelines.cancel', [b.id, b.project], 'danger')
              : actionBtn('rerun', 'Run again', 'azureDevOps.pipelines.rerun', [b.definitionId, b.branch, b.project])}
            ${actionBtn('external', 'Open in browser', 'azureDevOps.pipelines.openInBrowser', [b.id, b.project])}
          </div>
        </div>
        ${running ? '<div class="run-bar"></div>' : ''}
      </article>`;
  }

  // ----- pipeline folders -----
  const inFolder = (def, folder) => folder.every((seg, i) => def.folder[i] === seg);

  function folderView(defs) {
    const folder = S.folder;
    const below = defs.filter((d) => inFolder(d, folder));
    // A folder that no longer exists (deleted, other project) falls back to the root.
    if (folder.length && !below.length && defs.length) { S.folder = []; persist(); return folderView(defs); }
    const crumbs = [['All pipelines', []], ...folder.map((seg, i) => [seg, folder.slice(0, i + 1)])];
    const crumb = ([label, path], i) => {
      const home = i === 0 ? icon('home') : '';
      if (i === crumbs.length - 1) return `<span class="crumb current">${home}${esc(label)}</span>`;
      return `<button class="crumb" data-act="folder" data-args="${attr(path)}">${home}${esc(label)}</button>${icon('chevron', 'crumb-sep')}`;
    };
    const head = '<nav class="crumbs">' + crumbs.map(crumb).join('') + '</nav>';

    if (S.search) {
      const hits = below.filter((d) => haystack('pipelines', d).includes(S.search));
      return head + (hits.length ? hits.map(defCard).join('') : emptyState('pipelines'));
    }

    const subfolders = new Map();
    for (const d of below) {
      const seg = d.folder[folder.length];
      if (seg === undefined) continue;
      const f = subfolders.get(seg) || { name: seg, count: 0, failed: 0, running: 0 };
      f.count++;
      if (isRunning(d.latest)) f.running++;
      else if (d.latest?.result === 'failed') f.failed++;
      subfolders.set(seg, f);
    }
    const folders = [...subfolders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) => `
      <button class="folder-row" data-act="folder" data-args="${attr([...folder, f.name])}">
        ${icon('folder', 'folder-icon')}<span class="folder-name">${esc(f.name)}</span>
        ${f.running ? `<span class="folder-flag running" title="${f.running} running">${icon('spinner', 'spin')}${f.running}</span>` : ''}
        ${f.failed ? `<span class="folder-flag fail" title="${f.failed} failed">${icon('fail')}${f.failed}</span>` : ''}
        <span class="folder-count">${f.count}</span>${icon('chevron', 'folder-chevron')}
      </button>`).join('');
    const here = below.filter((d) => d.folder.length === folder.length);
    if (!folders && !here.length) return head + emptyState('pipelines');
    return head + (folders ? `<div class="folders">${folders}</div>` : '') + here.map(defCard).join('');
  }

  const runWhen = (r) => (isRunning(r) ? 'running' : timeAgo(r.finishTime || r.queueTime));

  function runRow(r, project) {
    return `
          <li class="run" data-cmd="azureDevOps.pipelines.openRun" data-args="${attr([r.id, project])}" title="Open run overview">
            ${statusIcon(r.status, r.result)}<span class="mono">#${esc(r.number)}</span>${branchName(r.branch)}
            <span class="grow"></span><span class="muted small">${esc(runWhen(r))}</span>
          </li>`;
  }

  /** Folder path and latest run of a pipeline. */
  function defMeta(def) {
    const l = def.latest;
    const path = def.path ? '<span>' + esc(def.path) + '</span>' : '';
    if (!l) return path + '<span>never run</span>';
    const sep = def.path ? '<span class="sep"></span>' : '';
    return `${path}${sep}<span class="mono">#${esc(l.number)}</span><span class="sep"></span><span>${esc(runWhen(l))}</span>`;
  }

  function defCard(def) {
    const key = `def:${def.id}:${def.project || ''}`;
    const open = S.expanded.has(key);
    const l = def.latest;
    const d = S.details.get(key);
    let runs = '';
    if (open) {
      if (!d || d.loading) runs = '<div class="mini-loading"><span class="dot-pulse"></span>Loading runs…</div>';
      else if (d.error) runs = `<div class="inline-error">${esc(d.error.message)}</div>`;
      else if (!d.data.length) runs = '<div class="muted small pad">No runs yet.</div>';
      else runs = '<ul class="runs">' + d.data.map((r) => runRow(r, def.project)).join('') + '</ul>';
    }
    const status = l ? statusIcon(l.status, l.result) : `<span class="status muted">${icon('rocket')}</span>`;
    return `
      <article class="card def ${open ? 'open' : ''}" data-toggle="${esc(key)}" tabindex="0">
        <div class="card-row">
          <div class="build-status">${status}</div>
          <div class="card-body">
            <div class="card-title">${esc(def.name)}</div>
            <div class="meta">${defMeta(def)}</div>
          </div>
          <div class="card-actions">
            ${actionBtn('play', 'Run pipeline', 'azureDevOps.pipelines.run', [def.id, def.project], 'accent')}
            ${actionBtn('external', 'Open in browser', 'azureDevOps.pipelines.openDefinition', [def.id, def.project])}
          </div>
        </div>
        ${open ? `<div class="expand">${runs}</div>` : ''}
      </article>`;
  }

  // ---------- interaction ----------
  function toggle(key) {
    if (S.expanded.has(key)) {
      S.expanded.delete(key);
      renderCard(key);
      return;
    }
    S.expanded.add(key);
    const [kind, a, b] = key.split(':');
    if (kind === 'pr') loadDetail(key, 'prFiles', { repoId: a, prId: Number(b) });
    else if (kind === 'def') loadDetail(key, 'definitionBuilds', { id: Number(a), project: b || undefined });
  }

  /** Clicks on elements with one of these data attributes, checked in this order. */
  const CLICKS = [
    ['project', (el) => selectProject(el.dataset.project)],
    ['cmd', (el, e) => {
      e.stopPropagation();
      command(el.dataset.cmd, ...(el.dataset.args ? JSON.parse(el.dataset.args) : []));
      if (el.classList.contains('icon-btn')) { el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 400); }
    }],
    ['tab', (el) => switchTab(el.dataset.tab)],
    ['filter', (el) => setFilter(el.dataset.filter, el.dataset.value)],
    ['act', (el) => ACTS[el.dataset.act]?.(el)],
    ['toggle', (el, e, target) => { if (!target.closest('.expand')) toggle(el.dataset.toggle); }],
  ];
  const ACTS = {
    applyProjects: () => applyProjects(),
    picker: () => { if (S.picker) closePicker(); else { openPicker(S.ctx.orgUrl); renderHeader(); } },
    folder: (el) => {
      S.folder = JSON.parse(el.dataset.args || '[]');
      persist();
      renderList();
      document.getElementById('list')?.scrollTo({ top: 0 });
    },
    reviewed: (el) => { rpc('setReviewed', JSON.parse(el.dataset.args || '{}')).catch(() => undefined); },
    refresh: () => refreshAll(),
  };

  function switchTab(tab) {
    S.tab = tab;
    persist();
    renderTabs();
    renderToolbar();
    renderList();
    if (!S.data[S.tab]) load(S.tab);
    else if (isStale(S.tab)) refreshVisible();
  }

  /** Grouping only re-renders; other filters load new data. */
  function setFilter(name, value) {
    S[name] = value;
    persist();
    renderToolbar();
    if (name === 'sprintGroup') { renderList(); return; }
    S.data[S.tab] = null;
    load(S.tab);
  }

  function toggleTick(name) {
    const m = S.picker.multi;
    S.picker.multi = m.includes(name) ? m.filter((x) => x !== name) : [...m, name];
    renderPickerList();
  }

  app.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (S.picker && !target.closest('#picker,[data-act="picker"]')) closePicker();
    const tick = target.closest('[data-tick]');
    if (tick instanceof HTMLElement && S.picker) {
      e.stopPropagation();
      toggleTick(tick.dataset.tick || '');
      return;
    }
    const el = target.closest('[data-cmd],[data-tab],[data-filter],[data-act],[data-toggle],[data-project]');
    if (!(el instanceof HTMLElement)) return;
    const hit = CLICKS.find(([key]) => el.dataset[key] !== undefined);
    hit?.[1](el, e, target);
  });

  app.addEventListener('toggle', (e) => {
    const t = e.target;
    if (t instanceof HTMLDetailsElement && t.classList.contains('loads')) S.loadsOpen = t.open;
  }, true);

  app.addEventListener('keydown', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if (e.key === 'Escape' && S.picker) { closePicker(); return; }
    if (e.key === 'Enter' && el.dataset.project !== undefined) { e.preventDefault(); selectProject(el.dataset.project); return; }
    if ((e.key === 'Enter' || e.key === ' ') && el.classList.contains('card')) {
      e.preventDefault();
      el.click();
    }
  });

  function refreshAll() {
    S.details.clear();
    const reopen = [...S.expanded];
    S.expanded.clear();
    rpc('context').then((ctx) => {
      const changed = !S.ctx || ctx.configured !== S.ctx.configured || ctx.project !== S.ctx.project || ctx.orgUrl !== S.ctx.orgUrl
        || (ctx.projects || []).join('\n') !== (S.ctx.projects || []).join('\n');
      S.ctx = ctx;
      if (changed) { S.data = {}; S.counts = {}; S.queries = null; S.teams = null; S.picker = null; init(); return; }
      for (const key of reopen) toggle(key);
      for (const t of TABS) if (t.id === S.tab || t.id !== 'sprint' || S.data.sprint) load(t.id, t.id !== S.tab);
    });
  }

  /** Re-arms after every run so interval changes in the settings apply without a reload. */
  function every(seconds, fn) {
    setTimeout(() => {
      if (S.ctx?.configured && !document.hidden) fn();
      every(seconds, fn);
    }, 1000 * seconds());
  }

  // Keep running pipelines fresh.
  every(() => Math.max(5, S.ctx?.refreshInterval || 10), () => {
    if (S.tab !== 'pipelines') return;
    const items = S.data.pipelines || [];
    if (!items.some((i) => isRunning(i) || isRunning(i.latest))) return;
    load('pipelines', true);
    for (const key of S.expanded) {
      const [kind, id, project] = key.split(':');
      if (kind === 'def') loadDetail(key, 'definitionBuilds', { id: Number(id), project: project || undefined }, true);
    }
  });

  // Background refresh (azureDevOps.refreshInterval, 0 = off): only the visible tab, only while the window has focus.
  // Other tabs catch up when opened, and the visible one when the window regains focus. Open cards stay open.
  const autoInterval = () => (S.ctx?.autoRefreshInterval > 0 ? Math.max(10, S.ctx.autoRefreshInterval) : 0);
  const isStale = (tab) => autoInterval() > 0 && Date.now() - (S.loadedAt[tab] || 0) >= autoInterval() * 1000;

  function refreshVisible() {
    if (!S.ctx?.configured) return;
    load(S.tab, true);
    for (const key of S.expanded) {
      const [kind, a, b] = key.split(':');
      if (kind === 'pr' && S.tab === 'prs') loadDetail(key, 'prFiles', { repoId: a, prId: Number(b) }, true);
      else if (kind === 'def' && S.tab === 'pipelines') loadDetail(key, 'definitionBuilds', { id: Number(a), project: b || undefined }, true);
    }
  }

  every(() => 5, () => {
    if (S.focused && isStale(S.tab)) refreshVisible();
  });

  window.addEventListener('resize', () => {
    const tabs = document.getElementById('tabs');
    if (tabs) placeIndicator(tabs);
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'rpc') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(m.error); else p.resolve(m.result);
    } else if (m.type === 'focus') {
      S.focused = m.focused;
      if (S.focused && !document.hidden && isStale(S.tab)) refreshVisible();
    } else if (m.type === 'refresh') {
      refreshAll();
    } else if (m.type === 'reviewed') {
      // Keep check marks in sync, whether toggled here or from the diff editor.
      const d = S.details.get(`pr:${m.repoId}:${m.prId}`);
      const f = d?.data?.files?.find((x) => x.path === m.path && x.version === m.version);
      if (f) { f.reviewed = m.reviewed; renderCard(`pr:${m.repoId}:${m.prId}`); }
    }
  });

  init().catch((e) => { app.innerHTML = errorState(e); });
})();

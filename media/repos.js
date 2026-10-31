// @ts-check
/* Branches of a repository with ahead/behind counts and actions. Long lists render in pages of PAGE rows. */
(function () {
  /* global vscode */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const PAGE = 300;
  const saved = vscode.getState() || {};
  let state = { repoId: saved.repoId, base: '', branches: [], current: undefined, cloned: false };
  let filter = '';
  let shown = PAGE;

  function ago(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  /** Ahead/behind as two bars around the middle, like the web UI. */
  function aheadBehind(b, max) {
    if (b.isBase) return '<span class="pill info">default</span>';
    // At least a sliver for any non-zero count, so small differences stay visible.
    const w = (n) => {
      if (!max || !n) return 0;
      return Math.max(4, Math.round((n / max) * 100));
    };
    return `<span class="ab" title="${b.behind} behind, ${b.ahead} ahead of ${esc(state.base)}">
      <span class="ab-num">${b.behind}</span><span class="ab-bar behind"><span style="width:${w(b.behind)}%"></span></span>
      <span class="ab-bar ahead"><span style="width:${w(b.ahead)}%"></span></span><span class="ab-num">${b.ahead}</span></span>`;
  }

  function row(b, max) {
    const isCurrent = b.name === state.current;
    return `<div class="branch-row${isCurrent ? ' current' : ''}">
      <div class="branch-main"><span class="branch">${esc(b.name)}</span>${isCurrent ? '<span class="pill ok">checked out</span>' : ''}
        <div class="muted small" title="${esc(b.message)}"><span class="mono">${esc(b.commit)}</span> ${esc(b.message)} · ${esc(b.author || '')} ${ago(b.date)}</div></div>
      ${aheadBehind(b, max)}
      <div class="branch-actions">
        ${b.isBase ? '' : `<button class="btn ghost small" data-act="compare" data-branch="${esc(b.name)}" title="Files changed compared with ${esc(state.base)}">Compare</button>
          <button class="btn ghost small" data-act="pr" data-branch="${esc(b.name)}">Create PR</button>`}
        ${state.cloned && !isCurrent ? `<button class="btn ghost small" data-act="checkout" data-branch="${esc(b.name)}">Checkout</button>` : ''}
        <button class="btn ghost small" data-act="create" data-from="${esc(b.name)}" title="New branch from ${esc(b.name)}">Branch from</button>
        ${b.isBase ? '' : `<button class="btn ghost small danger" data-act="delete" data-branch="${esc(b.name)}" title="Delete on the server">Delete</button>`}
      </div></div>`;
  }

  /** The filtered branches on screen and the scale of their ahead/behind bars. */
  let view = { list: [], max: 1 };

  function moreButton() {
    const rest = view.list.length - shown;
    return rest > 0 ? `<button class="btn ghost more" data-act="more">Show ${Math.min(PAGE, rest)} more of ${rest}</button>` : '';
  }

  function render() {
    const q = filter.toLowerCase();
    const list = q ? state.branches.filter((b) => b.name.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q)) : state.branches;
    view = { list, max: Math.max(1, ...list.map((b) => Math.max(b.ahead, b.behind))) };
    const count = state.branches.length;
    const base = state.base ? ' · compared with ' + state.base : '';
    $('subtitle').textContent = `${count} ${count === 1 ? 'branch' : 'branches'}${base}`;
    const emptyText = count ? 'No branch matches the filter.' : 'This repository has no branches yet.';
    const empty = list.length ? '' : `<p class="muted pad">${emptyText}</p>`;
    $('list').innerHTML = list.slice(0, shown).map((b) => row(b, view.max)).join('') + moreButton() + empty;
    $('clone').hidden = state.cloned;
  }

  /** The next page goes below the rows already shown instead of rendering the whole list again. */
  function showMore() {
    const from = shown;
    shown += PAGE;
    const list = $('list');
    list.querySelector('.more')?.remove();
    list.insertAdjacentHTML('beforeend', view.list.slice(from, shown).map((b) => row(b, view.max)).join('') + moreButton());
  }

  $('repo').addEventListener('change', (e) => {
    state.repoId = /** @type {HTMLSelectElement} */ (e.target).value;
    vscode.setState({ repoId: state.repoId });
    vscode.postMessage({ type: 'repo', repoId: state.repoId });
  });
  let t = 0;
  $('filter').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      const next = /** @type {HTMLInputElement} */ (e.target).value.trim();
      if (next === filter) return; // only spaces were typed
      filter = next;
      shown = PAGE;
      requestAnimationFrame(render);
    }, 120);
  });
  document.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-act]'));
    if (!el) return;
    if (el.dataset.act === 'more') { showMore(); return; }
    vscode.postMessage({ type: el.dataset.act, branch: el.dataset.branch, from: el.dataset.from });
  });

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'repos') {
      $('repo').innerHTML = m.repos.map((r) => `<option value="${esc(r.id)}" ${r.id === m.selected ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
      state.repoId = m.selected;
    } else if (m.type === 'loading') {
      $('error').hidden = true;
      $('list').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    } else if (m.type === 'branches') {
      state = { ...state, ...m };
      shown = PAGE;
      render();
    } else if (m.type === 'error') {
      $('error').textContent = m.message;
      $('error').hidden = false;
      $('list').innerHTML = '';
    }
  });
  vscode.postMessage({ type: 'ready', repoId: state.repoId });
})();

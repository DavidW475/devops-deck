import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { AdoError } from './client';

const svg = (paths: string) =>
  `<svg class="i" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Icon-only toolbar buttons shared by the editor panels (Lucide icons, ISC license). */
export const TOOLBAR_ICONS = {
  refresh: svg('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
  browser: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
};

/** Refresh and "open in browser" as compact icon buttons with tooltips. */
export function viewButtonsHtml(): string {
  return `<button class="btn ghost icon-only" data-action="browser" title="Open in browser" aria-label="Open in browser">${TOOLBAR_ICONS.browser}</button>
    <button class="btn ghost icon-only" data-action="refresh" title="Refresh" aria-label="Refresh">${TOOLBAR_ICONS.refresh}</button>`;
}

/** "1 file", "3 files". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function shortRef(ref?: string): string {
  return (ref ?? '').replace(/^refs\/heads\//, '');
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function nonce(): string {
  return randomBytes(16).toString('base64');
}

export function timeAgo(iso?: string | null): string {
  if (!iso) {
    return '';
  }
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) { return 'just now'; }
  if (sec < 3600) { return `${Math.floor(sec / 60)}m ago`; }
  if (sec < 86400) { return `${Math.floor(sec / 3600)}h ago`; }
  if (sec < 86400 * 30) { return `${Math.floor(sec / 86400)}d ago`; }
  return new Date(iso).toLocaleDateString();
}

export function duration(start?: string | null, end?: string | null): string {
  if (!start) {
    return '';
  }
  const sec = Math.max(0, Math.round(((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 1000));
  if (sec < 60) { return `${sec}s`; }
  if (sec < 3600) { return `${Math.floor(sec / 60)}m ${sec % 60}s`; }
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export const VOTE_LABELS: Record<string, string> = {
  '10': 'Approved',
  '5': 'Approved with suggestions',
  '0': 'No vote',
  '-5': 'Waiting for author',
  '-10': 'Rejected',
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function showError(e: unknown): Promise<void> {
  if (e instanceof AdoError && e.isAuthError) {
    const choice = await vscode.window.showErrorMessage(`DevOps Deck: ${e.message}`, 'Sign In', 'Use PAT');
    if (choice === 'Sign In') {
      await vscode.commands.executeCommand('azureDevOps.signIn');
    } else if (choice === 'Use PAT') {
      await vscode.commands.executeCommand('azureDevOps.setPat');
    }
    return;
  }
  void vscode.window.showErrorMessage(`DevOps Deck: ${errorMessage(e)}`);
}

/** Wrap a command handler so failures surface as notifications. */
export function guarded<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      await showError(e);
    }
  };
}

export async function renderMarkdown(text: string): Promise<string> {
  try {
    // Markdown may contain raw HTML written by anyone in the project.
    return sanitizeHtml(await vscode.commands.executeCommand<string>('markdown.api.render', text) ?? '');
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

/** Shared HTML shell for editor panels; CSP blocks any script without our nonce (e.g. inside work item HTML). */
export function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, body: string, script: string, scriptFile?: string): string {
  const n = nonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
  const file = scriptFile ? `<script nonce="${n}" src="${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', scriptFile))}"></script>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"><title>${escapeHtml(title)}</title></head>
<body>${body}<script nonce="${n}">const vscode = acquireVsCodeApi();${script}</script>${file}</body></html>`;
}

export function initials(name?: string): string {
  const parts = (name ?? '?').replace(/[[\]()]/g, '').split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function avatarHue(name?: string): number {
  let h = 0;
  for (const ch of name ?? '') {
    h = (h * 31 + ch.charCodeAt(0)) % 360;
  }
  return h;
}

export function avatarHtml(name?: string, size = 28): string {
  return `<span class="avatar" style="--hue:${avatarHue(name)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px" title="${escapeHtml(name)}">${escapeHtml(initials(name))}</span>`;
}

export interface LinkCandidate {
  /** opaque value sent back with the 'link' message */
  key: string;
  title: string;
  sub?: string;
}

/**
 * Search box of a panel's link picker; results come from the extension via a 'linkResults' message.
 * `picker` names the box when a page has several (e.g. 'link' and 'reviewer').
 */
export function linkPickerHtml(placeholder: string, picker = 'link'): string {
  return `<div class="linker" data-picker="${escapeHtml(picker)}"><input class="linker-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false">
    <ul class="linker-results" hidden></ul></div>`;
}

/**
 * Script for linkPickerHtml boxes and [data-unlink] buttons. Posts 'linkSearch' {text, seq, picker} (debounced),
 * 'link' {key, picker} and 'unlink' {key}; expects 'linkResults' {seq, picker, items: LinkCandidate[]} back.
 */
export const LINK_PICKER_SCRIPT = `
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const boxes = new Map();
  for (const box of document.querySelectorAll('.linker')) {
    if (box.closest('.md')) continue;
    const input = box.querySelector('.linker-input');
    const list = box.querySelector('.linker-results');
    const picker = box.dataset.picker || 'link';
    const st = { input, list, seq: 0, open: false, timer: 0 };
    boxes.set(picker, st);
    const search = () => { clearTimeout(st.timer); st.timer = setTimeout(() => { list.hidden = false; st.open = true; list.innerHTML = '<li class="linker-note">Searching…</li>'; vscode.postMessage({ type: 'linkSearch', text: input.value, seq: ++st.seq, picker }); }, 200); };
    input.addEventListener('focus', search);
    input.addEventListener('input', search);
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { list.hidden = true; st.open = false; input.blur(); }
      if (e.key === 'Enter') { e.preventDefault(); list.querySelector('[data-link]')?.click(); }
    });
    document.addEventListener('click', e => { if (st.open && !box.contains(e.target)) { list.hidden = true; st.open = false; } });
    list.addEventListener('click', e => {
      const li = e.target.closest('[data-link]');
      if (!li) return;
      vscode.postMessage({ type: 'link', key: li.dataset.link, picker });
      list.innerHTML = '<li class="linker-note">Adding…</li>';
      input.disabled = true;
    });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-unlink]');
    if (!b || b.closest('.md')) return;
    e.stopPropagation();
    b.classList.add('busy');
    vscode.postMessage({ type: 'unlink', key: b.dataset.unlink });
  }, true);
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type !== 'linkResults') return;
    const st = boxes.get(m.picker || 'link');
    if (!st || m.seq !== st.seq || !st.open) return;
    st.list.innerHTML = m.error ? '<li class="linker-note bad">' + esc(m.error) + '</li>'
      : m.items.length ? m.items.map(i => '<li data-link="' + esc(i.key) + '"><span class="linker-title">' + esc(i.title) + '</span>' + (i.sub ? '<span class="muted">' + esc(i.sub) + '</span>' : '') + '</li>').join('')
      : '<li class="linker-note">Nothing found.</li>';
  });
})();
`;

/** Runs `fn` over the items with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- HTML sanitizing ----------

const ALLOWED_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small',
  'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var']);
/** Removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'noscript', 'noembed',
  'textarea', 'title', 'svg', 'math', 'select', 'option', 'xmp', 'plaintext', 'noframes', 'head']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'col']);
const ALLOWED_ATTRS: Record<string, string[]> = {
  '*': ['title', 'align', 'class', 'dir', 'lang'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start'],
  input: ['type', 'checked', 'disabled'],
  font: ['color'],
  details: ['open'],
};

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return named[e.toLowerCase()] ?? m;
  });
}

/** Characters browsers ignore inside URLs (controls, spaces, NBSP), which could hide a "javascript:" scheme. */
function compactUrl(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c > 0x20 && (c < 0x7f || c > 0xa0)) {
      out += ch;
    }
  }
  return out.toLowerCase();
}

function safeUrl(value: string, attr: string): string | undefined {
  const v = compactUrl(decodeEntities(value));
  const scheme = /^[a-z][a-z0-9+.-]*:/.exec(v)?.[0];
  if (!scheme || scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
    return value;
  }
  return attr === 'src' && /^data:image\/(png|gif|jpe?g|webp);/.test(v) ? value : undefined;
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** Attribute names (lower case) and raw values of a tag, read with a simple scanner. */
function parseAttrs(raw: string): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && (isSpace(raw[i]) || raw[i] === '/')) {
      i++;
    }
    let j = i;
    while (j < raw.length && !isSpace(raw[j]) && raw[j] !== '=' && raw[j] !== '/') {
      j++;
    }
    if (j === i) {
      i++;
      continue;
    }
    const name = raw.slice(i, j).toLowerCase();
    const [value, next] = readAttrValue(raw, j);
    out.push([name, value]);
    i = next;
  }
  return out;
}

/** The value after an attribute name (quoted, unquoted or none) and the position after it. */
function readAttrValue(raw: string, from: number): [string, number] {
  let i = from;
  while (isSpace(raw[i])) {
    i++;
  }
  if (raw[i] !== '=') {
    return ['', from];
  }
  i++;
  while (isSpace(raw[i])) {
    i++;
  }
  const q = raw[i];
  if (q === '"' || q === "'") {
    const end = raw.indexOf(q, i + 1);
    return end < 0 ? [raw.slice(i + 1), raw.length] : [raw.slice(i + 1, end), end + 1];
  }
  let end = i;
  while (end < raw.length && !isSpace(raw[end])) {
    end++;
  }
  return [raw.slice(i, end), end];
}

function sanitizeAttrs(tag: string, raw: string): string {
  const allowed = new Set([...ALLOWED_ATTRS['*'], ...(ALLOWED_ATTRS[tag] ?? [])]);
  const out: string[] = [];
  for (const [name, rawValue] of parseAttrs(raw)) {
    if (!allowed.has(name)) {
      continue;
    }
    let value = decodeEntities(rawValue);
    if (name === 'href' || name === 'src') {
      const url = safeUrl(value, name);
      if (url === undefined) {
        continue;
      }
      value = url;
    }
    if (tag === 'input' && name === 'type' && value.toLowerCase() !== 'checkbox') {
      return '';
    }
    out.push(` ${name}="${escapeHtml(value)}"`);
  }
  if (tag === 'input') {
    return out.some(a => a.startsWith(' type=')) ? out.filter(a => !a.startsWith(' disabled')).join('') + ' disabled' : '';
  }
  if (tag === 'a') {
    out.push(' rel="noreferrer noopener"');
  }
  return out.join('');
}

/** Index of the ">" that ends a tag, skipping quoted attribute values; -1 when the tag is not closed. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      quote = ch === quote ? '' : quote;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

const TAG_NAME = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/;

/**
 * Position after "</name ...>". Without a closing tag only the opening tag is dropped (its content stays as
 * escaped text), so an unclosed tag does not swallow the rest of a description.
 */
function afterClosingTag(html: string, lower: string, name: string, from: number): number {
  const close = lower.indexOf(`</${name}`, from);
  const end = close < 0 ? -1 : html.indexOf('>', close);
  return end < 0 ? from : end + 1;
}

/** Comments, doctypes and processing instructions are dropped: the position after them, else undefined. */
function skipSpecial(html: string, lt: number): number | undefined {
  let close: string | undefined;
  if (html.startsWith('<!--', lt)) {
    close = '-->';
  } else if (html[lt + 1] === '!' || html[lt + 1] === '?') {
    close = '>';
  }
  if (!close) {
    return undefined;
  }
  const end = html.indexOf(close, lt + 2);
  return end < 0 ? html.length : end + close.length;
}

/** Output for the markup at `lt` (a "<") and where to continue. */
function sanitizeTag(html: string, lower: string, lt: number): { html: string; next: number } {
  const special = skipSpecial(html, lt);
  if (special !== undefined) {
    return { html: '', next: special };
  }
  const m = TAG_NAME.exec(html.slice(lt + 1, lt + 65));
  const end = m ? tagEnd(html, lt + 1 + m[0].length) : -1;
  if (!m || end < 0) {
    return { html: '&lt;', next: lt + 1 }; // a stray or unterminated "<" is text
  }
  const name = m[1].toLowerCase();
  const closing = m[0].startsWith('/');
  if (DROP_WITH_CONTENT.has(name)) {
    const selfClosed = html[end - 1] === '/';
    return { html: '', next: closing || selfClosed ? end + 1 : afterClosingTag(html, lower, name, end + 1) };
  }
  if (!ALLOWED_TAGS.has(name)) {
    return { html: '', next: end + 1 };
  }
  if (closing) {
    return { html: VOID_TAGS.has(name) ? '' : `</${name}>`, next: end + 1 };
  }
  const attrs = sanitizeAttrs(name, html.slice(lt + 1 + m[0].length, end));
  return { html: name === 'input' && !attrs ? '' : `<${name}${attrs}>`, next: end + 1 };
}

/**
 * Allowlist HTML sanitizer for content written by other users (work item descriptions, comments, rendered
 * Markdown). Keeps formatting, drops scripts, event handlers, styles, forms, ids and non-http(s) links.
 * A linear scanner, so large descriptions stay fast.
 */
export function sanitizeHtml(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let pos = 0;
  for (let lt = html.indexOf('<'); lt >= 0; lt = html.indexOf('<', pos)) {
    out += html.slice(pos, lt);
    const tag = sanitizeTag(html, lower, lt);
    out += tag.html;
    pos = tag.next;
  }
  return out + html.slice(pos);
}

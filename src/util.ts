import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { AdoError } from './client';

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
    return await vscode.commands.executeCommand<string>('markdown.api.render', text);
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

/** Shared HTML shell for editor panels; CSP blocks any script without our nonce (e.g. inside work item HTML). */
export function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, body: string, script: string): string {
  const n = nonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"><title>${escapeHtml(title)}</title></head>
<body>${body}<script nonce="${n}">const vscode = acquireVsCodeApi();${script}</script></body></html>`;
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

/** Search box of a panel's link picker; results come from the extension via a 'linkResults' message. */
export function linkPickerHtml(placeholder: string): string {
  return `<div class="linker"><input class="linker-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false">
    <ul class="linker-results" hidden></ul></div>`;
}

/**
 * Script for linkPickerHtml and [data-unlink] buttons. Posts 'linkSearch' {text} (debounced),
 * 'link' {key} and 'unlink' {key}; expects 'linkResults' {items: LinkCandidate[]} back.
 */
export const LINK_PICKER_SCRIPT = `
(() => {
  const input = document.querySelector('.linker-input');
  const list = document.querySelector('.linker-results');
  if (!input || !list) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  let timer, seq = 0, open = false;
  const search = () => { clearTimeout(timer); timer = setTimeout(() => { list.hidden = false; open = true; list.innerHTML = '<li class="linker-note">Searching…</li>'; vscode.postMessage({ type: 'linkSearch', text: input.value, seq: ++seq }); }, 200); };
  input.addEventListener('focus', search);
  input.addEventListener('input', search);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { list.hidden = true; open = false; input.blur(); }
    if (e.key === 'Enter') { e.preventDefault(); list.querySelector('[data-link]')?.click(); }
  });
  document.addEventListener('click', e => { if (open && !e.target.closest('.linker')) { list.hidden = true; open = false; } });
  list.addEventListener('click', e => {
    const li = e.target.closest('[data-link]');
    if (!li) return;
    vscode.postMessage({ type: 'link', key: li.dataset.link });
    list.innerHTML = '<li class="linker-note">Linking…</li>';
    input.disabled = true;
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-unlink]');
    if (!b || b.closest('.md')) return;
    e.stopPropagation();
    b.classList.add('busy');
    vscode.postMessage({ type: 'unlink', key: b.dataset.unlink });
  }, true);
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type !== 'linkResults' || m.seq !== seq || !open) return;
    list.innerHTML = m.error ? '<li class="linker-note bad">' + esc(m.error) + '</li>'
      : m.items.length ? m.items.map(i => '<li data-link="' + esc(i.key) + '"><span class="linker-title">' + esc(i.title) + '</span>' + (i.sub ? '<span class="muted">' + esc(i.sub) + '</span>' : '') + '</li>').join('')
      : '<li class="linker-note">Nothing found.</li>';
  });
})();
`;

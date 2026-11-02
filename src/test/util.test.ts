import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdoError } from '../client';
import { changeVersion } from '../pullRequests/reviewed';
import { duration, errorMessage, escapeHtml, initials, mapLimit, mdEscape, sanitizeHtml, shortRef, timeAgo } from '../util';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('util', () => {
  it('shortRef strips refs/heads/ only', () => {
    assert.equal(shortRef('refs/heads/feature/x'), 'feature/x');
    assert.equal(shortRef('refs/pull/12/merge'), 'refs/pull/12/merge');
    assert.equal(shortRef(), '');
  });

  it('mdEscape escapes theme icons, command links and HTML', () => {
    assert.equal(mdEscape('$(sync)'), '\\$\\(sync\\)');
    assert.ok(!mdEscape('[x](command:evil)').includes('](command:'));
    assert.equal(mdEscape('[x](command:evil)'), '\\[x\\]\\(command:evil\\)');
    assert.equal(mdEscape('<script>'), '\\<script\\>');
    assert.equal(mdEscape('plain text'), 'plain text');
  });

  it('escapeHtml escapes all HTML-significant characters', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    assert.equal(escapeHtml(null), '');
  });

  it('timeAgo buckets', () => {
    assert.equal(timeAgo(), '');
    assert.equal(timeAgo(minutesAgo(0.2)), 'just now');
    assert.equal(timeAgo(minutesAgo(5)), '5m ago');
    assert.equal(timeAgo(minutesAgo(180)), '3h ago');
    assert.equal(timeAgo(minutesAgo(60 * 24 * 2)), '2d ago');
  });

  it('duration formats seconds, minutes and hours', () => {
    const t0 = '2026-01-01T10:00:00Z';
    assert.equal(duration(), '');
    assert.equal(duration(t0, '2026-01-01T10:00:42Z'), '42s');
    assert.equal(duration(t0, '2026-01-01T10:03:05Z'), '3m 5s');
    assert.equal(duration(t0, '2026-01-01T12:15:00Z'), '2h 15m');
    assert.equal(duration('2026-01-01T10:00:10Z', t0), '0s', 'never negative');
  });

  it('initials use first and last name part', () => {
    assert.equal(initials('Lena Hoffmann'), 'LH');
    assert.equal(initials('[Fabrikam]\\Backend Team'), 'FT');
    assert.equal(initials('priya'), 'P');
    assert.equal(initials(), '?');
  });

  it('errorMessage handles errors and other values', () => {
    assert.equal(errorMessage(new AdoError('boom', 500)), 'boom');
    assert.equal(errorMessage('plain'), 'plain');
  });

  it('changeVersion is the object id, or "deleted" for deletions', () => {
    assert.equal(changeVersion({ changeType: 'edit', item: { objectId: 'abc' } }), 'abc');
    assert.equal(changeVersion({ changeType: 'delete, sourceRename', item: { objectId: 'abc' } }), 'deleted');
  });
});

describe('sanitizeHtml', () => {
  it('keeps formatting and safe links', () => {
    assert.equal(sanitizeHtml('<p>Hi <b>there</b><br/><a href="https://contoso.com/a?b=1&amp;c=2">x</a></p>'),
      '<p>Hi <b>there</b><br><a href="https://contoso.com/a?b=1&amp;c=2" rel="noreferrer noopener">x</a></p>');
  });

  it('drops scripts, styles, handlers, ids and dangerous URLs', () => {
    assert.equal(sanitizeHtml('a<script>alert(1)</script>b<style>body{}</style>c'), 'abc');
    assert.equal(sanitizeHtml('<img src=x onerror="alert(1)" id="state" style="position:fixed">'), '<img src="x">');
    assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a rel="noreferrer noopener">x</a>');
    assert.equal(sanitizeHtml('<a href="java&#115;cript&colon;alert(1)">x</a>'), '<a rel="noreferrer noopener">x</a>');
    assert.equal(sanitizeHtml('<a href=" JaVaScRiPt:alert(1)">x</a>'), '<a rel="noreferrer noopener">x</a>');
    assert.equal(sanitizeHtml('<form action="https://evil"><button data-action="abandon">go</button></form>'), 'go');
    assert.equal(sanitizeHtml('<svg><script>x</script></svg>ok'), 'ok');
    assert.equal(sanitizeHtml('<meta http-equiv="refresh" content="0;url=https://evil">'), '');
  });

  it('escapes stray and unterminated tags', () => {
    assert.equal(sanitizeHtml('1 < 2 and <script src=x'), '1 &lt; 2 and &lt;script src=x');
    assert.equal(sanitizeHtml('<!-- c --><p>x</p>'), '<p>x</p>');
  });

  it('does not lose text after unclosed or self-closed dropped tags, and decodes links once', () => {
    assert.equal(sanitizeHtml('<p>a<svg/>b</p>'), '<p>ab</p>');
    assert.equal(sanitizeHtml('<option>x<p>after</p>'), 'x<p>after</p>');
    assert.equal(sanitizeHtml('<a href="https://x/?q=&amp;lt;b">l</a>'), '<a href="https://x/?q=&amp;lt;b" rel="noreferrer noopener">l</a>');
  });

  it('keeps disabled task list checkboxes only', () => {
    assert.equal(sanitizeHtml('<input type="checkbox" checked>'), '<input type="checkbox" checked="" disabled>');
    assert.equal(sanitizeHtml('<input type="text" value="x">'), '');
  });

  it('allows data images but no other data URLs', () => {
    assert.equal(sanitizeHtml('<img src="data:image/png;base64,AAA=">'), '<img src="data:image/png;base64,AAA=">');
    assert.equal(sanitizeHtml('<img src="data:text/html;base64,AAA=">'), '<img>');
  });
});

describe('mapLimit', () => {
  it('keeps order and limits concurrency', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async n => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, n));
      running--;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
  });
});

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdoError } from '../client';
import { changeVersion } from '../pullRequests/reviewed';
import { duration, errorMessage, escapeHtml, initials, shortRef, timeAgo } from '../util';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('util', () => {
  it('shortRef strips refs/heads/ only', () => {
    assert.equal(shortRef('refs/heads/feature/x'), 'feature/x');
    assert.equal(shortRef('refs/pull/12/merge'), 'refs/pull/12/merge');
    assert.equal(shortRef(undefined), '');
  });

  it('escapeHtml escapes all HTML-significant characters', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    assert.equal(escapeHtml(null), '');
  });

  it('timeAgo buckets', () => {
    assert.equal(timeAgo(undefined), '');
    assert.equal(timeAgo(minutesAgo(0.2)), 'just now');
    assert.equal(timeAgo(minutesAgo(5)), '5m ago');
    assert.equal(timeAgo(minutesAgo(180)), '3h ago');
    assert.equal(timeAgo(minutesAgo(60 * 24 * 2)), '2d ago');
  });

  it('duration formats seconds, minutes and hours', () => {
    const t0 = '2026-01-01T10:00:00Z';
    assert.equal(duration(undefined), '');
    assert.equal(duration(t0, '2026-01-01T10:00:42Z'), '42s');
    assert.equal(duration(t0, '2026-01-01T10:03:05Z'), '3m 5s');
    assert.equal(duration(t0, '2026-01-01T12:15:00Z'), '2h 15m');
    assert.equal(duration('2026-01-01T10:00:10Z', t0), '0s', 'never negative');
  });

  it('initials use first and last name part', () => {
    assert.equal(initials('Lena Hoffmann'), 'LH');
    assert.equal(initials('[Fabrikam]\\Backend Team'), 'FT');
    assert.equal(initials('priya'), 'P');
    assert.equal(initials(undefined), '?');
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

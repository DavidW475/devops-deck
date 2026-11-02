import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOVER_COMMANDS, annotationText, cleanText, hoverMarkdown, mergeWorkItems, pickPullRequest, prIdFromMessage, relativeAge, shortSha, stateMessage, traceRows,
} from '../blame/blameModel';
import type { CommitLine, HoverData, PrMatch, TraceData } from '../blame/blameTypes';
import type { PullRequest, WorkItem } from '../types';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const REPO_ID = '11111111-2222-3333-4444-555555555555';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const pr = (id: number, status: string, closedDate?: string, title = `PR ${id}`): PullRequest =>
  ({
    pullRequestId: id,
    title,
    status,
    closedDate,
    sourceRefName: 'refs/heads/feature/vat-rounding',
    targetRefName: 'refs/heads/main',
    repository: { id: REPO_ID, name: 'Billing' },
  }) as unknown as PullRequest;

const wi = (id: number, type: string, title: string, state: string): WorkItem =>
  ({ id, rev: 1, fields: { 'System.WorkItemType': type, 'System.Title': title, 'System.State': state } });

const line = (over: Partial<CommitLine> = {}): CommitLine => ({
  kind: 'commit', sha: SHA, author: 'Erika Muster', authorTime: NOW / 1000 - 3 * 86400, summary: 'Round VAT per line, not per invoice', boundary: false, ...over,
});

const repo = { repo: {}, remoteName: 'origin', repoName: 'Billing', project: 'Contoso' };

describe('pickPullRequest', () => {
  it('returns undefined for nothing and for abandoned only', () => {
    assert.equal(pickPullRequest([], []), undefined);
    assert.equal(pickPullRequest([pr(1, 'abandoned')], [pr(2, 'abandoned')]), undefined);
  });

  it('prefers the earliest completed merge commit pull request', () => {
    const m = pickPullRequest([pr(5, 'completed', '2026-02-01'), pr(4, 'completed', '2026-01-01')], [pr(3, 'completed', '2025-01-01')]);
    assert.equal(m?.pr.pullRequestId, 4);
    assert.equal(m?.via, 'mergeCommit');
    assert.deepEqual(m?.others.map(p => p.pullRequestId), [3, 5]);
  });

  it('uses the earliest completed commit pull request without a merge commit hit', () => {
    const m = pickPullRequest([pr(9, 'active')], [pr(7, 'completed', '2026-03-01'), pr(6, 'completed', '2026-01-01'), pr(8, 'abandoned')]);
    assert.equal(m?.pr.pullRequestId, 6);
    assert.equal(m?.via, 'commit');
    assert.deepEqual(m?.others.map(p => p.pullRequestId), [7, 9]);
  });

  it('falls back to an active one with the via of its list', () => {
    assert.equal(pickPullRequest([pr(1, 'active')], [])?.via, 'mergeCommit');
    const m = pickPullRequest([], [pr(2, 'active')]);
    assert.equal(m?.via, 'commit');
    assert.equal(m?.pr.status, 'active');
  });

  it('ignores pull requests that are neither completed nor active', () => {
    assert.equal(pickPullRequest([pr(1, 'notSet')], []), undefined);
  });

  it('deduplicates by pull request ID', () => {
    const m = pickPullRequest([pr(1, 'completed', '2026-01-01')], [pr(1, 'completed', '2026-01-01'), pr(2, 'completed', '2026-02-01'), pr(2, 'completed', '2026-02-01')]);
    assert.equal(m?.pr.pullRequestId, 1);
    assert.deepEqual(m?.others.map(p => p.pullRequestId), [2]);
  });

  it('sorts others without a closed date last', () => {
    const m = pickPullRequest([pr(1, 'completed', '2026-01-01')], [pr(2, 'active'), pr(3, 'completed', '2026-05-01'), pr(4, 'active')]);
    assert.deepEqual(m?.others.map(p => p.pullRequestId), [3, 2, 4]);
  });
});

describe('prIdFromMessage', () => {
  it('reads the ID from the first line', () => {
    assert.equal(prIdFromMessage('Merged PR 1234: Fix VAT rounding'), 1234);
    assert.equal(prIdFromMessage('Merge PR 7: x\n\nbody'), 7);
    assert.equal(prIdFromMessage('Merged PR 123456789: x'), 123456789);
  });

  it('does not match anything else', () => {
    assert.equal(prIdFromMessage('Merged PR abc: x'), undefined);
    assert.equal(prIdFromMessage('Fix\nMerged PR 12: x'), undefined);
    assert.equal(prIdFromMessage('Merged PR 1234567890: x'), undefined);
    assert.equal(prIdFromMessage('Merged PR 12 x'), undefined);
    assert.equal(prIdFromMessage('merged PR 12: x'), undefined);
    assert.equal(prIdFromMessage(''), undefined);
  });
});

describe('mergeWorkItems', () => {
  const items = [wi(1, 'Bug', 'A', 'Active'), wi(2, 'Task', 'B', 'New'), wi(3, 'Task', 'C', 'New'), wi(4, 'Bug', 'D', 'New')];

  it('keeps loaded IDs only, with sources in order, sorted by strongest link then ID', () => {
    const r = mergeWorkItems(items, { pr: [4, 1, 99], commit: [3, 1], mention: [2, 3, 1] });
    assert.deepEqual(r.map(x => [x.item.id, x.sources]), [
      [1, ['pr', 'commit', 'mention']],
      [4, ['pr']],
      [3, ['commit', 'mention']],
      [2, ['mention']],
    ]);
  });

  it('handles nothing', () => {
    assert.deepEqual(mergeWorkItems([], { pr: [1], commit: [], mention: [] }), []);
  });
});

describe('cleanText', () => {
  it('removes control and bidi characters and collapses whitespace', () => {
    assert.equal(cleanText('a\u0000b\u202ec\u2066d\u200fe\u061cf'), 'a bcdef');
    assert.equal(cleanText('  a\n\t b \u0085 c  '), 'a b c');
    assert.equal(cleanText('x\u007Fy'), 'x y');
  });

  it('neutralizes codicon syntax', () => {
    assert.equal(cleanText('$(alert) x'), '$ (alert) x');
  });

  it('cuts at max characters with an ellipsis and never splits a surrogate pair', () => {
    assert.equal(cleanText('abcdefghij', 5), 'abcd…');
    assert.equal(cleanText('abcde', 5), 'abcde');
    const r = cleanText('😀😀😀😀😀😀', 4);
    assert.equal(r, '😀😀😀…');
    assert.equal(cleanText('abc', 0), '…');
  });
});

describe('relativeAge and shortSha', () => {
  const ago = (s: number) => relativeAge(NOW / 1000 - s, NOW);
  it('formats units', () => {
    assert.equal(ago(10), 'just now');
    assert.equal(ago(-100), 'just now');
    assert.equal(ago(300), '5 min ago');
    assert.equal(ago(3600), '1 hour ago');
    assert.equal(ago(3 * 3600), '3 hours ago');
    assert.equal(ago(86400), '1 day ago');
    assert.equal(ago(3 * 86400), '3 days ago');
    assert.equal(ago(65 * 86400), '2 mo ago');
    assert.equal(ago(365 * 86400), '1 year ago');
    assert.equal(ago(800 * 86400), '2 years ago');
  });

  it('shortens a SHA to 7 characters', () => {
    assert.equal(shortSha(SHA), 'a1b2c3d');
  });
});

describe('annotationText', () => {
  const match: PrMatch = { pr: pr(1234, 'completed', '2026-01-01', 'Fix VAT rounding for all invoices of the year'), via: 'mergeCommit', others: [] };
  const commit = (extra: object = {}) => ({ lookup: { state: 'commit' as const, line: line(), repo }, ...extra });

  it('shows author, age and pull request', () => {
    const t = annotationText(commit({ pr: { repoId: REPO_ID, match } }), NOW) ?? '';
    assert.match(t, /^Erika Muster, 3 days ago · !1234 Fix VAT rounding/);
    assert.ok(t.length <= 80);
  });

  it('shows a pull request found by commit message and an active one', () => {
    const m = { ...match, via: 'message' as const, pr: pr(5, 'active', undefined, 'T') };
    assert.equal(annotationText(commit({ pr: { repoId: REPO_ID, match: m } }), NOW), 'Erika Muster, 3 days ago · !5 T');
  });

  it('shows only author and age while loading or without pull request', () => {
    assert.equal(annotationText(commit(), NOW), 'Erika Muster, 3 days ago');
    assert.equal(annotationText(commit({ pr: { repoId: REPO_ID } }), NOW), 'Erika Muster, 3 days ago');
  });

  it('handles uncommitted, unpublished and shallow', () => {
    assert.equal(annotationText({ lookup: { state: 'uncommitted' } }, NOW), 'Not committed yet');
    const l = line({ authorTime: NOW / 1000 - 300 });
    assert.equal(annotationText({ lookup: { state: 'unpublished', line: l, repo } }, NOW), 'Erika Muster, 5 min ago · not pushed yet');
    assert.equal(annotationText({ lookup: { state: 'shallow', line: l, repo } }, NOW), 'Erika Muster, 5 min ago · shallow clone');
  });

  it('shows nothing for the other states', () => {
    for (const state of ['notAdo', 'untrusted', 'untracked', 'noLine', 'tooBig', 'saveToBlame'] as const) {
      assert.equal(annotationText({ lookup: { state } }, NOW), undefined);
    }
    assert.equal(annotationText({ lookup: { state: 'error', message: 'x' } }, NOW), undefined);
  });

  it('limits the length and cleans the texts', () => {
    const l = line({ author: `${'Erika '.repeat(30)}\u202e` });
    const t = annotationText({ lookup: { state: 'commit', line: l, repo }, pr: { repoId: REPO_ID, match: { ...match, pr: pr(1, 'completed', undefined, '$(alert) '.repeat(20)) } } }, NOW) ?? '';
    assert.ok(Array.from(t).length <= 80);
    assert.ok(!t.includes('$('));
    assert.ok(!t.includes('\u202e'));
  });
});

describe('hoverMarkdown', () => {
  const match: PrMatch = { pr: pr(1234, 'completed', '2026-01-01', 'Fix VAT rounding'), via: 'mergeCommit', others: [] };
  const base = (over: Partial<HoverData> = {}): HoverData => ({ line: line(), project: 'Contoso', repoName: 'Billing', ...over });
  const decode = (md: string, command: string) => {
    const m = new RegExp(`command:${command.replaceAll('.', '\\.')}\\?([^)]*(?:%29)?[^)]*)\\)`).exec(md);
    return m ? JSON.parse(decodeURIComponent(m[1])) : undefined;
  };

  it('builds the full hover with encoded command links', () => {
    const md = hoverMarkdown(base({
      pr: { repoId: REPO_ID, match },
      workItems: [
        { item: wi(4711, 'Bug', 'VAT off by one cent', 'Active'), sources: ['pr'] },
        { item: wi(4702, 'User Story', 'Invoice totals', 'Closed'), sources: ['commit', 'mention'] },
        { item: wi(4688, 'Epic', 'Tax rules 2026', 'New'), sources: ['mention'] },
      ],
    }), NOW);
    assert.match(md, /^\*\*Erika Muster\*\* · 3 days ago/);
    assert.ok(md.includes('$(git-commit) a1b2c3d'));
    assert.ok(md.includes('$(git-pull-request) !1234 Fix VAT rounding'));
    assert.ok(md.includes('completed · feature/vat\\-rounding → main'));
    assert.deepEqual(decode(md, 'azureDevOps.pr.openOverview'), [REPO_ID, 1234]);
    assert.deepEqual(decode(md, 'azureDevOps.pr.openInBrowser'), ['Billing', 1234, 'Contoso']);
    assert.deepEqual(decode(md, 'azureDevOps.wi.open'), [4711]);
    assert.deepEqual(decode(md, 'azureDevOps.blame.openCommit'), ['Contoso', 'Billing', SHA]);
    assert.ok(md.includes('$(bug) [#4711]'));
    assert.ok(md.includes('$(book) [#4702]'));
    assert.ok(md.includes('$(tag) [#4688]'));
    assert.ok(md.includes('linked commit, mentioned'));
    assert.ok(md.includes('[Open commit in browser]'));
    for (const c of md.matchAll(/command:([\w.]+)\?/g)) {
      assert.ok(HOVER_COMMANDS.includes(c[1]));
    }
  });

  it('omits unknown parts while loading', () => {
    const md = hoverMarkdown(base(), NOW);
    assert.ok(!md.includes('git-pull-request'));
    assert.ok(!md.includes('circle-slash'));
  });

  it('says so when no pull request exists, for a commit message hit and when not pushed', () => {
    assert.ok(hoverMarkdown(base({ pr: { repoId: REPO_ID } }), NOW).includes('$(circle-slash) No pull request found for this commit'));
    const m = hoverMarkdown(base({ pr: { repoId: REPO_ID, match: { ...match, via: 'message' } } }), NOW);
    assert.ok(m.includes('from commit message'));
    const u = hoverMarkdown(base({ unpublished: true, pr: { repoId: REPO_ID, match } }), NOW);
    assert.ok(u.includes('not pushed yet'));
    assert.ok(!u.includes('git-pull-request'));
  });

  it('gives no links for invalid values', () => {
    const md = hoverMarkdown(base({
      line: line({ sha: 'zzz' }),
      pr: { repoId: 'not-a-guid', match: { ...match, pr: pr(0, 'completed') } },
      workItems: [{ item: wi(-1, 'Bug', 'x', 'New'), sources: ['pr'] }],
    }), NOW);
    assert.ok(!md.includes('openOverview'));
    assert.ok(!md.includes('azureDevOps.wi.open'));
    assert.ok(!md.includes('openCommit'));
    const bad = hoverMarkdown(base({ pr: { repoId: 'not-a-guid', match } }), NOW);
    assert.ok(!bad.includes('openOverview'));
    assert.ok(bad.includes('openInBrowser'));
  });

  it('escapes every text from the file or the server', () => {
    const evil = '[x](command:azureDevOps.evil)';
    const md = hoverMarkdown(base({
      line: line({ author: evil, summary: '<script>alert(1)</script> $(alert)' }),
      repoName: 'Billing)(x',
      pr: { repoId: REPO_ID, match: { ...match, pr: { ...pr(1, 'completed', undefined, `${evil} $(alert) <b>`), sourceRefName: 'refs/heads/[a](command:azureDevOps.evil)', targetRefName: '<i>' } } },
      workItems: [{ item: wi(5, '<u>', `${evil}\n\n# <script>`, '$(alert)'), sources: ['pr'] }],
    }), NOW);
    assert.ok(!md.includes('command:azureDevOps.evil'));
    assert.ok(!md.includes('<script>'));
    assert.ok(!md.includes('<b>'));
    assert.ok(!md.includes('$(alert)'));
    assert.ok(md.includes('\\[x\\]\\(command:azureDevOps\\.evil\\)'));
    assert.ok(md.includes('\\<script\\>'));
    assert.ok(md.includes('\\$\\(alert\\)'));
    assert.ok(!md.includes('\n# '));
    const links = [...md.matchAll(/command:([\w.]+)\?/g)].map(m => m[1]);
    assert.ok(links.length > 0);
    assert.ok(links.every(c => HOVER_COMMANDS.includes(c)));
    assert.ok(!/%28|\(x/.test(md.split('openInBrowser')[1].split(')')[0]) || md.includes('Billing%29%28x'));
  });
});

describe('traceRows', () => {
  const match: PrMatch = { pr: pr(1234, 'completed', '2026-01-01', 'Fix VAT rounding'), via: 'mergeCommit', others: [pr(1301, 'completed', '2026-02-01', 'Release 26.4')] };
  const base = (over: Partial<TraceData> = {}): TraceData => ({ line: line(), project: 'Contoso', repoName: 'Billing', ...over });
  const labels = (rows: { label: string }[]) => rows.map(r => r.label);

  it('M4: commit, pull request, work items and other pull requests', () => {
    const rows = traceRows(base({
      pr: { repoId: REPO_ID, match },
      workItems: [
        { item: wi(4711, 'Bug', 'VAT off by one cent', 'Active'), sources: ['pr'] },
        { item: wi(4702, 'Product Backlog Item', 'Invoice totals', 'Closed'), sources: ['commit', 'mention'] },
      ],
    }), NOW);
    assert.deepEqual(labels(rows), [
      'Commit', '$(git-commit) a1b2c3d Round VAT per line, not per invoice',
      'Pull request', '$(git-pull-request) !1234 Fix VAT rounding',
      'Work items', '$(bug) #4711 VAT off by one cent', '$(book) #4702 Invoice totals',
      'Other pull requests with this commit', '$(git-pull-request) !1301 Release 26.4',
    ]);
    assert.equal(rows[0].kind, 'separator');
    assert.equal(rows[1].description, 'Erika Muster, 3 days ago');
    assert.deepEqual(rows[1].action, { command: 'azureDevOps.blame.openCommit', args: ['Contoso', 'Billing', SHA] });
    assert.equal(rows[3].description, 'completed → main');
    assert.deepEqual(rows[3].action, { command: 'azureDevOps.pr.openOverview', args: [REPO_ID, 1234] });
    assert.equal(rows[5].description, 'Active · linked to PR');
    assert.equal(rows[6].description, 'Closed · linked commit, mentioned');
    assert.deepEqual(rows[5].action, { command: 'azureDevOps.wi.open', args: [4711] });
    assert.equal(rows[8].description, 'completed → main');
  });

  it('M5: no pull request, work item mentioned', () => {
    const rows = traceRows(base({ pr: { repoId: REPO_ID }, workItems: [{ item: wi(4530, 'Task', 'Tax table 2026', 'Closed'), sources: ['mention'] }] }), NOW);
    assert.deepEqual(labels(rows).slice(2), ['$(circle-slash) No pull request found for this commit', 'Work items', '$(tag) #4530 Tax table 2026']);
    assert.equal(rows[2].action, undefined);
    assert.equal(rows[4].description, 'Closed · mentioned');
  });

  it('M5a and active: notes in the description', () => {
    const m = traceRows(base({ pr: { repoId: REPO_ID, match: { ...match, via: 'message', others: [] } } }), NOW);
    assert.equal(m[3].description, 'from commit message');
    const a = traceRows(base({ pr: { repoId: REPO_ID, match: { pr: pr(9, 'active'), via: 'commit', others: [] } } }), NOW);
    assert.equal(a[3].description, 'active, not merged yet → main');
  });

  it('M7: loading rows without action', () => {
    const p = traceRows(base({ loading: 'pr' }), NOW);
    assert.deepEqual(labels(p), ['Commit', '$(git-commit) a1b2c3d Round VAT per line, not per invoice', '$(sync~spin) Looking for the pull request…']);
    assert.equal(p[2].action, undefined);
    const w = traceRows(base({ loading: 'workItems', pr: { repoId: REPO_ID, match: { ...match, others: [] } } }), NOW);
    assert.equal(w.at(-1)?.label, '$(sync~spin) Looking for work items…');
  });

  it('unpublished, shallow (M9) and error', () => {
    const u = traceRows(base({ unpublished: true, pr: { repoId: REPO_ID, match } }), NOW);
    assert.equal(u.length, 3);
    assert.equal(u[2].label, '$(cloud-upload) This commit is not pushed yet');
    const s = traceRows(base({ shallow: true }), NOW);
    assert.equal(s.length, 1);
    assert.equal(s[0].label, '$(warning) Shallow clone: history ends at a1b2c3d, so the real commit for this line is unknown. Fetch the full history to look it up');
    const e = traceRows(base({ error: 'Boom\n$(x)' }), NOW);
    assert.equal(e[2].label, '$(error) Boom $ (x)');
  });

  it('keeps the pull request visible when a later step failed', () => {
    const rows = traceRows(base({ pr: { repoId: REPO_ID, match: { ...match, others: [] } }, error: 'Work items failed' }), NOW);
    assert.ok(rows.some(r => r.label.includes('!')), 'the pull request row stays');
    assert.equal(rows.at(-1)?.label, '$(error) Work items failed');
    assert.ok(rows.some(r => r.action?.command === 'azureDevOps.pr.openOverview'));
  });

  it('cleans plain texts so a title cannot produce an icon', () => {
    const rows = traceRows(base({
      line: line({ summary: '$(alert) \u202e' + 'x'.repeat(200), sha: 'abc' }),
      pr: { repoId: REPO_ID, match: { pr: pr(1, 'completed', undefined, '$(rocket) hi'), via: 'commit', others: [] } },
      workItems: [{ item: wi(2, 'Bug', '$(bug) t', 'New'), sources: ['pr'] }],
    }), NOW);
    assert.equal(rows[1].action, undefined);
    assert.ok(Array.from(rows[1].label).length <= 95);
    assert.ok(!rows[1].label.slice(14).includes('$('));
    assert.equal(rows[3].label, '$(git-pull-request) !1 $ (rocket) hi');
    assert.equal(rows[5].label, '$(bug) #2 $ (bug) t');
  });
});

describe('stateMessage', () => {
  it('explains the states', () => {
    assert.equal(stateMessage({ state: 'notAdo' }, 'tax.ts', 'https://dev.azure.com/contoso'), 'tax.ts is not in a clone of an Azure Repos repository of https://dev.azure.com/contoso, so there is nothing to look up.');
    assert.equal(stateMessage({ state: 'notAdo' }, 'tax.ts', undefined), 'tax.ts is not in a clone of an Azure Repos repository of the configured organization, so there is nothing to look up.');
    assert.equal(stateMessage({ state: 'untrusted' }, 'tax.ts', undefined), 'Tracing a line runs git, which is off in an untrusted workspace.');
    assert.equal(stateMessage({ state: 'untracked' }, 'tax.ts', undefined), 'tax.ts is not tracked by git yet.');
    assert.equal(stateMessage({ state: 'uncommitted' }, 'tax.ts', undefined), 'This line is not committed yet.');
    assert.equal(stateMessage({ state: 'noLine' }, 'tax.ts', undefined), 'There is no line here to trace.');
    assert.equal(stateMessage({ state: 'tooBig' }, 'tax.ts', undefined), 'tax.ts is too big to trace with unsaved changes. Save it first.');
    assert.equal(stateMessage({ state: 'saveToBlame' }, 'tax.ts', undefined), 'Save tax.ts to trace this line: it has unsaved changes and is not UTF-8.');
  });

  it('cleans the error message and ignores traceable states', () => {
    assert.equal(stateMessage({ state: 'error', message: 'Bad\n\u202ething $(x)' }, 'a', undefined), 'Bad thing $ (x)');
    assert.equal(stateMessage({ state: 'commit', line: line(), repo }, 'a', undefined), undefined);
    assert.equal(stateMessage({ state: 'shallow', line: line(), repo }, 'a', undefined), undefined);
    assert.equal(stateMessage({ state: 'unpublished', line: line(), repo }, 'a', undefined), undefined);
  });
});

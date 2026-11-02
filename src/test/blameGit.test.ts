import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  GitError, ZERO_SHA, blameArgs, blameWindow, isFullSha, isPastEndError, isUntrackedError, makeGitRunner,
  parsePorcelain, shallowArgs,
} from '../blame/blameGit';
import type { CommitLine } from '../blame/blameTypes';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('isFullSha / blameWindow', () => {
  it('accepts only 40 lowercase hex characters', () => {
    assert.equal(isFullSha(A), true);
    assert.equal(isFullSha('A'.repeat(40)), false);
    assert.equal(isFullSha('a'.repeat(39)), false);
    assert.equal(isFullSha(`${A}\n`), false);
    assert.equal(isFullSha(42), false);
    assert.equal(isFullSha(undefined), false);
  });
  it('clamps the window', () => {
    assert.deepEqual(blameWindow(0, 100), { from: 1, to: 21 });
    assert.deepEqual(blameWindow(50, 100), { from: 31, to: 71 });
    assert.deepEqual(blameWindow(99, 100), { from: 80, to: 100 });
    assert.deepEqual(blameWindow(0, 1), { from: 1, to: 1 });
  });
  it('throws on bad lines', () => {
    assert.throws(() => blameWindow(-1, 10));
    assert.throws(() => blameWindow(10, 10));
    assert.throws(() => blameWindow(1.5, 10));
    assert.throws(() => blameWindow(Number.NaN, 10));
  });
});

describe('blameArgs', () => {
  const base = { path: 'src/a.ts', line: 0, lineCount: 5, ignoreWhitespace: false, detectCopies: false, dirty: false };
  it('builds the basic command', () => {
    assert.deepEqual(blameArgs(base), ['blame', '--porcelain', '--no-textconv', '-M', '-L', '1,5', '--', 'src/a.ts']);
  });
  it('adds flags, never -C twice', () => {
    const args = blameArgs({ ...base, ignoreWhitespace: true, detectCopies: true, dirty: true });
    assert.deepEqual(args, ['blame', '--porcelain', '--no-textconv', '-w', '-M', '-C', '-L', '1,5', '--contents', '-', '--', 'src/a.ts']);
    assert.equal(args.filter((a) => a === '-C').length, 1);
  });
  it('keeps --contents out when clean and the path after --', () => {
    const args = blameArgs({ ...base, path: '-L' });
    assert.equal(args.includes('--contents'), false);
    assert.deepEqual(args.slice(-2), ['--', '-L']);
  });
  it('shallowArgs', () => {
    assert.deepEqual(shallowArgs(), ['rev-parse', '--is-shallow-repository']);
  });
});

describe('parsePorcelain', () => {
  const meta = (name: string, extra = '') =>
    `author ${name}\nauthor-mail <e@contoso.example>\nauthor-time 1700000000\nauthor-tz +0000\ncommitter ${name}\n` +
    `committer-time 1700000000\nsummary Fix thing\n${extra}filename a.txt\n`;

  it('parses 4-field and 3-field headers and reuses metadata', () => {
    const out = `${A} 3 1 2\n${meta('Erika Muster')}\tone\n${A} 4 2\n\ttwo\n${B} 1 3 1\n${meta('Max Mustermann', 'boundary\n')}\tthree\n`;
    const m = parsePorcelain(out);
    assert.equal(m.size, 3);
    const l1 = m.get(1) as CommitLine;
    assert.equal(l1.kind, 'commit');
    assert.equal(l1.sha, A);
    assert.equal(l1.author, 'Erika Muster');
    assert.equal(l1.authorTime, 1700000000);
    assert.equal(l1.summary, 'Fix thing');
    assert.equal(l1.boundary, false);
    const l2 = m.get(2) as CommitLine;
    assert.equal(l2.author, 'Erika Muster');
    const l3 = m.get(3) as CommitLine;
    assert.equal(l3.boundary, true);
    assert.equal(l3.author, 'Max Mustermann');
  });
  it('maps the zero SHA to uncommitted', () => {
    const m = parsePorcelain(`${ZERO_SHA} 1 1 1\nauthor Not Committed Yet\nsummary x\n\tcode\n`);
    assert.deepEqual(m.get(1), { kind: 'uncommitted' });
  });
  it('ignores content that looks like porcelain', () => {
    const out = `${A} 1 1 2\n${meta('Erika Muster')}\tauthor Mallory\n${A} 2 2\n\tauthor Mallory\n`;
    const m = parsePorcelain(out);
    assert.equal(m.size, 2);
    assert.equal((m.get(1) as CommitLine).author, 'Erika Muster');
    assert.equal((m.get(2) as CommitLine).sha, A);
    // a content row shaped like a header
    const m2 = parsePorcelain(`${A} 1 1 1\n${meta('Erika Muster')}\t${B} 5 5 1\n`);
    assert.equal(m2.size, 1);
  });
  it('handles CRLF', () => {
    const m = parsePorcelain(`${A} 1 1 1\r\nauthor Erika Muster\r\nsummary Hi\r\n\tline\r\n`);
    const l = m.get(1) as CommitLine;
    assert.equal(l.author, 'Erika Muster');
    assert.equal(l.summary, 'Hi');
  });
  it('skips garbage headers and empty input', () => {
    assert.equal(parsePorcelain('').size, 0);
    assert.equal(parsePorcelain(`${A} x 1 1\n\tfoo\n${A} 1\n\tbar\nauthor X\n`).size, 0);
    const m = parsePorcelain(`${A} 1 1 1\nauthor-time nope\nauthor\nboundary\n\tx`);
    assert.equal((m.get(1) as CommitLine).authorTime, 0);
  });
});

describe('error classification', () => {
  it('detects untracked and past-end messages', () => {
    assert.equal(isUntrackedError("fatal: no such path 'u.txt' in HEAD"), true);
    assert.equal(isUntrackedError("fatal: no such path 'u.txt' in the working tree"), true);
    assert.equal(isUntrackedError('fatal: file is not tracked'), true);
    assert.equal(isUntrackedError('fatal: bad revision'), false);
    assert.equal(isPastEndError('fatal: file t.txt has only 1 line'), true);
    assert.equal(isPastEndError('fatal: file t.txt has only 12 lines'), true);
    assert.equal(isPastEndError('fatal: other'), false);
  });
});

describe('makeGitRunner with real git', () => {
  let dir = '';
  const run = makeGitRunner('git');
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Erika Muster', '-c', 'user.email=erika@contoso.example', ...args], { cwd: dir, encoding: 'utf8' }); // NOSONAR: test helper, runs git from PATH only in a temporary repository

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blamegit-'));
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(dir, '-L'), 'dash\n');
    fs.writeFileSync(path.join(dir, 'm.txt'), 'x\nlong line that stays\nshort\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('blames committed lines', async () => {
    const out = await run(dir, blameArgs({ path: 'a.txt', line: 1, lineCount: 3, ignoreWhitespace: false, detectCopies: false, dirty: false }));
    const l = parsePorcelain(out).get(2) as CommitLine;
    assert.equal(l.author, 'Erika Muster');
    assert.equal(l.summary, 'first');
    assert.equal(l.boundary, true);
    assert.ok(isFullSha(l.sha));
  });
  it('blames a dirty buffer through stdin', async () => {
    const buf = 'one\ninserted\ntwo\nthree\n';
    const out = await run(dir, blameArgs({ path: 'a.txt', line: 0, lineCount: 4, ignoreWhitespace: false, detectCopies: false, dirty: true }), { stdin: buf });
    const m = parsePorcelain(out);
    assert.deepEqual(m.get(2), { kind: 'uncommitted' });
    assert.equal((m.get(1) as CommitLine).kind, 'commit');
  });
  it('a short line moved in an unsaved buffer counts as uncommitted', async () => {
    const moved = 'short\nx\nlong line that stays\n';
    const out = await run(dir, blameArgs({ path: 'm.txt', line: 0, lineCount: 3, ignoreWhitespace: false, detectCopies: false, dirty: true }), { stdin: moved });
    const m = parsePorcelain(out);
    assert.equal(m.size, 3);
    assert.equal(m.get(1)?.kind, 'uncommitted');
    assert.equal(m.get(2)?.kind, 'commit');
    assert.equal(m.get(3)?.kind, 'commit');
  });
  it('the window keeps a short line with its first commit, which a one-line -L range loses', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'blamemv-'));
    try {
      const g = (...args: string[]): string =>
        execFileSync('git', ['-c', 'user.name=Erika Muster', '-c', 'user.email=erika@contoso.example', ...args], { cwd: d, encoding: 'utf8' }); // NOSONAR: test helper, runs git from PATH only in a temporary repository
      const filler = (n: number, from: number): string[] => Array.from({ length: n }, (_, i) => `unique filler line number ${from + i} of the file`);
      const block = ['long block line one of the moved block', 'long block line two of the moved block', 'abcd5',
        'long block line four of the moved block', 'long block line five of the moved block'];
      g('init', '-q');
      fs.writeFileSync(path.join(d, 'f.txt'), [...block, ...filler(45, 0)].join('\n') + '\n');
      g('add', '.');
      g('commit', '-q', '-m', 'first');
      const first = g('rev-parse', 'HEAD').trim();
      fs.writeFileSync(path.join(d, 'f.txt'), [...filler(30, 0), ...block, ...filler(15, 30)].join('\n') + '\n');
      g('commit', '-q', '-am', 'second');
      const second = g('rev-parse', 'HEAD').trim();
      const shaOf = (out: string, n: number): string => (parsePorcelain(out).get(n) as CommitLine).sha;
      const windowed = await run(d, blameArgs({ path: 'f.txt', line: 32, lineCount: 50, ignoreWhitespace: false, detectCopies: false, dirty: false }));
      assert.equal(shaOf(windowed, 33), first);
      const single = await run(d, ['blame', '--porcelain', '-M', '-L', '33,33', '--', 'f.txt']);
      assert.equal(shaOf(single, 33), second);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  it('handles a file named -L', async () => {
    const out = await run(dir, blameArgs({ path: '-L', line: 0, lineCount: 1, ignoreWhitespace: true, detectCopies: true, dirty: false }));
    assert.equal((parsePorcelain(out).get(1) as CommitLine).kind, 'commit');
  });
  it('rejects untracked files with a GitError', async () => {
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'u\n');
    await assert.rejects(
      run(dir, blameArgs({ path: 'untracked.txt', line: 0, lineCount: 1, ignoreWhitespace: false, detectCopies: false, dirty: false })),
      (e: unknown) => e instanceof GitError && isUntrackedError(e.message) && !e.timedOut && !e.message.includes('--porcelain'),
    );
  });
  it('rejects past the end of the file', async () => {
    await assert.rejects(
      run(dir, ['blame', '--porcelain', '-L', '10,12', '--', 'a.txt']),
      (e: unknown) => e instanceof GitError && isPastEndError(e.message),
    );
  });
  it('reports shallow state', async () => {
    assert.equal((await run(dir, shallowArgs())).trim(), 'false');
  });
  it('times out', async () => {
    const slow = makeGitRunner(process.execPath);
    await assert.rejects(
      slow(dir, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 100 }),
      (e: unknown) => e instanceof GitError && e.timedOut,
    );
  });
  it('does not call output that does not fit the buffer a timeout', async () => {
    const big = makeGitRunner(process.execPath);
    await assert.rejects(
      big(dir, ['-e', "process.stdout.write('x'.repeat(17 * 1024 * 1024))"], { timeoutMs: 20000 }),
      (e: unknown) => e instanceof GitError && !e.timedOut && e.tooLarge && /too large/.test(e.message),
    );
  });
  it('does not mark an abort as a timeout and survives EPIPE', async () => {
    const ac = new AbortController();
    const slow = makeGitRunner(process.execPath);
    const p = slow(dir, ['-e', 'setTimeout(()=>{}, 10000)'], { signal: ac.signal, stdin: 'x'.repeat(1 << 20) });
    ac.abort();
    await assert.rejects(p, (e: unknown) => e instanceof GitError && !e.timedOut);
  });
  it('falls back to the error message when stderr is empty', async () => {
    const bad = makeGitRunner(path.join(dir, 'does-not-exist'));
    await assert.rejects(bad(dir, []), (e: unknown) => e instanceof GitError && e.message.length > 0 && e.code === 'ENOENT');
  });
});

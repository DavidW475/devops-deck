import { execFile } from 'node:child_process';
import type { BlameLine, GitRunner, GitRunOptions } from './blameTypes';

export const ZERO_SHA = '0'.repeat(40);

const FULL_SHA = /^[0-9a-f]{40}$/;
const WINDOW_RADIUS = 20;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 16 * 1024 * 1024;

export function isFullSha(s: unknown): s is string {
  return typeof s === 'string' && FULL_SHA.test(s);
}

/** 1-based inclusive window around the 0-based `line`, clamped to the file. */
export function blameWindow(line: number, lineCount: number): { from: number; to: number } {
  if (!Number.isInteger(line) || !Number.isInteger(lineCount) || line < 0 || line >= lineCount) {
    throw new RangeError('line out of range');
  }
  return { from: Math.max(1, line + 1 - WINDOW_RADIUS), to: Math.min(lineCount, line + 1 + WINDOW_RADIUS) };
}

export interface BlameArgsOptions {
  path: string;
  line: number;
  lineCount: number;
  ignoreWhitespace: boolean;
  detectCopies: boolean;
  dirty: boolean;
}

export function blameArgs(o: BlameArgsOptions): string[] {
  const { from, to } = blameWindow(o.line, o.lineCount);
  const args = ['blame', '--porcelain', '--no-textconv'];
  if (o.ignoreWhitespace) args.push('-w');
  args.push('-M');
  if (o.detectCopies) args.push('-C');
  args.push('-L', `${from},${to}`);
  if (o.dirty) args.push('--contents', '-');
  args.push('--', o.path);
  return args;
}

export function shallowArgs(): string[] {
  return ['rev-parse', '--is-shallow-repository'];
}

interface Header {
  sha: string;
  orig: number;
  final: number;
}

interface CommitInfo {
  author: string;
  authorTime: number;
  summary: string;
  boundary: boolean;
}

function toLineNumber(s: string): number | undefined {
  if (s.length === 0 || s.length > 9) return undefined;
  for (const ch of s) {
    if (ch < '0' || ch > '9') return undefined;
  }
  const n = Number(s);
  return n > 0 ? n : undefined;
}

function parseHeader(line: string): Header | undefined {
  const parts = line.split(' ');
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  if (!isFullSha(parts[0])) return undefined;
  const orig = toLineNumber(parts[1]);
  const final = toLineNumber(parts[2]);
  if (orig === undefined || final === undefined) return undefined;
  if (parts.length === 4 && toLineNumber(parts[3]) === undefined) return undefined;
  return { sha: parts[0], orig, final };
}

function applyMeta(info: CommitInfo, line: string): void {
  const space = line.indexOf(' ');
  const key = space < 0 ? line : line.slice(0, space);
  const value = space < 0 ? '' : line.slice(space + 1);
  if (key === 'author') info.author = value;
  else if (key === 'summary') info.summary = value;
  else if (key === 'boundary') info.boundary = true;
  else if (key === 'author-time') {
    const t = Number(value);
    if (Number.isFinite(t)) info.authorTime = t;
  }
}

function buildLine(header: Header, info: CommitInfo | undefined): BlameLine {
  if (header.sha === ZERO_SHA) return { kind: 'uncommitted' };
  return {
    kind: 'commit',
    sha: header.sha,
    author: info?.author ?? '',
    authorTime: info?.authorTime ?? 0,
    summary: info?.summary ?? '',
    origLine: header.orig,
    boundary: info?.boundary ?? false,
  };
}

interface ParseState {
  result: Map<number, BlameLine>;
  commits: Map<string, CommitInfo>;
  pending: Header | undefined;
}

function* splitLines(output: string): Generator<string> {
  let pos = 0;
  while (pos < output.length) {
    let end = output.indexOf('\n', pos);
    if (end < 0) end = output.length;
    yield output.slice(pos, end);
    pos = end + 1;
  }
}

/** A content row closes the pending header and is never interpreted. */
function closeEntry(st: ParseState): void {
  if (st.pending) st.result.set(st.pending.final, buildLine(st.pending, st.commits.get(st.pending.sha)));
  st.pending = undefined;
}

function openEntry(st: ParseState, header: Header): void {
  st.pending = header;
  if (!st.commits.has(header.sha)) {
    st.commits.set(header.sha, { author: '', authorTime: 0, summary: '', boundary: false });
  }
}

function metaLine(st: ParseState, line: string): void {
  const info = st.pending ? st.commits.get(st.pending.sha) : undefined;
  if (info) applyMeta(info, line);
}

function parseRow(st: ParseState, raw: string): void {
  if (raw.startsWith('\t')) {
    closeEntry(st);
    return;
  }
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  const header = st.pending ? undefined : parseHeader(line);
  if (header) openEntry(st, header);
  else metaLine(st, line);
}

/** Parses `git blame --porcelain`, keyed by the 1-based final line number. Line content is never kept. */
export function parsePorcelain(output: string): Map<number, BlameLine> {
  const st: ParseState = { result: new Map(), commits: new Map(), pending: undefined };
  for (const raw of splitLines(output)) parseRow(st, raw);
  return st.result;
}

export class GitError extends Error {
  readonly code: number | string | undefined;
  readonly timedOut: boolean;
  constructor(message: string, code?: number | string, timedOut = false) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.timedOut = timedOut;
  }
}

export function isUntrackedError(message: string): boolean {
  const m = message.toLowerCase();
  return (m.includes('no such path') && (m.includes('in head') || m.includes('in the working tree'))) || m.includes('not tracked');
}

export function isPastEndError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('file ') && m.includes(' has only ') && /\d (lines?)\b/.test(m);
}

interface ExecFailure {
  code?: number | string;
  killed?: boolean;
  message?: string;
}

function toGitError(err: ExecFailure, stderr: string, signal: AbortSignal | undefined): GitError {
  const text = stderr.trim() || (err.message ?? 'git failed');
  const timedOut = err.killed === true && signal?.aborted !== true;
  return new GitError(text, err.code, timedOut);
}

export function makeGitRunner(gitPath: string): GitRunner {
  return (root: string, args: string[], options?: GitRunOptions) =>
    new Promise<string>((resolve, reject) => {
      // The path comes from the git extension, no shell is used and the args are built only by this module.
      const child = execFile(
        gitPath,
        args,
        {
          cwd: root,
          env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
          timeout: options?.timeoutMs || DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          signal: options?.signal,
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (err) reject(toGitError(err as ExecFailure, String(stderr ?? ''), options?.signal));
          else resolve(stdout);
        },
      );
      const stdin = child.stdin;
      if (!stdin) return;
      stdin.on('error', () => undefined); // EPIPE when git exits before reading everything
      if (options?.stdin === undefined) stdin.end();
      else stdin.end(options.stdin);
    });
}

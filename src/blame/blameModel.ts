import type { PullRequest, WorkItem } from '../types';
import { mdEscape, plural, shortRef } from '../util';
import type { AnnotationData, CommitLine, HoverData, LineLookup, PrLookup, PrMatch, TraceData, TraceRow, TraceWorkItem, WiSource } from './blameTypes';

/** The commands a hover link may run. */
export const HOVER_COMMANDS: readonly string[] = [
  'azureDevOps.pr.openOverview',
  'azureDevOps.pr.openInBrowser',
  'azureDevOps.wi.open',
  'azureDevOps.blame.openCommit',
];

const GUID = /^[0-9a-f-]{36}$/i;
const SHA = /^[0-9a-f]{40}$/;
const PR_MESSAGE = /^Merged? PR (\d{1,9}):/;
const NO_PR = 'No pull request found for this commit';

const closedTime = (pr: PullRequest): number => {
  const t = Date.parse(pr.closedDate ?? '');
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

const byClosed = (a: PullRequest, b: PullRequest): number => {
  const x = closedTime(a);
  const y = closedTime(b);
  if (x === y) {
    return 0;
  }
  return x < y ? -1 : 1;
};

const sortedByClosed = (list: PullRequest[]): PullRequest[] => [...list].sort(byClosed);

/** Picks the pull request that brought a commit into the repository. Undefined when none counts. */
export function pickPullRequest(byMergeCommit: PullRequest[], byCommit: PullRequest[]): PrMatch | undefined {
  const seen = new Set<number>();
  const all: { pr: PullRequest; via: 'mergeCommit' | 'commit' }[] = [];
  const add = (list: PullRequest[], via: 'mergeCommit' | 'commit') => {
    for (const pr of list) {
      if (pr.status !== 'abandoned' && !seen.has(pr.pullRequestId)) {
        seen.add(pr.pullRequestId);
        all.push({ pr, via });
      }
    }
  };
  add(byMergeCommit, 'mergeCommit');
  add(byCommit, 'commit');
  const completed = (via: string) => all.filter(e => e.via === via && e.pr.status === 'completed').sort((a, b) => byClosed(a.pr, b.pr))[0];
  const picked = completed('mergeCommit') ?? completed('commit') ?? all.find(e => e.pr.status === 'active');
  if (!picked) {
    return undefined;
  }
  const others = sortedByClosed(all.filter(e => e !== picked).map(e => e.pr));
  return { pr: picked.pr, via: picked.via, others };
}

/** The pull request ID of a merge commit message like "Merged PR 1234: title", first line only. */
export function prIdFromMessage(message: string): number | undefined {
  const m = PR_MESSAGE.exec(message.split('\n', 1)[0]);
  return m ? Number(m[1]) : undefined;
}

const WI_ORDER: WiSource[] = ['pr', 'commit', 'mention'];

/** Joins the work items with their sources; items that were not loaded are dropped. */
export function mergeWorkItems(items: WorkItem[], ids: { pr: number[]; commit: number[]; mention: number[] }): TraceWorkItem[] {
  const byId = new Map(items.map(i => [i.id, i]));
  const sources = new Map<number, WiSource[]>();
  for (const source of WI_ORDER) {
    for (const id of ids[source]) {
      const list = sources.get(id) ?? [];
      if (byId.has(id) && !list.includes(source)) {
        list.push(source);
        sources.set(id, list);
      }
    }
  }
  const rank = (s: WiSource[]) => WI_ORDER.indexOf(s[0]);
  return [...sources.entries()]
    .map(([id, src]) => ({ item: byId.get(id) as WorkItem, sources: src }))
    .sort((a, b) => rank(a.sources) - rank(b.sources) || a.item.id - b.item.id);
}

const isControl = (c: number): boolean => c <= 0x1f || (c >= 0x7f && c <= 0x9f);
const isBidi = (c: number): boolean =>
  c === 0x61c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);

/** Control characters become spaces, bidi characters vanish. */
function stripControl(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (isControl(c)) {
      out += ' ';
    } else if (!isBidi(c)) {
      out += ch;
    }
  }
  return out;
}

/** Text from a file or the server for plain surfaces: no control or bidi characters, one line, no codicon syntax, at most `max` characters. */
export function cleanText(s: string, max = 60): string {
  const text = stripControl(s).replace(/\s+/g, ' ').trim().replaceAll('$(', '$ (');
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, Math.max(0, max - 1)).join('') + '…' : text;
}

/** "3 days ago" for a Unix timestamp in seconds. */
export function relativeAge(authorTime: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - authorTime));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) {
    return 'just now';
  }
  if (hours < 1) {
    return `${minutes} min ago`;
  }
  if (days < 1) {
    return `${plural(hours, 'hour')} ago`;
  }
  if (days < 30) {
    return `${plural(days, 'day')} ago`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)} mo ago`;
  }
  return `${plural(Math.floor(days / 365), 'year')} ago`;
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

const authorAge = (line: CommitLine, nowMs: number): string => `${cleanText(line.author, 30)}, ${relativeAge(line.authorTime, nowMs)}`;

/** The text after a line or in the status bar. The caller adds a spinner while `loading`. */
export function annotationText(data: AnnotationData, nowMs: number): string | undefined {
  const lookup = data.lookup;
  if (lookup.state === 'uncommitted') {
    return 'Not committed yet';
  }
  if (lookup.state !== 'commit' && lookup.state !== 'shallow' && lookup.state !== 'unpublished') {
    return undefined;
  }
  const base = authorAge(lookup.line, nowMs);
  let tail = '';
  if (lookup.state === 'shallow') {
    tail = 'shallow clone';
  } else if (lookup.state === 'unpublished') {
    tail = 'not pushed yet';
  } else if (data.pr?.match) {
    const pr = data.pr.match.pr;
    tail = `!${pr.pullRequestId} ${cleanText(pr.title, 40)}`;
  }
  return cleanText(tail ? `${base} · ${tail}` : base, 80);
}

const md = (s: string): string => mdEscape(stripControl(s).replace(/\s+/g, ' ').trim());

const commandUri = (command: string, args: unknown[]): string | undefined => {
  if (!HOVER_COMMANDS.includes(command)) {
    return undefined;
  }
  const encoded = encodeURIComponent(JSON.stringify(args)).replaceAll('(', '%28').replaceAll(')', '%29');
  return `command:${command}?${encoded}`;
};

const link = (text: string, command: string, args: unknown[]): string => {
  const uri = commandUri(command, args);
  return uri ? `[${text}](${uri})` : text;
};

const validPrId = (id: unknown): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0;

function prLinks(d: HoverData, repoId: string, prId: number): string {
  const parts: string[] = [];
  if (GUID.test(repoId)) {
    parts.push(link('Open', 'azureDevOps.pr.openOverview', [repoId, prId]));
  }
  if (d.repoName && d.project) {
    parts.push(link('Browser', 'azureDevOps.pr.openInBrowser', [d.repoName, prId, d.project]));
  }
  return parts.join(' | ');
}

function hoverPr(d: HoverData, lookup: PrLookup): string[] {
  const match = lookup.match;
  if (!match) {
    return [`$(circle-slash) ${NO_PR}`];
  }
  const pr = match.pr;
  const prId = pr.pullRequestId;
  const parts = [md(pr.status), `${md(shortRef(pr.sourceRefName))} → ${md(shortRef(pr.targetRefName))}`];
  if (match.via === 'message') {
    parts.push('from commit message');
  }
  const links = validPrId(prId) ? prLinks(d, lookup.repoId, prId) : '';
  if (links) {
    parts.push(links);
  }
  return [`$(git-pull-request) !${validPrId(prId) ? prId : '?'} ${md(pr.title)}`, parts.join(' · ')];
}

const WI_SOURCE_TEXT: Record<WiSource, string> = { pr: 'linked to PR', commit: 'linked commit', mention: 'mentioned' };

const fieldText = (item: WorkItem, name: string): string => {
  const v = item.fields?.[name];
  return typeof v === 'string' ? v : '';
};

function wiIcon(type: string): string {
  if (type === 'Bug') {
    return '$(bug)';
  }
  return ['User Story', 'Product Backlog Item', 'Requirement'].includes(type) ? '$(book)' : '$(tag)';
}

const wiSourcesText = (w: TraceWorkItem): string => w.sources.map(s => WI_SOURCE_TEXT[s]).join(', ');

function hoverWorkItem(w: TraceWorkItem): string {
  const id = w.item.id;
  const icon = wiIcon(fieldText(w.item, 'System.WorkItemType'));
  const idText = Number.isInteger(id) && id > 0 ? link(`#${id}`, 'azureDevOps.wi.open', [id]) : '#?';
  const state = md(fieldText(w.item, 'System.State'));
  const parts = [`${icon} ${idText} ${md(fieldText(w.item, 'System.Title'))}`];
  if (state) {
    parts.push(state);
  }
  parts.push(wiSourcesText(w));
  return parts.join(' · ');
}

/** The Markdown source of the own hover. Every text from a file or the server is escaped. */
export function hoverMarkdown(d: HoverData, nowMs: number): string {
  const line = d.line;
  const blocks: string[][] = [];
  blocks.push([`**${md(line.author)}** · ${relativeAge(line.authorTime, nowMs)}`, `$(git-commit) ${shortSha(md(line.sha))}  ${md(line.summary)}`]);
  if (d.unpublished) {
    blocks.push(['$(cloud-upload) not pushed yet']);
  } else if (d.pr) {
    blocks.push(hoverPr(d, d.pr));
  }
  if (d.workItems?.length) {
    blocks.push(d.workItems.map(hoverWorkItem));
  }
  if (SHA.test(line.sha) && d.project && d.repoName) {
    blocks.push([link('Open commit in browser', 'azureDevOps.blame.openCommit', [d.project, d.repoName, line.sha])]);
  }
  return blocks.map(b => b.join('\n\n')).join('\n\n---\n\n');
}

const sep = (label: string): TraceRow => ({ kind: 'separator', label });
const info = (label: string): TraceRow => ({ kind: 'item', label });

function commitRow(d: TraceData, nowMs: number): TraceRow {
  const line = d.line;
  const commitTitle = cleanText(`${shortSha(line.sha)} ${line.summary}`, 80);
  const row: TraceRow = {
    kind: 'item',
    label: `$(git-commit) ${commitTitle}`,
    description: authorAge(line, nowMs),
  };
  if (SHA.test(line.sha)) {
    row.action = { command: 'azureDevOps.blame.openCommit', args: [d.project, d.repoName, line.sha] };
  }
  return row;
}

function prRow(repoId: string, pr: PullRequest, note?: string): TraceRow {
  const target = cleanText(shortRef(pr.targetRefName), 60);
  const status = cleanText(pr.status, 20);
  let description = `${status} → ${target}`;
  if (note) {
    description = note;
  } else if (pr.status === 'active') {
    description = `active, not merged yet → ${target}`;
  }
  const prTitle = cleanText(`!${pr.pullRequestId} ${pr.title}`, 80);
  return {
    kind: 'item',
    label: `$(git-pull-request) ${prTitle}`,
    description,
    action: { command: 'azureDevOps.pr.openOverview', args: [repoId, pr.pullRequestId] },
  };
}

function workItemRow(w: TraceWorkItem): TraceRow {
  const { item } = w;
  const icon = wiIcon(fieldText(item, 'System.WorkItemType'));
  const state = cleanText(fieldText(item, 'System.State'), 20);
  const sources = wiSourcesText(w);
  const title = cleanText(`#${item.id} ${fieldText(item, 'System.Title')}`, 80);
  return {
    kind: 'item',
    label: `${icon} ${title}`,
    description: state ? `${state} · ${sources}` : sources,
    action: { command: 'azureDevOps.wi.open', args: [item.id] },
  };
}

function prRows(d: TraceData): TraceRow[] {
  if (d.loading === 'pr') {
    return [info('$(sync~spin) Looking for the pull request…')];
  }
  if (!d.pr) {
    return [];
  }
  const match = d.pr.match;
  if (!match) {
    return [info(`$(circle-slash) ${NO_PR}`)];
  }
  const rows = [sep('Pull request'), prRow(d.pr.repoId, match.pr, match.via === 'message' ? 'from commit message' : undefined)];
  return rows;
}

function otherRows(d: TraceData): TraceRow[] {
  const others = d.pr?.match?.others ?? [];
  if (!d.pr || others.length === 0) {
    return [];
  }
  return [sep('Other pull requests with this commit'), ...others.map(o => prRow(d.pr?.repoId ?? '', o))];
}

function workItemRows(d: TraceData): TraceRow[] {
  if (d.loading === 'workItems') {
    return [info('$(sync~spin) Looking for work items…')];
  }
  return d.workItems?.length ? [sep('Work items'), ...d.workItems.map(workItemRow)] : [];
}

/** The rows of the trace list for the current state of the lookup. */
export function traceRows(d: TraceData, nowMs: number): TraceRow[] {
  if (d.shallow) {
    const text = `Shallow clone: history ends at ${shortSha(d.line.sha)}, so the real commit for this line is unknown. Fetch the full history to look it up`;
    return [info(`$(warning) ${text}`)];
  }
  const rows = [sep('Commit'), commitRow(d, nowMs)];
  if (d.unpublished) {
    rows.push(info('$(cloud-upload) This commit is not pushed yet'));
    return rows;
  }
  if (d.error) {
    // What was found before the failing step stays visible (a pull request is still useful without its work items).
    return [...rows, ...prRows(d), ...workItemRows(d), ...otherRows(d), info(`$(error) ${cleanText(d.error, 200)}`)];
  }
  return [...rows, ...prRows(d), ...workItemRows(d), ...otherRows(d)];
}

const NOT_TRACEABLE: Partial<Record<LineLookup['state'], (file: string) => string>> = {
  untrusted: () => 'Tracing a line runs git, which is off in an untrusted workspace.',
  untracked: file => `${file} is not tracked by git yet.`,
  uncommitted: () => 'This line is not committed yet.',
  noLine: () => 'There is no line here to trace.',
  tooBig: file => `${file} is too big to trace with unsaved changes. Save it first.`,
  saveToBlame: file => `Save ${file} to trace this line: it has unsaved changes and is not UTF-8.`,
};

/** The notification text for the explicit command when there is nothing to trace. */
export function stateMessage(lookup: LineLookup, fileName: string, orgUrl: string | undefined): string | undefined {
  const file = cleanText(fileName, 80);
  if (lookup.state === 'notAdo') {
    return `${file} is not in a clone of an Azure Repos repository of ${orgUrl ? cleanText(orgUrl, 200) : 'the configured organization'}, so there is nothing to look up.`;
  }
  if (lookup.state === 'error') {
    return cleanText(lookup.message, 200);
  }
  return NOT_TRACEABLE[lookup.state]?.(file);
}

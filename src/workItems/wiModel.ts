import { IdentityRef, WorkItem, WorkItemTypeField, WorkItemUpdate } from '../types';
import { asText } from '../util';

export const PARENT_REL = 'System.LinkTypes.Hierarchy-Reverse';
export const CHILD_REL = 'System.LinkTypes.Hierarchy-Forward';
export const RELATED_REL = 'System.LinkTypes.Related';

/** Work item ID at the end of a relation URL, e.g. ".../_apis/wit/workItems/42". */
export function relationId(url: string): number | undefined {
  const m = /\/workItems\/(\d+)$/i.exec(url);
  return m ? Number(m[1]) : undefined;
}

/** Parent, children and related items of a work item, by ID. */
export function hierarchyOf(w: WorkItem): { parent?: number; children: number[]; related: number[] } {
  const ids = (rel: string) => (w.relations ?? []).filter(r => r.rel === rel).map(r => relationId(r.url)).filter((x): x is number => x !== undefined);
  return { parent: ids(PARENT_REL)[0], children: ids(CHILD_REL), related: ids(RELATED_REL) };
}

/** Numeric planning fields shown as inputs when the work item type has them. */
export const NUMBER_FIELDS: [string, string][] = [
  ['Microsoft.VSTS.Scheduling.StoryPoints', 'Story points'],
  ['Microsoft.VSTS.Scheduling.Effort', 'Effort'],
  ['Microsoft.VSTS.Scheduling.Size', 'Size'],
  ['Microsoft.VSTS.Scheduling.OriginalEstimate', 'Original estimate'],
  ['Microsoft.VSTS.Scheduling.RemainingWork', 'Remaining work'],
  ['Microsoft.VSTS.Scheduling.CompletedWork', 'Completed work'],
];

/** Fields with a fixed list of values shown as dropdowns when the type has them. */
export const CHOICE_FIELDS: [string, string][] = [
  ['Microsoft.VSTS.Common.Priority', 'Priority'],
  ['Microsoft.VSTS.Common.Severity', 'Severity'],
  ['Microsoft.VSTS.Common.ValueArea', 'Value area'],
  ['Microsoft.VSTS.Common.Activity', 'Activity'],
];

export interface EditableField {
  ref: string;
  label: string;
  kind: 'number' | 'choice';
  options?: string[];
}

/** The planning fields a work item type supports, in display order. */
export function editableFields(typeFields: WorkItemTypeField[]): EditableField[] {
  const byRef = new Map(typeFields.map(f => [f.referenceName, f]));
  const out: EditableField[] = [];
  for (const [ref, label] of CHOICE_FIELDS) {
    const f = byRef.get(ref);
    if (f?.allowedValues?.length) {
      out.push({ ref, label, kind: 'choice', options: f.allowedValues.map(String) });
    }
  }
  for (const [ref, label] of NUMBER_FIELDS) {
    if (byRef.has(ref)) {
      out.push({ ref, label, kind: 'number' });
    }
  }
  return out;
}

/** "a; b ;c" → ["a", "b", "c"]; and back with joinTags. */
export function splitTags(tags: unknown): string[] {
  return asText(tags).split(/[;,]/).map(t => t.trim()).filter(Boolean);
}

export function joinTags(tags: string[]): string {
  return [...new Set(tags.map(t => t.trim()).filter(Boolean))].join('; ');
}

/** Text without HTML tags (each tag becomes a space). */
export function stripTags(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') {
      inTag = true;
    } else if (ch === '>' && inTag) {
      inTag = false;
      out += ' ';
    } else if (!inTag) {
      out += ch;
    }
  }
  return out;
}

/** Short readable form of a field value for the history. */
export function valueText(v: unknown): string {
  if (v === undefined || v === null || v === '') {
    return '∅';
  }
  if (typeof v === 'object' && 'displayName' in (v as object)) {
    return String((v as IdentityRef).displayName);
  }
  const s = stripTags(asText(v)).replaceAll('&nbsp;', ' ').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

/** Fields that change with every revision and only add noise to the history. */
const NOISE = new Set(['System.Rev', 'System.ChangedDate', 'System.ChangedBy', 'System.RevisedDate', 'System.AuthorizedDate',
  'System.AuthorizedAs', 'System.PersonId', 'System.Watermark', 'System.IsDeleted', 'System.CommentCount',
  'Microsoft.VSTS.Common.StateChangeDate', 'System.BoardColumnDone', 'System.AcceleratedCardData']);

export interface HistoryEntry {
  rev: number;
  by: string;
  date?: string;
  changes: { field: string; from: string; to: string }[];
  links: string[];
}

/** Revisions newest first, each with its readable field and link changes; empty revisions are left out. */
export function historyEntries(updates: WorkItemUpdate[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const u of updates) {
    const changes = Object.entries(u.fields ?? {})
      .filter(([name]) => !NOISE.has(name) && !name.startsWith('WEF_'))
      .map(([name, v]) => ({ field: fieldLabel(name), from: valueText(v.oldValue), to: valueText(v.newValue) }));
    const linkText = (verb: string, r: { rel: string; url: string }) => {
      const id = relationId(r.url);
      return id ? `${verb} ${linkLabel(r.rel)} #${id}` : `${verb} ${linkLabel(r.rel)}`;
    };
    const links = [
      ...(u.relations?.added ?? []).map(r => linkText('Added', r)),
      ...(u.relations?.removed ?? []).map(r => linkText('Removed', r)),
    ];
    if (changes.length || links.length) {
      out.push({
        rev: u.rev, by: u.revisedBy?.displayName ?? '', changes, links,
        date: asText(u.fields?.['System.ChangedDate']?.newValue ?? u.revisedDate),
      });
    }
  }
  return out.reverse();
}

function fieldLabel(ref: string): string {
  const known: Record<string, string> = {
    'System.AssignedTo': 'Assigned to', 'System.IterationPath': 'Iteration', 'System.AreaPath': 'Area', 'System.WorkItemType': 'Type',
    'System.BoardColumn': 'Board column', 'Microsoft.VSTS.Common.Priority': 'Priority', 'System.Tags': 'Tags',
  };
  return known[ref] ?? ref.split('.').pop()!.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function linkLabel(rel: string): string {
  if (rel === PARENT_REL) { return 'parent'; }
  if (rel === CHILD_REL) { return 'child'; }
  if (rel === RELATED_REL) { return 'related link'; }
  if (rel === 'ArtifactLink') { return 'artifact link'; }
  if (rel === 'Hyperlink') { return 'hyperlink'; }
  return 'link';
}

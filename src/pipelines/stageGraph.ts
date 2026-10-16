/**
 * Stage dependencies of a pipeline run. Azure DevOps' timeline has no dependency information, so they come
 * from the run's expanded YAML (`stages[].dependsOn`) and, where that is not available, from start and finish times.
 */

/** Stage name → explicit dependencies, or null for "the previous stage" (no dependsOn). Order = YAML order. */
export type YamlStageDeps = Map<string, string[] | null>;

interface Line {
  indent: number;
  text: string;
}

function lines(yaml: string): Line[] {
  return yaml.split(/\r?\n/)
    .map(raw => ({ indent: raw.length - raw.trimStart().length, text: raw.trim() }))
    .filter(l => l.text && !l.text.startsWith('#'));
}

/** Drops a trailing "# comment" and surrounding quotes. */
function unquote(s: string): string {
  const hash = s.search(/\s#/);
  const t = (hash >= 0 ? s.slice(0, hash) : s).trim();
  const q = t[0];
  return t.length >= 2 && (q === '"' || q === "'") && t.endsWith(q) ? t.slice(1, -1) : t;
}

/** Inline value of `dependsOn:`: "A", "[A, B]" or "[]"; undefined when it continues on the next lines. */
function inlineList(value: string): string[] | undefined {
  const v = unquote(value);
  if (!v) {
    return undefined;
  }
  if (v.startsWith('[')) {
    return v.slice(1, v.lastIndexOf(']')).split(',').map(unquote).filter(Boolean);
  }
  return [v];
}

/**
 * Reads `stages:` with their names and `dependsOn` from pipeline YAML. Returns undefined when there is no stage
 * list or it uses templates or expressions that only the server can resolve.
 */
export function parseStageDependencies(yaml: string): YamlStageDeps | undefined {
  const ls = lines(yaml);
  const start = ls.findIndex(l => l.text === 'stages:');
  if (start < 0) {
    return undefined;
  }
  const keyIndent = ls[start].indent;
  const first = ls[start + 1];
  if (!first?.text.startsWith('- ') || first.indent < keyIndent) {
    return undefined;
  }
  const itemIndent = first.indent;
  const out: YamlStageDeps = new Map();
  // The list may be indented below "stages:" or start at the same column.
  const inBlock = (l: Line) => l.indent > keyIndent || (l.indent === keyIndent && itemIndent === keyIndent && l.text.startsWith('- '));
  let i = start + 1;
  while (i < ls.length && inBlock(ls[i])) {
    if (ls[i].indent !== itemIndent || !ls[i].text.startsWith('- ')) {
      i++;
      continue;
    }
    // One stage item: the "- " line plus every deeper line.
    const item: Line[] = [{ indent: itemIndent + 2, text: ls[i].text.slice(2).trim() }];
    i++;
    while (i < ls.length && ls[i].indent > itemIndent) {
      item.push(ls[i]);
      i++;
    }
    const parsed = parseStageItem(item, itemIndent + 2);
    if (!parsed) {
      return undefined;
    }
    out.set(parsed.name, parsed.deps);
  }
  return out.size ? out : undefined;
}

function parseStageItem(item: Line[], keyIndent: number): { name: string; deps: string[] | null } | undefined {
  let name: string | undefined;
  let deps: string[] | null = null;
  for (let j = 0; j < item.length; j++) {
    const l = item[j];
    if (l.indent !== keyIndent) {
      continue;
    }
    const colon = l.text.indexOf(':');
    const key = colon > 0 ? l.text.slice(0, colon) : '';
    if (!/^[\w$.{}]+$/.test(key)) {
      continue;
    }
    const value = l.text.slice(colon + 1).trim();
    if (key === 'template' || key.startsWith('${{')) {
      return undefined;
    }
    if (key === 'stage') {
      name = unquote(value);
    } else if (key === 'dependsOn') {
      deps = inlineList(value) ?? blockList(item, j + 1, keyIndent);
    }
  }
  return name ? { name, deps } : undefined;
}

function blockList(item: Line[], from: number, keyIndent: number): string[] {
  const out: string[] = [];
  // The list may be indented below the key or start at the key's column.
  for (let k = from; k < item.length && (item[k].indent > keyIndent || item[k].text.startsWith('- ')); k++) {
    if (item[k].text.startsWith('- ')) {
      out.push(unquote(item[k].text.slice(2)));
    }
  }
  return out;
}

export interface StageInfo {
  id: string;
  /** stage name from the YAML; the display name may differ */
  identifier?: string;
  start?: string | null;
  finish?: string | null;
}

/**
 * Dependencies (stage IDs) per stage ID. `stages` are in timeline order. With YAML, dependencies follow
 * `dependsOn` (no dependsOn = previous stage in the YAML); otherwise they are inferred from times.
 */
export function stageDependencies(stages: StageInfo[], yaml?: YamlStageDeps): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const byName = new Map(stages.filter(s => s.identifier).map(s => [s.identifier!.toLowerCase(), s.id]));
  const yamlOrder = yaml ? [...yaml.keys()] : [];
  stages.forEach((s, i) => {
    const key = s.identifier && yaml ? yamlOrder.find(n => n.toLowerCase() === s.identifier!.toLowerCase()) : undefined;
    if (key !== undefined) {
      const explicit = yaml!.get(key);
      const pos = yamlOrder.indexOf(key);
      const names = explicit ?? (pos >= 1 ? [yamlOrder[pos - 1]] : []);
      out.set(s.id, names.map(n => byName.get(n.toLowerCase())).filter((x): x is string => !!x));
    } else {
      out.set(s.id, inferred(stages, i, out));
    }
  });
  return out;
}

/**
 * Without YAML: a stage that has not started waits for the previous one. A started stage depends on the
 * stages that had finished before it started and that no other of those depends on (fan-in after parallel stages).
 */
function inferred(stages: StageInfo[], i: number, known: Map<string, string[]>): string[] {
  if (i === 0) {
    return [];
  }
  const started = stages[i].start ? Date.parse(stages[i].start!) : undefined;
  if (started === undefined) {
    return [stages[i - 1].id];
  }
  const before = stages.slice(0, i).filter(p => p.finish && Date.parse(p.finish) <= started + 1000);
  const covered = new Set(before.flatMap(p => known.get(p.id) ?? []));
  return before.filter(p => !covered.has(p.id)).map(p => p.id);
}

/** Column per stage: 0 for stages without dependencies, else one more than the deepest dependency. */
export function stageColumns(order: string[], deps: Map<string, string[]>): Map<string, number> {
  const col = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = col.get(id);
    if (known !== undefined) {
      return known;
    }
    if (seen.has(id)) {
      return 0; // cycle guard
    }
    seen.add(id);
    const ds = deps.get(id) ?? [];
    const c = ds.length ? Math.max(...ds.map(d => visit(d, seen))) + 1 : 0;
    col.set(id, c);
    return c;
  };
  order.forEach(id => visit(id, new Set()));
  return col;
}

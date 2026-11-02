/**
 * Texts from the task catalog that end up in hovers, completions and the designer: help without Markdown links, and
 * a link target that is safe to put into Markdown. Pure (no vscode), so the designer's helpers can use it.
 */

const MAX_HELP = 800;

/** Text of a `helpMarkDown` without Markdown links and images: only the link text stays. Linear, no regexes. */
export function plainHelp(markdown: string): string {
  const s = markdown.slice(0, MAX_HELP * 2);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const link = s[i] === '!' && s[i + 1] === '[' ? linkAt(s, i + 1) : undefined;
    const text = s[i] === '[' ? linkAt(s, i) : undefined;
    if (link) {
      i = link.after;
    } else if (text) {
      out += s.slice(i + 1, text.close);
      i = text.after;
    } else {
      out += s[i];
      i++;
    }
  }
  return out.trim().slice(0, MAX_HELP);
}

/** `[text](url)` starting at `open`: where the text ends and what follows the link. */
function linkAt(s: string, open: number): { close: number; after: number } | undefined {
  const close = s.indexOf(']', open + 1);
  if (close < 0 || s[close + 1] !== '(') {
    return undefined;
  }
  const end = s.indexOf(')', close + 2);
  return end < 0 ? undefined : { close, after: end + 1 };
}

/** The link target when it is an `https:` URL, else undefined. Brackets and parentheses are escaped for Markdown. */
export function safeHelpUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.href.replaceAll('(', '%28').replaceAll(')', '%29').replaceAll('[', '%5B').replaceAll(']', '%5D') : undefined;
  } catch {
    return undefined;
  }
}

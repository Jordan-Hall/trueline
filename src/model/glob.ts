/**
 * Pure deterministic POSIX glob matcher supporting `*`, `**`, `?`, and `{a,b}`.
 * Runtime-agnostic (works identically on Node.js and Bun).
 */

const globCache = new Map<string, RegExp>();

export function matchGlob(pattern: string, candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/');
  let regex = globCache.get(pattern);
  if (regex === undefined) {
    regex = compileGlob(pattern);
    globCache.set(pattern, regex);
  }
  return regex.test(normalized);
}

function compileGlob(pattern: string): RegExp {
  const src = pattern.replaceAll('\\', '/');
  let out = '^';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '*' && src[i + 1] === '*') {
      if (src[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      out += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (ch === '{') {
      const close = src.indexOf('}', i + 1);
      if (close !== -1) {
        const alts = src
          .slice(i + 1, close)
          .split(',')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        out += `(?:${alts.join('|')})`;
        i = close + 1;
      } else {
        out += '\\{';
        i += 1;
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  out += '$';
  return new RegExp(out);
}

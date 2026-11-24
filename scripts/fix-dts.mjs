/**
 * Rewrites relative `.ts` import specifiers in emitted `.d.ts` files to `.js`
 * so TypeScript consumers using NodeNext / Node16 module resolution compile cleanly.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function walkDts(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...walkDts(full));
    } else if (entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const distDir = join(process.cwd(), 'dist');
for (const file of walkDts(distDir)) {
  const original = readFileSync(file, 'utf8');
  const rewritten = original.replace(
    /((?:from|import\s*\()\s*['"]\.\.?\/[^'"]+)\.ts(['"])/g,
    '$1.js$2',
  );
  if (rewritten !== original) {
    writeFileSync(file, rewritten, 'utf8');
  }
}

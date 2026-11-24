// Bundles film.src.js with three.js and timing.json into one self-contained film.html.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = process.env.TOOLS_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'trueline-film-tools');
const requireFromTools = createRequire(join(toolsDir, 'package.json'));
const esbuild = requireFromTools('esbuild');
const threePath = join(toolsDir, 'node_modules/three/build/three.module.js');
const timing = JSON.parse(readFileSync(join(here, 'timing.json'), 'utf8'));

const out = await esbuild.build({
  entryPoints: [join(here, 'film.src.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  write: false,
  target: 'chrome120',
  alias: { three: threePath },
  legalComments: 'none',
});

const js = out.outputFiles[0].text.replaceAll('</script', '<\\/script');
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>trueline-lint v1</title></head>
<body><script>window.__TIMING__=${JSON.stringify(timing)};</script>
<script>${js}</script></body></html>
`;
writeFileSync(join(here, 'film.html'), html, 'utf8');
console.log('built film.html:', (html.length / 1024).toFixed(0), 'KiB');

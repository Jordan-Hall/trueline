// Renders film.html frame-by-frame on the GPU (Playwright Chrome) into silent 1080p H.264.
// Usage:
//   node scripts/film/render.mjs stills <outDir>
//   node scripts/film/render.mjs video  <out.mp4> [workers]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = process.env.TOOLS_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'trueline-film-tools');
const { chromium } = createRequire(join(toolsDir, 'package.json'))('playwright-core');
const timing = JSON.parse(readFileSync(join(here, 'timing.json'), 'utf8'));
const FPS = timing.fps;
const N = timing.frames;
const url = pathToFileURL(join(here, 'film.html')).href;
const [mode, out, a] = process.argv.slice(2);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});

async function openPage() {
  const p = await browser.newPage({ viewport: { width: timing.size[0], height: timing.size[1] } });
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  p.on('console', (m) => (m.type() === 'error' ? console.error('console', m.text()) : null));
  await p.goto(url);
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  return p;
}

const grab = (p, f, q = 0.94) =>
  p
    .evaluate(([t, quality]) => window.grab(t, quality), [f / FPS, q])
    .then((s) => Buffer.from(s, 'base64'));

if (mode === 'stills') {
  mkdirSync(out, { recursive: true });
  const p = await openPage();
  const picks = [
    ['01-meet', 60],
    ['02-code', 240],
    ['03-cycles', 420],
    ['04-cut', 540],
    ['05-deep', 675],
    ['06-layers', 905],
    ['07-slop', 1120],
    ['08-dash', 1520],
    ['09-tamper', 1800],
    ['10-ratchet', 2075],
    ['11-finale', 2280],
  ];
  for (const [name, f] of picks) {
    writeFileSync(join(out, `${name}.jpg`), await grab(p, f, 0.92));
  }
  console.log('rendered', picks.length, 'stills to', out);
} else if (mode === 'video') {
  const workers = Number(a ?? 4);
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(FPS),
      '-c:v',
      'mjpeg',
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-preset',
      'medium',
      '-crf',
      '15',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(FPS),
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );

  const pages = await Promise.all(Array.from({ length: workers }, openPage));
  const pending = new Map();
  let next = 0;
  let written = 0;
  const startMs = Date.now();

  async function flush() {
    while (pending.has(written)) {
      const buf = pending.get(written);
      pending.delete(written);
      written += 1;
      if (!ff.stdin.write(buf)) {
        await new Promise((r) => ff.stdin.once('drain', r));
      }
      if (written % 300 === 0 || written === N) {
        const secs = ((Date.now() - startMs) / 1000).toFixed(1);
        console.log(`frames ${written}/${N} (${secs}s)`);
      }
    }
  }

  let flushing = Promise.resolve();
  async function worker(p) {
    for (;;) {
      const f = next++;
      if (f >= N) return;
      while (f - written > workers * 6) await new Promise((r) => setTimeout(r, 5));
      pending.set(f, await grab(p, f, 0.94));
      flushing = flushing.then(flush);
    }
  }

  await Promise.all(pages.map(worker));
  await flushing;
  ff.stdin.end();
  const code = await new Promise((r) => ff.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
  console.log('rendered silent video:', out);
}

await browser.close();

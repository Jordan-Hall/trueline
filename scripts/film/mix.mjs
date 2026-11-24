// Mixes silent 1080p MP4 with Kokoro British English narration, warm acoustic/plucked soundtrack,
// tactile foley SFX, sidechain voice-ducking, two-pass -14 LUFS mastering, and generates preview GIF.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [silent, voiceDir, outMp4, outGif] = process.argv.slice(2);
if (!silent || !voiceDir || !outMp4) {
  throw new Error('usage: node mix.mjs <silent.mp4> <voiceDir> <out.mp4> [out.gif]');
}

const timing = JSON.parse(readFileSync(join(here, 'timing.json'), 'utf8'));
const FPS = timing.fps;
const SR = 48000;
const TAU = Math.PI * 2;
const totalSec = timing.frames / FPS;
const total = Math.ceil(totalSec * SR);
const mixBus = () => new Float32Array(total);

function readWav(path) {
  const buf = readFileSync(path);
  let pos = 12;
  let dataStart = 44;
  let dataLen = buf.length - 44;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const len = buf.readUInt32LE(pos + 4);
    if (id === 'data') {
      dataStart = pos + 8;
      dataLen = len;
      break;
    }
    pos += 8 + len + (len & 1);
  }
  const n = Math.floor(dataLen / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  return out;
}

function writeWavStereo(path, L, R) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

let seed = 1337;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296) * 2 - 1;
};
const env = (x, a, d) => (x < 0 ? 0 : x < a ? x / a : Math.exp(-(x - a) / d));
const sine = (f, x) => Math.sin(TAU * f * x);
const sweep = (f0, f1, dur, x) => Math.sin(TAU * (f0 + (f1 - f0) * Math.min(1, Math.max(0, x / dur)) * 0.5) * x);
const lp = (alpha) => {
  let y = 0;
  return (x) => (y += alpha * (x - y));
};
function add(bus, t0, dur, fn, gain = 1) {
  const s0 = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n; i += 1) {
    const idx = s0 + i;
    if (idx >= 0 && idx < bus.length) bus[idx] += fn(i / SR) * gain;
  }
}

const SFX = {
  hop: (b, t) => add(b, t, 0.18, (x) => sweep(220, 480, 0.16, x) * env(x, 0.005, 0.05), 0.45),
  land: (b, t) => {
    add(b, t, 0.15, (x) => sweep(170, 75, 0.12, x) * env(x, 0.002, 0.04), 0.6);
    const f = lp(0.25);
    add(b, t, 0.08, (x) => f(rnd()) * env(x, 0.002, 0.025), 0.25);
  },
  whoosh: (b, t) => {
    const f = lp(0.18);
    add(b, t, 0.32, (x) => f(rnd()) * Math.sin((Math.PI * x) / 0.32) ** 1.6, 0.32);
  },
  snap: (b, t) => {
    const f = lp(0.75);
    add(b, t, 0.06, (x) => f(rnd()) * env(x, 0.0005, 0.01), 0.72);
    add(b, t, 0.22, (x) => sweep(1400, 520, 0.14, x) * env(x, 0.001, 0.04), 0.48);
  },
  chime: (b, t) => {
    for (const [fr, g] of [
      [587.33, 0.34],
      [880.0, 0.26],
      [1174.66, 0.17],
    ]) {
      add(b, t, 0.55, (x) => sine(fr, x) * env(x, 0.002, 0.18), g);
    }
  },
  bonk: (b, t) => {
    add(b, t, 0.28, (x) => sweep(215, 95, 0.24, x) * env(x, 0.001, 0.07), 0.85);
    add(b, t, 0.1, (x) => sine(660, x) * env(x, 0.001, 0.015), 0.32);
  },
  click: (b, t) => {
    const f = lp(0.6);
    add(b, t, 0.03, (x) => f(rnd()) * env(x, 0.0005, 0.005), 0.45);
    add(b, t, 0.05, (x) => sine(1320, x) * env(x, 0.0005, 0.008), 0.28);
  },
  clink: (b, t) => {
    for (const fr of [2950, 3920]) {
      add(b, t, 0.35, (x) => sine(fr, x) * env(x, 0.0005, 0.06), 0.22);
    }
  },
};

const sfx = mixBus();
for (const h of timing.hits) {
  if (SFX[h.sound]) SFX[h.sound](sfx, h.frame / FPS);
}

const voice = mixBus();
for (const l of timing.voice.lines) {
  const w = readWav(join(voiceDir, `${l.id}.wav`));
  const s0 = Math.round(l.startSec * SR);
  for (let i = 0; i < w.length && s0 + i < voice.length; i += 1) voice[s0 + i] += w[i];
}

// Warm F major fable soundtrack (F -> Dm -> Bb -> C at 92 bpm)
const beat = 60 / timing.music.bpm;
const bar = beat * 4;
const CH = [
  [349.23, 440, 523.25],
  [293.66, 349.23, 440],
  [233.08, 293.66, 349.23],
  [261.63, 329.63, 392],
];
const ROOT = [87.31, 73.42, 58.27, 65.41];
const music = mixBus();
const outroT = timing.music.outroFrame / FPS;
let hpPx = 0;
let hpPy = 0;
const hp = (x) => {
  hpPy = 0.995 * (hpPy + x - hpPx);
  hpPx = x;
  return hpPy;
};

for (let i = 0; i < total; i += 1) {
  const t = i / SR;
  const inOutro = t >= outroT;
  const bi = Math.floor(t / bar);
  const ci = inOutro ? 0 : bi % 4;
  const tb = t - bi * bar;
  const padEnv = inOutro
    ? Math.exp(-(t - outroT) / 1.8)
    : Math.sin(Math.PI * Math.min(1, tb / bar)) ** 0.6;
  let pad = 0;
  for (const f of CH[ci]) {
    pad += Math.sin(TAU * f * t) * 0.5 + Math.sin(TAU * f * 1.003 * t) * 0.3 + Math.sin(TAU * f * 0.5 * t) * 0.35;
  }
  pad *= padEnv * 0.068;
  const bt = tb % (beat * 2);
  const bass = inOutro ? 0 : Math.sin(TAU * ROOT[ci] * 2 * t) * env(bt, 0.01, 0.48) * 0.12;
  const eighth = beat / 2;
  const ei = Math.floor(t / eighth);
  const te = t - ei * eighth;
  const note = [0, 2, 1, 2, 0, 1, 2, 1][ei % 8];
  const pluck =
    inOutro && t > outroT + 0.15
      ? 0
      : Math.sin(TAU * CH[ci][note] * 2 * t) * env(te, 0.003, 0.11) * 0.058 * (ei % 2 === 0 ? 1 : 0.72);
  music[i] = hp(pad + bass + pluck) * Math.min(1, t / 2.0) * Math.min(1, Math.max(0, (totalSec - t) / 1.4));
}

const L = new Float32Array(total);
const R = new Float32Array(total);
let e = 0;
const att = 1 - Math.exp(-1 / (0.04 * SR));
const rel = 1 - Math.exp(-1 / (0.45 * SR));
for (let i = 0; i < total; i += 1) {
  const a = Math.min(1, Math.abs(voice[i]) * 6);
  e += (a > e ? att : rel) * (a - e);
  const duck = 1 - 0.58 * Math.min(1, e);
  const m = music[i] * duck * 1.55;
  L[i] = voice[i] * 1.08 + sfx[i] * 0.55 + m;
  R[i] = voice[i] * 1.08 + sfx[i] * 0.55 + m;
}

const premix = join(voiceDir, 'premix.wav');
writeWavStereo(premix, L, R);

const run = (args) => {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stderr;
};
const target = 'I=-14:TP=-2.5:LRA=9';
const log = run(['-hide_banner', '-nostats', '-i', premix, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']);
const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
const filt = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,alimiter=limit=0.708:level=disabled:attack=2:release=40,apad=whole_dur=${totalSec}`;

mkdirSync(dirname(outMp4), { recursive: true });
run([
  '-y',
  '-hide_banner',
  '-i',
  silent,
  '-i',
  premix,
  '-map',
  '0:v:0',
  '-map',
  '1:a:0',
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-preset',
  'slow',
  '-crf',
  '24',
  '-pix_fmt',
  'yuv420p',
  '-af',
  filt,
  '-c:a',
  'aac',
  '-b:a',
  '192k',
  '-ar',
  '48000',
  '-t',
  String(totalSec),
  '-movflags',
  '+faststart',
  outMp4,
]);
console.log('mixed final MP4:', outMp4, 'input LUFS:', m.input_i);

if (outGif) {
  mkdirSync(dirname(outGif), { recursive: true });
  const filter = [
    '[0:v]trim=start=1:duration=3,setpts=PTS-STARTPTS[v0]',
    '[0:v]trim=start=15:duration=3,setpts=PTS-STARTPTS[v1]',
    '[0:v]trim=start=28:duration=3,setpts=PTS-STARTPTS[v2]',
    '[0:v]trim=start=46:duration=3,setpts=PTS-STARTPTS[v3]',
    '[0:v]trim=start=61:duration=3,setpts=PTS-STARTPTS[v4]',
    '[0:v]trim=start=72:duration=3,setpts=PTS-STARTPTS[v5]',
    '[v0][v1][v2][v3][v4][v5]concat=n=6:v=1:a=0,fps=8,scale=640:-1:flags=lanczos,split[s0][s1]',
    '[s0]palettegen=max_colors=96:stats_mode=diff[p]',
    '[s1][p]paletteuse=dither=bayer:bayer_scale=3',
  ].join(';');
  run(['-y', '-hide_banner', '-i', outMp4, '-filter_complex', filter, outGif]);
  console.log('generated preview GIF:', outGif);
}

// Generates British English narration WAVs with Kokoro ONNX TTS (offline).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function generateVoice(outDir, voiceArg) {
  const toolsDir = process.env.TOOLS_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'trueline-film-tools');
  const requireFromTools = createRequire(join(toolsDir, 'package.json'));
  const { KokoroTTS } = await import(pathToFileURL(requireFromTools.resolve('kokoro-js')).href);
  const timing = JSON.parse(readFileSync(join(__dirname, 'timing.json'), 'utf8'));
  const { voice: defaultVoice, speed: defaultSpeed, lines } = timing.voice;
  const voice = voiceArg ?? defaultVoice;

  const voiceDir = join(outDir, 'voice');
  mkdirSync(voiceDir, { recursive: true });
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'cpu',
  });

  const durations = {};
  for (const line of lines) {
    const parts = [];
    for (const s of line.sentences) {
      const audio = await tts.generate(s.say ?? s.text, {
        voice,
        speed: s.speed ?? defaultSpeed,
      });
      parts.push({ audio, gap: (s.gapMs ?? 300) / 1000 });
    }
    const rate = parts[0].audio.sampling_rate;
    const chunks = [];
    parts.forEach(({ audio, gap }, i) => {
      chunks.push(audio.audio);
      if (i < parts.length - 1) chunks.push(new Float32Array(Math.round(rate * gap)));
    });
    const all = new Float32Array(chunks.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    const raw = join(voiceDir, `${line.id}.raw.wav`);
    await new parts[0].audio.constructor(all, rate).save(raw);

    const filter = [
      'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.04',
      'areverse',
      'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08',
      'areverse',
      'highpass=f=70',
      'equalizer=f=240:t=q:w=1:g=1.5',
      'equalizer=f=3400:t=q:w=1.2:g=1.3',
      'acompressor=threshold=-24dB:ratio=2.2:attack=8:release=140:makeup=3',
    ].join(',');
    const target = join(voiceDir, `${line.id}.wav`);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af', filter, '-ar', '48000', target]);
    if (r.status !== 0) throw new Error(String(r.stderr));

    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target],
      { encoding: 'utf8' },
    );
    durations[line.id] = Number(Number(probe.stdout).toFixed(3));
  }

  writeFileSync(join(voiceDir, 'manifest.json'), JSON.stringify({ voice, durations }, null, 2));
  console.log(`Rendered ${lines.length} voice lines (${voice}):`, JSON.stringify(durations));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? join(__dirname, '.work'));
  await generateVoice(outDir, process.argv[3]);
}

/**
 * Computes and writes the next semver version for automated push-to-main/master releases.
 *
 * Bump rules from commits since the last tag:
 * - `BREAKING CHANGE` or `<type>!:` -> major
 * - `feat:` / `feat(...):`           -> minor
 * - anything else                    -> patch (every push releases a new version)
 *
 * If `package.json` was manually bumped to a version higher than npm `latest`
 * and not yet published, that explicit version is preserved.
 */

import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function parseSemver(ver) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(ver.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function bumpSemver(ver, kind) {
  const [maj, min, pat] = ver;
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function detectBumpKind() {
  let range = 'HEAD~1..HEAD';
  try {
    const lastTag = execSync('git describe --tags --abbrev=0', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (lastTag) range = `${lastTag}..HEAD`;
  } catch {
    range = 'HEAD';
  }

  let log = '';
  try {
    log = execSync(`git log ${range} --format=%B%n---COMMIT---`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return 'patch';
  }

  const commits = log
    .split('---COMMIT---')
    .map((c) => c.trim())
    .filter(Boolean);

  let kind = 'patch';
  for (const msg of commits) {
    const subject = msg.split(/\r?\n/, 1)[0] ?? '';
    if (/BREAKING CHANGE/.test(msg) || /^[a-z]+(\([^)]+\))?!:/.test(subject)) {
      return 'major';
    }
    if (/^feat(\([^)]+\))?:/.test(subject)) {
      kind = 'minor';
    }
  }
  return kind;
}

async function fetchNpmState(pkgName) {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkgName)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return { latest: null, published: new Set() };
    const data = await res.json();
    const latest =
      typeof data['dist-tags']?.latest === 'string'
        ? data['dist-tags'].latest
        : null;
    const published = new Set(Object.keys(data.versions ?? {}));
    return { latest, published };
  } catch {
    return { latest: null, published: new Set() };
  }
}

const pkgPath = join(process.cwd(), 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const pkgVer = parseSemver(pkg.version);
if (!pkgVer) {
  throw new Error(`Invalid semver in package.json: ${pkg.version}`);
}

const { latest, published } = await fetchNpmState(pkg.name);
const latestVer = latest ? parseSemver(latest) : null;
const bumpKind = detectBumpKind();

let nextVersion;
if (
  latestVer !== null &&
  compareSemver(pkgVer, latestVer) > 0 &&
  !published.has(pkg.version)
) {
  nextVersion = pkg.version;
} else {
  const base =
    latestVer !== null && compareSemver(latestVer, pkgVer) > 0
      ? latestVer
      : pkgVer;
  nextVersion = bumpSemver(base, bumpKind);
  while (published.has(nextVersion)) {
    nextVersion = bumpSemver(parseSemver(nextVersion), 'patch');
  }
}

pkg.version = nextVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${nextVersion}\n`, 'utf8');
}
process.stdout.write(`${nextVersion}\n`);

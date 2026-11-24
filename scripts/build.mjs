// Builds build/com.freesaver.app_<version>_all.ipk
// Photos in ./photos are converted to JPEG (max 3840px) and bundled in.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const stage = join(out, 'app');
const photosIn = join(root, 'photos');
const photosOut = join(stage, 'photos');
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.webp', '.gif', '.bmp']);

rmSync(out, { recursive: true, force: true });
mkdirSync(photosOut, { recursive: true });
cpSync(join(root, 'app'), stage, { recursive: true });

const sources = existsSync(photosIn)
  ? readdirSync(photosIn).filter((f) => !f.startsWith('.') && IMAGE.has(extname(f).toLowerCase())).sort()
  : [];

const manifest = [];
sources.forEach((file, i) => {
  const name = `${String(i + 1).padStart(4, '0')}.jpg`;
  try {
    const input = join(photosIn, file);
    const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', input], { encoding: 'utf8' });
    const longest = Math.max(...[...info.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])));
    const shrink = longest > 3840 ? ['-Z', '3840'] : []; // never enlarge
    execFileSync('sips', [
      '-s', 'format', 'jpeg', '-s', 'formatOptions', '88',
      ...shrink, input, '--out', join(photosOut, name)
    ], { stdio: 'pipe' });
    manifest.push({ src: `photos/${name}`, title: basename(file, extname(file)) });
  } catch (err) {
    console.warn(`  skipped ${file}: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
  }
});
writeFileSync(join(stage, 'photos.json'), JSON.stringify(manifest));
console.log(`${manifest.length} photo(s) bundled` + (manifest.length ? '' : ' (the app will show museum art)'));

// Optional, for tinkerers: FREESAVER_PHOTO_SERVER=1 bakes in the addresses of
// this computer's live photo server (scripts/photo-server.mjs). Off by
// default, so a normal build depends on nothing but the TV.
if (process.env.FREESAVER_PHOTO_SERVER) {
  const port = process.env.FREESAVER_PHOTO_PORT || 8377;
  const hosts = [];
  try { hosts.push(execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim() + '.local'); } catch { /* not macOS */ }
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) hosts.push(a.address);
  }
  writeFileSync(join(stage, 'local.js'),
    `window.FREESAVER_LOCAL = ${JSON.stringify({ photoServers: hosts.map((h) => `http://${h}:${port}`) })};\n`);
}

execFileSync(join(root, 'node_modules', '.bin', 'ares-package'), ['--no-minify', stage, '-o', out], { stdio: 'inherit' });

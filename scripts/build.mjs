// Builds build/com.freesaver.app_<version>_all.ipk
// Photos in ./photos are converted to JPEG (max 3840px) and bundled in.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
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

execFileSync(join(root, 'node_modules', '.bin', 'ares-package'), ['--no-minify', stage, '-o', out], { stdio: 'inherit' });

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const releaseDirectory = path.resolve(import.meta.dirname, '..', 'release');
const packageJson = JSON.parse(await readFile(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
const escapedVersion = String(packageJson.version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = (await readdir(releaseDirectory))
  .filter((name) => new RegExp(`^CompCtrl-(?:Setup|Portable)-${escapedVersion}-.+\\.exe$`, 'i').test(name))
  .sort();

if (!names.length) throw new Error('No CompCtrl Windows executables were found.');

const lines = [];
for (const name of names) {
  const hash = createHash('sha256').update(await readFile(path.join(releaseDirectory, name))).digest('hex');
  const line = `${hash}  ${name}`;
  lines.push(line);
  await writeFile(path.join(releaseDirectory, `${name}.sha256`), `${line}\n`, 'utf8');
}
await writeFile(path.join(releaseDirectory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
console.log(`Created SHA-256 checksums for ${names.length} Windows executables.`);

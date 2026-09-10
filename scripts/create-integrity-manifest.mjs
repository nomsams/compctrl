import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const webRoot = path.join(projectRoot, 'dist', 'client');

async function filesBelow(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

const files = [{
  path: 'native-bridge.ps1',
  sha256: await sha256(path.join(projectRoot, 'companion', 'native-bridge.ps1')),
}];

for (const relative of await filesBelow(webRoot)) {
  files.push({ path: `web/${relative}`, sha256: await sha256(path.join(webRoot, relative)) });
}

await writeFile(
  path.join(projectRoot, 'companion', 'integrity.json'),
  `${JSON.stringify({ version: 1, algorithm: 'sha256', files }, null, 2)}\n`,
  'utf8',
);
console.log(`Created packaged-resource integrity manifest for ${files.length} files.`);

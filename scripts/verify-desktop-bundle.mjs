import fs from 'node:fs';
import path from 'node:path';

const webRoot = path.resolve('dist/client');
const indexPath = path.join(webRoot, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const assetReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((reference) => !/^(?:[a-z]+:|#|data:)/i.test(reference));

if (assetReferences.length === 0) {
  throw new Error('The desktop renderer has no JavaScript or stylesheet references.');
}

for (const reference of assetReferences) {
  if (reference.startsWith('/compctrl/')) {
    throw new Error(`GitHub Pages asset path leaked into the desktop bundle: ${reference}`);
  }
  const assetPath = path.resolve(webRoot, reference.replace(/^\/+/, ''));
  if (!assetPath.startsWith(webRoot + path.sep) || !fs.existsSync(assetPath)) {
    throw new Error(`Desktop renderer asset is missing: ${reference}`);
  }
}

console.log(`Verified ${assetReferences.length} desktop renderer assets.`);

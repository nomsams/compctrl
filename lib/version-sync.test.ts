import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

void test('keeps the PWA cache generation aligned with the application version', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const serviceWorker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(serviceWorker, new RegExp(`compctrl-shell-v${packageJson.version.replaceAll('.', '\\.')}['"]`));
});

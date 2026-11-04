import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(testDir);

const REQUIRED = {
  M1: ['bindings persist', 'rebind', 'UNIQUE(session)', 'managed_mode', 'replay'],
  M2: ['assistant final is delivered', 'follows the binding', 'unbound session produces no output'],
  M3: ['apply subscribes to the host push envelopes', 'falls through next()'],
  M4: ['creates no state', 'corrupt state file', 'future state version', 'missing token disables'],
  M5: ['approval is claimed', 'question returns the selected labels', 'falls through next()'],
  M6: ['transcript parity', 'not echoed back'],
  M7: ['defaults to quiet', 'normal adds tool digests', 'verbose adds thinking digests', 'persists'],
  M8: ['stalled turn', 're-arms after recovery', 'turn/end disarms'],
};

test('[M1–M8] every acceptance requirement has a named test', async () => {
  const files = (await readdir(testDir)).filter((name) => name.endsWith('.test.js'));
  assert.ok(files.length >= 6);
  const sources = await Promise.all(files.map((name) => readFile(join(testDir, name), 'utf8')));
  const combined = sources.join('\n');

  for (const milestone of Object.keys(REQUIRED)) {
    assert.match(combined, new RegExp(`\\[${milestone}\\]`), `${milestone} is missing a named test`);
  }
  for (const [milestone, phrases] of Object.entries(REQUIRED)) {
    for (const phrase of phrases) {
      assert.ok(combined.includes(phrase), `${milestone} coverage is missing "${phrase}"`);
    }
  }
});

test('[package] the bridge keeps zero runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts.test, 'node --test test/');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { hostImport } from '../host-import.js';

function fixture(t, layout, exports) {
  // These fixtures exercise package-root lookup, not Electron's ASAR parser.
  // Real archives are exercised separately by the installed-host test matrix.
  const previousNoAsar = process.noAsar;
  if (process.versions.electron) process.noAsar = true;
  const resourcesPath = mkdtempSync(join(tmpdir(), 'dsh-model-controls-host-'));
  t.after(() => {
    assert.equal(dirname(resolve(resourcesPath)), resolve(tmpdir()));
    assert.ok(basename(resourcesPath).startsWith('dsh-model-controls-host-'));
    try { rmSync(resourcesPath, { recursive: true, force: true }); }
    finally {
      if (previousNoAsar === undefined) delete process.noAsar;
      else process.noAsar = previousNoAsar;
    }
  });
  const packageDir = join(resourcesPath, layout, 'node_modules/@model-controls-fixture/host');
  mkdirSync(join(packageDir, 'api'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@model-controls-fixture/host', type: 'module', exports,
  }));
  writeFileSync(join(packageDir, 'index.js'), 'export const hostLayout = ' + JSON.stringify(layout) + ';');
  writeFileSync(join(packageDir, 'api/test.js'), 'export const protocol = "mock";');
  return resourcesPath;
}

for (const layout of ['app', 'app.asar/dsh', 'app.asar']) {
  test('host imports resolve from running Electron resources: ' + layout, async t => {
    const resourcesPath = fixture(t, layout, { '.': { default: './index.js' } });
    const mod = await hostImport('@model-controls-fixture/host', { resourcesPath });
    assert.equal(mod.hostLayout, layout);
  });
}

test('unpacked host supports import-only pi-ai-style entry points and subpaths', async t => {
  const resourcesPath = fixture(t, 'app', {
    '.': { import: './index.js' }, './api/*': { import: './api/*.js' },
  });
  const mod = await hostImport('@model-controls-fixture/host', { resourcesPath });
  const api = await hostImport('@model-controls-fixture/host/api/test', { resourcesPath });
  assert.equal(mod.hostLayout, 'app');
  assert.equal(api.protocol, 'mock');
});

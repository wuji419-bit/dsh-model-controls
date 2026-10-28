import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Prefer the loader's host packages; the Desktop ASAR fallback avoids installing
// a second copy of the LLM service and its branded types in this local plugin.
export async function hostImport(id) {
  const roots = [import.meta.url];
  if (process.resourcesPath) roots.push(join(process.resourcesPath, 'app.asar/dsh/package.json'));
  roots.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json');
  let last;
  for (const root of roots) {
    try {
      let resolved;
      try { resolved = createRequire(root).resolve(id); }
      catch (error) {
        // pi-ai exports import-only entry points; require.resolve cannot select them.
        if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
        const parts = id.split('/');
        const packageName = id.startsWith('@') ? parts.slice(0,2).join('/') : parts[0];
        const subpath = '.' + id.slice(packageName.length);
        const base = join(dirname(root.startsWith('file:') ? fileURLToPath(root) : root), 'node_modules', packageName);
        const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
        let target = pkg.exports?.[subpath];
        if (!target) for (const [key, value] of Object.entries(pkg.exports ?? {})) {
          if (!key.endsWith('*') || !subpath.startsWith(key.slice(0,-1))) continue;
          const suffix = subpath.slice(key.length-1);
          const entry = typeof value === 'string' ? value : value.import ?? value.default;
          target = entry?.replace('*', suffix); break;
        }
        target = typeof target === 'string' ? target : target?.import ?? target?.default;
        if (!target) throw error;
        resolved = join(base, target);
      }
      return await import(pathToFileURL(resolved).href);
    }
    catch (error) { last = error; }
  }
  throw new Error('plugin cannot load host dependency ' + id, { cause: last });
}

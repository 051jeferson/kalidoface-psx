import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const args of [
  ['--check', 'docs/psx.js'], ['--check', 'docs/sw.js'],
  ['tools/patch.mjs', '--check'], ['tools/fetch-vendor.mjs', '--check'],
  ['tools/test-motion.mjs'], ['tools/test-system.mjs'], ['tools/test-audio.mjs'],
  ['tools/test-mouth.mjs']
]) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}
console.log('All checks passed. docs/ is ready to serve; no bundle was rebuilt.');

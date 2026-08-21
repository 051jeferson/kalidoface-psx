#!/usr/bin/env node
//
// Applies the PSX hooks to the built bundle.
//
// This repo ships only the built bundle, so the PSX layer reaches it by
// rewriting a couple of dozen call sites in minified code. Those edits are
// invisible to git once committed and they do not survive the bundle being
// regenerated - and this project syncs with Glitch, so that happens. When it
// does, psx.js still loads and still does nothing, with no error to explain it.
//
// So the edits live in psx-patches.json instead of in anyone's memory:
//
//   node tools/patch.mjs           apply (safe to re-run; already-applied
//                                  patches are skipped)
//   node tools/patch.mjs --check   report status, exit 1 if any are missing
//
// The bundle is located through docs/index.html rather than by name, so a
// rebuild that changes the content hash still resolves.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'tools', 'psx-patches.json');
const check = process.argv.includes('--check');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function findBundle() {
  const html = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  const m = html.match(/<script[^>]+type="module"[^>]+src="\.\/([^"]+)"/);
  if (!m) throw new Error('no module script tag in docs/index.html');
  return path.join(root, 'docs', m[1]);
}

const bundlePath = findBundle();
if (!fs.existsSync(bundlePath)) {
  console.error(`bundle not found: ${path.relative(root, bundlePath)}`);
  process.exit(1);
}

let src = fs.readFileSync(bundlePath, 'utf8');
const applied = [];
const already = [];
const failed = [];

manifest.patches.forEach((p, i) => {
  const has = src.split(p.replace).length - 1;
  if (has === 1) { already.push(i); return; }
  if (has > 1) { failed.push([i, `already applied ${has} times`]); return; }

  const hits = src.split(p.find).length - 1;
  if (hits === 0) { failed.push([i, 'call site not found']); return; }
  if (hits > 1) { failed.push([i, `call site matches ${hits} places`]); return; }

  // NOT src.replace(find, replace): a string replacement treats $ in the
  // replacement as a substitution pattern, and minified JS is full of them
  // ($$, $&, $`). A replacer function is passed through verbatim.
  src = src.replace(p.find, () => p.replace);
  applied.push(i);
});

const label = (i) => {
  const hook = (manifest.patches[i].replace.match(/window\.PSX\.(\w+)/) || [])[1];
  return `#${String(i).padStart(2, '0')} ${hook ? `PSX.${hook}` : '(continuation)'}`;
};

const rel = path.relative(root, bundlePath).replace(/\\/g, '/');
console.log(`bundle: ${rel}`);
console.log(`  ${already.length} already applied, ${applied.length} ${check ? 'missing' : 'applied'}, ${failed.length} failed`);

// Anything already applied is the boring case; only spell out what moved.
for (const i of applied) console.log(`  ${check ? 'MISSING' : 'patched'}  ${label(i)}`);
for (const [i, why] of failed) console.log(`  FAILED   ${label(i)}: ${why}`);

if (failed.length) {
  console.error('\nSome call sites did not resolve. The bundle has changed enough that');
  console.error('the manifest no longer matches it, and the patches must be re-derived.');
  process.exit(1);
}

if (check) {
  if (applied.length) {
    console.error(`\n${applied.length} patch(es) missing from the bundle. Run: node tools/patch.mjs`);
    process.exit(1);
  }
  console.log('\nAll PSX hooks present.');
  process.exit(0);
}

if (applied.length) {
  fs.writeFileSync(bundlePath, src);
  console.log(`\nWrote ${rel}.`);
} else {
  console.log('\nNothing to do - all PSX hooks already present.');
}

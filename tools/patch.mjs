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

function findFromHtml(re, err) {
  const html = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  const m = html.match(re);
  if (!m) throw new Error(err);
  return path.join(root, 'docs', m[1]);
}

function applyList(filePath, patches, labelOf) {
  if (!patches || !patches.length) {
    return { applied: 0, missing: 0, failed: 0 };
  }
  if (!fs.existsSync(filePath)) {
    console.error(`file not found: ${path.relative(root, filePath)}`);
    process.exit(1);
  }
  let src = fs.readFileSync(filePath, 'utf8');
  const applied = [];
  const already = [];
  const failed = [];

  patches.forEach((p, i) => {
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

  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  console.log(`${rel}`);
  console.log(`  ${already.length} already applied, ${applied.length} ${check ? 'missing' : 'applied'}, ${failed.length} failed`);
  for (const i of applied) console.log(`  ${check ? 'MISSING' : 'patched'}  ${labelOf(patches[i], i)}`);
  for (const [i, why] of failed) console.log(`  FAILED   ${labelOf(patches[i], i)}: ${why}`);

  if (failed.length) {
    console.error('\nSome call sites did not resolve. The bundle has changed enough that');
    console.error('the manifest no longer matches it, and the patches must be re-derived.');
    process.exit(1);
  }

  return { src, applied, already, failed, filePath, rel };
}

const bundlePath = findFromHtml(
  /<script[^>]+type="module"[^>]+src="\.\/([^"]+)"/,
  'no module script tag in docs/index.html'
);
const vendorPath = findFromHtml(
  /<link[^>]+rel="modulepreload"[^>]+href="\.\/([^"]+)"/,
  'no vendor modulepreload in docs/index.html'
);

const hookLabel = (p, i) => {
  const hook = (p.replace.match(/window\.PSX\.(\w+)/) || [])[1];
  return `#${String(i).padStart(2, '0')} ${hook ? `PSX.${hook}` : '(continuation)'}`;
};
const vendorLabel = (p, i) => `#v${String(i).padStart(2, '0')}`;

const main = applyList(bundlePath, manifest.patches, hookLabel);
const vendor = applyList(vendorPath, manifest.vendorPatches || [], vendorLabel);

const missing = main.applied.length + vendor.applied.length;
if (check) {
  if (missing) {
    console.error(`\n${missing} patch(es) missing. Run: node tools/patch.mjs`);
    process.exit(1);
  }
  console.log('\nAll PSX hooks present.');
  process.exit(0);
}

let wrote = 0;
if (main.applied.length) {
  fs.writeFileSync(main.filePath, main.src);
  console.log(`\nWrote ${main.rel}.`);
  wrote++;
}
if (vendor.applied.length) {
  fs.writeFileSync(vendor.filePath, vendor.src);
  console.log(`Wrote ${vendor.rel}.`);
  wrote++;
}
if (!wrote) console.log('\nNothing to do - all patches already present.');

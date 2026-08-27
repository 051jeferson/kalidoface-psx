#!/usr/bin/env node
//
// Downloads the third-party assets the app used to pull from a CDN on every
// cold load, into docs/vendor/.
//
// The target machine is a Raspberry Pi. Mediapipe alone is tens of megabytes of
// wasm and tflite that jsdelivr served on every boot, and sw.js deliberately
// does not cache cross-origin requests - so none of it was ever cached, the
// first frame waited on the network every time, and the app could not run
// offline at all. The fonts were the same story with a worse failure: Kalicon
// draws every icon in the menu, and `font-display: block` means up to three
// seconds of blank UI before a missing one gives up.
//
//   node tools/fetch-vendor.mjs            fetch what is missing
//   node tools/fetch-vendor.mjs --force    re-fetch everything
//   node tools/fetch-vendor.mjs --check    exit 1 if anything is missing
//
// Versions here must match the ones in docs/index.html and the locateFile
// patches in tools/psx-patches.json. A bundle rebuild that bumps Mediapipe
// changes all three.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'docs', 'vendor');
const force = process.argv.includes('--force');
const check = process.argv.includes('--check');

const HOLISTIC = '@mediapipe/holistic@0.5.1635989137';
const FACEMESH = '@mediapipe/face_mesh@0.4.1633559619';
const DRAWING = '@mediapipe/drawing_utils@0.3.1620248257';
const cdn = (pkg, file) => `https://cdn.jsdelivr.net/npm/${pkg}/${file}`;

// pose_landmark_heavy.tflite is deliberately absent: it is 27 MB and only
// modelComplexity 2 asks for it. This fork sends 0 (Lite pose model) or 1.
//
// Both the SIMD and the plain wasm builds are kept. The loader picks between
// them at runtime by feature-detecting the browser, and a machine without wasm
// SIMD would otherwise 404 rather than fall back.
const files = [
  ...[
    'holistic.binarypb',
    'holistic.js',
    'holistic_solution_packed_assets.data',
    'holistic_solution_packed_assets_loader.js',
    'holistic_solution_simd_wasm_bin.data',
    'holistic_solution_simd_wasm_bin.js',
    'holistic_solution_simd_wasm_bin.wasm',
    'holistic_solution_wasm_bin.js',
    'holistic_solution_wasm_bin.wasm',
    'pose_landmark_full.tflite',
    'pose_landmark_lite.tflite',
  ].map((f) => ['mediapipe/holistic/' + f, cdn(HOLISTIC, f)]),

  ...[
    'face_mesh.binarypb',
    'face_mesh.js',
    'face_mesh_solution_packed_assets.data',
    'face_mesh_solution_packed_assets_loader.js',
    'face_mesh_solution_simd_wasm_bin.data',
    'face_mesh_solution_simd_wasm_bin.js',
    'face_mesh_solution_simd_wasm_bin.wasm',
    'face_mesh_solution_wasm_bin.js',
    'face_mesh_solution_wasm_bin.wasm',
  ].map((f) => ['mediapipe/face_mesh/' + f, cdn(FACEMESH, f)]),

  ['mediapipe/drawing_utils/drawing_utils.js', cdn(DRAWING, 'drawing_utils.js')],

  // The three faces global.css asks for. Same host as the favicons, and the
  // icon font is the one that matters: without it every menu glyph renders as
  // the literal string its <i> contains.
  ['font/kalidoface-jelly.ttf', 'https://yeemachine.github.io/k2021/font/kalidoface-jelly.ttf'],
  ['font/kalidoface-regular.woff', 'https://yeemachine.github.io/k2021/font/kalidoface-regular.woff'],
  ['font/kalidoface-variable.ttf', 'https://yeemachine.github.io/k2021/font/kalidoface-variable.ttf'],

  // Favicon, PWA icons and the social card. Small, and the manifest is
  // unreadable to an offline install without them.
  ['icon/icon-circle.svg', 'https://yeemachine.github.io/k2021/favicon/kalidoface3d/icon-circle.svg'],
  ['icon/apple-icon-180.png', 'https://yeemachine.github.io/k2021/favicon/kalidoface3d/apple-icon-180.png'],
  ['icon/manifest-icon-192.png', 'https://yeemachine.github.io/k2021/favicon/kalidoface3d/manifest-icon-192.png'],
  ['icon/manifest-icon-512.png', 'https://yeemachine.github.io/k2021/favicon/kalidoface3d/manifest-icon-512.png'],
];

function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

const missing = files.filter(([rel]) => !fs.existsSync(path.join(vendor, rel)));

if (check) {
  if (missing.length) {
    console.error(`${missing.length} vendored file(s) missing. Run: node tools/fetch-vendor.mjs`);
    for (const [rel] of missing) console.error('  ' + rel);
    process.exit(1);
  }
  console.log(`All ${files.length} vendored files present.`);
  process.exit(0);
}

const want = force ? files : missing;
if (!want.length) {
  console.log(`Nothing to do - all ${files.length} files already in docs/vendor/.`);
  process.exit(0);
}

let total = 0;
for (const [rel, url] of want) {
  const dest = path.join(vendor, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  process.stdout.write(`  ${rel} ... `);
  const res = await fetch(url);
  if (!res.ok) {
    console.log('FAILED');
    console.error(`\n${url}\n  responded ${res.status}. Nothing was written for this file.`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  total += buf.length;
  console.log(mb(buf.length));
}

console.log(`\nWrote ${want.length} file(s), ${mb(total)}, into docs/vendor/.`);

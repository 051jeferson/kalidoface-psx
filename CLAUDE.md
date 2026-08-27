# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the long-form version of this file: layout, the hook-adding
procedure and every hard-won convention in `docs/psx.js`. Read it before
changing tracking, the arm retarget, calibration or the bundle patches.
`README.md` documents the product behaviour and every setting.

## Target hardware: Raspberry Pi

This app is meant to run on a Raspberry Pi in Chromium, on top of Mediapipe
inference and a WebGL render loop. That is the budget every change is measured
against — a change that only feels fine on a desktop is not done.

- **Keep the per-frame path allocation-free.** `frame()`, `tick`, `face`, `pose`,
  `arm` and `smooth` run every rendered frame, forever. Reuse objects made once
  (`armInfo` is the model for this), do rounding and formatting only in the
  readouts, and never build arrays or strings in a hot path.
- **Do work once, not per frame.** Anything derived from landmarks is memoised on
  `imgSeq`; anything read off a model that does not move (`armSeg`, `headHeight`)
  is read on model load. Follow that pattern rather than recomputing.
- **Spend nothing on the GPU that the PS1 did not have.** No extra full-scene
  passes, no post-processing, no shadow maps, no antialiasing, no mipmaps. Render
  scale and the rate caps are the levers; `perfAuto` sheds tracking rate on its own.
- **No new dependencies and no build step.** `docs/psx.js` is a plain classic
  script; adding a library means shipping and parsing more bytes on an ARM CPU.
- **Nothing loads from a CDN.** Mediapipe, the fonts and the icons are vendored
  into `docs/vendor/` and served from this origin, so a cold start does not wait
  on a third party and the app runs with no network at all. `sw.js` caches every
  successful same-origin response, so the second load comes off disk.
- **No polling.** No `setInterval` watchdogs, no `MutationObserver` left running,
  no DOM reads inside the render loop. Event-driven or nothing.
- **Keep the code clean:** small named functions, comments that explain the
  constraint rather than the walk-through, dead options deleted instead of hidden
  behind a flag.

## Working shape of the repo

There is **no app source tree**. `src/` is gitignored upstream leftover. The
running app is the built static site in `docs/`:

- `docs/psx.js` — the whole fork. This is where you edit.
- `docs/index.html` — defines a stub `window.PSX` with stock behaviour first, so a
  404 or parse error in `psx.js` cannot TypeError the render loop; loads `psx.js`,
  then the hashed bundle.
- `docs/assets/index.*.js` — the minified Kalidoface bundle. Never hand-edit.
- `docs/vendor/` — ~55 MB of Mediapipe wasm/tflite, the three fonts and the PWA
  icons, all committed. `node tools/fetch-vendor.mjs` repopulates it.
- `tools/patch.mjs` + `tools/psx-patches.json` — the 48 find/replace pairs that
  make the bundle call back into `window.PSX` (40 call sites) and point its
  `locateFile` at `docs/vendor/`.

## Commands

```bash
# serve the app (webcam needs localhost, not file://)
python -m http.server 5173 --bind 127.0.0.1 --directory docs

node tools/patch.mjs           # apply hooks; applied ones are skipped
node tools/patch.mjs --check   # exit 1 if a call site is missing

node tools/fetch-vendor.mjs         # refill docs/vendor/ from the source CDNs
node tools/fetch-vendor.mjs --check # exit 1 if a vendored file is missing
```

Never run `npm run dev` / `npm run build` / `vite`. Root `index.html` imports the
missing `./src/main.js`, and a Vite build overwrites `docs/` and drops the patches.
`node_modules` is not needed to run or edit. There is no test suite; verification
is `--check` plus `PSX.verify()` / `PSX.perf()` / `PSX.armInfo()` in the browser
console.

## Architecture in one pass

The bundle is stock Kalidoface 3D with call sites patched to ask `window.PSX`
first — renderer setup, AA, shadows, the tracking rAF, the face rig, the arm rig,
the preview canvas, the subnav overlay. `psx.js` answers those and owns:

- **PS1 look** — injected in `onBeforeCompile` (vertex snap, affine UV, dither), so
  it needs no call site.
- **Texture-atlas faces** — expressions are UV-offset cell swaps on `_MainTex_ST`,
  not blendshapes; `PSX.tick` drives them.
- **Arm retarget** — `PSX.pose` captures holistic world/image/hand landmarks and
  `PSX.arm` rebuilds shoulder/elbow/wrist from rest quaternions, returning `true`
  to suppress the stock Euler rig.
- **Calibration wizards** — one state machine (`calRun.kind`) over `face`, `motion`
  and `mouth`, with spoken prompts driven off the same translated strings.
- **Settings** — `localStorage` key `kf3d.psx`. A new key needs `DEFAULTS`, `SPEC`
  (if it reaches WebGL or could brick the page), the widget, and both `PT` / `EN`
  strings. English UI strings are the i18n keys.

Adding a bundle hook is a five-step procedure (patch pair, `EXPECTED_HOOKS` bump,
stub in `index.html`, real implementation, `--check`) — see AGENTS.md, which also
records the failure modes of getting it half-right.

## Git

Working branch is `glitch` (Glitch sync). `origin` is this fork; `upstream` is
yeemachine/kalidoface-3d.

- **Never `git push` unless explicitly asked.** Commit locally and stop there.
- Commits: `feat:` / `fix:` plus a short description of the user-visible change.
- Do not commit an unpatched bundle: if the module `src` hash in
  `docs/index.html` changed, run the patcher before calling the change done.

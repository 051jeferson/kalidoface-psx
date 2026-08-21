# Kalidoface PSX

> **This is a fork of [yeemachine/kalidoface-3d](https://github.com/yeemachine/kalidoface-3d), retuned for PSX / low-poly VRM models.**
>
> Stock Kalidoface 3D targets smooth, modern VRM avatars: 2x pixel ratio, MSAA + SMAA,
> linear/mipmapped textures and blendshape-driven faces. PSX-era models want the
> opposite — hard pixels, nearest-neighbour texels, and faces animated by *swapping
> texture cells* (UV offsets on a face atlas) instead of morph targets.
> This fork adds a compatibility layer, `docs/psx.js`, that makes those models look
> and animate the way they're supposed to.
>
> **There is no PSX mode to switch on.** Point sampling, no antialiasing, affine
> texture mapping, no realtime shadows and no eye aim are not options here — the
> hardware being imitated had no setting for them either. What remains adjustable
> is what genuinely varies between models and machines: render scale, snap grid,
> colour depth, tracking rates and per-model calibration.

## What the PSX layer does

`docs/psx.js` loads as a plain script **before** the app bundle and exposes `window.PSX`.
The bundle calls back into it at a handful of patched call sites, so nothing here
touches the app's own source tree (this repo only ships the built bundle).

| Hook | Effect |
| --- | --- |
| `PSX.setupRenderer(renderer)` | Replaces the hardcoded `setPixelRatio(max(2, dpr))` with the configured render scale |
| `PSX.aa()` / `PSX.smaa()` | Turn off WebGL MSAA and the SMAA post pass |
| `PSX.fingers()` | Limits which fingers the hand solver drives |
| `PSX.onModel(vrm, gltf)` | Nearest-neighbour texture filtering, no mipmaps, no anisotropy; collects `_MainTex_ST` UV binds |
| `PSX.tick(vrm)` | Drives texture-atlas face expressions each frame |
| `PSX.face(vrm, rig)` | Receives the solved Kalidokit face and writes the emotion presets |
| `PSX.headGain()` / `PSX.bodyGain()` | Neck and chest/spine rotation gain |
| `PSX.smooth(t)` | Lerp factor for every tracked bone |
| `PSX.frame()` | Whether this animation frame gets rendered |
| `PSX.nextTrack(fn)` | Schedules the next Mediapipe inference |
| `PSX.mpOptions(opts)` | Mediapipe model options, before `setOptions` |
| `PSX.shadows()` / `PSX.shadowSize()` | Shadow map enable and resolution |
| `PSX.overlay(inst, opts)` | Queued subnav background animation |
| `PSX.overlayOpen(inst)` | The state that animation is heading to |

### The PS1 look

Nearest textures and a low render scale are *low-fi*, but they are not what makes
something look like a PlayStation. Three things do, and all of them are
shader-level — injected through `onBeforeCompile`, so unlike everything else in
this fork they need no call site in the bundle:

| Effect | What the hardware did |
| --- | --- |
| **Vertex snapping** | The console had no floating point in its GPU, so vertices landed on an integer screen grid. That is the wobble everyone remembers. **Snap grid** sets how coarse — lower is wobblier |
| **Affine textures** | No perspective correction, so a texture visibly warps across a large polygon. The most recognisable artifact of the era |
| **Dither** | 15-bit output, 5 bits per channel, with ordered dithering to hide the banding. **Colour depth** defaults to `5 bit (PS1)` |

The tunables are uniforms rather than generated code, so the sliders are live;
only **Affine textures** rewrites the shader program, because it needs a varying
to carry `w` across. Affine is skipped on untextured materials, which have no uv
varying to rescale, and the program cache key accounts for it so three does not
reuse whichever variant it compiled first.

Dithering applies to the avatar's materials, not to backgrounds or stickers —
those are not ours to hook.

### Texture-atlas face expressions

PSX models usually put every mouth and eye state in one face atlas and switch between
cells with a UV offset. three-vrm can only bind those `_MainTex_ST` values on MToon
materials, so this layer drives them directly — which means texture expressions also
work on plain/unlit materials.

Cell selection is deliberately *not* smooth:

- **Trigger threshold** — weight an expression must clear before it takes over its material
- **Release margin** (hysteresis) — how far below the threshold it may sag before letting go, so the face doesn't chatter at the boundary
- **Minimum hold** — ms a cell stays on screen once picked
- **Snap to cell** — cut straight to the winning cell instead of easing into it
- **Mouth / blink gain** — pre-threshold multipliers, so quiet talking and soft blinks still register
- **Flip V axis** — Unity samples V upside down relative to glTF; `on` is correct for a normal VRM export

### Emotion detection

Upstream only ever writes `blink`, `blink_l`, `blink_r`, the five vowels, and
`joy` — and `joy` only when **Smile Detection [Beta]** is on. `angry`, `sorrow`
and `fun` are **never written at all**, so on a PSX avatar their atlas cells sit
at weight 0 forever and can never clear the threshold. The expression looks
broken when it is simply never being asked for.

Kalidokit does solve the two signals those presets need, so this fork derives
them: `brow` (negative = furrowed, positive = raised) drives **angry** and
**sorrow**, and `mouth.x` — the corner-to-corner width upstream already uses for
its smile — drives **fun** and/or **joy**. Each has its own threshold, and
**One emotion at a time** keeps a furrowed brow over a wide mouth from landing
between two cells — these are whole-face swaps, so blending two lands on a patch
of atlas that is not an expression at all.

**Signal range** is what makes this usable at all. Kalidokit's brow scalar only
swings a few hundredths for most faces, so a raw threshold of `0.35` is
unreachable and the emotion simply never fires. Three modes:

| Mode | How the range is decided |
| --- | --- |
| `calibrated` | From a recorded **guided calibration** — the best mapping, and what the button below sets |
| `auto` | Learned continuously while tracking: the layer follows where your brow rests and how far it travels |
| `raw` | Kalidokit's numbers untouched. Almost never usable — it exists to show what upstream is working with |

**Calibrate expressions** runs a short guided pass, the way a game asks you to
hold a stick at its extremes. It prompts for four poses — relax, furrow, raise,
smile — and waits: get into the pose, hold it, then press **Space** (or click the
button) and it reads for about a second and a half. `Esc` cancels. Nothing is on a timer,
so the reading always happens while you are actually in the pose. It then records
what your face reached and switches the mode to `calibrated`.

The reading is deliberately not a maximum. Extremes were taken as an absolute
min/max, so one glitched frame — a dropped track, a blink, a head jerk — defined
the whole span: a single `-9.0` outlier during a `0.5` head turn produced a gain
of `0.09` instead of `1.5`. Each step now keeps its samples and reads a
percentile off them (the 90th for an extreme, the median for the resting pose),
skips the first 250 ms while you settle after the keypress, and refuses to record
a step that caught fewer than 8 frames — a span built on three frames is worse
than no calibration, because it looks like one. It also measures how much the
middle half of each pose moved and says so if you were too shaky for the fit to
mean much.

This beats `auto` because it records **a separate span per direction**. Most
people furrow much further than they raise, and continuous auto-calibration has
only one span for both. A face that furrows to `-0.050` but raises only to
`+0.012` maps both extremes to a full `1.00` once calibrated; under `auto` the
raise would barely register.

It also reports what it measured, and says which pose barely moved so you know
which step to redo.

Under `auto`, the resting value only drifts while your face is near rest, so
holding an expression doesn't turn it into the new neutral and fade out mid
grimace. **Reset auto range** starts that learning over.

**Speech first** fixes the other half. On a PSX atlas the vowels and the emotions
are cells of the *same* face texture, so they cannot both show — an emotion that
outweighs a vowel takes the whole face and the lip sync stops dead. With this on,
the emotions stand down while a vowel is above **Talking at**, so the mouth keeps
speaking and the expression returns when you stop.

The card carries a **live readout** of the normalised `brow` and `smile` values
and the emotion currently winning. Pull each face, watch the numbers, and set
each threshold just under what you can actually reach.

While this is on, the emotion presets belong to the PSX layer: it writes all
four every frame, including the zeroes, so a stale upstream `joy` cannot outvote
an exclusive pick. Point **Smile drives** at `joy` for the stock behaviour with
a threshold you can actually tune.

### Language

The panel speaks English or Portuguese (BR), switched in the PSX Hands card.

Upstream cannot do this: it ships an `en`/`ru` map for the menu buttons only,
its language store is built as `J("en")`, and the `navigator.languages[0]`
lookup beside it is evaluated and thrown away. Everything else — every panel
label — is hardcoded `textContent`.

So the app's own labels are swapped in the DOM, keeping the English original on
the node so switching back is exact. That runs on the raw mutation records
rather than on the throttled pass, because a re-render that reset a label to
English would otherwise show for a quarter of a second and read as a flicker.

The main menu needs a second path: its labels are not text at all but `data-text`
attributes drawn by `content: attr(data-text)` in the CSS — 39 of them, and the
only strings upstream does keep in an i18n table. Those are translated by writing
the attribute, so the observer also watches `data-text`; an attribute write never
adds or removes a card, so it never triggers an injection pass.

### Motion calibration

The neck rig multiplies the solved head rotation by `1` and the chest/spine rig
by `0.05`, both hardcoded, then lerps toward the result at `0.04 + dt*4` and
`0.04 + dt*2`. A small real movement therefore lands as a large avatar movement,
with nothing upstream to tune. **Head / neck gain** and **Torso gain** scale the
rotation; **Damping** scales the lerp, so the avatar eases into a pose instead of
snapping to it.

**Calibrate motion** sets them for you, the same way the expression wizard does:
it prompts you to face the camera, then turn left, turn right, look up and look
down — same rhythm, press **Space** once you are there — and records how far your
head actually travels. The neck rig clamps its
rotation to ±0.8, so mapping your widest turn onto that number uses the whole
available range without clipping — someone who barely moves gets a gain above 1,
someone who moves a lot gets one below. The torso is driven by the same head
signal, so it keeps its stock ratio to the head.

Emotion detection and motion calibration are independent of PSX mode — they are
tracking fixes, not a render look — so each has its own switch and both default
to stock behaviour.

### Panel background

The panel's dark backdrop is not a CSS background — it is an animated SVG shape
that grows to cover the panel. Upstream drops any `animate()` call that arrives
while an animation is already running, and only flips `isOpen` when one
finishes, which is also what the caller consults to decide whether it needs to
open anything.

Click two tabs quickly and those two facts combine badly: pick a new tab while
the close animation is still playing, `isOpen` still reads `true`, so the caller
decides nothing needs opening — and when the close lands, the shape is gone while
the panel is open. The content then renders straight over the 3D canvas with
nothing behind it, so the chroma key bleeds through.

This fork routes the calls through `PSX.overlay`, which remembers the state each
request is heading to and holds a request that arrives mid-animation instead of
dropping it.

### Performance

Upstream runs a **Mediapipe inference on every animation frame** and renders on
every animation frame, with **two lights casting 2048×2048 shadow maps**. On a
PSX avatar all three are overkill — and the era's own cadence was 20–30fps, so
capping the rate is authentic rather than a compromise.

| Knob | What it costs upstream |
| --- | --- |
| **Tracking rate** | One Holistic/FaceMesh inference per animation frame. This is where nearly all the CPU goes; 24–30fps is plenty for face tracking |
| **Render rate** | One full render per animation frame, up to the display's refresh. Capping to 20–30 roughly halves GPU time on a 60Hz screen |
| **Lite pose model** | Holistic `modelComplexity` 1. Dropping to 0 trades pose accuracy for a much cheaper network |

Three of upstream's costs are not options here, because this fork targets PSX-era
models and nothing else:

| Removed | Why it is gone rather than switchable |
| --- | --- |
| **Realtime shadows** | Two shadow-casting lights at 2048×2048, so two extra full-scene depth passes every frame and ~33 MB of VRAM. The PS1 had no realtime shadows at all — it stamped a blob on the floor. `PSX.shadows()` returns `false`, and upstream's Shadow Strength / Shadow Blur sliders are hidden with it |
| **Eye aim** | `PSX.gaze()` replaces `lookAt.applyer.lookAt()` and does nothing. A PSX face keeps its eyes on the texture atlas: it blinks by swapping a cell, it does not swivel. Aiming eye bones at a solved pupil is wasted work that reads wrong |
| **Iris / lip refinement** | `refineFaceLandmarks` is forced off. It is a whole extra network per frame, placing iris landmarks and denser lip contours — detail a texture atlas cannot show, and its main consumer was the eye aim above |
| **Antialiasing** | `PSX.aa()` and `PSX.smaa()` both return `false`. The console had none, so neither MSAA nor the SMAA pass is a choice |
| **Texture filtering** | Always nearest-neighbour, no mipmaps, no anisotropy. The PS1 point-sampled; there was no bilinear filter to turn on |
| **Affine mapping** | Always on where a material has a uv varying to rescale. Turning it off would not be a preference, it would be a different console |
| **Upstream's replaced controls** | Pixelate, Outline, Water Animation, Light Cube Experiment, Light Colour, Light Position and Smile Detection are hidden and pinned unconditionally — see below. An option to restore a control that costs performance or fights a PSX one would only be an option to make it worse |

Stack these with **Render scale** in the Effects tab: at `0.5x` the renderer
draws a quarter of the pixels, which is the single biggest GPU win and the
reason PSX mode looks right in the first place.

The Mediapipe options are read once at startup, so those apply on reload; the
rate caps take effect immediately.

## Keeping the hooks alive

The PSX layer only runs because a call to it was written into ~26 places in the
minified bundle. Those edits are invisible once committed and **do not survive
the bundle being regenerated** — and this project syncs with Glitch, so that
happens. When it does, `psx.js` still loads, still builds its panels, and
silently does nothing at all, because nothing calls it.

So the edits are not kept in anyone's memory:

```bash
node tools/patch.mjs           # apply; safe to re-run, applied patches are skipped
node tools/patch.mjs --check   # report status, exit 1 if any are missing
```

`tools/psx-patches.json` holds every call site as a find/replace pair. The tool
locates the bundle through `docs/index.html` rather than by name, so a rebuild
that changes the content hash still resolves, and it refuses to write if a call
site is missing or ambiguous rather than guessing.

From the running app, **Check bundle hooks** in the PSX Hands card (or
`PSX.verify()`) counts the call sites in the bundle the browser actually
loaded and names the missing ones.

### If psx.js does not load

Those ~26 call sites are unguarded and on the hot path — the render loop, the
bone rig, the tracking loop. A 404 or a parse error in `psx.js` would mean a
`TypeError` per frame and a dead app. So `docs/index.html` defines
`window.PSX` inline first, with every hook returning exactly what the stock code
did inline; `psx.js` replaces it wholesale when it loads. If it never does, the
app runs as upstream instead of breaking.

Settings are validated on the way back out of `localStorage` for the same
reason: several of them reach WebGL directly, and a `pixelRatio` of `0` or a
`shadowSize` of `"large"` is a black screen with no way back but devtools.
Anything that does not fit its range or enum falls back to the default, and
**Reset PSX settings** clears the lot.

## Controls

The layer injects its own cards into the app's existing tabs, reusing their markup
and scoped class names, so they look native. Controls are split by what they do:

**Effects tab** — the render look, next to the app's own Pixelate / Outline effects:

- **PSX Render** — Render scale (0.25x–2x), Vertex snapping, Snap grid, Dither, Colour depth

**Settings tab** — per-model calibration, next to the app's own tracking options:

- **Face Expressions** — Texture expressions, Snap to cell, Flip V axis, Trigger threshold, Release margin, Minimum hold, Mouth gain, Blink gain, Preview cell (force one expression for calibration)
- **Emotion Detection** — Detect emotions, Signal range (`calibrated` / `auto` / `raw`), One emotion at a time, Speech first, Talking at, Signal gain, Angry at, Sorrow at, Smile at, Smile drives (`fun` / `joy` / `fun + joy`), live readout, Calibrate expressions and Reset auto range
- **Motion Calibration** — Motion calibration, Head / neck gain, Torso gain, Damping
- **Performance** — Performance caps, Tracking rate, Render rate, Realtime shadows, Shadow resolution, Iris / lip refinement, Lite pose model
- **PSX Hands** — Driven fingers (`all fingers` / `thumb only` / `none`), Log diagnostics to console, Check bundle hooks, Reset PSX settings

Every switch is **off by default**, and with it off the matching hooks fall back
to stock behaviour. Anything the app reads only at startup — PSX mode, MSAA,
SMAA, render scale, shadows, Mediapipe model options — applies on reload, and the
card says so once you touch one. Everything else is live.

Settings persist in `localStorage` under the key `kf3d.psx`.

## Calibrating a model

1. Load your `.vrm`, open **Settings**, turn on **PSX mode**, reload.
2. Use **Preview cell** to force each expression key in turn and confirm the atlas cell is right. If every expression lands on the wrong cell, toggle **Flip V axis**.
3. If the face chatters between two cells, raise **Release margin** or **Minimum hold**.
4. If quiet talking doesn't register, raise **Mouth gain**; same for **Blink gain**.
5. Hit **Log diagnostics to console** for the resolved materials, UV binds, current cell, and the last solved `brow` / `smile` values with the emotion weights they produced.
6. For emotions, hit **Calibrate expressions** and follow the four prompts. Then pull each face and watch the card's live readout — the thresholds should already be roughly right, and **Angry at** / **Sorrow at** / **Smile at** trim them. If an expression stops your lip sync, that is what **Speech first** is for.

---

## Upstream: Kalidoface 3D — Face and Full-Body tracking for Vtubing on the web!

A sequal to **[Kalidoface](https://kalidoface.com)** which supports Live2D avatars, **[Kalidoface 3D](https://3d.kalidoface.com)** is a web app that brings support for 3D Vtuber avatars. It now features more dynamic camera angles, and even full-body tracking options using the latest Mediapipe human pose detection models. Add the web app to your homescreen to use it in standalone full screen or even use it in OBS as a browser object directly.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/B0B75DIY1)

![Kalidoface Face Tracking](https://cdn.glitch.me/29e07830-2317-4b15-a044-135e73c7f840%2Fkalidoface-face-closeup.gif?v=1633451401758) ![Kalidoface Pose Demo](https://cdn.glitch.me/29e07830-2317-4b15-a044-135e73c7f840%2Fkalidoface-pose-dance.gif?v=1633453098775)

### Use your own VRM 3D models

Kalidoface 3D works with <b>VRM 3D models</b>. Just drag and drop your own .vrm files to add your Vtuber character. Might support other types of 3D human models if they're easy to implement.<br><br>Models are saved locally so you won't need to reupload them next visit!

![VRM file support](https://cdn.glitch.com/29e07830-2317-4b15-a044-135e73c7f840%2Fezgif-2-b312e89d3e07.gif?v=1626110793139)

### Call a friend

Share your <b>6 digit code</b> with a friend to start a private <b>voice call</b> using virtual avatars! Now updated with new selfie and first person camera modes.

![Peer to Peer chat](https://cdn.glitch.com/29e07830-2317-4b15-a044-135e73c7f840%2Fezgif-3-a2691d6ea927.gif?v=1626111894228)

### Upload custom background

Upload image backgrounds, or use the included <b>chroma key colors</b> for keying in special software such as OBS. You can also upload resizeable <b>gif stickers</b> to use as props for your videos/streams. Uploaded images are also saved locally for the next time you visit!

![Panorama Background](https://cdn.glitch.com/29e07830-2317-4b15-a044-135e73c7f840%2FIMG_1391.GIF?v=1626108547668)

### Add resizeable stickers

Add <b>image/gif</b> stickers that you can resize and use as props for videos or streaming.

![Chroma Keys](https://cdn.glitch.com/29e07830-2317-4b15-a044-135e73c7f840%2FIMG_1389.GIF?v=1626108547406)

All sample VRM models are not mine and credit should go to the creators on Vroid Hub.

### OBS Integration

To use Kalidoface directly in a Browser object in OBS, you need the `-use-fake-ui-for-media-stream` and `--allow-file-access-from-files` flags enabled. This is used to get access to the webcam and to allow custom This can be done through a terminal/command prompt. Below is a sample to get it running on mac. Just add the 2 prompts right after the path to your OBS application.

```
/Applications/OBS.app/Contents/MacOS/OBS -use-fake-ui-for-media-stream --allow-file-access-from-files
```

### Standalone Tracking Library

Interested in making your own Vtuber app? **[Kalidoface](https://github.com/yeemachine/kalidokit)** is a JS library that solves for face, full body, and hand tracking.

<a href="https://github.com/yeemachine/kalidokit"><img src="https://github.com/yeemachine/kalidokit/blob/main/docs/kalidokit_glitch.gif?raw=true" alt="Kalidokit Template" width="100%"/></a>

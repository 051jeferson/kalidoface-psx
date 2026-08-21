# Kalidoface 3D — PSX Edition

> **This is a fork of [yeemachine/kalidoface-3d](https://github.com/yeemachine/kalidoface-3d), retuned for PSX / low-poly VRM models.**
>
> Stock Kalidoface 3D targets smooth, modern VRM avatars: 2x pixel ratio, MSAA + SMAA,
> linear/mipmapped textures and blendshape-driven faces. PSX-era models want the
> opposite — hard pixels, nearest-neighbour texels, and faces animated by *swapping
> texture cells* (UV offsets on a face atlas) instead of morph targets.
> This fork adds a compatibility layer, `docs/psx.js`, that makes those models look
> and animate the way they're supposed to.

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

## Controls

The layer injects its own cards into the app's existing **Settings** tab, reusing the
app's markup and scoped class names, so they look native:

- **PSX Render** — PSX mode, Nearest textures, MSAA, SMAA, Render scale (0.25x–2x)
- **Face Expressions** — Texture expressions, Snap to cell, Flip V axis, Trigger threshold, Release margin, Minimum hold, Mouth gain, Blink gain, Preview cell (force one expression for calibration)
- **PSX Hands** — Driven fingers (`all fingers` / `thumb only` / `none`) + a diagnostics dump button

PSX mode is **off by default** — with it off, every hook falls back to stock behaviour.
PSX mode, MSAA, SMAA and render scale apply on reload; everything else is live.

Settings persist in `localStorage` under the key `kf3d.psx`.

## Calibrating a model

1. Load your `.vrm`, open **Settings**, turn on **PSX mode**, reload.
2. Use **Preview cell** to force each expression key in turn and confirm the atlas cell is right. If every expression lands on the wrong cell, toggle **Flip V axis**.
3. If the face chatters between two cells, raise **Release margin** or **Minimum hold**.
4. If quiet talking doesn't register, raise **Mouth gain**; same for **Blink gain**.
5. Hit **Log diagnostics to console** for the resolved materials, UV binds and current cell.

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

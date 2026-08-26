# Kalidoface PSX

Fork of [yeemachine/kalidoface-3d](https://github.com/yeemachine/kalidoface-3d) retuned for PSX / low-poly VRM models. Product behaviour lives in `README.md`. This file is for agents working the repo.

There is **no app source tree**. `src/` is gitignored leftover from upstream Vite. The running app is the built static site in `docs/`. All fork behaviour is `docs/psx.js` plus ~35 patched call sites in the minified bundle.

## Layout

```
docs/                 # the app. serve this directory
  index.html          # PSX stub, then psx.js, then the hashed bundle
  psx.js              # the compatibility layer (edit here)
  assets/index.*.js   # minified Kalidoface bundle. do not hand-edit
tools/
  patch.mjs           # applies / checks the hooks
  psx-patches.json    # find/replace pairs for those hooks
index.html            # upstream Vite entry. not used; points at missing src/
```

## Run locally

Serve `docs/` over HTTP. Webcam needs `localhost`, not `file://`.

```bash
python -m http.server 5173 --bind 127.0.0.1 --directory docs
# http://127.0.0.1:5173/
```

Do **not** run `npm run dev` / `npm run build` / `vite`. Root `index.html` imports `./src/main.js`, which is not in the repo. A Vite build would overwrite `docs/` and drop the patched bundle.

`node_modules` is not required to run or to edit `psx.js`.

## Commands

```bash
node tools/patch.mjs           # apply hooks; already-applied patches are skipped
node tools/patch.mjs --check   # exit 1 if any call site is missing
```

In the running app console: `PSX.verify()` counts bundle call sites; `PSX.dump()` logs the loaded model.

## Architecture

`docs/index.html` defines a stub `window.PSX` (stock Kalidoface behaviour) so a 404/parse error in `psx.js` does not TypeError the render loop. `psx.js` then replaces it.

The bundle calls `window.PSX.*` at patched sites (renderer, shadows, SMAA, tracking rAF, face rig, overlay, …). Shader-level PS1 look (vertex snap, affine, dither) is injected in `onBeforeCompile` and needs no call site.

Settings: `localStorage` key `kf3d.psx`. New keys need `DEFAULTS`, `SPEC` (if they reach WebGL or would brick the page), the Settings/Effects widget, and both `PT` / `EN` strings.

### Adding a bundle hook

1. Add a find/replace pair to `tools/psx-patches.json`. Use unique minified fragments. `patch.mjs` refuses 0 or >1 matches.
2. Bump `EXPECTED_HOOKS` in `psx.js` to the new call-site count (`smooth` is 7, `shadowSize` is 4, `overlay` is 3, `mpOptions` is 2).
3. Add the same hook to the stub in `docs/index.html`, returning stock behaviour.
4. Expose it on the real `window.PSX` object at the bottom of `psx.js`.
5. Run `node tools/patch.mjs --check`.

A `replace` that is a prefix or substring of its own `find` is read as already applied and silently skipped, while `--check` reports the hook present - so anchor such a pair on adjacent text until the replacement cannot be mistaken for the original. An expression evaluated on both the create and the update path needs a pair for each; applying to one of them looks clean and half works.

A patch may match text an earlier patch produced. `leanGain` is declared inside the `bodyGain` replacement rather than as its own pair: a separate pair keyed off the patched text would leave the original with a `find` that no longer exists on a clean bundle. Patches apply in array order, so a later one may rely on an earlier one's output - but never on breaking an earlier one's `replace` string.

Never edit `docs/assets/index.*.js` by hand. After a Glitch/Vite rebuild that changes the content hash, re-derive any failed patches — do not guess.

## Code conventions (`docs/psx.js`)

- One IIFE, `'use strict'`, `var`, 2-space indent. No modules, no build step, no `let`/`const` required. Keep it parseable as a classic script.
- Comments explain non-obvious constraints, not the implementation walk.
- English UI strings are the i18n keys. `T('Foo')` for our cards; `translateNode` swaps the app's own leaf `h4`/`label`/`p`/`button` text and stores the original on `__psxEn`.
- Injected cards reuse the host panel's scoped Svelte hashes (`FX = svelte-2t25z9`, `STG = svelte-1krauxh`, `TG = svelte-yzrsaq`). A new upstream bundle can change those hashes.
- Strip upstream controls in `STRIP`. Headings are translated, so match `__psxEn`, `PT[heading]`, **and** the toggle `aria-label` (those stay English). Pin values that fight the layer (`Smile Detection` → `false`, `Enable Wink` → `true`); hide the rest.
- Hide Camera Panel and Hide Webcam Video are one switch. The video row is stripped; the remaining heading is relabelled `Hide camera` (`RELABEL`, `__psxEn` stays the original so `headingMatches` still finds it) and drives both stores through the app's own inputs. Do not bring the second toggle back.
- Three wizards share one state machine (`calRun.kind`): `face` waits for Space, `motion` and `mouth` count themselves in. `steps()`, `calTarget()` and `syncCalUi()` each need the new kind added.
- The motion step list is fixed when the run begins (`calRun.steps`, built by `motionSteps()`), not read off `MOTION_STEPS` per call. `armIK` is a panel toggle and the sweep steps are meaningless without the retarget, so they are dropped from the run rather than failed in it - and the list may not change under a wizard that is part way through it. Count steps with `steps().length`, never `MOTION_STEPS.length`.
- `cfg.mouth.smile` is a prototype like any other, and optional so older saves still load. A toothy grin is an open, spread mouth - the same width as `i` - so it cannot be split off by a threshold, only by being its own recording. When it wins, `mouthSays` carries the confidence into `driveEmotions`, which takes it past `smileAt` rather than through it.
- Vowels are classified by nearest recorded prototype (`cfg.mouth`), not by Kalidokit's A/I/U/E/O and not by the width/openness formula - both pick one cell for every open mouth. `rest` is one of the prototypes, so silence is a decision rather than a threshold, and that is what leaves the mouth cell free for a smile. The formula is still the uncalibrated fallback, now gated on openness.
- Nothing a single **held pose** may move a gain by more than half (`nudge`'s default band). The T-pose reading is gated on the arms actually being out, and the depth reading on the arm actually pointing at the lens - both are factors against a pose, so a pose nobody made reads as a model that cannot reach and pushes the gain the wrong way. The `sweep` step is the deliberate exception (`FIT_BAND`): it is hundreds of samples over the whole workspace rather than one pose, and a calibration that gets run once and then kept has to be allowed to arrive.
- A calibration reading needs a **ground truth outside the landmarks**. The sweep has one - a locked elbow is exactly as long as the arm is, whichever way it points, and `userArm` from the T-pose says what that length is - which is why `sampleSweep` gates hard on `vlen(d) >= seg * 0.9`. Do not "improve" it into a fit of the model against the tracked landmarks: the model's hand distance comes from the elbow bend, so the two already agree in each one's own proportions, and such a fit is minimised at gain 1. It would silently undo the depth calibration instead of refining it.
- Reach and the axis factors are different kinds of number. `armReach` (and `reachR`/`reachL`) are magnitudes - they stretch the elbow toward straight, and only above 1. `reachUp` and `armDepth` steer direction and cannot lengthen anything, because `bend` sets how far the hand goes. A measurement of one may never be fed into the other. The sweep measures depth compression, so it sets `armDepth` alone; the hands-on-head pose is a vertical known pose, so it sets `reachUp`; the T-pose measures a span, so it sets `armReach`.
- `reachR`/`reachL` are sliders only. A sweep can say which arm the tracker reads worse (`sideResidual`, reported after the `check` step) but not that the arm needs more Reach - both arms match their own length by construction, so there is no per-side magnitude signal to calibrate from.
- The `check` step must set nothing. It re-reads the sweep against the finished rig, and its residual is the only number in the run that says whether the calibration worked - the fit's own residual is measured on the very samples that produced it.
- A step that gates on its own samples rather than on the face samples (`st.fit`) can fail forever when body tracking is off, because `retryStep` re-arms the same step. Those steps give up after `FIT_TRIES` and move on without a reading. Any future step with its own sample gate needs the same bound.
- The depth step measures the user's arm length from the *T-pose*, never from the pointing pose: depth is what the tracker compresses, so an arm aimed at the lens has its own length compressed by the very factor being measured, and the ratio would come out 1 on any camera.
- Expression cells are exclusive — never blend UVs. Emotions write all four presets including zeros while enabled, so stale upstream `joy` cannot win.
- Wink is always on. A `blink` cell reads `max(blink, blink_l, blink_r)`; a `blink_l`/`blink_r` cell also takes the combined `blink` so a full blink closes that eye. Guided calibration records `blinkOpen` / `blinkClosed` across head poses; those fields are optional on older `cfg.cal` objects.
- The open-eye head-turn poses in the face wizard (`leftOpen` / `rightOpen` / `gazeUp` / `gazeDown`, plus `rest`) also record brow rest at that pose. Looking aside changes the 2D brow scalar without the brows moving, the same way it fools the lids. Do not throw those samples away, and do not add extra wizard steps for it — those four already are the ground truth ("brows relaxed at this pose"). `cfg.cal.browAt` is optional on older saves. Pose rest shifts the zero only; the facing-camera furrow/raise stays the span. Do not cap that shift against the span — a yaw drift that is most of a small raise is the bug being fixed. Left and right often drift the same way, so a signed slope through both would cancel — interpolate each side from the rest pose out to that recording. Calibrated rest is a band (`BROW_DEAD`), not a point: mapping a tiny recorded furrow onto 0..1 makes tracker noise look like a full angry, and then `ramp(1, angryAt)` is 1 for every threshold the slider offers. Do not drop that deadzone, and do not call `refreshModels` / `applyStrip` / `syncControls` from a slider's `input` — that reset the UV latch and fought the drag, which is why the sliders looked dead after a calibration.
- The recorded poses are four points on two axes, and only exist once the wizard has been run — the default signal mode is `auto`, where nothing corrected the pose at all, which is where "looking aside reads as angry" came from. `browPose` is a ladder of cells along head `y` / `x` / `z` that learns the remaining drift while tracking and rides on top of `browAt`; with a good recording there is little left and it converges on nothing. It learns a **median** — a step toward each sample — with no "only while the brow is quiet" gate. That gate is right for `normalize`'s one global baseline and cannot work per pose: until a cell has learned anything the drift itself is what makes the frame look un-quiet, so the cell that most needs the sample refuses it, and a cell that ever learned wrong refuses every frame that could correct it. Only the centre cell is exempt — it is the baseline the others are measured against. Do not learn while `faceOcc`, and do not let one axis learn while another is off centre or both ladders take the same drift twice. `PSX.browRest()` is how to debug it.
- `on()` is hardwired `true`. Do not bring back a PSX-mode switch, realtime shadows, eye aim, MSAA/SMAA, or the stripped Pixelate/Outline/Water/Light-cube/Smile Detection/Enable Wink/Selfie/Call-a-friend controls as user options.
- Keep Mediapipe `refineFaceLandmarks` / `refineLandmarks` **on**. Kalidokit returns `brow: 0` and eyes stuck open unless it sees 478 landmarks. Vendor patches also let brow/blink run on a 468 mesh if refinement is missing.
- Kalidokit's stock brow remap is 0..1 and **clamps the furrow away**. The vendor patch returns the unclamped scalar so rest-relative mapping can go negative (angry) and positive (raise).
- `PSX.guide` gates the preview canvas repaint on `#drag-cam` not carrying `hide`. Do not widen that to any `.hide` ancestor — the subnav and the menu use the same class and say nothing about the preview.
- The motion wizard counts itself in (`CAL_PREP`); the face wizard waits for Space. A motion pose has no hand free for the keyboard, or turns back toward it and jolts the signal being read. Do not put a countdown on the face wizard - that was tried and reverted, expressions are still being built when a timer fires.
- `PSX.pose(world, image, hands)` takes three arguments. `image` is `poseLandmarks` in normalised video space, which is the only space the face mesh also reports in (`rig.head.position`) - that is what makes the sanity cross-check possible without mapping either convention. `hands` is the bundle's own `{Right, Left}` map of hand-model landmarks, already crossed over to the same convention as `ARM_LM`.
- The sanity gate learns its own thresholds (`meter` / `learn` / `offBy`); do not put a constant in it, it would be a constant tuned to one webcam. Both give-up counters exist so a genuine change - sitting down, new lighting - cannot lock the gate shut permanently.
- A hand on the face is a ground truth outside the mesh: the pose still sees the head, the hand model still sees the palm, and if they overlap in the video the mesh is looking at a hand. Hold blink / visemes / emotions at the last good frame (`faceOcc`). Do not let that disagreement reject the pose — covering a yawn is the arm's job and the mesh jumping is why it looked like tracking died. `faceTrusted` crawls the neck only when the mesh actually jumped; the retarget does not go through `smooth()`, so the hand still reaches the mouth. One overlapping palm is enough. Ear-span is this person's own face, not a constant. `PSX.armInfo().faceOcc` is how to debug it.
- `armLenOk` rejects only *over-long* arms. Foreshortening legitimately halves the measured length of an arm pointing at the lens; a symmetric check throws away every gesture toward the camera.
- `smooth()` is handed a lerp alpha, never the value being lerped, so the one-euro cutoff runs on a speed measured in `noteHeadSpeed` / `noteWristSpeed` and decayed once per rendered frame in `stepMotionClock`. Which bone a site belongs to is recovered from the alpha itself (`0.04 + dt*N`); do not flatten that, or the torso turns as fast as the neck. The arm retarget has its own target in hand and calls `euroAlpha` directly.
- `bodyGain` is the torso's *pitch*, which rides on the head signal and keeps its stock ratio to it. `leanGain` is the lean and twist, which come from the pose solver. Upstream shares one constant between them, which is why opening the lean up used to over-pitch the torso.
- Head roll is not a torso lean, but Mediapipe's pose copies it onto `Spine.z`, and three stacked chest bones then tip the whole upper body. The `headRoll` motion step is the ground truth that they are different: ear toward the shoulder, shoulders still, so whatever the shoulder line does is the coupling (`leanHead`) to strip. `PSX.spineLean(z, head.z)` subtracts only the same-sign component and never reverses past zero — a frame where the shoulders did not follow would otherwise invent a lean the other way. Do not cap isolation against `leanGain`; a coupling that is most of a small lean is the bug. `leanHead` is 0 on older saves. Do not feed a torso-lean pose into that slope — if `|dRoll|` outruns `|dHeadZ|` they leaned, and taking it would strip every real lean that happens with a head tilt.
- A lost arm coasts (`coast`) instead of snapping back to the stock rig, timed from when it was lost rather than from the last good solve - a whole-pose dropout is already being held through `POSE_STALE_MS`. `giveUpArm` has to put the shoulder back at rest: nothing upstream writes that bone.
- **Constrain the pose to what an arm can do, rather than only measuring harder.** A forearm has around 150 degrees of pronation in total and a hand placed behind the head has spent most of it getting there, so a palm facing away from the skull in that pose is not a mistracked palm - it is a pose no arm can make, and it can be rejected without measuring anything better. The same hand on the forehead or the crown *can* face outward, because the shoulder is rotated differently there, so the limit has to be a function of the arm's configuration and not a fixed cap. `armInfo().palmDot` reports where the palm currently points relative to the head (+1 at it, -1 away) so the rule can be fitted to observation.
- Enforcing anything about the palm needs to know which face of the hand **is** the palm, and that sign is opposite on the two hands. Getting it wrong inverts every palm, which this file records having happened twice. Settle the sign by watching `palmDot` against one known pose - a bind pose varies per model and cannot be reasoned from.
- Measure "at the head" from the **skull**, not the nose. `headRef()` is the ear midpoint, which is inside the head; the nose is on the front of the face. Hands go on the nape and the sides, and from the nose those read 1.3-1.6 head-heights - past `HEAD_ON`, most of the way to `HEAD_FAR` - so a hand physically touching the head was getting a quarter of its anchor. This is why the fault needed **two** hands to show: one hand tends to land high and forward, near the nose, and looked right.
- Proximity to the head is measured **across the image**, never through it. A hand behind the head is the one place the depth estimate has nothing to work from, and it is exactly the pose that test decides. The offset the anchor then applies keeps all three axes - being wrong about how far *through* the head a hand sits misplaces it slightly, where being wrong about *whether it is there* swaps the whole behaviour.
- Kalidokit's wrist is only re-solved on a frame that had hand landmarks (`i[o] !== null` in the bundle). With the hands lost it holds the flexion from whenever they were last seen, and replaying that on a forearm that has since moved is what puts the palms out sideways. Check `poseHand[side]`, not the rig - a stale value looks exactly like a fresh one from there. With nothing watching the hand, ease it into line with the forearm and hold the last palm roll.
- The retarget rewrites the forearm from its rest pose every frame, which is what lets the roll be read as an absolute angle instead of a correction stacking on the last one. A frame that skips the roll therefore does not leave the palm where it was - it snaps it to bind. Skipping is never the neutral option here.
- Holistic reports the two hands separately and swaps them once they are close together (`handSwaps` counts the corrections - 25 in one session with the hands touching, 0 with them apart). Do not trust the labels; ask which pose wrist each hand is sitting on, in the video frame, with a margin so a tie does not flicker.
- `vis()` answers whether a landmark may be used; `conf()` answers how far to believe it. Use `conf` wherever a reading is allowed to **undo** something. Note that Mediapipe reports `visibility` of 0.9+ for wrists that are behind the skull, so confidence alone will not detect that occlusion.
- Debugging this rig without `PSX.armInfo()` is guesswork: seven hypotheses were tried against these symptoms and every one that held up came from a **new field in that readout**, none from reasoning about the code. Add the field first. It writes raw numbers into two objects made once - keep it allocation-free, since it runs twice a frame forever, and do the rounding in `armInfo`.

- Head-relative gestures are anchored on the head (`headAnchor`), not the shoulder. Scaling a wrist offset by arm length preserves the direction exactly, and on a big-headed short-armed model that direction is faithfully wrong - its face is at a much steeper elevation from its shoulder than a person's. Measure such things in head-heights, never arm-lengths; an arm-length yardstick hides the very error, which is how this was missed twice. "At the head" for a hand *in front of* the face has to be read in the **image**, not in world landmarks: that is the axis Mediapipe compresses to nothing, so a covering palm sits on the skull in 3D while the video shows it on the mouth. `imgHeadNear` / `sideHitsFace` are that reading. Do not run `armDepth` under 1 on the head-anchor offset — that gain is for the whole-arm mapping, and crushing it here is what put every covering hand off to the side. When this hand occludes the face, add a forward standoff along the chest; without it the IK has no point in front of the mouth to reach. `PSX.armInfo().imgNear` / `occ` / `stand` are how to debug it.
- `armDepth` steers direction only now that the elbow angle sets distance, so a value under 1 no longer damps noise - it aims every toward-camera gesture off to the side. Default is 1; the adaptive filter does the damping. `armReach` above 1 overshoots on ordinary proportions for the same reason, and `REACH_STRAIGHTEN` caps how much of the person's bend it may take away.
- The elbow bend comes from the angle measured at the elbow, never from `vlen(toT)`. That length carries the person's size, their distance from the lens and `armReach`; the angle carries none of them. Deriving the bend from the length is what welded the arm into one piece, because any `armReach > 1` clamps the span at `a + b`.
- `mapDir` is often a reflection - the landmark frame's up runs down the screen and its front is forced toward the camera, so the two frames disagree about handedness, and `sx` flips it again. That is fine and needs no correction: a reflection carries a direction across faithfully, and by the time two directions are compared they are both in the model's space, where the angle between them is simply the angle to turn. There used to be a `mapFlip` factor on the twist for this; it turned every palm the wrong way. Do not bring it back.
- The wrist is aimed from the hand model's own landmarks (`handWant`), not from Kalidokit's Euler wrist, and the forearm twist is measured against the model's `IndexProximal` / `LittleProximal`. `aimBone` leaves twist at rest by design and both wrist sources only report flexion, so without the twist the palm never turns. The hand landmarks are in **image** space, so they map through `imageBasis()` and never through `lmBasis`. Holistic drops the hand model constantly; the Euler wrist and the pose model's index/pinky landmarks are the fallback, not a failure. A rig with no finger bones must fall back, not throw.
- The arms do not run on Kalidokit's Euler angles. `PSX.pose` captures the holistic world landmarks and `PSX.arm` retargets shoulder/elbow/wrist onto the model's own arm, returning `true` to suppress the stock rig. It aims bones from their captured rest quaternion, so never assume the arm bones are at identity. Falling back (`false`) is the correct answer for stale landmarks, an unseen limb, or the pose-only tracking path.
- Upstream never copies `brow` (or live `eye`) onto `tracking.Face` — only into a spring store. The bundle patches write `n.brow` / `n.eye` after Face.solve and copy both from the spring on subscribe. Without those, `PSX.face` always sees `brow: 0` and `eye: {l:1,r:1}`.

- Saved background colours are entries in the app's own uploaded-background list (`PSX.bg` captures its store when the Backgrounds panel mounts). A `{type:'color', url:'#rrggbb', pano:false, uploaded:<ms>}` entry gets the app's swatch, its delete button and its persistence for free - do not build a parallel PSX list. `pano:false` is what files it under the 2D tab.
- The app's own delete button reports the index the item was **rendered** at, which is an index into the list after it has been filtered by `pano`. `PSX.bgDrop` re-walks that filter; deleting by the raw index removes the wrong background as soon as a 3D upload sits ahead of a 2D one.
- The iro picker reads `savedIro` once, when it is constructed, and it is constructed when the Color tab mounts. To move it, drive its own hex field (`#picker .hex input`) with an `input` event - setting the store does nothing.

## Do not

- Restore `src/` as the place to work. The fork is `docs/psx.js`.
- Commit an unpatched bundle. If `docs/index.html`'s module `src` hash changes, run the patcher before considering the change done.
- Dispatch pin events in a loop. `PIN_TRIES` is 3 on purpose: a value the app rejects would re-render forever.

## Git

Working branch is `glitch` (Glitch sync). `origin` is this fork; `upstream` is yeemachine/kalidoface-3d.

Commits: `feat:` / `fix:` plus a short description of the user-visible change.

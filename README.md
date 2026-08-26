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
| `PSX.headGain()` / `PSX.bodyGain()` / `PSX.leanGain()` / `PSX.spineLean()` | Neck, torso pitch, torso lean gain, and head-roll stripped from `Spine.z` |
| `PSX.smooth(t)` | Lerp factor for every tracked bone |
| `PSX.pose(world)` | Receives the Mediapipe pose world landmarks |
| `PSX.arm(...)` | Replaces the Euler arm rig with the landmark retarget |
| `PSX.guide(canvas)` | Whether the tracking preview is worth painting |
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

Cells are picked, never blended, and that is not a setting. Easing from one cell
to another slides the UV window across the sheet, so the frames in between show
whatever sits between the two cells — which is not an expression. What is
adjustable is when a cell wins:

- **Trigger threshold** — weight an expression must clear before it takes over its material
- **Release margin** (hysteresis) — how far below the threshold it may sag before letting go, so the face doesn't chatter at the boundary
- **Minimum hold** — ms a cell stays on screen once picked
- **Mouth / blink gain** — pre-threshold multipliers, so quiet talking and soft blinks still register

The V axis is measured rather than configured. Unity samples V upside down
relative to glTF, and rebasing for that is right for a VRM written by UniVRM —
but not always for models arriving through the odd pipelines this fork exists
for, and getting it wrong puts every expression on a vertically mirrored row of
the atlas, which reads as a broken model rather than a convention mismatch. The
neutral group is the rest cell, so converting it correctly has to land on the UV
transform the material already shipped with: both conversions are tried against
that and the one that actually matches is kept, per material. With no neutral
bind there is nothing to measure, so the spec wins.

### Vowel calibration

Kalidokit reports five vowel weights (`A`/`I`/`U`/`E`/`O`) that all rise together
with the jaw, so one of them outranks the rest whatever you say. On a PSX atlas —
where a viseme is a whole-mouth texture swap, not a blend — that means every open
mouth lands on the same cell, and the avatar has one talking shape. Deriving the
vowels from width and openness instead only moves the problem: those constants are
one person's mouth, and on another face two vowels still collapse onto one cell.

**Calibrate vowels** records what *your* face reads while you say each vowel out
loud — a closed mouth, a toothy grin, then A, E, I, O, U — and a live frame
becomes whichever recording it lands nearest. It works on the shape weights precisely because it
never compares them to each other, only to what they read while you said that
vowel. Each pose is counted in rather than waiting for a key: someone holding
"oooo" while hunting for Space has stopped saying it.

Silence is one of the recorded poses, so a closed mouth is a *decision*, not a
threshold to guess at — and that is what frees the mouth cell for a smile. Without
the recording, a mouth's width alone used to keep a vowel lit at all times, so the
smile cell could never win it. **Vowel hold** is how much closer another vowel has
to be before the mouth swaps cell; two vowels trading the lead frame by frame reads
as a flicker rather than as speech.

The grin is recorded for the same reason silence is. A smile showing teeth *is* an
open, spread mouth — it is the same width as "ee" and nearly the same openness as
"eh" — so no threshold can separate them, because they are not different amounts of
one thing. Once it is its own recording, the classifier tells a grin from an "ee"
the way it tells "ee" from "eh", and having already ruled out every vowel it is a
better smile detector than the width threshold: when it fires, the smile goes in
past **Smile at** rather than through it. A calibration recorded before that step
existed still loads and still works, minus the grin.

If two mouths come out reading almost the same, the wizard names the pair rather
than saving a mapping that quietly cannot work.

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

#### Tuning it by hand

Three controls, for when the automatic mapping is not landing:

| Control | What it does |
| --- | --- |
| **Set neutral now** | Takes whatever your face is doing at that moment as its resting brow. The one-click version of the wizard, and the thing to reach for the moment the reading sits off zero. In `auto` it moves the tracker's own baseline; with a recording in force it writes the offset below, because a recorded zero stays where it is put and an offset against a baseline that re-zeroes itself is a number the tracker spends the next few seconds undoing |
| **Brow offset** | The same shift by hand, applied before the gain so it can still rescue a reading that is already pinned at ±1 — which is the state anyone reaching for it is in |
| **Head-angle correction** | Turns the pose machinery off entirely: no recorded per-pose mapping, no learned ladder, no confidence lift. Off is the plain signal with nothing moving under it, which is what tuning the other two by hand needs |

Watch the readout while you drag them. `brow` is the finished number the
thresholds see; `[raw~rest]` beside it is what came off the tracker and where
this layer thinks rest is.

#### Angle-free brow

Looking to the side used to read as an expression, and the reason was in the
number itself rather than anywhere downstream of it. Upstream's brow, per side,
is

    (d(63,229) + d(105,230) + d(66,231)) / 3  /  d(35,244)  / 1.15 - 1

and every one of those distances is taken **in the image**, with the mesh's own
z thrown away. The three on top run down the face; the one underneath runs
across it. They do not foreshorten together — so turn your head and the span
underneath shortens while the three on top barely move, dip your chin and the
opposite happens.

Measured on a rigid face turned in front of the lens, with nothing moving but
the head:

| Head | Upstream's brow moves by | In three dimensions |
| --- | --- | --- |
| yaw 17° | +0.037 | 0 |
| yaw 29° | +0.118 | 0 |
| yaw 40° | +0.295 | 0 |
| pitch 29° (chin down) | −0.062 | 0 |
| pitch 23° (chin up) | −0.064 | 0 |
| yaw 23° + pitch 20° | +0.026 | 0 |

A furrow is worth about 0.05 on that same face. Forty degrees of yaw is **six
times the whole expression**, spent on having turned. Yaw drives it positive, so
it reads as a raise; pitch drives it negative, so it reads as a furrow — which
is why a glance to the side with the chin a little down was the reliable way to
look angry at nobody.

**Angle-free brow** takes the same landmarks and the same constant in three
dimensions, where a distance does not care which way the head is pointing. The
mesh reports z on roughly the same scale as x, so this costs nothing but the
square root it was already taking.

`PSX.browRest()` reports `mesh` and `flat` side by side — turn your head with a
relaxed face and watch which one holds still. It also reports what the pose
ladder below has learned, which is now only the residue: iris noise, lighting,
and whatever the mesh gets wrong about z.

A recorded calibration belongs to whichever scalar was on when it was taken —
the two do not share a rest — so it is stamped, and a mismatch falls back to
`auto` for the brow rather than reading the recording against the wrong number.
**Recalibrate after switching this.**

#### Per-pose brow calibration

Reading the brow in 3D removes the projection, but not everything that moves
with the head: the mesh's own z is a fitted estimate, lighting changes across a
turn, and the far side of the face is guessed at. So the wizard measures the
brow at each pose instead of correcting for one.

At every head pose it records **three faces, not one** — relaxed, furrowed,
raised. The relaxed reading says where zero sits at that angle; the other two
say how far this face's own furrow and raise actually *travel* there, which is
not the same as facing the camera. A span borrowed from the frontal recording is
a gain that is wrong by however much the two disagree, which reads as a
threshold that cannot be set: too twitchy at one angle, dead at another.

It also records **two angles per direction** — a glance and a full turn. Drift
with head angle is a curve, and the previous version drew a straight line from
rest out to a single recording per side. A straight line through a curve is
right at both ends and wrong everywhere between them, so a full turn was
corrected, facing the camera was correct by construction, and halfway between
was off by the whole sag. That is what made it intermittent: it depended on
where between the two knots your head happened to be.

On a synthetic face with both a curved drift and a furrow that shrinks off-axis:

| Recording | Relaxed faces read as an expression | Real expressions muted |
| --- | --- | --- |
| one relaxed pose per direction | 4 of 9 poses | 4 of 18 |
| three faces, two angles per direction | **0** | **0** |

Steps are grouped by pose rather than by expression — you turn once and make
three faces, instead of being sent back and forth. That is not only faster: the
three readings have to share one angle, and a head that goes back to the camera
between them files three different angles under one pose.

The wizard is 23 steps and takes a couple of minutes. It is run once.

An older calibration still loads and still works exactly as it did — each field
falls back to the frontal recording on its own — but it does not get any of
this. **Re-run the wizard.** The finish message tells you how many poses ended
up with their own span, and names any whose furrow or raise barely moved.

**Signal range** is what makes this usable at all. Kalidokit's brow scalar only
swings a few hundredths for most faces, so a raw threshold of `0.35` is
unreachable and the emotion simply never fires. Three modes:

| Mode | How the range is decided |
| --- | --- |
| `calibrated` | From a recorded **guided calibration** — the best mapping, and what the button below sets |
| `auto` | Learned continuously while tracking: the layer follows where your brow rests and how far it travels |
| `raw` | Kalidokit's numbers untouched. Almost never usable — it exists to show what upstream is working with |

**Calibrate expressions** runs a short guided pass, the way a game asks you to
hold a stick at its extremes. It prompts for the brow and smile first — relax,
furrow, raise, smile — then the blink across head poses: eyes shut facing the
camera, ~40° left and right with eyes open and shut, look up, look down. Get
into the pose, hold it, then press **Space** (or click the button) and it reads
for about a second and a half. `Esc` cancels. Nothing is on a timer, so the
reading always happens while you are actually in the pose. It then records
what your face reached and switches the mode to `calibrated`.

The blink poses exist because the eye solver confuses head rotation with a
half-closed lid. Open samples become the floor (looking down must not fire
`blink`); closed samples become the peak (a blink while turned must still
reach it).

The same open-eye turns also record a **pose-dependent brow rest**. Kalidokit's
brow scalar is a 2D ratio, so yawing or pitching the head changes it even when
the brows have not moved, and that used to fire angry/sorrow on a neutral face.
The facing-camera rest is still the zero for a straight-on expression; at a
turn the zero follows what those relaxed-face samples read, so looking aside
does not spend the furrow/raise span. Older calibrations keep working without
this until the wizard is run again — the steps are the same ones already there
for blink, not a longer pass.

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

Rest is a band, not a point. Mapping the whole recorded furrow onto 0..1 used
to make the noise around a still face look like a full **angry**, and then
**Angry at** could not turn it off — `ramp(1, threshold)` is 1 for every value
that slider offers. The rest band is deadzoned, and a weak recording cannot
amplify tracker noise into a full expression.

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
an exclusive pick. A smile writes `fun` and/or `joy` according to which cells
the loaded model actually has.

### Language

The panel speaks English or Portuguese (BR), switched in the PSX Hands card. A
fresh profile picks its language from the browser's own, so a machine in
Portuguese starts in Portuguese; a saved profile always wins over that, and the
picker over both.

**The spoken calibration prompts follow that setting**, because the voice reads
the same translated strings the prompt shows and can never drift from what is on
screen. Setting `lang` on the utterance is not enough to get a Portuguese voice,
though: it is only a hint, and Chrome on Windows routinely ignores it and speaks
with the system default — which reads a Portuguese prompt in an American accent
and is most of the way to unintelligible. So a matching voice is named
explicitly: exact locale first (`pt-BR`), then any voice of the same language
(`pt-PT` before an English one), preferring local voices over network ones,
which stall long enough for the prompt to arrive after the pose is over. The
list loads asynchronously and is empty when first asked for, so the answer is
cached per language and dropped again on `voiceschanged`.

If no Portuguese voice is installed at all, nothing in the browser can fix it —
the console says so once, in as many words, and the prompts are read by the
system default until one is added in the OS speech settings.

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

**Calibrate motion** sets them for you. Unlike the expression wizard it does not
wait for a keypress: a motion pose either has no hand free to reach the keyboard
or turns back toward it to press the key, jolting the exact signal being read. So
each step prints its prompt, counts you in for five seconds, then reads while you
hold. **Space** skips the count-in once you are already set, **Esc** cancels.

The steps, in order:

| Step | What it sets |
| --- | --- |
| Face the camera | the rest pose everything else is measured against |
| Hold completely still | **Steadiness** — the spread of a pose that is not moving is your camera's own noise |
| Turn left / right / look up / down | **Head / neck gain**, mapping your widest turn onto the neck's ±0.8 clamp |
| Tilt your head to one side | **Head-tilt isolation**. Shoulders stay level, so whatever the shoulder line does is the pose solver copying a head roll onto the spine — stripped at runtime so an ear-to-shoulder no longer tips the chest |
| Lean your torso to one side | **Torso lean gain**, against the spine's ±0.7 clamp |
| Shrug your shoulders up | **Shoulder follow** — how far your own shoulders actually travel |
| Arms straight out to the sides | **Reach**. Arms out sit in the image plane, where the tracker has no depth to get wrong, so this is the cleanest reach reading there is |
| Point one arm at the camera | **Depth gain**. What is left of your arm's length after the across and up components have been accounted for has to be depth, so comparing it against the depth Mediapipe reported measures how far that estimate is compressed |
| Put both hands on your head | raises **Reach** if the avatar's hands still cannot make it to its skull. This pose is foreshortened, so it may only raise the T-pose reading, never pull it back down |

Full-body tracking has to be on for the head-tilt isolation and the arm steps. Torso *pitch* rides on the
head signal, so **Torso gain** keeps its stock ratio to the head; lean and twist
come from the pose solver instead and get their own gain. A head tilt (ear to
shoulder) is not a lean, but the pose solver reports it as one; **Head-tilt
isolation** is the fraction of that coupling to strip. It can be dragged live
without re-running the wizard.

### Tracking sanity

Visibility never catches the failure that actually hurts. A tracker that has
locked onto the wrong thing reports its landmarks as perfectly confident — the
numbers arrive, they are just not you — and that is the frame the arms and the
head jump on.

Both trackers say where your face is, in the same normalised video frame: the face
mesh as `head.position`, the pose as its nose landmark. (The call site has always
passed those pose landmarks as a second argument that this layer used to drop.) The
gap between the two is never zero — one is a face box, the other a nose tip — but it
belongs to your face and holds still for as long as both are tracking you. When it
jumps, one of them has lost you.

Nothing here is a constant: both the gap and how much it normally wobbles are
learned from your own camera, and a frame is disbelieved when it sits several
learned deviations out. The two axes are scored separately, so if the mirroring
leaves the horizontal gap varying it simply learns a wide wobble and stops
contributing rather than firing all the time. After a long run of rejections it
gives up and re-learns, or standing up once would lock the gate shut for good.

Arm length is checked the same way, per side — one arm can go missing while the
rest of the body tracks fine. Only an *over-long* arm is rejected: measured length
drops whenever the arm turns toward the lens, which is the same depth compression
the depth calibration exists to undo, and rejecting short arms would throw away
every gesture toward the camera.

A frame that fails either check is coasted rather than followed. The neck and torso
have no hook that can drop a frame, so there they get an almost-zero lerp instead —
the jump becomes a wobble, and the next believable frame pulls it back.

A hand on the face is a different failure. The mesh reports a blink, a shout, a
brow jump — it is looking at a palm — while the pose still has you. When a wrist
or palm overlaps the head in the video (measured in this person's own ear-span,
one hand is enough), blink / mouth / emotions hold the last good frame, and a
jumped mesh does **not** reject the pose: covering a yawn is an arm gesture, and
killing the retarget is what made that look like tracking had died. The neck only
crawls if the mesh actually jumped; otherwise the head still follows.

### Adaptive smoothing

A flat damping factor has to choose. Enough of it to settle the tremor of a held
pose turns a fast movement to rubber; enough responsiveness for the fast movement
leaves the tremor in. That trade is most of what reads as "jelly".

**Adaptive smoothing** is a one-euro filter: the cutoff is a function of speed, so
a still pose is filtered hard and a moving one barely at all. **Steadiness** is the
cutoff at rest, in Hz — lower is smoother, and the hold-still calibration step
measures it off your own camera. **Responsiveness** is how quickly that cutoff opens
up once you move. **Damping** still applies on top, and is the whole of the
smoothing when adaptive is off.

The bundle's smoothing sites hand over only the lerp factor, never the value being
lerped, so the speed is measured here off the solved head rotation and the tracked
wrists, and the faster of the two drives the cutoff. Which bone a site belongs to
is read back out of the factor itself (`0.04 + dt*4` for the neck, `*2` for the
torso, `*6` for the wrist), so the torso keeps trailing the head by the same ratio
it does upstream instead of every bone flattening onto one cutoff.

### Arm retarget

Kalidokit hands the rig three Euler angles per arm bone, estimated from the
landmark directions and then clamped. Replaying those angles puts the avatar's
hand wherever they happen to point it, which is not where the camera saw the
hand — put your palms on your skull and the avatar's hands stop at its ears. No
gain fixes that, because scaling a rotation sweeps the hand along an arc instead
of moving it toward the target.

**Arm retarget** drives the arm from the landmarks instead. It reads the
shoulder → wrist vector the camera measured in a torso frame built from your own
shoulders and hips, rebuilds it in the same frame on the model, scales it by the
model's arm length over yours, and solves the two bones so the hand lands on it.
The elbow landmark is the pole, so nothing guesses which way the elbow folds.

- **Reach** — how much further than your own elbow angle to extend. It exists
  for a model whose arms are too short to get to its own head. Now that the bend
  is measured at the elbow, the hand generally arrives on its own, so on ordinary
  proportions anything above `1` overshoots — it can only push the hand further
  along a direction that was already right. Leave it at `1` unless the hands
  visibly fall short. **Calibrate motion** sets it, and only raises it when the
  model's hands really do not make it to its head.
- **Depth gain** — how much the toward-camera axis counts. It used to sit below
  1 to damp Mediapipe's noisiest axis; damping is the adaptive filter's job now,
  and since the elbow angle sets how *far* the hand goes, this only steers
  *direction*. A value under 1 tilts every gesture toward the camera off to one
  side, so the hand never gets in front of the face — which is why it now
  defaults to `1`. The depth calibration measures the rest.
- **Wrist from hand model** — Mediapipe runs a separate hand model, and it is
  the only tracker that actually looks at your hand; it is already the one
  driving the fingers. The wrist used to be the hand solver's Euler angle
  instead — an angle inferred from where the *arm* was pointing, which is why
  the fingers and the wrist could disagree about which way the palm faced. The
  wrist is now aimed straight at the hand's own middle knuckle. Holistic drops
  the hand model whenever the hand blurs or leaves frame, and the Euler wrist
  takes over for those frames — it reads better here than it ever did on the
  stock rig, because the forearm under it is now in the right place. Turn this
  off to go back to the Euler wrist everywhere.
- **Forearm twist** — turning a palm from down to up is forearm rotation, and
  nothing upstream drives it: `aimBone` deliberately leaves each bone's twist at
  its rest value, and neither wrist source reports anything but flexion. So the
  palm stayed wherever the bind pose left it, and "which way is the hand facing"
  is almost entirely that axis. The hand model carries the index and little
  knuckles, and VRM carries `IndexProximal` / `LittleProximal`, so the same
  anatomical direction is measured on both and the difference rolled onto the
  forearm. The pose model's own knuckle landmarks are the fallback; it finds
  them as a by-product of finding the arm and they jitter by more than the palm
  is wide. Models without finger bones fall back to no twist at all.
- **Face anchor** — a hand at the face is a gesture *about the head*, and
  measuring it out from the shoulder in arm-lengths gets it wrong on exactly the
  models this fork is for. A low-poly avatar is a big head on short arms, so its
  face sits at a far steeper angle up from its shoulder than a person's does:
  the direction is carried across faithfully and is faithfully wrong, and the
  only way to land on the face is to raise the real hand well above one's own
  head. Near the face, this aims at the head instead — the hand's offset from
  your own nose, scaled by the two heads, hung off the model's head bone. It
  blends in by how close the hand is, so an arm doing something unrelated to the
  head is untouched. Closeness for a hand *in front of* the face is read in the
  video, not in world depth — that is the axis the tracker compresses, so a
  covering palm sat on the skull in 3D while the camera showed it on the mouth.
  When that hand occludes the face, the target is held a palm out along the
  chest so the IK has somewhere in front of the mouth to reach. Right at the
  face the hand's position wins and the elbow bend gives; away from it the
  bend is the honest signal and the distance gives.
- **Shoulder follow** — nothing upstream drives the shoulder bones at all, so a
  raised arm keeps its shoulder pinned and the upper arm cuts through the neck.
  This lets the shoulder turn part of the way toward the target. The hand does
  not move when it does — the target is fixed before the shoulder is allowed to
  go anywhere, because the landmarks already carry the person's own shrug and
  counting it twice would lift the hand back off the head. Models without a
  shoulder bone ignore it.

- **Prediction** — Mediapipe runs well under the render rate, so most frames re-use
  a target measured milliseconds ago and the hand trails whatever it is following.
  The velocity between the last two inferences says where that target has got to
  since, and this is how much of that gap to carry forward. Capped hard: an
  extrapolation is a guess, and one that can move the hand further than a knuckle
  is worse than the lag it removes.
- **Dropout hold** — a lost landmark used to hand the arm straight back to the
  stock Euler rig, which writes a completely different pose on the next frame, and
  that jump is most of what "it lost tracking" feels like. Instead the last solved
  rotations are held for this long, then eased back to the bone's rest over the
  same span, and only then is the arm given back — by which point stock's own
  answer for an arm it cannot see is near rest too, so the handover no longer
  shows. The shoulder goes back where the model loaded it at the same moment;
  nothing upstream writes that bone, so one left turned would stay turned.

It needs full-body (holistic) tracking; the pose-only path reports its keypoints
in another space, so there the arms stay on the stock Euler rig. An arm that was
never solved at all is left to the stock rig from the first frame rather than
eased into it. Bone lengths are never stretched.

The elbow angle is measured at the elbow, not derived from how far away the hand
ended up. It is a ratio between two landmark distances, so it does not care how
big the person is, how far from the lens they are, or what **Reach** is set to —
every one of which corrupts the *length* of the wrist offset. Taking the bend from
that length is what used to weld the arm into one piece: any Reach above 1 pushes
the length past what the model's arm can span, the solve clamps it, and a clamped
span is a straight arm in every pose. Reach now closes part of the gap to full
extension in proportion to how extended the arm already is — all of it when
straining upward for the model's own head, almost none at a folded elbow.

`mapDir` carries a vector's components from the landmark torso frame into the
model's. The two routinely disagree about handedness — the landmark frame's up runs
down the screen, and its front is forced to face the camera — which makes that
mapping a reflection. A reflection maps *directions* perfectly well, which is why
the hand lands where it should, but it reverses which way a *rotation* goes: a palm
turned outward comes out turned inward. Mirroring flips it once more. The twist
measures that off the two frames rather than assuming either one.

The solve runs in the parent bone's space rather than the world's, so posing an
arm never rebuilds its subtree — which below the shoulder is every finger bone in
the hand. Only the target is filtered, not the bones on top of it: the noise is
in the landmarks, and a second filter would only stack more lag on the first.

### Tracking preview

Every Mediapipe result repaints the preview canvas at the webcam's own
resolution — the pose skeleton, both hands, and `FACEMESH_TESSELATION`, some two
and a half thousand 2D line segments, on the thread the inference just finished
on. Upstream keeps doing all of it after the preview is closed, because closing
it only sets the wrapper's opacity to `0`. `PSX.guide()` skips the paint while
nothing can see it. There is no switch: closing the preview *is* the switch.

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

**Auto throttle** is on by default and is the one to leave alone. It watches how
fast the machine is actually handing out animation frames, learns the best it has
seen rather than assuming a display rate, and sheds **tracking rate only** while
frames are being dropped — then takes it back as the headroom returns. Tracking is
shed because that is where the CPU goes and because it degrades gracefully: a face
solved twenty times a second still looks alive, where a render at twenty does not,
and dropping the render resolution mid-session would reframe the shot being
captured.

It also knows when to stop. If a cut does not buy a frame back, the load is not
this app's — an export, a game, a capture encoding — and it holds where it is
instead of starving the avatar for nothing. `PSX.perf()` in the console reports
what it is doing: `autoFps` is the ceiling in force, `trackHz` what the tracker is
managing, `frameMs` the best frame interval it has learned, `throttling` whether
it is currently holding anything back.

The fixed caps below still apply on top of it, for anyone who would rather pick a
number than have one picked:

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
| **Antialiasing** | `PSX.aa()` and `PSX.smaa()` both return `false`. The console had none, so neither MSAA nor the SMAA pass is a choice |
| **Texture filtering** | Always nearest-neighbour, no mipmaps, no anisotropy. The PS1 point-sampled; there was no bilinear filter to turn on |
| **Affine mapping** | Always on where a material has a uv varying to rescale. Turning it off would not be a preference, it would be a different console |
| **Upstream's replaced controls** | Pixelate, Outline, Water Animation, Light Cube Experiment, Light Colour, Light Position, Smile Detection, Enable Wink, Selfie / First Person Mode and **Call a friend** are hidden and pinned unconditionally — see below. An option to restore a control that costs performance or fights a PSX one would only be an option to make it worse |

Stack these with **Render scale** in the Effects tab: at `0.5x` the renderer
draws a quarter of the pixels, which is the single biggest GPU win and the
reason PSX mode looks right in the first place.

The Mediapipe options are read once at startup, so those apply on reload; the
rate caps and the auto throttle take effect immediately.

**Capturing this alongside OBS.** Everything above is paced off
`requestAnimationFrame`, and a browser stops handing those out when it decides
nobody is looking — a minimised window, or one Chrome has marked occluded because
OBS is full-screen over it. The avatar then freezes in the capture while the page
looks fine the moment you click back to it. Capture it as a **Browser source**,
which renders offscreen and is never occluded, or launch the browser with
`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding` and
keep the window unminimised.

## Keeping the hooks alive

The PSX layer only runs because a call to it was written into ~35 places in the
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

From the running app, `PSX.verify()` in the console counts the call sites in
the bundle the browser actually loaded and names the missing ones. `PSX.dump()`
logs the resolved materials, UV binds and the last solved face.

### If psx.js does not load

Those ~35 call sites are unguarded and on the hot path — the render loop, the
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

- **Face Expressions** — Trigger threshold, Release margin, Minimum hold, Mouth gain, Blink gain, Preview cell (force one expression for calibration)
- **Emotion Detection** — Detect emotions, Signal range (`calibrated` / `auto` / `raw`), One emotion at a time, Speech first, Talking at, Signal gain, Angry at, Sorrow at, Smile at, live readout, Calibrate expressions and Reset auto range
- **Motion Calibration** — Motion calibration, Head / neck gain, Torso gain, Torso lean gain, Head-tilt isolation, Arm gain, Damping, Arm retarget, Wrist from hand model, Reach, Depth gain, Shoulder follow, Forearm twist, Face anchor, Prediction, Dropout hold, Tracking sanity
- **Performance** — Performance caps, Tracking rate, Render rate, Lite pose model
- **PSX Hands** — Language, Driven fingers (`all fingers` / `thumb only` / `none`), Export settings, Import settings, Reset PSX settings

Every switch is **off by default**, and with it off the matching hooks fall back
to stock behaviour. **Arm retarget** is the one exception: it is a rig rather
than a gain, it is right for every model, and it is on. Anything the app reads only at startup — PSX mode, MSAA,
SMAA, render scale, shadows, Mediapipe model options — applies on reload, and the
card says so once you touch one. Everything else is live.

Settings persist in `localStorage` under the key `kf3d.psx`. **Export settings**
downloads that snapshot as JSON — every setting plus all three calibrations, the
recorded expression spans, the vowel prototypes and the motion gains.
**Import settings** loads it on another device or after a cache clear, and says
underneath which of the three calibrations the file actually carried: a file
exported before you ran one does not have it, and the one already loaded is kept
rather than wiped. Reload if the card says so
— render scale and Mediapipe options still apply on startup.

### Background colours

The app ships five colour presets and an iro picker, but the picker keeps
exactly one colour under `savedIro` — so there was nowhere to keep a second one
and no way to drop one you were done with.

**Save colour** puts the picker's current colour into the app's own uploaded-
background list, which means it shows up as a swatch in the **2D** tab next to
your uploaded images, applies when you click it there, is deleted by the same
button an uploaded image has, and is persisted with everything else. Under the
picker, clicking a saved swatch loads it back in to edit — **Save colour**
becomes **Update colour** and replaces that swatch rather than adding a
near-identical one — and **×** deletes it.

Deleting an uploaded background also got less exciting. The list is filtered by
`pano` before it is drawn, but the delete button reported the index it was drawn
at and spliced that out of the *unfiltered* list, so with one 3D upload sitting
ahead of your 2D ones every 2D delete removed the wrong background. It now walks
the same filter the renderer did.

## Calibrating a model

1. Load your `.vrm`, open **Settings**, turn on **PSX mode**, reload.
2. Use **Preview cell** to force each expression key in turn and confirm the atlas cell is right. If every expression lands on the wrong cell, toggle **Flip V axis**.
3. If the face chatters between two cells, raise **Release margin** or **Minimum hold**.
4. If quiet talking doesn't register, raise **Mouth gain**; same for **Blink gain**.
5. For a material that will not switch, `PSX.dump()` in the console lists the resolved UV binds, the current cell, and the last solved `brow` / `smile` values with the emotion weights they produced.
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

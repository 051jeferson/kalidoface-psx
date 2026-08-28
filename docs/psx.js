/*
 * psx.js - PSX / low-poly compatibility layer for Kalidoface 3D.
 *
 * This project ships only the built bundle (docs/assets/index.*.js); there is no
 * source tree in the repo, so this file is loaded as a plain script BEFORE the
 * module bundle and the bundle calls back into `window.PSX` at a handful of
 * patched call sites:
 *
 *   PSX.setupRenderer(renderer)  - replaces the hardcoded setPixelRatio(max(2,dpr))
 *   PSX.aa()                     - value of WebGLRenderer `antialias`
 *   PSX.smaa()                   - whether the SMAA EffectPass is added
 *   PSX.fingers()                - finger list used by the hand rig
 *   PSX.onModel(vrm, gltf)       - called once per loaded VRM
 *   PSX.tick(vrm)                - called once per frame, after vrm.update()
 *   PSX.face(vrm, rig)           - the solved Kalidokit face, before it lands
 *   PSX.headGain() / bodyGain() / leanGain() / spineLean() / armGain()
 *                                - neck, torso pitch, torso lean, and arm rotation gain
 *   PSX.pose(world, image, hands) - the holistic landmarks, before Kalidokit
 *   PSX.arm(...)                 - retargets one arm; true suppresses the rig
 *   PSX.smooth(t)                - lerp factor for every tracked bone
 *   PSX.frame()                  - whether this animation frame gets rendered
 *   PSX.nextTrack(fn)            - schedules the next Mediapipe inference
 *   PSX.mpOptions(opts)          - Mediapipe model options, before setOptions
 *   PSX.shadows() / shadowSize() - shadow maps; both hardcoded off
 *   PSX.gaze(vrm, euler)         - eye aim; a no-op by design
 *   PSX.overlay(inst, opts)      - queued subnav background animation
 *   PSX.overlayOpen(inst)        - the state that animation is heading to
 *
 * The controls are injected into the app's own Effects and Settings tabs and
 * reuse their markup and scoped class names, so they look like the rest of the
 * panel. Settings live in localStorage under "kf3d.psx".
 */
(function () {
  'use strict';

  var STORE_KEY = 'kf3d.psx';

  // Used to assemble GLSL and the calibration prompts. Declared here because
  // the shader sources are built at load time, and a `var` further down would
  // still be undefined then - join(undefined) silently uses a comma.
  var NL = String.fromCharCode(10);

  // The browser already knows what language this person reads, and a fresh
  // profile guessing English at someone whose whole machine is in Portuguese
  // means the spoken prompts arrive in the wrong language too - the voice
  // follows the panel. Only the default: a saved profile still wins, and the
  // picker still overrides both.
  function localeLang() {
    try {
      var n = window.navigator || {};
      var l = String((n.languages && n.languages[0]) || n.language || '');
      if (l.toLowerCase().indexOf('pt') === 0) return 'pt';
    } catch (e) {}
    return 'en';
  }

  var DEFAULTS = {
    // render at 1 device pixel per CSS pixel and let CSS upscale with
    // image-rendering:pixelated -> hard pixel edges instead of a 2x downsample
    pixelRatio: 1,
    // 'en' | 'pt' - the panel language, the app's own labels, and the voice
    lang: localeLang(),
    // A calibration pose is held at arm's length from the screen, where the
    // prompt cannot be read and - worse - there is no way to tell the count-in
    // from the reading. The beeps and the spoken prompt carry that across the
    // room, and they are one switch: nobody wants the tones without the words
    // or the words without the tones, and two toggles for one answer is one
    // toggle too many.
    calCues: true,

    // --- the actual PS1 signatures ------------------------------------
    // The console had no floating point in its GPU: vertices were snapped to
    // an integer screen grid, which is where the characteristic wobble comes
    // from. Lower grid = coarser = wobblier.
    vertexSnap: true,
    snapGrid: 160,
    // 15-bit output, 5 bits per channel, with ordered dithering to hide the
    // banding. 32 levels per channel is the real thing.
    dither: true,
    colorLevels: 32,

    // weight an expression has to clear before it takes over its material
    threshold: 0.35,
    // how far below `threshold` an expression may sag before it lets go.
    // Stops the face chattering between two cells at the boundary.
    hysteresis: 0.1,
    // minimum ms a cell stays on screen once picked
    holdMs: 80,
    // pre-threshold multiplier, so quiet talking still registers
    mouthGain: 1,

    // --- eyes ----------------------------------------------------------
    // One number: how shut the eye has to look before it counts as shut.
    //
    // This was a two-point range and a gain, which is three controls for a
    // question with one answer. On an atlas a blink is binary - the cells are
    // picked, never blended - so the 0..1 value in between had no consumer:
    // everything downstream only ever asked whether it had crossed a bar. The
    // range mapped a number onto another number so that a gain could scale it
    // so that a threshold could compare it, and the person setting all three
    // was aiming at this one.
    //
    // Everyone's eyes read differently and the mesh does not agree with itself
    // between faces - narrow eyes, glasses and a low camera all park a
    // wide-open eye well up the scale - which is why it is a setting at all
    // and why the wizard measures it.
    eyeShutAt: 0.5,
    // How far to raise that while the brows are down, at a full furrow.
    // Furrowing narrows the eye - the same muscles do both - so without this
    // an angry face keeps tripping the blink cell, and on an atlas that means
    // the angry cell never gets to stay on screen. Measured by the wizard;
    // no slider, because there is nothing here a person could aim at by eye.
    // 0 = never measured, which leaves it inert.
    eyeFurrowLift: 0,

    // '' = live tracking; otherwise force this expression key (calibration)
    preview: '',

    // 'all' | 'thumb' | 'none' - which fingers the hand solver drives
    fingers: 'thumb',

    // --- emotion presets ----------------------------------------------
    // Where the 0..1 signal range comes from:
    //   'calibrated' - the guided calibration below. Records what each face
    //                  actually reaches, so a brow that furrows far but barely
    //                  raises gets a different span in each direction.
    //   'auto'       - learn the range continuously while tracking
    //   'raw'        - Kalidokit's numbers untouched. Almost never usable:
    //                  the brow scalar only swings a few hundredths, so a
    //                  threshold of 0.35 can never be reached.
    // Not on the panel. The wizard sets it, and the only other value anyone
    // would reach for is the one it already falls back to on its own.
    signal: 'auto',
    // recorded by the guided calibration; null until it has been run
    cal: null,
    // recorded by the mouth wizard: one feature vector per vowel plus a rest
    // pose. null until it has been run, and the vowels fall back to a formula.
    mouth: null,
    // Run the pose correction at all - the recorded per-pose mapping and the
    // learned ladder both. Off is the plain signal with nothing moving under
    // it, which is what manual tuning needs: a reading that will not be tuned
    // out from underneath the sliders. Not on the panel - it is a thing to do
    // from the console while chasing a fault, not a setting to leave off.
    poseFix: true,
    // Shifts the finished brow reading, after the gain, in the same units the
    // readout shows. The one knob that fixes a zero sitting in the wrong place
    // without recording anything.
    browBias: 0,
    // multiplier applied after normalisation
    browGain: 1,
    // how far the brow has to travel before it reads as that emotion
    angryAt: 0.35,
    sorrowAt: 0.35,
    // How long the brow has to stay past that before the emotion is written.
    // A drift spike while the head is turning lasts a frame or two; a face
    // making an expression holds it. Only the rise waits - an expression that
    // is over ends when it ends.
    emotionHold: 100,
    // how wide the mouth corners have to go before it reads as a smile
    smileAt: 0.3,
    // how much closer another vowel has to be before the mouth swaps cell.
    // 0 = swap on any lead, which flickers; this is the hysteresis of speech.
    mouthStick: 0.25,

    // --- motion -------------------------------------------------------
    // neck rotation gain; stock is 1
    headGain: 1,
    // Chest / spine / upper chest pitch gain; stock is 0.05. This one rides on
    // the head and keeps a fixed ratio to it, so the head-turn calibration
    // step is what sets it - there is nothing a slider of its own could say.
    bodyGain: 0.05,
    // the same three bones' lean and twist, which come from the pose solver
    // rather than the head. Stock shares bodyGain; the lean calibration needs
    // them apart, since one signal wants a small gain and the other a large one.
    leanGain: 0.05,
    // How much of Spine.z is treated as a head roll the pose solver copied.
    // 0 = stock (a head tilt leans the torso); 1 = strip a 1:1 coupling.
    leanHead: 0,
    // Arm/hand euler multiplier; 1 = stock Kalidokit. Only reaches the wrist
    // roll while the retarget is on, since the retarget replaces the upper and
    // lower arm angles outright - and the T-pose step measures it, so it is
    // not a slider either.
    armGain: 1,

    // --- adaptive smoothing ---------------------------------------------
    // One-euro rather than a flat damping factor: filter hard while the pose
    // is held, barely at all while it moves. A flat factor has to choose
    // between settling a held pose and following a fast one, and there is no
    // setting of it that does both - so there is no longer a switch back to it.
    // Hz. The cutoff a motionless signal is filtered at - lower is smoother,
    // and is what the "hold still" calibration step measures.
    minCutoff: 0.9,
    // how fast that cutoff opens up as the signal moves. 0 = never, i.e. a
    // plain low-pass at minCutoff.
    beta: 0.35,

    // How much of the measured forearm twist to apply. Turning a palm from
    // down to up is forearm rotation, and nothing upstream drives it - the
    // wrist solver only ever gets flexion. 0 = leave it at rest, as upstream.
    twist: 1,

    // --- arm retarget ---------------------------------------------------
    // Aim the arm at the hand the camera saw instead of replaying Kalidokit's
    // solved angles. Not a panel control - it is the rig, and the one thing
    // that turns it off is a model whose arm it cannot drive, which it works
    // out for itself.
    armIK: true,
    // model arm lengths per unit of the user's. 1 = the model reaches exactly
    // as far, in its own proportions, as the person does. Raise it when a
    // short-armed model cannot get its hands to its own head.
    armReach: 1,
    // Gain on the toward-camera axis of the hand target. It used to sit below 1
    // to damp Mediapipe's noisiest axis, but damping is the adaptive filter's
    // job now, and since the elbow angle sets how far the hand goes this only
    // steers direction - where a value under 1 tilts every gesture toward the
    // camera off to one side, so the hand never gets in front of the face.
    // 1 = believe the reported depth. The point-at-the-camera step measures
    // it; there is no value here for a person to find by eye.
    armDepth: 1,
    // Gain on the up axis of the hand target, as a factor on Reach. Reach is
    // measured with the arms straight out to the sides, where nothing is
    // foreshortened, so it is honest about lateral travel and says nothing
    // about vertical. A low-poly model whose hands make it out to the sides
    // but not up to its own head needs the two to differ, and folding both
    // into one number is what made the T-pose and hands-on-head readings
    // fight over it.
    reachUp: 1,
    // Per-side factors on Reach. A camera off to one side, or a shoulder
    // nearer the lens, makes one arm read consistently shorter than the other.
    reachR: 1,
    reachL: 1,
    // how far the shoulder bone follows the arm, 0 = pinned (stock). Nothing
    // upstream drives it at all, which is why a raised arm clips the neck.
    shoulder: 0.25,
    // How much a hand near the face is aimed at the model's head rather than
    // measured out from its shoulder. 0 = always shoulder-anchored, as upstream.
    headAnchor: 1,
    // how much of the gap between inferences to dead-reckon across. Mediapipe
    // runs slower than the render loop, so without this the hand target is a
    // frame or two behind whatever it is chasing. 0 = off.
    predict: 0.5,
    // ms to coast the arm on its last good target before easing it back to the
    // stock rig. 0 = hand it straight back, which is what upstream does.
    armHold: 350,
    // --- backgrounds ----------------------------------------------------
    // Saved background colours, as hex strings. The app keeps its own
    // background list in a plain in-memory store that nothing ever writes to
    // storage, so a colour saved into it is gone on the next reload - and an
    // export could only ever have carried whatever the running session happened
    // to hold. Keeping them here is what makes them survive a reload and ride
    // along in an exported profile.
    colours: [],

    // --- performance --------------------------------------------------
    // Shed tracking rate on its own while the machine cannot keep up, and take
    // it back when it can. Independent of the fixed caps, and on by default:
    // it costs nothing while there is headroom and it is the difference
    // between a stutter and a slightly slower face while something else on the
    // machine is busy.
    perfAuto: true,
    // Keep both loops running while the window is not on screen. Chromium
    // hands out no animation frames to a window that is minimised or fully
    // covered by another one, so the avatar freezes mid-stream and only
    // catches up when the window is raised. On by default: being on camera
    // while you are doing something else in front of it is the whole job.
    keepAwake: true,
    // Mediapipe inferences per second. 0 = one per animation frame (stock),
    // which is where nearly all the CPU goes.
    //
    // 24 rather than uncapped. Holistic never reaches a display rate anyway, so
    // the frames an uncapped tracker asks for are frames it cannot deliver -
    // it just spends the whole CPU finding that out. 24 is above what the face
    // needs to look alive and below what the machine was straining at.
    trackFps: 24,
    // Rendered frames per second. 0 = display rate (stock).
    //
    // 30, because this is a PSX fork: the era's own cadence was 20-30, so a cap
    // here is the look rather than a concession to the machine. It halves GPU
    // time on a 60Hz screen and nothing about the result is worse for it.
    renderFps: 30,
    // Holistic modelComplexity 0 (lite) instead of 1.
    //
    // Off by default, and it is the one performance setting that is a real
    // trade rather than a free win. The arm retarget is built on pose landmark
    // positions - which wrist a hand sits on, whether a palm is behind the
    // skull, how long a forearm reads - and those are exactly what the lite
    // network is worse at. The rate caps cost latency nobody sees; this costs
    // accuracy in the one part of the fork that needed the most work.
    poseLite: false,

    verbose: false
  };

  var STOCK_HEAD_GAIN = 1;
  var STOCK_BODY_GAIN = 0.05;
  // stock shares one constant between the torso's pitch and its lean
  var STOCK_LEAN_GAIN = 0.05;

  var MOUTH_KEYS = { a: 1, i: 1, u: 1, e: 1, o: 1 };
  // A toothy smile is an open, spread mouth - the solver writes A/I/E. Rounded
  // U/O cannot be a smile, so those are what still count as talking over one.
  var SPEECH_OVER_SMILE = { u: 1, o: 1 };
  var BLINK_KEYS = { blink: 1, blink_l: 1, blink_r: 1 };

  // Ranges and enums for the stored settings. Values come back out of
  // localStorage, which survives schema changes, hand editing and a half-written
  // save - and several of these reach WebGL directly. A pixelRatio of 0 or a
  // snapGrid of "large" is a black screen with no way back but devtools, so
  // anything that does not fit its spec falls back to the default.
  var SPEC = {
    pixelRatio: { min: 0.25, max: 2 },
    snapGrid: { min: 32, max: 480 },
    threshold: { min: 0, max: 1 },
    hysteresis: { min: 0, max: 0.5 },
    holdMs: { min: 0, max: 400 },
    mouthGain: { min: 0.25, max: 3 },
    eyeShutAt: { min: 0.05, max: 0.95 },
    eyeFurrowLift: { min: 0, max: 0.6 },
    browGain: { min: 0.25, max: 4 },
    browBias: { min: -1, max: 1 },
    angryAt: { min: 0, max: 0.95 },
    sorrowAt: { min: 0, max: 0.95 },
    emotionHold: { min: 0, max: 400 },
    smileAt: { min: 0, max: 0.95 },
    mouthStick: { min: 0, max: 1 },
    headGain: { min: 0, max: 1.5 },
    bodyGain: { min: 0, max: 0.2 },
    leanGain: { min: 0, max: 1 },
    leanHead: { min: 0, max: 1 },
    armGain: { min: 0.5, max: 2.5 },
    minCutoff: { min: 0.2, max: 5 },
    beta: { min: 0, max: 3 },
    armReach: { min: 0.5, max: 2 },
    armDepth: { min: 0, max: 2 },
    reachUp: { min: 0.5, max: 2 },
    reachR: { min: 0.5, max: 2 },
    reachL: { min: 0.5, max: 2 },
    shoulder: { min: 0, max: 0.6 },
    headAnchor: { min: 0, max: 1 },
    twist: { min: 0, max: 1 },
    predict: { min: 0, max: 1 },
    armHold: { min: 0, max: 1000 },
    trackFps: { min: 0, max: 60 },
    renderFps: { min: 0, max: 60 },
    colorLevels: { one: [8, 16, 32, 64] },
    fingers: { one: ['all', 'thumb', 'none'] },
    signal: { one: ['calibrated', 'auto', 'raw'] },
    lang: { one: ['en', 'pt'] }
  };

  var CAL_FIELDS = ['browRest', 'browDown', 'browUp', 'smileRest', 'smileMax'];

  // A saved colour is whatever the app's own picker wrote, which is six digits,
  // plus the eight-digit form the transparent preset uses. Three-digit CSS hex
  // is neither, and `isAlphaHex` reads length alone - so a '#0f0' let through
  // here would come back out of an imported file as an opaque colour that the
  // swatch draws as a checkerboard.
  // Narrower than this and the eye map is a division by almost nothing: one
  // noisy frame would swing the lid from open to shut. Declared here because
  // `load()` reads it during the eye-calibration migration, which runs before
  // anything further down the file exists.
  var EYE_SPAN_MIN = 0.05;

  var HEX_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  // An imported file is not necessarily one this app wrote. Colours cost a
  // localStorage write each, so the list is capped rather than trusted.
  var MAX_COLOURS = 64;

  function okHex(v) {
    if (typeof v !== 'string') return null;
    var t = v.trim();
    return HEX_RE.test(t) ? t.toLowerCase() : null;
  }

  var VOWELS = ['a', 'i', 'u', 'e', 'o'];
  // The features a vowel is recognised by: how wide the mouth is, how open it
  // is, and Kalidokit's own five shape weights. The shape weights all rise
  // together with the jaw, which is why they cannot pick a vowel on their own -
  // but the *differences* between them still separate one vowel from another,
  // and a recorded prototype per vowel is what turns that into a decision.
  var MOUTH_DIMS = 7;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function okVec(vec) {
    if (!vec || vec.length !== MOUTH_DIMS) return false;
    for (var d = 0; d < MOUTH_DIMS; d++) if (!isNum(vec[d])) return false;
    return true;
  }

  function sanitize(key, v) {
    var def = DEFAULTS[key];
    if (key === 'mouth') {
      if (!v || typeof v !== 'object') return null;
      var keys = ['rest'].concat(VOWELS);
      for (var m = 0; m < keys.length; m++) {
        if (!okVec(v[keys[m]])) return null;
      }
      // recorded before the grin step existed, and still usable without it
      if (v.smile && !okVec(v.smile)) delete v.smile;
      return v;
    }
    if (key === 'colours') {
      if (!Array.isArray(v)) return [];
      var out = [];
      for (var c = 0; c < v.length && out.length < MAX_COLOURS; c++) {
        var hex = okHex(v[c]);
        if (hex && out.indexOf(hex) === -1) out.push(hex);
      }
      return out;
    }
    if (key === 'cal') {
      if (!v || typeof v !== 'object') return null;
      for (var i = 0; i < CAL_FIELDS.length; i++) {
        if (!isNum(v[CAL_FIELDS[i]])) return null;
      }
      return v;
    }
    var spec = SPEC[key];
    if (spec && spec.one) return spec.one.indexOf(v) === -1 ? def : v;
    if (typeof def === 'boolean') return typeof v === 'boolean' ? v : def;
    if (typeof def === 'number') {
      if (!isNum(v)) return def;
      return spec ? clamp(v, spec.min, spec.max) : v;
    }
    return typeof v === typeof def ? v : def;
  }

  var cfg = load();

  function load() {
    var out = {};
    var saved = null;
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        saved = JSON.parse(raw);
        for (var j in saved) if (j in out) out[j] = sanitize(j, saved[j]);
      }
    } catch (e) {}
    out.preview = '';
    migrateEyeCal(out, saved);
    return out;
  }

  // The eye reading has been stored two ways before this one: inside `cal` as
  // `blinkOpen`/`blinkClosed`, and briefly as an `eyeOpenAt`/`eyeShutAt` pair.
  // Both were a range where this is a line, and the line that best replaces a
  // range is its midpoint - so either shape converts rather than being thrown
  // away and asked for again.
  //
  // Takes the raw saved object, not the loaded settings: `eyeOpenAt` is no
  // longer a key of DEFAULTS, so by the time `out` is built it has been
  // dropped. Only runs while the setting is still at its default, so a line
  // the person has since moved is never overwritten.
  function migrateEyeCal(out, saved) {
    if (out.eyeShutAt !== DEFAULTS.eyeShutAt) return;
    var lo = null, hi = null;
    if (saved && isNum(saved.eyeOpenAt) && isNum(saved.eyeShutAt)) {
      lo = saved.eyeOpenAt;
      hi = saved.eyeShutAt;
    } else {
      var c = out.cal;
      if (!c || !isNum(c.blinkOpen) || !isNum(c.blinkClosed)) return;
      lo = c.blinkOpen;
      hi = c.blinkClosed;
    }
    if (!(hi - lo >= EYE_SPAN_MIN)) return;
    out.eyeShutAt = clamp((lo + hi) / 2, SPEC.eyeShutAt.min, SPEC.eyeShutAt.max);
  }

  function resetSettings() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    var fresh = load();
    for (var k in fresh) cfg[k] = fresh[k];
    resetCalibration();
    applyCanvasFilter();
    refreshModels();
    mirrorColours();
    syncControls();
    injectBgColours();
    askReload();
    console.log('[psx] settings reset to defaults');
  }

  var EXPORT_KIND = 'kalidoface-psx-settings';
  var EXPORT_VERSION = 1;

  function askReload() {
    pendingReload = true;
    var notes = document.querySelectorAll('.psx-reload-note');
    Array.prototype.forEach.call(notes, function (n) { n.style.display = ''; });
  }

  function snapshotSettings() {
    var data = {};
    for (var k in DEFAULTS) {
      if (k === 'preview') continue;
      data[k] = cfg[k];
    }
    return { kind: EXPORT_KIND, version: EXPORT_VERSION, settings: data };
  }

  // The panel is rebuilt whenever the language changes, so these are looked up
  // through variables the rebuild reassigns rather than held across it.
  var importNoteEl = null;
  var voiceNoteEl = null;

  // The voice list can arrive after the card was built, so this is called both
  // from the card and from `voiceschanged`.
  function syncVoiceNote() {
    if (!voiceNoteEl) return;
    // `null` is "the list has not loaded yet" and must not be reported as a
    // machine with no voices - that reads as a fault on every normal browser
    // for the first second of the session.
    var show = cfg.calCues && speechAvailable() === false;
    voiceNoteEl.style.display = show ? '' : 'none';
  }

  // Everything that makes this run on a small machine, in one place. Two of
  // these are read once at startup, so the reload note appears with them.
  function applyLowPower() {
    cfg.pixelRatio = 0.5;
    cfg.renderFps = 30;
    cfg.trackFps = 20;
    cfg.poseLite = true;
    cfg.perfAuto = true;
    save();
    // liveChange returns early on the first reload-only key, so the others
    // would never reach applyCanvasFilter. Drive it per key.
    liveChange('pixelRatio');
    liveChange('poseLite');
    liveChange('renderFps');
    syncControls();
  }

  function setImportNote(msg) {
    if (importNoteEl) setText(importNoteEl, msg);
  }

  function exportSettings() {
    var blob = new Blob([JSON.stringify(snapshotSettings(), null, 2)], {
      type: 'application/json'
    });
    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = 'kalidoface-psx-settings.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function settingsFromPayload(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.kind === EXPORT_KIND && parsed.settings && typeof parsed.settings === 'object') {
      return parsed.settings;
    }
    // raw localStorage dump
    if ('pixelRatio' in parsed || 'cal' in parsed || 'lang' in parsed) return parsed;
    return null;
  }

  // What each calibration is called when the import reports on it. A file that
  // carried none is a file exported before that calibration was run, and the
  // one already loaded is kept - so the import has to say which of the three
  // arrived, or a half-imported profile looks exactly like a whole one.
  var CAL_PARTS = [
    { key: 'cal', name: 'expression calibration' },
    { key: 'mouth', name: 'vowel calibration' }
  ];

  function applyImported(parsed) {
    var body = settingsFromPayload(parsed);
    if (!body) return null;
    var langChanged = false;
    var needsReload = false;
    var bad = {};
    for (var k in DEFAULTS) {
      if (k === 'preview' || !(k in body)) continue;
      var next = sanitize(k, body[k]);
      // a calibration that did not survive validation is not the same as one
      // the file never had, and only the first is worth telling anyone about
      if (body[k] && next == null && DEFAULTS[k] === null) bad[k] = true;
      if (cfg[k] === next) continue;
      if (k === 'lang') langChanged = true;
      if (NEEDS_RELOAD[k]) needsReload = true;
      cfg[k] = next;
    }
    save();
    resetCalibration();
    applyCanvasFilter();
    refreshModels();
    // rebuildPanels drops every injected card and re-runs the injection pass,
    // which redraws the swatches on its own; the syncControls path does not.
    mirrorColours();
    if (langChanged) rebuildPanels();
    else { syncControls(); injectBgColours(); }
    if (needsReload) askReload();
    return importReport(body, bad);
  }

  // Motion calibration has no object of its own - it lands as a handful of
  // gains - so it counts as carried when the file brought any of them.
  var MOTION_KEYS = ['headGain', 'bodyGain', 'leanGain', 'leanHead', 'armReach', 'armDepth',
    'reachUp', 'reachR', 'reachL', 'shoulder', 'minCutoff'];

  function importReport(body, bad) {
    var lines = [T('Settings imported')];
    for (var i = 0; i < CAL_PARTS.length; i++) {
      var p = CAL_PARTS[i];
      lines.push(T(p.name) + ': ' + (bad[p.key] ? T('unusable, kept the current one')
        : (p.key in body) && body[p.key] ? T('imported') : T('not in the file')));
    }
    var motion = false;
    for (var j = 0; j < MOTION_KEYS.length; j++) {
      if (MOTION_KEYS[j] in body) motion = true;
    }
    lines.push(T('motion calibration') + ': ' +
      (motion ? T('imported') : T('not in the file')));
    // A file written before colours were carried has no key at all, which is
    // not the same as one that carried an empty list, and only the first means
    // the colours already loaded were left alone.
    lines.push(T('saved colours') + ': ' + ('colours' in body
      ? (cfg.colours || []).length : T('not in the file')));
    return lines.join(NL);
  }

  function importSettingsFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var ok = applyImported(JSON.parse(reader.result));
        if (!ok) {
          console.warn('[psx] that file is not PSX settings');
          setImportNote(T('That file is not PSX settings'));
        } else {
          console.log('[psx] settings imported');
          setImportNote(ok);
        }
      } catch (e) {
        console.warn('[psx] could not read that file', e);
        setImportNote(T('That file is not PSX settings'));
      }
    };
    reader.readAsText(file);
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  function log() {
    if (!cfg.verbose) return;
    console.log.apply(console, ['[psx]'].concat([].slice.call(arguments)));
  }

  // There is no "off". This is a PSX fork: a switch back to stock behaviour
  // would just be a switch to being upstream, which is one clone away.
  function on() { return true; }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  // ---------------------------------------------------------------- renderer

  var renderer = null;

  function applyPixelRatio() {
    if (!renderer) return;
    renderer.setPixelRatio(on() ? cfg.pixelRatio : Math.max(2, window.devicePixelRatio));
  }

  function applyCanvasFilter() {
    var el = document.getElementById('psx-canvas-css');
    if (!el) {
      if (!document.head) return;
      el = document.createElement('style');
      el.id = 'psx-canvas-css';
      document.head.appendChild(el);
    }
    el.textContent = on()
      ? 'canvas{image-rendering:pixelated;image-rendering:crisp-edges;}'
      : '';
  }

  // --------------------------------------------------------------- textures

  var NearestFilter = 1003;

  var TEXTURE_SLOTS = [
    'map', 'shadeTexture', 'emissiveMap', 'emissionMap',
    'sphereAdd', 'rimTexture', 'matcapTexture', 'outlineWidthTexture',
    'uvAnimMaskTexture', 'receiveShadowTexture', 'shadingGradeTexture'
  ];

  function eachMaterial(vrm, fn) {
    if (!vrm || !vrm.scene) return;
    var seen = [];
    vrm.scene.traverse(function (o) {
      if (!o.material) return;
      var list = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m || seen.indexOf(m) !== -1) continue;
        seen.push(m);
        fn(m);
      }
    });
  }

  // three allocates immutable storage (texStorage2D) for a texture on its first
  // upload, with a mip level count decided by generateMipmaps/minFilter at that
  // moment. `needsUpdate` re-uploads but never reallocates, so a texture already
  // uploaded with mipmaps has to be disposed before it can come back as a
  // 1-level nearest one - otherwise glGenerateMipmap fails, texSubImage2D writes
  // at a level that does not exist, and the texture goes black and stays black
  // because the broken GL object keeps being reused.
  //
  // Only dispose when the filtering actually changes, so unrelated edits do not
  // re-upload every texture on the model.
  // Not options. The console point-sampled its textures - there was no bilinear
  // filter to turn on - and it had no antialiasing of any kind. A switch for
  // either would only be a switch for looking wrong.
  function applyTextureFilter(vrm) {
    eachMaterial(vrm, function (m) {
      var touched = false;
      for (var i = 0; i < TEXTURE_SLOTS.length; i++) {
        var t = m[TEXTURE_SLOTS[i]];
        if (!t || !t.isTexture) continue;

        var want = {
          magFilter: NearestFilter,
          minFilter: NearestFilter,
          generateMipmaps: false,
          anisotropy: 1
        };

        if (t.magFilter === want.magFilter &&
            t.minFilter === want.minFilter &&
            t.generateMipmaps === want.generateMipmaps &&
            t.anisotropy === want.anisotropy) continue;

        t.magFilter = want.magFilter;
        t.minFilter = want.minFilter;
        t.generateMipmaps = want.generateMipmaps;
        t.anisotropy = want.anisotropy;

        // force reallocation, not just a re-upload
        t.dispose();
        t.needsUpdate = true;
        touched = true;
      }
      if (touched) m.needsUpdate = true;
    });
  }

  // -------------------------------------------------------- PS1 shader look
  //
  // Nearest textures and a low render scale are low-fi, but they are not what
  // makes something look like a PlayStation. Three things do, and all of them
  // are shader-level:
  //
  //   vertex snapping  - the console had no floating point in its GPU, so
  //                      vertices landed on an integer screen grid. That is the
  //                      wobble everyone remembers.
  //   affine mapping   - no perspective correction, so a texture warps across a
  //                      large polygon. The most recognisable artifact of all.
  //   15-bit colour    - 5 bits per channel with ordered dithering.
  //
  // These go in through onBeforeCompile, so unlike everything else in this file
  // they need no new call site in the bundle.
  //
  // The tunables are uniforms rather than generated code, so the sliders are
  // live; only affine changes the program, because it needs a varying.

  var psxU = { grid: { value: 0 }, levels: { value: 0 } };

  function syncShaderUniforms() {
    psxU.grid.value = (on() && cfg.vertexSnap) ? cfg.snapGrid : 0;
    psxU.levels.value = (on() && cfg.dither) ? cfg.colorLevels : 0;
  }

  // Affine mapping is the single most recognisable PS1 artifact: the console had
  // no perspective correction, so textures warp across large polygons. Turning
  // it off would not be a preference, it would be a different console. It is
  // still skipped per material where there is no uv varying to rescale.
  function affineOn() { return true; }

  // GLSL has no strings, so brace counting is enough to find the end of main.
  function appendToMain(src, code) {
    var i = src.indexOf('void main(');
    if (i < 0) return null;
    var open = src.indexOf('{', i);
    if (open < 0) return null;
    var depth = 0;
    for (var k = open; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}' && --depth === 0) {
        return src.slice(0, k) + code + src.slice(k);
      }
    }
    return null;
  }

  function prependToMain(src, code) {
    var i = src.indexOf('void main(');
    if (i < 0) return null;
    return src.slice(0, i) + code + src.slice(i);
  }

  var SNAP_GLSL = [
    'if (uPsxGrid > 0.0) {',
    '  vec2 g = vec2(uPsxGrid);',
    '  gl_Position.xy = floor(gl_Position.xy / gl_Position.w * g + 0.5) / g * gl_Position.w;',
    '}'
  ].join(NL);

  // 4x4 ordered Bayer without an array, since GLSL ES 1.0 will not index one
  // with a non-constant.
  var DITHER_GLSL = [
    'if (uPsxLevels > 0.0) {',
    '  vec2 bp = floor(gl_FragCoord.xy);',
    '  float b2a = fract(bp.x * 0.5 + bp.y * bp.y * 0.75);',
    '  vec2 bh = floor(bp * 0.5);',
    '  float b2b = fract(bh.x * 0.5 + bh.y * bh.y * 0.75);',
    '  float d = (b2b * 0.25 + b2a) - 0.5;',
    '  gl_FragColor.rgb = clamp(floor(gl_FragColor.rgb * uPsxLevels + 0.5 + d) / uPsxLevels, 0.0, 1.0);',
    '}'
  ].join(NL);

  function hookMaterial(mat) {
    if (!mat || mat.__psxShader) return;
    mat.__psxShader = true;
    var prevCompile = mat.onBeforeCompile;
    var prevKey = mat.customProgramCacheKey;

    mat.onBeforeCompile = function (shader, renderer) {
      if (prevCompile) prevCompile.call(this, shader, renderer);
      try {
        // affine needs a uv varying to rescale, and one only exists when the
        // material is actually textured
        var affine = affineOn() && !!this.map;

        var vsHead = 'uniform float uPsxGrid;' + NL;
        var fsHead = 'uniform float uPsxLevels;' + NL;
        var vsTail = SNAP_GLSL;

        if (affine) {
          vsHead += 'varying float vPsxW;' + NL;
          // The declaration of vUv lives in an #include that three has not
          // expanded yet, so anchor on main(): whatever declared vUv is
          // certainly above it. A macro does not re-expand its own name, so
          // the vUv inside the body is the varying itself.
          fsHead += 'varying float vPsxW;' + NL + '#define vUv (vUv / vPsxW)' + NL;
          vsTail = 'vPsxW = gl_Position.w;' + NL + 'vUv *= gl_Position.w;' + NL + vsTail;
        }

        var vs = prependToMain(shader.vertexShader, vsHead);
        vs = vs && appendToMain(vs, NL + vsTail + NL);
        var fs = prependToMain(shader.fragmentShader, fsHead);
        fs = fs && appendToMain(fs, NL + DITHER_GLSL + NL);
        if (!vs || !fs) { log('shader hook skipped, no main() found'); return; }

        shader.uniforms.uPsxGrid = psxU.grid;
        shader.uniforms.uPsxLevels = psxU.levels;
        shader.vertexShader = vs;
        shader.fragmentShader = fs;
      } catch (e) {
        log('shader hook failed', e);
      }
    };

    // affine rewrites the program, so it has to key the cache or three would
    // reuse whichever variant it compiled first
    mat.customProgramCacheKey = function () {
      return (prevKey ? prevKey.call(this) : '') + '|psx' + (affineOn() && this.map ? 'A' : '');
    };

    mat.needsUpdate = true;
  }

  // Walk the live models rather than keeping a list, which would keep disposed
  // materials alive for as long as the page.
  function refreshShaders() {
    syncShaderUniforms();
    for (var i = 0; i < models.length; i++) {
      eachMaterial(models[i], function (m) { if (m.__psxShader) m.needsUpdate = true; });
    }
  }

  // -------------------------------- texture-based (_MainTex_ST) expressions
  //
  // VRM avatars that animate the face by sliding the UVs of the face texture
  // (the usual trick for PSX / low-poly models) store that as
  // blendShapeGroups[].materialValues[] with propertyName "_MainTex_ST".
  //
  // three-vrm 0.6 binds those by writing `material.mainTex_ST`, a property that
  // only exists on its own MToonMaterial / VRMUnlitMaterial. If the VRM uses
  // VRM_USE_GLTFSHADER (plain glTF PBR, what most Blender exports produce) the
  // material is a MeshStandardMaterial, `material.mainTex_ST` is undefined, and
  // VRMBlendShapeController.addMaterialValue drops the bind without a warning.
  // Result: the expression is registered, the weight moves, nothing happens on
  // screen - while UniVRM / VSeeFace animate it fine.
  //
  // We re-read the binds straight from the glTF JSON and drive
  // texture.offset / texture.repeat ourselves.
  //
  // These offsets pick a CELL out of a texture atlas - they are not additive.
  // Blending two of them lands between cells and the face slides across the
  // sheet, and the tracker feeds every mouth shape a fractional weight on every
  // frame. So each material picks a single winner and snaps to it, which is
  // also how these avatars read in-game.

  function collectUvBinds(vrm, gltf) {
    var ext = gltf && gltf.parser && gltf.parser.json &&
      gltf.parser.json.extensions && gltf.parser.json.extensions.VRM;
    var groups = ext && ext.blendShapeMaster && ext.blendShapeMaster.blendShapeGroups;
    if (!groups || !groups.length) return null;

    var mats = [];
    eachMaterial(vrm, function (m) { mats.push(m); });

    var byMaterial = [];

    function entryFor(mat) {
      for (var i = 0; i < byMaterial.length; i++) {
        if (byMaterial[i].material === mat) return byMaterial[i];
      }
      // give this material its own texture instance so sliding its UVs does
      // not drag every other material sharing the same image along with it
      if (mat.map && mat.map.isTexture) {
        mat.map = mat.map.clone();
        mat.map.needsUpdate = true;
      }
      var e = {
        material: mat,
        base: {
          ox: mat.map ? mat.map.offset.x : 0,
          oy: mat.map ? mat.map.offset.y : 0,
          rx: mat.map ? mat.map.repeat.x : 1,
          ry: mat.map ? mat.map.repeat.y : 1
        },
        neutral: null,
        cells: [],
        current: null,
        currentCell: null,
        since: 0
      };
      byMaterial.push(e);
      return e;
    }

    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var key = (grp.presetName && grp.presetName !== 'unknown') ? grp.presetName : grp.name;
      var isBinary = !!grp.isBinary;
      var mvs = grp.materialValues || [];
      for (var v = 0; v < mvs.length; v++) {
        var mv = mvs[v];
        if (!mv.materialName || !mv.propertyName || !mv.targetValue) continue;
        var prop = mv.propertyName;
        if (prop !== '_MainTex_ST' && prop !== '_MainTex_ST_S' && prop !== '_MainTex_ST_T') continue;

        var targets = [];
        for (var i = 0; i < mats.length; i++) {
          var nm = mats[i].name;
          if (nm === mv.materialName || nm === mv.materialName + ' (Outline)') targets.push(mats[i]);
        }
        if (!targets.length) {
          log('materialValue references unknown material', mv.materialName);
          continue;
        }

        for (var t = 0; t < targets.length; t++) {
          var mat = targets[t];
          // MToon / VRMUnlit already carry a working mainTex_ST bind: leave
          // those to three-vrm so we do not apply the offset twice.
          if (mat.mainTex_ST !== undefined) continue;
          if (!mat.map || !mat.map.isTexture) continue;

          var e = entryFor(mat);
          var tv = mv.targetValue;
          var sx, sy, ox, oy;
          if (prop === '_MainTex_ST') {
            // Unity ST order: scale.xy, offset.xy
            sx = tv[0]; sy = tv[1]; ox = tv[2]; oy = tv[3];
          } else if (prop === '_MainTex_ST_S') {
            sx = tv[0]; ox = tv[1]; sy = 1; oy = 0;
          } else { // _MainTex_ST_T
            sy = tv[0]; oy = tv[1]; sx = 1; ox = 0;
          }
          e.cells.push({ key: key, isBinary: isBinary, unity: { sx: sx, sy: sy, ox: ox, oy: oy } });
        }
      }
    }

    // A "neutral" group, when the model has one, is the rest cell: use it as
    // the fallback instead of whatever UV transform the material shipped with.
    for (var b = 0; b < byMaterial.length; b++) {
      var ent = byMaterial[b];
      for (var c = 0; c < ent.cells.length; c++) {
        if (ent.cells[c].key !== 'neutral') continue;
        ent.neutral = ent.cells[c].unity;
        ent.cells.splice(c, 1);
        break;
      }
      ent.flipV = detectFlip(ent);
      if (!ent.flipV) {
        log('material', ent.material.name || '(unnamed)',
          'reads as glTF V, not Unity V - using its own convention');
      }
    }

    var used = byMaterial.filter(function (e) { return e.cells.length; });
    return used.length ? used : null;
  }

  // Unity/UniVRM sample with a flipped V axis relative to glTF, so the vertical
  // offset has to be rebased before it can go into a three.js texture:
  //   v_univrm = oy + sy * (1 - v)   ->   v_three = (1 - oy - sy) + sy * v
  //
  // That rebase is right for a VRM written by UniVRM, which is the spec. It is
  // not always right for the models this fork is for, which arrive through odd
  // pipelines - and getting it wrong puts every expression on a vertically
  // mirrored row of the atlas, which looks like a broken model rather than a
  // convention mismatch. So it is measured instead of assumed, per material.
  function toThreeUv(u, flip) {
    return flip
      ? { ox: u.ox, oy: 1 - u.oy - u.sy, rx: u.sx, ry: u.sy }
      : { ox: u.ox, oy: u.oy, rx: u.sx, ry: u.sy };
  }

  function uvDist(a, b) {
    return Math.abs(a.ox - b.ox) + Math.abs(a.oy - b.oy) +
           Math.abs(a.rx - b.rx) + Math.abs(a.ry - b.ry);
  }

  // The neutral group is the rest cell, so converting it correctly has to land
  // on the UV transform the material already shipped with. Convert it both ways
  // and keep whichever actually matches. Without a neutral bind there is
  // nothing to measure against, so fall back to the spec.
  function detectFlip(entry) {
    if (!entry.neutral) return true;
    var flipped = toThreeUv(entry.neutral, true);
    var plain = toThreeUv(entry.neutral, false);
    return uvDist(flipped, entry.base) <= uvDist(plain, entry.base);
  }

  // Blink had a gain here too. It scaled a value that is now 0 or 1, on its way
  // to a bar the person sets directly - so it could only ever move the same
  // decision `Eyes shut at` moves, in units nobody could reason about.
  function gainFor(key) {
    if (MOUTH_KEYS[key]) return cfg.mouthGain;
    return 1;
  }

  function proxyValue(proxy, key) {
    var w = 0;
    try { w = proxy.getValue(key) || 0; } catch (err) { w = 0; }
    return w;
  }

  // Wink tracking is pinned on. The app writes BlinkL/BlinkR (and zeros Blink)
  // when the eyes differ, and Blink (zeros L/R) when they match. Match the
  // cell the model actually has:
  //   blink     - one atlas cell for both eyes: a wink or a blink both close it
  //   blink_l/r - per-eye cells: a full blink (written as Blink) still closes
  //               that eye, a wink on the other eye does not
  function expressionWeight(proxy, key) {
    var w = proxyValue(proxy, key);
    if (key === 'blink') {
      var l = proxyValue(proxy, 'blink_l');
      var r = proxyValue(proxy, 'blink_r');
      if (l > w) w = l;
      if (r > w) w = r;
    } else if (key === 'blink_l' || key === 'blink_r') {
      var a = proxyValue(proxy, 'blink');
      if (a > w) w = a;
    }
    return w;
  }

  function writeUv(e, uv) {
    var map = e.material.map;
    if (!map) return;
    map.offset.set(uv.ox, uv.oy);
    map.repeat.set(uv.rx, uv.ry);
  }

  function applyUvBinds(vrm) {
    var binds = vrm.__psxUvBinds;
    if (!binds || !vrm.blendShapeProxy) return;
    var proxy = vrm.blendShapeProxy;
    var t = now();

    // Cells are picked, never blended. Easing from one to another slides the UV
    // window across the sheet, so the mid-transition frames show whatever sits
    // between the two cells - which is not an expression. Snapping is not a
    // preference here, it is the only reading of an atlas that means anything.
    for (var i = 0; i < binds.length; i++) {
      var e = binds[i];
      if (!e.material.map) continue;

      var neutralUv = e.neutral ? toThreeUv(e.neutral, e.flipV) : e.base;

      // hold the current cell for at least holdMs - except visemes, which have
      // to change every syllable. A 80 ms latch after "a" would skip "i" and
      // "u" and the mouth would look stuck on one cell.
      var holding = e.since && (t - e.since) < cfg.holdMs;
      if (holding && !(e.current && MOUTH_KEYS[e.current])) continue;

      var best = pickBest(e, proxy);
      var chosen = best.over ? best.cell : null;
      var tag = chosen ? chosen.key : null;

      if (tag === e.current && e.since) continue;
      e.current = tag;
      e.currentCell = chosen;
      e.since = t;
      writeUv(e, chosen ? toThreeUv(chosen.unity, e.flipV) : neutralUv);
    }
  }

  // The bar this cell has to clear. Hysteresis belongs to whichever cell is on
  // screen, so it is asked per cell rather than of the winner: asking the
  // winner meant the cell already showing was judged against the high bar
  // whenever something else briefly outweighed it.
  function barFor(e, cell) {
    var bar = (cell.key === e.current)
      ? Math.max(0, cfg.threshold - cfg.hysteresis)
      : cfg.threshold;
    // Visemes change every syllable and never get near a full weight; held to
    // the same bar as an expression the mouth would simply stop moving.
    if (MOUTH_KEYS[cell.key]) bar = Math.min(bar, 0.18);
    return bar;
  }

  // Blink and angry are not comparable magnitudes. Furrowing your brows
  // genuinely narrows your eyes - the same muscles do both - so both signals
  // rise together, and a plain argmax handed the face to whichever of Blink
  // gain and Signal gain happened to be larger. That is not a decision anyone
  // made, and it flips frame to frame, which is what "the angry face keeps
  // blinking at itself" is.
  //
  // So: class first, weight only within a class. A vowel outranks everything
  // because a mouth that stops moving mid-sentence reads as broken, and speech
  // is continuous where the other two are not. A blink outranks an emotion
  // because it is an event with a beginning and an end - it takes the face for
  // the tenth of a second it lasts and gives it straight back, where an
  // emotion is a state that will still be there afterwards. An emotion that
  // loses to a blink loses nothing; a blink that loses to an emotion never
  // happens at all, and an avatar that cannot blink looks dead.
  //
  // `eyeFurrowLift` is the other half of this, and the more important one: it
  // stops the furrow reaching the blink bar in the first place, so most frames
  // never get here with both above it.
  function classRank(key) {
    if (MOUTH_KEYS[key]) return 2;
    if (BLINK_KEYS[key]) return 1;
    return 0;
  }

  function pickBest(e, proxy) {
    var best = null, bestW = 0, bestRank = -1;
    for (var c = 0; c < e.cells.length; c++) {
      var cell = e.cells[c];
      var w = expressionWeight(proxy, cell.key);
      w *= gainFor(cell.key);
      if (w > 1) w = 1;
      // isBinary is about not interpolating morphs. We already snap the UV to
      // one cell, so a second 0.5 gate just fights the threshold
      // on groups UniVRM marked binary (blink usually is).
      //
      // A cell that clears its own bar beats one that does not, whatever the
      // raw numbers say. Below every bar they all rank -1 and the largest
      // weight wins, which is only ever used to report what was closest.
      var rank = w >= barFor(e, cell) ? classRank(cell.key) : -1;
      if (rank > bestRank || (rank === bestRank && w > bestW)) {
        bestRank = rank;
        bestW = w;
        best = cell;
      }
    }
    return { cell: best, weight: bestW, over: bestRank >= 0 };
  }

  // --------------------------------------------------- emotion presets
  //
  // The app solves a full Kalidokit face every frame but only ever writes
  // Blink / BlinkL / BlinkR, the five vowels, and Joy (and Joy only when
  // "Smile Detection [Beta]" is on). Angry, Sorrow and Fun are never written,
  // so on a PSX avatar their atlas cells sit at weight 0 forever and can never
  // clear the threshold - the expression looks broken when it is simply never
  // being asked for.
  //
  // Kalidokit does hand us the two signals those presets need: `brow`, a single
  // scalar that goes negative when the brows furrow and positive when they
  // raise, and `mouth.x`, the corner-to-corner width the app already uses for
  // its smile. We map them here and write the presets ourselves, before
  // blendShapeProxy.update() runs.

  var EMOTION_KEYS = ['angry', 'sorrow', 'fun', 'joy'];
  var lastFace = null;
  var lastBlink = null;
  // The tracker's own closedness, before the eye map. Shown beside the mapped
  // value so the two eye sliders can be set by watching a real face.
  var lastEyeRaw = null;
  // where the line sat on that frame, so the readout can show the reading and
  // the bar it is being judged against side by side
  var lastEyeBar = null;
  // per-lid latch, for the release margin
  var shutL = false;
  var shutR = false;
  var eyeReadoutEl = null;
  var lastViseme = { key: null, w: 0 };
  // how sure the mouth classifier is that this is the recorded grin, 0 = not it
  var mouthSays = 0;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  // 0 below the threshold, then a straight ramp up to 1
  function ramp(v, at) {
    if (at >= 1) return 0;
    return clamp((v - at) / (1 - at), 0, 1);
  }

  // Kalidokit's brow scalar only swings a few hundredths for most faces, and
  // mouth.x sits wherever that mouth happens to rest, so fixed thresholds are
  // unreachable for some people and permanently tripped for others. Learn the
  // resting value and the biggest deviation from it, then report the signal as
  // a fraction of that - a full grimace becomes 1 whatever its raw size.
  //
  // The baseline creeps toward wherever the face spends its time; the span
  // widens instantly on a new extreme and decays slowly, so a single big
  // expression sets the scale but the range still follows the face over time.
  function tracker() {
    return { base: null, span: 0 };
  }

  var browTrack = tracker();
  var smileTrack = tracker();

  function normalize(tr, raw, floor) {
    if (tr.base === null) tr.base = raw;
    var dev = raw - tr.base;
    var mag = Math.abs(dev);
    if (mag > tr.span) tr.span = mag; else tr.span *= 0.99985;
    var span = Math.max(tr.span, floor);
    // The resting value only follows the face while the face is near rest.
    // Letting it drift during an expression would make a held grimace the new
    // neutral, and the emotion would fade out while you were still pulling it.
    if (mag < span * 0.35) tr.base += dev * 0.002;
    return dev / span;
  }

  // Filled in when the Emotion card is built. Calibrating by watching numbers
  // move is the whole point, so this updates every tracked frame.
  var readoutEl = null;

  function setText(node, text) {
    if (!node.__psxText) {
      node.textContent = '';
      node.__psxText = document.createTextNode('');
      node.appendChild(node.__psxText);
    }
    if (node.__psxText.nodeValue !== text) node.__psxText.nodeValue = text;
  }

  // Rebuilt on every solved face, which is a string, six `toFixed` calls and a
  // join per frame - for a line nobody can read faster than this anyway. The
  // numbers are for watching a calibration move, and ten a second is already
  // more than the eye takes off them.
  var READOUT_EVERY = 100;
  var readoutAt = 0;

  function paintReadout() {
    var live = (readoutEl && readoutEl.isConnected) ||
      (eyeReadoutEl && eyeReadoutEl.isConnected);
    if (!live) return;
    if (!lastFace && lastBlink == null) return;
    var rt = now();
    if (rt - readoutAt < READOUT_EVERY) return;
    readoutAt = rt;

    // The eye line, for the card that holds the two eye sliders. `raw` is what
    // they are set against; `->` is what the map makes of it.
    if (eyeReadoutEl && eyeReadoutEl.isConnected && lastEyeRaw != null) {
      // The reading, the line it is being judged against right now (which the
      // furrow moves), and which side of it that puts the lid on.
      setText(eyeReadoutEl,
        T('eyes') + ' ' + lastEyeRaw.toFixed(3) +
        '  /  ' + (lastEyeBar == null ? '-' : lastEyeBar.toFixed(3)) +
        '  ->  ' + T(lastBlink ? 'shut' : 'open') +
        (faceOcc ? '  ·  ' + T('hand on face') : ''));
    }

    if (!readoutEl || !readoutEl.isConnected) return;
    var parts = [];
    if (lastFace) {
      var top = null;
      for (var i = 0; i < EMOTION_KEYS.length; i++) {
        var k = EMOTION_KEYS[i];
        if (lastFace.out[k] > 0 && (!top || lastFace.out[k] > lastFace.out[top])) top = k;
      }
      parts.push('brow ' + lastFace.brow.toFixed(2) +
        ' [' + lastFace.raw.brow.toFixed(3) +
        (lastFace.poseRest != null ? '~' + lastFace.poseRest.toFixed(3) : '') + ']');
      parts.push('smile ' + lastFace.smile.toFixed(2) +
        ' [' + lastFace.raw.smile.toFixed(3) + ']');
      parts.push(top ? top + ' ' + lastFace.out[top].toFixed(2) : 'neutral');
    }
    if (lastBlink != null) {
      parts.push('blink ' + lastBlink.toFixed(2) +
        (lastEyeRaw != null ? ' [' + lastEyeRaw.toFixed(3) + ']' : ''));
    }
    if (faceOcc) parts.push(T('hand on face'));
    setText(readoutEl, parts.join('  ·  '));
  }

  function resetCalibration() {
    browTrack = tracker();
    smileTrack = tracker();
    browPose = poseLadder();
    resetBrowFilter();
    log('auto calibration reset');
  }

  // ------------------------------------------------------ guided calibration
  //
  // Continuous auto-calibration has to guess which way the face is going and
  // treats both brow directions as one span. Most people furrow much further
  // than they raise, so asking for each pose in turn - the way a game asks you
  // to hold a stick at its extremes - records a separate span per direction and
  // gives a much better mapping.

  var MOTION_STEPS = [
    { key: 'rest',  title: 'Face the camera',      hint: 'Head straight, shoulders square, arms down' },
    // Every other step measures how far a signal travels. This one measures
    // how much it travels when it is not supposed to, which is what decides
    // how hard everything else has to be filtered.
    { key: 'still', title: 'Hold completely still',
      hint: 'Do not move at all - this reads how noisy your camera is' },
    { key: 'left',  title: 'Turn your head left',  hint: 'As far as is comfortable, and hold' },
    { key: 'right', title: 'Turn your head right', hint: 'As far as is comfortable, and hold' },
    { key: 'up',    title: 'Look up',              hint: 'Tilt your head back and hold' },
    { key: 'down',  title: 'Look down',            hint: 'Tilt your chin down and hold' },
    // Head roll is not a torso lean, but the pose solver copies it onto
    // Spine.z - a small ear-to-shoulder then leans the whole chest. This
    // pose is the ground truth that they are different: shoulders stay
    // level, so whatever the shoulder line does is the coupling to strip.
    { key: 'headRoll', title: 'Tilt your head to one side',
      hint: 'Ear toward your shoulder - keep your shoulders level' },
    { key: 'lean',  title: 'Lean your torso to one side',
      hint: 'Sway from the waist as far as is comfortable, and hold' },
    { key: 'shrug', title: 'Shrug your shoulders up',
      hint: 'Lift both shoulders toward your ears and hold' },
    { key: 'tpose', title: 'Arms straight out to the sides',
      hint: 'Shoulder height, elbows locked, like a T. Needs full-body tracking.' },
    { key: 'depth', title: 'Point one arm at the camera',
      hint: 'Elbow straight, hand toward the lens, and hold' },
    { key: 'hands', title: 'Put both hands on your head',
      hint: 'Palms on your skull, elbows out. Needs full-body tracking.' },
    // Every step above reads one pose and asks it to speak for the whole arm.
    // This one reads the whole arm: hundreds of samples spread over every
    // direction it can reach, which is what lets the three axes be separated
    // from each other instead of averaged into one number.
    { key: 'sweep', title: 'Straight arms - draw big slow circles',
      hint: 'Elbows completely straight, as if reaching for a far wall. Sweep both arms around: out to the sides, up overhead, forward at the camera, down by your legs. Bend an elbow and that moment is thrown away - watch the sample count rise.',
      ms: 12000, prep: 11000, fit: true },
    // Changes nothing. A calibration that is run once and then trusted forever
    // has to say out loud whether it worked, or a bad run is indistinguishable
    // from a good one for as long as the profile survives.
    { key: 'check', title: 'Once more, to check the result',
      hint: 'Same circles, elbows just as straight. This step only measures - it cannot make anything worse.',
      ms: 8000, fit: true, check: true }
  ];

  // Said out loud and held. The sound matters as much as the shape: people
  // make a much more definite mouth when they are actually voicing the vowel
  // than when they are posing it.
  var MOUTH_STEPS = [
    { key: 'rest', title: 'Close your mouth',
      hint: 'Lips together, relaxed - this is what silence looks like' },
    // A toothy smile is an open, spread mouth, which is also what "ee" and
    // "eh" are. No threshold separates them, because they are not different
    // amounts of the same thing - so record the smile as its own mouth and let
    // the classifier tell them apart the way it tells the vowels apart.
    { key: 'smile', title: 'Smile, showing your teeth',
      hint: 'The big one, teeth and all, and hold it' },
    { key: 'a', title: 'Say "aaah" and hold it', hint: 'As in f-a-ther. Jaw open' },
    { key: 'e', title: 'Say "ehh" and hold it', hint: 'As in b-e-d' },
    { key: 'i', title: 'Say "eee" and hold it', hint: 'As in s-ee. Lips wide' },
    { key: 'o', title: 'Say "ooh" and hold it', hint: 'As in g-o. Lips rounded' },
    { key: 'u', title: 'Say "oooo" and hold it', hint: 'As in b-oo-t. Lips pushed forward' }
  ];

  // Head pose fools the eye solver AND the brow scalar: looking down or 40°
  // off-camera reads as a half-blink and as a non-neutral brow with nothing on
  // the face having moved. Open poses set the blink floor, closed poses set
  // the blink peak.
  //
  // For the brow, a relaxed reading at each pose was tried first and is not
  // enough. It gives the zero, and the zero is only half of it: turning the
  // head changes how far the same furrow *travels* as well as where rest sits,
  // so a span borrowed from the facing-camera recording is a gain that is
  // wrong by however much the two disagree. Both halves were then modelled -
  // a learned per-pose ladder, then reading the scalar in three dimensions
  // instead of flattened onto the camera - and both helped without settling
  // it, because both are a model of a face standing in for a measurement of
  // one.
  //
  // So measure it. Furrow and raise at each pose as well as relax, which is
  // the whole local mapping at that angle instead of a correction carried
  // over from a distant one. It is a longer wizard and it is run once.
  //
  // Grouped by pose, not by expression: the three readings at one angle have
  // to share that angle, and a wizard that sends someone back and forth
  // between "turned left" and "facing the camera" files three different
  // angles under one pose. `at` is which pose a step belongs to, `expr` is
  // which of the three faces it is.
  // The eye pair on its own. The expression wizard already records these - but
  // it takes twenty-five poses to get there, and an eye map is the one thing in
  // it that a person wants to redo by itself: it goes wrong when the light or
  // the camera angle changes, neither of which moves a brow span.
  //
  // Two readings at one pose, not five across the head angles the expression
  // wizard uses. A lid does not foreshorten the way a brow-to-lid gap does, and
  // asking for four more poses to measure that would be asking for them to be
  // held for nothing.
  var BLINK_STEPS = [
    { key: 'eyesOpen', eyes: 'open',
      title: 'Eyes open, look at the camera',
      hint: 'Relaxed - not wide, just how you normally sit' },
    { key: 'eyesShut', eyes: 'closed',
      title: 'Close your eyes',
      hint: 'Still facing the camera, and hold them shut' },
    // The pose that makes the two signals fight. Reading how far a furrow
    // alone closes the eye is the only way to stop it counting as a blink.
    { key: 'eyesFurrow', eyes: 'furrow',
      title: 'Furrow your brows, eyes open',
      hint: 'Angry face - brows down and together, but keep your eyes open' }
  ];

  // Five poses, one head angle.
  //
  // This was twenty-three: the same three faces repeated at four off-centre
  // head angles, plus an eyes-shut reading at three of them. All eighteen of
  // those existed to record how far the brow reading drifted as the head
  // turned - which was the largest error in the old scalar by a factor of six,
  // and is not an error this one has. The side-of-face denominator foreshortens
  // with the numerator, so a yaw leaves the ratio alone, a pitch shortens both
  // by the same cosine and a roll turns both together.
  //
  // What drift is left - iris noise, lighting, whatever the mesh gets wrong -
  // is not the kind a recording fixes anyway, because it is not a property of
  // the angle. The pose ladder learns it live, at every angle including the
  // ones nobody would hold for a wizard, and it is unaffected by any of this:
  // it runs off `browPose`, which is built at runtime and never read from the
  // recording. Dropping the recorded poses drops `browAt`, `poseCalOk` goes
  // false, and `poseAdjustedBrow` returns the raw scalar with the ladder still
  // applied on top - which is the correct answer, not a degraded one.
  //
  // A profile recorded with the eighteen still loads and still uses them.
  var CAL_STEPS = [
    { key: 'rest',         at: 'rest', expr: 'rest', eyes: 'open',
      title: 'Relax your face',
      hint: 'Neutral, looking at the camera, eyes open' },
    // `eyes: 'furrow'` as well as the brow: this is the pose where the two
    // signals fight, so it is the pose that measures the coupling. The short
    // blink wizard asks for it separately for people who only need that.
    { key: 'down',         at: 'rest', expr: 'down', eyes: 'furrow',
      title: 'Furrow your brows',
      hint: 'Angry - pull them down and together, and keep your eyes open' },
    { key: 'up',           at: 'rest', expr: 'up',
      title: 'Raise your brows',
      hint: 'Surprised - lift them as high as you can' },
    { key: 'smile',        title: 'Smile wide',
      hint: 'Big smile, and hold it' },
    { key: 'blink',        eyes: 'closed',
      title: 'Close your eyes',
      hint: 'Still facing the camera, and hold them shut' }
  ];
  // The face wizard waits for the person to say they are in the pose rather
  // than counting them down: their hands are free, and a countdown only races
  // an expression they are still building.
  //
  // A motion pose is the opposite. Hands on the head cannot reach a key, and a
  // turned head that has to find one turns back to do it - the keypress jolts
  // the exact signal being read. So the motion wizard reads the prompt out and
  // counts in, and Space is only a way to skip ahead once they are already set.
  var CAL_PREP = 5000;   // ms to read the prompt and get into a motion pose
  var CAL_HOLD = 1400;   // ms of sampling once they confirm
  // Pressing the key jolts the head, and people are still settling into the
  // pose for a moment after they say they are in it. Those frames are the worst
  // ones in the window, so they are not read at all.
  // ---------------------------------------------------- calibration cues
  //
  // Tones are synthesised rather than loaded. A sample would be one more file
  // to serve, one more thing to go missing on a rebuild, and the whole
  // vocabulary here is six notes.
  //
  // The context is created on the first cue, which always follows the click
  // that started the wizard - browsers refuse one built any earlier.
  var actx = null;

  function tone(freq, at, ms, vol) {
    var t0 = actx.currentTime + at;
    var osc = actx.createOscillator();
    var g = actx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    // A square-edged gate clicks. Ramping the envelope is the difference
    // between a note and a pop.
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    g.gain.setValueAtTime(vol, t0 + ms / 1000 - 0.03);
    g.gain.linearRampToValueAtTime(0, t0 + ms / 1000);
    osc.connect(g);
    g.connect(actx.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.02);
  }

  function cue(notes) {
    if (!cfg.calCues) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume();
      for (var i = 0; i < notes.length; i++) {
        tone(notes[i][0], notes[i][1], notes[i][2], notes[i][3]);
      }
    } catch (e) { /* audio is a courtesy, never a dependency */ }
  }

  // Each state gets a shape, not just a pitch: from across the room the
  // direction of a two-note move reads where an absolute pitch does not.
  // Rising means the reading has started; falling means it has not.
  var CUE = {
    step:   [[660, 0, 120, 0.16]],
    tick:   [[440, 0, 60, 0.09]],
    read:   [[660, 0, 90, 0.2], [990, 0.09, 160, 0.2]],
    done:   [[880, 0, 110, 0.16]],
    retry:  [[400, 0, 160, 0.18], [300, 0.17, 260, 0.18]],
    finish: [[660, 0, 110, 0.18], [880, 0.11, 110, 0.18], [1320, 0.22, 240, 0.18]]
  };

  // `u.lang` is a hint, and Chrome on Windows routinely ignores it: with no
  // voice named it speaks with whatever the system default is, which reads a
  // Portuguese prompt in an American accent and is most of the way to
  // unintelligible. Naming a voice is the only thing that actually picks the
  // language.
  //
  // `getVoices()` is empty until the list has loaded and it loads
  // asynchronously, so the answer is cached per language and thrown away when
  // the browser says the list changed - asking once at startup gets nothing.
  var voiceFor = {};
  var voiceMissing = {};

  function pickVoice(want) {
    if (want in voiceFor) return voiceFor[want];
    var list;
    try { list = window.speechSynthesis.getVoices(); } catch (e) { list = null; }
    // Not loaded yet. Do not cache that - the next prompt should ask again.
    if (!list || !list.length) return null;
    var lang = want.toLowerCase();
    var base = lang.split('-')[0];
    var exact = null, same = null;
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      var vl = String(v.lang || '').replace('_', '-').toLowerCase();
      // A local voice over a network one where both fit: the network ones
      // stall, and a prompt that arrives after the pose is over is worse than
      // no prompt.
      if (vl === lang) { if (!exact || (v.localService && !exact.localService)) exact = v; }
      else if (vl.split('-')[0] === base) { if (!same || (v.localService && !same.localService)) same = v; }
    }
    // pt-PT before an English voice; nothing at all before a voice that is
    // definitely the wrong language, since `u.lang` alone may still land.
    var got = exact || same || null;
    voiceFor[want] = got;
    if (got) {
      log('voice for ' + want + ':', got.name, got.lang);
    } else if (!voiceMissing[want]) {
      voiceMissing[want] = true;
      // Not `log`: this is the answer to "why is it not speaking Portuguese",
      // and nobody debugging that has verbose on yet.
      console.warn('[psx] no ' + want + ' speech voice is installed, so the ' +
        'spoken prompts will be read by the system default voice. Add one in ' +
        'the operating system speech settings.');
    }
    return got;
  }

  // Whether this machine can speak at all, as opposed to whether it has the
  // right language. Chromium on Raspberry Pi OS reports an empty voice list
  // unless a speech engine is installed, and `speak()` on an empty list is
  // silence with no error - so the one cue that carries across a room simply
  // does not happen, and nothing on screen says why. `null` = not asked yet.
  var voiceAny = null;

  function speechAvailable() {
    try {
      if (!window.speechSynthesis) return false;
      var list = window.speechSynthesis.getVoices();
      // An empty list before `voiceschanged` fires is "not loaded yet", not
      // "none installed": answer unknown rather than accusing the machine.
      if (!list || !list.length) return voiceAny;
      return true;
    } catch (e) { return false; }
  }

  try {
    if (window.speechSynthesis && window.speechSynthesis.addEventListener) {
      window.speechSynthesis.addEventListener('voiceschanged', function () {
        voiceFor = {};
        var list = window.speechSynthesis.getVoices();
        voiceAny = !!(list && list.length);
        syncVoiceNote();
      });
    }
    // Chrome only starts loading the list once it has been asked for.
    if (window.speechSynthesis) {
      var boot = window.speechSynthesis.getVoices();
      if (boot && boot.length) voiceAny = true;
    } else {
      voiceAny = false;
    }
  } catch (e) { /* as with the tones */ }

  // Voice runs off the same translated strings the prompt shows, so it never
  // needs its own script - and never drifts from what is on screen.
  function say(text) {
    if (!cfg.calCues || !text) return;
    try {
      var synth = window.speechSynthesis;
      if (!synth) return;
      // The queue is not a transcript. A prompt that has been replaced is not
      // worth hearing, and a backlog would still be talking three steps later.
      synth.cancel();
      var want = cfg.lang === 'pt' ? 'pt-BR' : 'en-US';
      var u = new SpeechSynthesisUtterance(String(text));
      u.lang = want;
      var v = pickVoice(want);
      if (v) u.voice = v;
      u.rate = 1.05;
      synth.speak(u);
    } catch (e) { /* as with the tones */ }
  }

  function hush() {
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
  }

  var CAL_SETTLE = 250;
  // Below this there are not enough frames for a percentile to mean anything.
  var CAL_MIN_SAMPLES = 8;
  var calRun = null;
  var calSeq = 0;
  var calEl = null;
  var calBtn = null;
  var calMotionEl = null;
  var calMotionBtn = null;
  var calMouthEl = null;
  var calMouthBtn = null;
  var calMouthCancelBtn = null;
  var calBlinkEl = null;
  var calBlinkBtn = null;
  var calBlinkCancelBtn = null;
  var calCancelBtn = null;
  var calMotionCancelBtn = null;

  // A single bad frame - a dropped track, a blink, a head jerk - used to define
  // the whole span, because the extremes were taken as an absolute min or max.
  // Keeping the samples and reading a percentile off them costs nothing at this
  // size and throws that frame away instead of building the calibration on it.
  function stepAccum() {
    return {
      brow: [], smile: [], y: [], x: [], eyeL: [], eyeR: [],
      // motion: model-space readings from the render tick, landmark-space ones
      // from the holistic result
      reach: [], span: [], roll: [], torso: [], depth: [], alen: [], z: [],
      // sweep: one depth ratio and one residual per locked arm per inference
      fit: newFit(),
      // mouth: one feature vector per sampled frame
      feat: []
    };
  }

  // Kept as samples rather than sums so the reading can be a median. One arm
  // that clips the frame edge, or a frame where the elbow was not really
  // locked, is a wild ratio - and a mean would carry it into the gain.
  function newFit() {
    return {
      n: 0, r: [], res: [],
      side: { Right: { r: [], res: [] }, Left: { r: [], res: [] } }
    };
  }

  // A sweep only counts frames where an arm was really locked and really out
  // of the image plane, so it throws most of what it sees away. Still far above
  // CAL_MIN_SAMPLES, which sizes a percentile off a single held pose.
  var FIT_MIN = 40;

  // Kalidokit: 1 = open. Combined closedness is the more-closed eye.
  function closednessOf(a) {
    var n = Math.min(a.eyeL.length, a.eyeR.length);
    var out = [];
    for (var i = 0; i < n; i++) {
      var l = 1 - a.eyeL[i];
      var r = 1 - a.eyeR[i];
      out.push(l > r ? l : r);
    }
    return out;
  }

  function pct(arr, q) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (m, n) { return m - n; });
    var i = (a.length - 1) * q;
    var lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
  }

  function median(a) { return pct(a, 0.5); }

  // Per dimension, so one frame where the tracker lost the lip line cannot drag
  // the whole prototype off with it.
  function medianVec(rows) {
    var out = [];
    for (var d = 0; d < MOUTH_DIMS; d++) {
      var col = [];
      for (var i = 0; i < rows.length; i++) col.push(rows[i][d]);
      out.push(median(col));
    }
    return out;
  }

  // Spread of the middle half. A pose held still has a small one; a shaky pose
  // has a large one, and its reading is worth less.
  function spread(a) { return pct(a, 0.75) - pct(a, 0.25); }

  function deviations(arr, rest) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(Math.abs(arr[i] - rest));
    return out;
  }

  // The sweep and the check measure the retarget against the landmarks. With
  // the retarget off, the arms are on the stock Euler rig and there is nothing
  // for those two steps to read - they would gather no samples at all and sit
  // there retrying. So they are dropped from the run rather than failed in it,
  // and the count in the prompt is the count of steps that can actually happen.
  function motionSteps() {
    if (cfg.armIK) return MOTION_STEPS;
    var out = [];
    for (var i = 0; i < MOTION_STEPS.length; i++) {
      if (!MOTION_STEPS[i].fit) out.push(MOTION_STEPS[i]);
    }
    return out;
  }

  // Held on the run: the list may not change under a wizard that is part way
  // through it, and `armIK` is a control the panel can toggle at any time.
  function steps() {
    if (calRun.kind === 'motion') return calRun.steps;
    if (calRun.kind === 'mouth') return MOUTH_STEPS;
    if (calRun.kind === 'blink') return BLINK_STEPS;
    return CAL_STEPS;
  }

  function begin(kind) {
    calRun = { kind: kind, i: 0, phase: 'wait', until: 0, acc: stepAccum(), out: {} };
    if (kind === 'motion') calRun.steps = motionSteps();
    enterWait();
  }

  // Arm the next step: the motion wizard counts itself in, the face wizard
  // waits. Either way the same call, so a step is only ever set up in one place.
  function enterWait() {
    var st = steps()[calRun.i];
    cue(CUE.step);
    // Title and hint, the same two lines the prompt shows. The note from a
    // failed step goes first when there is one - it is the reason this step is
    // being asked for again, and it is useless after the instruction.
    say((calRun.note ? calRun.note + '. ' : '') +
      T(st.title) + '. ' + T(st.hint));
    calRun.tickAt = -1;
    // Only the face wizard waits for the key. A vowel has to be voiced to read
    // right, and someone holding "oooo" while hunting for Space stops voicing
    // it - the same reason the motion poses are counted in, and the same reason
    // the blink pair is: half of that one is held with the eyes shut, so there
    // is nothing on screen to read and the count-in is the only cue there is.
    if (calRun.kind !== 'face') {
      calRun.phase = 'prep';
      // A step whose instruction takes longer to say than the count-in lasts
      // would be cut off mid-sentence by its own reading. The sweep is the one
      // that needs saying in full, and it is also the one the person should
      // already be moving for when the reading starts.
      calRun.prepUntil = now() + (st.prep || CAL_PREP);
      calTick();
    } else {
      calRun.phase = 'wait';
      paintCalibration(0);
    }
    syncCalUi();
  }

  // Called from the button, the keyboard, or the end of the count-in: the
  // person is in the pose, read it.
  function captureStep() {
    if (!calRun || (calRun.phase !== 'wait' && calRun.phase !== 'prep')) return;
    // Rising, and it is the only rising cue in the set: this is the instant the
    // pose starts counting, and not knowing it is what made the wizard guesswork
    // from across the room.
    cue(CUE.read);
    // Silence the voice only for the vowels, where the pose *is* a sound and
    // talking over it is talking over the thing being measured. Elsewhere the
    // instruction is worth finishing - a sweep is easier to hold to when the
    // description is still arriving.
    if (calRun.kind === 'mouth') hush();
    calRun.note = '';
    calRun.phase = 'hold';
    calRun.holdFrom = now();
    calRun.until = calRun.holdFrom + (steps()[calRun.i].ms || CAL_HOLD);
    calRun.acc = stepAccum();
    calRun.tpose = false;
    calTick();
    syncCalUi();
  }

  function startCalibration() { begin('face'); }
  function startMotionCalibration() { begin('motion'); }
  function startMouthCalibration() { begin('mouth'); }
  function startBlinkCalibration() { begin('blink'); }

  function stopCalibration(note, spoken) {
    hush();
    cue(CUE.finish);
    // The full note is a line of gains and percentages - unreadable aloud and
    // useless across a room. Say the verdict; leave the numbers on screen.
    if (spoken) say(spoken);
    var el0 = calTarget();
    calRun = null;
    if (el0) setText(el0, note || '');
    syncCalUi();
    // The verdict is the one line the person who just held the pose actually
    // wants, and they are still across the room from the card it was written
    // into. Leave it up long enough to be read, then get out of the way.
    if (spoken) flashHud(spoken, note || '');
  }

  // Runs while a motion step is counting in and while any step is being
  // sampled; a face step waiting on the key costs nothing. Time advances here
  // rather than in the face hook, so a capture with no face tracked still ends
  // instead of hanging.
  //
  // A count-in and the sampling window that follows it are one chain, and
  // pressing Space to skip the count-in starts another. Each chain is stamped
  // and only the newest one survives, or the abandoned chain would keep
  // stepping the wizard alongside it.
  function calTick(seq) {
    if (!calRun) return;
    if (seq == null) seq = ++calSeq;
    else if (seq !== calSeq) return;
    var t = now();
    var again = function () { calTick(seq); };
    if (calRun.phase === 'prep') {
      if (t >= calRun.prepUntil) { captureStep(); return; }
      // One click per whole second left, so the count-in is audible as a count
      // rather than as a wait of unknown length.
      var left = Math.ceil((calRun.prepUntil - t) / 1000);
      if (left !== calRun.tickAt) {
        calRun.tickAt = left;
        if (left <= 3) cue(CUE.tick);
      }
      requestAnimationFrame(again);
      paintCalibration(calRun.prepUntil - t);
      return;
    }
    if (calRun.phase !== 'hold') return;
    if (t >= calRun.until) { advanceCalibration(); return; }
    requestAnimationFrame(again);
    paintCalibration(Math.max(0, calRun.until - t));
  }

  function nextStep(total, finish) {
    cue(CUE.done);
    calRun.tries = 0;
    calRun.i++;
    if (calRun.i >= total) { finish(); return; }
    enterWait();
  }

  // Redo the step rather than record it: a span built on three frames is worse
  // than no calibration, because it looks like one. The note rides on the run
  // rather than being written over the prompt, or the count-in's next repaint
  // would wipe it.
  // A held pose that read badly is worth asking for again - the person can
  // hold it better. A sweep that read nothing is usually not a bad sweep, it is
  // body tracking that is not running, and asking again forever is how a wizard
  // hangs. Give it two tries and then move on without it: a missing fit leaves
  // the coarse gains standing, which is the state this build shipped in.
  var FIT_TRIES = 2;

  function retryStep(n) {
    cue(CUE.retry);
    var st = steps()[calRun.i];
    if (st.fit) {
      calRun.tries = (calRun.tries || 0) + 1;
      if (calRun.tries >= FIT_TRIES) {
        calRun.tries = 0;
        calRun.note = T('Skipped - no body tracking was read for that step.');
        nextStep(steps().length, finishMotion);
        return;
      }
    }
    calRun.note = T('Only') + ' ' + n + ' ' +
      T('frames were read - hold the pose and try that step again.');
    enterWait();
  }

  function advanceCalibration() {
    var st = steps()[calRun.i];
    var a = calRun.acc;
    var motion = calRun.kind === 'motion';
    // A fit step is not gated on the face samples every other step counts -
    // it can be run with the head turned away the whole time - and it needs far
    // more of its own than a percentile off one held pose does.
    var fitStep = motion && st.fit;
    var n = fitStep ? a.fit.n
      : (motion ? a.y.length
        : (calRun.kind === 'mouth' ? a.feat.length : a.brow.length));

    if (n < (fitStep ? FIT_MIN : CAL_MIN_SAMPLES)) { retryStep(n); return; }

    if (calRun.kind === 'mouth') {
      calRun.out[st.key] = medianVec(a.feat);
      nextStep(MOUTH_STEPS.length, finishMouth);
      return;
    }

    if (motion) {
      var o = calRun.out;
      if (st.key === 'rest') {
        o.restY = median(a.y);
        o.restX = median(a.x);
        if (a.z.length) o.restZ = median(a.z);
        if (a.roll.length) o.restRoll = median(a.roll);
        if (a.torso.length) o.restTorso = median(a.torso);
        if (a.reach.length >= CAL_MIN_SAMPLES) o.restReach = median(a.reach);
      } else if (st.key === 'still') {
        // the spread of a pose that is not moving is the tracker's own noise,
        // and it is deliberately kept out of `shake` - a still step that reads
        // still is the point, not a warning
        o.noise = Math.max(spread(a.y), spread(a.x));
      } else if (st.key === 'headRoll') {
        // Signed medians, not abs deviations: the coupling has a direction,
        // and a slope through |roll|/|head.z| would treat a counter-lean as
        // the same thing as the pose solver copying the head onto the spine.
        if (a.roll.length >= CAL_MIN_SAMPLES && a.z.length >= CAL_MIN_SAMPLES &&
            isNum(o.restRoll) && isNum(o.restZ)) {
          var dZ = median(a.z) - o.restZ;
          var dR = median(a.roll) - o.restRoll;
          if (Math.abs(dZ) > 0.08) {
            o.headRoll = dZ;
            o.rollAtHead = dR;
          }
        }
      } else if (st.key === 'lean') {
        if (a.roll.length >= CAL_MIN_SAMPLES && isNum(o.restRoll)) {
          o.lean = pct(deviations(a.roll, o.restRoll), 0.9);
        }
      } else if (st.key === 'shrug') {
        if (a.torso.length >= CAL_MIN_SAMPLES) o.shrugTorso = median(a.torso);
      } else if (st.key === 'tpose') {
        if (a.span.length >= CAL_MIN_SAMPLES) o.span = median(a.span);
        // the depth step reads against this, so it has to be recorded even
        // when the model-space span could not be
        if (a.alen.length >= CAL_MIN_SAMPLES) o.userArm = median(a.alen);
      } else if (st.key === 'depth') {
        if (a.depth.length >= CAL_MIN_SAMPLES) o.depth = median(a.depth);
      } else if (st.key === 'hands') {
        if (a.reach.length >= CAL_MIN_SAMPLES) o.handsReach = median(a.reach);
        // Last of the held arm poses. The sweep refines what these set and the
        // check measures the result, so they go in now rather than at the end.
        applyArmGains(o);
      } else if (st.key === 'check') {
        // Deliberately sets nothing. Its whole job is to say how far off the
        // rig still is once everything else has been applied.
        o.checkRes = fitResidual(a.fit);
        o.resR = sideResidual(a.fit, 'Right');
        o.resL = sideResidual(a.fit, 'Left');
      } else if (st.fit) {
        o.fitN = a.fit.n;
        if (applyFit(a.fit, o.depth)) o.fitRes = fitResidual(a.fit);
        else o.fitBad = true;
      } else {
        var yaw = st.key === 'left' || st.key === 'right';
        var arr = yaw ? a.y : a.x;
        var rest = yaw ? o.restY : o.restX;
        // 90th percentile of the deviation, not the largest one seen
        o[st.key] = pct(deviations(arr, rest), 0.9);
        calRun.shake = Math.max(calRun.shake || 0, spread(arr));
      }
      nextStep(steps().length, finishMotion);
      return;
    }

    if (st.key === 'rest') calRun.out.smileRest = median(a.smile);
    else if (st.key === 'smile') calRun.out.smileMax = pct(a.smile, 0.9);

    // The three faces at one head pose, filed under that pose. A percentile
    // rather than the furthest frame for the two expressions, the same as
    // before: the extreme of a held furrow is as often a tracker excursion as
    // it is the furrow.
    if (st.at) {
      if (!calRun.browAt) calRun.browAt = {};
      var p = calRun.browAt[st.at] || (calRun.browAt[st.at] = {});
      if (st.expr === 'rest') {
        if (a.y.length < CAL_MIN_SAMPLES || a.x.length < CAL_MIN_SAMPLES) {
          retryStep(Math.min(a.y.length, a.x.length));
          return;
        }
        p.brow = median(a.brow);
        // The angle belongs to the relaxed reading. The furrow and the raise
        // are held at that same angle by instruction, and a face that is
        // straining is a worse place to measure where the head is pointing.
        p.y = median(a.y);
        p.x = median(a.x);
      } else {
        p[st.expr] = st.expr === 'down' ? pct(a.brow, 0.1) : pct(a.brow, 0.9);
        calRun.shake = Math.max(calRun.shake || 0, spread(a.brow));
      }
    }

    if (st.eyes) {
      var cl = closednessOf(a);
      if (cl.length < CAL_MIN_SAMPLES) { retryStep(cl.length); return; }
      if (st.eyes === 'open') {
        if (!calRun.openEyes) calRun.openEyes = [];
        calRun.openEyes.push(median(cl));
      } else if (st.eyes === 'furrow') {
        // The median, not a percentile: this is a held pose, and the extreme
        // frame of it is as often a flinch that shut the eye as it is the
        // furrow. Overstating it would lift the floor so far that a real
        // blink stops registering while the brows are down.
        if (!calRun.furrowEyes) calRun.furrowEyes = [];
        calRun.furrowEyes.push(median(cl));
      } else {
        if (!calRun.closedEyes) calRun.closedEyes = [];
        calRun.closedEyes.push(pct(cl, 0.9));
      }
      calRun.shake = Math.max(calRun.shake || 0, spread(cl));
    }
    if (calRun.kind === 'blink') { nextStep(BLINK_STEPS.length, finishBlink); return; }
    nextStep(CAL_STEPS.length, finishCalibration);
  }

  // The open reading is the *most closed* an open eye looked, and the closed
  // one the *least closed* a shut eye looked - the same conservative pair the
  // expression wizard takes, for the same reason. Erring inward on both ends
  // means a half-blink lands inside the range instead of clipping at it.
  function eyeSpanFrom(openEyes, closedEyes) {
    if (!openEyes || !closedEyes || !openEyes.length || !closedEyes.length) return null;
    var open = openEyes[0], i;
    for (i = 1; i < openEyes.length; i++) if (openEyes[i] > open) open = openEyes[i];
    var closed = closedEyes[0];
    for (i = 1; i < closedEyes.length; i++) if (closedEyes[i] < closed) closed = closedEyes[i];
    if (closed - open < EYE_SPAN_MIN) return null;
    return { open: clamp(open, 0, 1), closed: clamp(closed, 0, 1) };
  }

  // The line goes halfway between the two measured classes, which is the split
  // furthest from both of them - the most room a wrong reading in either
  // direction has before it lands on the wrong side.
  function applyEyeSpan(span) {
    cfg.eyeShutAt = clamp((span.open + span.closed) / 2,
      SPEC.eyeShutAt.min, SPEC.eyeShutAt.max);
    // Whatever was measured before belongs to the old line.
    cfg.eyeFurrowLift = 0;
  }

  // How much further a furrowed eye reads than a relaxed one. A furrow can
  // only ever close the eye, so a reading at or below the open one measured
  // nothing and is left inert rather than stored as a negative correction.
  // Capped so the raised line still leaves a real blink somewhere to go.
  function applyFurrow(furrowEyes, span) {
    cfg.eyeFurrowLift = 0;
    if (!furrowEyes || !furrowEyes.length || !span) return 0;
    var v = median(furrowEyes);
    if (!isNum(v) || !(v > span.open)) return 0;
    var room = Math.max(0, span.closed - EYE_SPAN_MIN - cfg.eyeShutAt);
    cfg.eyeFurrowLift = clamp(v - span.open, 0, Math.min(SPEC.eyeFurrowLift.max, room));
    return cfg.eyeFurrowLift;
  }

  function finishBlink() {
    var span = eyeSpanFrom(calRun.openEyes, calRun.closedEyes);
    if (!span) {
      // Not a failure worth throwing the old map away for: whatever was there
      // is still the better answer than the identity.
      stopCalibration(T('Eyes read almost the same open and shut - redo it, holding them properly shut.'), T('redo this'));
      return;
    }
    applyEyeSpan(span);
    var furrow = applyFurrow(calRun.furrowEyes, span);
    save();
    syncControls();
    var msg = T('Blink calibrated') + ' - ' + T('open') + ' ' + span.open.toFixed(3) +
      ', ' + T('shut') + ' ' + span.closed.toFixed(3) +
      ', ' + T('line at') + ' ' + cfg.eyeShutAt.toFixed(3) + '.';
    if (furrow) {
      msg += ' ' + T('Furrow closes the eye by') + ' ' + furrow.toFixed(3) +
        ' - ' + T('that much is discounted while the brows are down.');
    }
    log('blink calibration', { span: span, furrow: furrow });
    stopCalibration(msg, T('Blink calibrated'));
  }

  // The neck rig clamps its rotation to +/-0.8, so mapping the widest turn the
  // user actually makes onto that number uses the whole available range without
  // clipping - which is the same fix as the expression calibration, applied to
  // movement. The torso is driven by the same head signal, so it keeps its
  // stock ratio to the head.
  // The middle half of a held pose should barely move. When it does not, the
  // percentile is reading a moving target and the result is worth less.
  function shakeNote(range) {
    if (!calRun || !calRun.shake || !range) return '';
    if (calRun.shake < range * 0.35) return '';
    return T('The poses moved a lot while being read; redo it holding stiller for a tighter fit.') + ' ';
  }

  // A pose read at an angle, an arm that was not straight, a limb the tracker
  // half-lost: one bad step should degrade the fit, not replace it. Nothing a
  // single run reads is allowed to move a gain by more than half either way,
  // so a wrong answer stays recoverable by running it again.
  // Half a step by default: a re-run reads one pose once, and a reading that
  // disagrees wildly with a working setting is far more often a bad pose than
  // a bad setting. The workspace fit is the exception - it is hundreds of
  // samples across the whole reachable volume rather than one held pose, so it
  // is allowed to move a gain much further in a single run. That is the point
  // of running the long calibration.
  function nudge(from, to, band) {
    if (!isNum(from) || from <= 0) return to;
    var b = band || 0.5;
    return clamp(to, from * (1 - b), from * (1 + b));
  }

  // The three arm poses, applied the moment the last of them is read rather
  // than at the end of the wizard. The sweep that follows refines what they
  // set and the check after that has to be measuring the finished rig, so
  // nothing here may still be pending by the time either of those runs.
  function applyArmGains(c) {
    // The depth gain multiplies the raw landmark depth, and the ratio was
    // measured against that same raw depth, so it is the gain outright. Floored
    // well above zero: a flattened depth axis is not a smaller gesture toward
    // the camera, it is no gesture at all.
    if (isNum(c.depth) && c.depth > 0) {
      cfg.armDepth = clamp(nudge(cfg.armDepth, c.depth), 0.3, 2);
    }

    // Arms out to the sides sit in the image plane, where there is no depth for
    // the tracker to get wrong, so this is the cleanest reach reading there is.
    // It is a factor on the reach that was in force while it was read, not a
    // reach: the retarget had already scaled the target by `armReach` before
    // the span being measured came out of it.
    if (cfg.armIK && isNum(c.span) && c.span > 0) {
      cfg.armReach = clamp(nudge(cfg.armReach, cfg.armReach * c.span), 0.5, 2);
    }

    if (isNum(c.restReach) && isNum(c.handsReach) && c.restReach - c.handsReach > 0.04) {
      var target = c.restReach * 0.22;
      var moved = c.restReach - c.handsReach;
      var want = Math.max(c.restReach - target, moved);
      var ratio = want / moved;
      // the retarget scales the shoulder -> hand vector, so the reading is
      // relative to whatever reach was in force while it was taken; the Euler
      // rig has no such history and takes the ratio outright
      if (cfg.armIK) {
        // Hands on the head is a vertical, foreshortened pose, and it lands on
        // the vertical factor now instead of on Reach. It used to be allowed to
        // raise Reach and forbidden to lower it, because Reach also carried the
        // T-pose's lateral reading and that one was the honest one. With an
        // axis of its own there is nothing left for it to corrupt, so the gate
        // is gone: a model whose hands overshoot its head can be pulled back
        // down as readily as one whose hands cannot get there at all.
        cfg.reachUp = clamp(nudge(cfg.reachUp, cfg.reachUp * ratio), 0.5, 2);
      } else {
        c.armGain = cfg.armGain = clamp(ratio, 0.8, 2.5);
      }
    }
  }

  // How far one sweep may move a gain. Wide on purpose: `nudge`'s half step
  // guards a working setting against a single mis-held pose, and a sweep is not
  // one pose - it is the whole workspace, sampled hundreds of times. A
  // calibration that gets run once and then kept has to be allowed to arrive.
  var FIT_BAND = 1.5;
  // Residual at or under this is as close as a rig with a different skeleton
  // ever gets; above it, something in the run was wrong.
  var FIT_GOOD = 0.12;

  function fitPct(r) { return (r * 100).toFixed(1) + '%'; }

  function fitResidual(f) {
    return (f && f.res.length) ? median(f.res) : null;
  }

  // The median of every direction the arm visited, against the depth pose's
  // single reading of a single direction. Same quantity, far better sampled -
  // so this runs after the pose and is allowed to move much further.
  //
  // It sets depth and nothing else. Reach is a magnitude, and the sweep has no
  // magnitude error to read: the model's hand distance comes from the elbow
  // bend, so it already agrees with the person's in each one's own proportions.
  // Vertical stays with the hands-on-head pose, which is a known pose and
  // therefore has a ground truth of its own.
  // The depth pose measured this same compression a few steps earlier, from a
  // pose that is hard to get wrong: one arm at the lens. The sweep is the better
  // instrument when it is performed right and worthless when it is not, and the
  // one thing that separates those cases is whether it agrees with the pose.
  //
  // A bent elbow only ever inflates the ratio - the hand is nearer than the arm
  // is long and the shortfall is read as depth - so a sweep that comes back far
  // above the pose is a sweep that was performed with bent arms, and taking it
  // would distort every mapped direction and weld the model's elbows straight.
  var FIT_AGREE = 1.6;

  function applyFit(f, pose) {
    if (!f.r.length) return false;
    var got = median(f.r);
    if (isNum(pose) && pose > 0 && (got > pose * FIT_AGREE || got < pose / FIT_AGREE)) {
      return false;
    }
    cfg.armDepth = clamp(nudge(cfg.armDepth, got, FIT_BAND), 0.3, 2);
    return true;
  }

  // Reported, never applied - which arm the tracker is reading worse. It is not
  // a reason to move that arm's Reach: a compressed reading is the camera's
  // doing, not a short bone. It is a reason to look at where the camera is, and
  // the per-side sliders are there for the cases where moving it is not an
  // option.
  function sideResidual(f, side) {
    var a = f.side[side];
    return a.res.length ? median(a.res) : null;
  }

  function finishMotion() {
    var c = calRun.out;
    var devY = Math.max(c.left || 0, c.right || 0);
    var devX = Math.max(c.up || 0, c.down || 0);
    var dev = Math.max(devY, devX);

    if (dev < 0.05) {
      stopCalibration(T('Barely any head movement was tracked. Is face tracking running?'),
        T('No head movement was tracked. Check the camera.'));
      return;
    }

    cfg.headGain = clamp(0.8 / dev, 0, 1.5);
    // this one rides on the head signal, so it stays in the stock ratio to it
    cfg.bodyGain = clamp(STOCK_BODY_GAIN * (cfg.headGain / STOCK_HEAD_GAIN), 0, 0.2);
    var notes = [];

    // How hard a held pose has to be filtered is a property of the camera and
    // the light, not of the person, so it is worth measuring rather than
    // guessing at. The constant is empirical: it puts a clean webcam near 2 Hz
    // and a grainy one under 1.
    if (isNum(c.noise)) {
      cfg.minCutoff = clamp(0.008 / Math.max(c.noise, 0.0005), 0.3, 3);
      notes.push(T('Steadiness') + ' ' + cfg.minCutoff.toFixed(2) + 'Hz');
    }

    // Lean and twist come from the pose solver, not from the head, and the rig
    // clamps them at 0.7 - the same idea as the neck's 0.8. Stock shares one
    // gain between this and the head-driven pitch above, which is why opening
    // the lean up used to over-pitch the torso; they are separate hooks now.
    if (isNum(c.lean) && c.lean > 0.02) {
      cfg.leanGain = clamp(0.7 / c.lean, 0, 1);
      notes.push(T('Torso lean gain') + ' ' + cfg.leanGain.toFixed(2) + 'x');
    }

    // Shoulders that rolled as far as the head did were not held still - that
    // is a lean, and taking it as coupling would strip every real lean that
    // happens with a head tilt. Same-sign only: a counter-lean is the body
    // doing the opposite of the head, not the solver copying it.
    if (isNum(c.headRoll) && isNum(c.rollAtHead) &&
        Math.abs(c.headRoll) > 0.08 &&
        Math.abs(c.rollAtHead) <= Math.abs(c.headRoll) * 1.2) {
      var couple = c.rollAtHead / c.headRoll;
      if (couple > 0) {
        cfg.leanHead = clamp(couple, 0, 1);
        notes.push(T('Head-tilt isolation') + ' ' + cfg.leanHead.toFixed(2));
      }
    }

    // Someone whose shoulders really travel wants the model's to follow further
    if (isNum(c.restTorso) && isNum(c.shrugTorso) && c.restTorso > 1e-4) {
      var travel = (c.shrugTorso - c.restTorso) / c.restTorso;
      if (travel > 0.01) {
        cfg.shoulder = clamp(travel * 3, 0, 0.6);
        notes.push(T('Shoulder follow') + ' ' + cfg.shoulder.toFixed(2));
      }
    }

    if (!cfg.armIK && isNum(c.armGain)) {
      notes.push(T('Arm gain') + ' ' + c.armGain.toFixed(2));
    }
    if (isNum(c.fitRes)) {
      notes.push(T('Fit') + ' ' + fitPct(c.fitRes) + ' ' + T('over') + ' ' +
        c.fitN + ' ' + T('samples'));
    } else if (c.fitBad) {
      notes.push(T('sweep ignored - it disagreed with the depth pose, so the elbows were probably bent'));
    }
    // The check ran against the finished rig, so this number is the one that
    // says whether the calibration is any good - not the fit's own residual,
    // which is measured on the very samples that produced it.
    if (isNum(c.checkRes)) {
      notes.push(T('Check') + ' ' + fitPct(c.checkRes) +
        ' - ' + T(c.checkRes <= FIT_GOOD ? 'good' : 'redo this'));
    }
    // Which arm the tracker is reading worse. Nothing is set from it - see
    // `sideResidual` - but a lopsided pair is the one thing that says the
    // per-side sliders are worth touching by hand.
    if (isNum(c.resR) && isNum(c.resL)) {
      notes.push(T('Per arm') + ' ' + fitPct(c.resR) + '/' + fitPct(c.resL));
    }
    if (cfg.armIK && (isNum(c.span) || isNum(c.handsReach) || isNum(c.fitRes))) {
      notes.push(T('Reach') + ' ' + cfg.armReach.toFixed(2) +
        ', ' + T('up') + ' ' + cfg.reachUp.toFixed(2) +
        ', ' + T('depth') + ' ' + cfg.armDepth.toFixed(2));
    }
    save();
    syncControls();

    stopCalibration(shakeNote(dev) + T('Calibrated') + ' - ' + T('turn') + ' ' + devY.toFixed(2) +
      ', ' + T('tilt') + ' ' + devX.toFixed(2) + '  ->  ' +
      T('Head / neck gain') + ' ' + cfg.headGain.toFixed(2) +
      ', ' + T('Torso gain') + ' ' + cfg.bodyGain.toFixed(3) +
      (notes.length ? ', ' + notes.join(', ') : '') + '.',
      // The verdict, not the reading. Whether it worked is the one thing worth
      // hearing from across the room; the numbers stay on screen for later.
      T('Motion calibration done') + '. ' +
      (isNum(c.checkRes)
        ? T(c.checkRes <= FIT_GOOD ? 'It came out good.' : 'It came out poor - run it again.')
        : ''));
  }

  function finishMouth() {
    var out = calRun.out;
    var m = { rest: out.rest };
    var i;
    for (i = 0; i < VOWELS.length; i++) m[VOWELS[i]] = out[VOWELS[i]];
    if (out.smile) m.smile = out.smile;

    // Two vowels that read the same are two vowels that will land on the same
    // atlas cell, which is the whole complaint this wizard exists to answer.
    // Say which ones, rather than saving a mapping that quietly cannot work.
    var w = mouthWeights(m);
    var keys = mouthProtos(m);
    var same = [];
    for (i = 0; i < keys.length; i++) {
      for (var j = i + 1; j < keys.length; j++) {
        if (mouthDist(m[keys[i]], m[keys[j]], w) < 0.25) {
          same.push(keys[i].toUpperCase() + '/' + keys[j].toUpperCase());
        }
      }
    }

    cfg.mouth = m;
    save();
    syncControls();

    var msg = T('Mouth calibrated') + ' - ' + (mouthProtos(m).length - 1) + ' ' +
      T('mouths recorded') + '.';
    if (same.length) {
      msg += ' ' + T('These read almost the same:') + ' ' + same.join(', ') + '. ' +
        T('Redo those, exaggerating the shape and voicing the sound out loud.');
    }
    log('mouth calibration', m);
    stopCalibration(msg, T('Calibration done'));
  }

  function finishCalibration() {
    var c = calRun.out;
    // browRest / browDown / browUp are the facing-camera pose under their old
    // names - every threshold, readout and older code path reads them, and
    // browAt.rest is those same three numbers.
    var front = (calRun.browAt && calRun.browAt.rest) || {};
    if (isNum(front.brow)) c.browRest = front.brow;
    if (isNum(front.down)) c.browDown = front.down;
    if (isNum(front.up)) c.browUp = front.up;
    var down = Math.abs(c.browDown - c.browRest);
    var up = Math.abs(c.browUp - c.browRest);
    var sm = c.smileMax - c.smileRest;
    var weak = [];
    if (down < BROW_SPAN_MIN) weak.push('furrow');
    if (up < BROW_SPAN_MIN) weak.push('raise');
    if (sm < BROW_SPAN_MIN) weak.push('smile');

    // Floor = the most-closed an open eye still looked across every pose.
    // Peak = the weakest closed pose, so a blink while turned still reaches 1.
    // Written to the eye settings, the same two the short blink wizard and the
    // two sliders write - there is one eye map, not one per way of reaching it.
    var eyeSpan = eyeSpanFrom(calRun.openEyes, calRun.closedEyes);
    if (eyeSpan) {
      applyEyeSpan(eyeSpan);
      // Order matters: the furrow lift is capped against the line, so the line
      // has to be in place first.
      applyFurrow(calRun.furrowEyes, eyeSpan);
    } else {
      weak.push('blink');
    }

    // Every pose that recorded all three faces is one the mapping can use
    // outright; one whose furrow or raise barely moved would give that angle a
    // span narrow enough to trip on tracker noise, so it is named rather than
    // quietly kept.
    var spans = 0;
    var at = calRun.browAt || {};
    for (var pk in at) {
      var pp = at[pk];
      if (!pp || !isNum(pp.brow)) continue;
      var pd = isNum(pp.down) ? Math.abs(pp.down - pp.brow) : null;
      var pu = isNum(pp.up) ? Math.abs(pp.up - pp.brow) : null;
      if (pd === null && pu === null) continue;
      spans++;
      if (pd !== null && pd < BROW_SPAN_MIN) weak.push(pk + ' ' + T('furrow'));
      if (pu !== null && pu < BROW_SPAN_MIN) weak.push(pk + ' ' + T('raise'));
    }

    if (usableBrowAt(calRun.browAt)) c.browAt = calRun.browAt;
    c.src = BROW_SRC;

    cfg.cal = c;
    cfg.signal = 'calibrated';
    resetCalibration();
    save();
    syncControls();

    var blinkSpan = eyeSpan ? eyeSpan.closed - eyeSpan.open : 0;
    var poseDrift = browPoseDrift(c);
    var msg = shakeNote(Math.max(down, up, blinkSpan)) + T('Calibrated') +
      ' - ' + T('furrow') + ' ' + down.toFixed(3) +
      ', ' + T('raise') + ' ' + up.toFixed(3) +
      ', ' + T('smile') + ' ' + sm.toFixed(3);
    if (blinkSpan) msg += ', ' + T('blink') + ' ' + blinkSpan.toFixed(3);
    if (poseDrift > 0) msg += ', ' + T('brow drift') + ' ' + poseDrift.toFixed(3);
    if (spans) msg += ', ' + spans + ' ' + T('poses with their own span');
    msg += '.';
    if (weak.length) {
      msg += ' ' + T('These barely moved:') + ' ' + weak.join(', ') + '. ' +
        T('Redo that step with a bigger expression if it does not trigger.');
    }
    log('calibration', c);
    stopCalibration(msg, T('Calibration done'));
  }

  // Each wizard writes into the card it was started from.
  function calTarget() {
    if (!calRun) return null;
    if (calRun.kind === 'motion') return calMotionEl;
    if (calRun.kind === 'mouth') return calMouthEl;
    if (calRun.kind === 'blink') return calBlinkEl;
    return calEl;
  }

  // ------------------------------------------------------ calibration HUD
  //
  // The prompt used to exist only inside the settings card, which is the one
  // place it cannot be read: every pose in these wizards is held at arm's
  // length from the screen, several of them turned away from it, and the card
  // is 12px text behind the panel the pose is being performed in front of.
  // That is the reason the spoken prompts exist at all.
  //
  // Speech is not a substitute, and on the machine this fork targets it is
  // often not available: Chromium on Raspberry Pi OS ships with no
  // speechSynthesis voices unless one is installed, so `say()` is silence and
  // nothing tells the user why. So the prompt is also drawn large, over the
  // canvas, where the pose can see it.
  //
  // `pointer-events: none` throughout: this sits over the whole viewport and
  // must never eat a click meant for the app. Esc and the card's own Cancel
  // button stay the way out.
  var hudEl = null, hudStep = null, hudTitle = null, hudHint = null, hudLine = null;

  function buildHud() {
    if (hudEl && hudEl.isConnected) return hudEl;
    var body = document.body;
    if (!body) return null;
    hudEl = el('div', 'psx-injected');
    hudEl.id = 'psx-cal-hud';
    hudEl.style.cssText =
      'position:fixed;left:50%;top:6vh;transform:translateX(-50%);' +
      'z-index:2147483000;pointer-events:none;display:none;' +
      'max-width:min(92vw,900px);padding:18px 28px;border-radius:14px;' +
      'background:rgba(12,12,18,.82);box-shadow:0 8px 40px rgba(0,0,0,.55);' +
      'text-align:center;color:#fff;line-height:1.25;' +
      'font-family:inherit;text-shadow:0 2px 8px rgba(0,0,0,.9)';

    hudStep = el('div', null, '');
    hudStep.style.cssText = 'font-size:14px;opacity:.6;letter-spacing:.16em;' +
      'text-transform:uppercase;font-variant-numeric:tabular-nums';

    hudTitle = el('div', null, '');
    // clamped rather than fixed: this is read from across a room on a monitor
    // and from a foot away on a laptop, and the longest prompts are a sentence
    hudTitle.style.cssText = 'font-size:clamp(24px,4.2vw,46px);font-weight:700;margin-top:6px';

    hudHint = el('div', null, '');
    hudHint.style.cssText = 'font-size:clamp(15px,2vw,22px);opacity:.85;margin-top:8px';

    hudLine = el('div', null, '');
    hudLine.style.cssText = 'font-size:clamp(13px,1.5vw,17px);opacity:.6;margin-top:12px;' +
      'font-variant-numeric:tabular-nums';

    hudEl.appendChild(hudStep);
    hudEl.appendChild(hudTitle);
    hudEl.appendChild(hudHint);
    hudEl.appendChild(hudLine);
    body.appendChild(hudEl);
    return hudEl;
  }

  // Called from syncCalUi, so the HUD appears and goes with the run rather than
  // waiting for the next painted frame - a wizard that is counting in has not
  // necessarily had a tracked frame yet.
  function syncCalHud() {
    if (!calRun) {
      // A verdict still being shown owns the HUD until its own timer is up.
      if (hudEl && !hudFlashAt) hudEl.style.display = 'none';
      return;
    }
    if (buildHud()) hudEl.style.display = '';
  }

  // One timer, cleared before it is reset, so two runs finishing close together
  // cannot leave the earlier verdict on screen over the later one.
  var hudFlashAt = null;
  var HUD_FLASH_MS = 4500;

  function flashHud(title, sub) {
    if (!buildHud()) return;
    if (hudFlashAt) clearTimeout(hudFlashAt);
    hudEl.style.display = '';
    setText(hudStep, '');
    setText(hudTitle, title);
    setText(hudHint, sub || '');
    setText(hudLine, '');
    hudFlashAt = setTimeout(function () {
      hudFlashAt = null;
      // A new run may have started inside the window; that one owns the HUD now.
      if (!calRun && hudEl) hudEl.style.display = 'none';
    }, HUD_FLASH_MS);
  }

  function paintHud(st, line) {
    if (hudFlashAt) { clearTimeout(hudFlashAt); hudFlashAt = null; }
    if (!buildHud()) return;
    hudEl.style.display = '';
    setText(hudStep, (calRun.i + 1) + ' / ' + steps().length);
    setText(hudTitle, T(st.title));
    setText(hudHint, T(st.hint));
    setText(hudLine, line);
  }

  function paintCalibration(left) {
    if (!calRun) return;
    var calEl = calTarget();
    var st = steps()[calRun.i];
    var line;
    if (calRun.phase === 'prep') {
      line = T('Get into the pose - reading in') + ' ' +
        Math.ceil(left / 1000) + 's. ' + T('Space reads now, Esc cancels.');
    } else if (calRun.phase === 'wait') {
      line = T('Hold the pose, then press Space. Esc cancels.');
    } else {
      line = T('Reading, keep holding...');
      // A sweep is the one step whose samples are mostly thrown away - a bent
      // elbow counts for nothing - and without a number on screen there is no
      // way to tell a pose that is working from one that is not. This step was
      // shipped without it once and a run that gathered nothing looked exactly
      // like a run that gathered everything.
      if (st.fit) {
        line += '  ' + calRun.acc.fit.n + ' ' + T('samples');
        if (calRun.acc.fit.n < FIT_MIN) line += ' - ' + T('straighten your elbows');
      }
    }
    paintHud(st, line + (calRun.note ? '  ' + calRun.note : ''));
    // The card keeps its copy: it is where the result is written when the run
    // ends, and the panel may well be the thing being read on a laptop.
    if (!calEl) return;
    setText(calEl,
      (calRun.i + 1) + '/' + steps().length + '  ' + T(st.title) +
      NL + T(st.hint) +
      NL + line +
      (calRun.note ? NL + calRun.note : ''));
  }

  // Fed from the face hook, so it records whatever the tracker is actually
  // producing rather than the mapped value.
  function sampleCalibration(rawBrow, rawSmile, rig) {
    if (!calRun || calRun.phase !== 'hold') return;
    if (now() - calRun.holdFrom < CAL_SETTLE) return;
    var a = calRun.acc;
    if (calRun.kind === 'motion') {
      var h = rig && rig.head;
      if (!h) return;
      a.y.push(num(h.y));
      a.x.push(num(h.x));
      a.z.push(num(h.z));
      return;
    }
    // a hand on the face is what the mesh is looking at, not the pose
    if (faceOcc) return;
    if (calRun.kind === 'mouth') {
      var f = mouthFeature(rig);
      if (f) a.feat.push(f);
      return;
    }
    a.brow.push(rawBrow);
    a.smile.push(rawSmile);
    var h = rig && rig.head;
    if (h) {
      a.y.push(num(h.y));
      a.x.push(num(h.x));
    }
    var eye = rig && rig.eye;
    if (eye && isNum(eye.l) && isNum(eye.r)) {
      a.eyeL.push(eye.l);
      a.eyeR.push(eye.r);
    }
  }

  // Each brow direction gets its own span, which is the whole point of asking
  // for the poses separately. Stock Kalidokit remaps brow to 0..1 and clamps
  // the floor, so a furrow and rest both land on 0; we feed the unclamped
  // scalar instead, and this maps it around the recorded rest.
  // A recording belongs to the scalar it was taken against. The two do not
  // share a rest - the flat ratio and the 3D one disagree by however much this
  // face wraps around - so a recording read against the other one puts the zero
  // in the wrong place permanently, which is the fault it was meant to fix.
  // Older saves carry no stamp, so they belong to the flat one.
  function browCalUsable(c) {
    return !!(c && isNum(c.browRest) && isNum(c.browDown) && isNum(c.browUp) &&
      c.browDown < c.browRest - 0.002 && c.browUp > c.browRest + 0.002 &&
      c.src === BROW_SRC);
  }

  function browPoint(p) {
    return p && isNum(p.brow) && isNum(p.y) && isNum(p.x) ? p : null;
  }

  // ~7° of Kalidokit's head.y / head.x. Below that the "turn" was not a turn
  // and a slope fitted through it is noise pretending to be drift.
  var BROW_POSE_MIN = 0.12;

  // The pose recordings are in whichever scalar was on when they were taken,
  // and a drift measured on one scalar is not a drift the other has. Reading
  // them against the other one does not correct anything - it subtracts a
  // fault that is not there, which is worse than leaving it alone. The flat
  // scalar sags +0.30 at a full turn where the 3D one does not move at all,
  // so an old recording under the new scalar was pushing a relaxed face a
  // third of the way to angry and holding it there.
  //
  // `browCalUsable` had this check and the pose path did not, which is the
  // whole of "now it is angry all the time". Both gates, or neither.
  function poseCalOk(c) {
    return !!(c && usableBrowAt(c.browAt) && c.src === BROW_SRC);
  }

  function usableBrowAt(at) {
    var rest = browPoint(at && at.rest);
    if (!at) return false;
    var keys = POSE_Y.concat(POSE_X);
    var oy = rest ? rest.y : 0;
    var ox = rest ? rest.x : 0;
    for (var i = 0; i < keys.length; i++) {
      var p = browPoint(at[keys[i]]);
      if (!p) continue;
      if (Math.abs(p.y - oy) >= BROW_POSE_MIN || Math.abs(p.x - ox) >= BROW_POSE_MIN) return true;
    }
    return false;
  }

  function browPoseDrift(c) {
    if (!poseCalOk(c) || !isNum(c.browRest)) return 0;
    var keys = POSE_Y.concat(POSE_X);
    var d = 0;
    for (var i = 0; i < keys.length; i++) {
      var p = browPoint(c.browAt[keys[i]]);
      if (p) d = Math.max(d, Math.abs(p.brow - c.browRest));
    }
    return d;
  }

  function sidePoint(p, axis, field) {
    p = browPoint(p);
    if (!p) return null;
    var v = p[field || 'brow'];
    return isNum(v) ? { v: p[axis], brow: v } : null;
  }
  // Piecewise linear through every pose recorded on this axis, the rest pose
  // among them, in order of angle.
  //
  // This used to take one recording per side and draw a straight line from
  // rest out to it. A straight line through a curve is right at both ends and
  // wrong everywhere between them, and drift with head angle is a curve - so
  // a full turn was corrected, facing the camera was correct by construction,
  // and halfway between the two was off by the whole sag. That is what "it is
  // fine looking straight, wrong looking aside, and only sometimes" was: it
  // depended on where between the two knots the head happened to be.
  //
  // Nothing here knows how many recordings there are. More poses are more
  // knots, and the shape of the curve stops being anybody's guess.
  //
  // Left and right often drift the same way (foreshortening does not care
  // which way the head turned), so a signed slope fitted through both would
  // cancel; each side speaks for itself because each is its own segment.
  var axisKnots = [];

  function knotsFor(originV, originB, pts) {
    var k = axisKnots;
    k.length = 0;
    k.push({ v: originV, brow: originB });
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (!p || Math.abs(p.v - originV) < BROW_POSE_MIN) continue;
      k.push(p);
    }
    k.sort(function (a, b) { return a.v - b.v; });
    return k;
  }

  function axisShift(v, originV, originB, pts) {
    var k = knotsFor(originV, originB, pts);
    if (k.length < 2) return 0;
    var lastI = k.length - 1;
    // A quarter past the furthest recording and no further. Beyond that the
    // curve is a guess and the recordings said nothing about it.
    if (v < originV) v = Math.max(v, originV - (originV - k[0].v) * 1.25);
    else v = Math.min(v, originV + (k[lastI].v - originV) * 1.25);
    var a, b, i;
    if (v <= k[0].v) { a = k[0]; b = k[1]; }
    else if (v >= k[lastI].v) { a = k[lastI - 1]; b = k[lastI]; }
    else {
      for (i = 1; i <= lastI && k[i].v < v; i++) {}
      a = k[i - 1]; b = k[i];
    }
    var span = b.v - a.v;
    if (span < 1e-6) return b.brow - originB;
    return a.brow + (b.brow - a.brow) * ((v - a.v) / span) - originB;
  }

  // Which recorded poses sit on each axis. Two arrays made once: this runs on
  // every solved face, three times over, for the life of the session.
  var POSE_Y = ['leftNear', 'leftOpen', 'rightNear', 'rightOpen'];
  var POSE_X = ['gazeUpNear', 'gazeUp', 'gazeDownNear', 'gazeDown'];
  var axisPts = [];

  function ptsOn(at, keys, axis, field) {
    axisPts.length = 0;
    for (var i = 0; i < keys.length; i++) {
      var p = sidePoint(at[keys[i]], axis, field);
      if (p) axisPts.push(p);
    }
    return axisPts;
  }

  // The same interpolation, over whichever of the three numbers each pose
  // recorded. A pose that has not got this field drops out of it and the
  // facing-camera reading stands - which is how a calibration recorded before
  // the furrow and raise steps existed keeps working.
  function poseField(c, rig, field, base) {
    if (!isNum(base)) return base;
    if (!poseCalOk(c)) return base;
    var h = rig && rig.head;
    if (!h) return base;
    var at = c.browAt;
    var o = browPoint(at.rest);
    var oy = o ? o.y : 0;
    var ox = o ? o.x : 0;
    var origin = (o && isNum(o[field])) ? o[field] : base;
    // one axis at a time: `axisPts` is the one scratch array
    var dy = axisShift(num(h.y), oy, origin, ptsOn(at, POSE_Y, 'y', field));
    var dx = axisShift(num(h.x), ox, origin, ptsOn(at, POSE_X, 'x', field));
    var shifted = base + dy + dx;
    return isNum(shifted) ? shifted : base;
  }

  function poseBrowRest(c, rig) {
    if (!c || !isNum(c.browRest)) return 0;
    // Bounded by the recordings already (axisShift will not go past 1.25 of a
    // recorded pose). Do not also cap against the furrow/raise span: a yaw
    // that eats most of a small raise is the bug, and that cap would leave it.
    return poseField(c, rig, 'brow', c.browRest);
  }

  // How far this person's own furrow or raise actually travels *at this
  // angle*. Recording the relaxed face at four poses fixed where zero sits and
  // left the gain alone, so the same furrow read as a different fraction
  // depending on which way the head was pointing - too much at one angle, too
  // little at another, and both look like a threshold that cannot be set.
  //
  // A recording is one person holding one face once, so a step that went badly
  // must not be able to invent a hair-trigger or a dead spot. Kept inside a
  // band around the facing-camera span, which is the one measured with the
  // most of the face in view.
  var POSE_SPAN_MIN = 0.4;
  var POSE_SPAN_MAX = 2.5;

  function poseBrowSpan(c, rig, dev) {
    var flat = browSpan(c, dev);
    var rest = poseBrowRest(c, rig);
    var end = dev < 0
      ? poseField(c, rig, 'down', c.browDown)
      : poseField(c, rig, 'up', c.browUp);
    if (!isNum(end) || !isNum(rest)) return flat;
    return clamp(Math.abs(end - rest), flat * POSE_SPAN_MIN, flat * POSE_SPAN_MAX);
  }

  function poseAdjustedBrow(raw, rig) {
    var c = cfg.cal;
    if (!poseCalOk(c) || !cfg.poseFix) return raw;
    return raw - (poseBrowRest(c, rig) - c.browRest);
  }

  // Rest is a band, not a point. A recorded furrow can be a few hundredths, and
  // mapping that whole span onto 0..1 makes tracker noise around rest look like
  // a full angry. Then `ramp(1, angryAt)` is 1 for every threshold we offer, so
  // the slider appears broken. Deadzone the rest band; still map the recorded
  // extreme to 1. Floor the span so a weak recording cannot amplify noise.
  var BROW_DEAD = 0.25;
  var BROW_SPAN_MIN = 0.012;

  function calNorm(dev, span) {
    var x = dev / Math.max(span, BROW_SPAN_MIN);
    if (x > BROW_DEAD) return (x - BROW_DEAD) / (1 - BROW_DEAD);
    if (x < -BROW_DEAD) return (x + BROW_DEAD) / (1 - BROW_DEAD);
    return 0;
  }

  function browSpan(c, dev) {
    return dev < 0 ? Math.abs(c.browDown - c.browRest) : Math.abs(c.browUp - c.browRest);
  }

  function calibratedSmile(raw) {
    var c = cfg.cal;
    return calNorm(raw - c.smileRest, c.smileMax - c.smileRest);
  }

  // ------------------------------------------------------ the brow scalar
  //
  // Kalidokit's brow is the mean of three brow-to-lid distances over one span
  // across the eye, per side:
  //
  //   (d(63,229) + d(105,230) + d(66,231)) / 3 / d(35,244) / 1.15 - 1
  //
  // and every one of those distances is taken in the *image*, with z thrown
  // away. The three on top run down the face and the one underneath runs
  // across it, so they do not foreshorten together: turn the head and the span
  // underneath shortens while the three on top barely move, dip the chin and
  // the opposite happens, roll the head and the whole ratio walks. Measured on
  // a rigid face in front of a lens it moves +0.30 at 40 degrees of yaw
  // against a furrow worth 0.05 on the same face - six times the expression,
  // from a head that turned.
  //
  // That is the whole of "looking aside reads as angry", and it is not a
  // threshold that wants tuning or a rest that wants relearning. It is a
  // length divided by another length that is not being measured at the same
  // angle. Correcting it afterwards, however well, is correcting for a
  // projection that did not have to happen.
  //
  // What it takes to fix is not more geometry, it is a denominator that
  // foreshortens with the numerator. So: divide the brow-to-lid gap by a rigid
  // *vertical* beside it - the face oval down the side of the head, temple to
  // jaw, past the ear - and take the gap along that vertical's own direction
  // rather than as a bare length. Both run down the face, both are on the same
  // side of it, both sit at much the same depth. A yaw leaves a vertical alone,
  // a pitch shortens both by the same cosine, a roll turns both together, and
  // moving nearer the camera scales both. Nothing in the ratio moves unless a
  // brow does.
  //
  // Two other readings were tried and are worse. Kalidokit's distances taken
  // in three dimensions is geometrically exact and rests on the mesh's z,
  // which is a fitted estimate: on a noisy camera it costs more than the
  // projection did. Decomposing each gap onto a face-plane basis - eye corners
  // across, forehead-to-nasion down - is exact for a flat face and a face is
  // not flat: the nasion stands proud of the forehead by a third of the length
  // between them, so that basis leans out of the plane it claims to be in, and
  // on a synthetic sweep of 105 head poses it was *worse* than upstream on the
  // deepest of three face profiles. This one is better than upstream on all
  // three, at every camera distance, by about three to one on the mean drift
  // and with the furrow itself reading within a tenth of its size at the
  // camera whatever the head is doing.
  //
  // What is left for the pose recordings and the ladder is the little that
  // perspective does between two depths a few centimetres apart. That is what
  // they were always meant to be for.
  //
  // Each side carries its own reference so that neither borrows the other's
  // foreshortening: 127 -> 93 down the right of the face, 356 -> 323 down the
  // left, both on the face oval and neither touched by an expression. The
  // chin (152) is the obvious long vertical and is the wrong one - it moves
  // with the jaw, so every spoken vowel would arrive in the brow signal.
  var BROW_SIDES = [
    { up: [127, 93], pairs: [[63, 229], [105, 230], [66, 231]] },
    { up: [356, 323], pairs: [[293, 449], [334, 450], [296, 451]] }
  ];
  // The gap is a little under half that side length on a relaxed face, so this
  // is the same job Kalidokit's 1.15 does: put a neutral brow near zero, a
  // furrow below it and a raise above. Only the zero, and every mapping under
  // this subtracts a measured rest anyway - a face whose proportions differ
  // shifts the zero, it does not break the reading.
  var BROW_NEUTRAL = 0.45;

  // A recording belongs to the scalar it was taken against, and is stamped
  // with it. Two ways of reading a brow do not share a rest - the flat ratio
  // sags a third of the way to angry at a full turn where this one does not
  // move - so a recording read against a different one puts the zero
  // permanently wrong, which is the fault it was recorded to fix. A profile
  // carrying another stamp, or none, is rejected for the brow and falls back
  // to auto until it is recorded again; the smile and the vowels in it are
  // untouched by any of this and are still used.
  var BROW_SRC = 'side';

  // what each way of reading it last said, for comparing them live
  var browRead = { side: null, flat: null };

  // Image plane only. z is exactly what this is built to do without.
  function sub2(a, b, out) {
    out.x = num(a.x) - num(b.x);
    out.y = num(a.y) - num(b.y);
    return out;
  }

  // Made once and written over: this runs eight times per solved face for the
  // life of the session, the same reason `armDbg` holds raw numbers.
  var axU = { x: 0, y: 0 }, axD = { x: 0, y: 0 };

  function browSideRatio(lm, side) {
    var u = sub2(lm[side.up[1]], lm[side.up[0]], axU);
    var len = Math.sqrt(u.x * u.x + u.y * u.y);
    if (!(len > 1e-6)) return null;
    var sum = 0;
    for (var i = 0; i < side.pairs.length; i++) {
      var d = sub2(lm[side.pairs[i][0]], lm[side.pairs[i][1]], axD);
      // how far the gap reaches along the reference, not how long it is: a
      // furrow slides the brow down the face, and the sideways part of that
      // vector is anatomy rather than expression
      var along = Math.abs((d.x * u.x + d.y * u.y) / len);
      if (!(along > 0)) return null;
      sum += along;
    }
    return (sum / side.pairs.length) / len / BROW_NEUTRAL - 1;
  }

  // Called from inside the bundle's own face handler, not from our hook, so
  // nothing here may throw: a face result is not something the app checks.
  function browScalar(lm, fallback) {
    browRead.flat = isNum(fallback) ? fallback : null;
    browRead.side = null;
    var v = null;
    if (lm && lm.length >= 468) {
      try {
        var a = browSideRatio(lm, BROW_SIDES[0]);
        var b = browSideRatio(lm, BROW_SIDES[1]);
        if (a !== null && b !== null && isNum((a + b) / 2)) {
          v = (a + b) / 2;
          browRead.side = v;
        }
      } catch (e) { v = null; }
    }
    // A frame this could not read is not a reason to hand back Kalidokit's
    // number: the two do not share a rest, so swapping between them mid-session
    // steps the signal by more than any expression does. Hold what the filter
    // last had instead, and only fall back before it has ever had anything.
    if (v === null) return browFilt.v === null ? fallback : browFilt.v;
    return filterBrow(v);
  }

  // ------------------------------------------------------- brow noise floor
  //
  // The scalar above is pose-invariant, not noise-free: it is eight landmark
  // positions a frame, and Mediapipe moves every one of them a little on every
  // frame. A furrow is worth a few hundredths and so is a tenth of a second of
  // that jitter, which is what makes one threshold both trip on nothing and
  // miss a real face.
  //
  // One-euro, on the scalar itself rather than on anything downstream of it:
  // filter hard while the brow is sitting still, let go the moment it moves,
  // so a held expression is steady and the onset of one is not late. It runs
  // before the pose correction and before either mapping, so everything under
  // it - the recorded span, the ladder, the thresholds, the readout - sees the
  // same quieter signal, and the calibration records against exactly what
  // tracking will read.
  //
  // Its own constants, not the motion filter's: those are tuned in radians of
  // head rotation per second, and this is a ratio that swings by hundredths.
  // Swept against the two things they trade between, on a synthetic face with
  // a pixel of landmark jitter on it: at these values a pixel of jitter is
  // 0.10 of a furrow where unfiltered it is 0.29, and a furrow arrives in six
  // frames - about 200ms, against an `emotionHold` of 100. Opening beta right
  // up buys two frames and gives back most of the noise; closing it to a plain
  // low-pass halves the noise again and costs two thirds of a second.
  var BROW_MIN_CUTOFF = 1;     // Hz a motionless brow is filtered at
  var BROW_BETA = 4;           // how fast that opens up, per brow unit/s
  var browFilt = { v: null, dv: 0, at: 0 };

  function resetBrowFilter() { browFilt.v = null; browFilt.dv = 0; browFilt.at = 0; }

  function filterBrow(raw) {
    if (!isNum(raw)) return raw;
    var t = now();
    if (browFilt.v === null) {
      browFilt.v = raw;
      browFilt.at = t;
      return raw;
    }
    var dt = (t - browFilt.at) / 1000;
    browFilt.at = t;
    if (!(dt > 0)) return browFilt.v;
    // A stalled tab or a dropped inference is not a fast brow. Clamp the gap
    // rather than trust it, or one long frame opens the cutoff all the way and
    // lets that frame's noise straight through.
    dt = Math.min(dt, 0.2);
    // The derivative gets its own fixed low-pass, as one-euro specifies. An
    // unfiltered one is noise deciding how much noise to let through.
    var ad = dt / (1 / (2 * Math.PI) + dt);
    browFilt.dv += ((raw - browFilt.v) / dt - browFilt.dv) * ad;
    var fc = BROW_MIN_CUTOFF + BROW_BETA * Math.abs(browFilt.dv);
    var a = dt / (1 / (2 * Math.PI * fc) + dt);
    browFilt.v += (raw - browFilt.v) * clamp(a, 0, 1);
    return browFilt.v;
  }

  // ------------------------------------------------ learned pose brow rest
  //
  // The four recorded poses are ground truth, but they are four points on two
  // axes, taken at whatever angle the person turned that day - and they only
  // exist once the wizard has been run. The default signal mode is `auto`,
  // where nothing corrects the pose at all, which is where "looking aside
  // reads as angry" comes from. The drift is real at every angle between the
  // recordings too, on the roll axis nothing records, and past the angle that
  // was recorded.
  //
  // So the rest value is also learned while tracking: a ladder of cells along
  // each head axis, each creeping toward the brow seen at that angle while the
  // brow is not doing anything. That is the same bet `normalize` already makes
  // about a resting value, made per pose instead of once. It rides on top of
  // the recordings rather than replacing them - with a good `browAt` there is
  // little left for it to learn, and it converges on nothing.
  //
  // The centre cell is never learned: it is the baseline the others are
  // measured against, and letting both move leaves them chasing each other.
  var POSE_AXES = ['y', 'x', 'z'];
  var POSE_CELLS = 9;                 // cells per axis
  var POSE_CELL = 0.18;               // ~10 degrees of head rotation each
  var POSE_MID = (POSE_CELLS - 1) / 2;
  var POSE_WARM = 20;                 // frames before a cell is believed in full
  // The long-run pull, once `1 / n` has fallen below it. It is the rate at
  // which a cell that already has an opinion changes its mind, and at 0.01 it
  // was fast enough to change it about an expression: a face held at an
  // off-centre pose for a few seconds was partly adopted as that pose's
  // neutral, and the expression faded while it was still being pulled. That is
  // "it will not hold an expression". It only binds after ~400 frames, well
  // past `POSE_WARM`, so a new cell still arrives within a second of the head
  // turning that way - nothing about cold cells changes.
  var POSE_CREEP = 0.0025;            // per-frame pull once it is warm
  var POSE_SEED = 2;                  // how far a warm cell may be extrapolated
                                      //   outward to seed a colder one

  function poseLadder() {
    var l = {};
    for (var i = 0; i < POSE_AXES.length; i++) {
      var off = [], n = [];
      for (var j = 0; j < POSE_CELLS; j++) { off.push(0); n.push(0); }
      l[POSE_AXES[i]] = { off: off, n: n };
    }
    return l;
  }

  var browPose = poseLadder();

  function poseCell(v) {
    return clamp(v / POSE_CELL + POSE_MID, 0, POSE_CELLS - 1);
  }

  function cellWarm(a, i) {
    return Math.min(1, a.n[i] / POSE_WARM);
  }

  // A cold cell used to contribute a plain zero, and a zero is not "no
  // opinion" here - it is the opinion that this angle has no drift, which is
  // the very thing that was wrong before any of this existed. Blended in by
  // distance alone it dragged the correction back toward nothing at exactly
  // the angles nobody had held yet. That is the "only sometimes": move to a
  // cell that has not warmed and the correction quietly switches off.
  //
  // So weight the two cells by how warm they are as well as how near, and
  // carry the better of the two confidences out with the answer. A cell with
  // nothing in it now defers to its neighbour instead of outvoting it.
  function ladderAt(a, f) {
    var i = Math.floor(f), t = f - i;
    if (i >= POSE_CELLS - 1) { i = POSE_CELLS - 1; t = 0; }
    var w0 = cellWarm(a, i), w1 = t > 0 ? cellWarm(a, i + 1) : 0;
    var k0 = w0 * (1 - t), k1 = w1 * t;
    var sum = k0 + k1;
    if (sum <= 1e-6) return 0;
    var v = (a.off[i] * k0 + (t > 0 ? a.off[i + 1] * k1 : 0)) / sum;
    return v * Math.max(w0, w1);
  }

  // How much of this pose the ladder has actually seen. An axis on its centre
  // cell needs no correction and no confidence in one - the baseline is its
  // answer - so it does not count against this.
  function ladderConf(a, f) {
    var i = Math.floor(f), t = f - i;
    if (i >= POSE_CELLS - 1) { i = POSE_CELLS - 1; t = 0; }
    return Math.max(cellWarm(a, i), t > 0 ? cellWarm(a, i + 1) : 0);
  }

  // Set beside the shift it belongs to: 1 where every off-centre axis is warm,
  // 0 at a pose nothing has been learned at yet.
  var poseConf = 1;

  function learnedBrowShift(rig) {
    var h = rig && rig.head;
    poseConf = 1;
    if (!h) return 0;
    var sum = 0;
    for (var i = 0; i < POSE_AXES.length; i++) {
      var k = POSE_AXES[i], a = browPose[k];
      var f = poseCell(num(h[k]));
      sum += ladderAt(a, f);
      if (Math.abs(f - POSE_MID) > 0.5) poseConf = Math.min(poseConf, ladderConf(a, f));
    }
    return sum;
  }

  // A cell nobody has held yet starts at whatever the warm cells on its own
  // side of centre imply for that angle, not at zero. Zero is the answer that
  // was wrong to begin with, so starting there means every new angle shows the
  // fault once before it learns its way out of it - and the angles people
  // reach for least are the ones that stayed cold longest.
  //
  // Straight line in the angle: the same shape the recorded poses are already
  // interpolated along.
  function seedCell(a, c) {
    if (a.n[c] > 0) return;
    var d = c - POSE_MID;
    if (!d) return;
    var toward = d > 0 ? -1 : 1;
    for (var w = c + toward; w >= 0 && w < POSE_CELLS; w += toward) {
      var wd = w - POSE_MID;
      if (!wd || a.n[w] < POSE_WARM) continue;
      a.off[c] = clamp(a.off[w] * clamp(d / wd, -POSE_SEED, POSE_SEED),
        -POSE_MAX, POSE_MAX);
      return;
    }
  }

  // `target` is the whole drift this pose shows - raw minus the rest the
  // recordings alone would give.
  //
  // A cell learns the *median* of that - a step toward each sample rather than
  // an average of them - and nothing gates which frames it may read. A "only
  // while the brow is quiet" gate is what `normalize` uses for the one global
  // baseline, and it cannot work per pose: until a cell has learned anything,
  // the drift is exactly what makes the frame look un-quiet, so the cell that
  // most needs the sample is the one that refuses it, and a cell that ever
  // learned a wrong value would go on refusing every frame that could correct
  // it. The median needs no gate - the drift is on every frame at that pose
  // and an expression is only on some of them, so the middle is the drift.
  var POSE_MAX = 0.5;                 // the scalar swings in hundredths; this
                                      // is only here so nothing can run away
  // Made once and written over: this runs on every solved face for the life of
  // the session, the same reason `armDbg` holds raw numbers.
  var poseShare = { y: 0, x: 0, z: 0 };

  // `have` is what the ladder is already saying at this pose. The step is the
  // whole ladder moving toward the drift the pose is showing, split between
  // the axes that are away from centre in proportion to how far each has gone.
  //
  // The rule this replaced made an axis wait until the other two were near
  // centre, so that no two ladders could learn the same drift twice. A head
  // that turns and dips at once - which is most of the ways a head moves -
  // taught neither of them, and the angles nobody holds squarely on one axis
  // stayed uncorrected. That is the other half of "only sometimes". Sharing
  // one step between them settles the double-counting without ever refusing
  // the sample.
  function learnBrowPose(rig, target, have, span) {
    var h = rig && rig.head;
    if (!h || faceOcc || !isNum(target) || !isNum(have)) return;
    var i, k, f, total = 0;
    for (i = 0; i < POSE_AXES.length; i++) {
      k = POSE_AXES[i];
      // An axis on its centre cell has no offset to learn - the baseline is
      // its answer - so it takes no share and cannot be taught somebody
      // else's drift.
      f = Math.abs(poseCell(num(h[k])) - POSE_MID);
      poseShare[k] = f > 0.5 ? f : 0;
      total += poseShare[k];
    }
    if (total <= 0) return;
    var dir = target > have ? 1 : -1;
    var reach = Math.max(span, BROW_SPAN_MIN);
    // A frame far from what this pose already reads as rest is more likely an
    // expression than a correction, so it is worth less - but it is never
    // worth nothing. A hard "only while the brow is quiet" gate deadlocks: a
    // cell that has learned a wrong value would refuse every frame that could
    // put it right, and a cold cell refuses the very drift it exists to learn.
    // Slowing those frames down keeps the median honest at a pose somebody
    // spends holding a face, without ever closing the door on one.
    var quiet = clamp(1.2 - Math.abs(target - have) / reach, 0.05, 1);
    reach *= quiet;
    for (i = 0; i < POSE_AXES.length; i++) {
      k = POSE_AXES[i];
      if (!poseShare[k]) continue;
      var a = browPose[k];
      var c = Math.round(poseCell(num(h[k])));
      if (c === POSE_MID) continue;
      seedCell(a, c);
      a.n[c]++;
      // a big step while the cell is new, so it arrives within a second of
      // looking that way, and a small one once it has an opinion worth keeping
      var step = reach * Math.max(POSE_CREEP, 1 / a.n[c]) * (poseShare[k] / total);
      a.off[c] = clamp(a.off[c] + dir * step, -POSE_MAX, POSE_MAX);
    }
  }

  // The auto tracker's own baseline is the centre-pose rest, so that is what
  // the ladder measures against there. Returns it for the readout.
  function learnAutoBrow(rig, adj, learned) {
    if (browTrack.base === null) return null;
    learnBrowPose(rig, adj + learned - browTrack.base, learned, browTrack.span);
    return browTrack.base;
  }

  // What each ladder has learned, in raw brow units per cell, centre cell
  // first neighbour out. Reasoning about this from the code is guesswork -
  // watch the numbers while turning the head instead.
  function browRestInfo() {
    var out = {
      conf: r2(poseConf),
      src: BROW_SRC,
      // what each way of reading the mesh last said. Turn the head with a
      // relaxed face: `side` should sit still, `flat` is the one that walks.
      side: browRead.side == null ? null : +browRead.side.toFixed(4),
      flat: browRead.flat == null ? null : +browRead.flat.toFixed(4)
    };
    for (var i = 0; i < POSE_AXES.length; i++) {
      var k = POSE_AXES[i], a = browPose[k], cells = [];
      for (var j = 0; j < POSE_CELLS; j++) {
        cells.push({
          at: +(((j - POSE_MID) * POSE_CELL).toFixed(2)),
          shift: +(a.off[j].toFixed(4)),
          warm: +(cellWarm(a, j).toFixed(2)),
          n: a.n[j]
        });
      }
      out[k] = cells;
    }
    return out;
  }

  // `Set neutral now` and `Reset auto range` stood here. Both existed because
  // the brow's zero used to wander: the old scalar was a ratio measured across
  // the eye while its numerator ran down the face, so it moved whenever the
  // head did, and a person needed a way to say "no, *this* is my resting
  // brow". Measuring against the side of the face removed the wander, and the
  // pose ladder relearns whatever is left on its own.
  //
  // What is left of each is already reachable and better named: `Brow offset`
  // is the same shift by hand, against a zero that now stays put, and
  // `resetCalibration()` still runs from `Reset PSX settings`, from the end of
  // a wizard, and from `PSX.resetCalibration()` in the console.
  //
  // ------------------------------------------------------------ eye mapping
  //
  // The tracker reports how open each eye is; this maps that onto 0..1 for the
  // blink cell. Both ends are settings rather than a recorded pair gated on
  // `signal`, because an eyelid has nothing to do with which brow mapping is
  // in force - tying the two together meant a blink calibration did nothing at
  // all until the brow happened to be calibrated too.
  //
  // The defaults, 0 and 1, are the identity map: exactly what an uncalibrated
  // profile did before. Calibrating writes them; the two sliders are the same
  // numbers by hand.
  // Where the line sits this frame: the setting, raised by whatever the furrow
  // accounts for, and lowered by the release margin once the eye is already
  // shut. That margin is the same `hysteresis` the cells use and is here for
  // the same reason - a reading sitting exactly on the line would otherwise
  // flip every frame.
  function eyeBar(lift, wasShut) {
    var at = cfg.eyeShutAt + (lift > 0 ? lift : 0);
    if (wasShut) at -= cfg.hysteresis;
    return clamp(at, 0.02, 0.995);
  }

  // 0 or 1. A blink on a texture atlas is not a quantity - the cell is either
  // the shut one or it is not - so there is nothing for a value in between to
  // mean, and every consumer downstream was thresholding it anyway.
  function eyeShut(closedness, lift, wasShut) {
    return closedness >= eyeBar(lift, wasShut) ? 1 : 0;
  }

  // ------------------------------------------- furrow / blink decoupling
  //
  // Furrowing your brows narrows your eyes. That is anatomy, not a tracking
  // fault: the same muscles that pull the brow down pull the lid up, so the
  // closedness the tracker reports genuinely rises when you pull an angry
  // face. Nothing downstream can tell that rise apart from the start of a
  // blink, and on a texture atlas the two cells cannot both show - so an angry
  // face sat there blinking at itself.
  //
  // `eyeFurrowLift` is how much further a fully furrowed eye reads than a
  // relaxed one, measured by the wizard. Scaled here by how far into a furrow
  // this frame is - a half furrow raises the line half as far, a raised brow
  // does not raise it at all.
  //
  // Read off the previous frame's brow, which is one inference behind. The
  // brow is one-euro filtered and a furrow takes a couple of hundred
  // milliseconds to arrive, so a frame of lag on the correction is well inside
  // the thing being corrected.
  function furrowLift() {
    if (!(cfg.eyeFurrowLift > 0)) return 0;
    if (!lastFace || !isNum(lastFace.brow)) return 0;
    return cfg.eyeFurrowLift * clamp(-lastFace.brow, 0, 1);
  }

  // How much further the brow has to travel before angry or sorrow is claimed
  // at a pose the ladder has not learned yet. The zero under the brow is a
  // guess there, and a guess is not something to call an expression from -
  // but a real furrow still gets there, it just has to be a real one.
  var BLIND_LIFT = 0.3;

  // How loud a vowel has to be before the mouth is treated as talking, and the
  // emotions sharing its texture stand down for it. The alternative - an
  // emotion pinning the face while the lip sync runs underneath it, invisible -
  // is not something anyone would choose, so this is a constant rather than a
  // switch and a slider.
  var SPEECH_AT = 0.2;

  var emoSince = { angry: 0, sorrow: 0 };

  // Only the rise is held. On an atlas the cell snaps, so a single bad frame
  // is a visible change of face - the same reason the UV latch has `holdMs`.
  function heldEmotion(key, v, t) {
    if (v <= 0) { emoSince[key] = 0; return 0; }
    if (!emoSince[key]) emoSince[key] = t;
    return (t - emoSince[key]) >= cfg.emotionHold ? v : 0;
  }

  function driveEmotions(vrm, rig, rawBrow, rawSmile) {
    var proxy = vrm && vrm.blendShapeProxy;
    if (!proxy || !rig) return;
    if (faceOcc && lastFace) {
      for (var ei = 0; ei < EMOTION_KEYS.length; ei++) {
        try { proxy.setValue(EMOTION_KEYS[ei], lastFace.out[EMOTION_KEYS[ei]]); } catch (e) {}
      }
      paintReadout();
      return;
    }

    // a recorded calibration is the best mapping, but fall back rather than
    // going dead if the mode is selected before it has been run
    var mode = cfg.signal;
    if (mode === 'calibrated' && !cfg.cal) mode = 'auto';

    var brow, smile;
    // Pose rest is subtracted before either mapping, so a yaw that the
    // tracker reports as a brow does not spend the span or trip angry/sorrow.
    // The recordings correct the poses they were taken at; the ladder corrects
    // whatever is left, at every other angle and on the axis nothing records.
    // Raw mode is the unmapped scalar on purpose, and teaches the ladder
    // nothing - there is no rest to measure a drift against.
    var learned = (mode === 'raw' || !cfg.poseFix) ? 0 : learnedBrowShift(rig);
    if (!cfg.poseFix) poseConf = 1;
    var adjBrow = poseAdjustedBrow(rawBrow, rig) - learned;
    var restNow = null;
    var fixedZero = mode === 'calibrated' && browCalUsable(cfg.cal);
    if (fixedZero) {
      restNow = poseBrowRest(cfg.cal, rig);
      var dev = rawBrow - learned - restNow;
      var span = poseBrowSpan(cfg.cal, rig, dev);
      learnBrowPose(rig, rawBrow - restNow, learned, span);
      brow = calNorm(dev, span);
      smile = clamp(calibratedSmile(rawSmile) * cfg.browGain, 0, 1);
    } else if (mode === 'calibrated') {
      // Old saves used Kalidokit's 0..1 brow, so furrow sat on rest. Use auto
      // for the brow until they recapture; smile still uses the recording.
      restNow = learnAutoBrow(rig, adjBrow, learned);
      brow = normalize(browTrack, adjBrow, 0.01);
      smile = clamp(calibratedSmile(rawSmile) * cfg.browGain, 0, 1);
    } else if (mode === 'auto') {
      restNow = learnAutoBrow(rig, adjBrow, learned);
      brow = normalize(browTrack, adjBrow, 0.01);
      // a smile only ever opens the mouth wider than rest, so the closing half
      // of the range is not a smile
      smile = clamp(normalize(smileTrack, rawSmile, 0.02) * cfg.browGain, 0, 1);
    } else {
      brow = rawBrow;
      // the same normalisation the app uses: 0.4 -> 0.9 maps to 0 -> 1
      smile = clamp((rawSmile - 0.4) / 0.5, 0, 1);
    }

    // What the signal says before the offset, unclamped, which is what the
    // "Set neutral" button has to cancel.
    var browPre = brow;
    brow = clamp((brow + cfg.browBias) * cfg.browGain, -1, 1);

    var lift = mode === 'raw' ? 0 : (1 - poseConf) * BLIND_LIFT;
    var emoAt = now();
    var out = {
      angry: heldEmotion('angry', ramp(-brow, Math.min(0.95, cfg.angryAt + lift)), emoAt),
      sorrow: heldEmotion('sorrow', ramp(brow, Math.min(0.95, cfg.sorrowAt + lift)), emoAt),
      fun: 0,
      joy: 0
    };
    var sm = ramp(smile, cfg.smileAt);
    // The mouth classifier was recorded on this person's own grin, so it is a
    // better smile detector than a threshold on mouth width - and it is the
    // only one of the two that can tell a grin from an "ee", which are the same
    // width. It has already ruled out every vowel by the time it says so, so it
    // goes in past the threshold rather than through it.
    if (mouthSays > 0) sm = Math.max(sm, mouthSays);
    // Write whichever smile preset the loaded model actually has. No picker:
    // a fun cell, a joy cell, or both. With neither listed, write both so a
    // morph-only group can still fire.
    var keys = expressionKeys();
    var hasFun = !keys.length || keys.indexOf('fun') !== -1;
    var hasJoy = !keys.length || keys.indexOf('joy') !== -1;
    if (hasFun) out.fun = sm;
    if (hasJoy) out.joy = sm;

    // A furrowed brow over a wide mouth reads as neither. On a PSX atlas these
    // are whole-face swaps, so blending two of them lands between cells - only
    // the loudest one gets to speak. There is no blending to fall back to on a
    // face made of texture cells, so this is not a choice anyone has to make.
    var top = null;
    for (var i = 0; i < EMOTION_KEYS.length; i++) {
      var k = EMOTION_KEYS[i];
      if (out[k] > 0 && (!top || out[k] > out[top])) top = k;
    }
    for (var j = 0; j < EMOTION_KEYS.length; j++) {
      if (EMOTION_KEYS[j] !== top) out[EMOTION_KEYS[j]] = 0;
    }

    // Vowels and a smile on the *same* atlas cell cannot both show. Angry
    // brows often live on another material, so talking must not wipe them -
    // that looked like "one emotion at a time" even with exclusive off.
    // Only stand down an emotion that actually shares a mouth texture.
    var smiling = sm > 0;
    var articulating = lastViseme.key && lastViseme.w >= 0.15 && lastViseme.key !== 'a';
    var talking = mouthLevel(proxy, smiling) >= SPEECH_AT || articulating;
    if (talking) {
      for (var q = 0; q < EMOTION_KEYS.length; q++) {
        if (emotionFightsMouth(EMOTION_KEYS[q])) out[EMOTION_KEYS[q]] = 0;
      }
    }

    lastFace = {
      brow: brow, pre: browPre, adj: adjBrow, fixed: fixedZero,
      smile: smile, out: out,
      raw: { brow: rawBrow, smile: rawSmile },
      poseRest: restNow === null ? null : restNow + learned
    };
    paintReadout();

    // Write all four, including the ones we resolved to 0. The app writes Joy
    // itself from "Smile Detection [Beta]", and leaving that in place would let
    // a stale Joy outvote an exclusive pick - so while this is on, the emotion
    // presets belong to us. Joy still gets the smile weight when the model
    // has that cell, which is the stock behaviour with a threshold we tune.
    for (var n = 0; n < EMOTION_KEYS.length; n++) {
      try { proxy.setValue(EMOTION_KEYS[n], out[EMOTION_KEYS[n]]); } catch (e) {}
    }
  }

  // Kalidokit reports 1 = open. A wink or a blink both have to close the one
  // atlas cell, so take the more-closed eye. When a guided calibration exists,
  // map through the open-floor / closed-peak recorded across head poses, or
  // looking down reads as a blink and a blink while turned never clears.
  var heldBlink = null;

  function driveBlink(vrm, rig) {
    var proxy = vrm && vrm.blendShapeProxy;
    var eye = rig && rig.eye;
    if (!proxy || !eye) return;
    if (!isNum(eye.l) && !isNum(eye.r)) return;
    var rawL = isNum(eye.l) ? clamp(1 - eye.l, 0, 1) : 0;
    var rawR = isNum(eye.r) ? clamp(1 - eye.r, 0, 1) : 0;
    if (!isNum(eye.l)) rawL = rawR;
    if (!isNum(eye.r)) rawR = rawL;
    var lift = furrowLift();
    // Each lid keeps its own latch, or a wink would drag the other eye's
    // release margin around with it.
    var l = eyeShut(rawL, lift, shutL);
    var r = eyeShut(rawR, lift, shutR);
    shutL = !!l;
    shutR = !!r;
    // What the slider is set against: the tracker's own reading, before the
    // line. Setting it by eye is impossible without this on screen.
    lastEyeRaw = rawL > rawR ? rawL : rawR;
    lastEyeBar = eyeBar(lift, shutL || shutR);
    // A palm over an eye reads as that lid shutting. Hold the last open/shut
    // the mesh reported while it could still see the face.
    if (faceOcc && heldBlink) {
      l = heldBlink.l;
      r = heldBlink.r;
    } else {
      heldBlink = { l: l, r: r };
    }
    var blink = l > r ? l : r;
    lastBlink = blink;
    paintReadout();
    try { proxy.setValue('blink', blink); } catch (e) {}
    try { proxy.setValue('blink_l', l); } catch (e) {}
    try { proxy.setValue('blink_r', r); } catch (e) {}
  }

  // The vowels the app writes are the only speech signal we get; take the
  // loudest of them as "is this face talking right now". A toothy smile is
  // skipped down to U/O - A/I/E are how a grin looks to the viseme solver.
  function mouthLevel(proxy, smiling) {
    var keys = smiling ? SPEECH_OVER_SMILE : MOUTH_KEYS;
    var top = 0;
    for (var k in keys) {
      var w = 0;
      try { w = proxy.getValue(k) || 0; } catch (e) { w = 0; }
      if (w > top) top = w;
    }
    return top;
  }

  function clearVowels(proxy) {
    for (var k in MOUTH_KEYS) {
      try { proxy.setValue(k, 0); } catch (e) {}
    }
  }

  // ------------------------------------------------------------- visemes
  //
  // Kalidokit's A/I/U/E/O all rise together with the jaw, so A almost always
  // outranks the rest and the atlas snaps to that one cell - which is why they
  // were abandoned for a formula over width (mouth.x) and openness (mouth.y).
  // But a formula has the same problem in a different place: its constants are
  // one person's mouth, and on anyone else's face two vowels land on the same
  // cell and the mouth only ever has one open shape.
  //
  // So record the person's own vowels instead. Each recorded pose is a point in
  // the feature space below, and a live frame is whichever recorded pose it
  // lands nearest. That works on the shape weights precisely because it never
  // compares them to each other - only to what they read while this person said
  // that vowel.

  function mouthFeature(rig) {
    var m = rig && rig.mouth;
    if (!m) return null;
    var sh = m.shape || {};
    return [
      clamp(num(m.x), 0, 1), clamp(num(m.y), 0, 1),
      clamp(num(sh.A), 0, 1), clamp(num(sh.I), 0, 1), clamp(num(sh.U), 0, 1),
      clamp(num(sh.E), 0, 1), clamp(num(sh.O), 0, 1)
    ];
  }

  function mouthCalUsable(m) {
    if (!m || !m.rest) return false;
    for (var i = 0; i < VOWELS.length; i++) if (!m[VOWELS[i]]) return false;
    return true;
  }

  // `smile` is optional: a calibration recorded before that step existed is
  // still a usable one, it just cannot tell a grin from an "ee".
  function mouthProtos(m) {
    var keys = ['rest'].concat(VOWELS);
    if (m.smile) keys.push('smile');
    return keys;
  }

  // A dimension that reads the same for every recorded pose says nothing about
  // which one this is; one that swings right across them says a lot. Weighting
  // by the swing is what keeps the shape weights - which all sit in a narrow
  // band - from being drowned out by mouth.y, and vice versa.
  function mouthWeights(m) {
    var keys = mouthProtos(m);
    var w = [];
    for (var d = 0; d < MOUTH_DIMS; d++) {
      var lo = Infinity, hi = -Infinity;
      for (var k = 0; k < keys.length; k++) {
        var v = m[keys[k]][d];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      w.push(1 / Math.max(hi - lo, 0.02));
    }
    return w;
  }

  function mouthDist(f, proto, w) {
    var d = 0;
    for (var i = 0; i < MOUTH_DIMS; i++) {
      var e = (f[i] - proto[i]) * w[i];
      d += e * e;
    }
    return d;
  }

  // Nearest recorded pose, with the runner-up's distance so the caller can see
  // how close the call was. `rest` is one of the candidates, which is what
  // decides that the mouth is doing nothing - no threshold to guess at.
  function classifyMouth(f) {
    var m = cfg.mouth;
    var w = mouthWeights(m);
    var keys = mouthProtos(m);
    var best = null, bestD = Infinity, second = Infinity;
    for (var k = 0; k < keys.length; k++) {
      var d = mouthDist(f, m[keys[k]], w);
      if (d < bestD) { second = bestD; bestD = d; best = keys[k]; }
      else if (d < second) second = d;
    }
    // Sticky: an atlas cell is a whole-mouth swap, so two vowels trading the
    // lead frame by frame reads as a flicker rather than as speech. The one
    // already showing keeps it unless something is clearly closer.
    if (lastViseme.key && lastViseme.key !== best && m[lastViseme.key]) {
      var held = mouthDist(f, m[lastViseme.key], w);
      if (held <= bestD * (1 + cfg.mouthStick)) {
        second = bestD;
        bestD = held;
        best = lastViseme.key;
      }
    }
    return { key: best, d: bestD, margin: Math.max(second - bestD, 0) };
  }

  function driveVisemes(vrm, rig) {
    var proxy = vrm && vrm.blendShapeProxy;
    var mouth = rig && rig.mouth;
    if (!proxy || !mouth) return;
    var k;
    if (faceOcc) {
      if (lastViseme.key) {
        for (k in MOUTH_KEYS) {
          try { proxy.setValue(k, k === lastViseme.key ? lastViseme.w : 0); } catch (err) {}
        }
      } else {
        clearVowels(proxy);
      }
      return;
    }

    if (mouthCalUsable(cfg.mouth)) {
      var f = mouthFeature(rig);
      var got = f && classifyMouth(f);
      // How far clear of the runner-up it is, as a 0..1 weight. The cell is
      // exclusive, so this does not blend anything - it is what the emotion
      // arbitration reads as "how sure are we that this face is talking".
      var conf = got ? clamp(got.margin / Math.max(got.d + got.margin, 1e-6), 0, 1) : 0;
      // A grin is nearer the recorded grin than any vowel, so the mouth is not
      // talking and the cell belongs to the emotion. Saying so here is what
      // stops a toothy smile from being read as speech, which no threshold on
      // mouth width could do - a grin and an "ee" are the same width.
      mouthSays = (got && got.key === 'smile') ? conf : 0;
      if (!got || got.key === 'rest' || got.key === 'smile') {
        lastViseme = { key: null, w: 0 };
        clearVowels(proxy);
        return;
      }
      lastViseme = { key: got.key, w: Math.max(conf, 0.55) };
      for (k in MOUTH_KEYS) {
        try { proxy.setValue(k, k === got.key ? lastViseme.w : 0); } catch (err) {}
      }
      return;
    }

    mouthSays = 0;
    var x = clamp(num(mouth.x), 0, 1);
    var y = clamp(num(mouth.y), 0, 1);
    var sh = mouth.shape || {};
    var shMax = 0;
    var names = ['A', 'I', 'U', 'E', 'O'];
    for (var n = 0; n < names.length; n++) {
      var sv = clamp(num(sh[names[n]]), 0, 1);
      if (sv > shMax) shMax = sv;
    }

    // A closed mouth still has width, and width alone used to be enough to keep
    // a vowel lit - so the mouth cell was never free and a smile could not show
    // on it. Openness is what says the mouth is doing something at all.
    if (y < 0.12 && shMax < 0.2) {
      lastViseme = { key: null, w: 0 };
      clearVowels(proxy);
      return;
    }

    var vis = {
      a: y * (1 - clamp((x - 0.22) / 0.75, 0, 1)),
      i: x * (1 - y * 0.72),
      u: (1 - x) * y,
      e: x * y * (1 - y) * 1.6,
      o: y * clamp(1 - Math.abs(x - 0.34) * 2.2, 0, 1)
    };
    var topK = null, topW = 0;
    for (k in vis) {
      vis[k] = clamp(vis[k], 0, 1);
      if (vis[k] > topW) { topW = vis[k]; topK = k; }
    }
    if (topW < 0.1) {
      lastViseme = { key: null, w: 0 };
      clearVowels(proxy);
      return;
    }
    lastViseme = { key: topK, w: topW };
    for (k in vis) {
      var w = k === topK ? Math.max(topW, 0.55) : vis[k] * 0.15;
      try { proxy.setValue(k, w); } catch (err) {}
    }
  }

  // True when this emotion's atlas cell sits on a material that also has
  // vowel cells. Morph-only groups and brow-only textures return false, so
  // a held angry brow can stay up while the mouth talks.
  function emotionFightsMouth(key) {
    for (var i = 0; i < models.length; i++) {
      var binds = models[i].__psxUvBinds;
      if (!binds) continue;
      for (var b = 0; b < binds.length; b++) {
        var cells = binds[b].cells;
        var mouth = false, emo = false;
        for (var c = 0; c < cells.length; c++) {
          var ck = cells[c].key;
          if (MOUTH_KEYS[ck]) mouth = true;
          if (ck === key) emo = true;
        }
        if (mouth && emo) return true;
      }
    }
    return false;
  }

  // ----------------------------------------------------------- motion gains
  //
  // The neck rig multiplies the solved head rotation by 1 and the chest/spine
  // rig by 0.05, both hardcoded, then lerps toward the result at 0.04 + dt*4
  // (neck) or 0.04 + dt*2 (torso). A small real movement therefore lands as a
  // large avatar movement, with nothing to tune. These hooks put a gain and a
  // damping factor in front of both.

  // The gains default to their stock values, so there is nothing for a master
  // switch to turn off: it only ever meant "ignore what the calibration just
  // measured", which is not a state to leave anyone in.
  function headGain() { return cfg.headGain; }
  function bodyGain() { return cfg.bodyGain; }
  function leanGain() { return cfg.leanGain; }
  function armGain() { return cfg.armGain; }

  // The pose solver reports head roll as a torso lean. Subtract only the
  // component that agrees with the head, and never reverse past zero - a
  // frame where the shoulders did not follow would otherwise invent a lean
  // the other way. Off / uncalibrated is identity, which is stock.
  function spineLean(z, headZ) {
    z = num(z);
    if (!(cfg.leanHead > 0)) return z;
    var couple = cfg.leanHead * num(headZ);
    if (couple * z <= 0) return z;
    if (Math.abs(couple) >= Math.abs(z)) return 0;
    return z - couple;
  }

  function boneNode(vrm, name) {
    var h = vrm && vrm.humanoid;
    if (!h || !h.getBoneNode) return null;
    var n = h.getBoneNode(name);
    if (n) return n;
    var alt = name.charAt(0).toLowerCase() + name.slice(1);
    return alt === name ? null : h.getBoneNode(alt);
  }

  function worldPos(bone) {
    if (!bone || !bone.matrixWorld) return null;
    bone.updateWorldMatrix(true, false);
    var e = bone.matrixWorld.elements;
    return { x: e[12], y: e[13], z: e[14] };
  }

  function dist3(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function handHeadDist(vrm) {
    var head = boneNode(vrm, 'head');
    var rh = boneNode(vrm, 'rightHand');
    var lh = boneNode(vrm, 'leftHand');
    if (!head || !rh || !lh) return null;
    var hp = worldPos(head), rp = worldPos(rh), lp = worldPos(lh);
    if (!hp || !rp || !lp) return null;
    return (dist3(rp, hp) + dist3(lp, hp)) * 0.5;
  }

  function armLen(vrm, side) {
    var u = boneNode(vrm, side + 'UpperArm');
    var l = boneNode(vrm, side + 'LowerArm');
    var h = boneNode(vrm, side + 'Hand');
    if (!u || !l || !h) return 0;
    return dist3(worldPos(u), worldPos(l)) + dist3(worldPos(l), worldPos(h));
  }

  // How much short of a real T the model's hands are ending up, as a factor.
  // With the arms straight out the hands should sit one arm length past each
  // shoulder, and that whole span lies across the image where the tracker has
  // no depth to get wrong - so whatever is missing is Reach, not noise.
  function modelSpan(vrm) {
    var rh = boneNode(vrm, 'rightHand'), lh = boneNode(vrm, 'leftHand');
    if (!rh || !lh) return null;
    var c = vrm.__psxArm;
    if (!c || !c.ok) return null;
    var want = dist3(worldPos(c.ru), worldPos(c.lu)) +
      armLen(vrm, 'right') + armLen(vrm, 'left');
    var got = dist3(worldPos(rh), worldPos(lh));
    if (want < 1e-4 || got < 1e-4) return null;
    return want / got;
  }

  // Model-space readings, taken from the render tick because they need the
  // rig to have been written this frame.
  function sampleReach(vrm) {
    if (!calRun || calRun.kind !== 'motion' || calRun.phase !== 'hold') return;
    if (now() - calRun.holdFrom < CAL_SETTLE) return;
    var step = steps()[calRun.i];
    // the sweep is read off the landmarks, not off the rig - see sampleSweep
    if (step.fit) return;
    var key = step.key;
    if (key === 'tpose') {
      // `tpose` is set by the landmark sampler and only while the arms are
      // actually out, so a model-space span is never taken from a pose the
      // person did not make
      if (!calRun.tpose) return;
      var r = modelSpan(vrm);
      if (r != null && isFinite(r)) calRun.acc.span.push(r);
      return;
    }
    if (key !== 'rest' && key !== 'hands') return;
    var d = handHeadDist(vrm);
    if (d == null || !isFinite(d)) return;
    calRun.acc.reach.push(d);
  }

  // With one arm straight out toward the lens, the wrist offset should be as
  // long as the arm is. Its across and up components are read straight off the
  // image and are sound; whatever length is left over has to be depth, so
  // comparing that against the depth Mediapipe actually reported measures how
  // far its depth estimate is compressed. That is exactly what `armDepth`
  // corrects, and it is the one gain in the retarget nothing ever measured.
  // The arm length has to come from a pose where the arm lay across the image,
  // not from this one. Depth is what the tracker compresses, so an arm pointing
  // at the lens has its whole length compressed by the same factor being
  // measured - reading it here would divide the error by itself and report a
  // gain of 1 no matter how bad the camera is. `userArm` is the span step's
  // reading, taken with the arms straight out where nothing is foreshortened.
  function depthRatio(world, userArm) {
    if (!isNum(userArm) || userArm < 1e-4) return 0;
    var shR = world[ARM_LM.Right.shoulder], shL = world[ARM_LM.Left.shoulder];
    if (!vis(shR) || !vis(shL)) return 0;
    var ub = torsoBasis(shR, shL,
      vmid(world[ARM_LM.Right.hip], world[ARM_LM.Left.hip]),
      vsub(world[LM_NOSE], vmid(shR, shL)));
    if (!ub) return 0;
    var best = 0;
    for (var side in ARM_LM) {
      var idx = ARM_LM[side];
      var sh = world[idx.shoulder], el = world[idx.elbow], wr = world[idx.wrist];
      if (!vis(sh) || !vis(el) || !vis(wr)) continue;
      var d = vsub(wr, sh);
      var dx = vdot(d, ub.x), dy = vdot(d, ub.y), dz = vdot(d, ub.z);
      var plane = dx * dx + dy * dy;
      // Only an arm that really is aimed at the lens says anything about depth.
      // Half the arm's length still in the image plane means most of what is
      // left is the reading's own error, and dividing by it produces a gain
      // that can flatten the depth axis to nothing - which would cost the model
      // every gesture toward the camera, hand to mouth included.
      if (plane > userArm * userArm * 0.5) continue;
      var want = userArm * userArm - plane;
      if (want <= 0 || Math.abs(dz) < 1e-4) continue;
      var r = Math.sqrt(want) / Math.abs(dz);
      if (r > best) best = r;
    }
    return best;
  }

  // Landmark-space readings. Taken once per holistic result rather than once
  // per rendered frame: the "hold still" step measures noise as the spread of
  // its samples, and re-reading one inference over four frames would quarter
  // that spread and report a camera far calmer than it is.
  function sampleMotionLandmarks(world) {
    if (!calRun || calRun.kind !== 'motion' || calRun.phase !== 'hold') return;
    if (now() - calRun.holdFrom < CAL_SETTLE) return;
    var a = calRun.acc;
    var shR = world[ARM_LM.Right.shoulder], shL = world[ARM_LM.Left.shoulder];
    var hipR = world[ARM_LM.Right.hip], hipL = world[ARM_LM.Left.hip];
    if (!vis(shR) || !vis(shL) || !vis(hipR) || !vis(hipL)) return;
    var across = vsub(shL, shR);
    // how far off level the shoulder line sits - the same thing Kalidokit
    // reports as Spine.z, which is what the torso rig leans on
    a.roll.push(Math.atan2(across.y,
      Math.sqrt(across.x * across.x + across.z * across.z)));
    a.torso.push(vlen(vsub(vmid(shR, shL), vmid(hipR, hipL))));
    var ub = torsoBasis(shR, shL, vmid(hipR, hipL),
      vsub(world[LM_NOSE], vmid(shR, shL)));
    if (!ub) return;
    var key = steps()[calRun.i].key;
    if (key === 'tpose') {
      // Only read this if the arms really are out. Everything the step sets is
      // a factor between where the model's hands land and where a real T would
      // put them, so arms left hanging read as a model that cannot reach - and
      // Reach gets pushed up for a pose nobody made.
      var n = 0, sum = 0;
      for (var side in ARM_LM) {
        var idx = ARM_LM[side];
        var sh = world[idx.shoulder], el = world[idx.elbow], wr = world[idx.wrist];
        if (!vis(sh) || !vis(el) || !vis(wr)) return;
        var seg = dist3(sh, el) + dist3(el, wr);
        var d = vsub(wr, sh);
        var span = vlen(d);
        // Elbow straight, and the arm lying across the image rather than down it.
        //
        // The span this step reads is measured against the span the model would
        // have at full stretch, so every degree of elbow the person did not
        // straighten is read as reach the model is missing - and Reach only
        // ever multiplies, so that shortfall ratchets it to the ceiling over a
        // couple of runs and the straightening cap then irons every pose flat.
        // 0.85 admits an elbow bent 60 degrees, which asks for 18% more reach
        // on its own. Gate on the two segments being in line instead: it is the
        // same invariant the sweep uses, and unlike a distance it survives the
        // depth compression untouched.
        var uSeg = vnorm(vsub(el, sh)), lSeg = vnorm(vsub(wr, el));
        if (!uSeg || !lSeg || vdot(uSeg, lSeg) < 0.99) return;
        if (span < seg * 0.85 || Math.abs(vdot(d, ub.x)) < span * 0.8) return;
        sum += seg;
        n++;
      }
      if (n < 2) return;
      calRun.tpose = true;
      a.alen.push(sum / n);
    } else if (key === 'depth') {
      var r = depthRatio(world, calRun.out.userArm);
      if (r) a.depth.push(r);
    } else if (steps()[calRun.i].fit) {
      sampleSweep(world, ub, a.fit);
    }
  }

  // The depth pose generalised from one direction to all of them.
  //
  // `depthRatio` holds the arm at the lens and reads the compression once. That
  // is one direction, one reading, and it has to speak for every direction the
  // arm will ever point. This reads the same quantity continuously while the
  // arm sweeps the whole sphere, which is worth doing because the compression
  // is not one number - it varies across the frame - and a median over the
  // whole sweep is a far better single number than the one pose was.
  //
  // The ground truth is the locked elbow. A straight arm is exactly as long as
  // it is, whichever way it points, so `userArm` measured in the T-pose - where
  // nothing is foreshortened - says what the reading should have come to. What
  // the across and up components cannot account for has to be depth, and
  // comparing that against the depth actually reported is the compression.
  //
  // This is also why the fit cannot be run against the model instead. The
  // model's hand distance comes from the elbow bend, so it already agrees with
  // the person's in each one's own proportions - matching them measures
  // nothing, and would only ever drive the gains back to 1.
  function sampleSweep(world, ub, f) {
    var L = calRun.out.userArm;
    if (!isNum(L) || L < 1e-4) return;
    for (var side in ARM_LM) {
      var idx = ARM_LM[side];
      var sh = world[idx.shoulder], el = world[idx.elbow], wr = world[idx.wrist];
      if (!vis(sh) || !vis(el) || !vis(wr)) continue;
      var seg = dist3(sh, el) + dist3(el, wr);
      var d = vsub(wr, sh);
      // A bent elbow breaks the ground truth: the hand is nearer than the arm is
      // long, and every bit of that shortfall is read as depth that was never
      // there, straight into the gain.
      //
      // Gate on the two segments being in line rather than on the hand being
      // far enough away. Depth compression scales one axis, and a scaling maps
      // parallel vectors to parallel vectors - so collinearity survives it
      // exactly, while a distance does not survive it at all. The old distance
      // gate was measuring the arm with the very error being calibrated, and it
      // admitted an elbow bent 37 degrees, which inflates the ratio by a third.
      if (seg < 1e-4) continue;
      var uArm = vnorm(vsub(el, sh)), lArm = vnorm(vsub(wr, el));
      if (!uArm || !lArm || vdot(uArm, lArm) < 0.995) continue;
      var dx = vdot(d, ub.x), dy = vdot(d, ub.y), dz = vdot(d, ub.z);
      var plane = dx * dx + dy * dy;
      var want = L * L - plane;
      // Lying in the image plane there is no depth to compare against, and the
      // ratio would be the reading's own error divided by nearly nothing.
      if (want < L * L * 0.0625 || Math.abs(dz) < 1e-4) continue;
      var acc = f.side[side];
      var r = Math.sqrt(want) / Math.abs(dz);
      f.r.push(r);
      acc.r.push(r);
      // How long the arm comes out once the gain in force has been applied,
      // against how long it should be. This is the honest quality number: it
      // has a ground truth, and at the end of a good run it is near zero.
      var fixed = dz * cfg.armDepth;
      var e = Math.abs(Math.sqrt(plane + fixed * fixed) / L - 1);
      f.res.push(e);
      acc.res.push(e);
      f.n++;
    }
  }

  // -------------------------------------------------- adaptive smoothing
  //
  // A flat damping factor cannot win. Enough of it to settle the tremor of a
  // held pose turns a fast move to rubber, and enough responsiveness for the
  // fast move leaves the tremor in - which is the whole of the "jelly" feel.
  // The one-euro filter's answer is to make the cutoff a function of speed:
  // filter hard while the signal is still, barely at all while it moves.
  //
  // The bundle's smoothing sites hand over only the lerp alpha, never the value
  // being lerped, so the speed cannot be measured inside `smooth`. It is
  // measured here instead, off the two signals those bones actually follow -
  // the solved head rotation and the tracked wrists - and the faster of the two
  // sets the cutoff. The arm retarget has its target in hand and filters it
  // directly, so it does not go through this path.

  var frameDt = 0.016;
  var frameLast = 0;
  var speedNow = 0;
  var lastHead = null;
  var lastHeadAt = 0;
  var lastWrist = null;
  var lastWristAt = 0;

  // Rise instantly, fall over ~200 ms. A speed estimate that lagged its own
  // signal would filter hardest at the exact moment a movement ends, which is
  // the overshoot it is supposed to prevent.
  function noteSpeed(v) { if (v > speedNow) speedNow = v; }

  function speedOf(cur, prev, at) {
    var t = now();
    if (!prev || t <= at) return t;
    var dt = (t - at) / 1000;
    if (dt > 1e-3 && dt < 0.5) noteSpeed(dist3(cur, prev) / dt);
    return t;
  }

  // called once per solved face result
  function noteHeadSpeed(rig) {
    var h = rig && rig.head;
    if (!h) return;
    var cur = v3(num(h.x), num(h.y), num(h.z));
    lastHeadAt = speedOf(cur, lastHead, lastHeadAt);
    lastHead = cur;
  }

  // called once per holistic result. Landmark units are metres-ish, radians
  // are not - but both end up as "how fast is this moving", and the cutoff only
  // needs the larger of the two.
  function noteWristSpeed(lm) {
    var r = lm[ARM_LM.Right.wrist], l = lm[ARM_LM.Left.wrist];
    if (!vis(r) || !vis(l)) return;
    var cur = vmid(r, l);
    lastWristAt = speedOf(cur, lastWrist, lastWristAt);
    lastWrist = cur;
  }

  // Advanced once per rendered frame, not once per smoothed bone: the four call
  // sites all belong to the same frame and must be handed the same dt.
  function stepMotionClock() {
    var t = now();
    frameDt = frameLast ? Math.min((t - frameLast) / 1000, 0.1) : 0.016;
    frameLast = t;
    speedNow -= speedNow * Math.min(1, frameDt / 0.2);
  }

  // one-euro's alpha: a first-order low-pass whose cutoff opens with speed
  function euroAlpha(dt, speed, scale) {
    var fc = (cfg.minCutoff + cfg.beta * speed) * (scale || 1);
    var tau = 1 / (2 * Math.PI * Math.max(fc, 0.05));
    return clamp(dt / (tau + dt), 0.002, 1);
  }

  function smooth(t) {
    // The bundle says which bone it is smoothing in the alpha itself:
    // 0.04 + dt*4 for the neck, *2 for the torso, *6 for the wrist. Reading
    // that multiplier back out keeps the torso trailing the head by the same
    // ratio it does upstream, instead of flattening every bone onto one
    // cutoff and making the whole body turn as one board.
    var n = frameDt > 1e-4 ? clamp((t - 0.04) / frameDt, 1, 8) : 4;
    var a = euroAlpha(frameDt, speedNow, n / 4);
    // A frame the sanity check does not believe still reaches the neck and the
    // torso - there is no hook that can drop it. Crawling toward it instead of
    // following it turns the jump into a wobble, and the next frame anyone
    // believes pulls it back. A hand on the face can jump the mesh without
    // invalidating the pose, so that crawl is on faceTrusted, and the arms
    // still retarget (they do not go through this lerp).
    if (!poseTrusted || !faceTrusted) a = Math.min(a, 0.01);
    return a;
  }

  // ------------------------------------------------------------ arm retarget
  //
  // Kalidokit hands the rig three Euler angles per arm bone, estimated from the
  // landmark directions and then clamped. Replaying those angles puts the
  // avatar's hand wherever they happen to point it, which is not where the
  // camera saw the hand - hands-on-head lands on the ears. No gain fixes that,
  // because scaling a rotation sweeps the hand along an arc rather than moving
  // it toward the target.
  //
  // So drive the arm from the landmarks instead. Take the shoulder -> wrist
  // vector the camera measured, read it in a torso frame built from the user's
  // own shoulders and hips, rebuild it in the same frame on the model, scale it
  // by the model's arm length over the user's, and solve the two bones so the
  // hand lands on it. The elbow landmark is the pole, so nothing has to guess
  // which way the elbow folds.
  //
  // Only the holistic path feeds this. The tfjs pose-only path reports its
  // keypoints in another space, so there the arms stay on the stock rig.

  // Mediapipe pose world landmarks, in Kalidokit's naming: what Kalidokit calls
  // the Right arm is Mediapipe's left-side indices, because the preview is
  // mirrored. The bundle swaps the hand landmark sets the same way.
  var ARM_LM = {
    Right: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, pinky: 17, index: 19 },
    Left: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, pinky: 18, index: 20 }
  };
  var LM_NOSE = 0;
  // Mediapipe pose carries both ears. Their midpoint is inside the skull, which
  // is where "at the head" has to be measured from - see `headRef`.
  var LM_EAR_L = 7;
  var LM_EAR_R = 8;
  // The hand model's own 21 landmarks. Only the knuckle row is read: the
  // fingertips curl out of the palm's plane, the knuckles are the palm.
  var HAND_LM = { wrist: 0, index: 5, middle: 9, pinky: 17 };
  // a tracking drop should hand the arms back to the stock rig, not freeze them
  var POSE_STALE_MS = 500;
  // how much of the elbow's bend Reach is allowed to take away, in radians
  var REACH_STRAIGHTEN = 45 * Math.PI / 180;
  // How near the face a hand has to be, in the person's own head-heights, for
  // the head to be the thing it is aimed at. Inside HEAD_ON it is a gesture
  // about the head and gets the whole anchor; past HEAD_FAR the arm is doing
  // something the head has nothing to do with, and gets none of it.
  var HEAD_ON = 0.9;
  var HEAD_FAR = 1.8;
  // Image-space, in ear-spans. A covering palm sits well inside ON; a hand
  // still on the chest is past FAR. Used so a hand in front of the face -
  // where world depth is the axis the tracker compresses to nothing - still
  // counts as at the head.
  var IMG_HEAD_ON = 0.55;
  var IMG_HEAD_FAR = 1.7;
  var MIN_VIS = 0.35;

  // ------------------------------------------------------- tracking sanity
  //
  // Both trackers say where the face is, in the same normalised video frame:
  // the face mesh as `head.position`, the pose as its nose landmark. They never
  // agree exactly - one is a face box, the other a nose tip - but the gap
  // between them belongs to this person's face and holds still for as long as
  // both are actually tracking them. When it jumps, one of the two has lost the
  // person, and that is the frame the arms and the head jump on. Visibility
  // does not catch it: a tracker that has locked onto the wrong thing reports
  // its landmarks as perfectly visible.
  //
  // Nothing here assumes what the gap should be, or how steady it should be:
  // both are learned. A constant in this gate would be a gate tuned to one
  // webcam and one face.
  //
  // The preview is mirrored, so the horizontal gap may or may not be constant
  // depending on which source got flipped. That is why the two axes are scored
  // separately - a mirrored X simply learns a large wobble and stops
  // contributing, leaving Y to do the work, rather than firing all the time.

  var SANITY_WARMUP = 30;      // frames to learn the gap before gating on it
  var SANITY_K = 5;            // learned deviations before a frame is disbelieved
  // Something really changed - they sat down, swapped seats, changed the light.
  // Give up and re-learn, or one genuine change locks the gate shut for good.
  var SANITY_GIVE_UP = 20;
  // ms to keep treating the face as occluded after the hand leaves, so a pass
  // over the eyes does not glitch the lids on the way out.
  var FACE_OCC_HOLD = 180;
  // Knuckles and tips. A yawn-cover parks the wrist at the chin while the
  // fingers sit on the lips; the pose wrist alone would miss that.
  var HAND_FACE_PTS = [0, 4, 5, 8, 9, 12, 13, 16, 17, 20];

  function meter() { return { n: 0, avg: 0, dev: 0, hi: 0, bad: 0 }; }

  function learn(st, v) {
    st.n++;
    // average the warmup outright, then trail it slowly
    var a = st.n < SANITY_WARMUP ? 1 / st.n : 0.02;
    var d = v - st.avg;
    st.avg += d * a;
    st.dev += (Math.abs(d) - st.dev) * a;
  }

  function offBy(st, v) {
    if (st.n < SANITY_WARMUP) return 0;
    return Math.abs(v - st.avg) / Math.max(st.dev, 0.004);
  }

  var gapX = meter();
  var gapY = meter();
  var gapBad = 0;
  // false while the two trackers disagree about where this person is
  var poseTrusted = true;
  // false when the face mesh jumped because a hand is what it is looking at
  var faceTrusted = true;
  var faceOcc = false;
  var faceOccAt = 0;

  function nearFace(p, nose, lim2) {
    return vis(p) && imgDist(p, nose) < lim2;
  }

  // The image landmarks are written once per inference; these three answers
  // depend on nothing else, and the retarget asks for two of them once per arm
  // per *rendered* frame on top of that. At 144Hz against a 20Hz inference
  // that is the same square root taken seven times for one reading.
  //
  // `poseSeq` cannot key this. That one is bumped after the world landmarks
  // are accepted, and the image set is written even on a frame whose world set
  // is rejected - and `hands()` writes it before `pose()` runs at all.
  var imgSeq = 0;
  var imgMemo = {
    seq: -1, lim2: 0, lim2Done: false,
    hit: { Right: false, Left: false }, hitDone: { Right: false, Left: false },
    near: { Right: null, Left: null }, nearDone: { Right: false, Left: false }
  };

  function imgFrame() {
    if (imgMemo.seq === imgSeq) return imgMemo;
    imgMemo.seq = imgSeq;
    imgMemo.lim2Done = false;
    imgMemo.hitDone.Right = false; imgMemo.hitDone.Left = false;
    imgMemo.nearDone.Right = false; imgMemo.nearDone.Left = false;
    return imgMemo;
  }

  function faceLim2() {
    var m = imgFrame();
    if (!m.lim2Done) { m.lim2Done = true; m.lim2 = calcFaceLim2(); }
    return m.lim2;
  }

  function sideHitsFace(side) {
    var m = imgFrame();
    if (!m.hitDone[side]) { m.hitDone[side] = true; m.hit[side] = calcSideHitsFace(side); }
    return m.hit[side];
  }

  function imgHeadNear(side) {
    var m = imgFrame();
    if (!m.nearDone[side]) { m.nearDone[side] = true; m.near[side] = calcImgHeadNear(side); }
    return m.near[side];
  }

  function calcFaceLim2() {
    var img = poseImg;
    var nose = img && img[LM_NOSE];
    if (!vis(nose)) return 0;
    var earL = img[LM_EAR_L], earR = img[LM_EAR_R];
    var rad = (vis(earL) && vis(earR)) ? Math.sqrt(imgDist(earL, earR)) * 0.65 : 0.14;
    return rad * rad;
  }

  function calcSideHitsFace(side) {
    var img = poseImg;
    var nose = img && img[LM_NOSE];
    var lim2 = faceLim2();
    if (!vis(nose) || !lim2) return false;
    var idx = ARM_LM[side];
    if (nearFace(img[idx.wrist], nose, lim2)) return true;
    if (nearFace(img[idx.index], nose, lim2)) return true;
    if (nearFace(img[idx.pinky], nose, lim2)) return true;
    var h = poseHand && poseHand[side];
    if (!h) return false;
    for (var k = 0; k < HAND_FACE_PTS.length; k++) {
      if (nearFace(h[HAND_FACE_PTS[k]], nose, lim2)) return true;
    }
    return false;
  }

  // How near this hand is to the head in the video, in ear-spans. Null when
  // there is no image pose to read. A covering palm is well under 1.
  function calcImgHeadNear(side) {
    var img = poseImg;
    var nose = img && img[LM_NOSE];
    if (!vis(nose)) return null;
    var earL = img[LM_EAR_L], earR = img[LM_EAR_R];
    var span = (vis(earL) && vis(earR)) ? Math.sqrt(imgDist(earL, earR)) : 0.15;
    if (span < 0.02) span = 0.15;
    var idx = ARM_LM[side];
    var best = Infinity;
    var h = poseHand && poseHand[side];
    var i, d, p;
    p = img[idx.wrist];
    if (vis(p)) { d = Math.sqrt(imgDist(p, nose)) / span; if (d < best) best = d; }
    p = img[idx.index];
    if (vis(p)) { d = Math.sqrt(imgDist(p, nose)) / span; if (d < best) best = d; }
    p = img[idx.pinky];
    if (vis(p)) { d = Math.sqrt(imgDist(p, nose)) / span; if (d < best) best = d; }
    if (h) {
      for (i = 0; i < HAND_FACE_PTS.length; i++) {
        p = h[HAND_FACE_PTS[i]];
        if (!vis(p)) continue;
        d = Math.sqrt(imgDist(p, nose)) / span;
        if (d < best) best = d;
      }
    }
    return best === Infinity ? null : best;
  }

  // Ground truth outside the mesh: the pose still sees the head, the hand
  // model still sees the palm, and if they overlap in the video the mesh is
  // looking at a hand. Ear-span is this person's own face, not a webcam
  // constant. One hand is enough - covering a yawn is one palm.
  function handHitsFace() {
    return sideHitsFace('Right') || sideHitsFace('Left');
  }

  function noteFaceOcc() {
    if (handHitsFace()) {
      faceOcc = true;
      faceOccAt = now();
    } else if (faceOcc && now() - faceOccAt > FACE_OCC_HOLD) {
      faceOcc = false;
    }
  }

  function noteFaceBox(rig) {
    noteFaceOcc();
    var h = rig && rig.head;
    var box = h && h.position;
    var nose = poseImg && poseImg[LM_NOSE];
    // nothing to cross-check against - believe what there is
    if (!box || !vis(nose)) {
      poseTrusted = true;
      faceTrusted = !faceOcc;
      return;
    }
    var dx = num(box.x) - num(nose.x);
    var dy = num(box.y) - num(nose.y);
    var off = Math.max(offBy(gapX, dx), offBy(gapY, dy));
    if (off > SANITY_K && gapBad < SANITY_GIVE_UP) {
      gapBad++;
      if (faceOcc) {
        // the mesh jumped because it is looking at a hand. The pose still
        // has this person, and the arm covering the mouth has to keep going.
        poseTrusted = true;
        faceTrusted = false;
      } else {
        poseTrusted = false;
        faceTrusted = false;
      }
      return;                 // and do not learn from a frame we do not believe
    }
    gapBad = 0;
    poseTrusted = true;
    faceTrusted = true;
    // a hand on the cheek shifts the gap a little; that is not the new face
    if (faceOcc) return;
    learn(gapX, dx);
    learn(gapY, dy);
  }

  // An arm has one length, so a frame reporting a different one has put a
  // landmark where the arm cannot reach. Per side, which the face cross-check
  // cannot be: one arm goes missing while the rest of the body tracks fine.
  //
  // Only an over-long arm is impossible, and only that is rejected. Measured
  // length falls whenever the arm turns toward the lens - that is the same
  // depth compression the depth calibration exists to undo, and it can take
  // half the length off. Rejecting short arms would throw away every gesture
  // toward the camera, which is the one this layer works hardest to get right.
  var armLenSeen = { Right: meter(), Left: meter() };

  function armLenOk(side, len) {
    var st = armLenSeen[side];
    if (st.n >= SANITY_WARMUP && len > st.hi * 1.25 && st.bad < SANITY_GIVE_UP) {
      st.bad++;
      return false;
    }
    st.bad = 0;
    st.n++;
    // Reach a new maximum at once, fall back toward it slowly. A rejected frame
    // never gets here, so one bad reading cannot install itself as the new
    // normal - but an arm that really did get longer on screen still lands.
    st.hi = (st.n === 1 || len > st.hi) ? len : st.hi + (len - st.hi) * 0.01;
    return true;
  }

  var poseLm = null;
  var poseImg = null;
  // { Right: [21 landmarks] | null, Left: ... } from the hand model, in image
  // space. Same Right/Left convention as ARM_LM - the bundle builds this map
  // by crossing the sides over, and so does the rest of this layer.
  var poseHand = null;
  var poseLmAt = 0;
  var poseSeq = 0;
  // the torso frame those landmarks gave, and which result it came from
  var lmBasis = null;
  var lmBasisSeq = -1;
  // the same frame built from the image-space landmarks, which is where the
  // hand model reports
  var imgBasis = null;
  var imgBasisSeq = -1;

  // called with the world landmarks of every holistic result
  // `image` is the second argument the call site has always passed and this
  // layer has always dropped: the same landmarks in normalised video space,
  // which is the one space the face mesh also reports in.
  // How often the hand model handed back a hand belonging to the other arm.
  // Kept for `PSX.armInfo()`: a swap that is corrected leaves no trace in the
  // pose, and "it looks wrong with both hands up" is not a thing anyone can
  // measure from the outside.
  var handSwaps = 0;

  // Distance in the video frame. The hand model and the pose both report there,
  // and only there do the two have a common space - the depth axis is estimated
  // separately by each and cannot be compared.
  function imgDist(a, b) {
    var dx = num(a.x) - num(b.x), dy = num(a.y) - num(b.y);
    return dx * dx + dy * dy;
  }

  // Which arm's wrist this hand is actually sitting on.
  //
  // Holistic reports the two hands as separate results and, with both of them
  // up beside the head, regularly reports them the wrong way round - close
  // together, similar shapes, and nothing in the result says which arm each one
  // belongs to. One hand up cannot show the fault, because there is nothing for
  // it to be swapped with, which is exactly how it stayed hidden.
  //
  // Nothing here trusts the labels: it asks where each hand is. A hand nearer
  // the other arm's wrist than its own is the other arm's hand, whatever it was
  // filed under.
  function handSide(side, p) {
    var img = poseImg;
    if (!img || !p || p.length <= HAND_LM.wrist) return side;
    var other = side === 'Left' ? 'Right' : 'Left';
    var mine = img[ARM_LM[side].wrist], theirs = img[ARM_LM[other].wrist];
    if (!mine || !theirs || !vis(mine) || !vis(theirs)) return side;
    var w = p[HAND_LM.wrist];
    if (!w) return side;
    var dm = imgDist(w, mine), dt = imgDist(w, theirs);
    // A clear margin, not a tie-break. With the wrists crossed or touching the
    // two distances are nearly equal, and a swap decided on noise would flicker
    // the palms every frame - which is worse than the fault it is fixing.
    return dt * 1.44 < dm ? other : side;
  }

  function placeHands(hands) {
    if (!hands) return null;
    var want = { Right: null, Left: null };
    var moved = false;
    for (var side in ARM_LM) {
      var p = hands[side];
      if (!p) continue;
      var to = handSide(side, p);
      if (to !== side) moved = true;
      // Two hands that both claim the same arm are two readings of one hand, or
      // one reading of neither. Keep the one already filed there and drop the
      // other rather than choosing between them.
      if (!want[to]) want[to] = p;
    }
    if (moved) handSwaps++;
    return want;
  }

  // Called before the app solves its fingers, so the correction reaches the
  // finger rig too - a swapped pair puts every finger on the wrong hand, and
  // fixing only this layer's copy would leave that half standing.
  //
  // Takes the image-space pose directly: `pose()` has not run yet this frame,
  // so there is no `poseImg` to read.
  function hands(h, image) {
    poseImg = (image && image.length > LM_NOSE) ? image : poseImg;
    imgSeq++;
    return placeHands(h) || h;
  }

  function pose(world, image, hands) {
    poseImg = (image && image.length > LM_NOSE) ? image : null;
    // Already corrected when the bundle carries the hook; placing again is a
    // no-op, and it is what keeps this working on a bundle that does not.
    poseHand = placeHands(hands);
    imgSeq++;
    noteFaceOcc();
    if (!world || world.length <= ARM_LM.Left.hip) { poseLm = null; return; }
    poseLm = world;
    poseLmAt = now();
    poseSeq++;
    noteWristSpeed(world);
    sampleMotionLandmarks(world);
  }

  function v3(x, y, z) { return { x: x, y: y, z: z }; }
  function vsub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
  function vadd(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
  function vmul(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
  function vdot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function vcross(a, b) {
    return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  function vlen(a) { return Math.sqrt(vdot(a, a)); }
  function vnorm(a) { var l = vlen(a); return l > 1e-6 ? vmul(a, 1 / l) : null; }
  function vmid(a, b) { return v3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); }
  function vlerp(a, b, t) {
    return v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }

  // Rodrigues: turn `v` about `axis` by `ang`.
  function rotAbout(v, axis, ang) {
    var c = Math.cos(ang), s = Math.sin(ang);
    var cr = vcross(axis, v);
    var d = vdot(axis, v) * (1 - c);
    return v3(v.x * c + cr.x * s + axis.x * d,
      v.y * c + cr.y * s + axis.y * d,
      v.z * c + cr.z * s + axis.z * d);
  }

  // An orthonormal torso frame: x across the shoulders from the right one to
  // the left one, y up the spine, z out of the chest. Built the same way from
  // landmarks and from bones, so reading a vector's components in one frame and
  // rebuilding them in the other is an anatomical mapping - it needs no
  // assumption about either source's axis convention.
  //
  // `front` is any vector known to point out of the chest, and is what settles
  // the one thing anatomy alone does not: in a left-handed source the cross
  // product lands behind the body instead of in front of it. Bone space is
  // three.js and a VRM faces +Z, so there it can be omitted.
  function torsoBasis(shoulderR, shoulderL, hipMid, front) {
    var x = vnorm(vsub(shoulderL, shoulderR));
    if (!x) return null;
    var up = vsub(vmid(shoulderR, shoulderL), hipMid);
    var y = vnorm(vsub(up, vmul(x, vdot(up, x))));
    if (!y) return null;
    var z = vnorm(vcross(x, y));
    if (!z) return null;
    if (front && vdot(z, front) < 0) z = vmul(z, -1);
    return { x: x, y: y, z: z };
  }

  // `v` read in the landmark frame, rebuilt in the bone frame. Mirroring is a
  // reflection across the model's own midline, so it only flips the component
  // along the shoulder axis.
  // `g` scales the three torso axes independently on the way across: across
  // the shoulders, up the spine, and out toward the lens. Lateral is left at 1
  // and carries no gain of its own - Reach is the lateral scale, applied to the
  // whole vector once the direction is mapped, so the other two axes are
  // factors relative to it.
  function mapDir(v, ub, mb, sx, g) {
    var dx = vdot(v, ub.x) * sx * g.x;
    var dy = vdot(v, ub.y) * g.y;
    var dz = vdot(v, ub.z) * g.z;
    return vadd(vadd(vmul(mb.x, dx), vmul(mb.y, dy)), vmul(mb.z, dz));
  }

  function axisGain() {
    return { x: 1, y: cfg.reachUp, z: cfg.armDepth };
  }

  // Reach for one arm. The per-side factors are normalised around 1 by the
  // calibration, so this stays Reach for a symmetric setup.
  function sideReach(side) {
    var f = side === 'Left' ? cfg.reachL : cfg.reachR;
    return cfg.armReach * (isNum(f) ? f : 1);
  }

  function vis(p) {
    return !!p && (p.visibility == null || p.visibility > MIN_VIS);
  }

  // The middle of the head, not the front of the face. Falls back to the nose
  // where the ears are not tracked - a worse reference, but the only other one.
  function headRef(lm) {
    var a = lm[LM_EAR_L], b = lm[LM_EAR_R];
    if (vis(a) && vis(b)) return vmid(a, b);
    return lm[LM_NOSE];
  }

  // `vis` answers whether a landmark may be used at all. This answers how much
  // it should be believed, which is a different question and the one that
  // matters where a reading is allowed to undo something.
  function conf(p) {
    if (!p) return 0;
    return p.visibility == null ? 1 : p.visibility;
  }

  // A wrist this sure is being seen; below it, it is being guessed at.
  var SURE_VIS = 0.7;

  // The local rotation a bone loaded with. The stock rig writes solved angles
  // as absolute local rotations, i.e. it assumes this is identity; the retarget
  // measures its aim from whatever it actually is, so a rig with a baked-in
  // bind rotation still lands right.
  function restQuat(bone) {
    if (!bone.__psxRest) bone.__psxRest = bone.quaternion.clone();
    return bone.__psxRest;
  }

  // psx.js is a plain script with no handle on three, so every Quaternion and
  // Vector3 it needs is cloned off a bone once and then reused - which also
  // keeps the rig from allocating four of each per frame.
  function armCache(vrm) {
    if (vrm.__psxArm) return vrm.__psxArm;
    var c = { ok: false };
    var ru = boneNode(vrm, 'rightUpperArm');
    var lu = boneNode(vrm, 'leftUpperArm');
    var hips = boneNode(vrm, 'hips');
    if (ru && lu && hips) {
      c = {
        ok: true, ru: ru, lu: lu, hips: hips, at: {}, off: {},
        // model-space measurements, re-read a few times a second - see armSeg
        seg: {}, headB: undefined, headAt: 0, headH: 0,
        // per-side dead-reckoning state: the raw target of the last inference,
        // when it was taken, and the velocity between the last two
        raw: {}, rawAt: {}, rawSeq: {}, vel: {}, elb: {}, aim: {},
        // per-side coast state: when this arm was last solved from live
        // landmarks, and the three rotations it was left in
        goodAt: {}, lostAt: {}, sb: {}, held: {
          Right: {
            u: ru.quaternion.clone(), l: ru.quaternion.clone(),
            h: ru.quaternion.clone(), s: ru.quaternion.clone()
          },
          Left: {
            u: ru.quaternion.clone(), l: ru.quaternion.clone(),
            h: ru.quaternion.clone(), s: ru.quaternion.clone()
          }
        },
        vA: ru.position.clone(), vB: ru.position.clone(),
        qA: ru.quaternion.clone(), qB: ru.quaternion.clone(),
        qC: ru.quaternion.clone(), qD: ru.quaternion.clone(),
        keep: ru.quaternion.clone(), roll: {}
      };
    }
    vrm.__psxArm = c;
    return c;
  }

  // `v` turned by `q` - three's Vector3.applyQuaternion, on plain objects, so
  // moving a direction around costs no Vector3.
  function qRotate(q, v) {
    var ix = q.w * v.x + q.y * v.z - q.z * v.y;
    var iy = q.w * v.y + q.z * v.x - q.x * v.z;
    var iz = q.w * v.z + q.x * v.y - q.y * v.x;
    var iw = -q.x * v.x - q.y * v.y - q.z * v.z;
    return v3(ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
      iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
      iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x);
  }

  // The shoulder for the bone the rig is about to write, or null - it is an
  // optional VRM bone and plenty of low-poly models leave it out. Taken only
  // when it really is this arm's parent, so a rig that names it something else
  // cannot get twisted by mistake.
  // Which of the model's sides this tracked side drives. Mirrored is the
  // normal case - the preview is a mirror, so the person's right arm is the
  // one the viewer sees where the model's left arm is.
  function boneSide(side, mirrored) {
    return mirrored ? (side === 'Right' ? 'left' : 'right') : side.toLowerCase();
  }

  function shoulderBone(vrm, upper, side, mirrored) {
    var sb = boneNode(vrm, boneSide(side, mirrored) + 'Shoulder');
    return sb && upper.parent === sb ? sb : null;
  }

  // Point `bone` so the segment running to `child` lies along `dir` in world
  // space, leaving the twist about that segment at its rest value. Written as a
  // delta from the rest rotation rather than as an Euler, because which local
  // axis runs down the bone differs per model.
  //
  // Solved in the parent's space, not the world's. The segment is just the
  // child's local offset, so its rest direction is known without moving
  // anything - which matters, because reading it off the child's world position
  // instead would mean rebuilding this bone's whole subtree first, and below
  // the shoulder that subtree is every finger bone in the hand.
  function aimBone(c, bone, child, dir) {
    var seg = vnorm(child.position);
    if (!seg) return;
    if (bone.parent) bone.parent.getWorldQuaternion(c.qB);
    else c.qB.set(0, 0, 0, 1);
    var rest = restQuat(bone);
    var from = qRotate(rest, seg);                    // rest aim, parent space
    var to = qRotate(c.qC.copy(c.qB).invert(), dir);  // wanted aim, parent space
    bone.quaternion.copy(c.qA.setFromUnitVectors(
      c.vA.set(from.x, from.y, from.z), c.vB.set(to.x, to.y, to.z)).multiply(rest));
  }

  function perpTo(v, axis) { return vsub(v, vmul(axis, vdot(v, axis))); }

  // The angle from `from` to `to` measured around `axis`, signed. Both are
  // flattened onto the plane across the axis first, so only rotation about it
  // is counted - which is what a forearm twist is.
  function twistAngle(from, to, axis) {
    var f = vnorm(perpTo(from, axis));
    var t = vnorm(perpTo(to, axis));
    if (!f || !t) return null;
    return Math.atan2(vdot(vcross(f, t), axis), clamp(vdot(f, t), -1, 1));
  }

  // Turn `bone` about a world-space axis, on top of wherever it already is.
  // Written in world space and pulled back into the parent's, because the axis
  // that matters is the forearm's, not one of the bone's own.
  function rollBone(c, bone, axis, ang) {
    var half = ang / 2, sn = Math.sin(half);
    c.qA.set(axis.x * sn, axis.y * sn, axis.z * sn, Math.cos(half));
    if (bone.parent) bone.parent.getWorldQuaternion(c.qB);
    else c.qB.set(0, 0, 0, 1);
    c.qC.copy(c.qB).invert().multiply(c.qA).multiply(c.qB);
    c.qD.copy(bone.quaternion);
    bone.quaternion.copy(c.qC).multiply(c.qD);
  }

  // Across the back of the hand, from the little finger to the index. Both
  // sources have it: the model as two humanoid finger bones, the tracker as two
  // pose landmarks. Comparing the same anatomical direction on each is what
  // makes the twist measurable without knowing either rig's axis convention.
  function palmAcross(vrm, side, mirrored) {
    var s = boneSide(side, mirrored);
    var ix = boneNode(vrm, s + 'IndexProximal');
    var li = boneNode(vrm, s + 'LittleProximal');
    if (!ix || !li) return null;
    return vnorm(vsub(worldPos(ix), worldPos(li)));
  }

  // A difference between two landmarks, tolerant of a missing z. The hand
  // model always reports one, but a landmark array that has been through a
  // serialisation somewhere may not, and a NaN here silently kills the whole
  // arm rather than one axis of it.
  function lmVec(a, b) {
    return v3(num(a.x) - num(b.x), num(a.y) - num(b.y), num(a.z) - num(b.z));
  }

  // The torso frame, in image space. The hand model reports there and the pose
  // world landmarks do not, so a hand vector cannot be read in `lmBasis` - the
  // two are different spaces. It is the frame, not the space, that makes a
  // direction anatomical, so building the same frame here is all it takes.
  //
  // Image y runs down the screen and image z is a rough depth in x's units;
  // neither matters once both are read as components of this frame.
  function imageBasis() {
    if (imgBasisSeq === poseSeq) return imgBasis;
    imgBasisSeq = poseSeq;
    imgBasis = null;
    var p = poseImg;
    if (!p || p.length <= ARM_LM.Left.hip) return null;
    var shR = p[ARM_LM.Right.shoulder], shL = p[ARM_LM.Left.shoulder];
    if (!vis(shR) || !vis(shL)) return null;
    imgBasis = torsoBasis(shR, shL, vmid(p[ARM_LM.Right.hip], p[ARM_LM.Left.hip]),
      lmVec(p[LM_NOSE], vmid(shR, shL)));
    return imgBasis;
  }

  // Where this hand points and which way its palm faces, in the model's space.
  //
  // The pose model also reports an index and a pinky landmark, and this used to
  // run on those - but it finds them as a by-product of finding the arm, and
  // they jitter by more than the palm is wide. The hand model is the only
  // tracker that actually looks at the hand. It is also the one that drives the
  // fingers, so when it has the hand the fingers and the wrist finally agree.
  //
  // Null whenever the hand is not being seen, which is often: holistic drops
  // the hand model the moment the hand blurs or leaves the frame.
  function handWant(side, mb, sx, depth) {
    if (!poseHand) return null;
    var p = poseHand[side];
    if (!p || p.length <= HAND_LM.pinky) return null;
    var ib = imageBasis();
    if (!ib) return null;
    var w = p[HAND_LM.wrist], md = p[HAND_LM.middle];
    var ix = p[HAND_LM.index], pk = p[HAND_LM.pinky];
    if (!w || !md || !ix || !pk) return null;
    var fwd = vnorm(mapDir(lmVec(md, w), ib, mb, sx, depth));
    var across = vnorm(mapDir(lmVec(ix, pk), ib, mb, sx, depth));
    if (!fwd || !across) return null;
    return { fwd: fwd, across: across };
  }

  // Something on the far side of the wrist to aim the hand bone by. The middle
  // knuckle is the hand's own axis. A rig with no finger bones has to fall
  // back, and there the Euler wrist is still the right answer.
  function handChild(vrm, side, mirrored) {
    var s = boneSide(side, mirrored);
    return boneNode(vrm, s + 'MiddleProximal') || boneNode(vrm, s + 'IndexProximal');
  }

  // three.js XYZ order, so the wrist keeps reading the way the stock rig set it
  function quatFromEuler(q, x, y, z) {
    var c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    var s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return q.set(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
  }

  // Read this while holding the pose that comes out wrong. `live: false` means
  // the retarget never ran and the stock Euler rig drew that arm, which is a
  // different bug from a retarget that ran and got it wrong. With it live,
  // `userBend` against `modelBend` says whether the elbow survived the trip,
  // and `clamped` says the solve ran out of arm.
  function deg(r) { return r == null ? null : Math.round(r * 180 / Math.PI); }
  function r2(v) { return isNum(v) ? Math.round(v * 100) / 100 : null; }

  function armSide(d) {
    if (!d.live) return { live: false, reason: d.reason };
    var span = d.a + d.b;
    return {
      live: true,
      // the elbow the person made, and the one the model was given once reach,
      // the anchor and the filter had each had their turn
      userBend: deg(d.bend == null ? null : Math.acos(d.bend)),
      modelBend: deg(Math.acos(clamp((d.a * d.a + d.b * d.b - d.want * d.want) /
        (2 * d.a * d.b), -1, 1))),
      // 1 = the hand is as far out as the arm reaches. Pinned there means the
      // solve is clamped, which is a straight arm in every pose.
      extend: r2(d.want / span),
      clamped: d.want >= span - 1e-4,
      anchor: r2(d.anchor), near: r2(d.near), wristSeen: r2(d.wristSeen),
      upper: r2(d.upper), fore: r2(d.fore), gap: r2(d.gap),
      reach: r2(d.reach),
      straighten: d.bend == null ? null
        : deg(REACH_STRAIGHTEN * Math.pow((1 - d.bend) / 2, 4)),
      hand: d.hand, twistDeg: deg(d.twist), twistCapped: d.twistCapped,
      palmDot: r2(d.palmDot),
      rollHeld: d.rollHeld, handRest: d.handRest,
      imgNear: r2(d.imgNear), occ: d.occ, stand: r2(d.stand)
    };
  }

  function armInfo() {
    return {
      armIK: cfg.armIK,
      faceOcc: faceOcc, faceTrusted: faceTrusted, poseTrusted: poseTrusted,
      reach: r2(cfg.armReach), up: r2(cfg.reachUp), depth: r2(cfg.armDepth),
      sides: [r2(cfg.reachR), r2(cfg.reachL)],
      headAnchor: cfg.headAnchor,
      twist: cfg.twist,
      handSwaps: handSwaps,
      right: armSide(armDbg.Right),
      left: armSide(armDbg.Left)
    };
  }

  // Called at the top of the arm rig. Returning true means the retarget has
  // written the three bones and the stock Euler rig must not run.
  function arm(vrm, rig, side, mirrored, instant, upper, lower, hand) {
    if (!cfg.armIK || !vrm || !rig || !upper || !lower || !hand) return false;
    var idx = ARM_LM[side];
    if (!idx) return false;
    try {
      return retarget(vrm, rig, side, idx, mirrored, instant, upper, lower, hand);
    } catch (e) {
      log('arm retarget failed', e);
      cfg.armIK = false;
      return false;
    }
  }

  // A lost landmark used to hand the arm straight back to the stock Euler rig,
  // which writes a completely different pose on the next frame - the arm jumps,
  // and that jump is most of what "it loses tracking" feels like. Instead the
  // last solved rotations are held for `armHold`, then eased back to the bone's
  // rest over the same span, and only then is the arm given back. Stock's
  // answer for an arm it cannot see is near rest too, so by that point the
  // handover has nothing left to show.
  //
  // An arm that has never been solved is not coasted: with no holistic pose at
  // all - the tfjs pose-only path - the stock rig is the right answer from the
  // first frame, not something to be eased into.
  function coast(c, side, upper, lower, hand) {
    armDbg[side].live = false;
    armDbg[side].reason = armWhy;
    if (!c.goodAt[side]) return false;
    var hold = cfg.armHold;
    if (hold <= 0) { giveUpArm(c, side); return false; }
    // Timed from the moment the arm was lost, not from the last good solve.
    // The two are the same when a limb goes out of view, but a whole pose only
    // counts as stale after POSE_STALE_MS - during which the retarget is still
    // re-solving the same landmarks, which is already a hold.
    var t = now();
    if (!c.lostAt[side]) c.lostAt[side] = t;
    var age = t - c.lostAt[side];
    if (age > hold * 2) { giveUpArm(c, side); return false; }
    var k = age <= hold ? 0 : (age - hold) / hold;
    var h = c.held[side];
    fadeBone(upper, h.u, k);
    fadeBone(lower, h.l, k);
    fadeBone(hand, h.h, k);
    if (c.sb[side]) fadeBone(c.sb[side], h.s, k);
    return true;
  }

  // Give the arm back to the stock rig, and put the shoulder back where the
  // model loaded it - nothing upstream writes that bone, so one left turned by
  // the retarget would stay turned for the rest of the session.
  function giveUpArm(c, side) {
    c.goodAt[side] = 0;
    c.lostAt[side] = 0;
    if (c.sb[side]) c.sb[side].quaternion.copy(restQuat(c.sb[side]));
    c.sb[side] = null;
  }

  function fadeBone(bone, from, k) {
    bone.quaternion.copy(from);
    if (k > 0) bone.quaternion.slerp(restQuat(bone), clamp(k, 0, 1));
  }

  // Why the retarget bailed, if it did. Set at each gate rather than worked out
  // afterwards - by the time the caller sees `false` the reason is gone.
  //
  // Two objects, made once and written over. This runs twice a frame for the
  // life of the session, so it holds raw numbers and allocates nothing: the
  // rounding and the derived figures are `armInfo`'s job, and `armInfo` is
  // called by a person, at human speed.
  var armDbg = { Right: {}, Left: {} };
  var armWhy = '';

  // Every field, cleared: the object outlives the frame, and a flag left over
  // from a frame that set it would read as this frame's answer.
  function dbgOpen(side) {
    var d = armDbg[side];
    d.live = false; d.reason = ''; d.bend = null; d.want = 0; d.span = 0;
    d.anchor = 0; d.near = null; d.wristSeen = 0; d.upper = 0; d.fore = 0;
    d.gap = null; d.reach = 1; d.hand = false; d.twist = null;
    d.twistCapped = false; d.rollHeld = false; d.handRest = false;
    d.palmDot = null; d.imgNear = null; d.occ = false; d.stand = 0;
    return d;
  }

  // A bone-to-bone distance is the length of a fixed local offset, so it is
  // the same number on every frame the model is on screen - but it was being
  // measured twice per rendered frame, and every `worldPos` walks that bone's
  // whole parent chain re-multiplying matrices to get it. Re-read a few times a
  // second instead: a model that is swapped or rescaled still corrects itself
  // inside a blink, and the frames in between stop paying for an answer that
  // did not change.
  //
  // Only measurements go through this. Anything that moves with the pose -
  // `mb`, the head bone's own position - is still read live every frame.
  var MEASURE_EVERY = 250;

  function armSeg(c, side, upper, lower, hand) {
    var s = c.seg[side];
    var t = now();
    if (s && t - s.at < MEASURE_EVERY) return s.ok ? s : null;
    if (!s) s = c.seg[side] = { at: 0, a: 0, b: 0, ok: false };
    var El = worldPos(lower);
    s.a = dist3(worldPos(upper), El);
    s.b = dist3(El, worldPos(hand));
    s.at = t;
    s.ok = s.a >= 1e-5 && s.b >= 1e-5;
    return s.ok ? s : null;
  }

  // Same again for the model's head height. The neck moves it a little; this is
  // only ever used as "head-sized", which is all the two scales it relates need
  // them to be.
  function headHeight(c, headB) {
    var t = now();
    if (c.headAt && t - c.headAt < MEASURE_EVERY) return c.headH;
    c.headAt = t;
    c.headH = vlen(vsub(worldPos(headB), vmid(worldPos(c.ru), worldPos(c.lu))));
    return c.headH;
  }

  // `getBoneNode` is a map lookup with a string fallback behind it, and the
  // head bone is asked for on every frame that has an anchor to place.
  function headBone(c, vrm) {
    if (c.headB === undefined) c.headB = boneNode(vrm, 'head') || null;
    return c.headB;
  }

  function retarget(vrm, rig, side, idx, mirrored, instant, upper, lower, hand) {
    var c = armCache(vrm);
    var dbg = dbgOpen(side);
    armWhy = 'no arm bones';
    if (!c.ok) return false;

    var lm = poseLm;
    var live = !!lm && now() - poseLmAt <= POSE_STALE_MS;
    var sh, el, wr;
    if (live) {
      sh = lm[idx.shoulder]; el = lm[idx.elbow]; wr = lm[idx.wrist];
      live = vis(sh) && vis(el) && vis(wr);
    }
    // the two trackers disagree about where this person even is
    armWhy = (lm && now() - poseLmAt > POSE_STALE_MS) ? 'landmarks are stale'
      : (!lm ? 'no pose landmarks' : 'this arm is not visible');
    if (live && !poseTrusted) { live = false; armWhy = 'sanity rejected the pose'; }
    if (!live) return coast(c, side, upper, lower, hand);

    // both arms of a frame read the same landmarks, and the landmarks only
    // change once per inference, which is slower than the render loop
    var ub = lmBasis;
    if (lmBasisSeq !== poseSeq) {
      var shR = lm[ARM_LM.Right.shoulder], shL = lm[ARM_LM.Left.shoulder];
      ub = torsoBasis(shR, shL, vmid(lm[ARM_LM.Right.hip], lm[ARM_LM.Left.hip]),
        vsub(lm[LM_NOSE], vmid(shR, shL)));
      lmBasis = ub;
      lmBasisSeq = poseSeq;
    }
    if (!ub) return coast(c, side, upper, lower, hand);

    // the upper arm bones sit at the shoulder joints, so this frame is
    // unaffected by whatever the arms themselves are doing
    var mb = torsoBasis(worldPos(c.ru), worldPos(c.lu), worldPos(c.hips), null);
    if (!mb) return coast(c, side, upper, lower, hand);

    var userLen = dist3(sh, el) + dist3(el, wr);
    if (userLen < 1e-4) return coast(c, side, upper, lower, hand);
    armWhy = 'arm length looked wrong';
    if (!armLenOk(side, userLen)) return coast(c, side, upper, lower, hand);

    // A bone-to-bone distance is the length of a fixed local offset, so it does
    // not depend on how either bone is currently turned. The model's arm can be
    // measured where it stands - no need to straighten it out first, which
    // would mean writing the bones before knowing whether the solve works.
    var seg = armSeg(c, side, upper, lower, hand);
    if (!seg) return coast(c, side, upper, lower, hand);
    var a = seg.a, b = seg.b;

    var sx = mirrored ? -1 : 1;
    var depth = { x: 1, y: 1, z: cfg.armDepth };
    var g = axisGain();
    var scale = ((a + b) / userLen) * sideReach(side);
    var off = vmul(mapDir(vsub(wr, sh), ub, mb, sx, g), scale);
    var pole = vnorm(mapDir(vsub(el, sh), ub, mb, sx, g));

    // How far the elbow is actually bent, measured at the elbow. This is a
    // ratio between two landmark distances, so it does not care how big the
    // person is, how far from the lens they are, or what Reach is set to -
    // every one of which corrupts the *length* of the wrist offset. Taking the
    // bend from that length is what welded the arm into one piece: any Reach
    // above 1 pushes the length past what the model's arm can span, the solve
    // clamps it, and a clamped span is a straight arm in every pose.
    //
    // Measured in the mapped frame rather than the raw one, so the depth gain
    // corrects the angle the same way it corrects the target.
    var mUp = vnorm(mapDir(vsub(sh, el), ub, mb, sx, g));
    var mLo = vnorm(mapDir(vsub(wr, el), ub, mb, sx, g));
    var bend = (mUp && mLo) ? clamp(vdot(mUp, mLo), -1, 1) : null;

    // A hand at the face is a gesture *about the head*, and measuring it out
    // from the shoulder in arm-lengths gets it wrong on exactly the models this
    // fork is for. A low-poly avatar has a big head on short arms, so its face
    // sits at a far steeper angle up from its shoulder than a person's does -
    // the direction is carried across faithfully and is faithfully wrong, and
    // the only way to land on the face is to raise the real hand well above
    // one's own head.
    //
    // So near the face, aim at the head: take the hand's offset from the
    // person's own nose, scale it by the two heads, and hang it off the model's
    // head bone. Blended in by how close the hand is, so nothing changes for an
    // arm that is not doing anything with the head.
    var anchorW = 0;
    var near = null;
    var headB = cfg.headAnchor > 0 ? headBone(c, vrm) : null;
    if (headB && vis(lm[LM_NOSE])) {
      // The nose is on the *front* of the face and the hands go on the back and
      // sides of the skull, so measuring from it calls a hand resting on the
      // nape 1.3 to 1.6 head-heights away - past HEAD_ON, most of the way to
      // HEAD_FAR - and the anchor is half gone for a hand that is touching the
      // head. Both hands go there at once, which is why the fault needed two
      // hands to show and why one hand, which tends to land higher and more to
      // the front, always looked right.
      //
      // The ears bracket the skull, so their midpoint sits inside it. That is
      // the point a hand on the head is near, whichever side it is on - and it
      // is also the better twin for `mHead`, the model's head bone, which sits
      // at the base of the skull rather than on the face.
      var nose = headRef(lm);
      var uH = vlen(vsub(nose, vmid(lm[ARM_LM.Right.shoulder], lm[ARM_LM.Left.shoulder])));
      var mHead = worldPos(headB);
      var mH = headHeight(c, headB);
      var toFace = vsub(wr, nose);
      if (uH > 1e-4 && mH > 1e-4) {
        // How near the hand is to the head, measured across the image and not
        // through it.
        //
        // A hand behind the head is the one place the depth estimate has
        // nothing to work from, and it is exactly the pose this test decides.
        // With both hands up, one wrist read 1.74 head-heights from the nose
        // while the other read 0.95 in the same symmetric pose - and 1.74 is
        // past HEAD_FAR, so that arm lost the anchor entirely and struck out on
        // its own while its twin stayed on the head. The lateral and vertical
        // components are measured, not guessed, and they are enough to say
        // whether a hand is at the head: nothing else in the body can be a head
        // -height away across the frame and not be near it.
        //
        // The offset below keeps all three axes. Being wrong about how far
        // through the head a hand sits only misplaces it slightly; being wrong
        // about whether it is there at all swaps the whole behaviour.
        var flatFace = vsub(toFace, vmul(ub.z, vdot(toFace, ub.z)));
        var flatH = vsub(nose, vmid(lm[ARM_LM.Right.shoulder], lm[ARM_LM.Left.shoulder]));
        flatH = vsub(flatH, vmul(ub.z, vdot(flatH, ub.z)));
        var flatLen = vlen(flatH);
        near = flatLen > 1e-4 ? vlen(flatFace) / flatLen : vlen(toFace) / uH;
        anchorW = clamp((HEAD_FAR - near) / (HEAD_FAR - HEAD_ON), 0, 1) * cfg.headAnchor;

        // Engaging is an observation; releasing may only be occlusion.
        //
        // Hands behind the head hide the wrists behind the skull, and the
        // tracker answers anyway - one arm read 0.67 head-heights from the nose
        // while its twin, in the same symmetric pose, read 1.21. There is no
        // arithmetic that recovers a wrist reported in the wrong place. What
        // there is: the wrist was in plain view on the way up, and it said the
        // hand was at the head.
        //
        // So a rising anchor is taken at once, and a falling one only counts
        // when the wrist is actually being seen. While it is a guess the last
        // engaged value stands - the same answer `coast` gives an arm that
        // leaves the frame, and the same one the palm roll gives when nothing
        // can see it.
        c.anch = c.anch || {};
        var held = c.anch[side];
        if (!instant && isNum(held) && anchorW < held && conf(wr) < SURE_VIS) {
          anchorW = held;
        }
        // World depth is the axis the tracker compresses, so a hand in front
        // of the face can sit at the skull in 3D while the video shows a palm
        // covering the mouth. The image is the ground truth for "at the head".
        var iNear = imgHeadNear(side);
        dbg.imgNear = iNear;
        if (iNear != null) {
          var iW = clamp((IMG_HEAD_FAR - iNear) / (IMG_HEAD_FAR - IMG_HEAD_ON), 0, 1)
            * cfg.headAnchor;
          if (iW > anchorW) anchorW = iW;
        }
        c.anch[side] = anchorW;
        if (anchorW > 0) {
          // the head bone sits at the base of the skull and the nose on the
          // front of the face, so the two scales are head-sized rather than
          // identical - which is all this needs them to be
          //
          // Never crush this offset's toward-camera axis: `armDepth` under 1
          // is a whole-arm direction gain, and using it here is what put every
          // covering hand off to the side of the face.
          var faceGain = { x: 1, y: 1, z: Math.max(cfg.armDepth, 1) };
          var faceOff = vmul(mapDir(toFace, ub, mb, sx, faceGain), mH / uH);
          // This palm is between the lens and the face. World z will not say
          // so - that is the compressed axis - so a covering hand's offset
          // sits on the skull and the IK has no point in front of the mouth
          // to reach. A palm's worth of head-heights along the chest is what
          // that pose looks like.
          dbg.occ = sideHitsFace(side);
          if (dbg.occ) {
            var stand = mH * 0.3;
            var along = vdot(faceOff, mb.z);
            if (along < stand) {
              faceOff = vadd(faceOff, vmul(mb.z, stand - along));
              dbg.stand = stand;
            }
          }
          off = vlerp(off, vsub(vadd(mHead, faceOff), worldPos(upper)), anchorW);
        }
      }
    }

    var t = now();

    // Mediapipe runs well under the render rate, so most frames re-use a target
    // that was measured milliseconds ago and the hand trails whatever it is
    // following. The velocity between the last two inferences says where that
    // target has got to since, so carry it forward by the age of the reading.
    // Capped hard: an extrapolation is a guess, and a guess that can move the
    // hand further than a knuckle is worse than the lag it removes.
    if (c.rawSeq[side] !== poseSeq) {
      var prev = c.raw[side];
      if (prev && poseLmAt > c.rawAt[side]) {
        var dtl = (poseLmAt - c.rawAt[side]) / 1000;
        c.vel[side] = (dtl > 1e-3 && dtl < 0.5) ? vmul(vsub(off, prev), 1 / dtl) : null;
      }
      c.raw[side] = off;
      c.rawAt[side] = poseLmAt;
      c.rawSeq[side] = poseSeq;
    }
    if (cfg.predict && c.vel[side]) {
      var age = Math.min((t - poseLmAt) / 1000, 0.12);
      var step = vmul(c.vel[side], age * cfg.predict);
      var cap = (a + b) * 0.15;
      var sl = vlen(step);
      if (sl > cap) step = vmul(step, cap / sl);
      off = vadd(off, step);
    }

    // Smooth the target rather than the bones, and only the target: the noise
    // is in the landmarks, and a second filter on the rotation afterwards would
    // just stack another lag on top of this one. Measured as an offset from the
    // shoulder, so walking the avatar around does not drag its hands behind it.
    var dt = c.at[side] ? Math.min((t - c.at[side]) / 1000, 0.1) : 0.016;
    c.at[side] = t;
    // the retarget has its own signal, so it runs the one-euro filter directly
    // on the hand target instead of going through `smooth`'s shared estimate
    var k = instant ? 1
      : euroAlpha(dt, c.vel[side] ? vlen(c.vel[side]) * scale : 0);
    if (!instant && c.off[side]) off = vlerp(c.off[side], off, k);
    c.off[side] = off;

    // Where the hand goes, fixed now, before the shoulder is allowed to move.
    // The landmarks already carry the person's own shrug, so re-offsetting from
    // a shoulder that has since risen would count that shrug twice and lift the
    // hand back off the head.
    var target = vadd(worldPos(upper), off);

    // Nothing upstream drives the shoulder bones, so a raised arm keeps its
    // shoulder pinned and the upper arm ends up cutting through the neck. Let
    // the shoulder turn part of the way toward the target; the hand stays where
    // it was, because the solve below re-reads the joint that just moved and
    // aims at the same point. All the shrug does is shorten the reach.
    var sb = shoulderBone(vrm, upper, side, mirrored);
    if (sb && cfg.shoulder > 0) {
      var seg = vnorm(upper.position);
      if (seg) {
        if (sb.parent) sb.parent.getWorldQuaternion(c.qB);
        else c.qB.set(0, 0, 0, 1);
        var restDir = qRotate(c.qB, qRotate(restQuat(sb), seg));
        var wantDir = vnorm(vsub(target, worldPos(sb)));
        var blend = wantDir && vnorm(vlerp(restDir, wantDir, cfg.shoulder));
        if (blend) aimBone(c, sb, upper, blend);
      }
    }
    c.sb[side] = sb || null;

    // an arm cannot be straighter than straight or fold past itself
    var S = worldPos(upper);
    var toT = vsub(target, S);
    var dir = vnorm(toT);
    if (!dir) return coast(c, side, upper, lower, hand);

    // The law of cosines run the other way: the person's own elbow angle on the
    // model's own bone lengths. `-1` is a straight arm and gives back a + b,
    // `+1` is folded shut and gives |a - b|, so the whole range still lands
    // inside what the arm can do. Reach stretches past that for a model whose
    // arms are too short to get to its own head - but it stretches from a bend
    // that is already right, instead of setting the bend.
    var want;
    if (bend == null) {
      want = vlen(toT);
    } else {
      want = Math.sqrt(Math.max(a * a + b * b - 2 * a * b * bend, 0));
      // Reach closes part of the gap to full extension, and only in proportion
      // to how extended the arm already is. Straining upward for the model's
      // own head gets the whole of it; an elbow folded at ninety degrees gets
      // almost none, so raising Reach to make the hands meet the head no longer
      // welds every other pose straight.
      if (sideReach(side) > 1) {
        // Reach may straighten the elbow, never iron it flat. It exists to get
        // a short-armed model to its own head; a bend that survives that is
        // still the person's bend.
        //
        // This used to add the whole of REACH_STRAIGHTEN to every pose, flat.
        // The comment claimed it was proportional and it was not: a measured
        // elbow of 132 degrees came out at 177, straight, over exactly the 45
        // the constant is worth - and it did that to every pose, which is the
        // welding it was written to prevent.
        //
        // Weight it by how extended the arm already is. `bend` is the cosine of
        // the elbow angle, so (1 - bend) / 2 runs 0 when folded shut to 1 when
        // straight, and the fourth power puts the stretch where the intent
        // always was: a nearly straight arm at 170 degrees keeps 97% of it, a
        // right angle keeps 6% - about three degrees, which is nothing.
        var ext = (1 - bend) / 2;
        ext *= ext; ext *= ext;
        var phi = Math.min(Math.acos(bend) + REACH_STRAIGHTEN * ext, Math.PI);
        var capped = Math.sqrt(Math.max(a * a + b * b - 2 * a * b * Math.cos(phi), 0));
        want = Math.min(want * sideReach(side), capped);
      }
    }
    // Right at the face, where the hand *is* is the whole point and the bend has
    // to give; away from it the bend is the honest signal and the distance
    // gives. Same blend either way, so there is no seam between them.
    if (anchorW > 0) want += (vlen(toT) - want) * anchorW;

    // the direction is filtered above; the bend has to be filtered too, or the
    // elbow is the one joint still chasing raw landmark noise
    if (!instant && isNum(c.elb[side])) want = c.elb[side] + (want - c.elb[side]) * k;
    c.elb[side] = want;

    // What this arm is really doing, for `PSX.armInfo()`. Written where every
    // term already exists rather than recomputed: a diagnostic that measures a
    // second version of the solve tells you about the second version.
    dbg.live = true;
    // the elbow the person is making, as a cosine; `armInfo` turns the pair
    // into the two angles worth comparing
    dbg.bend = bend;
    dbg.want = want;
    dbg.a = a;
    dbg.b = b;
    dbg.anchor = anchorW;
    dbg.near = near;
    dbg.wristSeen = conf(wr);
    // The two arms have the same bones, so a difference between these is the
    // tracker's error and nothing else - the one reading here that needs no
    // reference to interpret.
    dbg.upper = dist3(sh, el);
    dbg.fore = dist3(el, wr);
    // How far apart the two wrists are, against the person's own head. The
    // report is that the pose degrades as the hands converge, so it is the
    // number the rest has to be read against.
    dbg.gap = uH > 1e-4 ? dist3(lm[ARM_LM.Right.wrist], lm[ARM_LM.Left.wrist]) / uH : null;
    dbg.reach = sideReach(side);

    var d = clamp(want, Math.abs(a - b) + 1e-4, a + b - 1e-4);
    target = vadd(S, vmul(dir, d));

    // law of cosines: how far off the line to the target the upper arm has to
    // sit for the elbow to bend by the right amount
    var alpha = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
    var axis = vnorm(vcross(dir, pole || mb.z)) ||
      vnorm(vcross(dir, mb.y)) || mb.z;
    var upDir = rotAbout(dir, axis, alpha);
    var loDir = vnorm(vsub(target, vadd(S, vmul(upDir, a))));
    if (!loDir) return coast(c, side, upper, lower, hand);

    aimBone(c, upper, lower, upDir);
    aimBone(c, lower, hand, loDir);

    // The wrist, from the hand model when it has this hand and from Kalidokit's
    // Euler wrist when it does not. The Euler pose is not a failure case - it
    // is relative to a forearm this retarget has just placed correctly, so it
    // reads better here than it ever did on the stock rig - but it is a wrist
    // angle inferred from the arm, and the hand model is looking straight at
    // the thing it is measuring.
    var hw = handWant(side, mb, sx, depth);
    var hChild = hw ? handChild(vrm, side, mirrored) : null;
    if (hw && hChild) {
      // Filtered as a direction, on the target's own alpha. The wrist is the
      // noisiest joint in the chain and an unfiltered aim buzzes visibly, but
      // it must not get its own second filter either - that is another lag
      // stacked on the one the target already carries.
      var hf = hw.fwd;
      if (!instant && c.aim[side]) hf = vnorm(vlerp(c.aim[side], hf, k)) || hf;
      c.aim[side] = hf;
      aimBone(c, hand, hChild, hf);
    } else {
      c.aim[side] = null;
      // Kalidokit's wrist is only re-solved on a frame that had hand landmarks:
      //
      //   ["Right","Left"].forEach(o => { i[o] !== null && (tracking[o+"Hand"] = ...) })
      //
      // so with the hands lost it holds the flexion from whenever they were
      // last seen - which, for hands going up behind the head, is the pose with
      // the arms hanging down. That angle is relative to a forearm that has
      // since swung up, and replaying it puts the palms out sideways like wings.
      //
      // An angle from one pose on a forearm from another is worse than no angle
      // at all. With nothing watching the hand, the honest answer is the hand
      // in line with the forearm - which is a plausible hand in every pose,
      // where the stale one is a wrong hand in this one.
      var h = (poseHand && poseHand[side]) ? rig[side + 'Hand'] : null;
      if (!h) {
        var restH = restQuat(hand);
        var rk = instant ? 1 : clamp(smooth(0.04 + dt * 6), 0.002, 1);
        hand.quaternion.copy(rk >= 1 ? restH
          : c.keep.copy(hand.quaternion).slerp(restH, rk));
        dbg.handRest = true;
      }
      if (h) {
        var g = armGain();
        var wantQ = quatFromEuler(c.qA, num(h.x) * g, num(h.y) * sx * g, num(h.z) * sx * g);
        var hk = instant ? 1 : clamp(smooth(0.04 + dt * 6), 0.002, 1);
        hand.quaternion.copy(hk >= 1 ? wantQ : c.keep.copy(hand.quaternion).slerp(wantQ, hk));
      }
    }

    // Nothing upstream ever turns the forearm about its own axis, so the palm
    // stays wherever the bind pose left it - and "which way is the hand facing"
    // is almost all that axis. Neither wrist source can supply it: both report
    // flexion, relative to a forearm they estimated themselves and which the
    // retarget has since replaced.
    //
    // Measured last, once both bones are where they belong, and against the
    // model's own knuckles rather than an assumed axis. `aimBone` rewrites the
    // forearm from rest every frame, so this is an absolute reading each time,
    // not a correction stacking on the last one.
    //
    // Both vectors are in the model's space by the time they are compared, so
    // the angle between them is the angle to turn. The reflection in `mapDir`
    // is spent on carrying the target direction across and must not be spent a
    // second time on the rotation - doing that turned every palm the wrong way.
    if (cfg.twist > 0) {
      var wantAcross = hw ? hw.across
        : (vis(lm[idx.index]) && vis(lm[idx.pinky])
          ? vnorm(mapDir(vsub(lm[idx.index], lm[idx.pinky]), ub, mb, sx, depth))
          : null);
      var haveAcross = palmAcross(vrm, side, mirrored);
      var ang = (wantAcross && haveAcross)
        ? twistAngle(haveAcross, wantAcross, loDir) : null;
      // what the landmarks asked for, before the limit and the filter get to it
      dbg.hand = !!(hw && hChild);
      dbg.twist = ang;
      dbg.twistCapped = ang != null && Math.abs(ang) > 2.6;

      // Which way the palm ends up facing, against the way the head lies.
      //
      // A forearm has perhaps 150 degrees of pronation in total, and a hand put
      // behind the head has spent most of it getting there - so a palm facing
      // away from the skull in that pose is not a mistracked palm, it is a pose
      // no arm can make. A limit like that can be imposed without measuring
      // anything better, which is a different kind of fix from the ones tried
      // so far and probably the right one.
      //
      // Reported rather than enforced, because enforcing it needs to know which
      // face of the hand is the palm, and that sign is opposite on the two
      // hands. Getting it wrong inverts every palm - this file records having
      // done exactly that twice. The sign is cheap to settle by watching one
      // number against one pose, and impossible to settle by reasoning about a
      // bind pose that varies per model.
      //
      // +1 means this face of the hand looks at the head, -1 away from it.
      var pAcross = haveAcross;
      if (pAcross && headB) {
        var pNorm = vnorm(vcross(loDir, pAcross));
        var toHead = vnorm(vsub(worldPos(headB), worldPos(hand)));
        if (pNorm && toHead) dbg.palmDot = vdot(pNorm, toHead);
      }
      if (ang != null) {
        // a forearm does not rotate past about 150 degrees, and a landmark that
        // says it did is a landmark that has flipped the hand over
        ang = clamp(ang, -2.6, 2.6) * cfg.twist;
        if (!instant && isNum(c.roll[side])) ang = c.roll[side] + (ang - c.roll[side]) * k;
        c.roll[side] = ang;
        rollBone(c, lower, loDir, ang);
        // the roll turned the forearm, and the hand rode along with it
        if (hw && hChild) aimBone(c, hand, hChild, c.aim[side]);
      } else if (haveAcross && isNum(c.roll[side])) {
        // Nothing could read the palm this frame. Both hands up beside the head
        // is the case that does it: they hide each other and the skull, the
        // hand model drops both, and the pose's own knuckles go with them.
        //
        // Doing nothing is not neutral here. The solve rewrites the forearm
        // from its rest pose every frame, which is what lets the roll be read
        // as an absolute angle rather than a correction stacking on the last
        // one - so a frame that skips the roll does not leave the palm where it
        // was, it snaps it back to the bind pose. That is the flip: not a wrong
        // angle, an erased one.
        //
        // So hold the last angle that was read, the same answer `coast` gives
        // for an arm that goes out of view. A palm held from a moment ago is
        // right until the wrist turns; a palm at bind is wrong immediately.
        rollBone(c, lower, loDir, c.roll[side]);
        dbg.rollHeld = true;
        if (hw && hChild) aimBone(c, hand, hChild, c.aim[side]);
      }
    }

    // what `coast` replays if the next frame cannot see this arm
    var held = c.held[side];
    held.u.copy(upper.quaternion);
    held.l.copy(lower.quaternion);
    held.h.copy(hand.quaternion);
    if (c.sb[side]) held.s.copy(c.sb[side].quaternion);
    c.goodAt[side] = t;
    c.lostAt[side] = 0;
    return true;
  }

  // -------------------------------------------------- stripping app options
  //
  // A few of the app's own controls either do the same job as a PSX control,
  // only worse, or actively fight one. They are anchored here by the input's
  // name / aria-label rather than by its visible label, since those are stable
  // and the labels are not.
  //
  // Hiding alone is not enough - a hidden slider still holds its value - so
  // each is also driven to a harmless setting through its own input event,
  // which lets the app's own handler update its store. That is why none of
  // this needs a new call site in the bundle.

  var STRIP = [
    // Render scale does this before rasterising. The app's version renders at
    // full resolution and pixelates afterwards, so it costs more for a worse
    // result - and any non-zero value moves the whole scene onto the composer,
    // which drags a 60-sample god-rays pass along with it.
    { find: 'input[name="pixelSize"]', card: '.setting', pin: 0 },
    // Same composer cost, and outlines were never a PS1 thing.
    { find: 'input[name="outlineSize"]', card: '.setting', pin: 0 },
    // Composer again, plus a per-frame animation step.
    { aria: ['Animation Off', 'Animation On'], card: '.setting', pin: false },
    { aria: ['Disable Experiment', 'Enable Experiment'], card: '.setting', pin: false },
    // Light colour and the two light position sliders. A PSX avatar is lit by
    // its texture, not by a rig the viewer is meant to pose; these only give a
    // way to make it read worse. Hidden rather than pinned, so whatever the
    // scene is currently lit by stays as it is. The card also holds #temp,
    // which effectsContainer() anchors on - display:none keeps it findable.
    { find: 'input[name="lightRotX"]', card: '.setting' },
    // This one is not merely redundant. The app subtracts its smile value from
    // every vowel and from the blink, so it drags the mouth cells below the
    // expression threshold and the lip sync degrades. PSX.face also overwrites
    // the Joy it writes, so it has nothing left to contribute.
    //
    // The visible h4 is translated, so matching it by English text alone misses
    // the card in Portuguese. Match the original English (kept on __psxEn), the
    // Portuguese label, and the toggle's untranslated aria-label.
    { heading: 'Smile Detection [Beta]',
      aria: ['Enable Smile Detection', 'Disable Smile Detection'],
      card: '.list', pin: false },
    // Wink is not a preference. If the VRM has blink_l / blink_r cells, those
    // fire; if it only has blink, a wink still closes that one cell. The
    // toggle would only be an option to throw the weights away.
    { heading: 'Enable Wink',
      aria: ['Enable Wink Detection', 'Disable Wink Detection'],
      card: '.list', pin: true },
    // Corner HUD camera: selfie / first-person. A PSX avatar is framed like a
    // stage, not a phone. The same control is the only way out of selfie, so
    // pin it off before hiding or a leftover session would be stuck there.
    { dataText: ['Selfie Mode', 'First Person Mode'],
      card: '.menu-item', pin: false },
    // Peer-to-peer voice chat with a stranger's browser. Nothing to do with
    // driving a PSX avatar, and it owns a whole subnav of its own. Anchored on
    // the menu item's own "call" class rather than on its label: the label is
    // replaced by the live chat ID once a call connects.
    { find: '.menu-item.call', card: '.menu-item' },
    // Two toggles for one job: hide the preview, and hide the video inside
    // it. One remaining control drives both; this one is the spare.
    { heading: 'Hide Webcam Video', card: '.list' }
  ];

  // App headings we keep but rename. `__psxEn` stays the original so
  // headingMatches still finds the card after the label has changed.
  var RELABEL = { 'Hide Camera Panel': 'Hide camera' };

  function headingMatches(h, want) {
    var cur = (h.textContent || '').trim();
    var en = (h.__psxEn || '').trim();
    if (cur === want || en === want) return true;
    var pt = PT[want];
    return !!(pt && (cur === pt || en === pt));
  }

  function stripTarget(spec) {
    if (spec.heading) {
      var hs = document.querySelectorAll('h4');
      for (var j = 0; j < hs.length; j++) {
        if (!headingMatches(hs[j], spec.heading)) continue;
        var c = hs[j].closest(spec.card) || hs[j].parentElement;
        return { card: c, input: c && c.querySelector('input') };
      }
    }
    var el = null;
    if (spec.find) el = document.querySelector(spec.find);
    else if (spec.aria) {
      for (var i = 0; i < spec.aria.length && !el; i++) {
        el = document.querySelector('input[aria-label="' + spec.aria[i] + '"]');
      }
    } else if (spec.dataText) {
      var tagged = document.querySelectorAll('[data-text]');
      for (var d = 0; d < tagged.length && !el; d++) {
        var n = tagged[d];
        var cur = (n.getAttribute('data-text') || '').trim();
        var en = (n.__psxEnAttr || cur).trim();
        for (var k = 0; k < spec.dataText.length; k++) {
          if (cur === spec.dataText[k] || en === spec.dataText[k]) { el = n; break; }
        }
      }
    }
    return el ? { card: el.closest(spec.card) || el.parentElement || el, input: el } : null;
  }

  // Drive the app's own input so its handler runs; setting the property alone
  // would leave the store untouched.
  // Give up after a few attempts. This runs on every injection pass, so a value
  // the app refuses to accept - a slider with its own minimum, say - would mean
  // dispatching an event into it four times a second forever, and every one of
  // those is a re-render. The card is hidden either way, so a value that will
  // not stick is not worth a permanent loop.
  var PIN_TRIES = 3;

  function pin(input, want) {
    if (!input || want === undefined) return;
    if (input.__psxPinTries >= PIN_TRIES) return;
    if (typeof want === 'boolean' && input.tagName !== 'INPUT') {
      var on = !!(input.classList && input.classList.contains('selected'));
      if (on === want) return;
      input.click();
    } else if (typeof want === 'boolean') {
      if (input.checked === want) return;
      input.checked = want;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      if (parseFloat(input.value) === want) return;
      input.value = want;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    input.__psxPinTries = (input.__psxPinTries || 0) + 1;
  }

  function hide(node) {
    if (node && !node.__psxHidden) {
      node.style.display = 'none';
      node.__psxHidden = true;
    }
  }

  // Not conditional on PSX mode, and not a setting. This fork is for PSX-era
  // models; an option to bring back a control that costs performance and fights
  // a PSX one would only be an option to make it worse.
  function applyStrip() {
    for (var i = 0; i < STRIP.length; i++) {
      var t = stripTarget(STRIP[i]);
      if (!t) continue;
      pin(t.input, STRIP[i].pin);
      hide(t.card);
    }
    // Realtime shadows are off for good, so these two do nothing at all now.
    var sh = document.querySelector('input[name="shadowStrength"]');
    if (sh) hide(sh.closest('.setting'));
    syncCamHide();
  }

  // Hide Camera Panel and Hide Webcam Video were two switches for one intent.
  // The remaining one hides both: the wrapper (so the overlay paint stops)
  // and the video. Driven through the app's own inputs so its stores update.
  function syncCamHide() {
    var panel = stripTarget({ heading: 'Hide Camera Panel', card: '.list' });
    var video = stripTarget({ heading: 'Hide Webcam Video', card: '.list' });
    if (panel && panel.card) {
      var h = panel.card.querySelector('h4');
      if (h) {
        h.__psxEn = 'Hide Camera Panel';
        var want = T('Hide camera');
        if ((h.textContent || '').trim() !== want) h.textContent = want;
      }
    }
    if (!panel || !panel.input || !video || !video.input) return;
    if (!panel.input.__psxCamHide) {
      panel.input.__psxCamHide = true;
      panel.input.addEventListener('change', function () {
        syncCamHide();
      });
    }
    var on = !!panel.input.checked;
    if (video.input.checked === on) return;
    video.input.checked = on;
    video.input.dispatchEvent(new Event('change', { bubbles: true }));
  }


  // ------------------------------------------------------------ translation
  //
  // English strings are the keys, so an untranslated one falls through to
  // itself rather than to a blank label. The same table also drives the app's
  // own hardcoded labels, which are not in its i18n tables at all: it ships an
  // en/ru map for the menu buttons only, and even that never switches, because
  // the language store is built as J("en") and the navigator.languages lookup
  // beside it is evaluated and thrown away.

  var PT = {
    // --- Effects / render ---
    'PSX Render': 'Render PSX',
    'Render scale': 'Escala de render',
    'Vertex snapping': 'Snap de vértices',
    'Snap grid': 'Grade do snap',
    'Dither': 'Dithering',
    'Colour depth': 'Profundidade de cor',
    '3 bit': '3 bits',
    '4 bit': '4 bits',
    '5 bit (PS1)': '5 bits (PS1)',
    '6 bit': '6 bits',
    'Reload to apply': 'Recarregar para aplicar',

    // --- expressions ---
    'Face Expressions': 'Expressões faciais',
    'Trigger threshold': 'Limiar de disparo',
    'Release margin': 'Margem de liberação',
    'Minimum hold': 'Tempo mínimo',
    'Mouth gain': 'Ganho da boca',
    'Preview cell': 'Pré-visualizar célula',
    'live tracking': 'rastreio ao vivo',
    'Load a VRM to calibrate individual cells.': 'Carregue um VRM para calibrar células individuais.',

    // --- emotions ---
    'Emotion Detection': 'Detecção de emoções',
    'Signal gain': 'Ganho do sinal',
    'Brow offset': 'Deslocamento da sobrancelha',
    'Eyes': 'Olhos',
    'Eyes shut at': 'Olhos fechados em',
    'line at': 'linha em',
    'Calibrate blink': 'Calibrar piscar',
    'Blink calibrated': 'Piscar calibrado',
    'Eyes open, look at the camera': 'Olhos abertos, olhando para a câmera',
    'Relaxed - not wide, just how you normally sit':
      'Relaxados - nao arregalados, do jeito que voce normalmente fica',
    'Eyes read almost the same open and shut - redo it, holding them properly shut.':
      'Os olhos leem quase igual abertos e fechados - refaca, mantendo-os bem fechados.',
    'Furrow your brows, eyes open': 'Franza as sobrancelhas, olhos abertos',
    'Angry face - brows down and together, but keep your eyes open':
      'Cara de bravo - sobrancelhas para baixo e juntas, mas mantenha os olhos abertos',
    'Angry - pull them down and together, and keep your eyes open':
      'Bravo - puxe para baixo e junte, e mantenha os olhos abertos',
    'Furrow closes the eye by': 'Franzir fecha o olho em',
    'that much is discounted while the brows are down.':
      'isso é descontado enquanto as sobrancelhas estão baixas.',
    'eyes': 'olhos',
    'open': 'aberto',
    'shut': 'fechado',
    'span': 'faixa',
    'Angry at': 'Bravo a partir de',
    'Sorrow at': 'Triste a partir de',
    'Smile at': 'Sorriso a partir de',
    'Emotion hold': 'Espera da emoção',
    'waiting for a tracked face...': 'aguardando um rosto rastreado...',
    'Calibrate expressions': 'Calibrar expressões',
    'Cancel calibration': 'Cancelar calibração',
    'Calibrate motion': 'Calibrar movimento',
    'Calibrate vowels': 'Calibrar vogais',
    'Vowel hold': 'Segurar vogal',
    'Mouth calibrated': 'Boca calibrada',
    'mouths recorded': 'bocas gravadas',
    'Smile, showing your teeth': 'Sorria mostrando os dentes',
    'The big one, teeth and all, and hold it':
      'O sorrisão, com dentes, e segure',
    'These read almost the same:': 'Estas ficaram quase iguais:',
    'Redo those, exaggerating the shape and voicing the sound out loud.':
      'Refaça essas, exagerando o formato e falando o som em voz alta.',
    'Close your mouth': 'Feche a boca',
    'Lips together, relaxed - this is what silence looks like':
      'Lábios juntos, relaxado - é assim que o silêncio se parece',
    'Say "aaah" and hold it': 'Fale "ááá" e segure',
    'As in f-a-ther. Jaw open': 'Como em p-a-to. Mandíbula aberta',
    'Say "ehh" and hold it': 'Fale "êêê" e segure',
    'As in b-e-d': 'Como em p-e-na',
    'Say "eee" and hold it': 'Fale "iii" e segure',
    'As in s-ee. Lips wide': 'Como em v-i-da. Lábios esticados',
    'Say "ooh" and hold it': 'Fale "óóó" e segure',
    'As in g-o. Lips rounded': 'Como em b-o-la. Lábios arredondados',
    'Say "oooo" and hold it': 'Fale "uuu" e segure',
    'As in b-oo-t. Lips pushed forward': 'Como em l-u-a. Lábios projetados',
    'Capture (Space)': 'Capturar (Espaço)',
    'Reading...': 'Lendo...',
    'Hold the pose, then press Space. Esc cancels.':
      'Faça a pose, segure, e aperte Espaço. Esc cancela.',
    'Get into the pose - reading in': 'Faça a pose - lendo em',
    'Space reads now, Esc cancels.': 'Espaço lê agora, Esc cancela.',
    'Reading, keep holding...': 'Lendo, continue segurando...',
    'Only': 'Apenas',
    'frames were read - hold the pose and try that step again.':
      'frames foram lidos - segure a pose e refaça esse passo.',
    'The poses moved a lot while being read; redo it holding stiller for a tighter fit.':
      'As poses se mexeram bastante durante a leitura; refaça segurando mais firme para um ajuste melhor.',
    'Face the camera': 'Encare a câmera',
    'Turn your head left': 'Vire a cabeça para a esquerda',
    'Turn your head right': 'Vire a cabeça para a direita',
    'As far as is comfortable, and hold': 'Até onde for confortável, e segure',
    'Look up': 'Olhe para cima',
    'Tilt your head back and hold': 'Incline a cabeça para tras e segure',
    'Look down': 'Olhe para baixo',
    'Tilt your chin down and hold': 'Incline o queixo para baixo e segure',
    'Barely any head movement was tracked. Is face tracking running?':
      'Quase nenhum movimento de cabeça foi detectado. O rastreio facial está ligado?',
    'No face was tracked during': 'Nenhum rosto foi detectado durante',
    'Start face tracking and try again.': 'Ligue o rastreio facial e tente de novo.',
    'Calibrated': 'Calibrado',
    'These barely moved:': 'Estes quase não se mexeram:',
    'Redo that step with a bigger expression if it does not trigger.':
      'Refaça esse passo com uma expressão maior se ele não disparar.',
    'furrow': 'franzir',
    'raise': 'levantar',
    'smile': 'sorriso',
    'blink': 'piscada',
    'hand on face': 'mão no rosto',
    'brow drift': 'deriva da sobrancelha',
    'poses with their own span': 'poses com amplitude propria',
    'turn': 'giro',
    'tilt': 'inclinacao',
    'neutral': 'neutro',

    // --- calibration prompts ---
    'Relax your face': 'Relaxe o rosto',
    'Neutral, looking at the camera, eyes open':
      'Neutro, olhando para a câmera, olhos abertos',
    'Furrow your brows': 'Franza as sobrancelhas',
    'Angry - pull them down and together': 'Bravo - puxe para baixo e para o centro',
    'Raise your brows': 'Levante as sobrancelhas',
    'Surprised - lift them as high as you can': 'Surpreso - levante o máximo que conseguir',
    'Smile wide': 'Sorria bastante',
    'Big smile, and hold it': 'Sorriso grande, e segure',
    'Close your eyes': 'Feche os olhos',
    'Still facing the camera, and hold them shut':
      'Ainda de frente para a câmera, e segure fechados',
    'Turn a little left, relax your face':
      'Vire um pouco à esquerda, relaxe o rosto',
    'About half a turn - the angle you use glancing at a second screen':
      'Uns metade da virada - o ângulo de olhar para um segundo monitor',
    'Turn ~40° left, relax your face':
      'Vire uns 40° à esquerda, relaxe o rosto',
    'Still turned left - furrow your brows':
      'Ainda virado à esquerda - franza as sobrancelhas',
    'Still turned left - raise them':
      'Ainda virado à esquerda - levante elas',
    'Same angle. Do not turn back toward the camera':
      'O mesmo ângulo. Não volte a cabeça para a câmera',
    'Same angle, as high as you can':
      'O mesmo ângulo, o mais alto que conseguir',
    'Turn a little right, relax your face':
      'Vire um pouco à direita, relaxe o rosto',
    'About half a turn, the other way':
      'Uns metade da virada, para o outro lado',
    'Turn ~40° right, relax your face':
      'Vire uns 40° à direita, relaxe o rosto',
    'Still turned right - furrow your brows':
      'Ainda virado à direita - franza as sobrancelhas',
    'Still turned right - raise them':
      'Ainda virado à direita - levante elas',
    'Tilt your head back a little, relax your face':
      'Incline a cabeça um pouco para trás, relaxe o rosto',
    'About half of the full tilt': 'Uns metade da inclinação inteira',
    'Look up, relax your face': 'Olhe para cima, relaxe o rosto',
    'Still looking up - furrow your brows':
      'Ainda olhando para cima - franza as sobrancelhas',
    'Still looking up - raise them': 'Ainda olhando para cima - levante elas',
    'Chin still up': 'Queixo ainda levantado',
    'Chin still up, as high as you can':
      'Queixo ainda levantado, o mais alto que conseguir',
    'Dip your chin a little, relax your face':
      'Abaixe um pouco o queixo, relaxe o rosto',
    'About half of the full dip, eyes open':
      'Uns metade do abaixamento inteiro, olhos abertos',
    'Look down, relax your face': 'Olhe para baixo, relaxe o rosto',
    'Still looking down - furrow your brows':
      'Ainda olhando para baixo - franza as sobrancelhas',
    'Still looking down - raise them': 'Ainda olhando para baixo - levante elas',
    'Chin still down': 'Queixo ainda abaixado',
    'Chin still down, as high as you can':
      'Queixo ainda abaixado, o mais alto que conseguir',
    'Head turned, looking past the camera, brows relaxed':
      'Cabeça virada, olhando além da câmera, sobrancelhas relaxadas',
    'Hold that left turn, close your eyes':
      'Mantenha a virada à esquerda, feche os olhos',
    'Same angle, eyes shut': 'O mesmo ângulo, olhos fechados',
    'Turn ~40° right, eyes open': 'Vire uns 40° à direita, olhos abertos',
    'Head turned the other way, brows relaxed':
      'Cabeça virada para o outro lado, sobrancelhas relaxadas',
    'Hold that right turn, close your eyes':
      'Mantenha a virada à direita, feche os olhos',
    'Look up, eyes open': 'Olhe para cima, olhos abertos',
    'Tilt your head back, brows relaxed, do not squint':
      'Incline a cabeça para trás, sobrancelhas relaxadas, sem apertar os olhos',
    'Look down, eyes open': 'Olhe para baixo, olhos abertos',
    'Chin down, eyes open, brows relaxed':
      'Queixo para baixo, olhos abertos, sobrancelhas relaxadas',
    'get ready': 'prepare-se',
    'hold': 'segure',
    'Calibration cancelled.': 'Calibração cancelada.',

    // --- motion ---
    'Motion Calibration': 'Calibragem de movimento',
    'Head / neck gain': 'Ganho de cabeça / pescoço',
    'Torso gain': 'Ganho do torso',
    'Torso lean gain': 'Ganho de inclinação do torso',
    'Head-tilt isolation': 'Isolar inclinação da cabeça',
    'Tilt your head to one side': 'Incline a cabeça para um lado',
    'Ear toward your shoulder - keep your shoulders level':
      'Orelha em direção ao ombro - mantenha os ombros nivelados',
    'Steadiness': 'Firmeza',
    'Responsiveness': 'Resposta',
    'Prediction': 'Predição',
    'Dropout hold': 'Segurar na perda',
    'Arm gain': 'Ganho dos braços',
    'Reach': 'Alcance',
    'Reach up': 'Alcance para cima',
    'Calibration cues': 'Avisos da calibragem',
    'Fine tuning': 'Ajuste fino',
    'Low power preset': 'Preset de baixo consumo',
    'Profile': 'Perfil',
    'note.novoice': 'Este navegador não tem nenhuma voz de fala instalada, então as ' +
      'instruções faladas ficam mudas - os bipes e o texto na tela continuam ' +
      'funcionando. No Raspberry Pi OS, instalar um motor de fala dá uma lista ' +
      'de vozes ao Chromium.',
    'note.lowpower': 'Metade da escala de render, render a 30fps, rastreio a 20fps e o ' +
      'modelo de pose leve - o que faz isto rodar numa máquina pequena, num lugar ' +
      'só. As duas opções de modelo valem no próximo carregamento.',
    'Motion calibration done': 'Calibragem de movimento concluída',
    'It came out good.': 'Ficou boa.',
    'It came out poor - run it again.': 'Ficou ruim - rode de novo.',
    'Calibration done': 'Calibragem concluída',
    'Cancelled.': 'Cancelada.',
    'No head movement was tracked. Check the camera.':
      'Nenhum movimento de cabeça foi rastreado. Verifique a câmera.',
    'Right arm': 'Braço direito',
    'Left arm': 'Braço esquerdo',
    'up': 'cima',
    'depth': 'profundidade',
    'Per arm': 'Por braço',
    'Fit': 'Ajuste',
    'over': 'sobre',
    'samples': 'amostras',
    'Check': 'Conferência',
    'good': 'bom',
    'redo this': 'refaça a calibragem',
    'Straight arms - draw big slow circles':
      'Braços retos - faça círculos grandes e lentos',
    'straighten your elbows': 'estique bem os cotovelos',
    'sweep ignored - it disagreed with the depth pose, so the elbows were probably bent':
      'giro ignorado - discordou da pose de profundidade, provavelmente os cotovelos estavam dobrados',
    'Elbows completely straight, as if reaching for a far wall. Sweep both arms around: out to the sides, up overhead, forward at the camera, down by your legs. Bend an elbow and that moment is thrown away - watch the sample count rise.':
      'Cotovelos totalmente esticados, como se fosse alcançar uma parede distante. Gire os dois braços: para os lados, acima da cabeça, à frente da câmera, embaixo junto às pernas. Se dobrar o cotovelo, aquele instante é descartado - acompanhe a contagem de amostras subir.',
    'Once more, to check the result': 'Mais uma vez, para conferir o resultado',
    'Skipped - no body tracking was read for that step.':
      'Pulado - nenhum rastreio de corpo foi lido nesse passo.',
    'Same circles, elbows just as straight. This step only measures - it cannot make anything worse.':
      'Mesmos círculos, cotovelos igualmente retos. Este passo só mede - não piora nada.',
    'Shoulder follow': 'Acompanhamento do ombro',
    'Forearm twist': 'Torção do antebraço',
    'Face anchor': 'Âncora no rosto',
    'Head straight, shoulders square, arms down':
      'Cabeça reta, ombros alinhados, braços baixos',
    'Put both hands on your head': 'Ponha as duas mãos na cabeça',
    'Hold completely still': 'Fique completamente parado',
    'Do not move at all - this reads how noisy your camera is':
      'Não se mexa nada - isto mede o quanto sua câmera é ruidosa',
    'Lean your torso to one side': 'Incline o tronco para um lado',
    'Sway from the waist as far as is comfortable, and hold':
      'Dobre pela cintura até onde for confortável, e segure',
    'Shrug your shoulders up': 'Levante os ombros',
    'Lift both shoulders toward your ears and hold':
      'Erga os dois ombros na direção das orelhas e segure',
    'Arms straight out to the sides': 'Braços esticados para os lados',
    'Shoulder height, elbows locked, like a T. Needs full-body tracking.':
      'Na altura dos ombros, cotovelos travados, em T. Precisa de rastreio corporal.',
    'Point one arm at the camera': 'Aponte um braço para a câmera',
    'Elbow straight, hand toward the lens, and hold':
      'Cotovelo esticado, mão na direção da lente, e segure',
    'Palms on your skull, elbows out. Needs full-body tracking.':
      'Palmas no crânio, cotovelos para fora. Precisa de rastreio corporal.',

    // --- performance ---
    'Performance': 'Desempenho',
    'Auto throttle': 'Ajuste automático',
    'Run while hidden': 'Rodar em segundo plano',
    'Tracking rate': 'Taxa de rastreio',
    'Render rate': 'Taxa de render',
    'Iris / lip refinement': 'Refino de iris / labios',
    'Lite pose model': 'Modelo de pose leve',
    'uncapped': 'sem limite',

    // --- hands / diagnostics ---
    'PSX Hands': 'Mãos PSX',
    'Driven fingers': 'Dedos animados',
    'all fingers': 'todos os dedos',
    'thumb only': 'só o polegar',
    'none': 'nenhum',
    'Presets': 'Predefinidas',
    'Saved': 'Salvas',
    'saved colours': 'cores salvas',
    'Save colour': 'Salvar cor',
    'Update colour': 'Atualizar cor',
    'Delete colour': 'Apagar cor',
    'Chroma green': 'Verde chroma key',
    'Transparent': 'Transparente',
    'No colours saved yet': 'Nenhuma cor salva ainda',
    'note.bgColour': 'O seletor guarda uma cor só, e não havia como manter uma segunda nem descartar uma que você não usa mais. Clique num quadrinho para aplicar a cor e carregá-la no seletor para editar; × apaga. O app nunca gravava a lista de fundos, então as cores salvas ficam junto com o resto dos ajustes - sobrevivem ao reload, e um perfil exportado leva elas junto.',
    'Export settings': 'Exportar ajustes',
    'Import settings': 'Importar ajustes',
    'Settings imported': 'Ajustes importados',
    'That file is not PSX settings': 'Esse arquivo não é de ajustes PSX',
    'expression calibration': 'calibragem de expressões',
    'vowel calibration': 'calibragem de vogais',
    'motion calibration': 'calibragem de movimento',
    'imported': 'importada',
    'not in the file': 'não estava no arquivo',
    'unusable, kept the current one': 'inválida, mantida a atual',
    'Reset PSX settings': 'Restaurar ajustes PSX',
    'Language': 'Idioma',
    'English': 'English',
    'Portuguese (BR)': 'Português (BR)',

    // --- notes ---
    'note.eyes': 'Uma linha só: o quanto o olho precisa parecer fechado para a célula de olho fechado assumir. Onde esse número cai é propriedade dos teus olhos, dos óculos e de onde a câmera está, não do piscar - por isso vale medir; um olho bem aberto quase nunca lê perto de zero. A leitura mostra o valor ao vivo, a linha contra a qual ele está sendo julgado e de que lado ele está; arraste até uma piscada cruzar e um rosto relaxado não. Calibrar piscar define isso a partir de duas poses, na metade entre as duas, e uma terceira pose mede o quanto franzir as sobrancelhas fecha o olho sozinho - isso é descontado enquanto as sobrancelhas estão baixas, que é o que impede a cara de bravo de ficar piscando sozinha.',
    'note.reloadRender': 'A escala de render e aplicada ao recarregar.',
    'note.reloadPerf': 'As opções do modelo Mediapipe são aplicadas ao recarregar. Os limites de taxa valem na hora.',
    'note.emotions': 'O app so rastreia piscadas, as cinco vogais e um sorriso. Bravo, triste e fun nunca são escritos - isto os deriva da sobrancelha e da boca para que essas células possam disparar. Faça cada careta e observe a leitura para ajustar os limiares. ' +
      'A espera da emoção é quanto tempo a sobrancelha tem que ficar passada do limiar antes de virar expressão: um pico enquanto a cabeça gira dura um ou dois frames, uma careta é segurada. Só a subida espera. ' +
      'Deslocamento da sobrancelha empurra a leitura pronta na mão, para um rosto que o mapeamento ainda lê um pouco fora do zero. ' +
      'A sobrancelha agora é medida contra a lateral do teu próprio rosto, e não atravessando o olho, então ela encurta junto com a sobrancelha em vez de contra: girar, inclinar ou deitar a cabeça quase não mexe na leitura. A calibragem grava o que sobra, e as duas coisas juntas são o motivo de olhar para o lado não ler mais como bravo.',
    'note.motion': 'Os ganhos de pescoço e torso são fixos no app, entao um movimento real pequeno vira um movimento grande no avatar. Baixe o ganho para mexer menos. Tudo que o assistente consegue medir na tua própria câmera - o quanto você gira de verdade, o quanto a câmera treme, quanto de uma inclinação de torso é na verdade a cabeça, até onde teus braços alcançam - ele ajusta sozinho; o que sobra aqui é o punhado de números que é questão de gosto.',
    'note.armIK': 'Mira o braço na mão que a câmera viu, em vez de repetir os ângulos do Kalidokit - é o que faz a mão chegar de fato na cabeça. Precisa de rastreio corporal (holistic). Alcance corrige a proporção de um modelo de braço curto. O ombro não é animado por nada no app, então acompanhamento do ombro solta ele um pouco e o braço erguido para de cortar o pescoço. Um frame em que a malha do rosto e a pose do corpo discordam sobre onde teu rosto está quer dizer que uma das duas te perdeu - esses são segurados em vez de seguidos, com limiares aprendidos da tua própria câmera.',
    'note.mouth': 'O app reporta cinco pesos de vogal que sobem todos juntos com a mandíbula, então um deles ganha diga o que disser e a boca acaba com um formato aberto só. Isto grava o que o teu rosto marca enquanto você fala cada vogal em voz alta, e escolhe a gravação mais próxima do frame atual - silêncio incluído, que é o que libera a célula da boca para o sorriso. Segurar vogal é o quanto outra vogal precisa estar mais perto para a boca trocar de célula.',
    'note.adaptive': 'Um amortecimento fixo tem que escolher: o suficiente para assentar uma pose parada vira borracha num movimento rápido, e o suficiente para o movimento rápido deixa o tremor. Isto filtra forte quando você está parado e quase nada quando você se mexe. Firmeza é o quanto uma pose parada é filtrada - o passo de ficar parado na calibragem mede isso na sua própria câmera. Resposta é a rapidez com que ele solta quando você se mexe.',
    'note.perf': 'O app roda uma inferencia do Mediapipe a cada frame e renderiza a cada frame. A taxa de rastreio é onde vai quase toda a CPU. ' +
      'O ajuste automático larga taxa de rastreio sozinho enquanto a máquina não dá conta - OBS gravando, um render rodando - e devolve quando sobra folga. ' +
      'Os limites fixos abaixo continuam valendo por cima dele. ' +
      'Rodar em segundo plano mantém os dois loops vivos com a janela minimizada ou coberta ' +
      'por outra: o Chromium para os animation frames de uma janela que não está mostrando, ' +
      'que é de onde vem o avatar congelando no meio da live. Custa o que os limites deixarem, ' +
      'e só enquanto nada está na tela.',

    // --- the app's own menu, drawn from data-text attributes ---
    'Start Face Tracking': 'Iniciar rastreio facial',
    'Stop Face Tracking': 'Parar rastreio facial',
    'Characters': 'Personagens',
    'Stickers': 'Adesivos',
    'Backgrounds': 'Fundos',
    'Call a friend': 'Ligar para um amigo',
    'Accessories': 'Acessórios',
    'Picture-in-Picture': 'Picture-in-Picture',
    'Selfie Mode': 'Modo selfie',
    'First Person Mode': 'Modo primeira pessoa',
    'Flip Camera': 'Inverter câmera',
    'Settings': 'Ajustes',
    'Effects': 'Efeitos',
    'Hide Controls': 'Ocultar controles',
    'Show Controls': 'Mostrar controles',
    'FACE / EYE': 'ROSTO / OLHOS',
    'FULL BODY': 'CORPO INTEIRO',

    // --- the app's own hardcoded labels ---
    'Light Color': 'Cor da luz',
    'Light Position X': 'Posição da luz X',
    'Light Position Y': 'Posição da luz Y',
    'Shadow Strength': 'Força da sombra',
    'Shadow Blur': 'Desfoque da sombra',
    'Outline Size': 'Espessura do contorno',
    'Outline Color': 'Cor do contorno',
    'Pixelate': 'Pixelizar',
    'Water Animation': 'Animação de água',
    'Light Cube Experiment': 'Experimento do cubo de luz',
    'Body Tracking Options': 'Opções de rastreio corporal',
    'Enable Wink': 'Ativar piscadela',
    'Smile Detection [Beta]': 'Detecção de sorriso [Beta]',
    'Room Tracking': 'Rastreio de ambiente',
    'Leg Tracking [WIP]': 'Rastreio de pernas [WIP]',
    'Hide Camera Panel': 'Ocultar painel da câmera',
    'Hide Webcam Video': 'Ocultar vídeo da webcam',
    'Hide camera': 'Ocultar câmera',
    'Change Camera': 'Trocar câmera',
    'Reset Character Tracking': 'Reiniciar rastreio do personagem',
    'For eyetracking, use both face and full body tracking.':
      'Para rastreio ocular, use rastreio facial e de corpo inteiro juntos.',
    'Allow webcam access to see câmera list.':
      'Permita o acesso à webcam para ver a lista de cameras.'
  };

  var EN = {
    'note.novoice': 'This browser has no speech voices installed, so the spoken ' +
      'prompts are silent - the beeps and the on-screen prompt still work. On ' +
      'Raspberry Pi OS, installing a speech engine gives Chromium a voice list.',
    'note.lowpower': 'Half render scale, 30fps render, 20fps tracking and the lite ' +
      'pose model - the settings that make this run on a small machine, in one ' +
      'place. The two model options apply on reload.',
    'note.eyes': 'One line: how shut an eye has to look before the shut cell takes ' +
      'over. Where that number falls is a property of your eyes, your glasses and ' +
      'where the camera sits, not of blinking, so it is worth measuring - a wide-open ' +
      'eye rarely reads near zero. The readout shows the live reading, the line it is ' +
      'being judged against, and which side it is on; drag until a blink crosses and ' +
      'a relaxed face does not. Calibrate blink sets it from two poses, halfway ' +
      'between the two, and a third pose measures how far furrowing your brows closes ' +
      'the eye on its own - that much is discounted while the brows are down, which is ' +
      'what stops an angry face blinking at itself.',
    'note.reloadRender': 'Render scale applies on reload.',
    'note.reloadPerf': 'The Mediapipe model options apply on reload. ' +
      'The rate caps take effect immediately.',
    'note.emotions': 'The app only tracks blinks, the five vowels and a smile. Angry, ' +
      'sorrow and fun are never written at all - this derives them from the brow and ' +
      'mouth so those cells can fire. Pull each face and watch the readout to set the ' +
      'thresholds. Emotion hold is how long the brow has to stay past one before it ' +
      'is written: a spike while the head turns lasts a frame or two, a face making ' +
      'an expression holds it. Only the rise waits. Brow offset shifts the ' +
      'finished reading by hand, for a face the mapping still reads a little ' +
      'off zero. The brow itself is now measured ' +
      'against the side of your own face rather than across your eye, so it ' +
      'foreshortens with the brow instead of against it: turning, tilting or ' +
      'rolling your head barely moves the reading at all. Calibrating records ' +
      'what is left, and the two together are why a glance to the side no longer ' +
      'reads as angry.',
    'note.motion': 'The neck and torso gains are hardcoded upstream, so a small real ' +
      'movement lands as a large avatar movement. Lower the gain to move less. ' +
      'Everything the wizard can measure off your own camera - how far you actually ' +
      'turn, how steady the camera is, how much of a torso lean is really a head ' +
      'tilt, how far your arms reach - it sets for itself; what is left here is the ' +
      'handful of numbers that are a matter of taste.',
    'note.armIK': 'Aims the arm at the hand the camera saw instead of replaying ' +
      'Kalidokit’s angles - this is what gets the hand onto the head at all. Needs ' +
      'full-body (holistic) tracking. Reach corrects for a short-armed model. ' +
      'Nothing upstream drives the shoulder at all, so shoulder follow lets it turn ' +
      'a little and keeps a raised arm out of the neck. A frame where the face mesh ' +
      'and the body pose disagree about where your face is means one of them has ' +
      'lost you - those are coasted rather than followed, on thresholds learned from ' +
      'your own camera.',
    'note.bgColour': 'The picker keeps one colour, and there was no way to keep a '
      + 'second one or drop one you are done with. Click a swatch to apply it and '
      + 'load it back into the picker to edit; × deletes it. The app never wrote '
      + 'its background list to storage, so saved colours are kept with the rest of '
      + 'the settings instead - they survive a reload, and an exported profile '
      + 'brings them with it.',
    'note.mouth': 'Upstream reports five vowel weights that all rise together with '
      + 'the jaw, so one of them wins whatever you say and the mouth ends up with a '
      + 'single open shape. This records what your own face reads while you say each '
      + 'vowel out loud, and picks whichever recording a live frame lands nearest - '
      + 'silence included, which is what frees the mouth cell for a smile. Vowel hold '
      + 'is how much closer another vowel has to be before the mouth swaps cell.',
    'note.adaptive': 'A flat damping factor has to choose: enough to settle a held ' +
      'pose turns a fast move to rubber, enough for the fast move leaves the tremor ' +
      'in. This filters hard while you are still and barely at all while you move. ' +
      'Steadiness is how hard a motionless pose is filtered - the hold-still ' +
      'calibration step measures it off your own camera. Responsiveness is how ' +
      'quickly that lets go once you move.',
    'note.perf': 'Upstream runs a Mediapipe inference on every animation frame, renders ' +
      'on every animation frame. The ' +
      'tracking rate is where nearly all the CPU goes. Auto throttle sheds that rate on ' +
      'its own while the machine cannot keep up - OBS recording, an export running - and ' +
      'takes it back when the headroom returns. The fixed caps below still apply on top. ' +
      'Run while hidden keeps both loops going while the window is minimised or covered by ' +
      'another window: Chromium stops animation frames for a window it is not showing, which ' +
      'is where the avatar freezing mid-stream comes from. It costs whatever the caps allow, ' +
      'and only while nothing is on screen.'
  };

  function T(en) {
    if (cfg.lang !== 'pt') return EN[en] === undefined ? en : EN[en];
    var v = PT[en];
    if (v !== undefined) return v;
    return EN[en] === undefined ? en : EN[en];
  }

  // ------------------------------------------------------------- integrity
  //
  // Every hook above only fires because a call to it was written into the
  // minified bundle. Those edits are invisible once committed and do not
  // survive the bundle being regenerated - and this project syncs with Glitch,
  // so that happens. When it does, psx.js still loads, still builds its panels,
  // and silently does nothing at all, because nothing ever calls it.
  //
  // So: count the call sites in the bundle that is actually running and say
  // which ones are missing. tools/patch.mjs puts them back.

  var EXPECTED_HOOKS = {
    setupRenderer: 1, aa: 1, smaa: 1, fingers: 1, onModel: 1, tick: 1,
    face: 1, brow: 1, headGain: 1, bodyGain: 1, leanGain: 1, spineLean: 1, armGain: 1,
    smooth: 7, frame: 1, nextTrack: 1,
    mpOptions: 2, shadows: 1, shadowSize: 4, overlay: 3, overlayOpen: 1, gaze: 1,
    pose: 1, hands: 1, arm: 1, guide: 1, bg: 1, bgDrop: 1
  };

  function verify() {
    var el = document.querySelector('script[type="module"][src]');
    if (!el || typeof fetch !== 'function') {
      console.warn('[psx] cannot reach the bundle to check it');
      return;
    }
    return fetch(el.src).then(function (r) { return r.text(); }).then(function (src) {
      var bad = [];
      var total = 0;
      for (var k in EXPECTED_HOOKS) {
        total++;
        // the trailing word boundary stops PSX.overlay from also counting
        // every PSX.overlayOpen
        var re = new RegExp('window\\.PSX\\.' + k + '\\b', 'g');
        var n = (src.match(re) || []).length;
        if (n !== EXPECTED_HOOKS[k]) {
          bad.push('  PSX.' + k + ': ' + n + ' call site(s), expected ' + EXPECTED_HOOKS[k]);
        }
      }
      var name = el.getAttribute('src');
      if (!bad.length) {
        console.log('[psx] ' + name + ': all ' + total + ' hooks present');
      } else {
        console.warn('[psx] ' + name + ' is missing PSX hooks - the layer is ' +
          'loaded but partly inert. Run:  node tools/patch.mjs');
        console.warn(bad.join(String.fromCharCode(10)));
      }
      return bad;
    }).catch(function (e) {
      console.warn('[psx] could not read the bundle:', e);
    });
  }

  // ------------------------------------------------------- subnav overlay
  //
  // The panel's dark background is not a CSS background - it is an animated SVG
  // shape that grows to cover the panel. Its component drops any animate() call
  // that arrives while an animation is already running, and only flips `isOpen`
  // when one finishes. The caller then asks `isOpen` whether it needs to open.
  //
  // Click two tabs quickly and those two facts combine badly: pick a new tab
  // while the close animation is still playing, `isOpen` still reads true, so
  // the caller decides nothing needs opening - and when the close lands, the
  // shape is gone while the panel is open. The panel's content renders over the
  // 3D canvas with no background behind it, which is the chroma key bleeding
  // through.
  //
  // So: remember the state each request is heading to, and hold the request that
  // arrived mid-animation instead of dropping it.

  // The one the subnav animates. Captured rather than looked up: it is a
  // component instance, not a node, and the only reference to it the app ever
  // offers is the one it passes here.
  var subnavShape = null;

  function overlayOpen(inst) {
    if (!inst) return false;
    return inst.__psxWant === undefined ? !!inst.isOpen : inst.__psxWant;
  }

  function overlay(inst, opts) {
    if (!inst) return;
    subnavShape = inst;
    if (opts && (opts.action === 'open' || opts.action === 'close')) {
      inst.__psxWant = opts.action === 'open';
    }
    if (inst.transition) {
      // last request wins; anything older is already stale
      inst.__psxQueued = opts;
      watchOverlay(inst);
      return;
    }
    inst.animate(opts);
  }

  // The component exposes `transition` but nothing to subscribe to, so poll it
  // for the length of one animation rather than reaching into its internals.
  function watchOverlay(inst) {
    if (inst.__psxWatching) return;
    inst.__psxWatching = true;
    (function step() {
      if (inst.transition) { requestAnimationFrame(step); return; }
      inst.__psxWatching = false;
      var q = inst.__psxQueued;
      if (!q) return;
      inst.__psxQueued = null;
      // it may have landed where we wanted anyway
      var open = q.action === 'open';
      if ((q.action === 'open' || q.action === 'close') && !!inst.isOpen === open) return;
      inst.animate(q);
    })();
  }

  // ------------------------------------------------------------ performance
  //
  // Upstream runs a Mediapipe inference on every animation frame and renders on
  // every animation frame, with two lights casting 2048x2048 shadow maps. On a
  // PSX avatar all three are overkill: the models are flat and untextured by
  // modern standards, and the era's own cadence was 20-30fps.

  // Not options. This fork targets PSX-era models and the performance that goes
  // with them, and the console had no realtime shadows at all - it stamped a
  // blob on the floor. Leaving them on costs two extra full-scene depth passes
  // per frame, from two lights at 2048x2048, for something the look does not
  // want. The size still answers because the bundle asks, but nothing is
  // allocated while shadowMap.enabled is false.
  function shadows() { return false; }
  function shadowSize() { return 256; }

  // Eye aim, called instead of lookAt.applyer.lookAt(). PSX faces put the eyes
  // on the texture atlas - they blink by swapping a cell, they do not swivel -
  // so pointing the eye bones at a solved pupil is wasted work and reads wrong.
  // The eyes stay at their bind pose, facing forward.
  function gaze() {}

  // ----------------------------------------------------------- tracking guide
  //
  // Every Mediapipe result repaints the preview canvas at the video's own
  // resolution: the pose skeleton, both hands, and FACEMESH_TESSELATION - some
  // two and a half thousand 2D line segments, on the same thread the inference
  // just finished on. The app keeps doing all of it after the preview is put
  // away, because closing it only sets the wrapper's opacity to 0.
  //
  // So skip the paint while nothing can see it. Cached, because the answer is
  // asked once per inference and reading it back touches the DOM.
  var GUIDE_RECHECK = 400;
  var guideAt = 0;
  var guideOn = true;

  function guide(canvas) {
    var t = now();
    if (t - guideAt < GUIDE_RECHECK) return guideOn;
    guideAt = t;
    // the preview's own wrapper, not any `.hide` ancestor - the subnav and the
    // menu carry that class too, and neither of them says anything about this
    var box = canvas && canvas.closest && canvas.closest('#drag-cam');
    guideOn = !box || !box.classList.contains('hide');
    return guideOn;
  }

  // Called with whatever options object is about to reach setOptions - Holistic
  // spells the refinement flag one way, FaceMesh another, so touch whichever
  // keys are actually present.
  function mpOptions(opts) {
    if (!opts) return opts;
    // Kalidokit Face.brow / Face.eye return 0 / eyes-stuck-open unless they
    // see 478 landmarks (the 10 iris points). The brow and lid math only
    // uses the 468 mesh, but the solver gates on the count. Forcing this
    // off made angry/sorrow dead and blink never close. Gaze is still a
    // no-op; we only need the extra points. Holistic and FaceMesh spell
    // the flag differently.
    if ('refineFaceLandmarks' in opts) opts.refineFaceLandmarks = true;
    if ('refineLandmarks' in opts) opts.refineLandmarks = true;
    if ('modelComplexity' in opts) opts.modelComplexity = cfg.poseLite ? 0 : 1;
    log('mediapipe options', opts);
    return opts;
  }

  // ---------------------------------------------------------- auto throttle
  //
  // This runs beside OBS, and beside whatever else is on the machine. That
  // load is not something a fixed cap can be chosen for in advance: a rate
  // that is comfortable with nothing else running drops frames the moment an
  // editor starts an export. The caps above are still there for anyone who
  // wants to pick a number; this watches instead.
  //
  // Only the tracking rate is shed. That is where nearly all the CPU goes, and
  // it is the one that degrades gracefully - a face solved twenty times a
  // second still looks alive, where a render at twenty does not, and dropping
  // the render resolution mid-session reframes the shot that is being captured.
  //
  // Nothing here assumes a display rate. The fastest frame interval this
  // machine has actually delivered is the target, learned the way the sanity
  // gate learns its gap: a hard-coded 16.7 would be a cap tuned to one monitor,
  // and this fork already has one screen's worth of that lesson.
  var AUTO_MIN = 12;        // never shed past this - below it the face reads as
                            //   broken rather than economical
  var AUTO_MAX = 60;        // at the ceiling this does nothing at all
  var AUTO_SLACK = 1.5;     // an interval this far over the learned best is a
                            //   dropped frame rather than jitter
  var AUTO_EASY = 1.15;     // and this far under it is headroom to take back
  var AUTO_DOWN = 6;        // shed fast, take back slowly, so a spike is
  var AUTO_UP = 2;          //   absorbed instead of chased
  var AUTO_EVERY = 700;     // ms between decisions
  var AUTO_WARM = 20;       // frames behind a decision before it is acted on

  var autoFps = AUTO_MAX;
  var autoBest = 0;
  var autoAcc = 0, autoN = 0, autoAt = 0, autoSeen = 0;
  // what the tracking loop is actually managing, inference included
  var trackMs = 0, trackSeen = 0;
  // the frame interval that was standing when the rate was last shed, so the
  // next decision can ask whether shedding bought anything
  var autoShed = 0;
  var AUTO_WORTH = 0.97;    // an interval has to come down by this much for the
                            //   cut that preceded it to count as having worked

  function autoNote(dt) {
    // A frame the tab was not rendering at all - the machine did not fail to
    // deliver it, nobody asked for it - and the first frame after, which
    // carries that whole gap.
    if (dt > 500) { autoAcc = 0; autoN = 0; autoAt = now(); return; }
    autoAcc += dt;
    autoN++;
    var t = now();
    if (t - autoAt < AUTO_EVERY || autoN < AUTO_WARM) return;
    var avg = autoAcc / autoN;
    autoAcc = 0; autoN = 0; autoAt = t;
    // The best decays back up slowly, so a machine that genuinely got slower -
    // a laptop dropped to battery, a window moved to a 60Hz second monitor -
    // is followed instead of being measured forever against a number it can no
    // longer reach.
    if (!autoBest || avg < autoBest) autoBest = avg;
    else autoBest += (avg - autoBest) * 0.02;
    if (avg > autoBest * AUTO_SLACK) {
      // Shedding only helps while this app is the thing taking the time. When
      // a cut buys nothing, the load is somebody else's - an export, a game,
      // a capture encoding - and cutting further costs the face without
      // buying a frame back. Hold at whatever the last cut that worked left,
      // and let it climb again when the machine frees up.
      if (autoShed && avg > autoShed * AUTO_WORTH) { autoShed = avg; return; }
      // The ceiling is 60 and holistic never reaches it, so shedding from the
      // ceiling spends several decisions cutting a rate nothing was using -
      // the machine keeps stuttering while the number comes down through
      // figures the tracker was already under. Start from what it is really
      // achieving, so the first decision is the first one that bites.
      var got = trackMs > 1 ? 1000 / trackMs : autoFps;
      autoFps = Math.max(AUTO_MIN, Math.min(autoFps, got) - AUTO_DOWN);
      autoShed = avg;
    } else if (avg < autoBest * AUTO_EASY) {
      autoFps = Math.min(AUTO_MAX, autoFps + AUTO_UP);
      autoShed = 0;
    }
  }

  // What it is doing, for anyone wondering why the face slowed down.
  function perfInfo() {
    return {
      auto: cfg.perfAuto,
      trackFps: cfg.trackFps, renderFps: cfg.renderFps, poseLite: cfg.poseLite,
      autoFps: r2(autoFps),
      frameMs: r2(autoBest),
      trackHz: trackMs > 1 ? r2(1000 / trackMs) : null,
      throttling: cfg.perfAuto && autoFps < AUTO_MAX,
      keepAwake: cfg.keepAwake, hidden: !!document.hidden, onClock: awake
    };
  }

  // ------------------------------------------------------- hidden windows

  // Chromium hands out no animation frames to a window it is not showing, and
  // on Windows "not showing" includes a window that is merely covered by
  // another one - which during a stream is most of the time. Both loops here
  // end in requestAnimationFrame, so the avatar freezes mid-shot and comes
  // back only when the window is raised again.
  //
  // Timers are no way around it either: a hidden page has setTimeout clamped
  // to once a second. The one clock that still runs on time is the audio
  // thread, which has to be fed or the output glitches - so while the page is
  // hidden we borrow it and run the callbacks the animation frame would have
  // run. None of it exists while the page is visible: the graph is suspended
  // and the shim below is a passthrough.

  var rafNative = window.requestAnimationFrame;
  var cafNative = window.cancelAnimationFrame;
  var awake = false;
  var awakeCtx = null, awakeNode = null;

  // Callbacks handed to the native animation frame and not yet fired. Carrying
  // those across the moment the window is hidden is the whole trick: each loop
  // re-arms only from inside its own callback, so the one frame it already has
  // in flight *is* the chain, and a chain dropped there never restarts.
  // Knowing when one has fired needs a wrapper, and a closure per animation
  // frame is an allocation in the hottest path there is - so the wrappers are
  // built once and a callback takes a free slot.
  var SLOTS = 8;
  var slotFn = [], slotId = [], slotWrap = [];

  function addSlot(i) {
    slotFn.push(null);
    slotId.push(0);
    slotWrap.push(function (t) {
      var fn = slotFn[i];
      slotFn[i] = null;
      if (fn) fn(t);
    });
  }
  for (var slot = 0; slot < SLOTS; slot++) addSlot(slot);

  // Two arrays swapped on every tick, so a callback that re-arms itself lands
  // in the next tick instead of growing the one being drained - and neither
  // array is ever reallocated.
  var qA = [], qB = [], queue = qA, queueId = 0;

  function awakeTick() {
    if (!queue.length) return;
    var due = queue;
    queue = due === qA ? qB : qA;
    queue.length = 0;
    var t = now();
    for (var i = 0; i < due.length; i += 2) {
      var fn = due[i + 1];
      due[i + 1] = null;
      if (fn) fn(t);
    }
  }

  function rafShim(fn) {
    if (awake) {
      // negative, so it can never collide with a real animation-frame id
      var id = --queueId;
      queue.push(id, fn);
      return id;
    }
    for (var i = 0; i < SLOTS; i++) {
      if (slotFn[i]) continue;
      slotFn[i] = fn;
      slotId[i] = rafNative.call(window, slotWrap[i]);
      return slotId[i];
    }
    // More in flight than the loops ever hold at once. Hand it straight over:
    // it will not survive the window being hidden, which is exactly what a
    // one-shot did before any of this existed.
    return rafNative.call(window, fn);
  }

  function cafShim(id) {
    if (id < 0) {
      for (var i = 0; i < queue.length; i += 2) {
        if (queue[i] === id) { queue[i + 1] = null; return; }
      }
      return;
    }
    for (var j = 0; j < SLOTS; j++) {
      if (slotId[j] === id) slotFn[j] = null;
    }
    return cafNative.call(window, id);
  }

  window.requestAnimationFrame = rafShim;
  window.cancelAnimationFrame = cafShim;

  // Moving the in-flight frames between the two clocks, in whichever direction
  // the window just went.
  function handOver(toClock) {
    var i, fn;
    if (toClock) {
      for (i = 0; i < SLOTS; i++) {
        if (!slotFn[i]) continue;
        cafNative.call(window, slotId[i]);
        queue.push(--queueId, slotFn[i]);
        slotFn[i] = null;
      }
      return;
    }
    var due = queue;
    queue = due === qA ? qB : qA;
    queue.length = 0;
    for (i = 0; i < due.length; i += 2) {
      fn = due[i + 1];
      due[i + 1] = null;
      if (fn) rafShim(fn);
    }
  }

  function awakeStart() {
    if (awake || !cfg.keepAwake) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      if (!awakeCtx) {
        awakeCtx = new AC();
        // 512 frames is ~11ms, finer than any rate cap in this panel, so the
        // caps stay the thing that decides the rate. A ScriptProcessor rather
        // than an AudioWorklet because a worklet is a second file to fetch and
        // parse for a callback that does nothing but tick. It writes nothing
        // into its output buffer, so what reaches the muted gain is silence.
        awakeNode = awakeCtx.createScriptProcessor(512, 1, 1);
        awakeNode.onaudioprocess = awakeTick;
        var mute = awakeCtx.createGain();
        mute.gain.value = 0;
        awakeNode.connect(mute);
        mute.connect(awakeCtx.destination);
      }
    } catch (e) {
      log('no background clock available', e);
      return;
    }
    awake = true;
    handOver(true);
    // resume() wants a user gesture to have happened at some point, and one
    // has: the camera does not start without one. If it is refused anyway,
    // give the frames back to the animation frame rather than sit on them -
    // that is a face frozen until the window is raised, which is where this
    // started, rather than a face frozen for good.
    try {
      var p = awakeCtx.resume();
      if (p && p['catch']) {
        p['catch'](function (e) { log('background clock refused', e); awakeStop(); });
      }
    } catch (e) { log('background clock refused', e); awakeStop(); }
  }

  function awakeStop() {
    if (!awake) return;
    awake = false;
    handOver(false);
    try { if (awakeCtx) awakeCtx.suspend(); } catch (e) {}
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) awakeStart();
    else awakeStop();
  });

  // The tracking loop awaits its inference, so the gap between iterations is
  // inference time plus whatever we wait here. Measure from the start of the
  // last cycle so the rate holds steady instead of drifting slower.
  var trackAt = 0;

  function nextTrack(fn) {
    // One call per completed cycle, so the gap between two of them is what the
    // tracker is managing end to end. A gap long enough to be a tab that was
    // not running is not a rate.
    var tn = now();
    if (trackSeen && tn - trackSeen < 2000) {
      var gap = tn - trackSeen;
      trackMs = trackMs ? trackMs + (gap - trackMs) * 0.2 : gap;
    }
    trackSeen = tn;

    var fps = cfg.trackFps;
    if (cfg.perfAuto) fps = fps ? Math.min(fps, autoFps) : autoFps;
    // At the ceiling there is nothing to wait for: hand it straight back to the
    // animation frame, which is what upstream does.
    if (!fps || fps >= AUTO_MAX) return requestAnimationFrame(fn);
    var t = now();
    var wait = Math.max(0, trackAt + (1000 / fps) - t);
    trackAt = t + wait;
    // setTimeout is clamped to once a second on a hidden page, so a rate cap
    // set through it would drop tracking to 1Hz exactly where the audio clock
    // has just gone to the trouble of keeping it alive. On the clock the wait
    // is counted off in ticks instead. One tracking loop exists, so one
    // pending slot is all it can ever need - and it costs no closure.
    if (awake) {
      trackDue = t + wait;
      trackFn = fn;
      return rafShim(trackPump);
    }
    return setTimeout(function () { requestAnimationFrame(fn); }, wait);
  }

  var trackDue = 0, trackFn = null;

  function trackPump() {
    if (now() < trackDue) { rafShim(trackPump); return; }
    var fn = trackFn;
    trackFn = null;
    if (fn) fn();
  }

  var frameAt = 0;

  function frame() {
    // Measured before the render cap, and whether or not one is set: this is
    // how fast the machine is handing out animation frames, which is the
    // question, and a capped render answers a different one.
    var seen = now();
    if (autoSeen) autoNote(seen - autoSeen);
    autoSeen = seen;

    var fps = cfg.renderFps;
    if (fps) {
      var t = now();
      // a few ms of slack, or a 30fps budget would keep missing 60Hz ticks by a
      // hair and land on 20
      if (t - frameAt < (1000 / fps) - 4) return false;
      frameAt = t;
    }
    // only on frames that really render, so the smoothing dt is the interval
    // the bones are actually lerped over
    stepMotionClock();
    return true;
  }

  // ------------------------------------------------------------------ models

  var models = [];

  function registerModel(vrm, gltf) {
    if (!vrm) return vrm;
    vrm.__psxGltf = gltf || null;
    var at = models.indexOf(vrm);
    if (at !== -1) models.splice(at, 1);
    models.push(vrm);
    // collect first: this may swap in cloned textures, and the filter pass
    // below has to run on whatever textures end up attached
    vrm.__psxUvBinds = collectUvBinds(vrm, gltf);
    if (vrm.__psxUvBinds) log('driving', vrm.__psxUvBinds.length, 'material(s) via _MainTex_ST');
    applyTextureFilter(vrm);
    eachMaterial(vrm, hookMaterial);
    syncShaderUniforms();
    scheduleInject();
    return vrm;
  }

  function refreshModels() {
    for (var i = 0; i < models.length; i++) {
      applyTextureFilter(models[i]);
      if (!models[i].__psxUvBinds) {
        models[i].__psxUvBinds = collectUvBinds(models[i], models[i].__psxGltf);
        applyTextureFilter(models[i]);
      }
      // snap mode only writes on a cell change, so drop the latch or a
      // threshold / flip-V edit would not show until the expression changes
      var binds = models[i].__psxUvBinds;
      if (binds) {
        binds.forEach(function (e) { e.current = null; e.currentCell = null; e.since = 0; });
      }
    }
  }

  function expressionKeys() {
    var keys = [];
    for (var i = 0; i < models.length; i++) {
      var binds = models[i].__psxUvBinds;
      if (!binds) continue;
      binds.forEach(function (e) {
        if (e.neutral && keys.indexOf('neutral') === -1) keys.push('neutral');
        e.cells.forEach(function (c) { if (keys.indexOf(c.key) === -1) keys.push(c.key); });
      });
    }
    return keys;
  }

  // Force one expression weight and freeze it, so you can see whether the
  // texture actually moves. PSX.test() with no args hands control back.
  var held = {};

  function test(key, weight) {
    var vrm = models[models.length - 1];
    if (!vrm || !vrm.blendShapeProxy) { console.warn('[psx] no model'); return; }
    if (key === undefined) { held = {}; console.log('[psx] hold cleared'); return; }
    if (weight === undefined) weight = 1;
    held[key] = weight;
    if (!weight) delete held[key];
    console.log('[psx] holding', held);
  }

  var lastPreview = '';

  function applyHeld(vrm) {
    if (!vrm.blendShapeProxy) return;
    if (cfg.preview) {
      lastPreview = cfg.preview;
      var keys = expressionKeys();
      for (var i = 0; i < keys.length; i++) {
        vrm.blendShapeProxy.setValue(keys[i], keys[i] === cfg.preview ? 1 : 0);
      }
      return;
    }
    if (lastPreview) {
      // the tracker only rewrites the presets it drives, so zero the rest once
      // or the previewed cell stays pinned after leaving preview
      lastPreview = '';
      var all = expressionKeys();
      for (var k = 0; k < all.length; k++) vrm.blendShapeProxy.setValue(all[k], 0);
    }
    for (var hk in held) vrm.blendShapeProxy.setValue(hk, held[hk]);
  }

  // ------------------------------------------------------------- diagnostics

  function dump(vrm) {
    vrm = vrm || models[models.length - 1];
    if (!vrm) { console.warn('[psx] no model loaded'); return; }
    var proxy = vrm.blendShapeProxy;
    console.group('[psx] ' + (vrm.name || 'model'));

    if (!proxy) {
      console.warn('no blendShapeProxy - this VRM has no blendShapeMaster at all');
    } else {
      var presetMap = proxy.blendShapePresetMap || {};
      console.log('preset -> group:', presetMap);
      console.log('unknown (non-preset) groups:', proxy.unknownGroupNames);
      var wanted = ['blink', 'blink_l', 'blink_r', 'a', 'i', 'u', 'e', 'o', 'joy'];
      var emotionMissing = EMOTION_KEYS.filter(function (p) { return !presetMap[p]; });
      if (emotionMissing.length) {
        console.warn('emotion presets this model does NOT map:', emotionMissing.join(', '));
      }
      if (lastFace) {
        console.log('last solved face - brow ' + lastFace.brow.toFixed(3) +
          ', smile ' + lastFace.smile.toFixed(3) +
          (lastFace.poseRest != null
            ? ' (pose rest ' + lastFace.poseRest.toFixed(3) +
              ', raw ' + lastFace.raw.brow.toFixed(3) + ')'
            : '') +
          (faceOcc ? ' [hand on face]' : '') +
          ' ->', lastFace.out);
      } else {
        console.warn('no face has been solved yet - is face tracking running?');
      }
      var missing = wanted.filter(function (p) { return !presetMap[p]; });
      if (missing.length) {
        console.warn('presets the app drives but the model does NOT map:', missing.join(', '));
      } else {
        console.log('all presets the app drives are mapped');
      }
    }

    var ext = vrm.__psxGltf && vrm.__psxGltf.parser && vrm.__psxGltf.parser.json &&
      vrm.__psxGltf.parser.json.extensions && vrm.__psxGltf.parser.json.extensions.VRM;

    console.log('psx config:', JSON.parse(JSON.stringify(cfg)));

    var sceneMats = [];
    eachMaterial(vrm, function (m) {
      sceneMats.push({
        name: m.name, type: m.type,
        map: m.map ? (m.map.name || '(unnamed)') : '(none)',
        hasMainTexST: m.mainTex_ST !== undefined
      });
    });
    console.log('materials in scene:');
    console.table(sceneMats);

    if (ext && ext.blendShapeMaster) {
      var mvRows = [];
      (ext.blendShapeMaster.blendShapeGroups || []).forEach(function (g) {
        (g.materialValues || []).forEach(function (mv) {
          var key = (g.presetName && g.presetName !== 'unknown') ? g.presetName : g.name;
          var hit = sceneMats.some(function (m) {
            return m.name === mv.materialName || m.name === mv.materialName + ' (Outline)';
          });
          mvRows.push({
            key: key, materialName: mv.materialName, matched: hit,
            propertyName: mv.propertyName, targetValue: JSON.stringify(mv.targetValue)
          });
        });
      });
      console.log('raw materialValues from the VRM:');
      console.table(mvRows);
      var unmatched = mvRows.filter(function (r) { return !r.matched; });
      if (unmatched.length) {
        console.warn('materialValues whose materialName matches NO material in the scene:',
          unmatched.map(function (r) { return r.materialName; }).join(', '));
      }
    }
    if (ext && ext.materialProperties) {
      var shaders = {};
      ext.materialProperties.forEach(function (m) { shaders[m.shader] = (shaders[m.shader] || 0) + 1; });
      console.log('shaders:', shaders);
    }

    var binds = vrm.__psxUvBinds;
    if (!binds) {
      console.error('PSX is driving NOTHING on this model (__psxUvBinds is empty).');
      console.error('-> either the VRM has no blendShapeMaster materialValues for ' +
        '_MainTex_ST, no materialName matched, or the matched material has no .map. ' +
        'See the tables above.');
    } else {
      console.log('PSX is driving ' + binds.length + ' material(s):');
      console.table(binds.map(function (b) {
        return {
          material: b.material.name,
          showing: b.current || '(neutral)',
          hasNeutralCell: !!b.neutral,
          cells: b.cells.map(function (d) { return d.key; }).join(' ')
        };
      }));
      console.log('resolved UV per cell (three.js space):');
      var cellRows = [];
      binds.forEach(function (b) {
        var n = b.neutral ? toThreeUv(b.neutral, b.flipV) : b.base;
        cellRows.push({
          material: b.material.name, cell: '(neutral)',
          offset: n.ox.toFixed(3) + ', ' + n.oy.toFixed(3),
          repeat: n.rx.toFixed(3) + ', ' + n.ry.toFixed(3)
        });
        b.cells.forEach(function (c) {
          var u = toThreeUv(c.unity, b.flipV);
          cellRows.push({
            material: b.material.name, cell: c.key,
            offset: u.ox.toFixed(3) + ', ' + u.oy.toFixed(3),
            repeat: u.rx.toFixed(3) + ', ' + u.ry.toFixed(3)
          });
        });
      });
      console.table(cellRows);
    }

    var h = vrm.humanoid;
    if (h) {
      var fingerBones = [];
      ['left', 'right'].forEach(function (side) {
        ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].forEach(function (f) {
          ['Proximal', 'Intermediate', 'Distal'].forEach(function (seg) {
            if (h.getBoneNode(side + f + seg)) fingerBones.push(side + f + seg);
          });
        });
      });
      console.log('finger bones present (' + fingerBones.length + '):', fingerBones.join(', ') || '(none)');
    }
    console.groupEnd();
  }

  // ----------------------------------------------------------------- panel UI
  //
  // Rebuilds the app's own markup: <container> > .setting cards, with h4
  // headings, styled range inputs and the same checkbox-backed toggle.
  // All class names below are the app's scoped Svelte hashes - keep them.
  //
  // The controls are split across two tabs, by what they actually do:
  //
  //   Effects  - the render look: PSX mode, texture filtering, AA, render
  //              scale. Sits next to the app's own Pixelate / Outline effects.
  //   Settings - per-model calibration: expression cells, thresholds, gains,
  //              hands. Sits next to the app's own tracking options.
  //
  // These are two separate Svelte components with near-identical scoped CSS, so
  // each card is built with the scope of the panel hosting it. Range, toggle and
  // hr styling only exists in the Effects scope, so those widgets carry FX
  // wherever they are used.

  var FX = 'svelte-2t25z9';   // Effects panel scope (also: range/toggle/hr CSS)
  var STG = 'svelte-1krauxh'; // Settings panel scope (also: .trigger buttons)
  var TG = 'svelte-yzrsaq';   // Toggle component scope

  // Keys the app only reads once, at startup: the renderer flags, the shadow
  // map setup, and the Mediapipe model options.
  // The labels are baked into the DOM when a card is built, so switching
  // language means throwing the cards away and building them again.
  var REBUILDS = { lang: 1 };

  var NEEDS_RELOAD = {
    pixelRatio: 1, poseLite: 1
  };
  // Snap-mode UV only writes on a cell change, so these have to drop the latch
  // or a new threshold would sit there until the expression itself changed.
  // Nothing else needs that - and doing it on every slider tick is what made
  // hold/hysteresis look broken and the face chatter while you dragged.
  var LATCH_KEYS = { threshold: 1, hysteresis: 1, holdMs: 1, preview: 1 };
  var pendingReload = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.setAttribute('class', cls);
    if (text != null) n.textContent = text;
    return n;
  }

  function heading(text, readout, sc) {
    var h = el('h4', sc || FX, text);
    if (readout != null) {
      var s = el('span', null, readout);
      s.style.marginLeft = 'auto';
      s.style.opacity = '.55';
      s.style.fontWeight = '400';
      h.appendChild(s);
      h.__readout = s;
    }
    return h;
  }

  // The document says what language it is in, which is not the same question as
  // what the labels say. A screen reader picks its voice off this attribute and
  // the browser offers to translate a page whose declared language is not the
  // reader's - and it shipped hardcoded `en` while the whole UI was Portuguese.
  function applyDocLang() {
    var root = document.documentElement;
    if (!root) return;
    var want = cfg.lang === 'pt' ? 'pt-BR' : 'en';
    if (root.getAttribute('lang') !== want) root.setAttribute('lang', want);
  }

  function liveChange(key) {
    if (NEEDS_RELOAD[key]) {
      pendingReload = true;
      var notes = document.querySelectorAll('.psx-reload-note');
      Array.prototype.forEach.call(notes, function (n) { n.style.display = ''; });
      return;
    }
    applyCanvasFilter();
    syncShaderUniforms();
    // Turning the cues off hides the "this machine has no voice" note with
    // them: it is an explanation of a switch that is now off.
    if (key === 'calCues') syncVoiceNote();
    if (REBUILDS[key]) { applyDocLang(); rebuildPanels(); }
    if (LATCH_KEYS[key]) refreshModels();
  }

  function onChange(key) {
    save();
    liveChange(key);
  }

  var controls = [];

  function fpsLabel(v) { return v ? v + ' fps' : 'uncapped'; }

  function addRange(parent, key, label, min, max, step, fmt, sc) {
    var h = heading(label, fmt(cfg[key]), sc);
    var input = el('input', FX);
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = cfg[key];
    input.setAttribute('aria-label', label);
    input.setAttribute('name', 'psx-' + key);

    function paint() {
      var pct = (cfg[key] - min) / (max - min) * 100;
      input.style.backgroundSize = pct + '% 100%';
      if (h.__readout) h.__readout.textContent = fmt(cfg[key]);
    }
    input.addEventListener('input', function () {
      cfg[key] = parseFloat(input.value);
      paint();
      liveChange(key);
    });
    input.addEventListener('change', function () { save(); });
    paint();
    parent.appendChild(h);
    parent.appendChild(input);
    controls.push({
      key: key, node: input,
      sync: function () {
        if (document.activeElement === input) return;
        input.value = cfg[key];
        paint();
      }
    });
    return input;
  }

  function addToggle(parent, key, label, sc) {
    var row = el('div', 'toggle ' + FX);
    // The switch is a 24px knob inside an 11px track with overflow:visible, so
    // it hangs ~5px past the row. The app never notices because its toggles are
    // always last in a card; ours are followed by sliders, and the knob landed
    // on top of the next heading.
    row.style.minHeight = '24px';
    row.style.marginBottom = '6px';
    var h = el('h4', sc || FX, label);
    h.style.margin = '0';

    var lab = el('label', TG);
    lab.setAttribute('name', label);
    var input = el('input', TG);
    input.type = 'checkbox';
    input.setAttribute('aria-label', label);
    input.checked = !!cfg[key];
    var cont = el('container', TG);
    var track = el('div', 'track ' + TG);
    track.innerHTML = '<div class="toggleButton ' + TG + '">' +
      '<i class="kalicon notranslate fill small ' + TG + '">jellyfill</i></div>';
    cont.appendChild(track);
    lab.appendChild(input);
    lab.appendChild(cont);

    function paint() {
      input.checked = !!cfg[key];
      lab.setAttribute('class', (cfg[key] ? 'toggled' : '') + ' ' + TG);
    }
    input.addEventListener('change', function () {
      cfg[key] = input.checked;
      paint();
      onChange(key);
    });
    paint();

    row.appendChild(h);
    row.appendChild(lab);
    parent.appendChild(row);
    controls.push({ key: key, node: row, sync: paint });
    return row;
  }

  function addChoice(parent, key, label, values, labels, sc) {
    var h = heading(label, labels[values.indexOf(cfg[key])] || cfg[key], sc);
    var input = el('input', FX);
    input.type = 'range';
    input.min = 0; input.max = values.length - 1; input.step = 1;
    input.value = Math.max(0, values.indexOf(cfg[key]));
    input.setAttribute('aria-label', label);
    input.setAttribute('name', 'psx-' + key);

    function paint() {
      var idx = Math.max(0, values.indexOf(cfg[key]));
      input.value = idx;
      input.style.backgroundSize = (idx / (values.length - 1) * 100) + '% 100%';
      if (h.__readout) h.__readout.textContent = labels[idx];
    }
    input.addEventListener('input', function () {
      cfg[key] = values[parseInt(input.value, 10)];
      paint();
      liveChange(key);
    });
    input.addEventListener('change', function () { save(); });
    paint();
    parent.appendChild(h);
    parent.appendChild(input);
    controls.push({
      key: key, node: input,
      sync: function () {
        if (document.activeElement === input) return;
        paint();
      }
    });
    return input;
  }

  // A range input is the right control for something ordinal - a colour depth,
  // a shadow resolution. It is the wrong one for picking between names, and
  // absurd for a list that can grow, like the expression cells. Those get the
  // app's own <select>, whose styling is only defined in the Settings scope, so
  // the wrapper always carries STG even when the card lives in Effects.
  function addSelect(parent, key, label, values, labels, sc) {
    var h = el('h4', sc || FX, label);
    var wrap = el('div', 'select ' + STG);
    var sel = el('select', STG);
    sel.setAttribute('aria-label', label);
    sel.setAttribute('name', 'psx-' + key);

    for (var i = 0; i < values.length; i++) {
      var opt = el('option', STG, labels[i]);
      opt.value = String(i);
      // The app styles the closed control white-on-dark, but the popup list is
      // drawn by the OS on its own light background - so the options inherited
      // white text onto white. Native popups do honour these two properties.
      opt.style.color = '#fff';
      opt.style.backgroundColor = '#2b2a35';
      sel.appendChild(opt);
    }

    function paint() {
      var idx = values.indexOf(cfg[key]);
      sel.value = String(idx < 0 ? 0 : idx);
    }
    sel.addEventListener('change', function () {
      cfg[key] = values[parseInt(sel.value, 10)];
      onChange(key);
    });
    paint();

    wrap.appendChild(sel);
    wrap.appendChild(el('div', 'select_arrow ' + STG));
    parent.appendChild(h);
    parent.appendChild(wrap);
    controls.push({ key: key, node: sel, sync: paint });
    return sel;
  }

  function addRule(parent) { parent.appendChild(el('hr', FX)); }

  // A disclosure for the controls a card does not need open. Native
  // <details>/<summary> rather than a button and a class: it is keyboard
  // operable and announced as a disclosure without a line of script, and the
  // sliders inside keep their own scoped classes, so the app's styling reaches
  // them exactly as it does anywhere else in the card.
  function addDetails(parent, label, sc) {
    var d = el('details', sc || FX);
    d.style.cssText = 'width:100%;margin:4px 0';
    var s = el('summary', sc || FX, label);
    s.style.cssText = 'cursor:pointer;opacity:.55;font-size:11px;padding:8px 0;' +
      'letter-spacing:.08em;text-transform:uppercase;user-select:none';
    d.appendChild(s);
    parent.appendChild(d);
    return d;
  }

  // Shown only once a reload-only key has been touched. Both panels get one,
  // since either can hold a control the app reads only at startup.
  function reloadNote(parent, text, sc) {
    var note = el('div', sc || FX, text);
    note.className = (sc || FX) + ' psx-reload-note';
    note.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin-top:16px;text-align:left';
    note.style.display = pendingReload ? '' : 'none';
    var btn = el('button', 'trigger ' + STG, T('Reload to apply'));
    btn.style.marginTop = '12px';
    btn.addEventListener('click', function () { location.reload(); });
    note.appendChild(btn);
    parent.appendChild(note);
    return note;
  }

  function card(title, sc) {
    sc = sc || FX;
    var c = el('div', 'setting ' + sc + ' psx-injected');
    if (title) {
      var h = el('h4', sc, title);
      h.style.opacity = '.5';
      h.style.letterSpacing = '.08em';
      h.style.textTransform = 'uppercase';
      h.style.fontSize = '11px';
      c.appendChild(h);
    }
    return c;
  }

  // --- Effects tab: how it renders -----------------------------------------

  function buildEffects() {
    var frag = document.createDocumentFragment();

    var r = card(T('PSX Render'));
    addRange(r, 'pixelRatio', T('Render scale'), 0.25, 2, 0.25, function (v) { return v + 'x'; });
    addRule(r);
    addToggle(r, 'vertexSnap', T('Vertex snapping'));
    addRange(r, 'snapGrid', T('Snap grid'), 32, 480, 8, function (v) { return v + ''; });
    addRule(r);
    addToggle(r, 'dither', T('Dither'));
    addChoice(r, 'colorLevels', T('Colour depth'), [8, 16, 32, 64],
      [T('3 bit'), T('4 bit'), T('5 bit (PS1)'), T('6 bit')]);

    reloadNote(r, T('note.reloadRender'), FX);

    r.classList.add('last');
    frag.appendChild(r);
    return frag;
  }

  // --- Settings tab: calibrating one model ---------------------------------

  function buildSettings() {
    var frag = document.createDocumentFragment();

    // First card in the tab. It was the last control of a card headed "PSX
    // Hands", which is the one place nobody looks for it - and it is the
    // control most needed by someone who cannot read the rest of the panel.
    // No card heading: the select carries its own, and two "Language" labels
    // stacked on each other is worse than none.
    var lg = card(null, STG);
    addSelect(lg, 'lang', T('Language'), ['en', 'pt'],
      [T('English'), T('Portuguese (BR)')], STG);
    frag.appendChild(lg);

    var x = card(T('Face Expressions'), STG);
    addRange(x, 'threshold', T('Trigger threshold'), 0, 1, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(x, 'hysteresis', T('Release margin'), 0, 0.5, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(x, 'holdMs', T('Minimum hold'), 0, 400, 10, function (v) { return v + ' ms'; }, STG);
    addRule(x);
    addRange(x, 'mouthGain', T('Mouth gain'), 0.25, 3, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRule(x);
    var keys = expressionKeys();
    if (keys.length) {
      addSelect(x, 'preview', T('Preview cell'), [''].concat(keys), [T('live tracking')].concat(keys), STG);
    } else {
      var hint = el('div', STG, T('Load a VRM to calibrate individual cells.'));
      hint.style.cssText = 'width:100%;opacity:.5;font-size:12px;text-align:left';
      x.appendChild(hint);
    }
    frag.appendChild(x);

    // --- eyes ----------------------------------------------------------
    var ey = card(T('Eyes'), STG);
    var eyNote = el('div', STG, T('note.eyes'));
    eyNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    ey.appendChild(eyNote);
    addRange(ey, 'eyeShutAt', T('Eyes shut at'), 0.05, 0.95, 0.005,
      function (v) { return v.toFixed(3); }, STG);

    // Its own copy of the live numbers. The main readout is in the Emotion card
    // below, and setting the line by eye means watching the raw reading while
    // dragging it - which cannot be done with the number off screen.
    eyeReadoutEl = el('div', STG, T('waiting for a tracked face...'));
    eyeReadoutEl.style.cssText = 'width:100%;font-size:12px;opacity:.75;text-align:left;' +
      'margin-top:6px;font-variant-numeric:tabular-nums;font-feature-settings:"tnum"';
    ey.appendChild(eyeReadoutEl);

    calBlinkEl = el('div', STG, '');
    calBlinkEl.style.cssText = 'width:100%;font-size:12px;opacity:.85;text-align:left;' +
      'white-space:pre-line;margin-top:10px;line-height:1.5';
    ey.appendChild(calBlinkEl);

    calBlinkBtn = el('button', 'trigger ' + STG, T('Calibrate blink'));
    calBlinkBtn.style.marginTop = '12px';
    calBlinkBtn.addEventListener('click', function () {
      if (!calRun) startBlinkCalibration();
      else if (calRun.kind === 'blink') captureStep();
    });
    ey.appendChild(calBlinkBtn);

    calBlinkCancelBtn = el('button', 'trigger reset ' + STG, T('Cancel calibration'));
    calBlinkCancelBtn.style.marginTop = '8px';
    calBlinkCancelBtn.style.display = 'none';
    calBlinkCancelBtn.addEventListener('click', function () {
      stopCalibration(T('Calibration cancelled.'), T('Cancelled.'));
    });
    ey.appendChild(calBlinkCancelBtn);
    frag.appendChild(ey);

    // --- emotions ------------------------------------------------------
    var em = card(T('Emotion Detection'), STG);
    var emNote = el('div', STG, T('note.emotions'));
    emNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    em.appendChild(emNote);
    addRange(em, 'browGain', T('Signal gain'), 0.25, 4, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(em, 'browBias', T('Brow offset'), -1, 1, 0.01, function (v) { return (v > 0 ? '+' : '') + v.toFixed(2); }, STG);
    addRange(em, 'angryAt', T('Angry at'), 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(em, 'sorrowAt', T('Sorrow at'), 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(em, 'smileAt', T('Smile at'), 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(em, 'emotionHold', T('Emotion hold'), 0, 400, 10, function (v) { return v + ' ms'; }, STG);
    addRule(em);

    readoutEl = el('div', STG, T('waiting for a tracked face...'));
    readoutEl.style.cssText = 'width:100%;font-size:12px;opacity:.75;text-align:left;' +
      'font-variant-numeric:tabular-nums;font-feature-settings:"tnum"';
    em.appendChild(readoutEl);

    calEl = el('div', STG, '');
    calEl.style.cssText = 'width:100%;font-size:12px;opacity:.85;text-align:left;' +
      'white-space:pre-line;margin-top:10px;line-height:1.5';
    em.appendChild(calEl);

    calBtn = el('button', 'trigger ' + STG, T('Calibrate expressions'));
    calBtn.style.marginTop = '12px';
    calBtn.addEventListener('click', function () {
      if (!calRun) startCalibration();
      else if (calRun.kind === 'face') captureStep();
    });
    em.appendChild(calBtn);

    calCancelBtn = el('button', 'trigger reset ' + STG, T('Cancel calibration'));
    calCancelBtn.style.marginTop = '8px';
    calCancelBtn.style.display = 'none';
    calCancelBtn.addEventListener('click', function () {
      stopCalibration(T('Calibration cancelled.'), T('Cancelled.'));
    });
    em.appendChild(calCancelBtn);

    addRule(em);
    var mouthNote = el('div', STG, T('note.mouth'));
    mouthNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    em.appendChild(mouthNote);
    addRange(em, 'mouthStick', T('Vowel hold'), 0, 1, 0.05, function (v) { return v.toFixed(2); }, STG);

    calMouthEl = el('div', STG, '');
    calMouthEl.style.cssText = 'width:100%;font-size:12px;opacity:.85;text-align:left;' +
      'white-space:pre-line;margin-top:10px;line-height:1.5';
    em.appendChild(calMouthEl);

    calMouthBtn = el('button', 'trigger ' + STG, T('Calibrate vowels'));
    calMouthBtn.style.marginTop = '12px';
    calMouthBtn.addEventListener('click', function () {
      if (!calRun) startMouthCalibration();
      else if (calRun.kind === 'mouth') captureStep();
    });
    em.appendChild(calMouthBtn);

    calMouthCancelBtn = el('button', 'trigger reset ' + STG, T('Cancel calibration'));
    calMouthCancelBtn.style.marginTop = '8px';
    calMouthCancelBtn.style.display = 'none';
    calMouthCancelBtn.addEventListener('click', function () {
      stopCalibration(T('Calibration cancelled.'), T('Cancelled.'));
    });
    em.appendChild(calMouthCancelBtn);
    syncCalUi();
    frag.appendChild(em);

    // --- motion --------------------------------------------------------
    var mo = card(T('Motion Calibration'), STG);
    var moNote = el('div', STG, T('note.motion'));
    moNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    mo.appendChild(moNote);
    addToggle(mo, 'calCues', T('Calibration cues'), STG);

    // Shown only on a machine that has no voice at all. `say()` on an empty
    // voice list is silence and no error, and the beeps still work - so
    // without this the cues look half-broken with nothing to explain it.
    voiceNoteEl = el('div', STG, T('note.novoice'));
    voiceNoteEl.style.cssText = 'width:100%;opacity:.55;font-size:12px;margin:2px 0 4px;' +
      'text-align:left;line-height:1.5';
    mo.appendChild(voiceNoteEl);
    syncVoiceNote();

    addRule(mo);
    addRange(mo, 'headGain', T('Head / neck gain'), 0, 1.5, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(mo, 'leanGain', T('Torso lean gain'), 0, 1, 0.02, function (v) { return v.toFixed(2) + 'x'; }, STG);

    // Everything below is measured by the wizard or left alone. Eleven sliders
    // in one column read as eleven things to set before the feature works,
    // which is the opposite of what the wizard is for - so the card opens on
    // the two gains and a Calibrate button, and the rest is a disclosure for
    // the session where something specific is being chased.
    var adv = addDetails(mo, T('Fine tuning'), STG);

    var fxNote = el('div', STG, T('note.adaptive'));
    fxNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    adv.appendChild(fxNote);
    addRange(adv, 'minCutoff', T('Steadiness'), 0.2, 5, 0.05, function (v) { return v.toFixed(2) + 'Hz'; }, STG);
    addRange(adv, 'beta', T('Responsiveness'), 0, 3, 0.05, function (v) { return v.toFixed(2); }, STG);

    addRule(adv);
    var ikNote = el('div', STG, T('note.armIK'));
    ikNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    adv.appendChild(ikNote);
    addRange(adv, 'armReach', T('Reach'), 0.5, 2, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(adv, 'reachUp', T('Reach up'), 0.5, 2, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(adv, 'reachR', T('Right arm'), 0.5, 2, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(adv, 'reachL', T('Left arm'), 0.5, 2, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(adv, 'shoulder', T('Shoulder follow'), 0, 0.6, 0.05, function (v) { return v.toFixed(2); }, STG);
    addRange(adv, 'twist', T('Forearm twist'), 0, 1, 0.05, function (v) { return v.toFixed(2); }, STG);
    addRange(adv, 'headAnchor', T('Face anchor'), 0, 1, 0.05, function (v) { return v.toFixed(2); }, STG);
    addRange(adv, 'predict', T('Prediction'), 0, 1, 0.05, function (v) { return v.toFixed(2); }, STG);
    addRange(adv, 'armHold', T('Dropout hold'), 0, 1000, 25, function (v) { return v.toFixed(0) + 'ms'; }, STG);
    addRange(adv, 'leanHead', T('Head-tilt isolation'), 0, 1, 0.05, function (v) { return v.toFixed(2); }, STG);

    calMotionEl = el('div', STG, '');
    calMotionEl.style.cssText = 'width:100%;font-size:12px;opacity:.85;text-align:left;' +
      'white-space:pre-line;margin-top:10px;line-height:1.5';
    mo.appendChild(calMotionEl);

    calMotionBtn = el('button', 'trigger ' + STG, T('Calibrate motion'));
    calMotionBtn.style.marginTop = '12px';
    calMotionBtn.addEventListener('click', function () {
      if (!calRun) startMotionCalibration();
      else if (calRun.kind === 'motion') captureStep();
    });
    mo.appendChild(calMotionBtn);

    calMotionCancelBtn = el('button', 'trigger reset ' + STG, T('Cancel calibration'));
    calMotionCancelBtn.style.marginTop = '8px';
    calMotionCancelBtn.style.display = 'none';
    calMotionCancelBtn.addEventListener('click', function () {
      stopCalibration(T('Calibration cancelled.'), T('Cancelled.'));
    });
    mo.appendChild(calMotionCancelBtn);
    syncCalUi();
    frag.appendChild(mo);

    // --- performance ---------------------------------------------------
    var pf = card(T('Performance'), STG);
    var pfNote = el('div', STG, T('note.perf'));
    pfNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    pf.appendChild(pfNote);
    addToggle(pf, 'perfAuto', T('Auto throttle'), STG);
    addToggle(pf, 'keepAwake', T('Run while hidden'), STG);
    addRule(pf);
    addRange(pf, 'trackFps', T('Tracking rate'), 0, 60, 1, fpsLabel, STG);
    addRange(pf, 'renderFps', T('Render rate'), 0, 60, 1, fpsLabel, STG);
    addRule(pf);
    addToggle(pf, 'poseLite', T('Lite pose model'), STG);

    // The settings that make this run on a Raspberry Pi are five controls in
    // two different tabs, two of which need a reload, and knowing which five is
    // not something the panel says anywhere. One button.
    var lowNote = el('div', STG, T('note.lowpower'));
    lowNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:12px 0 4px;text-align:left';
    pf.appendChild(lowNote);
    var low = el('button', 'trigger ' + STG, T('Low power preset'));
    low.style.marginTop = '4px';
    low.addEventListener('click', function () { applyLowPower(); });
    pf.appendChild(low);

    reloadNote(pf, T('note.reloadPerf'), STG);
    frag.appendChild(pf);

    var hnd = card(T('PSX Hands'), STG);
    addSelect(hnd, 'fingers', T('Driven fingers'), ['all', 'thumb', 'none'],
      [T('all fingers'), T('thumb only'), T('none')], STG);
    frag.appendChild(hnd);

    // Export / import / reset are about the settings file, not about hands.
    var io = card(T('Profile'), STG);
    var exp = el('button', 'trigger ' + STG, T('Export settings'));
    exp.addEventListener('click', function () { exportSettings(); });
    io.appendChild(exp);

    var file = el('input', STG);
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.style.display = 'none';
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      file.value = '';
      importSettingsFile(f);
    });
    io.appendChild(file);

    var imp = el('button', 'trigger ' + STG, T('Import settings'));
    imp.style.marginTop = '8px';
    imp.addEventListener('click', function () { file.click(); });
    io.appendChild(imp);

    importNoteEl = el('div', STG, '');
    importNoteEl.style.cssText = 'width:100%;font-size:12px;opacity:.85;text-align:left;' +
      'white-space:pre-line;margin-top:10px;line-height:1.5';
    io.appendChild(importNoteEl);

    var rst = el('button', 'trigger reset ' + STG, T('Reset PSX settings'));
    rst.style.marginTop = '8px';
    rst.addEventListener('click', function () { resetSettings(); });
    io.appendChild(rst);
    // .last only exists in the Effects scope, so carry FX along for the margin
    io.classList.add('last', FX);
    frag.appendChild(io);

    return frag;
  }

  // The primary button doubles as the step advance, so the whole flow works
  // with the mouse alone; Space and Esc are the shortcut, not the only way in.
  function calLabel(mine, idle) {
    if (!mine) return idle;
    return calRun.phase === 'hold' ? T('Reading...') : T('Capture (Space)');
  }

  // One wizard runs at a time, so the other two start buttons do nothing at all
  // while one is going - they looked exactly as clickable as the live one and
  // answered a click with silence. Disable them, and show only the cancel that
  // belongs to the run: three identical Cancel buttons appearing at once said
  // there were three things to cancel.
  function syncCalBtn(btn, cancel, kind, idle) {
    var busy = !!calRun;
    var mine = busy && calRun.kind === kind;
    if (btn) {
      setText(btn, calLabel(mine, idle));
      btn.disabled = busy && !mine;
      btn.style.opacity = btn.disabled ? '.4' : '';
      btn.style.pointerEvents = btn.disabled ? 'none' : '';
    }
    if (cancel) cancel.style.display = mine ? '' : 'none';
  }

  function syncCalUi() {
    syncCalBtn(calBtn, calCancelBtn, 'face', T('Calibrate expressions'));
    syncCalBtn(calMotionBtn, calMotionCancelBtn, 'motion', T('Calibrate motion'));
    syncCalBtn(calMouthBtn, calMouthCancelBtn, 'mouth', T('Calibrate vowels'));
    syncCalBtn(calBlinkBtn, calBlinkCancelBtn, 'blink', T('Calibrate blink'));
    syncCalHud();
  }

  function syncControls() {
    for (var i = 0; i < controls.length; i++) controls[i].sync();
  }

  // The Effects panel has no class of its own we can rely on, but it owns the
  // #temp swatch (the Light Color picker mounts into it).
  function effectsContainer() {
    var probe = document.getElementById('temp');
    if (!probe || !probe.closest) return null;
    return probe.closest('container.' + FX);
  }

  function settingsContainer() {
    return document.querySelector('container.' + STG);
  }

  var injectQueued = false;
  var lastInject = 0;
  var INJECT_EVERY = 250;

  // The app writes a store on every tracked frame, so its panels mutate
  // continuously and the observer fires with them. Running the full pass each
  // time meant querySelectorAll over the document once a frame for no reason.
  function scheduleInject() {
    if (injectQueued) return;
    injectQueued = true;
    var wait = Math.max(0, lastInject + INJECT_EVERY - now());
    setTimeout(function () {
      requestAnimationFrame(function () {
        injectQueued = false;
        lastInject = now();
        tryInject();
      });
    }, wait);
  }

  // A panel is torn down when its tab closes, taking our cards with it. Drop the
  // orphaned control handles instead of resetting the list, so the panel that is
  // still mounted keeps syncing.
  function pruneControls() {
    var live = [];
    for (var i = 0; i < controls.length; i++) {
      if (controls[i].node && controls[i].node.isConnected) live.push(controls[i]);
    }
    controls = live;
  }

  // ------------------------------------------------------ background colours
  //
  // The app can already put a flat colour behind the avatar - five presets and
  // an iro picker - but the picker keeps exactly one colour under `savedIro`,
  // so there is nowhere to keep a second one and no way to drop one you are
  // done with.
  //
  // The uploaded-background list is already the right shape for that: it
  // renders a `color` entry as a swatch, gives anything marked `uploaded` a
  // delete button, and is persisted with the rest of the app's state. So a
  // saved colour is an entry in that list, and it appears in the 2D tab next
  // to the uploaded images rather than in some parallel PSX place.

  // The two the Color tab exists for, and neither was ever a swatch: a chroma
  // key green to pull the avatar into OBS, and the app's own transparent, which
  // is a hex with an alpha byte - the background component reads `length > 7`
  // and sets `scene.background = null`, which the renderer supports because it
  // is built with `alpha`. They are not saved colours and have no delete: a
  // fresh profile has to arrive with both already there.
  var BG_PRESETS = [
    { url: '#00FF00', name: 'Chroma green' },
    { url: '#00000000', name: 'Transparent' }
  ];

  function isAlphaHex(url) { return String(url).length > 7; }

  var bgStores = null;
  // the swatch the picker is currently loaded from, so Save replaces it rather
  // than piling up a near-identical colour every time one is nudged
  var bgEditUrl = null;
  var bgCard = null;

  // called when the Backgrounds panel mounts, with the app's own stores
  function bg(stores) { bgStores = stores; mirrorColours(); }

  // Svelte stores only hand their value to a subscriber. Subscribing runs the
  // callback once, synchronously, before returning the unsubscriber.
  function readStore(st) {
    if (!st || typeof st.subscribe !== 'function') return null;
    var v = null;
    var un = st.subscribe(function (x) { v = x; });
    if (typeof un === 'function') un();
    else if (un && typeof un.unsubscribe === 'function') un.unsubscribe();
    return v;
  }

  // The list is filtered by `pano` before it is rendered, and the delete button
  // reports the index it was rendered at - so with one 3D upload sitting ahead
  // of them, every 2D delete removes the wrong entry. Count through the same
  // filter the renderer used instead of trusting that index against the whole
  // list.
  function bgDrop(list, idx, tab) {
    var out = (list || []).slice();
    var seen = -1;
    for (var i = 0; i < out.length; i++) {
      if ((out[i] && out[i].pano ? '3D' : '2D') !== tab) continue;
      seen++;
      if (seen === idx) { out.splice(i, 1); return out; }
    }
    // an index that does not land anywhere is not one worth guessing at
    return out;
  }

  // The stored list is the source of truth. Reading the app's store instead
  // would answer with an empty list every time the Backgrounds panel has not
  // been opened yet this session, which is exactly when an export is most
  // likely to be taken.
  function savedColours() {
    var list = cfg.colours || [];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({ url: list[i], name: list[i] });
    return out;
  }

  // Keep the app's own background list in step with the stored colours. It is
  // what its list view renders and what `bgDrop` edits, and it is in-memory
  // only - so this is a mirror rather than a second copy to keep in sync by
  // hand. Uploads live in the same list and are not ours to touch.
  function mirrorColours() {
    if (!bgStores || !bgStores.list) return;
    var list = readStore(bgStores.list) || [];
    var keep = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].type !== 'color') keep.push(list[i]);
    }
    var cols = cfg.colours || [];
    var mine = [];
    for (var c = 0; c < cols.length; c++) {
      mine.push({ type: 'color', name: cols[c], url: cols[c], pano: false, uploaded: now() });
    }
    bgStores.list.set(mine.concat(keep));
  }

  function saveColour() {
    if (!bgStores) return;
    var hex = okHex(readStore(bgStores.saved));
    if (!hex) return;
    var list = (cfg.colours || []).slice();
    var at = bgEditUrl ? list.indexOf(bgEditUrl) : -1;
    // Editing replaces the swatch in place, so nudging a colour does not leave
    // the near-identical one it started from sitting beside it.
    if (at >= 0) list[at] = hex;
    else if (list.indexOf(hex) === -1) list.unshift(hex);
    cfg.colours = sanitize('colours', list);
    save();
    mirrorColours();
    bgStores.current.set({ type: 'color', url: hex });
    bgEditUrl = hex;
    injectBgColours();
  }

  function dropColour(url) {
    var list = (cfg.colours || []).slice();
    var at = list.indexOf(url);
    if (at === -1) return;
    list.splice(at, 1);
    cfg.colours = list;
    save();
    mirrorColours();
    if (bgEditUrl === url) bgEditUrl = null;
    injectBgColours();
  }

  // Load a saved colour back into the picker by driving the picker's own hex
  // field, the same way the stripped app controls are driven. Setting the
  // `savedIro` store instead would do nothing: the picker reads it once, when
  // it is constructed, and it is constructed when the tab mounts.
  function editColour(url) {
    bgEditUrl = url;
    var input = document.querySelector('#picker .hex input');
    // iro's hex field takes six digits. Handing it the transparent preset would
    // have it read the alpha byte as part of the colour and answer with a
    // different one, so that preset is applied without touching the picker.
    if (input && !isAlphaHex(url)) {
      input.value = String(url).replace('#', '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (bgStores) bgStores.current.set({ type: 'color', url: url });
    injectBgColours();
  }

  function bgHost() {
    var picker = document.getElementById('picker');
    if (!picker) return null;
    return (picker.closest && picker.closest('.bg-list')) || picker.parentElement;
  }

  // The checkerboard the app uses for its own transparent swatch is a remote
  // png. Drawn here instead, so a preset that ships with the fork does not need
  // a network round trip to look like anything.
  var CHECKER = 'background-color:#fff;background-image:' +
    'linear-gradient(45deg,#bbb 25%,transparent 25%,transparent 75%,#bbb 75%),' +
    'linear-gradient(45deg,#bbb 25%,transparent 25%,transparent 75%,#bbb 75%);' +
    'background-size:12px 12px;background-position:0 0,6px 6px;';

  // The app marks the background it is showing with a light-blue ring that
  // grows out from behind the tile (`div.bg.selected:before`), and its own
  // radius for a background tile is 8px. Both are borrowed here so a swatch
  // reads as the same kind of thing as the tiles it stands in for, rather than
  // as a control this fork bolted on.
  function bgSwatch(item, fixed) {
    var box = el('div', '', '');
    var on = bgEditUrl === item.url;
    box.style.cssText = 'position:relative;width:40px;height:40px;border-radius:8px;' +
      'cursor:pointer;flex:0 0 auto;transition:box-shadow .2s ease;' +
      (isAlphaHex(item.url) ? CHECKER : 'background:' + item.url + ';') +
      'box-shadow:0 0 0 1px rgba(0,0,0,.45)' +
      (on ? ',0 0 0 3px var(--lightBlue)' : '');
    box.title = fixed ? T(item.name) : item.url;
    box.addEventListener('click', function () { editColour(item.url); });
    // A preset is not a saved colour. Nothing to delete, and deleting it would
    // leave a profile with no way back to the two colours it is meant to have.
    if (fixed) return box;

    var x = el('button', '', '×');
    x.style.cssText = 'position:absolute;top:-6px;right:-6px;width:18px;height:18px;' +
      'line-height:16px;padding:0;border:0;border-radius:9px;font-size:14px;' +
      'font-weight:600;background:var(--lightRed);color:#fff;cursor:pointer;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.4)';
    x.setAttribute('aria-label', T('Delete colour'));
    x.addEventListener('click', function (e) {
      e.stopPropagation();
      dropColour(item.url);
    });
    box.appendChild(x);
    return box;
  }

  function bgLabel(text) {
    var h = el('div', '', text);
    h.style.cssText = 'color:#fff;font-size:11px;font-weight:600;letter-spacing:.04em;' +
      'text-transform:uppercase;opacity:.75;margin:0 0 8px';
    return h;
  }

  // The panels this card sits in set no colour of their own, so text here
  // inherits whatever the page hands down - which on the Backgrounds panel is
  // dark, on a dark slate. Every string below states its own colour. `opacity`
  // is what the other cards use for a secondary line, but it dims the
  // inherited colour rather than white, which is what made these two
  // illegible here; the app's own secondary is #ffffff80, and a note that has
  // to be read rather than glanced at sits a step above it.
  function buildBgColours() {
    var wrap = el('div', 'psx-injected', '');
    wrap.style.cssText = 'width:100%;margin-top:16px;text-align:left;color:#fff;' +
      'background:#ffffff10;border-radius:12px;padding:16px;box-sizing:border-box';

    var note = el('div', '', T('note.bgColour'));
    note.style.cssText = 'color:#ffffffb3;font-size:12px;margin:0 0 14px;line-height:1.5';
    wrap.appendChild(note);

    wrap.appendChild(bgLabel(T('Presets')));
    var fixed = el('div', '', '');
    fixed.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px';
    for (var f = 0; f < BG_PRESETS.length; f++) {
      fixed.appendChild(bgSwatch(BG_PRESETS[f], true));
    }
    wrap.appendChild(fixed);

    wrap.appendChild(bgLabel(T('Saved')));
    var row = el('div', '', '');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px';
    var cols = savedColours();
    for (var i = 0; i < cols.length; i++) row.appendChild(bgSwatch(cols[i]));
    if (!cols.length) {
      var none = el('div', '', T('No colours saved yet'));
      none.style.cssText = 'color:#ffffff80;font-size:12px;line-height:40px';
      row.appendChild(none);
    }
    wrap.appendChild(row);

    // `.trigger` is the app's own button, but its 24px padding and 32px radius
    // are sized for the full-width Settings panel and swamp a card this
    // narrow, so both come down to the scale of the tab pills beside it.
    var save = el('button', 'trigger ' + STG, bgEditUrl ? T('Update colour') : T('Save colour'));
    save.style.cssText = 'width:100%;margin:0;padding:12px;border-radius:20px;' +
      'font-size:14px;font-weight:600;box-sizing:border-box';
    save.addEventListener('click', saveColour);
    wrap.appendChild(save);
    return wrap;
  }

  // Rebuilt only when what it shows has changed. The injection pass runs
  // several times a second, and a swatch replaced under a cursor is a swatch
  // whose click never lands.
  function bgSignature() {
    var cols = savedColours();
    var s = bgEditUrl || '-';
    for (var i = 0; i < cols.length; i++) s += '|' + cols[i].url;
    return s;
  }

  function injectBgColours() {
    if (!bgStores) return;
    var host = bgHost();
    if (!host) { bgCard = null; return; }
    var sig = bgSignature();
    if (bgCard && bgCard.parentNode === host && bgCard.__psxSig === sig) return;
    if (bgCard && bgCard.parentNode) bgCard.parentNode.removeChild(bgCard);
    bgCard = buildBgColours();
    bgCard.__psxSig = sig;
    host.appendChild(bgCard);
  }

  function injectInto(c, build, keyed) {
    if (!c) return;
    // only the Settings side lists per-model expression cells, so it is the
    // only one that has to be rebuilt when the loaded model changes
    var wantKeys = expressionKeys().length;
    var existing = c.querySelectorAll('.psx-injected');
    if (existing.length) {
      if (!keyed || c.__psxKeys === wantKeys) return;
      Array.prototype.forEach.call(existing, function (n) { n.remove(); });
    }
    c.__psxKeys = wantKeys;
    c.appendChild(build());
  }

  function rebuildPanels() {
    var cards = document.querySelectorAll('.psx-injected');
    Array.prototype.forEach.call(cards, function (n) {
      if (n.parentNode) n.parentNode.__psxKeys = undefined;
      n.remove();
    });
    controls = [];
    // Every handle into a card that was just removed. Missing one leaves a
    // detached node being written to forever: syncCalUi would keep relabelling
    // the old button and the new one would never change.
    calEl = calMotionEl = calMouthEl = calBlinkEl = null;
    readoutEl = eyeReadoutEl = importNoteEl = null;
    calBtn = calMotionBtn = calMouthBtn = calBlinkBtn = null;
    calCancelBtn = calMotionCancelBtn = calMouthCancelBtn = calBlinkCancelBtn = null;
    bgCard = null;
    lastInject = 0;
    translateTree(document.body || document.documentElement);
    tryInject();
  }

  function tryInject() {
    applyStrip();
    pruneControls();
    injectInto(effectsContainer(), buildEffects, false);
    injectInto(settingsContainer(), buildSettings, true);
    injectBgColours();
  }

  function isOurs(n) {
    while (n) {
      if (n.classList && n.classList.contains('psx-injected')) return true;
      n = n.parentNode;
    }
    return false;
  }

  function allOurs(list) {
    for (var i = 0; i < list.length; i++) {
      if (!isOurs(list[i])) return false;
    }
    return true;
  }

  // A mutation is ours if it happened inside one of our cards, or if it *is* one
  // of our cards arriving or leaving - appending a card targets the container,
  // which is the app's, so matching on the target alone would let every
  // injection schedule another pass.
  function ownMutation(m) {
    if (isOurs(m.target)) return true;
    var added = m.addedNodes || [];
    var removed = m.removedNodes || [];
    if (!added.length && !removed.length) return false;
    return allOurs(added) && allOurs(removed);
  }

  // The app's panel labels are hardcoded textContent, not entries in its i18n
  // tables, so they are swapped in the DOM. Only leaf elements are touched, and
  // the English original is kept on the node so switching back is exact.
  function translateNode(n) {
    if (!n || n.nodeType !== 1 || n.children.length) return;
    var tag = n.tagName;
    if (tag !== 'H4' && tag !== 'LABEL' && tag !== 'P' && tag !== 'BUTTON') return;
    if (isOurs(n)) return;
    var en = n.__psxEn || (n.textContent || '').trim();
    n.__psxEn = en;
    var key = RELABEL[en] || en;
    if (!(key in PT) && !(en in PT)) return;
    var want = T(key);
    if ((n.textContent || '').trim() !== want) n.textContent = want;
  }

  // The main menu does not put its labels in the DOM as text: they are
  // data-text attributes drawn by `content: attr(data-text)` in the CSS. Those
  // are the only strings the app does keep in an i18n table, and the table has
  // en and ru - so translating them means writing the attribute.
  function translateAttr(n) {
    if (!n || n.nodeType !== 1 || !n.getAttribute || isOurs(n)) return;
    var cur = n.getAttribute('data-text');
    if (cur === null) return;
    var en = n.__psxEnAttr || cur.trim();
    if (!(en in PT)) return;
    n.__psxEnAttr = en;
    var want = cfg.lang === 'pt' ? PT[en] : en;
    if (cur !== want) n.setAttribute('data-text', want);
  }

  function translateTree(root) {
    if (!root || root.nodeType !== 1) return;
    translateNode(root);
    translateAttr(root);
    if (!root.querySelectorAll) return;
    var kids = root.querySelectorAll('h4, label, p, button');
    for (var i = 0; i < kids.length; i++) translateNode(kids[i]);
    var tagged = root.querySelectorAll('[data-text]');
    for (var j = 0; j < tagged.length; j++) translateAttr(tagged[j]);
  }

  // Runs on the raw mutation records rather than the throttled pass: a re-render
  // that reset a label back to English would otherwise show for a quarter of a
  // second, which reads as a flicker.
  // The target itself is translated, not its whole subtree: a re-render that
  // put a label back in English replaced a text node, and that record's target
  // is the element holding it. Anything deeper arrived as an added node and is
  // walked as one. `translateTree` runs two `querySelectorAll` calls, and this
  // list arrives with every mutation the app makes - so the difference is a
  // document scan per panel write versus a tag check.
  function translateMutations(list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      translateNode(m.target);
      translateAttr(m.target);
      var added = m.addedNodes || [];
      for (var j = 0; j < added.length; j++) translateTree(added[j]);
    }
  }

  // ------------------------------------------------ stuck panel escape
  //
  // The panel is two pieces that can disagree. Its background is an animated
  // SVG shape; its content is a separate component driven by which tab is
  // selected. When the shape finishes closing while a tab is still selected,
  // the content is left sitting on the 3D canvas with nothing behind it.
  //
  // What makes that unrecoverable is that the app has exactly one close path -
  // clicking the tab that is already open - and the click that got lost is the
  // very same one. Nothing else in the UI dismisses the panel, so the session
  // has to be restarted.
  //
  // Esc does nothing outside a calibration run, so it is free to be that way
  // out. It closes through the app's own handler rather than hiding anything:
  // the content, the shape and the store all have to move together, and only
  // the app's handler moves all three.
  function selectedTab() {
    var all = document.querySelectorAll('nav .menu-item.selected');
    for (var i = 0; i < all.length; i++) {
      // the camera button wears `selected` to mean the camera is running, which
      // is not a panel and must not be clicked shut
      if (!all[i].classList.contains('video')) return all[i];
    }
    return null;
  }

  function closePanel() {
    var tab = selectedTab();
    if (!tab) return false;
    // What the shape was doing at the moment the panel could not be dismissed.
    // The disagreement is a race and it is not reproducible to order, so the
    // one run that hits it is worth a line in the console.
    // console.warn rather than `log`: `log` is gated on verbose, and a panel
    // that had to be rescued is the one event worth seeing without having
    // turned anything on first.
    var sh = subnavShape;
    console.warn('[psx] closed a stuck panel', {
      tab: tab.getAttribute('data-text') || tab.className,
      isOpen: sh ? !!sh.isOpen : null,
      want: sh ? sh.__psxWant : null,
      animating: sh ? !!sh.transition : null,
      queued: !!(sh && sh.__psxQueued)
    });
    tab.click();
    return true;
  }

  // Somewhere the key belongs to whatever has focus, not to us. Space in a
  // text field is a space, and Escape in one is how you back out of it - both
  // of these listeners preventDefault, so without this the app's own hex field
  // cannot be typed into while a wizard is running.
  function typingIn(t) {
    if (!t || t.nodeType !== 1) return false;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
      !!t.isContentEditable;
  }

  function onCalKey(e) {
    if (typingIn(e.target)) return;
    if (!calRun) {
      if (e.key === 'Escape' && closePanel()) e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      stopCalibration(T('Calibration cancelled.'), T('Cancelled.'));
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
      // or the page scrolls, or a focused button fires as well
      e.preventDefault();
      captureStep();
    }
  }

  function startObserver() {
    document.addEventListener('keydown', onCalKey);
    var mo = new MutationObserver(function (list) {
      translateMutations(list);
      // our own cards mutate constantly (the live readout, the calibration
      // prompts). Reacting to those would schedule a pass every frame. An
      // attribute write never adds or removes a card, so it never needs one.
      for (var i = 0; i < list.length; i++) {
        if (list[i].type === 'childList' && !ownMutation(list[i])) {
          scheduleInject();
          return;
        }
      }
    });
    mo.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['data-text']
    });
    translateTree(document.body || document.documentElement);
    scheduleInject();
  }

  // ------------------------------------------------------------ app CSS
  //
  // Rules the fork wants over the app's own. A stylesheet rather than a patch
  // in the bundle: the bundle's class names carry a Svelte hash that changes on
  // every rebuild, but these are the app's own semantic names and survive it -
  // and a rule that stops matching costs nothing, where a patch that stops
  // matching fails the build.
  var APP_CSS = [
    // The free-camera cluster, bottom left. It orbits the scene, which this
    // fork does not want touched by hand - the camera is where the capture is
    // framed from and nudging it mid-session silently reframes the shot. The
    // flip control lives inside the same cluster and goes with it.
    '.cameraMenu{display:none !important}'
  ].join('');

  function injectAppCss() {
    if (document.getElementById('psx-app-css')) return;
    var head = document.head || document.documentElement;
    if (!head) return;
    var st = document.createElement('style');
    st.id = 'psx-app-css';
    st.textContent = APP_CSS;
    head.appendChild(st);
  }

  injectAppCss();
  applyDocLang();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }
  applyCanvasFilter();

  // ------------------------------------------------------------- public API

  window.PSX = {
    cfg: cfg,
    save: save,
    dump: dump,
    test: test,
    models: models,
    keys: expressionKeys,

    set: function (k, v) {
      cfg[k] = v;
      save();
      applyCanvasFilter();
      refreshModels();
      syncControls();
    },

    // --- hooks called from the patched bundle ---
    setupRenderer: function (r) {
      renderer = r;
      applyPixelRatio();
      applyCanvasFilter();
      return r;
    },
    // The console had no antialiasing of any kind, so neither does this.
    aa: function () { return false; },
    smaa: function () { return false; },
    fingers: function () {
      var all = ['Ring', 'Index', 'Little', 'Thumb', 'Middle'];
      if (!on() || cfg.fingers === 'all') return all;
      if (cfg.fingers === 'none') return [];
      return ['Thumb'];
    },
    onModel: registerModel,
    brow: browScalar,
    tick: function (vrm) {
      if (!vrm) return;
      applyHeld(vrm);
      if (vrm.__psxUvBinds) applyUvBinds(vrm);
      sampleReach(vrm);
    },

    // called from the face rig, after the app has written its own presets and
    // before blendShapeProxy.update() applies them
    face: function (vrm, rig) {
      try {
        var rawBrow = num(rig && rig.brow);
        var rawSmile = num(rig && rig.mouth && rig.mouth.x);
        // calibration has to record even with emotions switched off, since
        // that is the order people will do it in
        noteHeadSpeed(rig);
        noteFaceBox(rig);
        sampleCalibration(rawBrow, rawSmile, rig);
        driveBlink(vrm, rig);
        driveVisemes(vrm, rig);
        driveEmotions(vrm, rig, rawBrow, rawSmile);
      } catch (e) { log('face hook failed', e); }
    },

    calibrate: startCalibration,
    calibrateMotion: startMotionCalibration,
    calibrateMouth: startMouthCalibration,
    calibrateBlink: startBlinkCalibration,
    resetCalibration: resetCalibration,
    browRest: browRestInfo,
    resetSettings: resetSettings,
    exportSettings: exportSettings,
    importSettings: applyImported,
    verify: verify,

    headGain: headGain,
    bodyGain: bodyGain,
    leanGain: leanGain,
    spineLean: spineLean,
    armGain: armGain,
    smooth: smooth,

    pose: pose,
    hands: hands,
    arm: arm,
    armInfo: armInfo,
    perf: perfInfo,
    bg: bg,
    bgDrop: bgDrop,
    guide: guide,

    frame: frame,
    nextTrack: nextTrack,
    mpOptions: mpOptions,
    shadows: shadows,
    shadowSize: shadowSize,
    gaze: gaze,

    overlay: overlay,
    overlayOpen: overlayOpen
  };
})();

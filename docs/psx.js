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
 *   PSX.headGain() / bodyGain()  - neck and chest/spine rotation gain
 *   PSX.smooth(t)                - lerp factor for every tracked bone
 *   PSX.frame()                  - whether this animation frame gets rendered
 *   PSX.nextTrack(fn)            - schedules the next Mediapipe inference
 *   PSX.mpOptions(opts)          - Mediapipe model options, before setOptions
 *   PSX.shadows() / shadowSize() - shadow map enable and resolution
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

  var DEFAULTS = {
    // master switch; when false every hook falls back to stock behaviour
    enabled: false,
    // render at 1 device pixel per CSS pixel and let CSS upscale with
    // image-rendering:pixelated -> hard pixel edges instead of a 2x downsample
    pixelRatio: 1,
    // WebGL MSAA. Off for PSX.
    antialias: false,
    // SMAA post pass. Off for PSX.
    smaa: false,
    // nearest-neighbour texture sampling, no mipmaps, no anisotropy
    nearestTextures: true,

    // drive _MainTex_ST blendshape material values ourselves, so texture-based
    // expressions work on materials three-vrm cannot bind (non-MToon)
    uvExpressions: true,
    // cut straight to the winning atlas cell instead of easing into it
    snapExpressions: true,
    // Unity samples V upside down relative to glTF. True is correct for a
    // normal VRM export; flip it if every expression lands on the wrong cell.
    uvFlipV: true,
    // weight an expression has to clear before it takes over its material
    threshold: 0.35,
    // how far below `threshold` an expression may sag before it lets go.
    // Stops the face chattering between two cells at the boundary.
    hysteresis: 0.1,
    // minimum ms a cell stays on screen once picked
    holdMs: 80,
    // pre-threshold multipliers, so quiet talking / soft blinks still register
    mouthGain: 1,
    blinkGain: 1,
    // '' = live tracking; otherwise force this expression key (calibration)
    preview: '',

    // 'all' | 'thumb' | 'none' - which fingers the hand solver drives
    fingers: 'thumb',

    // --- emotion presets ----------------------------------------------
    // Drive angry / sorrow / fun from the solved face. Off = stock, which
    // never writes those presets at all, so their atlas cells can never win.
    emotions: false,
    // Normalise the brow and the smile against the range this face actually
    // produces, instead of against a fixed span. Kalidokit's brow scalar only
    // swings a few hundredths for most people, so a raw threshold of 0.35 is
    // unreachable and the emotion never fires.
    autoCalibrate: true,
    // multiplier applied after normalisation
    browGain: 1,
    // how far the brow has to travel before it reads as that emotion
    angryAt: 0.35,
    sorrowAt: 0.35,
    // how wide the mouth corners have to go before it reads as a smile
    smileAt: 0.3,
    // Let the mouth win while it is talking. On a PSX atlas the vowels and the
    // emotions are cells of the same face texture, so they cannot both show -
    // without this an emotion pins the face and the lip sync stops.
    speechFirst: true,
    // how loud a vowel has to be to count as talking
    speechAt: 0.2,
    // which preset a smile drives: 'fun' | 'joy' | 'both'
    smileKey: 'fun',
    // let only the strongest emotion through
    exclusive: true,

    // --- motion -------------------------------------------------------
    // Enable the gains below. Off = the app's own values.
    motion: false,
    // neck rotation gain; stock is 1
    headGain: 1,
    // chest / spine / upper chest rotation gain; stock is 0.05
    bodyGain: 0.05,
    // 0 = stock responsiveness, 1 = as heavy as it goes
    damping: 0,

    // --- performance --------------------------------------------------
    // Enable the caps below. Off = the app's own behaviour.
    perf: false,
    // Mediapipe inferences per second. 0 = one per animation frame (stock),
    // which is where nearly all the CPU goes.
    trackFps: 0,
    // rendered frames per second. 0 = display rate (stock).
    renderFps: 0,
    // realtime shadow maps. Two lights cast at 2048x2048 by default, which is
    // two full depth passes per frame.
    shadows: true,
    shadowSize: 2048,
    // Mediapipe iris / lip refinement (refineFaceLandmarks). An extra model.
    faceIris: true,
    // Holistic modelComplexity 0 (lite) instead of 1
    poseLite: false,

    verbose: false
  };

  var STOCK_HEAD_GAIN = 1;
  var STOCK_BODY_GAIN = 0.05;
  var STOCK_SHADOW_SIZE = 2048;

  var MOUTH_KEYS = { a: 1, i: 1, u: 1, e: 1, o: 1 };
  var BLINK_KEYS = { blink: 1, blink_l: 1, blink_r: 1 };

  var cfg = load();

  function load() {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var j in saved) if (j in out) out[j] = saved[j];
      }
    } catch (e) {}
    out.preview = '';
    return out;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  function log() {
    if (!cfg.verbose) return;
    console.log.apply(console, ['[psx]'].concat([].slice.call(arguments)));
  }

  function on() { return !!cfg.enabled; }
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
  // moment. `needsUpdate` re-uploads but never reallocates, so switching a
  // 1-level texture to a mipmap minFilter afterwards makes glGenerateMipmap fail
  // and pushes texSubImage2D at a level that does not exist -> the texture goes
  // black and stays black, because the broken GL object is reused.
  //
  // Disposing first drops the GL texture, so the next render allocates fresh
  // storage with the right level count. We only do it when the filtering
  // actually changed, to avoid re-uploading every texture on unrelated edits.
  //
  // The restore path puts back what the VRM authored, not a hardcoded
  // linear+mipmap guess: some of these textures are authored without mipmaps on
  // purpose (formats that cannot generate them), and anisotropy has to come back
  // from the original too.
  function applyTextureFilter(vrm) {
    var nearest = on() && cfg.nearestTextures;
    eachMaterial(vrm, function (m) {
      var touched = false;
      for (var i = 0; i < TEXTURE_SLOTS.length; i++) {
        var t = m[TEXTURE_SLOTS[i]];
        if (!t || !t.isTexture) continue;

        if (!t.__psxOrig) {
          t.__psxOrig = {
            magFilter: t.magFilter,
            minFilter: t.minFilter,
            generateMipmaps: t.generateMipmaps,
            anisotropy: t.anisotropy
          };
        }
        var want = nearest
          ? { magFilter: NearestFilter, minFilter: NearestFilter, generateMipmaps: false, anisotropy: 1 }
          : t.__psxOrig;

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
        var src = mat.map;
        mat.map = src.clone();
        // Texture.copy() does not carry custom fields, and this clone can be
        // made while PSX filtering is already applied - without this the clone
        // would record nearest as its authored state and never restore.
        if (src.__psxOrig) mat.map.__psxOrig = src.__psxOrig;
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
    }

    var used = byMaterial.filter(function (e) { return e.cells.length; });
    return used.length ? used : null;
  }

  // Unity/UniVRM sample with a flipped V axis relative to glTF, so the vertical
  // offset has to be rebased before it can go into a three.js texture:
  //   v_univrm = oy + sy * (1 - v)   ->   v_three = (1 - oy - sy) + sy * v
  function toThreeUv(u) {
    return cfg.uvFlipV
      ? { ox: u.ox, oy: 1 - u.oy - u.sy, rx: u.sx, ry: u.sy }
      : { ox: u.ox, oy: u.oy, rx: u.sx, ry: u.sy };
  }

  function gainFor(key) {
    if (MOUTH_KEYS[key]) return cfg.mouthGain;
    if (BLINK_KEYS[key]) return cfg.blinkGain;
    return 1;
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
    var snap = !!cfg.snapExpressions;
    var t = now();

    for (var i = 0; i < binds.length; i++) {
      var e = binds[i];
      if (!e.material.map) continue;

      var neutralUv = e.neutral ? toThreeUv(e.neutral) : e.base;

      // in blend mode there is no cell latch, so it just rewrites every frame
      if (!snap) {
        var top = pickBest(e, proxy);
        var uv = neutralUv;
        if (top.cell && top.weight >= cfg.threshold) {
          var hit = toThreeUv(top.cell.unity);
          var w = top.weight;
          uv = {
            ox: neutralUv.ox + (hit.ox - neutralUv.ox) * w,
            oy: neutralUv.oy + (hit.oy - neutralUv.oy) * w,
            rx: neutralUv.rx + (hit.rx - neutralUv.rx) * w,
            ry: neutralUv.ry + (hit.ry - neutralUv.ry) * w
          };
        }
        e.current = top.cell ? top.cell.key : null;
        e.currentCell = top.cell;
        writeUv(e, uv);
        continue;
      }

      // snap mode: hold the current cell for at least holdMs
      if (e.since && (t - e.since) < cfg.holdMs) continue;

      var best = pickBest(e, proxy);
      // hysteresis: the cell already on screen only has to clear the lower bar
      var bar = (best.cell && best.cell.key === e.current)
        ? Math.max(0, cfg.threshold - cfg.hysteresis)
        : cfg.threshold;
      var chosen = (best.cell && best.weight >= bar) ? best.cell : null;
      var tag = chosen ? chosen.key : null;

      if (tag === e.current && e.since) continue;
      e.current = tag;
      e.currentCell = chosen;
      e.since = t;
      writeUv(e, chosen ? toThreeUv(chosen.unity) : neutralUv);
    }
  }

  function pickBest(e, proxy) {
    var best = null, bestW = 0;
    for (var c = 0; c < e.cells.length; c++) {
      var cell = e.cells[c];
      var w = 0;
      try { w = proxy.getValue(cell.key) || 0; } catch (err) { w = 0; }
      w *= gainFor(cell.key);
      if (w > 1) w = 1;
      if (cell.isBinary) w = w >= 0.5 ? 1 : 0;
      if (w > bestW) { bestW = w; best = cell; }
    }
    return { cell: best, weight: bestW };
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

  function paintReadout() {
    if (!readoutEl || !readoutEl.isConnected || !lastFace) return;
    var top = null;
    for (var i = 0; i < EMOTION_KEYS.length; i++) {
      var k = EMOTION_KEYS[i];
      if (lastFace.out[k] > 0 && (!top || lastFace.out[k] > lastFace.out[top])) top = k;
    }
    readoutEl.textContent =
      'brow ' + lastFace.brow.toFixed(2) +
      '  ·  smile ' + lastFace.smile.toFixed(2) +
      '  ·  ' + (top ? top + ' ' + lastFace.out[top].toFixed(2) : 'neutral');
  }

  function resetCalibration() {
    browTrack = tracker();
    smileTrack = tracker();
    log('calibration reset');
  }

  function driveEmotions(vrm, rig) {
    if (!cfg.emotions) return;
    var proxy = vrm && vrm.blendShapeProxy;
    if (!proxy || !rig) return;

    var rawBrow = num(rig.brow);
    var rawSmile = num(rig.mouth && rig.mouth.x);
    var brow, smile;
    if (cfg.autoCalibrate) {
      brow = clamp(normalize(browTrack, rawBrow, 0.01) * cfg.browGain, -1, 1);
      // a smile only ever opens the mouth wider than rest, so the closing half
      // of the range is not a smile
      smile = clamp(normalize(smileTrack, rawSmile, 0.02) * cfg.browGain, 0, 1);
    } else {
      brow = clamp(rawBrow * cfg.browGain, -1, 1);
      // the same normalisation the app uses: 0.4 -> 0.9 maps to 0 -> 1
      smile = clamp((rawSmile - 0.4) / 0.5, 0, 1);
    }

    var out = {
      angry: ramp(-brow, cfg.angryAt),
      sorrow: ramp(brow, cfg.sorrowAt),
      fun: 0,
      joy: 0
    };
    var sm = ramp(smile, cfg.smileAt);
    if (cfg.smileKey === 'fun' || cfg.smileKey === 'both') out.fun = sm;
    if (cfg.smileKey === 'joy' || cfg.smileKey === 'both') out.joy = sm;

    // A furrowed brow over a wide mouth reads as neither. On a PSX atlas these
    // are whole-face swaps, so blending two of them lands between cells - only
    // the loudest one gets to speak.
    if (cfg.exclusive) {
      var top = null;
      for (var i = 0; i < EMOTION_KEYS.length; i++) {
        var k = EMOTION_KEYS[i];
        if (out[k] > 0 && (!top || out[k] > out[top])) top = k;
      }
      for (var j = 0; j < EMOTION_KEYS.length; j++) {
        if (EMOTION_KEYS[j] !== top) out[EMOTION_KEYS[j]] = 0;
      }
    }

    // On a PSX atlas the vowels and the emotions are cells of the same face
    // texture, so whichever wins takes the whole face. An emotion that outweighs
    // a vowel therefore stops the lip sync dead. Let the mouth speak first: while
    // a vowel is loud enough to count as talking, the emotions stand down.
    if (cfg.speechFirst && mouthLevel(proxy) >= cfg.speechAt) {
      for (var q = 0; q < EMOTION_KEYS.length; q++) out[EMOTION_KEYS[q]] = 0;
    }

    lastFace = { brow: brow, smile: smile, out: out, raw: { brow: rawBrow, smile: rawSmile } };
    paintReadout();

    // Write all four, including the ones we resolved to 0. The app writes Joy
    // itself from "Smile Detection [Beta]", and leaving that in place would let
    // a stale Joy outvote an exclusive pick - so while this is on, the emotion
    // presets belong to us. Point "Smile drives" at joy to get the stock
    // behaviour back, with a threshold you can actually tune.
    for (var n = 0; n < EMOTION_KEYS.length; n++) {
      try { proxy.setValue(EMOTION_KEYS[n], out[EMOTION_KEYS[n]]); } catch (e) {}
    }
  }

  // The vowels the app writes are the only speech signal we get; take the
  // loudest of them as "is this face talking right now".
  function mouthLevel(proxy) {
    var top = 0;
    for (var k in MOUTH_KEYS) {
      var w = 0;
      try { w = proxy.getValue(k) || 0; } catch (e) { w = 0; }
      if (w > top) top = w;
    }
    return top;
  }

  // ----------------------------------------------------------- motion gains
  //
  // The neck rig multiplies the solved head rotation by 1 and the chest/spine
  // rig by 0.05, both hardcoded, then lerps toward the result at 0.04 + dt*4
  // (neck) or 0.04 + dt*2 (torso). A small real movement therefore lands as a
  // large avatar movement, with nothing to tune. These hooks put a gain and a
  // damping factor in front of both.

  function headGain() { return cfg.motion ? cfg.headGain : STOCK_HEAD_GAIN; }
  function bodyGain() { return cfg.motion ? cfg.bodyGain : STOCK_BODY_GAIN; }

  function smooth(t) {
    if (!cfg.motion || !cfg.damping) return t;
    // never return 0, or the bone would freeze instead of easing
    return Math.max(t * (1 - cfg.damping), 0.002);
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

  function overlayOpen(inst) {
    if (!inst) return false;
    return inst.__psxWant === undefined ? !!inst.isOpen : inst.__psxWant;
  }

  function overlay(inst, opts) {
    if (!inst) return;
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

  function shadows() { return cfg.perf ? !!cfg.shadows : true; }
  function shadowSize() { return cfg.perf ? cfg.shadowSize : STOCK_SHADOW_SIZE; }

  // Called with whatever options object is about to reach setOptions - Holistic
  // spells the refinement flag one way, FaceMesh another, so touch whichever
  // keys are actually present.
  function mpOptions(opts) {
    if (!cfg.perf || !opts) return opts;
    if ('refineFaceLandmarks' in opts) opts.refineFaceLandmarks = !!cfg.faceIris;
    if ('refineLandmarks' in opts) opts.refineLandmarks = !!cfg.faceIris;
    if ('modelComplexity' in opts) opts.modelComplexity = cfg.poseLite ? 0 : 1;
    log('mediapipe options', opts);
    return opts;
  }

  // The tracking loop awaits its inference, so the gap between iterations is
  // inference time plus whatever we wait here. Measure from the start of the
  // last cycle so the rate holds steady instead of drifting slower.
  var trackAt = 0;

  function nextTrack(fn) {
    var fps = cfg.perf ? cfg.trackFps : 0;
    if (!fps) return requestAnimationFrame(fn);
    var t = now();
    var wait = Math.max(0, trackAt + (1000 / fps) - t);
    trackAt = t + wait;
    return setTimeout(function () { requestAnimationFrame(fn); }, wait);
  }

  var frameAt = 0;

  function frame() {
    var fps = cfg.perf ? cfg.renderFps : 0;
    if (!fps) return true;
    var t = now();
    // a few ms of slack, or a 30fps budget would keep missing 60Hz ticks by a
    // hair and land on 20
    if (t - frameAt < (1000 / fps) - 4) return false;
    frameAt = t;
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
    if (on() && cfg.uvExpressions) {
      vrm.__psxUvBinds = collectUvBinds(vrm, gltf);
      if (vrm.__psxUvBinds) log('driving', vrm.__psxUvBinds.length, 'material(s) via _MainTex_ST');
    } else {
      vrm.__psxUvBinds = null;
    }
    applyTextureFilter(vrm);
    scheduleInject();
    return vrm;
  }

  function refreshModels() {
    for (var i = 0; i < models.length; i++) {
      applyTextureFilter(models[i]);
      if (on() && cfg.uvExpressions && !models[i].__psxUvBinds) {
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
    var hk = Object.keys(held);
    for (var j = 0; j < hk.length; j++) vrm.blendShapeProxy.setValue(hk[j], held[hk[j]]);
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
          ', smile ' + lastFace.smile.toFixed(3) + ' ->', lastFace.out);
      } else if (cfg.emotions) {
        console.warn('emotion detection is on but no face has been solved yet - ' +
          'is face tracking running?');
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
      if (!on()) console.error('-> PSX mode is off.');
      else if (!cfg.uvExpressions) console.error('-> "Texture expressions" is off.');
      else console.error('-> see the tables above: either no materialName matched, or the matched material has no .map');
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
        var n = b.neutral ? toThreeUv(b.neutral) : b.base;
        cellRows.push({
          material: b.material.name, cell: '(neutral)',
          offset: n.ox.toFixed(3) + ', ' + n.oy.toFixed(3),
          repeat: n.rx.toFixed(3) + ', ' + n.ry.toFixed(3)
        });
        b.cells.forEach(function (c) {
          var u = toThreeUv(c.unity);
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
  var NEEDS_RELOAD = {
    enabled: 1, pixelRatio: 1, antialias: 1, smaa: 1,
    perf: 1, shadows: 1, shadowSize: 1, faceIris: 1, poseLite: 1
  };
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

  function onChange(key) {
    save();
    if (NEEDS_RELOAD[key]) {
      pendingReload = true;
      var notes = document.querySelectorAll('.psx-reload-note');
      Array.prototype.forEach.call(notes, function (n) { n.style.display = ''; });
    } else {
      applyCanvasFilter();
      refreshModels();
    }
    syncControls();
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
      onChange(key);
    });
    paint();
    parent.appendChild(h);
    parent.appendChild(input);
    controls.push({ key: key, node: input, sync: function () { input.value = cfg[key]; paint(); } });
    return input;
  }

  function addToggle(parent, key, label, sc) {
    var row = el('div', 'toggle ' + FX);
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
      onChange(key);
    });
    paint();
    parent.appendChild(h);
    parent.appendChild(input);
    controls.push({ key: key, node: input, sync: paint });
    return input;
  }

  function addRule(parent) { parent.appendChild(el('hr', FX)); }

  // Shown only once a reload-only key has been touched. Both panels get one,
  // since either can hold a control the app reads only at startup.
  function reloadNote(parent, text, sc) {
    var note = el('div', sc || FX, text);
    note.className = (sc || FX) + ' psx-reload-note';
    note.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin-top:16px;text-align:left';
    note.style.display = pendingReload ? '' : 'none';
    var btn = el('button', 'trigger ' + STG, 'Reload to apply');
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

    var r = card('PSX Render');
    addToggle(r, 'enabled', 'PSX mode');
    addToggle(r, 'nearestTextures', 'Nearest textures');
    addToggle(r, 'antialias', 'MSAA');
    addToggle(r, 'smaa', 'SMAA');
    addRule(r);
    addRange(r, 'pixelRatio', 'Render scale', 0.25, 2, 0.25, function (v) { return v + 'x'; });

    reloadNote(r, 'PSX mode, MSAA, SMAA and render scale apply on reload.', FX);

    r.classList.add('last');
    frag.appendChild(r);
    return frag;
  }

  // --- Settings tab: calibrating one model ---------------------------------

  function buildSettings() {
    var frag = document.createDocumentFragment();

    var x = card('Face Expressions', STG);
    addToggle(x, 'uvExpressions', 'Texture expressions', STG);
    addToggle(x, 'snapExpressions', 'Snap to cell', STG);
    addToggle(x, 'uvFlipV', 'Flip V axis', STG);
    addRule(x);
    addRange(x, 'threshold', 'Trigger threshold', 0, 1, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(x, 'hysteresis', 'Release margin', 0, 0.5, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(x, 'holdMs', 'Minimum hold', 0, 400, 10, function (v) { return v + ' ms'; }, STG);
    addRule(x);
    addRange(x, 'mouthGain', 'Mouth gain', 0.25, 3, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(x, 'blinkGain', 'Blink gain', 0.25, 3, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRule(x);
    var keys = expressionKeys();
    if (keys.length) {
      addChoice(x, 'preview', 'Preview cell', [''].concat(keys), ['live tracking'].concat(keys), STG);
    } else {
      var hint = el('div', STG, 'Load a VRM to calibrate individual cells.');
      hint.style.cssText = 'width:100%;opacity:.5;font-size:12px;text-align:left';
      x.appendChild(hint);
    }
    frag.appendChild(x);

    // --- emotions ------------------------------------------------------
    var em = card('Emotion Detection', STG);
    var emNote = el('div', STG,
      'The app only tracks blinks, the five vowels and a smile. Angry, sorrow ' +
      'and fun are never written at all - this derives them from the brow and ' +
      'mouth so those cells can fire. Pull each face and watch the readout to ' +
      'set the thresholds.');
    emNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    em.appendChild(emNote);
    addToggle(em, 'emotions', 'Detect emotions', STG);
    addToggle(em, 'autoCalibrate', 'Auto-calibrate', STG);
    addToggle(em, 'exclusive', 'Strongest only', STG);
    addRule(em);
    addToggle(em, 'speechFirst', 'Speech first', STG);
    addRange(em, 'speechAt', 'Talking at', 0, 1, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRule(em);
    addRange(em, 'browGain', 'Signal gain', 0.25, 4, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(em, 'angryAt', 'Angry at', 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(em, 'sorrowAt', 'Sorrow at', 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(em, 'smileAt', 'Smile at', 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRule(em);
    addChoice(em, 'smileKey', 'Smile drives', ['fun', 'joy', 'both'],
      ['fun', 'joy', 'fun + joy'], STG);
    addRule(em);

    readoutEl = el('div', STG, 'waiting for a tracked face...');
    readoutEl.style.cssText = 'width:100%;font-size:12px;opacity:.75;text-align:left;' +
      'font-variant-numeric:tabular-nums;font-feature-settings:"tnum"';
    em.appendChild(readoutEl);
    var recal = el('button', 'trigger ' + STG, 'Reset calibration');
    recal.style.marginTop = '12px';
    recal.addEventListener('click', function () { resetCalibration(); });
    em.appendChild(recal);
    frag.appendChild(em);

    // --- motion --------------------------------------------------------
    var mo = card('Motion Calibration', STG);
    var moNote = el('div', STG,
      'The neck and torso gains are hardcoded upstream, so a small real ' +
      'movement lands as a large avatar movement. Lower the gain to move less, ' +
      'raise the damping to move slower.');
    moNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    mo.appendChild(moNote);
    addToggle(mo, 'motion', 'Motion calibration', STG);
    addRule(mo);
    addRange(mo, 'headGain', 'Head / neck gain', 0, 1.5, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(mo, 'bodyGain', 'Torso gain', 0, 0.2, 0.005, function (v) { return v.toFixed(3) + 'x'; }, STG);
    addRange(mo, 'damping', 'Damping', 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    frag.appendChild(mo);

    // --- performance ---------------------------------------------------
    var pf = card('Performance', STG);
    var pfNote = el('div', STG,
      'Upstream runs a Mediapipe inference on every animation frame, renders on ' +
      'every animation frame, and has two lights casting 2048x2048 shadow maps. ' +
      'The tracking rate is where nearly all the CPU goes.');
    pfNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    pf.appendChild(pfNote);
    addToggle(pf, 'perf', 'Performance caps', STG);
    addRule(pf);
    addRange(pf, 'trackFps', 'Tracking rate', 0, 60, 1, fpsLabel, STG);
    addRange(pf, 'renderFps', 'Render rate', 0, 60, 1, fpsLabel, STG);
    addRule(pf);
    addToggle(pf, 'shadows', 'Realtime shadows', STG);
    addChoice(pf, 'shadowSize', 'Shadow resolution', [256, 512, 1024, 2048],
      ['256', '512', '1024', '2048'], STG);
    addRule(pf);
    addToggle(pf, 'faceIris', 'Iris / lip refinement', STG);
    addToggle(pf, 'poseLite', 'Lite pose model', STG);
    reloadNote(pf, 'Shadows and the Mediapipe model options apply on reload. ' +
      'The rate caps take effect immediately.', STG);
    frag.appendChild(pf);

    var hnd = card('PSX Hands', STG);
    addChoice(hnd, 'fingers', 'Driven fingers', ['all', 'thumb', 'none'],
      ['all fingers', 'thumb only', 'none'], STG);
    var dbg = el('button', 'trigger ' + STG, 'Log diagnostics to console');
    dbg.style.marginTop = '20px';
    dbg.addEventListener('click', function () { dump(); });
    hnd.appendChild(dbg);
    // .last only exists in the Effects scope, so carry FX along for the margin
    hnd.classList.add('last', FX);
    frag.appendChild(hnd);

    return frag;
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

  function scheduleInject() {
    if (injectQueued) return;
    injectQueued = true;
    requestAnimationFrame(function () {
      injectQueued = false;
      tryInject();
    });
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

  function tryInject() {
    pruneControls();
    injectInto(effectsContainer(), buildEffects, false);
    injectInto(settingsContainer(), buildSettings, true);
  }

  function startObserver() {
    var mo = new MutationObserver(scheduleInject);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    scheduleInject();
  }

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
    aa: function () { return on() ? !!cfg.antialias : true; },
    smaa: function () { return on() ? !!cfg.smaa : true; },
    fingers: function () {
      var all = ['Ring', 'Index', 'Little', 'Thumb', 'Middle'];
      if (!on() || cfg.fingers === 'all') return all;
      if (cfg.fingers === 'none') return [];
      return ['Thumb'];
    },
    onModel: registerModel,
    tick: function (vrm) {
      if (!vrm) return;
      applyHeld(vrm);
      if (vrm.__psxUvBinds) applyUvBinds(vrm);
    },

    // called from the face rig, after the app has written its own presets and
    // before blendShapeProxy.update() applies them
    face: function (vrm, rig) {
      try { driveEmotions(vrm, rig); } catch (e) { log('face hook failed', e); }
    },

    headGain: headGain,
    bodyGain: bodyGain,
    smooth: smooth,

    frame: frame,
    nextTrack: nextTrack,
    mpOptions: mpOptions,
    shadows: shadows,
    shadowSize: shadowSize,

    overlay: overlay,
    overlayOpen: overlayOpen
  };
})();

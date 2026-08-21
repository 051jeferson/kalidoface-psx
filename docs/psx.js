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

  var DEFAULTS = {
    // render at 1 device pixel per CSS pixel and let CSS upscale with
    // image-rendering:pixelated -> hard pixel edges instead of a 2x downsample
    pixelRatio: 1,
    // 'en' | 'pt' - the panel language, and the app's own labels with it
    lang: 'en',

    // --- the actual PS1 signatures (all gated behind `enabled`) -------
    // The console had no floating point in its GPU: vertices were snapped to
    // an integer screen grid, which is where the characteristic wobble comes
    // from. Lower grid = coarser = wobblier.
    vertexSnap: true,
    snapGrid: 160,
    // 15-bit output, 5 bits per channel, with ordered dithering to hide the
    // banding. 32 levels per channel is the real thing.
    dither: true,
    colorLevels: 32,

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
    // Where the 0..1 signal range comes from:
    //   'calibrated' - the guided calibration below. Records what each face
    //                  actually reaches, so a brow that furrows far but barely
    //                  raises gets a different span in each direction.
    //   'auto'       - learn the range continuously while tracking
    //   'raw'        - Kalidokit's numbers untouched. Almost never usable:
    //                  the brow scalar only swings a few hundredths, so a
    //                  threshold of 0.35 can never be reached.
    signal: 'auto',
    // recorded by the guided calibration; null until it has been run
    cal: null,
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
    // Holistic modelComplexity 0 (lite) instead of 1
    poseLite: false,

    verbose: false
  };

  var STOCK_HEAD_GAIN = 1;
  var STOCK_BODY_GAIN = 0.05;

  var MOUTH_KEYS = { a: 1, i: 1, u: 1, e: 1, o: 1 };
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
    blinkGain: { min: 0.25, max: 3 },
    browGain: { min: 0.25, max: 4 },
    angryAt: { min: 0, max: 0.95 },
    sorrowAt: { min: 0, max: 0.95 },
    smileAt: { min: 0, max: 0.95 },
    speechAt: { min: 0, max: 1 },
    headGain: { min: 0, max: 1.5 },
    bodyGain: { min: 0, max: 0.2 },
    damping: { min: 0, max: 0.95 },
    trackFps: { min: 0, max: 60 },
    renderFps: { min: 0, max: 60 },
    colorLevels: { one: [8, 16, 32, 64] },
    fingers: { one: ['all', 'thumb', 'none'] },
    smileKey: { one: ['fun', 'joy', 'both'] },
    signal: { one: ['calibrated', 'auto', 'raw'] },
    lang: { one: ['en', 'pt'] }
  };

  var CAL_FIELDS = ['browRest', 'browDown', 'browUp', 'smileRest', 'smileMax'];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function sanitize(key, v) {
    var def = DEFAULTS[key];
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
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var j in saved) if (j in out) out[j] = sanitize(j, saved[j]);
      }
    } catch (e) {}
    out.preview = '';
    return out;
  }

  function resetSettings() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    var fresh = load();
    for (var k in fresh) cfg[k] = fresh[k];
    resetCalibration();
    applyCanvasFilter();
    refreshModels();
    syncControls();
    pendingReload = true;
    var notes = document.querySelectorAll('.psx-reload-note');
    Array.prototype.forEach.call(notes, function (n) { n.style.display = ''; });
    console.log('[psx] settings reset to defaults');
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

  function setText(node, text) {
    if (!node.__psxText) {
      node.textContent = '';
      node.__psxText = document.createTextNode('');
      node.appendChild(node.__psxText);
    }
    if (node.__psxText.nodeValue !== text) node.__psxText.nodeValue = text;
  }

  function paintReadout() {
    if (!readoutEl || !readoutEl.isConnected || !lastFace) return;
    var top = null;
    for (var i = 0; i < EMOTION_KEYS.length; i++) {
      var k = EMOTION_KEYS[i];
      if (lastFace.out[k] > 0 && (!top || lastFace.out[k] > lastFace.out[top])) top = k;
    }
    setText(readoutEl,
      'brow ' + lastFace.brow.toFixed(2) +
      '  ·  smile ' + lastFace.smile.toFixed(2) +
      '  ·  ' + (top ? top + ' ' + lastFace.out[top].toFixed(2) : 'neutral'));
  }

  function resetCalibration() {
    browTrack = tracker();
    smileTrack = tracker();
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
    { key: 'rest',  title: 'Face the camera',      hint: 'Head straight, shoulders square' },
    { key: 'left',  title: 'Turn your head left',  hint: 'As far as is comfortable, and hold' },
    { key: 'right', title: 'Turn your head right', hint: 'As far as is comfortable, and hold' },
    { key: 'up',    title: 'Look up',              hint: 'Tilt your head back and hold' },
    { key: 'down',  title: 'Look down',            hint: 'Tilt your chin down and hold' }
  ];

  var CAL_STEPS = [
    { key: 'rest',  title: 'Relax your face',   hint: 'Neutral, looking at the camera' },
    { key: 'down',  title: 'Furrow your brows', hint: 'Angry - pull them down and together' },
    { key: 'up',    title: 'Raise your brows',  hint: 'Surprised - lift them as high as you can' },
    { key: 'smile', title: 'Smile wide',        hint: 'Big smile, and hold it' }
  ];
  // No countdown to race. Each step waits for the person to say they are in
  // the pose, then samples briefly while they hold it - which is the whole
  // reason a guided calibration beats a continuous one, and it only works if
  // they are actually in the pose when it reads.
  var CAL_HOLD = 1400;   // ms of sampling once they confirm
  // Pressing the key jolts the head, and people are still settling into the
  // pose for a moment after they say they are in it. Those frames are the worst
  // ones in the window, so they are not read at all.
  var CAL_SETTLE = 250;
  // Below this there are not enough frames for a percentile to mean anything.
  var CAL_MIN_SAMPLES = 8;
  var calRun = null;
  var calEl = null;
  var calBtn = null;
  var calMotionEl = null;
  var calMotionBtn = null;
  var calCancelBtn = null;
  var calMotionCancelBtn = null;

  // A single bad frame - a dropped track, a blink, a head jerk - used to define
  // the whole span, because the extremes were taken as an absolute min or max.
  // Keeping the samples and reading a percentile off them costs nothing at this
  // size and throws that frame away instead of building the calibration on it.
  function stepAccum() {
    return { brow: [], smile: [], y: [], x: [] };
  }

  function pct(arr, q) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (m, n) { return m - n; });
    var i = (a.length - 1) * q;
    var lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
  }

  function median(a) { return pct(a, 0.5); }

  // Spread of the middle half. A pose held still has a small one; a shaky pose
  // has a large one, and its reading is worth less.
  function spread(a) { return pct(a, 0.75) - pct(a, 0.25); }

  function deviations(arr, rest) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(Math.abs(arr[i] - rest));
    return out;
  }

  function steps() { return calRun.kind === 'motion' ? MOTION_STEPS : CAL_STEPS; }

  function begin(kind) {
    calRun = { kind: kind, i: 0, phase: 'wait', until: 0, acc: stepAccum(), out: {} };
    paintCalibration(0);
    syncCalUi();
  }

  // Called from the button or the keyboard: the person is in the pose, read it.
  function captureStep() {
    if (!calRun || calRun.phase !== 'wait') return;
    calRun.phase = 'hold';
    calRun.holdFrom = now();
    calRun.until = calRun.holdFrom + CAL_HOLD;
    calRun.acc = stepAccum();
    calTick();
    syncCalUi();
  }

  function startCalibration() { begin('face'); }
  function startMotionCalibration() { begin('motion'); }

  function stopCalibration(note) {
    var el0 = calTarget();
    calRun = null;
    if (el0) setText(el0, note || '');
    syncCalUi();
  }

  // Only runs while a step is being sampled; waiting for the person costs
  // nothing. Time advances here rather than in the face hook, so a capture with
  // no face tracked still ends instead of hanging.
  function calTick() {
    if (!calRun || calRun.phase !== 'hold') return;
    var t = now();
    if (t >= calRun.until) { advanceCalibration(); return; }
    requestAnimationFrame(calTick);
    paintCalibration(Math.max(0, calRun.until - t));
  }

  function nextStep(total, finish) {
    calRun.i++;
    if (calRun.i >= total) { finish(); return; }
    calRun.phase = 'wait';
    paintCalibration(0);
    syncCalUi();
  }

  function advanceCalibration() {
    var st = steps()[calRun.i];
    var a = calRun.acc;
    var motion = calRun.kind === 'motion';
    var n = motion ? a.y.length : a.brow.length;

    if (n < CAL_MIN_SAMPLES) {
      // Redo the step rather than record it: a span built on three frames is
      // worse than no calibration, because it looks like one.
      calRun.phase = 'wait';
      paintCalibration(0);
      syncCalUi();
      setText(calTarget(), T('Only') + ' ' + n + ' ' +
        T('frames were read - hold the pose and try that step again.'));
      syncCalUi();
      return;
    }

    if (motion) {
      if (st.key === 'rest') {
        calRun.out.restY = median(a.y);
        calRun.out.restX = median(a.x);
      } else {
        var yaw = st.key === 'left' || st.key === 'right';
        var arr = yaw ? a.y : a.x;
        var rest = yaw ? calRun.out.restY : calRun.out.restX;
        // 90th percentile of the deviation, not the largest one seen
        calRun.out[st.key] = pct(deviations(arr, rest), 0.9);
        calRun.shake = Math.max(calRun.shake || 0, spread(arr));
      }
      nextStep(MOTION_STEPS.length, finishMotion);
      return;
    }

    if (st.key === 'rest') {
      calRun.out.browRest = median(a.brow);
      calRun.out.smileRest = median(a.smile);
    } else if (st.key === 'down') {
      calRun.out.browDown = pct(a.brow, 0.1);
      calRun.shake = Math.max(calRun.shake || 0, spread(a.brow));
    } else if (st.key === 'up') {
      calRun.out.browUp = pct(a.brow, 0.9);
      calRun.shake = Math.max(calRun.shake || 0, spread(a.brow));
    } else if (st.key === 'smile') {
      calRun.out.smileMax = pct(a.smile, 0.9);
    }
    nextStep(CAL_STEPS.length, finishCalibration);
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

  function finishMotion() {
    var c = calRun.out;
    var devY = Math.max(c.left || 0, c.right || 0);
    var devX = Math.max(c.up || 0, c.down || 0);
    var dev = Math.max(devY, devX);

    if (dev < 0.05) {
      stopCalibration(T('Barely any head movement was tracked. Is face tracking running?'));
      return;
    }

    cfg.headGain = clamp(0.8 / dev, 0, 1.5);
    cfg.bodyGain = clamp(STOCK_BODY_GAIN * (cfg.headGain / STOCK_HEAD_GAIN), 0, 0.2);
    cfg.motion = true;
    save();
    syncControls();

    stopCalibration(shakeNote(dev) + T('Calibrated') + ' - ' + T('turn') + ' ' + devY.toFixed(2) +
      ', ' + T('tilt') + ' ' + devX.toFixed(2) + '  ->  ' +
      T('Head / neck gain') + ' ' + cfg.headGain.toFixed(2) +
      ', ' + T('Torso gain') + ' ' + cfg.bodyGain.toFixed(3) + '.');
  }

  function finishCalibration() {
    var c = calRun.out;
    var down = Math.abs(c.browDown - c.browRest);
    var up = Math.abs(c.browUp - c.browRest);
    var sm = c.smileMax - c.smileRest;
    var weak = [];
    if (down < 0.004) weak.push('furrow');
    if (up < 0.004) weak.push('raise');
    if (sm < 0.01) weak.push('smile');

    cfg.cal = c;
    cfg.signal = 'calibrated';
    save();
    syncControls();

    var msg = shakeNote(Math.max(down, up)) + T('Calibrated') +
      ' - ' + T('furrow') + ' ' + down.toFixed(3) +
      ', ' + T('raise') + ' ' + up.toFixed(3) +
      ', ' + T('smile') + ' ' + sm.toFixed(3) + '.';
    if (weak.length) {
      msg += ' ' + T('These barely moved:') + ' ' + weak.join(', ') + '. ' +
        T('Redo that step with a bigger expression if it does not trigger.');
    }
    log('calibration', c);
    stopCalibration(msg);
  }

  // Each wizard writes into the card it was started from.
  function calTarget() {
    return calRun && calRun.kind === 'motion' ? calMotionEl : calEl;
  }

  function paintCalibration(left) {
    var calEl = calTarget();
    if (!calEl || !calRun) return;
    var st = steps()[calRun.i];
    setText(calEl,
      (calRun.i + 1) + '/' + steps().length + '  ' + T(st.title) +
      NL + T(st.hint) +
      NL + (calRun.phase === 'wait'
        ? T('Hold the pose, then press Space. Esc cancels.')
        : T('Reading, keep holding...')));
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
      return;
    }
    a.brow.push(rawBrow);
    a.smile.push(rawSmile);
  }

  // Each brow direction gets its own span, which is the whole point of asking
  // for the poses separately.
  function calibratedBrow(raw) {
    var c = cfg.cal;
    var dev = raw - c.browRest;
    var span = dev < 0 ? Math.abs(c.browDown - c.browRest) : Math.abs(c.browUp - c.browRest);
    return dev / Math.max(span, 0.004);
  }

  function calibratedSmile(raw) {
    var c = cfg.cal;
    return (raw - c.smileRest) / Math.max(c.smileMax - c.smileRest, 0.01);
  }

  function driveEmotions(vrm, rig, rawBrow, rawSmile) {
    if (!cfg.emotions) return;
    var proxy = vrm && vrm.blendShapeProxy;
    if (!proxy || !rig) return;

    // a recorded calibration is the best mapping, but fall back rather than
    // going dead if the mode is selected before it has been run
    var mode = cfg.signal;
    if (mode === 'calibrated' && !cfg.cal) mode = 'auto';

    var brow, smile;
    if (mode === 'calibrated') {
      brow = clamp(calibratedBrow(rawBrow) * cfg.browGain, -1, 1);
      smile = clamp(calibratedSmile(rawSmile) * cfg.browGain, 0, 1);
    } else if (mode === 'auto') {
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
    { heading: 'Smile Detection [Beta]', card: '.list', pin: false }
  ];

  function stripTarget(spec) {
    if (spec.heading) {
      var hs = document.querySelectorAll('h4');
      for (var j = 0; j < hs.length; j++) {
        if ((hs[j].textContent || '').trim() !== spec.heading) continue;
        var c = hs[j].closest(spec.card);
        return { card: c, input: c && c.querySelector('input') };
      }
      return null;
    }
    var el = null;
    if (spec.find) el = document.querySelector(spec.find);
    else if (spec.aria) {
      for (var i = 0; i < spec.aria.length && !el; i++) {
        el = document.querySelector('input[aria-label="' + spec.aria[i] + '"]');
      }
    }
    return el ? { card: el.closest(spec.card), input: el } : null;
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
    if (typeof want === 'boolean') {
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
    'Texture expressions': 'Expressões por textura',
    'Snap to cell': 'Encaixar na célula',
    'Flip V axis': 'Inverter eixo V',
    'Trigger threshold': 'Limiar de disparo',
    'Release margin': 'Margem de liberação',
    'Minimum hold': 'Tempo mínimo',
    'Mouth gain': 'Ganho da boca',
    'Blink gain': 'Ganho da piscada',
    'Preview cell': 'Pré-visualizar célula',
    'live tracking': 'rastreio ao vivo',
    'Load a VRM to calibrate individual cells.': 'Carregue um VRM para calibrar células individuais.',

    // --- emotions ---
    'Emotion Detection': 'Detecção de emoções',
    'Detect emotions': 'Detectar emoções',
    'Signal range': 'Faixa do sinal',
    'calibrated': 'calibrado',
    'auto': 'auto',
    'raw': 'bruto',
    'One emotion at a time': 'Uma emoção por vez',
    'Speech first': 'Prioridade à fala',
    'Talking at': 'Falando a partir de',
    'Signal gain': 'Ganho do sinal',
    'Angry at': 'Bravo a partir de',
    'Sorrow at': 'Triste a partir de',
    'Smile at': 'Sorriso a partir de',
    'Smile drives': 'Sorriso aciona',
    'fun + joy': 'fun + joy',
    'waiting for a tracked face...': 'aguardando um rosto rastreado...',
    'Calibrate expressions': 'Calibrar expressões',
    'Cancel calibration': 'Cancelar calibração',
    'Reset auto range': 'Zerar faixa automática',
    'Calibrate motion': 'Calibrar movimento',
    'Capture (Space)': 'Capturar (Espaço)',
    'Reading...': 'Lendo...',
    'Hold the pose, then press Space. Esc cancels.':
      'Faça a pose, segure, e aperte Espaço. Esc cancela.',
    'Reading, keep holding...': 'Lendo, continue segurando...',
    'Only': 'Apenas',
    'frames were read - hold the pose and try that step again.':
      'frames foram lidos - segure a pose e refaça esse passo.',
    'The poses moved a lot while being read; redo it holding stiller for a tighter fit.':
      'As poses se mexeram bastante durante a leitura; refaça segurando mais firme para um ajuste melhor.',
    'Face the câmera': 'Encare a câmera',
    'Head straight, shoulders square': 'Cabeca reta, ombros alinhados',
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
    'turn': 'giro',
    'tilt': 'inclinacao',
    'neutral': 'neutro',

    // --- calibration prompts ---
    'Relax your face': 'Relaxe o rosto',
    'Neutral, looking at the câmera': 'Neutro, olhando para a câmera',
    'Furrow your brows': 'Franza as sobrancelhas',
    'Angry - pull them down and together': 'Bravo - puxe para baixo e para o centro',
    'Raise your brows': 'Levante as sobrancelhas',
    'Surprised - lift them as high as you can': 'Surpreso - levante o máximo que conseguir',
    'Smile wide': 'Sorria bastante',
    'Big smile, and hold it': 'Sorriso grande, e segure',
    'get ready': 'prepare-se',
    'hold': 'segure',
    'Calibration cancelled.': 'Calibração cancelada.',

    // --- motion ---
    'Motion Calibration': 'Calibragem de movimento',
    'Motion calibration': 'Calibragem de movimento',
    'Head / neck gain': 'Ganho de cabeça / pescoço',
    'Torso gain': 'Ganho do torso',
    'Damping': 'Amortecimento',

    // --- performance ---
    'Performance': 'Desempenho',
    'Performance caps': 'Limites de desempenho',
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
    'Log diagnostics to console': 'Registrar diagnóstico no console',
    'Check bundle hooks': 'Conferir hooks do bundle',
    'Reset PSX settings': 'Restaurar ajustes PSX',
    'Language': 'Idioma',
    'English': 'English',
    'Portuguese (BR)': 'Português (BR)',

    // --- notes ---
    'note.reloadRender': 'A escala de render e aplicada ao recarregar.',
    'note.reloadPerf': 'As opções do modelo Mediapipe são aplicadas ao recarregar. Os limites de taxa valem na hora.',
    'note.emotions': 'O app so rastreia piscadas, as cinco vogais e um sorriso. Bravo, triste e fun nunca são escritos - isto os deriva da sobrancelha e da boca para que essas células possam disparar. Faça cada careta e observe a leitura para ajustar os limiares.',
    'note.motion': 'Os ganhos de pescoço e torso são fixos no app, entao um movimento real pequeno vira um movimento grande no avatar. Baixe o ganho para mexer menos, aumente o amortecimento para mexer mais devagar.',
    'note.perf': 'O app roda uma inferencia do Mediapipe a cada frame e renderiza a cada frame. A taxa de rastreio é onde vai quase toda a CPU.',

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
    'Change Camera': 'Trocar câmera',
    'Reset Character Tracking': 'Reiniciar rastreio do personagem',
    'For eyetracking, use both face and full body tracking.':
      'Para rastreio ocular, use rastreio facial e de corpo inteiro juntos.',
    'Allow webcam access to see câmera list.':
      'Permita o acesso à webcam para ver a lista de cameras.'
  };

  var EN = {
    'note.reloadRender': 'Render scale applies on reload.',
    'note.reloadPerf': 'The Mediapipe model options apply on reload. ' +
      'The rate caps take effect immediately.',
    'note.emotions': 'The app only tracks blinks, the five vowels and a smile. Angry, ' +
      'sorrow and fun are never written at all - this derives them from the brow and ' +
      'mouth so those cells can fire. Pull each face and watch the readout to set the ' +
      'thresholds.',
    'note.motion': 'The neck and torso gains are hardcoded upstream, so a small real ' +
      'movement lands as a large avatar movement. Lower the gain to move less, raise ' +
      'the damping to move slower.',
    'note.perf': 'Upstream runs a Mediapipe inference on every animation frame, renders ' +
      'on every animation frame. The ' +
      'tracking rate is where nearly all the CPU goes.'
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
    face: 1, headGain: 1, bodyGain: 1, smooth: 4, frame: 1, nextTrack: 1,
    mpOptions: 2, shadows: 1, shadowSize: 4, overlay: 3, overlayOpen: 1, gaze: 1
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

  // Called with whatever options object is about to reach setOptions - Holistic
  // spells the refinement flag one way, FaceMesh another, so touch whichever
  // keys are actually present.
  function mpOptions(opts) {
    if (!opts) return opts;
    // Always off: the refinement model exists to place iris landmarks and
    // denser lip contours, and its main consumer here was the eye aim we no
    // longer do. It is a whole extra network per frame for detail a texture
    // atlas cannot show. Holistic and FaceMesh spell the flag differently.
    if ('refineFaceLandmarks' in opts) opts.refineFaceLandmarks = false;
    if ('refineLandmarks' in opts) opts.refineLandmarks = false;
    if (cfg.perf && 'modelComplexity' in opts) opts.modelComplexity = cfg.poseLite ? 0 : 1;
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
    eachMaterial(vrm, hookMaterial);
    syncShaderUniforms();
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
  // The labels are baked into the DOM when a card is built, so switching
  // language means throwing the cards away and building them again.
  var REBUILDS = { lang: 1 };

  var NEEDS_RELOAD = {
    pixelRatio: 1, perf: 1, poseLite: 1
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
      syncShaderUniforms();
      if (REBUILDS[key]) rebuildPanels();
      applyStrip();
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
      onChange(key);
    });
    paint();
    parent.appendChild(h);
    parent.appendChild(input);
    controls.push({ key: key, node: input, sync: paint });
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

    var x = card(T('Face Expressions'), STG);
    addToggle(x, 'uvExpressions', T('Texture expressions'), STG);
    addToggle(x, 'snapExpressions', T('Snap to cell'), STG);
    addToggle(x, 'uvFlipV', T('Flip V axis'), STG);
    addRule(x);
    addRange(x, 'threshold', T('Trigger threshold'), 0, 1, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(x, 'hysteresis', T('Release margin'), 0, 0.5, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(x, 'holdMs', T('Minimum hold'), 0, 400, 10, function (v) { return v + ' ms'; }, STG);
    addRule(x);
    addRange(x, 'mouthGain', T('Mouth gain'), 0.25, 3, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(x, 'blinkGain', T('Blink gain'), 0.25, 3, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
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

    // --- emotions ------------------------------------------------------
    var em = card(T('Emotion Detection'), STG);
    var emNote = el('div', STG, T('note.emotions'));
    emNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    em.appendChild(emNote);
    addToggle(em, 'emotions', T('Detect emotions'), STG);
    addSelect(em, 'signal', T('Signal range'), ['calibrated', 'auto', 'raw'],
      [T('calibrated'), T('auto'), T('raw')], STG);
    addToggle(em, 'exclusive', T('One emotion at a time'), STG);
    addRule(em);
    addToggle(em, 'speechFirst', T('Speech first'), STG);
    addRange(em, 'speechAt', T('Talking at'), 0, 1, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRule(em);
    addRange(em, 'browGain', T('Signal gain'), 0.25, 4, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(em, 'angryAt', T('Angry at'), 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(em, 'sorrowAt', T('Sorrow at'), 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRange(em, 'smileAt', T('Smile at'), 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);
    addRule(em);
    addSelect(em, 'smileKey', T('Smile drives'), ['fun', 'joy', 'both'],
      ['fun', 'joy', T('fun + joy')], STG);
    addRule(em);

    readoutEl = el('div', STG, T('waiting for a tracked face...'));
    readoutEl.style.cssText = 'width:100%;font-size:12px;opacity:.75;text-align:left;' +
      'font-variant-numeric:tabular-nums;font-feature-settings:"tnum"';
    em.appendChild(readoutEl);

    calEl = el('div', STG, '');
    calEl.style.cssText = 'width:100%;font-size:12px;opacity:.85;text-align:left;' +
      'white-space:pre-line;margin-top:10px;line-height:1.5';
    em.appendChild(calEl);

    calBtn = el('button', 'trigger ' + STG, '');
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
      stopCalibration(T('Calibration cancelled.'));
    });
    em.appendChild(calCancelBtn);

    var recal = el('button', 'trigger ' + STG, T('Reset auto range'));
    recal.style.marginTop = '8px';
    recal.addEventListener('click', function () { resetCalibration(); });
    em.appendChild(recal);
    syncCalUi();
    frag.appendChild(em);

    // --- motion --------------------------------------------------------
    var mo = card(T('Motion Calibration'), STG);
    var moNote = el('div', STG, T('note.motion'));
    moNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    mo.appendChild(moNote);
    addToggle(mo, 'motion', T('Motion calibration'), STG);
    addRule(mo);
    addRange(mo, 'headGain', T('Head / neck gain'), 0, 1.5, 0.05, function (v) { return v.toFixed(2) + 'x'; }, STG);
    addRange(mo, 'bodyGain', T('Torso gain'), 0, 0.2, 0.005, function (v) { return v.toFixed(3) + 'x'; }, STG);
    addRange(mo, 'damping', T('Damping'), 0, 0.95, 0.01, function (v) { return v.toFixed(2); }, STG);

    calMotionEl = el('div', STG, '');
    calMotionEl.style.cssText = 'width:100%;font-size:12px;opacity:.85;text-align:left;' +
      'white-space:pre-line;margin-top:10px;line-height:1.5';
    mo.appendChild(calMotionEl);

    calMotionBtn = el('button', 'trigger ' + STG, '');
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
      stopCalibration(T('Calibration cancelled.'));
    });
    mo.appendChild(calMotionCancelBtn);
    frag.appendChild(mo);

    // --- performance ---------------------------------------------------
    var pf = card(T('Performance'), STG);
    var pfNote = el('div', STG, T('note.perf'));
    pfNote.style.cssText = 'width:100%;opacity:.5;font-size:12px;margin:0 0 4px;text-align:left';
    pf.appendChild(pfNote);
    addToggle(pf, 'perf', T('Performance caps'), STG);
    addRule(pf);
    addRange(pf, 'trackFps', T('Tracking rate'), 0, 60, 1, fpsLabel, STG);
    addRange(pf, 'renderFps', T('Render rate'), 0, 60, 1, fpsLabel, STG);
    addRule(pf);
    addToggle(pf, 'poseLite', T('Lite pose model'), STG);
    reloadNote(pf, T('note.reloadPerf'), STG);
    frag.appendChild(pf);

    var hnd = card(T('PSX Hands'), STG);
    addSelect(hnd, 'lang', T('Language'), ['en', 'pt'],
      [T('English'), T('Portuguese (BR)')], STG);
    addRule(hnd);
    addSelect(hnd, 'fingers', T('Driven fingers'), ['all', 'thumb', 'none'],
      [T('all fingers'), T('thumb only'), T('none')], STG);
    var dbg = el('button', 'trigger ' + STG, T('Log diagnostics to console'));
    dbg.style.marginTop = '20px';
    dbg.addEventListener('click', function () { dump(); });
    hnd.appendChild(dbg);

    var chk = el('button', 'trigger ' + STG, T('Check bundle hooks'));
    chk.style.marginTop = '8px';
    chk.addEventListener('click', function () { verify(); });
    hnd.appendChild(chk);

    var rst = el('button', 'trigger reset ' + STG, T('Reset PSX settings'));
    rst.style.marginTop = '8px';
    rst.addEventListener('click', function () { resetSettings(); });
    hnd.appendChild(rst);
    // .last only exists in the Effects scope, so carry FX along for the margin
    hnd.classList.add('last', FX);
    frag.appendChild(hnd);

    return frag;
  }

  // The primary button doubles as the step advance, so the whole flow works
  // with the mouse alone; Space and Esc are the shortcut, not the only way in.
  function calLabel(mine, idle) {
    if (!mine) return idle;
    return calRun.phase === 'wait' ? T('Capture (Space)') : T('Reading...');
  }

  function syncCalUi() {
    var busy = !!calRun;
    if (calBtn) {
      setText(calBtn, calLabel(busy && calRun.kind === 'face', T('Calibrate expressions')));
    }
    if (calMotionBtn) {
      setText(calMotionBtn, calLabel(busy && calRun.kind === 'motion', T('Calibrate motion')));
    }
    if (calCancelBtn) calCancelBtn.style.display = busy ? '' : 'none';
    if (calMotionCancelBtn) calMotionCancelBtn.style.display = busy ? '' : 'none';
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
    calEl = calMotionEl = calBtn = calMotionBtn = readoutEl = null;
    calCancelBtn = calMotionCancelBtn = null;
    lastInject = 0;
    translateTree(document.body || document.documentElement);
    tryInject();
  }

  function tryInject() {
    applyStrip();
    pruneControls();
    injectInto(effectsContainer(), buildEffects, false);
    injectInto(settingsContainer(), buildSettings, true);
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
    if (!(en in PT)) return;
    n.__psxEn = en;
    var want = cfg.lang === 'pt' ? PT[en] : en;
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
  function translateMutations(list) {
    for (var i = 0; i < list.length; i++) {
      translateTree(list[i].target);
      var added = list[i].addedNodes || [];
      for (var j = 0; j < added.length; j++) translateTree(added[j]);
    }
  }

  function onCalKey(e) {
    if (!calRun) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      stopCalibration(T('Calibration cancelled.'));
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
    tick: function (vrm) {
      if (!vrm) return;
      applyHeld(vrm);
      if (vrm.__psxUvBinds) applyUvBinds(vrm);
    },

    // called from the face rig, after the app has written its own presets and
    // before blendShapeProxy.update() applies them
    face: function (vrm, rig) {
      try {
        var rawBrow = num(rig && rig.brow);
        var rawSmile = num(rig && rig.mouth && rig.mouth.x);
        // calibration has to record even with emotions switched off, since
        // that is the order people will do it in
        sampleCalibration(rawBrow, rawSmile, rig);
        driveEmotions(vrm, rig, rawBrow, rawSmile);
      } catch (e) { log('face hook failed', e); }
    },

    calibrate: startCalibration,
    calibrateMotion: startMotionCalibration,
    resetCalibration: resetCalibration,
    resetSettings: resetSettings,
    verify: verify,

    headGain: headGain,
    bodyGain: bodyGain,
    smooth: smooth,

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

// Optional browser checks. Pass an installed Playwright package's index.mjs;
// Playwright is a development tool, never a dependency of the static app.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createSiteServer } from './serve.mjs';

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : 'playwright');
const server = createSiteServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['microphone']);
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.testMicStreams = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints);
      if (constraints.audio && !constraints.video) window.testMicStreams.push(stream);
      return stream;
    };
  });
  const page = await context.newPage();
  const errors = [], remote = new Set();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base + '/') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    remote.add(url); return route.abort();
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.PSX && !window.PSX.stub && document.querySelector('canvas'));
  assert.deepEqual(await page.evaluate(() => PSX.verify()), []);
  console.log('Startup:', JSON.stringify({ errors, remote: [...remote] }));

  // Real bundled three.js transforms, a synthetic rig with known dimensions.
  // This checks the whole IK path, not a second implementation of its math.
  const rigResult = await page.evaluate(async () => {
    const mod = await import('./assets/vendor.832d142e.js');
    const Group = mod.ae;
    const bones = {}, root = new Group();
    function bone(name, parent, x, y, z) {
      const b = new Group(); b.name = name; b.position.set(x, y, z);
      parent.add(b); bones[name] = b; return b;
    }
    const hips = bone('hips', root, 0, 0.9, 0);
    const chest = bone('chest', hips, 0, 0.5, 0);
    bone('head', chest, 0, 0.25, 0);
    for (const side of ['right', 'left']) {
      const sign = side === 'right' ? -1 : 1;
      const u = bone(side + 'UpperArm', chest, sign * 0.2, 0, 0);
      const l = bone(side + 'LowerArm', u, sign * 0.27, 0, 0);
      const h = bone(side + 'Hand', l, sign * 0.24, 0, 0);
      bone(side + 'MiddleProximal', h, sign * 0.08, 0, 0);
      bone(side + 'IndexProximal', h, sign * 0.07, 0, 0.03);
      bone(side + 'LittleProximal', h, sign * 0.065, 0, -0.03);
    }
    const vrm = { humanoid: { getBoneNode: name => bones[name] } };
    const p = (x, y, z = 0) => ({ x, y, z, visibility: 1 });
    const world = Array.from({ length: 33 }, () => p(0, 0));
    world[11] = p(-0.2, -0.5); world[12] = p(0.2, -0.5);
    world[23] = p(-0.15, 0); world[24] = p(0.15, 0);
    world[7] = p(-0.08, -0.75); world[8] = p(0.08, -0.75);
    world[0] = p(0, -0.75, -0.08);
    world[13] = p(-0.35, -0.25); world[14] = p(0.35, -0.25);
    world[15] = p(-0.15, -0.09); world[16] = p(0.15, -0.09);
    const image = world.map(v => p(0.5 + v.x, 0.8 + v.y, v.z));
    const cfg = { ...PSX.cfg };
    Object.assign(PSX.cfg, { armIK: true, shoulder: 0, armReach: 1,
      reachR: 1, reachL: 1, armDepth: 1, reachUp: 1, headAnchor: 1, twist: 1, predict: 0 });
    const dummy = {};
    function solve() {
      PSX.pose(world, image, { Right: null, Left: null });
      const success = PSX.arm(vrm, dummy, 'Right', false, true,
        bones.rightUpperArm, bones.rightLowerArm, bones.rightHand);
      const out = new mod.V(); bones.rightHand.getWorldPosition(out);
      return { success, position: { x: out.x, y: out.y, z: out.z }, debug: PSX.armInfo().right };
    }
    const waist = solve();
    world[15] = p(-0.08, -0.74, -0.05); image[15] = p(0.42, 0.06, -0.05);
    world[13] = p(-0.43, -0.5); image[13] = p(0.07, 0.3);
    const head = solve();
    world[15] = p(-0.15, -0.09, -0.05); world[15].visibility = 0.1;
    image[15] = p(0.35, 0.71, -0.05); image[15].visibility = 0.1;
    const hand = Array.from({ length: 21 }, () => p(0.49, 0.12, 0));
    hand[5] = p(0.47, 0.075, -0.01); hand[9] = p(0.49, 0.07, -0.01);
    hand[17] = p(0.515, 0.085, -0.01);
    PSX.pose(world, image, { Right: hand, Left: null });
    const recovered = PSX.arm(vrm, dummy, 'Right', false, true,
      bones.rightUpperArm, bones.rightLowerArm, bones.rightHand);
    const recovery = { success: recovered, debug: PSX.armInfo().right };
    const start = performance.now();
    for (let i = 0; i < 2000; i++) {
      PSX.arm(vrm, dummy, 'Right', false, true, bones.rightUpperArm, bones.rightLowerArm, bones.rightHand);
    }
    const msPerArm = (performance.now() - start) / 2000;
    // A mitten-style PSX rig may expose only a thumb: no middle/index/little
    // humanoid bones. The old path silently produced no roll on either hand.
    const hidden = {};
    for (const name of ['rightMiddleProximal', 'rightIndexProximal', 'rightLittleProximal']) {
      hidden[name] = bones[name]; delete bones[name];
    }
    bone('rightThumbProximal', bones.rightHand, -0.04, 0, 0.025);
    const thumbVrm = { humanoid: vrm.humanoid };
    const thumbTurns = [];
    for (const direction of [1, -1]) {
      hand[1] = p(hand[0].x + 0.04 * direction, hand[0].y, hand[0].z + 0.02 * direction);
      PSX.pose(world, image, { Right: hand, Left: null });
      const success = PSX.arm(thumbVrm, dummy, 'Right', false, true,
        bones.rightUpperArm, bones.rightLowerArm, bones.rightHand);
      thumbTurns.push({ success, ...PSX.armInfo().right });
    }
    Object.assign(bones, hidden);
    world[15] = p(-0.15, -0.09); world[13] = p(-0.35, -0.25);
    image[15] = p(0.35, 0.71); image[13] = p(0.15, 0.55);
    world[19] = p(-0.15, -0.09, 0.04); world[17] = p(-0.15, -0.09, -0.04);
    function palmFrame() {
      PSX.pose(world, image, { Right: null, Left: null });
      PSX.arm(vrm, dummy, 'Right', false, false,
        bones.rightUpperArm, bones.rightLowerArm, bones.rightHand);
      return PSX.armInfo().right;
    }
    const palmBefore = palmFrame();
    [world[19], world[17]] = [world[17], world[19]];
    const palmFlip = palmFrame();
    for (let i = 0; i < 100; i++) PSX.arm(vrm, dummy, 'Right', false, false,
      bones.rightUpperArm, bones.rightLowerArm, bones.rightHand);
    const palmRepeat = PSX.armInfo().right;
    palmFrame();
    const palmRecovered = palmFrame();
    Object.assign(PSX.cfg, cfg);
    return { waist, head, recovery, msPerArm, thumbTurns, palmBefore, palmFlip, palmRepeat, palmRecovered };
  });
  assert.ok(rigResult.waist.success && rigResult.head.success, 'both contact poses must solve');
  assert.ok(rigResult.waist.debug.waist > 0.9);
  assert.ok(rigResult.head.debug.anchor > 0.9);
  assert.ok(Math.abs(rigResult.waist.position.y - 0.99) < 0.015, 'wrist reaches the model waist');
  assert.ok(rigResult.head.position.y > 1.55, 'wrist reaches the model head');
  assert.ok(Object.values(rigResult.head.position).every(Number.isFinite));
  assert.ok(rigResult.recovery.success);
  assert.equal(rigResult.recovery.debug.wristSource, 'hand image');
  assert.ok(typeof rigResult.recovery.debug.palmError === 'number' && Math.abs(rigResult.recovery.debug.palmError) <= 1,
    'the complete retarget preserves the detected palm with a bent wrist');
  assert.ok(rigResult.thumbTurns.every(t => t.success && t.palmBasis === 'thumb-wrist' && typeof t.rollDeg === 'number'),
    'a thumb-only rig must rotate instead of silently losing palm roll');
  const thumbDelta = (rigResult.thumbTurns[1].rollDeg - rigResult.thumbTurns[0].rollDeg) * Math.PI / 180;
  assert.ok(Math.abs(Math.atan2(Math.sin(thumbDelta), Math.cos(thumbDelta))) > 170 * Math.PI / 180,
    'turning the thumb to the other side turns the mitten palm/dorsum by a half turn');
  assert.equal(rigResult.palmBefore.rollSource, 'pose');
  assert.equal(rigResult.palmBefore.rollRejected, false);
  assert.equal(rigResult.palmFlip.rollRejected, true, 'an inverted palm must be confirmed');
  assert.equal(rigResult.palmFlip.rollHeld, true, 'keep the previous roll while rejecting a flip');
  assert.equal(rigResult.palmRepeat.rollRejected, true, 'renders cannot confirm an inversion');
  assert.equal(rigResult.palmRepeat.rollDeg, rigResult.palmBefore.rollDeg);
  assert.equal(rigResult.palmRecovered.rollRejected, false, 'a consistent new palm recovers');
  console.log('Bundled three.js IK:', JSON.stringify(rigResult));
  // a fresh profile takes cfg.lang from navigator.languages, so on a pt-BR
  // machine the app boots translated and the button says "Ajustes" - match
  // either label
  await page.locator('button.subButton[data-text="Settings"], button.subButton[data-text="Ajustes"]').click();
  const language = page.locator('select[name="psx-lang"]');
  await language.waitFor();
  await language.selectOption('1');
  assert.equal(await page.locator('html').getAttribute('lang'), 'pt-BR');
  assert.equal(await page.locator('[data-psx-mic]').textContent(), 'Ativar microfone');
  await language.selectOption('0');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.ok(await page.locator('input[name="psx-threshold"]').getAttribute('aria-valuetext'));
  assert.equal(await page.evaluate(() => testMicStreams.length), 0, 'microphone stays off on startup');
  await page.getByRole('button', { name: 'Enable microphone', exact: true }).click();
  await page.waitForFunction(() => PSX.mic().state !== 'requesting');
  const micState = await page.evaluate(() => PSX.mic());
  assert.equal(micState.state, 'active', JSON.stringify(micState));
  const microphone = page.locator('select[name="psx-micDevice"]');
  await page.waitForFunction(() => document.querySelector('select[name="psx-micDevice"]').options.length > 1);
  await microphone.selectOption('1');
  await page.waitForFunction(() => PSX.mic().state === 'active' && testMicStreams.length === 2);
  assert.equal(await page.evaluate(() => testMicStreams[0].getTracks()[0].readyState), 'ended');
  await page.locator('select[name="psx-micMode"]').selectOption('1');
  assert.equal(await page.evaluate(() => PSX.mic().mode), 'speech');
  assert.ok(await page.getByText('The microphone controls speech;', { exact: false }).isVisible());
  const audioResult = await page.evaluate(async () => {
    const values = {};
    const vrm = { blendShapeProxy: {
      setValue: (k, v) => { values[k] = v; }, getValue: k => values[k] || 0
    } };
    const face = { mouth: { x: 0.3, y: 0.5, shape: {} } };
    const start = performance.now();
    for (let i = 0; i < 25; i++) {
      PSX.face(vrm, face);
      await new Promise(resolve => setTimeout(resolve, 55));
    }
    return { ...PSX.mic(), elapsed: performance.now() - start };
  });
  assert.ok(audioResult.reads > 0 && audioResult.reads <= 25);
  assert.ok(audioResult.reads <= Math.ceil(audioResult.elapsed / 50));
  console.log('Real Web Audio sampling (synthetic microphone):', JSON.stringify(audioResult));
  await page.getByRole('button', { name: 'Disable microphone', exact: true }).click();
  assert.equal(await page.evaluate(() => PSX.mic().state), 'off');
  assert.equal(await page.evaluate(() => testMicStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true,
    'disabling microphone stops its real browser track');
  // the fork relabelled this button when backgrounds became the Back layer
  // (EN "Back", PT "Fundo") - go by its class, which the label swaps don't touch
  await page.locator('button.menu-item.bg').click();
  const green = page.getByRole('button', { name: 'Chroma green', exact: true });
  await green.waitFor();
  await green.focus();
  await page.keyboard.press('Enter');
  assert.equal(await green.getAttribute('aria-pressed'), 'true');
  assert.equal(await green.evaluate(n => n === document.activeElement), true, 'swatch rebuild keeps keyboard focus');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await green.evaluate(n => getComputedStyle(n).transitionDuration), '1e-05s');

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(metrics.scroll <= metrics.width + 1, `horizontal overflow at ${width}px`);
    await mkdir(new URL('../.audit/', import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`../.audit/browser-${width}.png`, import.meta.url)) });
  }
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.goto(base + '/?source=pwa', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.PSX && !window.PSX.stub && document.querySelector('canvas'));
  assert.equal(await page.evaluate(() => document.fonts.check('16px Kalicon')), true);
  assert.deepEqual(errors, [], 'no uncaught application errors');
  console.log('Browser smoke passed: startup, hooks, real bone transforms, contact poses, microphone lifecycle, language, keyboard colours, reduced motion, narrow viewport, first-visit offline/PWA shell.');
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

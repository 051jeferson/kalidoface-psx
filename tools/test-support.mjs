import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../docs/psx.js', import.meta.url), 'utf8');
export function runtime(saved = null, overrides = {}) {
  const noop = () => {};
  const document = {
    readyState: 'loading', addEventListener: noop,
    getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], documentElement: { style: {} }
  };
  const window = { addEventListener: noop, requestAnimationFrame: noop,
    cancelAnimationFrame: noop, performance: { now: () => 1000 } };
  Object.assign(window, overrides.window);
  const context = vm.createContext({ window, document, console,
    navigator: overrides.navigator || { languages: ['en'] }, performance: window.performance,
    localStorage: { getItem: () => saved && JSON.stringify(saved), setItem: noop },
    setTimeout: noop, clearTimeout: noop, setInterval: noop,
    requestAnimationFrame: window.requestAnimationFrame });
  const expose = `window.motion = { followRoll, stableRoll, stablePalm, palmFrame, palmRollAngle, rigidPalmFrame, skinBoundsCenter, twistAngle, armLenOk, waistContact,
    faceWristOffset, faceContactDepth, imageBasis, contactReading, cfg, armLenSeen,
    depthRatio, noteWristSpeed, sampleReach, sampleMotionLandmarks,
    motionRun: function (key) {
      calRun = { kind: 'motion', phase: 'hold', holdFrom: now() - 300,
        i: 0, steps: [{ key: key }], acc: stepAccum(), out: {}, tpose: false };
      return calRun;
    },
    motionSpeed: function () { return speedNow; },
    resetSpeed: function () { speedNow = 0; },
    startMic, stopMic, micLevel, mic, driveVisemes, changeMicDevice, refreshMicDevices,
    sampleCalibration, captureStep, advanceCalibration, steps, snapshotSettings,
    micDevices: function () { return micDevices; },
    setOccluded: function (value) { faceOcc = value; },
    modelCount: function () { return models.length; }, expected: EXPECTED_HOOKS,
    frame: function (world, image, hand) {
      poseLm = world; poseImg = image; poseHand = hand; poseSeq++; imgSeq++; poseLmAt = now();
    }, image: function (image) { poseImg = image; imgSeq++; },
    getPose: function () { return poseLm; },
    setRun: function () { calRun = { kind: 'face', phase: 'wait' }; },
    getRun: function () { return calRun; }
  };`;
  // The boot lines are stripped so the stub never runs the stylesheet
  // injectors or the language attribute pass - the document here has neither
  // an element factory nor a real documentElement. Matched loosely over line
  // endings: checkouts on both sides of core.autocrlf have to strip cleanly.
  vm.runInContext(source
    .replace(/  injectAppCss\(\);\r?\n  applyDocLang\(\);/, '')
    .replace(/\}\)\(\);\s*$/, `${expose}\n})();`), context);
  return { ...window.motion, psx: window.PSX };
}

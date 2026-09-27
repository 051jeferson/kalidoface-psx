import assert from 'node:assert/strict';
import { runtime } from './test-support.mjs';

// Exercise the shipped classic script, without loading the UI or a webcam.
const r = runtime();
const rad = d => d * Math.PI / 180;
const p = (x, y, z = 0) => ({ x, y, z, visibility: 1 });
const idx = { shoulder: 11, elbow: 13, wrist: 15, hip: 23 };

// A rigid mitten: broad palm, thin cross-section, and a proximal thumb bulge.
// No finger bones, hardcoded world axes or side-specific palm signs are needed.
const mitten = [];
for (const x of [0, 0.5, 1]) for (const y of [-0.2, 0.2]) for (const z of [-0.04, 0.04]) mitten.push(p(x, y, z));
for (const x of [0.15, 0.25]) for (const y of [0.35, 0.45]) for (const z of [-0.04, 0.04]) mitten.push(p(x, y, z));
for (const scale of [0.01, 1, 10]) for (const mirror of [-1, 1]) {
  const shape = r.rigidPalmFrame(mitten.map(v => p(-v.z * scale, v.x * scale, -v.y * scale * mirror)));
  assert.ok(shape, 'rigid hands can recover a frame from their bound mesh');
  assert.ok(shape.fwd.y > 0.999, 'the long distal section locates the fingers');
  assert.ok(shape.across.z * mirror < -0.999, 'thumb geometry settles the transverse sign on both hands');
}
assert.equal(r.rigidPalmFrame([]), null);
assert.equal(r.rigidPalmFrame(mitten.slice(0, 12)), null, 'a symmetric block cannot establish a thumb side');
// Repositioning a head joint changes its local skin coordinates, not the
// skull's physical centre. Material duplicates must not bias the reference.
const skull = [];
for (const x of [-0.08, 0.08]) for (const y of [-0.05, 0.21]) for (const z of [-0.13, 0.13]) skull.push(p(x, y, z));
const skullCentre = r.skinBoundsCenter(skull);
assert.ok(Math.abs(skullCentre.y - 0.08) < 1e-10, 'a head joint at the neck is not the skull centre');
const shiftedSkull = skull.map(v => p(v.x - 0.2, v.y + 0.3, v.z - 0.4));
const shiftedCentre = r.skinBoundsCenter(shiftedSkull.concat(shiftedSkull.slice(0, 3)));
assert.ok(Math.abs(shiftedCentre.x + 0.2 - skullCentre.x) < 1e-10);
assert.ok(Math.abs(shiftedCentre.y - 0.3 - skullCentre.y) < 1e-10);
assert.ok(Math.abs(shiftedCentre.z + 0.4 - skullCentre.z) < 1e-10);
assert.equal(r.skinBoundsCenter([]), null);
assert.equal(r.skinBoundsCenter(skull.map(v => p(v.x, v.y, 0))), null, 'flat accessories cannot provide a skull volume');
function pose() {
  const a = Array.from({ length: 33 }, () => p(0.5, 0.5));
  a[11] = p(0.3, 0.3); a[12] = p(0.7, 0.3);
  a[23] = p(0.35, 0.8); a[24] = p(0.65, 0.8);
  a[7] = p(0.45, 0.15); a[8] = p(0.55, 0.15);
  a[0] = p(0.5, 0.15, -0.05);
  a[15] = p(0.35, 0.71);
  return a;
}

assert.ok(Math.abs(r.followRoll(rad(179), rad(-179), 0.5) - Math.PI) < 1e-10,
  'the palm must cross the seam by 2 degrees, not unwind by 358');
assert.ok(Math.abs(r.followRoll(rad(-179), rad(179), 0.5) + Math.PI) < 1e-10);
assert.equal(r.followRoll(undefined, 1, 0.5), 1);

// A pair must be assigned as a pair, even when both detections are nearer
// one wrist. Detector labels win ties; a clear reversal swaps both together.
const handImage = pose();
handImage[15] = p(0.3, 0.5); handImage[16] = p(0.7, 0.5);
const rightHand = [p(0.45, 0.5)], leftHand = [p(0.49, 0.5)];
let assigned = r.psx.hands({ Right: rightHand, Left: leftHand }, handImage);
assert.equal(assigned.Right, rightHand);
assert.equal(assigned.Left, leftHand, 'two visible hands must not lose one to iteration order');
rightHand[0] = p(0.7, 0.5); leftHand[0] = p(0.3, 0.5);
assigned = r.psx.hands({ Right: rightHand, Left: leftHand }, handImage);
assert.equal(assigned.Right, leftHand);
assert.equal(assigned.Left, rightHand);
assert.equal(r.psx.hands(assigned, handImage).Right, leftHand, 'reapplying association is idempotent');
rightHand[0] = leftHand[0] = p(0.5, 0.5);
assert.equal(r.psx.hands({ Right: rightHand, Left: leftHand }, handImage).Right, rightHand);
rightHand[0] = p(0.7, 0.5);
assert.equal(r.psx.hands({ Right: rightHand, Left: null }, handImage).Left, rightHand);

let motionTime = 1000;
const moving = runtime(null, { window: { performance: { now: () => motionTime } } });
const wrists = pose();
wrists[15] = p(0.3, 0.5); wrists[16] = p(0.7, 0.5);
moving.noteWristSpeed(wrists);
motionTime += 100;
wrists[15].x -= 0.1; wrists[16].x += 0.1;
moving.noteWristSpeed(wrists);
assert.ok(moving.motionSpeed() > 0.99, 'opposite wrist motion cannot cancel its speed');
moving.resetSpeed();
motionTime += 100;
wrists[16].visibility = 0; wrists[15].x -= 0.1;
moving.noteWristSpeed(wrists);
assert.ok(moving.motionSpeed() > 0.99, 'one missing hand cannot hide motion of the other');
moving.resetSpeed();
motionTime += 100;
wrists[16] = p(4, 0.5);
moving.noteWristSpeed(wrists);
assert.equal(moving.motionSpeed(), 0, 'reacquisition does not measure speed across a dropout');

const depthWorld = pose();
depthWorld[13] = p(0.3, 0.3, -0.2); depthWorld[15] = p(0.3, 0.3, -0.4);
depthWorld[14] = p(0.95, 0.3); depthWorld[16] = p(1.2, 0.3);
assert.ok(Math.abs(r.depthRatio(depthWorld, 0.5) - 1.25) < 1e-10,
  'a straight arm at the lens measures depth compression');
depthWorld[13] = p(0.5, 0.3, -0.2);
assert.equal(r.depthRatio(depthWorld, 0.5), 0, 'a bent arm cannot calibrate depth');
depthWorld[13] = depthWorld[11];
assert.equal(r.depthRatio(depthWorld, 0.5), 0, 'collapsed arm segments cannot calibrate depth');

let calTime = 1000, matrixReads = 0;
const calibration = runtime(null, { window: { performance: { now: () => calTime } } });
function calBone(x, y) {
  const elements = Array(16).fill(0);
  elements[12] = x; elements[13] = y;
  return { matrixWorld: { elements }, updateWorldMatrix() { matrixReads++; } };
}
const calBones = {
  head: calBone(0.5, 0.1), rightUpperArm: calBone(0.3, 0.3),
  rightLowerArm: calBone(0.05, 0.3), rightHand: calBone(-0.2, 0.3),
  leftUpperArm: calBone(0.7, 0.3), leftLowerArm: calBone(0.95, 0.3), leftHand: calBone(1.2, 0.3)
};
const calModel = {
  humanoid: { getBoneNode: name => calBones[name] },
  __psxArm: { ok: true, ru: calBones.rightUpperArm, lu: calBones.leftUpperArm }
};
const tWorld = pose();
tWorld[13] = p(0.05, 0.3); tWorld[15] = p(-0.2, 0.3);
tWorld[14] = p(0.95, 0.3); tWorld[16] = p(1.2, 0.3);
const tRun = calibration.motionRun('tpose');
calibration.frame(tWorld, tWorld, null);
calibration.sampleMotionLandmarks(tWorld);
calibration.sampleReach(calModel);
assert.equal(tRun.acc.span.length, 1);
const onceReads = matrixReads;
for (let i = 0; i < 144; i++) calibration.sampleReach(calModel);
assert.equal(tRun.acc.span.length, 1, 'renders cannot manufacture calibration observations');
assert.equal(matrixReads, onceReads, 'repeated renders skip calibration skeleton traversal');
tWorld[13] = p(0.3, 0.55); tWorld[15] = p(0.3, 0.8);
calTime += 100;
calibration.frame(tWorld, tWorld, null);
calibration.sampleMotionLandmarks(tWorld);
calibration.sampleReach(calModel);
assert.equal(tRun.acc.span.length, 1, 'a previous T-pose cannot authorize lowered arms');

const handsRun = calibration.motionRun('hands');
for (let sample = 0; sample < 8; sample++) {
  calTime += 100;
  calibration.frame(tWorld, tWorld, null);
  for (let render = 0; render < 14; render++) calibration.sampleReach(calModel);
}
assert.equal(handsRun.acc.reach.length, 8, '10 Hz tracking contributes 10 Hz observations at faster render rates');
calTime += 100;
tWorld[15].visibility = 0;
calibration.frame(tWorld, tWorld, null);
calibration.sampleReach(calModel);
assert.equal(handsRun.acc.reach.length, 8, 'a held model with an unseen wrist cannot calibrate reach');
tWorld[15].visibility = 1;
calibration.frame(tWorld, tWorld, null);
calTime += 600;
calibration.sampleReach(calModel);
assert.equal(handsRun.acc.reach.length, 8, 'stale landmarks cannot calibrate a held model');

// Moving the forearm changes the bind-relative zero, not a stationary palm.
// Old scalar smoothing would apply 9 degrees of this 90-degree compensation.
assert.ok(Math.abs(r.palmRollAngle(p(1, 0), p(0, 1), p(0, 0, 1), p(0, 1), 0.1) - Math.PI / 2) < 1e-10);
const palmReading = { seq: -1, frame: null, pending: null, count: 0, at: 0, speed: 0 };
const frontPalm = r.palmFrame(p(0, 1), p(1, 0));
const backPalm = r.palmFrame(p(0, 1), p(-1, 0));
assert.equal(r.stablePalm(palmReading, frontPalm, 0, 1000), frontPalm);
for (let i = 0; i < 144; i++) assert.equal(r.stablePalm(palmReading, backPalm, 1, 1050), null);
assert.equal(palmReading.count, 1, 'only new images can confirm a palm/dorsum flip');
assert.equal(r.stablePalm(palmReading, backPalm, 2, 1100), null);
assert.equal(r.stablePalm(palmReading, backPalm, 3, 1150), backPalm);
assert.ok(palmReading.speed > 0, 'turning the palm has speed even without wrist translation');
assert.equal(r.stablePalm(palmReading, null, 4, 1200), null);
assert.equal(r.stablePalm(palmReading, frontPalm, 5, 1250), null);
assert.equal(r.stablePalm(palmReading, null, 6, 1300), null);
assert.equal(r.stablePalm(palmReading, frontPalm, 7, 1350), null);
assert.equal(palmReading.count, 1, 'dropouts break palm confirmation');
assert.equal(r.palmFrame(p(0, 1), p(0, 1)), null, 'collapsed knuckles cannot report palm facing');
const turning = { seq: -1, frame: null, pending: null, count: 0, at: 0, speed: 0 };
for (let angle = 0; angle <= 540; angle += 15) {
  const frame = r.palmFrame(p(0, 1), p(Math.cos(rad(angle)), 0, Math.sin(rad(angle))));
  assert.equal(r.stablePalm(turning, frame, angle, 1000 + angle * 4), frame,
    'a continuous palm-to-dorsum turn crosses both angular seams without rejection');
}

// Tiny opposite perturbations near the forearm axis used to request opposite
// palms. A well-conditioned quarter turn must still be measurable.
assert.equal(r.twistAngle(p(1, 0), p(0.001, 0, 1), p(0, 0, 1)), null);
assert.equal(r.twistAngle(p(1, 0), p(-0.001, 0, 1), p(0, 0, 1)), null);
assert.equal(r.twistAngle(p(0.001, 0, 1), p(1, 0), p(0, 0, 1)), null);
assert.ok(Math.abs(r.twistAngle(p(1, 0), p(0, 1), p(0, 0, 1)) - Math.PI / 2) < 1e-10);
const reading = { seq: -1, angle: null, pending: null, count: 0 };
assert.equal(r.stableRoll(reading, 0, 0), 0);
for (let i = 0; i < 144; i++) assert.equal(r.stableRoll(reading, rad(170), 1), null);
assert.equal(reading.count, 1, 'render retries cannot confirm a detector flip');
assert.equal(r.stableRoll(reading, rad(5), 2), rad(5), 'one bad sample does not disturb a held palm');
assert.equal(r.stableRoll(reading, rad(170), 3), null);
assert.equal(r.stableRoll(reading, rad(175), 4), null);
assert.equal(r.stableRoll(reading, rad(178), 5), rad(178), 'a consistent new pose recovers');
assert.equal(r.stableRoll(reading, rad(-179), 6), rad(-179), 'the angular seam is not a flip');
assert.equal(r.stableRoll(reading, null, 7), null);
assert.equal(r.stableRoll(reading, 0, 8), null);
assert.equal(r.stableRoll(reading, null, 9), null);
assert.equal(r.stableRoll(reading, 0, 10), null);
assert.equal(reading.count, 1, 'missing readings break confirmation');
const continuous = { seq: -1, angle: null, pending: null, count: 0 };
for (let d = -180; d <= 540; d += 10) {
  const angle = Math.atan2(Math.sin(rad(d)), Math.cos(rad(d)));
  assert.equal(r.stableRoll(continuous, angle, d), angle,
    'continuous rotation across multiple seams must not be delayed');
}

for (let sample = 0; sample < 30; sample++) {
  r.frame(null, null, null);
  for (let render = 0; render < 7; render++) assert.equal(r.armLenOk('Right', 1), true);
}
assert.equal(r.armLenSeen.Right.n, 30, 'warmup counts inferences, not rendered frames');
r.frame(null, null, null);
for (let render = 0; render < 144; render++) assert.equal(r.armLenOk('Right', 2), false);
assert.equal(r.armLenSeen.Right.bad, 1, 'one rejected inference cannot exhaust all retries');
for (let sample = 0; sample < 20; sample++) { r.frame(null, null, null); r.armLenOk('Right', 2); }
assert.equal(r.armLenOk('Right', 2), true, 'a real change can still recover');
r.frame(null, null, null);
assert.equal(r.armLenOk('Right', 0.4), true, 'foreshortened arms remain usable');

let world = pose(), image = pose();
assert.equal(r.waistContact(world, image, idx), 1);
image[15] = p(0.1, 0.3);
assert.equal(r.waistContact(world, image, idx), 0, 'a raised/free arm is not waist contact');
image = pose(); world[15].z = -1;
assert.equal(r.waistContact(world, image, idx), 0, 'pointing at the lens is not waist contact');
world = pose(); image[23].y = 1.2;
assert.equal(r.waistContact(world, image, idx), 0, 'offscreen hips cannot anchor a hand');

image = pose();
r.frame(world, image, { Right: [p(0.49, 0.2)] });
const offset = r.faceWristOffset('Right', world, p(-0.15, 0.56, -0.2));
assert.ok(Math.abs(offset.x + 0.01) < 1e-10);
assert.ok(Math.abs(offset.y - 0.05) < 1e-10, 'the detected hand, not the pose wrist on the chest, locates the gesture');
assert.equal(offset.z, -0.2, 'hand-local depth must not replace pose-world depth');
// A hand resting on the face must not follow a body detector wrist drifting
// toward the lens. The overlapping fingertip supplies relative hand depth;
// changing that detector's arbitrary z origin must not move the contact.
world = pose(); image = pose(); world[15].z = -0.39;
const contactHand = Array.from({ length: 21 }, () => p(0.5, 0.4, 7));
contactHand[0] = p(0.5, 0.28, 7);
contactHand[8] = p(0.5, 0.15, 6.97);
r.frame(world, image, { Right: contactHand });
assert.ok(Math.abs(r.faceContactDepth('Right', world) + 0.02) < 1e-10);
assert.ok(Math.abs(r.contactReading('Right', world, idx).wrist.z + 0.02) < 1e-10,
  'contact reaches the face plane instead of preserving a 39 cm wrist error');
const shiftedHand = contactHand.map(v => p(v.x, v.y, v.z + 23));
r.frame(world, image, { Right: shiftedHand });
assert.ok(Math.abs(r.faceContactDepth('Right', world) + 0.02) < 1e-10,
  'body and hand depth origins are never equated');
r.cfg.headAnchor = 0;
r.frame(world, image, { Right: contactHand });
assert.equal(r.contactReading('Right', world, idx).wrist.z, world[15].z,
  'disabling head anchoring disables contact depth');
r.cfg.headAnchor = 1;
const boundaryDepths = [];
for (const x of [0.564, 0.565, 0.566]) {
  const boundaryHand = contactHand.map(v => p(v.x, v.y, v.z));
  boundaryHand[8].x = x;
  r.frame(world, image, { Right: boundaryHand });
  boundaryDepths.push(r.contactReading('Right', world, idx).wrist.z);
}
assert.ok(Math.abs(boundaryDepths[0] - boundaryDepths[1]) < 0.03,
  'a fingertip leaving the face fades contact depth rather than snapping back');
assert.equal(boundaryDepths[2], world[15].z);
r.frame(world, image, { Right: contactHand.map(v => p(v.x + 0.4, v.y, v.z)) });
assert.equal(r.faceContactDepth('Right', world), null, 'an unobscured face cannot anchor a distant hand');
r.frame(world, image, { Right: null });
assert.equal(r.faceContactDepth('Right', world), null, 'pose overlap without detected hand depth is insufficient');
// A palm beside the temple does not cover the face, but its directly detected
// wrist still locates the gesture better than the pose wrist on the chest.
image = pose(); world = pose();
for (const i of [15, 17, 19]) image[i] = p(0.3, 0.7);
world[15] = p(0.3, 0.7, -0.2);
r.frame(world, image, { Right: [p(0.6, 0.15)] });
const temple = r.contactReading('Right', world, idx);
assert.ok(temple.wrist && temple.wrist.y < world[15].y,
  'visible temple gestures recover without requiring face occlusion');
assert.equal(temple.wrist.z, world[15].z);
r.frame(world, image, { Right: null });
assert.equal(r.contactReading('Right', world, idx).wrist, null, 'missing hands cannot invent a recovery');
r.frame(world, image, { Right: [p(0.9, 0.7)] });
assert.equal(r.contactReading('Right', world, idx).wrist, null, 'free gestures keep the world wrist');
const basis = r.imageBasis();
const tilted = pose(); tilted[12].y = 0.4;
r.image(tilted);
assert.notEqual(r.imageBasis().x.y, basis.x.y, 'new images invalidate the basis even without new world landmarks');
assert.equal(r.psx.fingers().length, 5, 'new profiles can articulate the index finger');
assert.equal(runtime({ fingers: 'thumb' }).psx.fingers().length, 1, 'explicit saved finger settings survive');
console.log('Motion regressions passed: palm seam, degenerate palms, flip confirmation, inference gates, waist contact, face wrist, image cache, finger settings.');

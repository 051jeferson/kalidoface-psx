import assert from 'node:assert/strict';
import { runtime } from './test-support.mjs';

// The camera side of the mouth: the wizard records a prototype per atlas
// cell, a live frame classifies to the nearest one, and the winner is written
// through the model preset bound to that photo. The audio half of the wizard
// is covered by test-audio.mjs.

// 7 dims: mouth.x, mouth.y, then Kalidokit's A/I/U/E/O shape weights.
const rest = [0, 0.1, 0, 0, 0, 0, 0];
const cells = {
  rest,
  open: [0.5, 0.9, 1, 0.2, 0.1, 0.3, 0.2],
  round: [0.2, 0.6, 0.3, 0, 1, 0, 0.9],
  wide: [0.9, 0.4, 0.2, 1, 0, 0.8, 0]
};
// Older saves carry one prototype per vowel. The classifier is the same code;
// each vowel passes through to its own preset.
const vowels = {
  rest,
  a: cells.open,
  i: cells.wide,
  u: cells.round,
  e: [0.8, 0.7, 0.6, 0.8, 0, 1, 0.1],
  o: [0.3, 0.8, 0.4, 0.1, 0.6, 0.2, 1]
};

function rigFor(f) {
  return { mouth: { x: f[0], y: f[1], shape: { A: f[2], I: f[3], U: f[4], E: f[5], O: f[6] } } };
}

const values = {};
const vrm = { blendShapeProxy: { setValue: (k, v) => { values[k] = v; } } };
function positives() {
  return Object.keys(values).filter(k => values[k] > 0);
}

let r = runtime({ mouth: cells });

// A cells-format save survives the reload sanitiser...
assert.ok(r.cfg.mouth && r.cfg.mouth.open, 'a cells calibration survives reload');
// ...as does a five-vowel one, and an incomplete cells recording does not.
assert.ok(runtime({ mouth: vowels }).cfg.mouth, 'a five-vowel calibration survives reload');
assert.equal(runtime({ mouth: { rest, open: cells.open, round: cells.round } }).cfg.mouth, null,
  'a cells calibration missing the wide recording is unusable');

// A frame sitting on a recorded cell picks that cell and writes only the
// preset bound to its photo - the u/o and e/a photos are shared, so the
// classifier must not spend its margin between them.
const winners = { open: 'a', round: 'u', wide: 'i' };
for (const [cell, preset] of Object.entries(winners)) {
  for (let i = 0; i < 4; i++) r.driveVisemes(vrm, rigFor(cells[cell]));
  assert.ok(values[preset] > 0.4, `a frame on the recorded ${cell} mouth shows the ${preset} texture`);
  assert.deepEqual(positives(), [preset], `${cell} never blends textures`);
}
for (let i = 0; i < 4; i++) r.driveVisemes(vrm, rigFor(rest));
assert.deepEqual(positives(), [], 'a frame on the recorded rest pose closes the mouth');

// The sticky hysteresis is what keeps the cell from flickering between
// syllables: the held mouth keeps the lead unless the challenger is clearly
// closer. Distances compare squared, so with cfg.mouthStick at 0.25 the hold
// band ends at 52.8% of the way to the rival - sit the frame just inside it.
const mid = cells.open.map((v, d) => v + (cells.round[d] - v) * 0.52);
for (let i = 0; i < 4; i++) r.driveVisemes(vrm, rigFor(cells.open));
for (let i = 0; i < 4; i++) r.driveVisemes(vrm, rigFor(mid));
assert.ok(values.a > 0, 'the held mouth keeps the cell against a near miss');
for (let i = 0; i < 4; i++) r.driveVisemes(vrm, rigFor(cells.round));
assert.ok(values.u > 0, 'a clearly closer recording takes the cell');

// The readout is how "the mouth sits on one cell" becomes a number: counts
// per decision over a rolling window, plus what is showing right now.
const info = r.psx.mouthInfo();
assert.equal(info.cal, 'cells');
assert.ok(info.stats, 'the readout counts decisions');
assert.ok(info.stats.open > 0 && info.stats.round > 0, 'both winning cells were counted');
assert.ok(info.stats.rest > 0, 'the rest decisions were counted');
assert.ok(!info.stats.smile, 'nothing counted a smile that was never recorded');

// Five-vowel recordings classify as before and write their own preset - an
// 'e' frame still lands on the e group, which is the same photo as 'a' on the
// shipped avatar but is the recording's own decision to make.
r = runtime({ mouth: vowels });
for (let i = 0; i < 4; i++) r.driveVisemes(vrm, rigFor(vowels.e));
assert.ok(values.e > 0.4, 'a five-vowel calibration still writes the vowel it recorded');
assert.deepEqual(positives(), ['e'], 'vowel recordings never blend textures');
const legacy = r.psx.mouthInfo();
assert.equal(legacy.cal, 'vowels', 'the readout names the recording format it counted');

console.log('Mouth regressions passed: cells format, five-vowel fallback, preset mapping, stickiness, readout.');

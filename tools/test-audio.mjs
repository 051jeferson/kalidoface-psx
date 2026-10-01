import assert from 'node:assert/strict';
import { runtime } from './test-support.mjs';

let time = 0, amplitude = 0, bias = 0, requested = 0, reads = 0;
let created = 0, closed = 0, stopped = 0, disconnected = 0;
let spectralReads = 0, frequency = 750;
let resolvePermission, rejectPermission, ended, constraintsUsed;
let devices = [{ kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' },
  { kind: 'videoinput', deviceId: 'camera', label: 'Camera' }];
const buffers = new Set(), spectralBuffers = new Set(), events = {};
const track = { readyState: 'live', muted: false,
  stop() { stopped++; }, addEventListener(name, fn) { ended = fn; } };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
class AudioContext {
  constructor() { created++; this.state = 'running'; this.sampleRate = 48000; }
  resume() { return Promise.resolve(); }
  close() { closed++; this.state = 'closed'; return Promise.resolve(); }
  createAnalyser() { return { getFloatTimeDomainData(buffer) {
    reads++; buffers.add(buffer);
    for (let i = 0; i < buffer.length; i++) buffer[i] = bias + (i % 2 ? amplitude : -amplitude);
  }, getFloatFrequencyData(buffer) {
    spectralReads++; spectralBuffers.add(buffer); buffer.fill(-Infinity);
    buffer[Math.round(frequency / (48000 / this.fftSize))] = 20 * Math.log10(amplitude || 1e-20);
  } }; }
  createMediaStreamSource() { return {
    connect() {}, disconnect() { disconnected++; }
  }; }
}
const r = runtime(null, {
  window: { AudioContext, performance: { now: () => time },
    addEventListener: (name, fn) => { events[name] = fn; } },
  navigator: { mediaDevices: { getUserMedia(constraints) {
    constraintsUsed = constraints;
    requested++;
    assert.equal(constraints.video, false);
    assert.equal(constraints.audio.noiseSuppression, false);
    return new Promise((resolve, reject) => { resolvePermission = resolve; rejectPermission = reject; });
  }, enumerateDevices: () => Promise.resolve(devices),
  addEventListener: (name, fn) => { events[name] = fn; } } }
});
assert.equal(created, 0, 'startup creates no audio graph');
assert.equal(requested, 0, 'startup does not ask for microphone access');
for (let i = 0; i < 1000; i++) r.micLevel();
assert.equal(reads, 0, 'disabled mode performs no audio reads');

const cancelled = r.startMic();
r.stopMic();
resolvePermission(stream); await cancelled;
assert.equal(stopped, 1, 'a late permission grant releases its stream');
assert.equal(closed, 1);
assert.equal(r.psx.mic().state, 'off');

const denied = r.startMic();
rejectPermission({ name: 'NotAllowedError' }); await denied;
assert.equal(r.psx.mic().state, 'denied');
assert.equal(closed, 2, 'permission denial releases the audio context');

const enabled = r.startMic();
resolvePermission(stream); await enabled;
assert.equal(r.psx.mic().state, 'active');
amplitude = 0.1;
for (time = 0; time < 1000; time++) r.micLevel();
assert.equal(reads, 20, '1000 render calls perform only 20 audio reads per second');
assert.equal(buffers.size, 1, 'the sample buffer is reused');
assert.equal([...buffers][0].length, 512);
assert.ok(r.micLevel() > 0.9);
track.muted = true;
assert.equal(r.micLevel(), 0, 'a muted device cannot retain an open mouth');
track.muted = false;
amplitude = 0; bias = 0.2; time += 50;
assert.equal(r.micLevel(), 0, 'DC offset is not speech');
bias = 0;

const values = {};
const vrm = { blendShapeProxy: { setValue: (k, v) => { values[k] = v; } } };
const rig = { mouth: { x: 0, y: 0, shape: {} } };
amplitude = 0.1; time += 50;
r.driveVisemes(vrm, rig);
assert.equal(values.a, 0, 'sound must not overwrite a visible resting mouth');
r.cfg.micMode = 'speech'; time += 50;
r.driveVisemes(vrm, rig);
assert.ok(values.a > 0.5, 'speech mode talks even when the camera mouth is closed');
const openRig = { mouth: { x: 0.8, y: 0.8, shape: { I: 1 } } };
amplitude = 0;
for (let i = 0; i < 8; i++) { time += 50; r.driveVisemes(vrm, openRig); }
assert.equal(Object.values(values).filter(v => v > 0).length, 0,
  'silence closes speech vowels even when the camera mouth is open');
amplitude = 0.1;
r.cfg.micMode = 'assist';
r.setOccluded(true); time += 50;
r.driveVisemes(vrm, rig);
assert.ok(values.a > 0.5, 'audio animates an occluded mouth');
assert.equal(Object.values(values).filter(v => v > 0).length, 1, 'audio selects one vowel only');
amplitude = 0;
for (let i = 0; i < 8; i++) { time += 50; r.driveVisemes(vrm, rig); }
assert.equal(values.a, 0, 'silence closes the occlusion fallback');
amplitude = 0.1; r.setRun(); time += 50;
const beforeCalibration = reads;
r.driveVisemes(vrm, rig);
assert.equal(reads, beforeCalibration, 'calibration bypasses audio');
ended();
assert.equal(r.psx.mic().state, 'unavailable');
assert.equal(disconnected, 1);
assert.equal(r.mic.buffer, null);

await r.refreshMicDevices();
assert.equal(r.micDevices().length, 1, 'only audio inputs are selectable');
devices = [];
await events.devicechange();
assert.equal(r.micDevices().length, 0, 'device changes refresh the list');
r.cfg.micDevice = 'usb';
const usb = r.startMic(); resolvePermission(stream); await usb;
assert.equal(constraintsUsed.audio.deviceId.exact, 'usb', 'capture requires the selected device');
const oldEnded = ended, beforeSwitch = stopped;
r.cfg.micDevice = 'headset';
const switched = r.changeMicDevice();
assert.equal(stopped, beforeSwitch + 1, 'switching releases the previous stream');
assert.equal(constraintsUsed.audio.deviceId.exact, 'headset');
oldEnded();
assert.equal(r.psx.mic().state, 'requesting', 'old track events cannot cancel the replacement');
rejectPermission({ name: 'NotFoundError' }); await switched;
assert.equal(r.psx.mic().state, 'unavailable', 'missing selection does not use another microphone');
r.cfg.micDevice = '';

const again = r.startMic(); resolvePermission(stream); await again;
assert.equal(constraintsUsed.audio.deviceId, undefined, 'system default leaves device selection to the browser');
assert.equal(spectralReads, 0, 'uncalibrated speech and assist do not compute spectra');
r.cfg.calCues = false;
r.psx.importSettings({ lang: 'en' }); // Cancels the earlier face wizard.
r.setOccluded(false);
r.cfg.calCues = false;
const tones = { a: 750, e: 1350, i: 2650, o: 525, u: 375, open: 750, round: 375, wide: 2650 };
function recordMouth({ missing = '', changeDevice = false } = {}) {
  r.psx.calibrateMouth();
  const total = r.steps().length;
  for (let step = 0; step < total; step++) {
    const key = r.steps()[r.getRun().i].key;
    r.captureStep();
    amplitude = key === 'rest' || key === 'smile' || key === missing ? 0.001 : 0.08;
    frequency = tones[key] || 750;
    time += 300;
    for (let i = 0; i < 16; i++) {
      r.sampleCalibration(0, 0, rig);
      if (key === 'open' && i === 0) {
        const samples = r.getRun().acc.audio.length;
        for (let repeat = 0; repeat < 100; repeat++) r.sampleCalibration(0, 0, rig);
        assert.equal(r.getRun().acc.audio.length, samples, 'render retries cannot duplicate audio recordings');
      }
      time += 50;
    }
    if (changeDevice && step === 3) r.mic.epoch++;
    r.advanceCalibration();
  }
  assert.equal(r.getRun(), null, 'mouth calibration finishes');
}
recordMouth();
assert.ok(r.cfg.micMouth, 'the mouth wizard records the three mouth sounds');
assert.ok(r.cfg.micMouth.noise > 0, 'silence establishes the background noise');
assert.equal(spectralBuffers.size, 1, 'spectral analysis reuses one buffer');
const recording = r.cfg.micMouth;
const reloaded = runtime({ micMouth: recording, micMode: 'speech', micDevice: 'private-id' });
assert.ok(reloaded.cfg.micMouth, 'audio recordings survive reload');
assert.equal(reloaded.cfg.micMode, 'assist', 'capture mode stays session-only');
assert.equal(reloaded.cfg.micDevice, '', 'device identity stays session-only');
assert.ok(r.snapshotSettings().settings.micMouth, 'export includes audio prototypes');
assert.equal(r.snapshotSettings().settings.micDevice, undefined);
const broken = JSON.parse(JSON.stringify(recording)); broken.i[0] = NaN;
assert.ok(r.psx.importSettings({ lang: 'en', micMouth: broken }).includes('unusable'));
assert.equal(r.cfg.micMouth, recording, 'invalid imported audio preserves the existing calibration');
recordMouth({ missing: 'wide' });
assert.equal(r.cfg.micMouth, recording, 'a silent mouth cannot overwrite a working recording');
recordMouth({ changeDevice: true });
assert.equal(r.cfg.micMouth, recording, 'a device change invalidates the entire audio recording');
r.cfg.micMode = 'speech';
amplitude = 0.08;
for (const key of ['a', 'i', 'u']) {
  frequency = tones[key];
  for (let i = 0; i < 3; i++) { time += 50; r.driveVisemes(vrm, rig); }
  assert.ok(values[key] > 0.5, `recorded ${key.toUpperCase()} selects its own mouth texture`);
  assert.equal(Object.values(values).filter(v => v > 0).length, 1, 'audio vowels never blend textures');
}
frequency = tones.i; time += 50; r.driveVisemes(vrm, rig);
assert.equal(r.mic.vowel, 'u', 'one new sample cannot flicker to a different vowel');
for (let i = 0; i < 100; i++) r.driveVisemes(vrm, rig);
assert.equal(r.mic.vowel, 'u', 'render retries cannot confirm a new vowel');
time += 50; r.driveVisemes(vrm, rig);
assert.equal(r.mic.vowel, 'i');
amplitude = 0;
for (let i = 0; i < 10; i++) { time += 50; r.driveVisemes(vrm, openRig); }
assert.equal(Object.values(values).filter(v => v > 0).length, 0, 'calibrated speech closes during silence');
const quietReads = spectralReads;
for (let i = 0; i < 10; i++) { time += 50; r.driveVisemes(vrm, rig); }
assert.equal(spectralReads, quietReads, 'silence skips frequency analysis');
r.cfg.micMode = 'assist'; amplitude = 0.08;
for (let i = 0; i < 10; i++) { time += 50; r.driveVisemes(vrm, rig); }
assert.equal(spectralReads, quietReads, 'assist skips frequency analysis even with a recording');
events.pagehide();
assert.equal(r.psx.mic().state, 'off', 'leaving the page releases capture');
assert.equal(created, closed, 'every acquired audio context is closed');
console.log('Audio regressions passed: lifecycle, 20 Hz cap, fixed buffers, calibrated mouth sounds, silence, hysteresis, recording failures and persistence.');

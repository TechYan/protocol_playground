// Run with: node tests/pcie-ltssm.mjs
// Exercises the exact pure model consumed by the offline page; no DOM doubles.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const page = new URL('../site/pcie/ltssm/index.html', import.meta.url);
assert.ok(existsSync(page), 'Standalone PCIe HTML has not been implemented');
const html = readFileSync(page, 'utf8');
const source = html.match(/<script id="pcie-model">([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, 'The page must contain its executable pure timeline model');
const model = vm.runInNewContext(`${source}\nPcie;`, {}, { timeout: 2000 });
let checks = 0;
function check(name, run) {
  run();
  checks += 1;
  console.log(`PASS ${name}`);
}
function at(scene, tag, offset = 0) {
  const index = model.scenarios[scene].steps.findIndex(step => step.tag === tag);
  assert.ok(index >= 0, `${scene} is missing event ${tag}`);
  return model.sample(scene, model.boundary(scene, index) + offset);
}

check('A 64 GT/s request does not complete the PHY rate change', () => {
  const request = at('gen6', 'request-g6');
  assert.equal(request.signals.rate, 5);
  assert.equal(request.linkSpeed, 32);
  assert.equal(request.signals.txIdle, 1);
  assert.equal(request.signals.phyStatus, 0);
  const done = at('gen6', 'complete-g6');
  assert.equal(done.linkSpeed, 64);
  assert.equal(done.signals.phyStatus, 1);
  assert.equal(at('gen6', 'complete-g6', 1).signals.phyStatus, 0);
});

check('32 GT/s preset preparation precedes the separate 64 GT/s EQ startup', () => {
  const prepare = at('gen6', 'preset-g6');
  assert.equal(prepare.linkSpeed, 32);
  assert.equal(prepare.step.down, 'EQ TS2');
  const startup = at('gen6', 'g6-p0');
  assert.equal(startup.linkSpeed, 64);
  assert.equal(startup.step.down, 'TS0');
  assert.equal(startup.step.up, 'TS0');
  assert.equal(startup.encoding, '1b/1b');
});

check('P2 changes the downstream transmitter before P3 changes the upstream transmitter', () => {
  assert.equal(at('gen6', 'g6-p2-start').step.down, 'TS0');
  const downstream = at('gen6', 'g6-p2-ts1');
  assert.equal(downstream.step.down, 'TS1');
  assert.equal(downstream.step.up, 'TS0');
  assert.equal(at('gen6', 'g6-p3-start').step.up, 'TS0');
  const upstream = at('gen6', 'g6-p3-ts1');
  assert.equal(upstream.step.down, 'TS1');
  assert.equal(upstream.step.up, 'TS1');
});

check('The complete training path reaches Gen6 with Flit Mode negotiated', () => {
  const scene = model.scenarios.cold;
  const speeds = new Set();
  scene.steps.forEach((step, index) => {
    const frame = model.sample('cold', model.boundary('cold', index));
    speeds.add(frame.linkSpeed);
    if (frame.linkSpeed === 64) assert.equal(frame.step.flit, true);
  });
  assert.deepEqual([...speeds], [2.5, 5, 8, 16, 32, 64]);
  const final = model.sample('cold', model.total('cold'));
  assert.equal(final.step.state, 'l0');
  assert.equal(final.step.down, 'FLIT');
  assert.equal(final.step.flit, true);
});

check('Recovery returns to an explicitly lower active link speed', () => {
  const end = model.sample('recovery', model.total('recovery'));
  assert.equal(end.step.state, 'l0');
  assert.equal(end.linkSpeed, 32);
  assert.equal(end.signals.rate, 4);
  assert.equal(end.signals.txIdle, 0);
});

check('L0s is presented only in a non-Flit link below 64 GT/s', () => {
  for (const scene of Object.values(model.scenarios)) {
    scene.steps.filter(step => step.state === 'l0s').forEach(step => {
      assert.equal(step.flit, false, 'Flit Mode does not support L0s');
      assert.ok(step.generation < 6, '64 GT/s requires Flit Mode');
    });
  }
  const wake = at('power', 'l1-l0');
  assert.equal(wake.linkSpeed, 32);
  assert.equal(wake.step.down, 'DATA');
});

check('Timeline navigation clamps at both ends and handles non-finite input', () => {
  for (const id of Object.keys(model.scenarios)) {
    assert.equal(model.sample(id, -100).index, 0);
    assert.equal(model.sample(id, NaN).index, 0);
    assert.equal(model.sample(id, Infinity).index, 0);
    assert.equal(model.move(id, 0, -1), 0);
    const end = model.total(id);
    assert.equal(model.sample(id, end + 100).index, model.scenarios[id].steps.length - 1);
    assert.equal(model.move(id, end, 1), end);
    const next = model.move(id, 0, 1);
    assert.ok(next > 0 && next < end);
    assert.equal(model.move(id, next, -1), 0);
  }
});

check('Every scene has valid state references and legal selected PIPE values', () => {
  for (const [id, scene] of Object.entries(model.scenarios)) {
    assert.ok(scene.steps.length > 1);
    scene.steps.forEach((step, index) => {
      assert.ok(model.states[step.state], `${id}: unknown state ${step.state}`);
      assert.ok(step.ticks > 0);
      const frame = model.sample(id, model.boundary(id, index));
      assert.ok(frame.signals.rate >= 0 && frame.signals.rate <= 5);
      assert.ok(frame.signals.powerDown >= 0 && frame.signals.powerDown <= 3);
      assert.ok(frame.signals.rxStatus >= 0 && frame.signals.rxStatus <= 7);
    });
  }
});

console.log(`${checks}/${checks} checks passed; deterministic teaching model only.`);

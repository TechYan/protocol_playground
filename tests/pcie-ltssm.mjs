// Exercise the same offline models and timing windows that the browser renders.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../site/pcie/ltssm/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script id="([^"]+)">([\s\S]*?)<\/script>/g)];
const context = vm.createContext({});
for (const [, id, source] of scripts) {
  const compiled = new vm.Script(source, { filename: id });
  if (id !== 'viewer') compiled.runInContext(context, { timeout: 2000 });
}
const { Pcie: m, Serial: serial } = vm.runInContext('({Pcie, Serial})', context);
const dirs = ['down', 'up'];
let checks = 0;
function check(name, fn) {
  fn();
  console.log('PASS', name);
  checks++;
}
function at(id, tag, offset = 0, dir = 'down') {
  const step = m.scenarios[id].steps.find((s) => s.tag === tag);
  assert.ok(step, id + '/' + tag);
  return m.sample(id, step.start + offset, dir);
}
function sig(id, tag, dir = 'down', offset = 0) {
  return at(id, tag, offset, dir).signals;
}
function byTag(tag, dir) {
  return serial.profile(at('gen6', tag).step, dir);
}
function compressedStates(scene) {
  return scene.steps
    .map((s) => s.state)
    .filter((state, i, states) => state !== states[i - 1])
    .join(' ');
}
check('Standalone entry compiles; it uses no runtime CDN, module or stylesheet fetch', () => {
  assert.deepEqual(
    scripts.map((s) => s[1]),
    ['pcie-model', 'serial-model', 'viewer']
  );
  assert.doesNotMatch(
    html,
    /<script[^>]+\bsrc=|<link[^>]+rel="stylesheet"|<img[^>]+src="https?:|\bfetch\(|\bimport\s*\(/i
  );
});
check('Every scene resolves all states and tokens once on a contiguous timeline', () => {
  assert.equal(Object.keys(m.scenarios).length, 8);
  for (const [id, scene] of Object.entries(m.scenarios)) {
    let next = 0;
    const seen = new Set();
    for (const [i, step] of scene.steps.entries()) {
      assert.ok(!seen.has(step.tag));
      seen.add(step.tag);
      assert.equal(step.start, next);
      assert.ok(step.ticks > 0);
      next += step.ticks;
      for (const dir of dirs) {
        assert.ok(m.states[m.portState(step, dir)]);
        assert.ok(m.wire[step[dir]]);
        assert.equal(m.sample(id, step.start, dir).index, i);
      }
    }
    assert.equal(next, scene.total);
  }
});
check('Successful Gen6 EQ follows the principal Recovery states in both directions', () => {
  assert.equal(
    compressedStates(m.scenarios.gen6),
    'l0 r.lock r.config r.speed r.lock r.eq0 r.eq1 r.eq2 r.eq3 r.lock r.config r.idle l0'
  );
  assert.equal(at('gen6', 'preset-g6').linkSpeed, 32);
  assert.equal(at('gen6', 'preset-g6').step.down, 'EQ TS2');
  assert.equal(at('gen6', 'g6-p0').encoding, '1b/1b');
  assert.equal(m.portState(at('gen6', 'g6-p0').step, 'down'), 'r.eq1');
  assert.equal(m.portState(at('gen6', 'g6-p0').step, 'up'), 'r.eq0');
});
check('Cold training, directed fallback and sampled service fragments use their own paths', () => {
  const cold = m.scenarios.cold;
  assert.equal(
    compressedStates(cold).split(' l0 ')[0],
    'reset detect.quiet detect.active polling.active polling.config config.width.start config.width.accept config.lane.wait config.lane.accept config.complete config.idle'
  );
  assert.deepEqual([...new Set(cold.steps.map((s) => m.speeds[s.generation]))], [2.5, 5, 8, 16, 32, 64]);
  assert.equal(compressedStates(m.scenarios.recovery), 'l0 r.lock r.config r.speed r.lock r.config r.idle l0');
  assert.equal(m.sample('recovery', m.total('recovery')).linkSpeed, 32);
  assert.equal(
    compressedStates(m.scenarios.service),
    'r.idle hotreset detect.quiet gap config.width.start disabled detect.quiet detect.active'
  );
  assert.equal(
    compressedStates(m.scenarios.loopback),
    'config.width.start loop.entry loop.active loop.exit detect.quiet'
  );
  assert.equal(
    compressedStates(m.scenarios.compliance),
    'polling.active polling.compliance reset detect.quiet'
  );
  assert.equal(compressedStates(m.scenarios.l2), 'l0 gap l2.idle l2.wake reset detect.quiet');
});
check('All P0 rate requests are preceded by idle/standby and finish before either is released', () => {
  let requests = 0;
  for (const [id, scene] of Object.entries(m.scenarios)) {
    scene.steps.forEach((s, i) => {
      if (!i || s.rate === scene.steps[i - 1].rate) return;
      requests++;
      const last = scene.steps[i - 1],
        done = scene.steps[i + 1];
      assert.equal(last.generation, s.generation);
      assert.equal(done.generation - 1, s.rate);
      for (const dir of dirs) {
        for (const step of [last, s, done]) {
          const f = m.sample(id, step.start, dir);
          assert.equal(f.signals.powerDown, 0);
          assert.equal(f.signals.standby, 1);
          assert.equal(f.signals.txIdle, 1);
          assert.equal(step[dir], 'EIDLE');
        }
        assert.equal(sig(id, s.tag, dir).phyStatus, 0);
        assert.equal(sig(id, done.tag, dir).phyStatus, 1);
        assert.equal(sig(id, done.tag, dir, 1).phyStatus, 0);
      }
    });
    scene.steps.forEach((s, i) => {
      if (i && s.generation !== scene.steps[i - 1].generation) assert.equal(s.ack, true);
    });
  }
  assert.equal(requests, 7);
  assert.equal(at('gen6', 'request-g6').signals.rate, 5);
  assert.equal(at('gen6', 'request-g6').linkSpeed, 32);
  assert.equal(at('gen6', 'complete-g6').linkSpeed, 64);
});
check('P1 receiver detection holds the request and qualifies RxStatus with PhyStatus', () => {
  assert.deepEqual(
    [
      sig('cold', 'detect-request').powerDown,
      sig('cold', 'detect-request').detect,
      sig('cold', 'detect-request').rxStatus
    ],
    [2, 1, null]
  );
  const done = sig('cold', 'detect-complete');
  assert.deepEqual([done.detect, done.phyStatus, done.rxStatus], [1, 1, 3]);
  assert.equal(sig('cold', 'detect-complete', 'down', 1).rxStatus, null);
  assert.equal(sig('cold', 'detect-release').detect, 0);
  assert.equal(sig('cold', 'detect-release').powerDown, 2);
  assert.equal(sig('cold', 'poll-ack').phyStatus, 1);
  assert.equal(sig('cold', 'polling-active').txIdle, 0);
});
check('Reset completion is a falling PhyStatus, and P2 clocks are unobserved', () => {
  for (const [scene, start, release] of [
    ['cold', 'reset', 'quiet'],
    ['compliance', 'compliance-reset', 'compliance-detect'],
    ['l2', 'l2-reset', 'l2-detect']
  ]) {
    assert.equal(sig(scene, start).reset, 0);
    assert.equal(sig(scene, start).detect, 0);
    assert.equal(sig(scene, start).phyStatus, 1);
    assert.equal(sig(scene, release).reset, 1);
    assert.equal(sig(scene, release).phyStatus, 1);
    assert.equal(sig(scene, release, 'down', 1).phyStatus, 0);
  }
  assert.equal(sig('l2', 'l2-idle').pclk, null);
  assert.equal(sig('l2', 'l2-wake', 'down').rxIdle, 0);
  assert.equal(sig('l2', 'l2-wake', 'up').txIdle, 0);
});
check('SerDes loopback is implemented in the MAC and high-rate EI is inferred', () => {
  assert.equal(sig('loopback', 'loop-active').detect, 0);
  for (const [id, scene] of Object.entries(m.scenarios))
    for (const step of scene.steps) {
      for (const dir of dirs) {
        const v = m.sample(id, step.start, dir).signals;
        if (step.generation > 1) assert.equal(v.rxIdle, null);
        if (step[dir] === 'EIDLE') assert.equal(v.txIdle, 1);
        if (step.state === 'gap') assert.ok(Object.values(v).every((x) => x === null));
        if (v.powerDown === 1 || v.powerDown === 2) assert.equal(v.txIdle, 1);
        if (v.rxStatus !== null) assert.equal(v.rxStatus, 3);
      }
    }
});
check('Optional receiver control is armed after PHY completion and clears for the remote TX', () => {
  for (const dir of dirs) {
    assert.equal(sig('gen6', 'request-g6', dir).restricted, null);
    assert.equal(sig('gen6', 'complete-g6', dir).restricted, 0);
    assert.equal(sig('gen6', 'arm-g6', dir).restricted, 1);
    assert.equal(sig('gen6', 'arm-g6', dir).standby, 1);
    assert.equal(sig('gen6', 'g6-lock-new', dir).standby, 0);
  }
  assert.equal(sig('gen6', 'g6-p2-ask', 'up').restricted, 0);
  assert.equal(sig('gen6', 'g6-p2-ask', 'down').restricted, 1);
  assert.equal(at('gen6', 'g6-p2-ask').step.down, 'TS0');
  assert.equal(sig('gen6', 'g6-p3-ask', 'down').restricted, 0);
  assert.equal(at('gen6', 'g6-p3-ask').step.up, 'TS0');
});
check('Directional ordered sets and the Gen6 data-stream start match the selected EQ path', () => {
  for (const [tag, down, up] of [
    ['g6-p0', 'TS0', 'TS0'],
    ['g6-p1', 'TS0', 'TS0'],
    ['g6-p2-start', 'TS0', 'TS0'],
    ['g6-p2-ts1', 'TS1', 'TS0'],
    ['g6-p3-start', 'TS1', 'TS0'],
    ['g6-p3-ts1', 'TS1', 'TS1']
  ]) {
    const s = at('gen6', tag).step;
    assert.equal(s.down, down);
    assert.equal(s.up, up);
  }
  assert.equal(
    m.scenarios.gen6.steps
      .slice(-5)
      .map((s) => s.down)
      .join(','),
    'TS2,SDS,SKP,IDLE FLIT,FLIT'
  );
});
check('L0s stays directional and Non-Flit; all 64 GT/s intervals are Flit capable', () => {
  for (const scene of Object.values(m.scenarios))
    for (const s of scene.steps) {
      if (s.generation === 6) assert.equal(s.flit, true);
      if (s.state === 'l0s') {
        assert.equal(s.flit, false);
        assert.ok(s.generation < 6);
        assert.equal(m.portState(s, 'up'), 'l0');
      }
    }
  assert.equal(sig('power', 'l0s-idle', 'down').powerDown, 1);
  assert.equal(sig('power', 'l0s-idle', 'up').powerDown, 0);
  assert.equal(at('power', 'l0s-idle').step.up, 'ACK');
  assert.equal(at('power', 'l1-l0').step.down, 'DATA');
});
check('Flit negotiation and the sender-specific Configuration handoff occur before first L0', () => {
  assert.equal(at('cold', 'width-start').step.flit, false);
  assert.equal(at('cold', 'width-accept').step.flit, true);
  assert.equal(m.portState(at('cold', 'ds-lane-accept').step, 'down'), 'config.lane.accept');
  const step = at('cold', 'lane-accept').step;
  assert.equal(m.portState(step, 'down'), 'config.complete');
  assert.equal(step.down, 'TS2');
  assert.equal(m.portState(step, 'up'), 'config.lane.accept');
  assert.equal(step.up, 'TS1');
});
check('Data stream starts and L0s exit have the correct ordered-set sequence for each mode', () => {
  for (const gen of [3, 4, 5, 6]) {
    const steps = m.scenarios.cold.steps.filter((s) => s.state === 'r.idle' && s.generation === gen);
    assert.equal(steps.map((s) => s.down).join(','), 'SDS,SKP,IDLE FLIT');
  }
  const power = m.scenarios.power.steps;
  assert.equal(power[0].generation, 5);
  assert.equal(
    power
      .filter((s) => s.state === 'l0s' && s.down !== 'EIDLE')
      .map((s) => s.down)
      .join(','),
    'EIOS,EIEOS,FTS,EIEOS,SDS'
  );
  assert.equal(at('power', 'l1-enter').step.down, 'EIDLE');
  assert.equal(
    power
      .filter((s) => s.state === 'r.idle')
      .map((s) => s.down)
      .join(','),
    'SKP,SDS,IDLE'
  );
  const rows = m.logRows('gen6');
  assert.ok(rows.find((r) => r.tick === at('gen6', 'g6-lock-new').tick).detail.includes('4 × EIEOS'));
  assert.ok(rows.find((r) => r.tick === at('gen6', 'sds-g6').tick).detail.includes('2 × SDS'));
});
check('Tracker covers both transmitters at every stage and preserves idle and unknown', () => {
  for (const [id, sc] of Object.entries(m.scenarios)) {
    const rows = m.logRows(id);
    assert.equal(rows.length, sc.steps.length * 2);
    for (const r of rows) {
      const s = sc.steps[r.index],
        frame = m.sample(id, r.tick, r.dir);
      assert.equal(r.token, s[r.dir]);
      assert.equal(r.name, m.wire[s[r.dir]][0]);
      assert.equal(r.tick, s.start);
      if (r.category === 'idle') assert.equal(frame.signals.txIdle, 1);
      if (r.token === 'UNKNOWN') assert.equal(r.category, 'other');
    }
  }
});
check('NRZ / TS0 / PAM4 use the prescribed number of levels and the correct symbol period', () => {
  const nrz = byTag('g5-l0', 'down'),
    ts0 = byTag('g6-p2-ts1', 'up'),
    pam = byTag('g6-p2-ts1', 'down');
  for (const [p, mode, rails] of [
    [nrz, 'nrz', [0, 3]],
    [ts0, 'ts0', [0, 3]],
    [pam, 'pam4', [0, 1, 2, 3]]
  ]) {
    assert.equal(p.mode, mode);
    assert.equal(p.baud, 32);
    assert.equal(p.uiPs, 31.25);
    assert.deepEqual([...new Set(serial.makeTrace(p).ids)].sort(), rails);
  }
  assert.equal(serial.profile(at('cold', 'polling-active').step, 'down').uiPs, 400);
  assert.equal(serial.makeTrace(byTag('request-g6', 'down')), null);
  assert.equal(serial.makeTrace(serial.profile(at('l2', 'l2-wake').step, 'up')), null);
});
check('Eye slices are 2 UI views of the scope record and compare equal stimuli', () => {
  for (const dir of dirs) {
    const p = byTag('g6-p2-ts1', dir),
      now = serial.makeTrace(p),
      raw = serial.makeTrace(p, true);
    const windows = serial.eyeWindows(now);
    assert.equal(windows.length, 377);
    assert.equal(windows[0].length, 2 * now.samplesPerUI + 1);
    assert.equal(windows[0].buffer, now.data.buffer);
    assert.equal(windows[0][now.samplesPerUI], now.data[(4 + 0.5) * now.samplesPerUI]);
    assert.deepEqual([...now.ids], [...raw.ids]);
    assert.deepEqual([...serial.makeTrace(p).data], [...now.data]);
    assert.notDeepEqual([...now.data], [...raw.data]);
    assert.equal(now.openings.length, dir === 'down' ? 3 : 1);
    assert.ok(Math.min(...now.openings) > Math.min(...raw.openings));
  }
});
check('Cursor boundaries, replay endpoint and previous/next navigation are stable', () => {
  for (const [id, sc] of Object.entries(m.scenarios)) {
    for (const invalid of [-1, Infinity, NaN]) assert.equal(m.sample(id, invalid).index, 0);
    for (const [i, s] of sc.steps.entries()) {
      assert.equal(m.move(id, s.start, 1), m.boundary(id, i + 1));
      assert.equal(m.move(id, s.start, -1), m.boundary(id, i - 1));
      assert.equal(m.move(id, s.start + 0.25, -1), s.start);
    }
    assert.equal(m.sample(id, sc.total + 10).index, sc.steps.length - 1);
    assert.equal(m.move(id, sc.total, 1), sc.total);
  }
});
console.log(checks + '/' + checks + ' teaching-model checks passed.');

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareErrors } from './errors.mjs';
import { openHistory } from './history.mjs';
test('baseline, growth, unchanged, missing counters and resets remain distinct', () => {
  assert.deepEqual(compareErrors({ crcErrors: 252 }), { crcErrors: { status: 'baseline', delta: null } });
  assert.equal(compareErrors({ crcErrors: 252 }, { crcErrors: 252 }).crcErrors.status, 'unchanged');
  assert.deepEqual(compareErrors({ crcErrors: 254 }, { crcErrors: 252 }).crcErrors, { status: 'increased', delta: 2 });
  assert.equal(compareErrors({ crcErrors: 0 }, { crcErrors: 252 }).crcErrors.status, 'reset');
  assert.deepEqual(compareErrors({ crcErrors: null }), {});
});
test('persisted previous available counters survive gaps and restarts in scan data', () => {
  const history = openHistory(':memory:');
  try {
    const drive = { name: 'WDC test', serial: 'a', smartErrors: { crcErrors: 252, pendingSectors: 0 } };
    const save = (d, time) => { const scan = { drives: [d], scannedAt: time }; history.annotateErrors(scan); history.save(scan); return d; };
    assert.equal(save(drive, '2026-10-18T10:00:00Z').smartChanges.crcErrors.status, 'baseline');
    save({ name: drive.name, serial: 'a' }, '2026-10-18T10:05:00Z');
    const next = save({ ...drive, smartErrors: { crcErrors: 255, pendingSectors: 1 } }, '2026-10-18T10:10:00Z');
    assert.equal(next.smartChanges.crcErrors.delta, 3);
    assert.equal(next.smartChanges.pendingSectors.delta, 1);
  } finally { history.close(); }
});

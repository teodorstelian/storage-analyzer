import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName } from './names.mjs';
import { driveKey } from './history.mjs';
test('uses exposed models and volume labels without changing drive identity', () => {
  const drive = { id: '2', serial: 'abc', name: 'USB 3.0', windowsModel: 'USB 3.0', volumes: [{ letter: 'E:', label: 'Fun' }] };
  assert.equal(displayName(drive), 'USB 3.0 · E: [Fun]');
  const key = driveKey(drive);
  drive.windowsModel = 'WDC WD10EZEX-00BBHA0';
  assert.equal(displayName(drive), 'WDC WD10EZEX-00BBHA0');
  assert.equal(driveKey(drive), key);
  drive.smartModel = 'Actual SMART model';
  assert.equal(displayName(drive), 'Actual SMART model');
  drive.ataModel = 'WDC WD10EZEX-08WN4A0';
  assert.equal(displayName(drive), 'WDC WD10EZEX-08WN4A0');
  assert.equal(driveKey(drive), key);
  assert.equal(displayName({ name: 'KINGSTON SNV3S2000G' }), 'KINGSTON SNV3S2000G');
});

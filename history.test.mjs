import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driveKey, openHistory } from './history.mjs';

test('records use all-time peaks, preserve zero, and retain disconnected drives', () => {
  const history = openHistory(':memory:');
  try {
    assert.deepEqual(history.records(), []);
    const a = { name: 'SSD A', serial: 'a', lifetimeWritesBytes: 5000000000000, powerOnHours: 345, temperature: 40, wear: 0 };
    const b = { name: 'SSD B', serial: 'b', powerOnHours: 1000, temperature: 60 };
    history.save({ scannedAt: '2026-10-18T08:00:00Z', drives: [a, b] });
    history.save({ scannedAt: '2026-10-18T09:00:00Z', drives: [{ ...a, lifetimeWritesBytes: 1000000000000, powerOnHours: null, temperature: 0 }] });
    history.save({ scannedAt: '2026-10-18T10:00:00Z', drives: [{ ...a, lifetimeWritesBytes: 5000000000000, temperature: 42 }] });
    const records = history.records();
    const first = records.find((d) => d.id === driveKey(a));
    const second = records.find((d) => d.id === driveKey(b));
    assert.equal(records.length, 2);
    assert.equal(first.records, 3);
    assert.deepEqual(first.peaks.lifetimeWritesBytes, { value: 5000000000000, recordedAt: '2026-10-18T08:00:00Z' });
    assert.equal(first.peaks.temperature.value, 42);
    assert.equal(first.peaks.powerOnHours.value, 345);
    assert.equal(first.peaks.wear.value, 0);
    assert.equal(second.peaks.lifetimeWritesBytes, undefined);
    assert.equal(second.peaks.temperature.value, 60);
    assert.equal(second.last_seen, '2026-10-18T08:00:00Z');
  } finally { history.close(); }
});

test('history survives restart and tracks one drive across disk slot changes', () => {
  const folder = mkdtempSync(join(tmpdir(), 'drive-history-'));
  const path = join(folder, 'test.sqlite');
  let history = openHistory(path);
  const drive = { id: '0', name: 'Test SSD', serial: 'serial-a', temperature: 0, wear: 2, readErrors: 0, lifetimeWritesBytes: 1000000000000 };
  try {
    history.save({ scannedAt: '2026-10-18T08:00:00Z', drives: [drive], warnings: [] });
    history.close(); history = openHistory(path);
    history.save({ scannedAt: '2026-10-18T09:00:00Z', drives: [{ ...drive, id: '3', temperature: 40, wear: 3, readErrors: 4, lifetimeWritesBytes: 2000000000000 }], warnings: [] });
    history.save({ scannedAt: '2026-10-18T10:00:00Z', drives: [{ ...drive, temperature: null, wear: null, readErrors: null, lifetimeWritesBytes: null }], warnings: [] });
    const list = history.list(); assert.equal(list.length, 1); assert.equal(list[0].records, 3);
    const record = history.get(driveKey(drive));
    assert.equal(record.stats.averageTemperature, 20); assert.equal(record.stats.maxTemperature, 40);
    assert.equal(record.stats.wearChange, 1); assert.equal(record.stats.readErrorChange, 4);
    assert.equal(record.stats.lifetimeWritesChange, 1000000000000);
    assert.equal(record.readings[1].lifetimeWritesBytes, 2000000000000);
    assert.equal(record.stats.writeErrorChange, null); assert.equal(record.readings[0].temperature, null);
    assert.equal(history.get('missing'), null);
  } finally { history.close(); rmSync(folder, { recursive: true }); }
});

test('separates identical models and retains disconnected drives after empty scans', () => {
  const history = openHistory(':memory:');
  try {
    const a = { id: '0', name: 'Same SSD', serial: 'a' };
    const b = { id: '1', name: 'Same SSD', serial: 'b' };
    assert.notEqual(driveKey(a), driveKey(b));
    assert.equal(driveKey({ ...a, uniqueId: 'stable' }), driveKey({ ...b, uniqueId: 'stable' }));
    history.save({ scannedAt: '2026-10-18T08:00:00Z', drives: [a, b], warnings: [] });
    history.save({ scannedAt: '2026-10-18T09:00:00Z', drives: [], warnings: ['Access denied'] });
    assert.equal(history.list().length, 2);
    assert.equal(history.get(driveKey(a)).stats.records, 1);
  } finally { history.close(); }
});

test('limits displayed records but computes statistics across the full history', () => {
  const history = openHistory(':memory:');
  try {
    const drive = { id: '0', name: 'SSD', serial: 'a' };
    for (let i = 0; i < 205; i++) history.save({ scannedAt: new Date(1700000000000 + i * 1000).toISOString(), drives: [{ ...drive, temperature: i === 0 ? 99 : 20 }], warnings: [] });
    const record = history.get(driveKey(drive));
    assert.equal(record.readings.length, 200); assert.equal(record.stats.records, 205); assert.equal(record.stats.maxTemperature, 99);
  } finally { history.close(); }
});

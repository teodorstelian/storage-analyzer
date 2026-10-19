import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichSmart, mergeSmart } from './smart.mjs';

test('KINGSTON NVMe fills unavailable counters while preserving Windows values and identity', () => {
  const drive = { id: '1', uniqueId: 'keep', name: 'KINGSTON SNV3S2000G', serial: ' abc ', temperature: 36, powerOnHours: null, source: 'Windows Storage' };
  assert.equal(mergeSmart(drive, { serial_number: 'ABC', power_on_time: { hours: 345 }, nvme_smart_health_information_log: { percentage_used: 3, temperature: 40, media_errors: 2 } }), true);
  assert.equal(drive.powerOnHours, 345); assert.equal(drive.temperature, 36); assert.equal(drive.wear, 3);
  assert.equal(drive.uniqueId, 'keep'); assert.equal(drive.readErrors, undefined);
  assert.equal(drive.metricSources.powerOnHours, 'smartctl SMART');
});

test('does not mix identical models with different or missing serials; zero is a valid counter', () => {
  for (const serial of ['', 'wrong']) {
    const drive = { serial, powerOnHours: null };
    assert.equal(mergeSmart(drive, { serial_number: 'ABC', power_on_time: { hours: 345 } }), false);
    assert.equal(drive.powerOnHours, null);
  }
  const drive = { serial: 'abc', powerOnHours: 0 };
  mergeSmart(drive, { serial_number: 'abc', power_on_time: { hours: 345 } });
  assert.equal(drive.powerOnHours, 0);
});

test('fallback discovers devices and matches serials regardless of enumeration order', async () => {
  const scan = { warnings: [], drives: [{ serial: 'a', powerOnHours: null }, { serial: 'b', powerOnHours: null }] };
  await enrichSmart(scan, async (file, args) => {
    if (args[0] === '--scan-open') return { devices: [{ name: '/dev/nvme0', type: 'nvme' }, { name: '/dev/nvme1', type: 'nvme' }] };
    assert.ok(args.includes('-a')); assert.ok(args.includes('-j'));
    return { serial_number: args.at(-1) === '/dev/nvme0' ? 'b' : 'a', nvme_smart_health_information_log: { power_on_hours: 345, data_units_written: 0 } };
  }, 'test-smartctl');
  assert.equal(scan.drives[0].powerOnHours, 345); assert.equal(scan.drives[1].powerOnHours, 345);
  assert.deepEqual(scan.warnings, []);
});

test('missing tool or denied access preserves existing readings and explains missing hours', async () => {
  const scan = { warnings: [], drives: [{ serial: 'a', temperature: 35, powerOnHours: null }] };
  await enrichSmart(scan, async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, 'missing');
  assert.match(scan.warnings[0], /optional fallback/); assert.equal(scan.drives[0].temperature, 35);
  assert.equal(scan.drives[0].powerOnHours, null);
});

test('ambiguous serials and invalid counter values do not produce false readings', async () => {
  const drive = { serial: 'abc' };
  mergeSmart(drive, { serial_number: 'abc', power_on_time: { hours: -1 }, temperature: { current: '45' }, nvme_smart_health_information_log: { percentage_used: Infinity } });
  assert.equal(drive.powerOnHours, undefined); assert.equal(drive.wear, undefined);
  const scan = { warnings: [], drives: [{ serial: 'abc' }, { serial: 'abc' }] };
  await enrichSmart(scan, async (file, args) => args[0] === '--scan-open' ? { devices: [{ name: '/dev/nvme0' }] } : { serial_number: 'abc', power_on_time: { hours: 345 } }, 'test');
  assert.ok(scan.drives.every((d) => d.powerOnHours === undefined));
});

test('NVMe lifetime writes uses 512000 bytes per data unit, including zero', () => {
  const drive = { serial: 'kingston' };
  mergeSmart(drive, { serial_number: 'kingston', nvme_smart_health_information_log: { data_units_written: 21757813 } });
  assert.equal(drive.lifetimeWritesBytes, 11140000256000);
  assert.equal((drive.lifetimeWritesBytes / 1e12).toFixed(2), '11.14');
  const empty = { serial: 'new' };
  mergeSmart(empty, { serial_number: 'new', nvme_smart_health_information_log: { data_units_written: 0 } });
  assert.equal(empty.lifetimeWritesBytes, 0);
});

test('does not guess vendor ATA write units or accept unsafe NVMe byte totals', () => {
  for (const data of [
    { ata_smart_attributes: { table: [{ id: 241, raw: { value: 12345 } }] } },
    { nvme_smart_health_information_log: { data_units_written: Number.MAX_SAFE_INTEGER } },
    { nvme_smart_health_information_log: { data_units_written: -1 } },
    { nvme_smart_health_information_log: { data_units_written: '123' } },
  ]) {
    const drive = { serial: 'a' };
    mergeSmart(drive, { ...data, serial_number: 'a' });
    assert.equal(drive.lifetimeWritesBytes, undefined);
  }
});

test('queries SMART for writes even when Windows already supplies power-on hours', async () => {
  const scan = { warnings: [], drives: [{ serial: 'a', powerOnHours: 345 }] };
  await enrichSmart(scan, async (file, args) => args[0] === '--scan-open'
    ? { devices: [{ name: '/dev/nvme0' }] }
    : { serial_number: 'a', nvme_smart_health_information_log: { data_units_written: 2000000 } }, 'test');
  assert.equal(scan.drives[0].lifetimeWritesBytes, 1024000000000);
  assert.equal(scan.drives[0].powerOnHours, 345);
});

test('missing USB writes warning identifies only affected drives and counters', async () => {
  const scan = { warnings: [], drives: [
    { id: '0', name: 'KINGSTON', busType: 'NVMe', powerOnHours: 345, lifetimeWritesBytes: 12250000000000 },
    { id: '1', name: 'Seagate M3 Portable', busType: 'USB', powerOnHours: 11856 },
  ] };
  await enrichSmart(scan, async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, 'missing');
  assert.equal(scan.warnings.length, 1);
  assert.match(scan.warnings[0], /Seagate M3 Portable \(disk 1\): Lifetime Writes unavailable/);
  assert.match(scan.warnings[0], /USB bridges/);
  assert.doesNotMatch(scan.warnings[0], /KINGSTON|administrator|power-on time/);
});

test('complete native readings do not call optional tools or warn', async () => {
  const scan = { warnings: [], drives: [{ powerOnHours: 345, lifetimeWritesBytes: 0 }] };
  await enrichSmart(scan, async () => { throw new Error('Should not run'); }, 'missing');
  assert.deepEqual(scan.warnings, []);
});

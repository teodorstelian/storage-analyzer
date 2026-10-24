import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderMetrics,createExporter} from './metrics.mjs';
test('metrics preserve missing sensors, escape labels and omit serials', () => {
  const text = renderMetrics({scannedAt:'2026-10-24T00:00:00Z',drives:[{name:'A"\\\nB',serial:'secret-serial',temperature:0,wear:null,smartErrors:{pendingSectors:2}}]},true);
  assert.match(text,/drive_health_scan_success 1/);
  assert.match(text,/temperature_celsius\{.*\} 0/);
  assert.match(text,/name="A\\"\\\\\\nB"/);
  assert.doesNotMatch(text,/secret-serial|wear_percent\{/);
  assert.match(text,/smart_pending_sectors\{.*\} 2/);
  assert.ok(text.endsWith('\n'));
});
test('failed scan with no snapshot does not fabricate drives', () => {
  assert.doesNotMatch(renderMetrics(undefined,false),/drive_health_info/);
  assert.match(renderMetrics(undefined,false),/scan_success 0/);
});
test('exporter can enable and disable; occupied port is recoverable', async () => {
  const exporter = createExporter(() => ({healthy:false}),{port:19431});
  const conflict = createExporter(() => ({}),{port:19431});
  try {
    await exporter.setEnabled(true);
    assert.equal(exporter.enabled,true);
    const response = await fetch('http://127.0.0.1:19431/metrics');
    assert.match(await response.text(),/scan_success 0/);
    assert.equal((await fetch('http://127.0.0.1:19431/api/health')).status,404);
    await assert.rejects(conflict.setEnabled(true),{code:'EADDRINUSE'});
    assert.equal(conflict.enabled,false);
  } finally { await exporter.setEnabled(false); }
  assert.equal(exporter.enabled,false);
});

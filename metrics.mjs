import http from 'node:http';
import { driveKey } from './history.mjs';

const escape = v => String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
export function renderMetrics(scan, healthy) {
  const lines = [];
  const emit = (name, help, samples) => {
    lines.push(`# HELP drive_health_${name} ${help}`, `# TYPE drive_health_${name} gauge`);
    for (const [labels, value] of samples) if (typeof value === 'number' && Number.isFinite(value)) lines.push(`drive_health_${name}${labels} ${value}`);
  };
  emit('scan_success', 'Whether the most recent scan succeeded.', [['', healthy ? 1 : 0]]);
  if (!scan) return lines.join('\n') + '\n';
  emit('scan_timestamp_seconds', 'Latest successful scan time.', [['', Date.parse(scan.scannedAt) / 1000]]);
  const rows = scan.drives.map(d => [`{drive="${driveKey(d)}",name="${escape(d.displayName || d.name)}"}`, d]);
  emit('info', 'Currently connected drives.', rows.map(([l]) => [l, 1]));
  emit('status', 'Windows health: 0 unknown, 1 healthy, 2 warning, 3 unhealthy.', rows.map(([l,d]) => [l, ({Healthy:1,Warning:2,Unhealthy:3})[d.health] || 0]));
  for (const [name,key] of Object.entries({temperature_celsius:'temperature',capacity_bytes:'size',wear_percent:'wear',power_on_hours:'powerOnHours',host_writes_bytes:'lifetimeWritesBytes',read_errors:'readErrors',write_errors:'writeErrors'})) {
    emit(name, 'Latest available drive measurement; missing values omitted.', rows.map(([l,d]) => [l,d[key]]));
  }
  for (const key of ['reallocatedSectors','pendingSectors','uncorrectableSectors','crcErrors']) emit(`smart_${key.replace(/[A-Z]/g,c => '_' + c.toLowerCase())}`, 'SMART raw count.', rows.map(([l,d]) => [l,d.smartErrors?.[key]]));
  return lines.join('\n') + '\n';
}

export function createExporter(getSnapshot, {port = 9431, host = '127.0.0.1'} = {}) {
  let server;
  return {
    get enabled() { return Boolean(server?.listening); },
    async setEnabled(enabled) {
      if (enabled === this.enabled) return;
      if (!enabled) { await new Promise((resolve,reject) => server.close(e => e ? reject(e) : resolve())); server = undefined; return; }
      const candidate = http.createServer((req,res) => {
        if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404).end(); return; }
        const {scan,healthy} = getSnapshot();
        res.writeHead(200, {'Content-Type':'text/plain; version=0.0.4; charset=utf-8','Cache-Control':'no-store'});
        res.end(renderMetrics(scan,healthy));
      });
      await new Promise((resolve,reject) => { candidate.once('error',reject); candidate.listen(port,host,resolve); });
      candidate.on('error', e => console.error('Metrics exporter:', e.message));
      server = candidate;
    }
  };
}

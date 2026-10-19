import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { displayName } from './names.mjs';

const valid = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const serial = (value) => String(value || '').trim().toUpperCase();
function reportMissing(scan, reason) {
  for (const drive of scan.drives) {
    const missing = [];
    if (!valid(drive.powerOnHours)) missing.push('power-on time');
    if (!valid(drive.lifetimeWritesBytes)) missing.push('Lifetime Writes');
    if (!missing.length) continue;
    const connection = drive.busType === 'USB'
      ? 'USB bridges and drive firmware may not expose these counters.'
      : 'Counter availability depends on the controller, driver, and firmware.';
    scan.warnings.push(`${displayName(drive)} (disk ${drive.id ?? '?' }): ${missing.join(' and ')} unavailable. ${connection} ${reason}`);
  }
}

export function mergeSmart(drive, data) {
  // Never associate measurements using model name or enumeration order.
  if (!serial(drive.serial) || serial(drive.serial) !== serial(data.serial_number)) return false;
  if (typeof data.model_name === 'string' && data.model_name.trim()) drive.smartModel = data.model_name.trim();
  const nvme = data.nvme_smart_health_information_log;
  const metrics = {
    powerOnHours: data.power_on_time?.hours ?? nvme?.power_on_hours,
    temperature: data.temperature?.current ?? nvme?.temperature,
    wear: nvme?.percentage_used,
    // NVMe data units are 1,000 × 512 bytes, independent of sector size.
    lifetimeWritesBytes: valid(nvme?.data_units_written) ? nvme.data_units_written * 512000 : undefined,
  };
  let changed = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (!valid(drive[key]) && valid(value)) {
      drive[key] = value;
      drive.metricSources = { ...drive.metricSources, [key]: 'smartctl SMART' };
      changed = true;
    }
  }
  // NVMe media_errors is not a separate read/write error count: do not map it.
  if (changed) drive.source = `${drive.source || 'Windows Storage'} + smartctl SMART`;
  return changed;
}

export function runSmart(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error?.killed || error?.signal || (error && typeof error.code !== 'number')) { reject(error); return; }
      // smartctl uses an exit-status bitmask, including health warnings. Parse valid
      // JSON even for nonzero status; a failing disk may still report its counters.
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); }
      catch { reject(new Error('smartctl did not return readable JSON.')); }
    });
  });
}

export async function enrichSmart(scan, run = runSmart, executable) {
  if (!scan.drives.some((d) => !valid(d.powerOnHours) || !valid(d.lifetimeWritesBytes))) return scan;
  const file = executable || process.env.SMARTCTL_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean).map((folder) => join(folder, 'smartmontools', 'bin', 'smartctl.exe')).find(existsSync) || 'smartctl.exe';
  try {
    const inventory = await run(file, ['--scan-open', '-j']);
    if (!Array.isArray(inventory.devices) || !inventory.devices.length) throw new Error('No SMART devices were accessible');
    const results = await Promise.allSettled(inventory.devices.map((device) => {
      if (typeof device.name !== 'string' || !device.name.startsWith('/dev/')) throw new Error('Invalid SMART device path');
      return run(file, ['-a', '-j', ...(device.type ? ['-d', device.type] : []), device.name]);
    }));
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const matches = scan.drives.filter((d) => serial(d.serial) && serial(d.serial) === serial(result.value.serial_number));
      if (matches.length === 1) mergeSmart(matches[0], result.value);
    }
    reportMissing(scan, 'The optional SMART fallback did not supply these readings.');
  } catch (error) {
    reportMissing(scan, error.code === 'ENOENT'
      ? 'smartmontools is an optional fallback; installing it does not guarantee these counters.'
      : 'The optional SMART fallback failed; check its installation and access permissions.');
  }
  return scan;
}

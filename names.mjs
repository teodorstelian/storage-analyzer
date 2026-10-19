const generic = (name) => /^(?:USB(?:\s*3\.\d)?(?:\s+(?:device|disk|storage|SCSI Disk Device))?|Generic.*|External USB.*)$/i.test(String(name || '').trim());
export function displayName(drive) {
  const model = [drive.ataModel, drive.smartModel, drive.windowsModel, drive.name].find((v) => typeof v === 'string' && v.trim() && !generic(v));
  const volumes = (drive.volumes || []).map((v) => `${v.letter}${v.label ? ` [${v.label}]` : ''}`).join(', ');
  return model?.trim() || (volumes ? `${drive.name || 'USB drive'} · ${volumes}` : drive.name || 'Unknown drive');
}

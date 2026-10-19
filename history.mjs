import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { compareErrors, errorKeys } from './errors.mjs';

export function driveKey(drive) {
  const identity = drive.uniqueId ? ['unique', drive.uniqueId] : drive.serial ? ['serial', drive.serial, drive.name] : ['fallback', drive.id, drive.name, drive.size, drive.busType];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function openHistory(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY, scanned_at TEXT NOT NULL, warnings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drives (id TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, identity_confidence TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS readings (scan_id INTEGER NOT NULL REFERENCES scans(id), drive_id TEXT NOT NULL REFERENCES drives(id), snapshot TEXT NOT NULL, PRIMARY KEY(scan_id, drive_id));
    CREATE INDEX IF NOT EXISTS readings_by_drive ON readings(drive_id, scan_id DESC);`);
  return {
    annotateErrors(scan) {
      for (const drive of scan.drives) {
        const baseline = {};
        for (const row of db.prepare('SELECT snapshot FROM readings WHERE drive_id=? ORDER BY scan_id DESC').iterate(driveKey(drive))) {
          const prior = JSON.parse(row.snapshot);
          for (const key of errorKeys) if (baseline[key] === undefined && Number.isSafeInteger(prior.smartErrors?.[key]) && prior.smartErrors[key] >= 0) baseline[key] = prior.smartErrors[key];
          if (errorKeys.every((key) => baseline[key] !== undefined)) break;
        }
        drive.smartChanges = compareErrors(drive.smartErrors, baseline);
      }
    },
    save(scan) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare('INSERT INTO scans(scanned_at, warnings) VALUES (?, ?)').run(scan.scannedAt, JSON.stringify(scan.warnings || []));
        for (const drive of scan.drives) {
          const key = driveKey(drive);
          db.prepare(`INSERT INTO drives VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, last_seen=excluded.last_seen`).run(key, drive.displayName || drive.name, scan.scannedAt, scan.scannedAt, drive.uniqueId || drive.serial ? 'hardware identifier' : 'device slot (may change)');
          db.prepare('INSERT OR REPLACE INTO readings VALUES (?, ?, ?)').run(result.lastInsertRowid, key, JSON.stringify(drive));
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    list() {
      return db.prepare(`SELECT d.*, (SELECT COUNT(*) FROM readings r WHERE r.drive_id=d.id) AS records FROM drives d ORDER BY last_seen DESC, name`).all();
    },
    records() {
      const drives = new Map(this.list().map((drive) => [drive.id, { ...drive, peaks: {} }]));
      const metrics = ['lifetimeWritesBytes', 'powerOnHours', 'temperature', 'wear'];
      for (const row of db.prepare(`SELECT r.drive_id, r.snapshot, s.scanned_at FROM readings r JOIN scans s ON s.id=r.scan_id ORDER BY s.id`).iterate()) {
        const drive = drives.get(row.drive_id);
        const snapshot = JSON.parse(row.snapshot);
        for (const metric of metrics) {
          const value = snapshot[metric];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
          if (!drive.peaks[metric] || value > drive.peaks[metric].value) drive.peaks[metric] = { value, recordedAt: row.scanned_at };
        }
      }
      return [...drives.values()];
    },
    get(id) {
      const drive = db.prepare('SELECT * FROM drives WHERE id=?').get(id);
      if (!drive) return null;
      const all = db.prepare(`SELECT s.scanned_at, r.snapshot FROM readings r JOIN scans s ON s.id=r.scan_id WHERE r.drive_id=? ORDER BY s.id`).all(id).map((row) => ({ ...JSON.parse(row.snapshot), scannedAt: row.scanned_at }));
      const values = (key) => all.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      const temps = values('temperature');
      const delta = (key) => { const v = values(key); return v.length > 1 ? v.at(-1) - v[0] : null; };
      return { drive, stats: { records: all.length, averageTemperature: temps.length ? temps.reduce((a,b) => a+b,0)/temps.length : null, maxTemperature: temps.length ? Math.max(...temps) : null, lifetimeWritesChange: delta('lifetimeWritesBytes'), wearChange: delta('wear'), readErrorChange: delta('readErrors'), writeErrorChange: delta('writeErrors') }, readings: all.slice(-200).reverse() };
    },
    close() { db.close(); }
  };
}

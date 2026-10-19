const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const metrics = {
  lifetimeWritesBytes: { label: 'MOST LIFETIME WRITES', format: (v) => `${(v / 1e12).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TB` },
  powerOnHours: { label: 'LONGEST POWER-ON TIME', format: (v) => `${Math.floor(v / 24).toLocaleString()}d ${Math.floor(v % 24)}h` },
  temperature: { label: 'HIGHEST TEMPERATURE', format: (v) => `${v.toLocaleString()} °C` },
  wear: { label: 'MOST RATED LIFE USED', format: (v) => `${v.toLocaleString()}%` },
};
let drives = [];
function ranked(key) {
  return [...drives].sort((a, b) => (b.peaks[key]?.value ?? -Infinity) - (a.peaks[key]?.value ?? -Infinity) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
function render() {
  $('leaders').innerHTML = Object.entries(metrics).map(([key, metric]) => {
    const winner = ranked(key).find((drive) => drive.peaks[key]);
    return `<article><span>${metric.label}</span><strong>${winner ? metric.format(winner.peaks[key].value) : '—'}</strong><small>${winner ? esc(winner.name) : 'No recorded readings'}</small></article>`;
  }).join('');
  if (!drives.length) {
    $('rankings').innerHTML = '<div class="empty"><h3>No drive records yet</h3><p>Run a scan from Overview to start collecting records.</p><a href="/">Open Overview →</a></div>';
    return;
  }
  const key = $('ranking').value;
  const metric = metrics[key];
  let position = 0, rank = 0, previous;
  $('rankings').innerHTML = `<div class="record-scroll"><table><thead><tr><th>Rank</th><th>Drive</th><th>Record</th><th>First recorded at</th><th>Last seen</th><th>Saved scans</th></tr></thead><tbody>${ranked(key).map((drive) => {
    const peak = drive.peaks[key];
    if (peak) { position++; if (peak.value !== previous) rank = position; previous = peak.value; }
    return `<tr><td>${peak ? `#${rank}` : '—'}</td><td><a href="/?drive=${encodeURIComponent(drive.id)}">${esc(drive.name)}</a><small class="record-id">${esc(drive.id.slice(0, 8))}</small></td><td>${peak ? metric.format(peak.value) : 'Unavailable'}</td><td>${peak ? esc(new Date(peak.recordedAt).toLocaleString()) : '—'}</td><td>${esc(new Date(drive.last_seen).toLocaleString())}</td><td>${drive.records}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
async function load() {
  $('reload').disabled = true;
  try {
    const response = await fetch('/api/records');
    if (!response.ok) throw new Error('Unable to load records. Try refreshing.');
    drives = await response.json(); render();
    $('record-status').textContent = `Updated ${new Date().toLocaleTimeString()} · ${drives.length} saved drives · Refresh reads saved scans without scanning hardware.`;
  } catch (error) { $('record-status').textContent = `${error.message} Any displayed records may be stale.`; }
  finally { $('reload').disabled = false; }
}
$('ranking').addEventListener('change', render);
$('reload').addEventListener('click', load);
load();

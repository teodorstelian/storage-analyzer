const $ = (id) => document.getElementById(id);
let drives = [];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const present = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const metric = (v, suffix = '') => present(v) ? `${Number(v).toLocaleString()}${suffix}` : 'Unavailable';
const attention = (d) => ['reallocatedSectors', 'pendingSectors', 'uncorrectableSectors'].some((key) => Number(d.smartErrors?.[key]) > 0) || Object.values(d.smartChanges || {}).some((c) => c.status === 'increased') || ['Warning', 'Unhealthy'].includes(d.health) || Number(d.readErrors) > 0 || Number(d.writeErrors) > 0 || (present(d.wear) && Number(d.wear) >= 100);
const size = (n) => present(n) ? Number(n) >= 1e12
  ? `${(Number(n) / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`
  : `${(Number(n) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })} GB`
  : 'Unknown capacity';
const writes = (v) => present(v) ? `${(Number(v) / 1e12).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TB` : 'Unavailable';
const powerOnTime = (hours) => present(hours) && Number(hours) >= 0 ? `${Math.floor(Number(hours) / 24).toLocaleString()}d ${Math.floor(Number(hours) % 24)}h` : 'Unavailable';
const smartLabels = { reallocatedSectors: 'Reallocated sectors', pendingSectors: 'Pending sectors', uncorrectableSectors: 'Offline uncorrectable sectors', crcErrors: 'Communication CRC errors' };
function smartPanel(d) {
  const rows = Object.entries(smartLabels).map(([key, label]) => {
    const value = d.smartErrors?.[key], change = d.smartChanges?.[key];
    const note = !present(value) ? 'Unavailable' : change?.status === 'increased' ? `+${metric(change.delta)} since previous reading` : change?.status === 'reset' ? 'Counter decreased / reset' : change?.status === 'unchanged' ? 'No change' : 'First reading · baseline';
    return `<tr><td>${label}</td><td>${metric(value)}</td><td class="${change?.status === 'increased' ? 'error-increase' : ''}">${note}</td></tr>`;
  }).join('');
  return `<section class="smart-panel"><h3>SMART error tracking</h3><p class="history-caption">Changes compare with the previous available saved counter. Historical CRC errors alone do not trigger an alert.</p>${d.smartReadError ? `<p class="history-caption">${esc(d.smartReadError)}</p>` : ''}<div class="record-scroll"><table><thead><tr><th>Counter</th><th>Total</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function render() {
  const filtered = drives.filter((d) => $('filter').value === 'all' || d.mediaType === $('filter').value);
  $('drives').innerHTML = filtered.length ? filtered.map((d) => {
    const state = attention(d) ? 'warning' : d.health === 'Healthy' ? 'healthy' : 'unknown';
    const label = state === 'warning' ? 'Needs attention' : state === 'healthy' ? 'Reported healthy' : 'Health unknown';
    return `<article class="drive"><div class="drive-header"><div class="drive-icon">▤</div><div class="drive-name"><h3>${esc(d.displayName || d.name)}</h3><p>DISK ${esc(d.id)} <span>·</span> ${esc(d.mediaType === 'Unspecified' ? 'Drive type unavailable' : d.mediaType)} <span>·</span> ${esc(d.busType)}</p></div><span class="pill ${state}">● &nbsp; ${label}</span></div><div class="drive-body"><div class="capacity"><span>CAPACITY</span><strong>${size(d.size)}</strong><small>Total physical capacity</small></div><div><span>TEMPERATURE</span><strong>${metric(d.temperature, ' °C')}</strong><small>Peak recorded: ${metric(d.temperatureMax, ' °C')}</small></div><div><span>RATED LIFE USED</span><strong>${metric(d.wear, '%')}</strong><small>Reported wear counter</small></div><div><span>POWER-ON TIME</span><strong>${powerOnTime(d.powerOnHours)}</strong><small>${present(d.powerOnHours) ? `${metric(d.powerOnHours, ' total hours')} · ${esc(d.metricSources?.powerOnHours || 'Windows Storage')}` : 'Windows counter unavailable; see scan messages'}</small></div><div><span>LIFETIME WRITES</span><strong>${writes(d.lifetimeWritesBytes)}</strong><small>Total host writes · decimal TB</small></div></div><details><summary>View diagnostics <span>＋</span></summary><div class="details"><p>Model source <b>${esc(d.modelSource || (d.smartModel ? 'smartctl SMART' : 'Windows inventory'))}</b></p>${d.modelReadError ? `<p>USB identification <b>${esc(d.modelReadError)}</b></p>` : ''}${d.writesReadError ? `<p>ATA write counter <b>${esc(d.writesReadError)}</b></p>` : ''}<p>Windows device name <b>${esc(d.name)}</b></p><p>Volumes <b>${esc((d.volumes || []).map((v) => `${v.letter} ${v.label || ''}`.trim()).join(', ') || 'Unavailable')}</b></p><p>Serial number <b>${esc(d.serial || 'Unavailable')}</b></p><p>Operational status <b>${esc(d.operation || 'Unavailable')}</b></p><p>Uncorrected read errors <b>${metric(d.readErrors)}</b></p><p>Uncorrected write errors <b>${metric(d.writeErrors)}</b></p><p>Health provider <b>${esc(d.source)}</b></p></div></details>${smartPanel(d)}</article>`;
  }).join('') : '<div class="empty"><div class="empty-icon">▤</div><h3>No drives to display</h3><p>Check the messages above or select a different drive type.</p></div>';
}
async function refresh() {
  $('refresh').disabled = true; $('refresh').textContent = '↻ Scanning…'; $('status').textContent = 'Reading Windows Storage…';
  try {
    const response = await fetch('/api/health'); const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Drive scan failed.');
    drives = data.drives; $('count').textContent = drives.length; $('badge').textContent = drives.length;
    $('healthy').textContent = drives.filter((d) => d.health === 'Healthy' && !attention(d)).length;
    $('attention').textContent = drives.filter(attention).length;
    const temps = drives.filter((d) => present(d.temperature)).map((d) => Number(d.temperature));
    $('temp').textContent = temps.length ? `${Math.max(...temps)} °C` : '—';
    $('warnings').innerHTML = data.warnings.map((w) => `<p class="warning-message">ⓘ &nbsp; ${esc(w)}</p>`).join('');
    $('updated').textContent = `Updated ${new Date(data.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    $('status').textContent = 'Scan complete · saved locally'; render(); loadHistory();
  } catch (error) {
    $('warnings').innerHTML = `<p class="warning-message">${esc(error.message)} Previous readings, if shown, may be stale.</p>`;
    $('status').textContent = 'Scan failed';
    if (!drives.length) $('drives').innerHTML = '<div class="empty">Unable to read drive information. Refresh to try again.</div>';
  } finally { $('refresh').disabled = false; $('refresh').textContent = '↻  Refresh drives'; }
}
$('filter').addEventListener('change', render); $('refresh').addEventListener('click', refresh); refresh();
let historyRequest = 0;
async function loadHistory() {
  try {
    const response = await fetch('/api/history');
    if (!response.ok) throw new Error('Unable to load saved drives.');
    const list = await response.json();
    const previous = $('history-drive').value || new URLSearchParams(location.search).get('drive');
    $('history-drive').innerHTML = list.length ? list.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} · ${d.records} records · ${esc(d.id.slice(0, 8))}</option>`).join('') : '<option value="">No saved drives yet</option>';
    if (list.some((d) => d.id === previous)) $('history-drive').value = previous;
    await showHistory();
  } catch (error) { $('history-content').textContent = error.message; }
}
async function showHistory() {
  const request = ++historyRequest;
  const id = $('history-drive').value;
  if (!id) { $('history-content').textContent = 'Your first successful drive scan will appear here.'; return; }
  $('history-content').textContent = 'Loading drive records…';
  try {
    const response = await fetch(`/api/history/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error('Unable to load drive records.');
    const { drive, stats, readings } = await response.json();
    if (request !== historyRequest) return;
    const date = (v) => esc(new Date(v).toLocaleString());
    const change = (v, suffix = '') => present(v) ? `${v > 0 ? '+' : ''}${metric(v, suffix)}` : 'Need more readings';
    $('history-content').innerHTML = `<p class="history-caption">First seen ${date(drive.first_seen)} · Last seen ${date(drive.last_seen)}<br>Matched by ${esc(drive.identity_confidence)}. Counter changes compare the first and latest available readings; negative changes can indicate a reset.</p><div class="summary"><article><span>SAVED READINGS</span><strong>${stats.records}</strong><small>All-time records</small></article><article><span>AVERAGE / PEAK TEMP</span><strong>${present(stats.averageTemperature) ? metric(Math.round(stats.averageTemperature), ' °C') : '—'}</strong><small>Peak: ${metric(stats.maxTemperature, ' °C')}</small></article><article><span>WEAR CHANGE</span><strong>${change(stats.wearChange, ' pp')}</strong><small>Percentage points of rated life used</small></article><article><span>ERROR COUNTER CHANGE</span><strong>${change(stats.readErrorChange)}</strong><small>Read errors · Write: ${change(stats.writeErrorChange)}</small></article></div><p class="history-caption">Host writes change since first available reading: ${writes(stats.lifetimeWritesChange)}. Negative changes may indicate a counter reset.</p><p class="history-caption">Latest ${readings.length} records (up to 200 shown). Statistics use all saved readings.</p><div class="record-scroll"><table><thead><tr><th>Recorded</th><th>Health</th><th>Temp.</th><th>Wear used</th><th>Power-on time</th><th>Lifetime writes</th><th>Read errors</th><th>Write errors</th><th>Reallocated</th><th>Pending</th><th>Offline uncorrectable</th><th>CRC errors</th></tr></thead><tbody>${readings.map((r) => `<tr><td>${date(r.scannedAt)}</td><td>${esc(r.health)}</td><td>${metric(r.temperature, ' °C')}</td><td>${metric(r.wear, '%')}</td><td title="${metric(r.powerOnHours, ' total hours')}">${powerOnTime(r.powerOnHours)}</td><td>${writes(r.lifetimeWritesBytes)}</td><td>${metric(r.readErrors)}</td><td>${metric(r.writeErrors)}</td>${Object.keys(smartLabels).map((key) => `<td>${metric(r.smartErrors?.[key])}${r.smartChanges?.[key]?.status === 'increased' ? ` (+${metric(r.smartChanges[key].delta)})` : r.smartChanges?.[key]?.status === 'reset' ? ' (reset)' : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } catch (error) { if (request === historyRequest) $('history-content').textContent = error.message; }
}
$('history-drive').addEventListener('change', showHistory);
loadHistory();
setInterval(loadHistory, 60000);

import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openHistory } from './history.mjs';
import { enrichSmart } from './smart.mjs';
import { displayName } from './names.mjs';

await mkdir(new URL('./data/', import.meta.url), { recursive: true });
const history = openHistory(fileURLToPath(new URL('./data/drive-health.sqlite', import.meta.url)));

const root = new URL('./public/', import.meta.url);
let pending;
function scan() {
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./scan.ps1', import.meta.url))], { timeout: 45000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error('Windows could not read drive information. Try running the app from an administrator terminal.'));
      else { try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch { reject(new Error('Windows returned an unreadable response.')); } }
    });
  }).then(enrichSmart).then((data) => {
    for (const drive of data.drives) drive.displayName = displayName(drive);
    try { history.annotateErrors(data); history.save(data); }
    catch (error) { console.error('Unable to save scan:', error.message); data.warnings.push('This scan could not be saved to the local database.'); }
    return data;
  }).finally(() => { pending = undefined; });
  return pending;
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/records') {
    res.setHeader('Content-Type', 'application/json');
    try { res.end(JSON.stringify(history.records())); }
    catch { res.writeHead(500).end(JSON.stringify({ error: 'Unable to read drive records.' })); }
    return;
  }
  if (path === '/api/history' || path.startsWith('/api/history/')) {
    res.setHeader('Content-Type', 'application/json');
    try {
      const result = path === '/api/history' ? history.list() : history.get(path.slice('/api/history/'.length));
      if (!result) { res.writeHead(404).end(JSON.stringify({ error: 'Drive record not found.' })); return; }
      res.end(JSON.stringify(result));
    } catch { res.writeHead(500).end(JSON.stringify({ error: 'Unable to read drive history.' })); }
    return;
  }
  if (path === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    try { res.end(JSON.stringify(await scan())); }
    catch (error) { res.writeHead(503).end(JSON.stringify({ error: error.message })); }
    return;
  }
  const files = { '/': ['index.html', 'text/html'], '/records': ['records.html', 'text/html'], '/records.js': ['records.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
  if (!files[path]) { res.writeHead(404).end(); return; }
  try { res.setHeader('Content-Type', files[path][1]); res.end(await readFile(new URL(files[path][0], root))); }
  catch { res.writeHead(500).end('Unable to load app.'); }
});
server.listen(Number(process.env.PORT || 4317), '127.0.0.1', () => console.log(`Drive Health is ready at http://127.0.0.1:${server.address().port}`));
setInterval(() => scan().catch((error) => console.error('Scheduled scan failed:', error.message)), 5 * 60 * 1000).unref();
server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? 'This port is already in use. Stop the previous copy, or set $env:PORT = "4318" and restart.' : error.message); process.exitCode = 1; });

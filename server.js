'use strict';

const express  = require('express');
const fetch    = require('node-fetch');
const cors     = require('cors');
const path     = require('path');
const Database = require('better-sqlite3');
const fs       = require('fs');
const { spawn, execSync } = require('child_process');

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATUS_FILE = path.join(DATA_DIR, 'viz_status.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'nanoleaf.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS clusters (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    ip          TEXT    NOT NULL,
    token       TEXT    NOT NULL,
    player_name TEXT,
    viz_enabled INTEGER NOT NULL DEFAULT 1,
    smoothing   REAL    NOT NULL DEFAULT 0.15,
    freq_min    INTEGER NOT NULL DEFAULT 40,
    freq_max    INTEGER NOT NULL DEFAULT 16000,
    created     INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS ma_config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migrate existing clusters table if needed (add new columns)
const cols = db.prepare("PRAGMA table_info(clusters)").all().map(c => c.name);
if (!cols.includes('player_name'))  db.exec("ALTER TABLE clusters ADD COLUMN player_name TEXT");
if (!cols.includes('viz_enabled'))  db.exec("ALTER TABLE clusters ADD COLUMN viz_enabled INTEGER NOT NULL DEFAULT 1");
if (!cols.includes('smoothing'))    db.exec("ALTER TABLE clusters ADD COLUMN smoothing REAL NOT NULL DEFAULT 0.15");
if (!cols.includes('freq_min'))     db.exec("ALTER TABLE clusters ADD COLUMN freq_min INTEGER NOT NULL DEFAULT 40");
if (!cols.includes('freq_max'))     db.exec("ALTER TABLE clusters ADD COLUMN freq_max INTEGER NOT NULL DEFAULT 16000");

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Cluster CRUD ──────────────────────────────────────────────────────────────
app.get('/api/clusters', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, ip, token, player_name, viz_enabled, smoothing, freq_min, freq_max, created
    FROM clusters ORDER BY name
  `).all();
  res.json(rows);
});

app.post('/api/clusters', (req, res) => {
  const { name, ip, token, player_name, viz_enabled, smoothing, freq_min, freq_max } = req.body;
  if (!name || !ip || !token) return res.status(400).json({ error: 'name, ip and token are required' });
  try {
    const info = db.prepare(`
      INSERT INTO clusters (name, ip, token, player_name, viz_enabled, smoothing, freq_min, freq_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(), ip.trim(), token.trim(),
      (player_name || name).trim(),
      viz_enabled ?? 1,
      smoothing ?? 0.15,
      freq_min ?? 40,
      freq_max ?? 16000
    );
    res.json({ id: info.lastInsertRowid, name, ip, token });
    restartViz();
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: `A cluster named "${name}" already exists` });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/clusters/:id', (req, res) => {
  const { name, ip, token, player_name, viz_enabled, smoothing, freq_min, freq_max } = req.body;
  if (!name || !ip || !token) return res.status(400).json({ error: 'name, ip and token are required' });
  try {
    db.prepare(`
      UPDATE clusters SET name=?, ip=?, token=?, player_name=?, viz_enabled=?, smoothing=?, freq_min=?, freq_max=?
      WHERE id=?
    `).run(
      name.trim(), ip.trim(), token.trim(),
      (player_name || name).trim(),
      viz_enabled ?? 1,
      smoothing ?? 0.15,
      freq_min ?? 40,
      freq_max ?? 16000,
      req.params.id
    );
    res.json({ ok: true });
    restartViz();
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: `A cluster named "${name}" already exists` });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/clusters/:id', (req, res) => {
  db.prepare('DELETE FROM clusters WHERE id=?').run(req.params.id);
  res.json({ ok: true });
  restartViz();
});

app.put('/api/clusters/:id/viz_toggle', (req, res) => {
  const { enabled } = req.body;
  db.prepare('UPDATE clusters SET viz_enabled=? WHERE id=?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
  restartViz();
});

// ── MA Config ─────────────────────────────────────────────────────────────────
app.get('/api/ma_config', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM ma_config').all();
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  // Never expose token in plaintext beyond what's stored
  res.json(cfg);
});

app.put('/api/ma_config', (req, res) => {
  const { ma_host, ma_port, ma_token } = req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO ma_config (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    if (ma_host  !== undefined) upsert.run('ma_host',  ma_host);
    if (ma_port  !== undefined) upsert.run('ma_port',  String(ma_port));
    if (ma_token !== undefined) upsert.run('ma_token', ma_token);
  });
  tx();
  res.json({ ok: true });
  restartViz();
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.put('/api/settings', (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(req.body)) {
      upsert.run(k, String(v));
    }
  });
  tx();
  res.json({ ok: true });
  restartViz();
});

// ── Nanoleaf proxy helper ─────────────────────────────────────────────────────
async function nanoleaf(ip, token, method, endpoint, body) {
  const url  = `http://${ip}:16021/api/v1/${token}${endpoint}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  if (res.status === 204) return { status: 204, body: null };
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

// ── Nanoleaf API routes (studio) ──────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  const { ip, token } = req.query;
  if (!ip || !token) return res.status(400).json({ error: 'ip and token required' });
  try { const r = await nanoleaf(ip, token, 'GET', '', undefined); res.status(r.status).json(r.body); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/layout', async (req, res) => {
  const { ip, token } = req.query;
  try { const r = await nanoleaf(ip, token, 'GET', '/panelLayout/layout', undefined); res.status(r.status).json(r.body); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/state', async (req, res) => {
  const { ip, token } = req.query;
  try { const r = await nanoleaf(ip, token, 'GET', '/state', undefined); res.status(r.status).json(r.body); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.put('/api/brightness', async (req, res) => {
  const { ip, token } = req.query; const { value } = req.body;
  try { await nanoleaf(ip, token, 'PUT', '/state', { brightness: { value } }); res.status(200).json({ ok: true }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.put('/api/power', async (req, res) => {
  const { ip, token } = req.query; const { on } = req.body;
  try { await nanoleaf(ip, token, 'PUT', '/state', { on: { value: on } }); res.status(200).json({ ok: true }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.put('/api/panels/colour', async (req, res) => {
  const { ip, token } = req.query; const { panelColours } = req.body;
  try {
    const frames   = panelColours.map(p => `${p.id} 1 ${p.r} ${p.g} ${p.b} 0 1`).join(' ');
    const animData = `${panelColours.length} ${frames}`;
    await nanoleaf(ip, token, 'PUT', '/effects', { write: { command: 'display', animType: 'static', animData, loop: false, palette: [] } });
    res.status(200).json({ ok: true });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/api/effects/save', async (req, res) => {
  const { ip, token } = req.query; const { effectName, panelColours } = req.body;
  if (!effectName || !panelColours) return res.status(400).json({ error: 'effectName and panelColours required' });
  try {
    const frames   = panelColours.map(p => `${p.id} 1 ${p.r} ${p.g} ${p.b} 0 1`).join(' ');
    const animData = `${panelColours.length} ${frames}`;
    await nanoleaf(ip, token, 'PUT', '/effects', { write: { command: 'add', animName: effectName, animType: 'static', animData, loop: false, palette: [] } });
    res.status(200).json({ ok: true });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.delete('/api/effects/:name', async (req, res) => {
  const { ip, token } = req.query;
  try { await nanoleaf(ip, token, 'PUT', '/effects', { write: { command: 'delete', animName: req.params.name } }); res.status(200).json({ ok: true }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.put('/api/effects/select', async (req, res) => {
  const { ip, token } = req.query; const { effectName } = req.body;
  try { await nanoleaf(ip, token, 'PUT', '/effects', { select: effectName }); res.status(200).json({ ok: true }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/effects', async (req, res) => {
  const { ip, token } = req.query;
  try { const r = await nanoleaf(ip, token, 'GET', '/effects/effectsList', undefined); res.status(r.status).json(r.body); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/api/identify', async (req, res) => {
  const { ip, token } = req.query;
  try { await nanoleaf(ip, token, 'PUT', '/identify', undefined); res.status(200).json({ ok: true }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/api/auth', async (req, res) => {
  const { ip } = req.query;
  try {
    const r    = await fetch(`http://${ip}:16021/api/v1/new`, { method: 'POST' });
    const body = await r.json();
    res.status(r.status).json(body);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// ── Visualiser process management ─────────────────────────────────────────────
let vizProc = null;
let vizRestartTimer = null;

function getMaConfig() {
  const rows = db.prepare('SELECT key, value FROM ma_config').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function getGlobalSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function buildVizEnv() {
  const ma  = getMaConfig();
  const cfg = getGlobalSettings();
  const clusters = db.prepare('SELECT * FROM clusters WHERE viz_enabled=1').all();

  if (!ma.ma_host || !ma.ma_token || !clusters.length) return null;

  // Pass cluster config as JSON env var
  return {
    ...process.env,
    MA_HOST:      ma.ma_host,
    MA_PORT:      ma.ma_port || '8095',
    MA_TOKEN:     ma.ma_token,
    VIZ_FPS:      cfg.fps || '30',
    CLUSTERS_JSON: JSON.stringify(clusters.map(c => ({
      id:          c.id,
      name:        c.name,
      player_name: c.player_name || c.name,
      ip:          c.ip,
      token:       c.token,
      smoothing:   c.smoothing,
      freq_min:    c.freq_min,
      freq_max:    c.freq_max,
    }))),
    STATUS_FILE,
  };
}

function writeStatus(data) {
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...data, ts: Date.now() })); } catch {}
}

function stopViz() {
  if (vizProc) {
    try { vizProc.kill('SIGTERM'); } catch {}
    vizProc = null;
  }
  if (vizRestartTimer) { clearTimeout(vizRestartTimer); vizRestartTimer = null; }
}

function startViz() {
  stopViz();
  const env = buildVizEnv();
  if (!env) {
    writeStatus({ running: false, error: 'MA not configured or no enabled clusters' });
    return;
  }

  const scriptPath = path.join(__dirname, 'visualiser.py');
  if (!fs.existsSync(scriptPath)) {
    writeStatus({ running: false, error: 'visualiser.py not found' });
    return;
  }

  console.log('[viz] Starting visualiser process');
  writeStatus({ running: true, clusters: [], now_playing: null });

  vizProc = spawn('python3', ['-u', scriptPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  vizProc.stdout.on('data', d => process.stdout.write(`[viz] ${d}`));
  vizProc.stderr.on('data', d => process.stderr.write(`[viz] ${d}`));

  vizProc.on('exit', (code, signal) => {
    console.log(`[viz] Process exited: code=${code} signal=${signal}`);
    vizProc = null;
    writeStatus({ running: false, exit_code: code });
    // Auto-restart after 5s unless deliberately stopped
    if (signal !== 'SIGTERM') {
      vizRestartTimer = setTimeout(startViz, 5000);
    }
  });
}

function restartViz() {
  // Debounce config changes
  if (vizRestartTimer) clearTimeout(vizRestartTimer);
  vizRestartTimer = setTimeout(startViz, 500);
}

// ── Visualiser status API ─────────────────────────────────────────────────────
app.get('/api/viz/status', (req, res) => {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      res.json({ ...data, process_alive: vizProc !== null });
    } else {
      res.json({ running: false, process_alive: false });
    }
  } catch { res.json({ running: false, process_alive: false }); }
});

app.post('/api/viz/start', (req, res) => { startViz(); res.json({ ok: true }); });
app.post('/api/viz/stop',  (req, res) => { stopViz();  writeStatus({ running: false, stopped: true }); res.json({ ok: true }); });
app.post('/api/viz/restart', (req, res) => { restartViz(); res.json({ ok: true }); });

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Nanoleaf Hub running on http://0.0.0.0:${PORT}`);
  // Auto-start visualiser on boot
  setTimeout(startViz, 2000);
});

process.on('SIGTERM', () => { stopViz(); process.exit(0); });
process.on('SIGINT',  () => { stopViz(); process.exit(0); });

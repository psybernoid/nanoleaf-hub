'use strict';

const express  = require('express');
const fetch    = require('node-fetch');
const cors     = require('cors');
const path     = require('path');
const Database = require('better-sqlite3');
const fs       = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'nanoleaf.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS clusters (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT    NOT NULL UNIQUE,
    ip      TEXT    NOT NULL,
    token   TEXT    NOT NULL,
    created INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Cluster CRUD ──────────────────────────────────────────────────────────────
app.get('/api/clusters', (req, res) => {
  res.json(db.prepare('SELECT id, name, ip, token, created FROM clusters ORDER BY name').all());
});

app.post('/api/clusters', (req, res) => {
  const { name, ip, token } = req.body;
  if (!name || !ip || !token) return res.status(400).json({ error: 'name, ip and token are required' });
  try {
    const info = db.prepare('INSERT INTO clusters (name, ip, token) VALUES (?, ?, ?)')
                   .run(name.trim(), ip.trim(), token.trim());
    res.json({ id: info.lastInsertRowid, name, ip, token });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: `A cluster named "${name}" already exists` });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/clusters/:id', (req, res) => {
  const { name, ip, token } = req.body;
  if (!name || !ip || !token) return res.status(400).json({ error: 'name, ip and token are required' });
  try {
    db.prepare('UPDATE clusters SET name=?, ip=?, token=? WHERE id=?')
      .run(name.trim(), ip.trim(), token.trim(), req.params.id);
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: `A cluster named "${name}" already exists` });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/clusters/:id', (req, res) => {
  db.prepare('DELETE FROM clusters WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Nanoleaf proxy helper ─────────────────────────────────────────────────────
async function nl(ip, token, method, path, body) {
  const url  = `http://${ip}:16021/api/v1/${token}${path}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: text || {} }; }
}

// ── Nanoleaf endpoints ────────────────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  const { ip, token } = req.query;
  try { const r = await nl(ip, token, 'GET', '/'); res.status(r.status).json(r.body); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/layout', async (req, res) => {
  const { ip, token } = req.query;
  try { const r = await nl(ip, token, 'GET', '/panelLayout/layout'); res.status(r.status).json(r.body); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/effects', async (req, res) => {
  const { ip, token } = req.query;
  try { const r = await nl(ip, token, 'GET', '/effects/effectsList'); res.status(r.status).json(r.body); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

// Apply a named effect
app.put('/api/effects/select', async (req, res) => {
  const { ip, token } = req.query;
  const { effectName } = req.body;
  try { const r = await nl(ip, token, 'PUT', '/effects', { select: effectName }); res.status(r.status).json({ ok: r.status < 300 }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

// Delete a named effect
app.delete('/api/effects/:name', async (req, res) => {
  const { ip, token } = req.query;
  const name = decodeURIComponent(req.params.name);
  try {
    const r = await nl(ip, token, 'PUT', '/effects', { write: { command: 'delete', animName: name } });
    res.status(r.status).json({ ok: r.status < 300 });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// Push colour layout to device (raw extControl-style via static effect display)
app.put('/api/panels/colour', async (req, res) => {
  const { ip, token } = req.query;
  const { panelColours } = req.body;
  const animData = panelColours.map(p => `${p.id} 1 ${p.r} ${p.g} ${p.b} 0 10`).join(' ');
  const body = { write: { command: 'display', animType: 'static', animData: `${panelColours.length} ${animData}`, loop: false, palette: [] } };
  try { const r = await nl(ip, token, 'PUT', '/effects', body); res.json({ ok: r.status < 300 }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

// Save layout as named effect on device
app.post('/api/effects/save', async (req, res) => {
  const { ip, token } = req.query;
  const { effectName, panelColours } = req.body;
  const animData = panelColours.map(p => `${p.id} 1 ${p.r} ${p.g} ${p.b} 0 10`).join(' ');
  const body = { write: { command: 'add', animName: effectName, animType: 'static', animData: `${panelColours.length} ${animData}`, loop: false, palette: [] } };
  try { const r = await nl(ip, token, 'PUT', '/effects', body); res.json({ ok: r.status < 300 }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.put('/api/power', async (req, res) => {
  const { ip, token } = req.query;
  const { on } = req.body;
  try { const r = await nl(ip, token, 'PUT', '/state', { on: { value: on } }); res.json({ ok: r.status < 300 }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.put('/api/brightness', async (req, res) => {
  const { ip, token } = req.query;
  const { value } = req.body;
  try { const r = await nl(ip, token, 'PUT', '/state', { brightness: { value: parseInt(value) } }); res.json({ ok: r.status < 300 }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/api/identify', async (req, res) => {
  const { ip, token } = req.query;
  try { const r = await nl(ip, token, 'PUT', '/identify', {}); res.json({ ok: r.status < 300 }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

// Token acquisition
app.post('/api/auth', async (req, res) => {
  const { ip } = req.query;
  try {
    const r = await fetch(`http://${ip}:16021/api/v1/new`, { method: 'POST' });
    const body = await r.json();
    res.status(r.status).json(body);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// Generic effect write — passes the body's "write" object directly to the device
// Used by push-to-device (static display), save-as-effect (add), and animation editor
app.put('/api/effect', async (req, res) => {
  const { ip, token } = req.query;
  try { const r = await nl(ip, token, 'PUT', '/effects', req.body); res.status(r.status).json(r.body || { ok: r.status < 300 }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nanoleaf Hub running on http://0.0.0.0:${PORT}`));

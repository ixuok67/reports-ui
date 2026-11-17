#!/usr/bin/env node
'use strict';

// Reader for plain-file reports. A report is any `<YYYY-MM-DD>.md` or `<YYYY-Qn>.md`
// under $REPORTS_HOME; its top-level folder is the kind, any folders between the kind
// and the year are the group (e.g. pr-digest/<repo>/2026/2026-11-16.md). A new kind
// needs no change here: add the folder and it shows up.

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(process.env.REPORTS_HOME || path.join(os.homedir(), 'reports'));
const PORT = Number(process.env.PORT || 4400);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const MARKED = path.join(__dirname, 'node_modules', 'marked', 'lib', 'marked.umd.js');

const REPORT_RE = /^(\d{4}-\d{2}-\d{2}|\d{4}-Q[1-4])\.md$/;
const MAX_DEPTH = 6;
const RESCAN_MS = 2000;

const cache = new Map(); // rel path -> { mtimeMs, size, entry, text }
let entries = [];
let lastScan = 0;
let scanning = null;

function plain(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function describe(text) {
  const lines = text.split('\n');
  let title = '';
  let summary = '';
  let fallback = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!title && /^#\s+/.test(line)) {
      title = plain(line.replace(/^#\s+/, ''));
      continue;
    }
    const focus = line.match(/^\*\*Focus:?\*\*:?\s*(.+)$/i);
    if (focus) {
      summary = plain(focus[1]);
      break;
    }
    if (/^##\s/.test(line)) break; // metadata block ends at the first section
    if (!fallback && !/^[#|>\-=*]/.test(line) && !/^\*\*[^*]+:\*\*/.test(line)) {
      fallback = plain(line);
    }
  }
  summary = summary || fallback;
  if (summary.length > 260) summary = summary.slice(0, 257).trimEnd() + '…';
  return { title, summary };
}

async function walk(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      if (name.startsWith('.') || name === 'node_modules') return;
      const full = path.join(dir, name);
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        return;
      }
      if (st.isDirectory()) return walk(full, depth + 1, out);
      if (depth >= 1 && st.isFile() && REPORT_RE.test(name)) out.push({ full, st });
    }),
  );
}

async function scan() {
  const found = [];
  await walk(ROOT, 0, found);
  const seen = new Set();
  const next = [];
  for (const { full, st } of found) {
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    seen.add(rel);
    let hit = cache.get(rel);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      let text;
      try {
        text = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const parts = rel.split('/');
      const file = parts.pop();
      const kind = parts.shift();
      const group = parts.filter((p) => !/^\d{4}$/.test(p)).join('/');
      hit = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        text,
        lower: text.toLowerCase(),
        entry: {
          path: rel,
          kind,
          group,
          date: file.replace(/\.md$/, ''),
          mtime: Math.round(st.mtimeMs),
          words: text.split(/\s+/).length,
          ...describe(text),
        },
      };
      cache.set(rel, hit);
    }
    next.push(hit.entry);
  }
  for (const rel of cache.keys()) if (!seen.has(rel)) cache.delete(rel);
  next.sort(
    (a, b) =>
      b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind) || a.group.localeCompare(b.group),
  );
  entries = next;
  lastScan = Date.now();
}

function fresh() {
  if (Date.now() - lastScan < RESCAN_MS) return Promise.resolve();
  if (!scanning) scanning = scan().finally(() => (scanning = null));
  return scanning;
}

function search(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const hits = [];
  for (const e of entries) {
    const c = cache.get(e.path);
    if (!c || !terms.every((t) => c.lower.includes(t))) continue;
    const snippets = [];
    let count = 0;
    for (const raw of c.text.split('\n')) {
      // Snippets are shown as plain text, so drop markdown emphasis, code ticks and table pipes.
      const line = raw.replace(/\*\*|__|`/g, '').replace(/\s*\|\s*/g, ' · ').replace(/^[\s·]+|[\s·]+$/g, '');
      const low = line.toLowerCase();
      const at = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0);
      if (!at.length) continue;
      count++;
      if (snippets.length < 3) {
        const start = Math.max(0, Math.min(...at) - 60);
        let s = line.slice(start, start + 220).replace(/^[\s|#>\-*]+/, '').trim();
        if (start > 0) s = '…' + s;
        if (start + 220 < line.length) s += '…';
        if (s) snippets.push(s);
      }
    }
    hits.push({ path: e.path, count, snippets });
  }
  return hits;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Reports quote text from other people's PRs, so nothing in them may run as script.
const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, type) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), MIME['.json']);

async function sendFile(res, file) {
  try {
    const body = await fsp.readFile(file);
    send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/index') {
      await fresh();
      const home = os.homedir();
      const root = ROOT === home || ROOT.startsWith(home + path.sep) ? '~' + ROOT.slice(home.length) : ROOT;
      return json(res, 200, { root, entries });
    }
    if (p === '/api/report') {
      await fresh();
      // Only paths the scan produced are readable, so no traversal outside the index.
      const hit = cache.get(url.searchParams.get('path') || '');
      if (!hit) return json(res, 404, { error: 'No such report' });
      return json(res, 200, { ...hit.entry, markdown: hit.text });
    }
    if (p === '/api/search') {
      await fresh();
      return json(res, 200, { hits: search(url.searchParams.get('q') || '') });
    }
    if (p === '/vendor/marked.js') return sendFile(res, MARKED);

    const file = path.join(PUBLIC, path.normalize(p === '/' ? '/index.html' : p));
    if (!file.startsWith(PUBLIC + path.sep)) {
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    return sendFile(res, file);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`reports-ui: http://${HOST}:${PORT}  (reports root: ${ROOT})`);
});

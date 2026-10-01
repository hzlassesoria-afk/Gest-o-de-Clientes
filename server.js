'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const monday = require('./lib/monday');
const { createStore } = require('./lib/store');
const { applyDemo, clearDemo } = require('./lib/demo');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

// ---------- persistência ----------
const store = createStore(DATA_DIR);
const loadDb = () => store.load();
const saveDb = (db) => store.save(db);

const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- helpers HTTP ----------
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(Object.assign(new Error('Corpo muito grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_FIELDS = new Set([
  'investimento', 'leads', 'leadsQualificados', 'leadsResponderam', 'cotacoes', 'pararamResponder',
  'negociacoes', 'vendas', 'receita', 'mrr', 'faturado', 'inadimplente', 'dinheiroColetado', 'nps',
  'healthScore', 'reclamacoes', 'contatosCliente', 'reunioesRealizadas', 'reunioesPlanejadas',
  'contatosEspontaneos', 'observacoes',
]);

/** Mantém só campos conhecidos; números vazios viram null. */
function cleanMonth(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!METRIC_FIELDS.has(k)) continue;
    if (k === 'observacoes') { out[k] = String(v || '').slice(0, 2000); continue; }
    if (v === '' || v == null) { out[k] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n)) throw Object.assign(new Error(`Valor inválido em "${k}"`), { status: 400 });
    out[k] = n;
  }
  return out;
}

function cleanProject(input) {
  const out = {};
  for (const k of ['startDate', 'contractDate', 'campaignStartDate', 'firstSaleDate']) {
    if (!(k in input)) continue;
    const v = input[k];
    if (v === '' || v == null) out[k] = null;
    else if (DATE_RE.test(v)) out[k] = v;
    else throw Object.assign(new Error(`Data inválida em "${k}" (use AAAA-MM-DD)`), { status: 400 });
  }
  for (const k of ['mrr', 'roasTarget']) {
    if (!(k in input)) continue;
    const v = input[k];
    if (v === '' || v == null) out[k] = null;
    else if (Number.isFinite(Number(v))) out[k] = Number(v);
    else throw Object.assign(new Error(`Valor inválido em "${k}"`), { status: 400 });
  }
  if ('cacIncludesFee' in input) out.cacIncludesFee = !!input.cacIncludesFee;
  return out;
}

// ---------- rotas ----------
async function handleApi(req, res, url) {
  // Na Vercel, o rewrite entrega a rota original em ?p=<caminho>
  const route = url.searchParams.get('p');
  const parts = route != null
    ? route.split('/').filter(Boolean)
    : url.pathname.split('/').filter(Boolean).slice(1); // remove "api"
  const db = await loadDb();

  if (parts[0] !== 'clients') return send(res, 404, { error: 'Rota não encontrada' });

  // /api/clients
  if (parts.length === 1) {
    if (req.method === 'GET') {
      return send(res, 200, db.clients.map(({ id, name, segment }) => ({ id, name, segment })));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: 'Informe o nome do cliente' });
      const id = slugify(name);
      if (!id) return send(res, 400, { error: 'Nome inválido' });
      if (db.clients.some((c) => c.id === id)) return send(res, 409, { error: 'Já existe um cliente com esse nome' });
      const client = {
        id, name, segment: String(body.segment || '').trim(),
        project: { cacIncludesFee: true },
        months: {},
        monday: { boardName: 'Entrada de Clientes', itemName: name },
      };
      db.clients.push(client);
      await saveDb(db);
      return send(res, 201, client);
    }
    return send(res, 405, { error: 'Método não permitido' });
  }

  const client = db.clients.find((c) => c.id === parts[1]);
  if (!client) return send(res, 404, { error: 'Cliente não encontrado' });

  // /api/clients/:id
  if (parts.length === 2) {
    if (req.method === 'GET') return send(res, 200, { ...client, mondayConfigured: !!process.env.MONDAY_API_TOKEN });
    return send(res, 405, { error: 'Método não permitido' });
  }

  // /api/clients/:id/project
  if (parts[2] === 'project' && req.method === 'PUT') {
    client.project = { ...client.project, ...cleanProject(await readBody(req)) };
    await saveDb(db);
    return send(res, 200, client);
  }

  // /api/clients/:id/months/:YYYY-MM
  if (parts[2] === 'months' && parts[3]) {
    if (!MONTH_RE.test(parts[3])) return send(res, 400, { error: 'Mês inválido (use AAAA-MM)' });
    if (req.method === 'PUT') {
      const merged = { ...client.months[parts[3]], ...cleanMonth(await readBody(req)) };
      delete merged._demo; // editado pelo usuário: passa a valer como dado real
      client.months[parts[3]] = merged;
      await saveDb(db);
      return send(res, 200, client);
    }
    if (req.method === 'DELETE') {
      delete client.months[parts[3]];
      await saveDb(db);
      return send(res, 200, client);
    }
  }

  // /api/clients/:id/monday/sync  (?apply=1 aplica as sugestões ao projeto)
  // /api/clients/:id/demo  (POST carrega dados simulados, DELETE limpa só os simulados)
  if (parts[2] === 'demo' && parts.length === 3) {
    if (req.method === 'POST') {
      const result = applyDemo(client);
      await saveDb(db);
      return send(res, 200, { client, ...result });
    }
    if (req.method === 'DELETE') {
      const result = clearDemo(client);
      await saveDb(db);
      return send(res, 200, { client, ...result });
    }
    return send(res, 405, { error: 'Método não permitido' });
  }

  if (parts[2] === 'monday' && parts[3] === 'sync' && req.method === 'POST') {
    try {
      const { board, snapshot, suggested } = await monday.syncClient(client, { token: process.env.MONDAY_API_TOKEN });
      client.monday = { ...client.monday, board, snapshot, syncedAt: new Date().toISOString(), error: null };
      const applied = [];
      for (const [key, { value, from }] of Object.entries(suggested)) {
        // Não sobrescreve o que já foi preenchido manualmente
        if (client.project[key] == null) { client.project[key] = value; applied.push({ key, value, from }); }
      }
      await saveDb(db);
      return send(res, 200, { client, applied, suggested });
    } catch (err) {
      client.monday = { ...client.monday, error: err.message, syncedAt: new Date().toISOString() };
      await saveDb(db);
      return send(res, 502, { error: err.message });
    }
  }

  return send(res, 404, { error: 'Rota não encontrada' });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA: qualquer rota sem arquivo devolve o index
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    send(res, err.status || 500, { error: err.message || 'Erro interno' });
  }
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Gestão de Clientes rodando em http://localhost:${PORT}`));
}

module.exports = { server, handler, cleanMonth, cleanProject };

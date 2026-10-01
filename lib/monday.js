'use strict';
/*
 * Sincronização com o quadro "Entrada de Clientes" do Monday (API GraphQL).
 * Precisa da variável de ambiente MONDAY_API_TOKEN (Monday → Avatar → Developers → My access tokens).
 */

const API_URL = 'https://api.monday.com/v2';
const API_VERSION = '2024-10';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function gql(query, variables, { token, fetchImpl = fetch }) {
  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': API_VERSION },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    const msg = (body.errors && body.errors.map((e) => e.message).join('; ')) || `HTTP ${res.status}`;
    throw new Error(`Monday: ${msg}`);
  }
  return body.data;
}

async function findBoard(boardName, ctx) {
  for (let page = 1; page <= 10; page++) {
    const data = await gql(
      'query($page:Int){ boards(limit:100, page:$page, state:active){ id name } }',
      { page }, ctx,
    );
    if (!data.boards.length) break;
    const hit = data.boards.find((b) => norm(b.name) === norm(boardName))
      || data.boards.find((b) => norm(b.name).includes(norm(boardName)));
    if (hit) return hit;
  }
  throw new Error(`Quadro "${boardName}" não encontrado no Monday (o token tem acesso a ele?).`);
}

async function fetchItems(boardId, ctx) {
  const items = [];
  let columns = [];
  let cursor = null;
  do {
    const q = cursor
      ? 'query($c:String!){ next_items_page(limit:100, cursor:$c){ cursor items{ id name group{title} column_values{ id text type } } } }'
      : 'query($id:[ID!]){ boards(ids:$id){ columns{ id title type } items_page(limit:100){ cursor items{ id name group{title} column_values{ id text type } } } } }';
    const data = await gql(q, cursor ? { c: cursor } : { id: [String(boardId)] }, ctx);
    const page = cursor ? data.next_items_page : data.boards[0].items_page;
    if (!cursor) columns = data.boards[0].columns;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return { columns, items };
}

/** Converte um item do Monday em { campos: [{title,type,text}], ... } legível. */
function toSnapshot(item, columns) {
  const byId = Object.fromEntries(columns.map((c) => [c.id, c]));
  return {
    id: item.id,
    name: item.name,
    group: item.group && item.group.title,
    fields: item.column_values
      .map((cv) => ({ id: cv.id, title: (byId[cv.id] || {}).title || cv.id, type: cv.type, text: cv.text || '' }))
      .filter((f) => f.text !== ''),
  };
}

// Dicas p/ preencher automaticamente campos do projeto a partir dos títulos das colunas do Monday.
const FIELD_HINTS = {
  mrr: [/\bmrr\b/, /mensalidade/, /valor (do )?(contrato|mensal)/, /fee/, /ticket mensal/],
  contractDate: [/(data|dt).*(contrato|assinatura|fechamento)/, /assinatura/, /fechamento/],
  startDate: [/(data|dt).*(inicio|início|entrada|onboarding)/, /^entrada$/, /inicio do projeto/],
  campaignStartDate: [/(inicio|início|subida|go.?live|ativacao|ativação).*(campanha|anuncio|anúncio)/, /campanha.*(no ar|ativa)/],
};

function parseMoney(text) {
  const cleaned = String(text).replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const n = cleaned.includes(',') ? Number(cleaned.replace(/\./g, '').replace(',', '.')) : Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDate(text) {
  const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})/) || String(text).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Sugere valores do projeto a partir dos campos do Monday.
 * `fieldMap` (opcional, no cliente) força colunas: { mrr: 'Título da coluna', ... }.
 */
function suggestProject(snapshot, fieldMap = {}) {
  const out = {};
  for (const [key, hints] of Object.entries(FIELD_HINTS)) {
    const forced = fieldMap[key] && snapshot.fields.find((f) => norm(f.title) === norm(fieldMap[key]));
    const field = forced || snapshot.fields.find((f) => hints.some((re) => re.test(norm(f.title))));
    if (!field) continue;
    const value = key === 'mrr' ? parseMoney(field.text) : parseDate(field.text);
    if (value != null) out[key] = { value, from: field.title };
  }
  return out;
}

async function syncClient(client, { token, fetchImpl } = {}) {
  if (!token) throw new Error('MONDAY_API_TOKEN não configurado no servidor.');
  const cfg = client.monday || {};
  const ctx = { token, fetchImpl };
  const board = await findBoard(cfg.boardName || 'Entrada de Clientes', ctx);
  const { columns, items } = await fetchItems(board.id, ctx);

  const target = norm(cfg.itemName || client.name);
  const item = items.find((i) => norm(i.name) === target) || items.find((i) => norm(i.name).includes(target));
  if (!item) throw new Error(`Item "${cfg.itemName || client.name}" não encontrado no quadro "${board.name}" (${items.length} itens lidos).`);

  const snapshot = toSnapshot(item, columns);
  return { board: { id: board.id, name: board.name }, snapshot, suggested: suggestProject(snapshot, cfg.fieldMap) };
}

module.exports = { syncClient, suggestProject, toSnapshot, parseMoney, parseDate };

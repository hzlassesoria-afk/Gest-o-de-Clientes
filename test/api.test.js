'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
delete process.env.MONDAY_API_TOKEN;
const { server } = require('../server');

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const call = async (p, method = 'GET', body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('Petra Seguros vem cadastrada', async () => {
  const r = await call('/api/clients');
  assert.deepEqual(r.body.map((c) => c.id), ['petra-seguros']);
});

test('salva e apaga mês, rejeitando lixo', async () => {
  let r = await call('/api/clients/petra-seguros/months/2026-09', 'PUT', { leads: '120', vendas: '', hack: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.months['2026-09'], { leads: 120, vendas: null });
  r = await call('/api/clients/petra-seguros/months/2026-09', 'PUT', { leads: 'abc' });
  assert.equal(r.status, 400);
  r = await call('/api/clients/petra-seguros/months/setembro', 'PUT', {});
  assert.equal(r.status, 400);
  r = await call('/api/clients/petra-seguros/months/2026-09', 'DELETE');
  assert.deepEqual(r.body.months, {});
});

test('dados do projeto validam datas', async () => {
  let r = await call('/api/clients/petra-seguros/project', 'PUT', { contractDate: '2026-02-10', mrr: '1500' });
  assert.equal(r.body.project.contractDate, '2026-02-10');
  assert.equal(r.body.project.mrr, 1500);
  r = await call('/api/clients/petra-seguros/project', 'PUT', { contractDate: '10/02/2026' });
  assert.equal(r.status, 400);
});

test('cria cliente e impede duplicado', async () => {
  let r = await call('/api/clients', 'POST', { name: 'Açaí & Cia' });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 'acai-cia');
  r = await call('/api/clients', 'POST', { name: 'Açaí & Cia' });
  assert.equal(r.status, 409);
});

test('sync sem token devolve 502 e registra o erro', async () => {
  const r = await call('/api/clients/petra-seguros/monday/sync', 'POST');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /MONDAY_API_TOKEN/);
  const c = await call('/api/clients/petra-seguros');
  assert.match(c.body.monday.error, /MONDAY_API_TOKEN/);
});

test('não vaza arquivos fora de /public', async () => {
  const res = await fetch(base + '/..%2fserver.js');
  assert.notEqual(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('rota vinda do rewrite da Vercel (?p=) funciona igual', async () => {
  const r = await call('/api/index?p=clients/petra-seguros');
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 'petra-seguros');
});

test('dados simulados: carrega, não sobrescreve dado real, e limpa só o simulado', async () => {
  await call('/api/clients/petra-seguros/months/2026-08', 'PUT', { leads: 999 }); // mês "real"
  let r = await call('/api/clients/petra-seguros/demo', 'POST');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.addedMonths, ['2026-06', '2026-07', '2026-09']); // 08 já existia
  assert.equal(r.body.client.months['2026-08'].leads, 999);
  assert.equal(r.body.client.months['2026-09']._demo, true);
  assert.equal(r.body.client.project.roasTarget, 6);
  assert.equal(r.body.client.project.contractDate, '2026-02-10'); // não sobrescreveu o que o usuário já tinha

  // editar um mês simulado o torna real
  r = await call('/api/clients/petra-seguros/months/2026-07', 'PUT', { leads: 170 });
  assert.equal(r.body.months['2026-07']._demo, undefined);

  r = await call('/api/clients/petra-seguros/demo', 'DELETE');
  assert.deepEqual(r.body.removedMonths.sort(), ['2026-06', '2026-09']);
  assert.ok(r.body.client.months['2026-07'] && r.body.client.months['2026-08']);
  assert.equal(r.body.client.project.contractDate, '2026-02-10');
  assert.equal(r.body.client.project.roasTarget, null); // era do demo e continuava igual
});

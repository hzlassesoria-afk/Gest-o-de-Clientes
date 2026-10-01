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

test('metas: cria plano do mês, lança realizado do dia e valida entradas', async () => {
  const base = '/api/clients/petra-seguros/goals/2027-02';
  // sem plano, não dá para lançar realizado
  let r = await call(`${base}/days/2027-02-01`, 'PUT', { vendas: 1 });
  assert.equal(r.status, 404);

  r = await call(base, 'PUT', { meta: { investimento: '4000', cpl: 20, vendas: 10, hack: 1 }, naoUteis: ['2027-02-03'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.goals['2027-02'].meta, { investimento: 4000, cpl: 20, vendas: 10 });
  assert.deepEqual(r.body.goals['2027-02'].naoUteis, ['2027-02-03']);

  // atualizar a meta preserva o que já estava e o realizado
  r = await call(`${base}/days/2027-02-01`, 'PUT', { vendas: '2', leads: 15, lixo: 9 });
  assert.deepEqual(r.body.goals['2027-02'].days['2027-02-01'], { vendas: 2, leads: 15 });
  r = await call(base, 'PUT', { meta: { cotacoes: 40 }, compensarExcedente: true });
  assert.equal(r.body.goals['2027-02'].meta.vendas, 10);
  assert.equal(r.body.goals['2027-02'].meta.cotacoes, 40);
  assert.equal(r.body.goals['2027-02'].compensarExcedente, true);
  assert.equal(r.body.goals['2027-02'].days['2027-02-01'].vendas, 2);

  // validações
  assert.equal((await call(`${base}/days/2027-03-01`, 'PUT', { vendas: 1 })).status, 400); // fora do mês
  assert.equal((await call(`${base}/days/2027-02-30`, 'PUT', { vendas: 1 })).status, 400); // data inexistente
  assert.equal((await call(`${base}/days/2027-02-02`, 'PUT', { vendas: -1 })).status, 400);
  assert.equal((await call(`${base}/days/2027-02-02`, 'PUT', { vendas: 'x' })).status, 400);
  assert.equal((await call(base, 'PUT', { naoUteis: ['2027-03-03'] })).status, 400);
  assert.equal((await call('/api/clients/petra-seguros/goals/fev', 'PUT', {})).status, 400);

  // limpar todos os campos do dia remove o dia
  r = await call(`${base}/days/2027-02-01`, 'PUT', { vendas: '', leads: '' });
  assert.equal(r.body.goals['2027-02'].days['2027-02-01'], undefined);

  r = await call(base, 'DELETE');
  assert.equal(r.body.goals['2027-02'], undefined);
});

test('metas: meta por número, porcentagem ou custo é validada e substitui a anterior', async () => {
  const base = '/api/clients/petra-seguros/goals/2027-03';
  let r = await call(base, 'PUT', { meta: { investimento: '6000', itens: {
    leads: { modo: 'custo', valor: '30' }, leadsQualificados: { modo: 'taxa', valor: 40 },
    cotacoes: { modo: 'numero', valor: 40 }, vendas: { modo: 'custo', valor: 600 }, lixo: { modo: 'x', valor: 1 },
  } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.goals['2027-03'].meta, { investimento: 6000, itens: {
    leads: { modo: 'custo', valor: 30 }, leadsQualificados: { modo: 'taxa', valor: 40 },
    cotacoes: { modo: 'numero', valor: 40 }, vendas: { modo: 'custo', valor: 600 },
  } });
  // modo que a etapa não aceita, porcentagem acima de 100 e valor negativo
  assert.equal((await call(base, 'PUT', { meta: { itens: { leads: { modo: 'taxa', valor: 10 } } } })).status, 400);
  assert.equal((await call(base, 'PUT', { meta: { itens: { vendas: { modo: 'taxa', valor: 120 } } } })).status, 400);
  assert.equal((await call(base, 'PUT', { meta: { itens: { vendas: { modo: 'custo', valor: -1 } } } })).status, 400);
  // salvar de novo no formato novo substitui (não sobra etapa antiga)
  r = await call(base, 'PUT', { meta: { investimento: 100, itens: { vendas: { modo: 'numero', valor: 3 } } } });
  assert.deepEqual(r.body.goals['2027-03'].meta, { investimento: 100, itens: { vendas: { modo: 'numero', valor: 3 } } });
  await call(base, 'DELETE');
});

test('metas: pessoas só aceitam número inteiro (realizado e meta por número), dinheiro aceita centavos', async () => {
  const base = '/api/clients/petra-seguros/goals/2027-04';
  let r = await call(base, 'PUT', { meta: { investimento: 1000.5, itens: { vendas: { modo: 'numero', valor: 10 } } } });
  assert.equal(r.status, 200);
  assert.equal((await call(base, 'PUT', { meta: { itens: { vendas: { modo: 'numero', valor: 2.5 } } } })).status, 400);
  assert.equal((await call(base, 'PUT', { meta: { itens: { vendas: { modo: 'taxa', valor: 12.5 } } } })).status, 200); // % pode ter casa decimal
  assert.equal((await call(base, 'PUT', { meta: { itens: { vendas: { modo: 'custo', valor: 99.9 } } } })).status, 200);  // custo também
  assert.equal((await call(`${base}/days/2027-04-01`, 'PUT', { vendas: 1.5 })).status, 400);
  assert.equal((await call(`${base}/days/2027-04-01`, 'PUT', { leads: 0.5 })).status, 400);
  r = await call(`${base}/days/2027-04-01`, 'PUT', { investimento: 123.45, vendas: 2, leads: '7' });
  assert.deepEqual(r.body.goals['2027-04'].days['2027-04-01'], { investimento: 123.45, vendas: 2, leads: 7 });
  await call(base, 'DELETE');
});

test('metas: guarda faturamento e valor médio por venda junto da meta', async () => {
  const base = '/api/clients/petra-seguros/goals/2027-03';
  const meta = { investimento: 5000, faturamento: 100000, ticketVenda: 1500, itens: { leads: { modo: 'custo', valor: 35 } } };
  let r = await call(base, 'PUT', { meta });
  assert.equal(r.status, 200);
  assert.equal(r.body.goals['2027-03'].meta.faturamento, 100000);
  assert.equal(r.body.goals['2027-03'].meta.ticketVenda, 1500);
  r = await call(base, 'PUT', { meta: { ...meta, faturamento: -1 } });
  assert.equal(r.status, 400);
  await call(base, 'DELETE');
});

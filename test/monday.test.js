'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const monday = require('../lib/monday');

function fakeFetch(calls) {
  return async (url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    calls.push({ query, variables, auth: opts.headers.Authorization });
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (query.includes('boards(limit')) return ok({ boards: [{ id: '1', name: 'Outro' }, { id: '99', name: 'Entrada de Clientes' }] });
    if (query.includes('next_items_page')) {
      return ok({ next_items_page: { cursor: null, items: [
        { id: '12', name: 'Petra Seguros', group: { title: 'Ativos' }, column_values: [
          { id: 'mrr', type: 'numbers', text: 'R$ 2.500,50' },
          { id: 'dt', type: 'date', text: '2026-03-10' },
          { id: 'x', type: 'text', text: '' }] },
      ] } });
    }
    return ok({ boards: [{ columns: [{ id: 'mrr', title: 'Valor Mensalidade', type: 'numbers' }, { id: 'dt', title: 'Data de assinatura do contrato', type: 'date' }, { id: 'x', title: 'Vazio', type: 'text' }],
      items_page: { cursor: 'abc', items: [{ id: '11', name: 'Outro cliente', group: { title: 'Ativos' }, column_values: [] }] } }] });
  };
}

test('sincroniza: acha quadro, pagina, acha item e sugere campos', async () => {
  const calls = [];
  const r = await monday.syncClient({ name: 'Petra Seguros', monday: { boardName: 'entrada de clientes' } }, { token: 'tok', fetchImpl: fakeFetch(calls) });
  assert.equal(r.board.id, '99');
  assert.equal(r.snapshot.name, 'Petra Seguros');
  assert.equal(r.snapshot.fields.length, 2); // campo vazio descartado
  assert.equal(r.suggested.mrr.value, 2500.5);
  assert.equal(r.suggested.contractDate.value, '2026-03-10');
  assert.ok(calls.every((c) => c.auth === 'tok'));
});

test('sem token, falha com mensagem clara', async () => {
  await assert.rejects(() => monday.syncClient({ name: 'X' }, {}), /MONDAY_API_TOKEN/);
});

test('item inexistente informa quantos itens foram lidos', async () => {
  await assert.rejects(
    () => monday.syncClient({ name: 'Não existe' }, { token: 't', fetchImpl: fakeFetch([]) }),
    /não encontrado/,
  );
});

test('parseMoney / parseDate', () => {
  assert.equal(monday.parseMoney('R$ 1.234,56'), 1234.56);
  assert.equal(monday.parseMoney('1500'), 1500);
  assert.equal(monday.parseDate('25/12/2026'), '2026-12-25');
  assert.equal(monday.parseDate('lixo'), null);
});

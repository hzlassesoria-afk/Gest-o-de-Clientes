'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Goals = require('../public/goals');
const GoalChart = require('../public/goalchart');

const plan = {
  meta: { investimento: 4000, itens: { leads: { modo: 'numero', valor: 200 }, vendas: { modo: 'custo', valor: 400 } } },
  naoUteis: [],
  days: {
    '2027-02-01': { investimento: 200, leads: 10, vendas: 1 },
    '2027-02-02': { investimento: 220, leads: 12, vendas: 0 },
    '2027-02-03': { investimento: 180, leads: 9, vendas: 2 },
  },
};
const res = Goals.compute('2027-02', plan, '2027-02-04');
const fv = (row, v) => (row.fmt === 'brl' ? 'R$ ' + v.toFixed(2) : String(v));

test('um ponto por dia útil, com meta e realizado do dia', () => {
  const { points } = GoalChart.points(res, plan, 'vendas', 'dia');
  assert.equal(points.length, 20);
  assert.equal(points[0].real, 1);
  assert.equal(points[1].real, 0);
  assert.equal(points[5].real, null); // sem lançamento
  assert.ok(points.every((p) => p.meta == null || Number.isInteger(p.meta)));
});

test('acumulado: realizado soma só o que foi lançado e a meta-base fecha no total do mês', () => {
  const { points } = GoalChart.points(res, plan, 'vendas', 'acum');
  assert.deepEqual(points.slice(0, 3).map((p) => p.real), [1, 1, 3]);
  assert.equal(points[19].meta, res.rows.vendas.meta); // 400 → 10 vendas
  for (let i = 1; i < points.length; i++) assert.ok(points[i].meta >= points[i - 1].meta);
  const withReal = points.filter((p) => p.real != null).map((p) => p.real);
  for (let i = 1; i < withReal.length; i++) assert.ok(withReal[i] >= withReal[i - 1]);
});

test('linha de custo: razão do dia e razão acumulada (não média das razões)', () => {
  const dia = GoalChart.points(res, plan, 'cpl', 'dia').points;
  assert.equal(dia[0].real, 20);                 // 200 ÷ 10
  const acum = GoalChart.points(res, plan, 'cpl', 'acum').points;
  assert.equal(acum[2].real, 600 / 31);          // (200+220+180) ÷ (10+12+9)
  assert.equal(dia[0].meta, 20);                 // teto = 4000 ÷ 200
});

test('SVG sai completo, sem NaN, e funciona para cada métrica nos dois modos', () => {
  for (const mode of ['dia', 'acum']) {
    for (const row of res.rowDefs) {
      const html = GoalChart.build({ res, plan, key: row.key, mode, fmtVal: fv });
      assert.ok(html.includes('<svg'), row.key);
      assert.ok(!/NaN|undefined|Infinity/.test(html), `${row.key}/${mode}`);
    }
  }
  const dia = GoalChart.build({ res, plan, key: 'vendas', mode: 'dia', fmtVal: fv });
  assert.equal((dia.match(/class="gc-bar"/g) || []).length, 3); // só os dias lançados têm barra
  assert.equal((dia.match(/class="gc-meta"/g) || []).length, 20);
});

test('mês sem lançamentos e sem metas não quebra', () => {
  const vazio = { meta: {}, days: {} };
  const r = Goals.compute('2027-02', vazio, '2027-02-01');
  const html = GoalChart.build({ res: r, plan: vazio, key: 'vendas', mode: 'dia', fmtVal: fv });
  assert.ok(html.includes('<svg') && !/NaN|Infinity/.test(html));
});

test('passo do eixo é redondo', () => {
  assert.equal(GoalChart.niceStep(4), 1);
  assert.equal(GoalChart.niceStep(10), 2.5);
  assert.equal(GoalChart.niceStep(40), 10);
  assert.equal(GoalChart.niceStep(100), 25);
  assert.equal(GoalChart.niceStep(1000), 250);
});

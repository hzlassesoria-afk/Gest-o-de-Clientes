'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Metrics = require('../public/metrics');

const client = {
  project: { startDate: '2026-01-01', contractDate: '2026-01-05', campaignStartDate: '2026-01-15', firstSaleDate: '2026-02-04', mrr: 1000, roasTarget: 5, cacIncludesFee: true },
  months: {
    '2026-08': { investimento: 2000, leads: 100, leadsQualificados: 40, leadsResponderam: 30, cotacoes: 20, pararamResponder: 8, negociacoes: 6, vendas: 4, receita: 12000,
      faturado: 5000, inadimplente: 500, nps: 80, reclamacoes: 1, contatosCliente: 20, reunioesRealizadas: 3, reunioesPlanejadas: 4, contatosEspontaneos: 8, dinheiroColetado: 4500 },
    '2026-09': { investimento: 3000, leads: 200, vendas: 6, receita: 18000, nps: 60 },
  },
};

test('razões de um mês', () => {
  const m = Metrics.compute(client, ['2026-08'], '2026-10-01');
  assert.equal(m.cpl, 20);
  assert.equal(m.cplQualificado, 50);
  assert.equal(m.ticketMedio, 3000);
  assert.equal(m.roas, 6);
  assert.equal(m.cac, (2000 + 1000) / 4); // inclui mensalidade
  assert.equal(m.taxaInadimplencia, 10);
  assert.equal(m.indiceReclamacao, 5);
  assert.equal(m.aderenciaReunioes, 0.75);
  assert.equal(m.dinheiroColetado, 4500);
});

test('acumulado soma brutos e recalcula razões (não faz média de médias)', () => {
  const m = Metrics.compute(client, ['2026-08', '2026-09'], '2026-10-01');
  assert.equal(m.investimento, 5000);
  assert.equal(m.leads, 300);
  assert.equal(m.cpl, 5000 / 300);
  assert.equal(m.roas, 30000 / 5000);
  assert.equal(m.nps, 70);
  assert.equal(m.cac, (5000 + 2000) / 10);
});

test('CAC sem mensalidade quando configurado', () => {
  const c = { ...client, project: { ...client.project, cacIncludesFee: false } };
  assert.equal(Metrics.compute(c, ['2026-08']).cac, 500);
});

test('dados ausentes viram null, nunca NaN/Infinity', () => {
  const m = Metrics.compute({ project: {}, months: { '2026-09': {} } }, ['2026-09']);
  for (const k of ['cpl', 'cplQualificado', 'roas', 'cac', 'ticketMedio', 'taxaInadimplencia', 'nps', 'healthScore']) {
    assert.equal(m[k], null, k);
  }
  const z = Metrics.compute({ project: {}, months: { a: { investimento: 100, leads: 0, vendas: 0 } } }, ['a']);
  assert.equal(z.cpl, null);
  assert.equal(z.cac, null);
});

test('time to value e tempo de projeto', () => {
  const m = Metrics.compute(client, ['2026-08'], '2026-04-01');
  assert.equal(m.timeToValueCampanhaDias, 10);
  assert.equal(m.timeToValuePrimeiraVendaDias, 20);
  assert.equal(m.timeToValueContratoPrimeiraVendaDias, 30);
  assert.ok(Math.abs(m.tempoProjetoMeses - 3) < 0.1);
});

test('nível de ansiedade pelos contatos espontâneos por semana', () => {
  assert.equal(Metrics.anxietyLevel(1), 'Baixo');
  assert.equal(Metrics.anxietyLevel(4), 'Médio');
  assert.equal(Metrics.anxietyLevel(9), 'Alto');
  assert.equal(Metrics.compute(client, ['2026-08']).nivelAnsiedade, 'Baixo'); // 8 / 4.33 ≈ 1.8
});

test('health score: calculado, faixa e override manual', () => {
  const auto = Metrics.compute(client, ['2026-08']);
  assert.ok(auto.healthScore >= 0 && auto.healthScore <= 100);
  assert.equal(auto.healthScoreManual, false);
  assert.ok(auto.healthScoreAuto.parts.some((p) => p.key === 'ROAS vs meta'));

  const manual = Metrics.compute({ ...client, months: { x: { healthScore: 42 } } }, ['x']);
  assert.equal(manual.healthScore, 42);
  assert.equal(manual.healthBand, 'Risco');
});

test('funil: % da etapa anterior pula etapas vazias', () => {
  const m = Metrics.compute(client, ['2026-09']);
  const vendas = m.funil.find((s) => s.label === 'Vendas');
  assert.equal(vendas.pctOfLeads, 6 / 200);
  assert.equal(vendas.pctOfPrev, 6 / 200); // anteriores vazias => compara com leads
});

test('variação mês a mês: relativa, absoluta e direção boa/ruim', () => {
  const D = Metrics.INDICATOR_BY_KEY;
  let c = Metrics.change(120, 100, D.leads);
  assert.equal(c.value, 20); assert.equal(c.tone, 'good'); assert.equal(c.dir, 'up');
  c = Metrics.change(30, 25, D.cpl); // custo subiu = ruim
  assert.equal(c.tone, 'bad');
  c = Metrics.change(20, 25, D.cpl); // custo caiu = bom
  assert.equal(c.tone, 'good'); assert.equal(c.dir, 'down');
  c = Metrics.change(4500, 4000, D.investimento); // neutro
  assert.equal(c.tone, 'flat'); assert.equal(c.dir, 'up');
  c = Metrics.change(8, 10, D.taxaInadimplencia); // 10% -> 8%: -2 p.p., bom
  assert.equal(c.value, -2); assert.equal(c.tone, 'good'); assert.equal(c.unit, 'p.p.');
  c = Metrics.change(80, 70, D.nps);
  assert.equal(c.value, 10); assert.equal(c.tone, 'good');
  assert.equal(Metrics.change(5, 0, D.leads), null);           // % sobre zero
  assert.equal(Metrics.change(0, 5, D.leads).value, -100);
  assert.equal(Metrics.change(null, 5, D.leads), null);
  assert.equal(Metrics.change(5, null, D.leads), null);
  assert.equal(Metrics.change(7, 7, D.leads).tone, 'flat');
  assert.equal(Metrics.change(3, 0, D.taxaInadimplencia).value, 3); // abs funciona com prev=0
});

test('toda chave dos indicadores existe no resultado de compute()', () => {
  const m = Metrics.compute(client, ['2026-08'], '2026-10-01');
  for (const g of Metrics.INDICATORS) for (const d of g.items) assert.ok(d.key in m, d.key);
  assert.equal(m.aderenciaReunioesPct, 75);
});

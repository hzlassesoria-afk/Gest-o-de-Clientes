'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Goals = require('../public/goals');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} esperado ${b}, veio ${a}`);

// Fevereiro/2027: 1º é segunda, 28 dias, 20 dias úteis, exatamente 4 semanas (sem feriado nacional)
const FEV = '2027-02';
const goal = (extra = {}) => ({
  meta: { investimento: 4000, cpl: 20, cplQualificado: 50, cotacoes: 40, negociacoes: 20, vendas: 10 },
  naoUteis: [], days: {}, ...extra,
});
const day = (w, i, r) => r.weeks[w].days[i];

test('feriados: Páscoa e Sexta-feira Santa corretas', () => {
  assert.equal(Goals.holidays(2026)['2026-04-03'], 'Sexta-feira Santa'); // Páscoa 05/04/2026
  assert.equal(Goals.holidays(2027)['2027-03-26'], 'Sexta-feira Santa'); // Páscoa 28/03/2027
});

test('folgas padrão: só feriados em dia de semana', () => {
  assert.deepEqual(Goals.defaultOffDays('2026-10'), ['2026-10-12']); // 12/10 é segunda
  assert.deepEqual(Goals.defaultOffDays('2026-11'), ['2026-11-02', '2026-11-20']); // 15/11 é domingo
});

test('calendário: semanas seg-sex, primeira semana parcial', () => {
  const r = Goals.compute('2026-10', { meta: {}, days: {} }, '2026-10-01');
  assert.equal(r.workingDays, 21); // 22 dias de semana − feriado 12/10
  assert.equal(r.weeks.length, 5);
  assert.equal(r.weeks[0].workingDays, 2); // qui 01 e sex 02
  assert.equal(r.weeks[0].days[0].inMonth, false); // segunda é de setembro
  assert.equal(r.weeks[2].days[0].working, false); // 12/10 feriado
  assert.equal(r.weeks[4].workingDays, 5);
});

test('meta mensal se divide igualmente por dias úteis quando nada foi lançado (futuro)', () => {
  const r = Goals.compute(FEV, goal(), '2027-02-01');
  assert.equal(r.workingDays, 20);
  assert.equal(r.weeks.length, 4);
  near(r.weeks[0].rows.vendas.meta, 2.5);
  near(day(0, 0, r).rows.vendas.meta, 0.5);
  near(day(3, 4, r).rows.investimento.meta, 200);
  near(day(2, 1, r).rows.cotacoes.meta, 2);
  // metas derivadas: leads = investimento ÷ CPL ; qualificados = investimento ÷ CPLQ
  near(r.rows.leads.meta, 200);
  near(r.rows.leadsQualificados.meta, 80);
  // custo é teto: igual em todos os níveis
  assert.equal(r.rows.cpl.meta, 20);
  assert.equal(day(1, 3, r).rows.cplQualificado.meta, 50);
});

test('não bateu a meta do dia 01 → a meta do dia 02 sobe', () => {
  const g = goal({ days: { '2027-02-01': { vendas: 0 } } });
  const r = Goals.compute(FEV, g, '2027-02-02');
  near(day(0, 0, r).rows.vendas.meta, 0.5);
  // semana: 2,5 − 0 = 2,5 em 4 dias → 0,625
  near(day(0, 1, r).rows.vendas.meta, 0.625);
  assert.equal(day(0, 1, r).rows.vendas.raised, true);
  assert.equal(day(0, 0, r).rows.vendas.raised, false);
  // sexta absorve o resto: nada é perdido dentro da semana
  near(day(0, 4, r).rows.vendas.meta, 0.625);
});

test('dia sem lançamento no passado conta como 0 e é sinalizado', () => {
  const r = Goals.compute(FEV, goal(), '2027-02-03'); // dias 01 e 02 passaram sem lançamento
  assert.deepEqual(r.semLancamento, ['2027-02-01', '2027-02-02']);
  near(day(0, 2, r).rows.vendas.meta, 2.5 / 3); // hoje (qua) precisa cobrir 2,5 em 3 dias
});

test('não bateu a meta da semana 01 → a meta da semana 02 sobe', () => {
  const days = {};
  ['01', '02', '03', '04', '05'].forEach((d) => { days[`2027-02-${d}`] = { vendas: 0.3, cotacoes: 1 }; });
  const r = Goals.compute(FEV, goal({ days }), '2027-02-08');
  near(r.weeks[0].rows.vendas.realizado, 1.5);
  // restam 10 − 1,5 = 8,5 em 15 dias úteis → semana 2 (5 dias) = 2,8333
  near(r.weeks[1].rows.vendas.meta, (8.5 * 5) / 15);
  near(r.weeks[1].rows.vendas.base, 2.5);
  assert.equal(r.weeks[1].rows.vendas.raised, true);
  // e a semana 3 continua em 2,5 enquanto a 02 ainda é projetada para ser batida
  near(r.weeks[2].rows.vendas.meta, (8.5 - r.weeks[1].rows.vendas.meta) / 10 * 5);
  // cotações: 5 de 10 esperadas → semana 2 sobe também
  near(r.weeks[1].rows.cotacoes.meta, ((40 - 5) * 5) / 15);
});

test('superou a meta: por padrão a próxima meta não cai abaixo da base', () => {
  const g = goal({ days: { '2027-02-01': { vendas: 5 } } });
  const r = Goals.compute(FEV, g, '2027-02-02');
  near(day(0, 1, r).rows.vendas.meta, 0.5);
  assert.equal(day(0, 1, r).rows.vendas.raised, false);
});

test('compensarExcedente: superar reduz as metas seguintes', () => {
  const g = goal({ compensarExcedente: true, days: { '2027-02-01': { vendas: 1.5 } } });
  const r = Goals.compute(FEV, g, '2027-02-02');
  near(day(0, 1, r).rows.vendas.meta, (2.5 - 1.5) / 4); // 0,25
});

test('realizado semanal/mensal soma os dias; CPL é razão dos totais, não média', () => {
  const days = {
    '2027-02-01': { investimento: 100, leads: 10, leadsQualificados: 5 },
    '2027-02-02': { investimento: 300, leads: 10, leadsQualificados: 5 },
  };
  const r = Goals.compute(FEV, goal({ days }), '2027-02-03');
  assert.equal(r.weeks[0].rows.investimento.realizado, 400);
  assert.equal(r.weeks[0].rows.cpl.realizado, 20); // 400 ÷ 20 leads
  assert.equal(day(0, 0, r).rows.cpl.realizado, 10);
  assert.equal(day(0, 1, r).rows.cpl.realizado, 30);
  assert.equal(r.rows.cplQualificado.realizado, 40);
  // custo: dia 01 (10) ≤ teto 20 = bom; dia 02 (30) > 20×1,2 = ruim
  assert.equal(day(0, 0, r).rows.cpl.tone, 'good');
  assert.equal(day(0, 1, r).rows.cpl.tone, 'bad');
});

test('CPL do período usa totais ponderados', () => {
  const days = {
    '2027-02-01': { investimento: 100, leads: 1 },   // CPL 100
    '2027-02-02': { investimento: 100, leads: 99 },  // CPL ~1
  };
  const r = Goals.compute(FEV, goal({ days }), '2027-02-03');
  assert.equal(r.rows.cpl.realizado, 2); // 200 ÷ 100, e não a média (50,5)
});

test('folga: dia desligado não recebe meta e a semana redistribui', () => {
  const g = goal({ naoUteis: ['2027-02-03'] }); // quarta da semana 1
  const r = Goals.compute(FEV, g, '2027-02-01');
  assert.equal(r.workingDays, 19);
  assert.equal(day(0, 2, r).working, false);
  assert.equal(day(0, 2, r).rows.vendas.meta, null);
  near(r.weeks[0].rows.vendas.meta, (10 * 4) / 19);
  near(day(0, 0, r).rows.vendas.meta, ((10 * 4) / 19) / 4);
});

test('sem meta definida, não inventa meta nem quebra', () => {
  const r = Goals.compute(FEV, { meta: { vendas: 10 }, naoUteis: [], days: {} }, '2027-02-01');
  assert.equal(r.rows.investimento.meta, null);
  assert.equal(r.rows.leads.meta, null);
  assert.equal(r.rows.cpl.meta, null);
  near(r.rows.vendas.meta, 10);
});

test('tom do dia: encerrado sem lançar é ruim; futuro sem lançar é neutro', () => {
  const r = Goals.compute(FEV, goal({ days: { '2027-02-02': { vendas: 1 } } }), '2027-02-03');
  assert.equal(day(0, 0, r).rows.vendas.tone, 'bad');  // dia 01 sem lançamento (0 de 0,5)
  assert.equal(day(0, 1, r).rows.vendas.tone, 'good'); // dia 02 bateu
  assert.equal(day(0, 3, r).rows.vendas.tone, null);   // quinta ainda não chegou
});

test('datas inválidas são rejeitadas', () => {
  assert.equal(Goals.isRealDate('2027-02-28'), true);
  assert.equal(Goals.isRealDate('2027-02-30'), false);
  assert.equal(Goals.isRealDate('28/02/2027'), false);
});

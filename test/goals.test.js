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

test('meta mensal vira inteiros por semana e por dia (pessoas), e dinheiro continua com centavos', () => {
  const r = Goals.compute(FEV, goal(), '2027-02-01');
  assert.equal(r.workingDays, 20);
  assert.equal(r.weeks.length, 4);
  // pessoas: tudo inteiro e a soma fecha com o mês
  for (const k of ['leads', 'leadsQualificados', 'cotacoes', 'negociacoes', 'vendas']) {
    for (const w of r.weeks) {
      assert.ok(Number.isInteger(w.rows[k].meta), `${k} semana ${w.n}: ${w.rows[k].meta}`);
      for (const d of w.days) if (d.working) assert.ok(Number.isInteger(d.rows[k].meta), `${k} ${d.date}: ${d.rows[k].meta}`);
      assert.equal(w.days.filter((d) => d.working).reduce((s, d) => s + d.rows[k].meta, 0), w.rows[k].meta, `${k} dias somam a semana`);
    }
    assert.equal(r.weeks.reduce((s, w) => s + w.rows[k].meta, 0), r.rows[k].meta, `${k} semanas somam o mês`);
  }
  assert.deepEqual(r.weeks.map((w) => w.rows.vendas.meta), [3, 2, 3, 2]); // 10 vendas espalhadas
  assert.deepEqual(r.weeks[0].days.map((d) => d.rows.vendas.meta), [1, 1, 0, 1, 0]);
  assert.equal(day(2, 1, r).rows.cotacoes.meta, 2);  // 40 cotações em 20 dias
  assert.equal(day(0, 0, r).rows.leads.meta, 10);    // 200 leads em 20 dias
  assert.equal(r.rows.leadsQualificados.meta, 80);
  near(day(3, 4, r).rows.investimento.meta, 200);    // dinheiro: fracionado normalmente
  near(r.weeks[0].rows.investimento.meta, 1000);
  // custo é teto: igual em todos os níveis
  assert.equal(r.rows.cpl.meta, 20);
  assert.equal(day(1, 3, r).rows.cplQualificado.meta, 50);
});

test('total do mês quebrado é arredondado para cima (pessoas)', () => {
  const { targets } = Goals.resolveTargets({ investimento: 6000, itens: { leads: { modo: 'custo', valor: 70 }, vendas: { modo: 'numero', valor: 2.2 } } });
  assert.equal(targets.leads, 86);   // 6000 ÷ 70 = 85,7
  assert.equal(targets.vendas, 3);
  const t2 = Goals.resolveTargets({ investimento: 6000, itens: { leads: { modo: 'numero', valor: 85 }, leadsQualificados: { modo: 'taxa', valor: 33 } } }).targets;
  assert.equal(t2.leadsQualificados, 29); // 28,05 → 29
  assert.equal(Goals.resolveTargets({ investimento: 6000, itens: { leads: { modo: 'custo', valor: 30 } } }).targets.leads, 200); // exato não sobe
});

test('não bateu a meta do dia 01 → a meta do dia 02 sobe (em inteiros)', () => {
  const g = goal({ meta: { vendas: 20 }, days: { '2027-02-01': { vendas: 0 } } }); // 1 venda por dia útil
  const r = Goals.compute(FEV, g, '2027-02-02');
  assert.equal(day(0, 0, r).rows.vendas.meta, 1);
  assert.equal(day(0, 1, r).rows.vendas.meta, 2);
  assert.equal(day(0, 1, r).rows.vendas.raised, true);
  assert.equal(day(0, 0, r).rows.vendas.raised, false);
  assert.deepEqual(r.weeks[0].days.map((d) => d.rows.vendas.meta), [1, 2, 1, 1, 1]); // a semana continua somando 5
});

test('dia sem lançamento no passado conta como 0 e é sinalizado', () => {
  const r = Goals.compute(FEV, goal({ meta: { vendas: 20 } }), '2027-02-03'); // dias 01 e 02 passaram sem lançamento
  assert.deepEqual(r.semLancamento, ['2027-02-01', '2027-02-02']);
  assert.equal(day(0, 2, r).rows.vendas.meta, 2); // faltam 5 em 3 dias e a semana está atrasada: puxa para cima
  assert.ok(Number.isInteger(day(0, 2, r).rows.vendas.meta));
});

test('não bateu a meta da semana 01 → a meta da semana 02 sobe', () => {
  const days = {};
  ['01', '02', '03', '04', '05'].forEach((d) => { days[`2027-02-${d}`] = { vendas: 0, cotacoes: 1 }; });
  const r = Goals.compute(FEV, goal({ meta: { vendas: 20, cotacoes: 40 }, days }), '2027-02-08');
  assert.equal(r.weeks[0].rows.vendas.realizado, 0);
  assert.equal(r.weeks[1].rows.vendas.base, 5);
  assert.ok(r.weeks[1].rows.vendas.meta > 5);
  assert.ok(Number.isInteger(r.weeks[1].rows.vendas.meta));
  assert.equal(r.weeks[1].rows.vendas.raised, true);
  // o que faltava (20) continua sendo o total projetado: semanas 2 a 4 somam o mês inteiro
  assert.equal(r.weeks.slice(1).reduce((s, w) => s + w.rows.vendas.meta, 0), 20);
  // cotações: 5 de 10 esperadas na semana 1 → semana 2 sobe também
  assert.ok(r.weeks[1].rows.cotacoes.meta > r.weeks[1].rows.cotacoes.base);
});

test('superou a meta: por padrão a próxima meta não cai abaixo da base', () => {
  const g = goal({ meta: { vendas: 20 }, days: { '2027-02-01': { vendas: 5 } } });
  const r = Goals.compute(FEV, g, '2027-02-02');
  assert.equal(day(0, 1, r).rows.vendas.meta, 1);
  assert.equal(day(0, 1, r).rows.vendas.raised, false);
});

test('compensarExcedente: superar reduz as metas seguintes', () => {
  const g = goal({ meta: { vendas: 20 }, compensarExcedente: true, days: { '2027-02-01': { vendas: 3 } } });
  const r = Goals.compute(FEV, g, '2027-02-02');
  // a semana (5) já tem 3 feitos no dia 01: faltam 2, espalhados nos 4 dias restantes (nada de 1 por dia)
  const resto = r.weeks[0].days.slice(1).map((d) => d.rows.vendas.meta);
  assert.ok(resto.every(Number.isInteger));
  assert.equal(resto.reduce((a, b) => a + b, 0), 2);
  assert.ok(day(0, 1, r).rows.vendas.meta <= 1);
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
  const g = goal({ naoUteis: ['2027-02-03'], meta: { investimento: 4000, vendas: 19 } }); // quarta da semana 1; 19 dias úteis = 1 por dia
  const r = Goals.compute(FEV, g, '2027-02-01');
  assert.equal(r.workingDays, 19);
  assert.equal(day(0, 2, r).working, false);
  assert.equal(day(0, 2, r).rows.vendas.meta, null);
  assert.equal(r.weeks[0].rows.vendas.meta, 4);
  assert.deepEqual(r.weeks[0].days.filter((d) => d.working).map((d) => d.rows.vendas.meta), [1, 1, 1, 1]);
  near(r.weeks[0].rows.investimento.meta, (4000 * 4) / 19); // dinheiro segue proporcional, com centavos
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

// ---------- meta por número exato, porcentagem ou custo ----------
const nova = (itens, extra = {}) => ({ meta: { investimento: 6000, itens }, naoUteis: [], days: {}, ...extra });

test('formato antigo continua valendo (cpl, cplQualificado, números)', () => {
  const { targets, info } = Goals.resolveTargets({ investimento: 4000, cpl: 20, cplQualificado: 50, cotacoes: 40, negociacoes: 20, vendas: 10 });
  assert.equal(targets.leads, 200);
  assert.equal(targets.leadsQualificados, 80);
  assert.equal(targets.vendas, 10);
  assert.equal(info.leads.modo, 'custo');
  assert.equal(info.vendas.modo, 'numero');
});

test('custo: meta = investimento ÷ custo por unidade', () => {
  const { targets, info } = Goals.resolveTargets(nova({
    leads: { modo: 'custo', valor: 30 }, vendas: { modo: 'custo', valor: 300 },
  }).meta);
  assert.equal(targets.leads, 200);
  assert.equal(targets.vendas, 20);
  assert.equal(info.vendas.custo, 300);
});

test('porcentagem: cada etapa é % da etapa anterior que tem meta', () => {
  const { targets, info } = Goals.resolveTargets(nova({
    leads: { modo: 'numero', valor: 200 },
    leadsQualificados: { modo: 'taxa', valor: 40 },   // 80
    cotacoes: { modo: 'taxa', valor: 50 },            // 40
    negociacoes: { modo: 'taxa', valor: 50 },         // 20
    vendas: { modo: 'taxa', valor: 25 },              // 5
  }).meta);
  assert.deepEqual([targets.leads, targets.leadsQualificados, targets.cotacoes, targets.negociacoes, targets.vendas], [200, 80, 40, 20, 5]);
  near(info.vendas.custo, 1200); // 6000 ÷ 5 vendas: equivalência mostrada mesmo sem ter escolhido custo
  near(info.vendas.taxa, 25);
});

test('porcentagem pula etapa sem meta e usa a anterior que tem', () => {
  const { targets } = Goals.resolveTargets(nova({
    leads: { modo: 'numero', valor: 200 },
    leadsQualificados: { modo: 'numero', valor: null },
    cotacoes: { modo: 'taxa', valor: 20 },
  }).meta);
  assert.equal(targets.leadsQualificados, null);
  assert.equal(targets.cotacoes, 40); // 20% dos 200 leads
});

test('porcentagem sem etapa anterior definida não inventa meta', () => {
  const { targets } = Goals.resolveTargets(nova({ vendas: { modo: 'taxa', valor: 10 } }).meta);
  assert.equal(targets.vendas, null);
});

test('custo sem investimento não inventa meta', () => {
  const { targets } = Goals.resolveTargets({ itens: { vendas: { modo: 'custo', valor: 300 } } });
  assert.equal(targets.vendas, null);
});

test('modo inválido para a etapa cai no padrão da etapa', () => {
  const n = Goals.normalizeMeta({ investimento: 100, itens: { leads: { modo: 'taxa', valor: 5 } } });
  assert.equal(n.itens.leads.modo, 'custo'); // leads não tem "taxa"
});

test('compute usa as metas resolvidas e mostra linha de custo só quando o modo é custo', () => {
  const r = Goals.compute(FEV, nova({
    leads: { modo: 'numero', valor: 200 },
    leadsQualificados: { modo: 'taxa', valor: 40 },
    cotacoes: { modo: 'numero', valor: 40 },
    negociacoes: { modo: 'numero', valor: 20 },
    vendas: { modo: 'custo', valor: 600 },
  }), '2027-02-01');
  near(r.rows.vendas.meta, 10);               // 6000 ÷ 600
  near(r.rows.leadsQualificados.meta, 80);
  const keys = r.rowDefs.map((d) => d.key);
  assert.ok(keys.includes('custoVenda'));
  assert.ok(!keys.includes('custoCotacao'));
  assert.ok(!keys.includes('custoNegociacao'));
  assert.equal(r.rows.custoVenda.meta, 600);  // teto em todos os níveis
  assert.equal(day(0, 1, r).rows.custoVenda.meta, 600);
  // CPL implícito quando leads foi definido por número: 6000 ÷ 200
  assert.equal(r.rows.cpl.meta, 30);
});

test('custo por venda realizado = investimento ÷ vendas do período e vira bom/ruim contra o teto', () => {
  const days = { '2027-02-01': { investimento: 1000, vendas: 2 }, '2027-02-02': { investimento: 1000, vendas: 1 } };
  const r = Goals.compute(FEV, nova({ vendas: { modo: 'custo', valor: 600 } }, { days }), '2027-02-03');
  assert.equal(day(0, 0, r).rows.custoVenda.realizado, 500);
  assert.equal(day(0, 0, r).rows.custoVenda.tone, 'good');
  near(day(0, 1, r).rows.custoVenda.realizado, 1000);
  assert.equal(day(0, 1, r).rows.custoVenda.tone, 'bad');
  near(r.rows.custoVenda.realizado, 2000 / 3);
  assert.equal(r.rows.custoVenda.tone, 'warn'); // 666,67 ≤ 600 × 1,2
});

test('meta definida por % também compensa dia/semana como qualquer outra', () => {
  const g = nova({ leads: { modo: 'numero', valor: 400 }, vendas: { modo: 'taxa', valor: 5 } }, // 20 vendas no mês, 1 por dia útil
    { days: { '2027-02-01': { vendas: 0 } } });
  const r = Goals.compute(FEV, g, '2027-02-02');
  assert.equal(day(0, 0, r).rows.vendas.base, 1);
  assert.equal(day(0, 1, r).rows.vendas.meta, 2);
  assert.equal(day(0, 1, r).rows.vendas.raised, true);
});


test('dia com meta 0 que mesmo assim vendeu aparece como bom; sem venda fica neutro', () => {
  const r = Goals.compute(FEV, goal({ days: { '2027-02-03': { vendas: 1 } } }), '2027-02-01'); // nada encerrado ainda
  assert.equal(day(0, 2, r).rows.vendas.meta, 0);
  assert.equal(day(0, 2, r).rows.vendas.tone, 'good');
  assert.equal(day(0, 4, r).rows.vendas.tone, null); // sexta (meta 0), sem lançamento
});

test('linhas de pessoas são marcadas como inteiras (para o formulário)', () => {
  const inteiras = Goals.ROWS.filter((r) => r.integer).map((r) => r.key);
  assert.deepEqual(inteiras, ['leads', 'leadsQualificados', 'cotacoes', 'negociacoes', 'vendas']);
});

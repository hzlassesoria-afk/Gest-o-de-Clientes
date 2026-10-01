'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Funnel = require('../public/funnel');

const m = { leads: 100, leadsQualificados: 25, cotacoes: 18, negociacoes: 10, vendas: 3 };
const fmtInt = (v) => String(Math.round(v));
const fmtPct = (v) => v.toFixed(1) + '%';

test('conversão de cada etapa sobre a anterior', () => {
  const st = Funnel.stages(m);
  assert.deepEqual(st.map((s) => s.key), ['leads', 'leadsQualificados', 'cotacoes', 'negociacoes', 'vendas']);
  assert.equal(st[0].conversion, null);
  assert.equal(st[1].conversion, 25);
  assert.equal(st[2].conversion, 72);
  assert.ok(Math.abs(st[3].conversion - 55.555) < 0.01);
  assert.equal(st[4].conversion, 30);
  assert.equal(st[0].share, 1);
  assert.equal(Funnel.overall(m), 3);
});

test('dados faltando ou etapa anterior zerada não geram conversão', () => {
  const st = Funnel.stages({ leads: 50, leadsQualificados: null, cotacoes: 10, negociacoes: 0, vendas: 2 });
  assert.equal(st[1].conversion, null);
  assert.equal(st[2].conversion, null);   // anterior ausente
  assert.equal(st[3].conversion, 0);
  assert.equal(st[4].conversion, null);   // anterior zerada: sem divisão por zero
  assert.equal(Funnel.overall({ leads: 0, vendas: 1 }), null);
});

test('HTML: um trapézio por etapa, números e conversões escritos', () => {
  const html = Funnel.build({ m, fmtInt, fmtPct });
  assert.equal((html.match(/class="fn-tier /g) || []).length, 5);
  assert.match(html, />100</);
  assert.match(html, /25\.0% de conversão/);
  assert.match(html, /Conversão total[^<]*<b>3\.0%/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('sem nenhum valor não desenha funil; rótulos são escapados', () => {
  assert.equal(Funnel.build({ m: {}, fmtInt, fmtPct }), '');
  assert.equal(Funnel.build({ m: { leads: null }, fmtInt, fmtPct }), '');
  const html = Funnel.build({ m: { leads: 5 }, fmtInt, fmtPct });
  assert.doesNotMatch(html, /NaN/);
});

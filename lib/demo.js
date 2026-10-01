'use strict';
/*
 * Dados SIMULADOS para demonstração. Cada mês carregado recebe `_demo: true`;
 * editar o mês pela tela remove a marca (o mês passa a ser tratado como real).
 * Nunca sobrescreve um mês nem um campo de projeto que já tenha valor.
 */
const DEMO_PROJECT = {
  startDate: '2026-05-18',
  contractDate: '2026-05-18',
  campaignStartDate: '2026-05-27',
  firstSaleDate: '2026-06-14',
  mrr: 2500,
  roasTarget: 6,
};

const DEMO_MONTHS = {
  '2026-06': { investimento: 3000, leads: 120, leadsQualificados: 48, leadsResponderam: 70, cotacoes: 28, pararamResponder: 11, negociacoes: 8, vendas: 3, receita: 7800,
    mrr: 2500, faturado: 2500, inadimplente: 0, dinheiroColetado: 2500, nps: 60, reclamacoes: 2, contatosCliente: 25, reunioesRealizadas: 3, reunioesPlanejadas: 4, contatosEspontaneos: 14 },
  '2026-07': { investimento: 3500, leads: 165, leadsQualificados: 70, leadsResponderam: 98, cotacoes: 41, pararamResponder: 16, negociacoes: 12, vendas: 5, receita: 14500,
    mrr: 2500, faturado: 2500, inadimplente: 0, dinheiroColetado: 2500, nps: 70, reclamacoes: 1, contatosCliente: 22, reunioesRealizadas: 4, reunioesPlanejadas: 4, contatosEspontaneos: 10 },
  '2026-08': { investimento: 4000, leads: 210, leadsQualificados: 95, leadsResponderam: 125, cotacoes: 52, pararamResponder: 20, negociacoes: 15, vendas: 7, receita: 21700,
    mrr: 2500, faturado: 2500, inadimplente: 2500, dinheiroColetado: 0, nps: 75, reclamacoes: 1, contatosCliente: 20, reunioesRealizadas: 4, reunioesPlanejadas: 4, contatosEspontaneos: 8 },
  '2026-09': { investimento: 4500, leads: 245, leadsQualificados: 118, leadsResponderam: 150, cotacoes: 63, pararamResponder: 24, negociacoes: 19, vendas: 9, receita: 29700,
    mrr: 2500, faturado: 5000, inadimplente: 0, dinheiroColetado: 5000, nps: 80, reclamacoes: 0, contatosCliente: 18, reunioesRealizadas: 4, reunioesPlanejadas: 4, contatosEspontaneos: 6 },
};

/** Carrega o que estiver vazio. Devolve o que foi adicionado. */
function applyDemo(client) {
  const addedMonths = [];
  for (const [key, values] of Object.entries(DEMO_MONTHS)) {
    if (client.months[key]) continue;
    client.months[key] = { ...values, _demo: true };
    addedMonths.push(key);
  }
  const addedProject = [];
  for (const [key, value] of Object.entries(DEMO_PROJECT)) {
    if (client.project[key] == null) { client.project[key] = value; addedProject.push(key); }
  }
  client.demo = {
    projectKeys: [...new Set([...((client.demo && client.demo.projectKeys) || []), ...addedProject])],
  };
  return { addedMonths, addedProject };
}

/** Remove só os meses ainda marcados como simulados e os campos de projeto que continuam iguais ao demo. */
function clearDemo(client) {
  const removedMonths = Object.keys(client.months).filter((k) => client.months[k]._demo);
  for (const k of removedMonths) delete client.months[k];
  const keys = (client.demo && client.demo.projectKeys) || [];
  for (const k of keys) if (client.project[k] === DEMO_PROJECT[k]) client.project[k] = null;
  delete client.demo;
  return { removedMonths };
}

const demoMonthKeys = (client) => Object.keys(client.months).filter((k) => client.months[k]._demo);

module.exports = { applyDemo, clearDemo, demoMonthKeys };

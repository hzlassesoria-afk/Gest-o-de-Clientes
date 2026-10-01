/*
 * Cálculo das métricas. Arquivo UMD: roda no navegador (window.Metrics) e no Node (require).
 *
 * Cada mês guarda apenas valores BRUTOS digitados/importados. Tudo que é razão
 * (CPL, ROAS, CAC, taxa de inadimplência...) é calculado aqui a partir dos
 * totais do período, nunca média de médias.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Metrics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Campos brutos somáveis (acumulam no período)
  const SUM_FIELDS = [
    'investimento', 'leads', 'leadsQualificados', 'leadsResponderam', 'cotacoes',
    'pararamResponder', 'negociacoes', 'vendas', 'receita',
    'faturado', 'inadimplente', 'dinheiroColetado',
    'reclamacoes', 'contatosCliente', 'reunioesRealizadas', 'reunioesPlanejadas',
    'contatosEspontaneos',
  ];

  const SEMANAS_POR_MES = 4.33;

  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const div = (a, b) => (a == null || b == null || b === 0 ? null : a / b);

  /** Soma os campos brutos de uma lista de meses ({key: {...}}). null se nenhum mês tem valor. */
  function sumMonths(monthList) {
    const out = {};
    for (const f of SUM_FIELDS) {
      let total = null;
      for (const m of monthList) {
        const v = num(m && m[f]);
        if (v != null) total = (total || 0) + v;
      }
      out[f] = total;
    }
    return out;
  }

  /** Média simples dos valores informados (para NPS). */
  function avg(monthList, field) {
    const vals = monthList.map((m) => num(m && m[field])).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  /** Último valor informado (para MRR, Health Score manual). */
  function last(monthKeys, months, field) {
    for (let i = monthKeys.length - 1; i >= 0; i--) {
      const v = num(months[monthKeys[i]] && months[monthKeys[i]][field]);
      if (v != null) return v;
    }
    return null;
  }

  function monthsBetween(fromISO, to) {
    if (!fromISO) return null;
    const a = new Date(fromISO + 'T00:00:00Z');
    const b = to instanceof Date ? to : new Date(to + 'T00:00:00Z');
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    const days = (b - a) / 86400000;
    return days < 0 ? 0 : days / 30.4375;
  }

  function daysBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return null;
    const a = new Date(fromISO + 'T00:00:00Z');
    const b = new Date(toISO + 'T00:00:00Z');
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    return Math.round((b - a) / 86400000);
  }

  function anxietyLevel(contatosPorSemana) {
    if (contatosPorSemana == null) return null;
    if (contatosPorSemana <= 2) return 'Baixo';
    if (contatosPorSemana <= 5) return 'Médio';
    return 'Alto';
  }

  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

  /**
   * Health Score (0-100) calculado. Cada componente vale 0-100; os pesos são
   * renormalizados entre os componentes que têm dado. O valor manual sempre vence.
   */
  function computeHealth(c, roasTarget) {
    const parts = [];
    if (c.nps != null) parts.push({ key: 'NPS', w: 25, v: clamp((c.nps + 100) / 2) });
    if (c.roas != null && roasTarget) parts.push({ key: 'ROAS vs meta', w: 25, v: clamp((c.roas / roasTarget) * 100) });
    if (c.taxaInadimplencia != null) parts.push({ key: 'Inadimplência', w: 15, v: clamp(100 - c.taxaInadimplencia * 5) });
    if (c.contatosEspontaneosSemana != null) parts.push({ key: 'Ansiedade', w: 15, v: clamp(100 - c.contatosEspontaneosSemana * 12) });
    if (c.aderenciaReunioes != null) parts.push({ key: 'Reuniões', w: 10, v: clamp(c.aderenciaReunioes * 100) });
    if (c.indiceReclamacao != null) parts.push({ key: 'Reclamações', w: 10, v: clamp(100 - c.indiceReclamacao * 5) });
    if (!parts.length) return null;
    const wSum = parts.reduce((s, p) => s + p.w, 0);
    const score = parts.reduce((s, p) => s + p.v * p.w, 0) / wSum;
    return { score: Math.round(score), parts };
  }

  function healthBand(score) {
    if (score == null) return null;
    if (score >= 75) return 'Saudável';
    if (score >= 50) return 'Atenção';
    return 'Risco';
  }

  /**
   * Calcula todas as métricas de um período.
   * @param {object} client  { project, months }
   * @param {string[]} keys  chaves de mês ('YYYY-MM') incluídas no período
   * @param {Date|string} [today] data de referência p/ tempo de projeto
   */
  function compute(client, keys, today) {
    const project = client.project || {};
    const months = client.months || {};
    const list = keys.map((k) => months[k] || {});
    const s = sumMonths(list);

    const investimento = s.investimento;
    const mrr = last(keys, months, 'mrr') ?? num(project.mrr);
    const mensalidades = (() => {
      // custo de gestão no período = MRR de cada mês informado (ou MRR do projeto)
      let t = null;
      for (const k of keys) {
        const v = num(months[k] && months[k].mrr) ?? num(project.mrr);
        if (v != null) t = (t || 0) + v;
      }
      return t;
    })();

    const custoAquisicao = project.cacIncludesFee === false || mensalidades == null
      ? investimento
      : (investimento == null ? null : investimento + mensalidades);

    const result = {
      // ---- Resultado do cliente ----
      investimento,
      leads: s.leads,
      cpl: div(investimento, s.leads),
      leadsQualificados: s.leadsQualificados,
      cplQualificado: div(investimento, s.leadsQualificados),
      leadsResponderam: s.leadsResponderam,
      cotacoes: s.cotacoes,
      pararamResponder: s.pararamResponder,
      negociacoes: s.negociacoes,
      vendas: s.vendas,
      receita: s.receita,
      ticketMedio: div(s.receita, s.vendas),
      roas: div(s.receita, investimento),
      cac: div(custoAquisicao, s.vendas),

      // ---- Gestão ----
      tempoProjetoMeses: monthsBetween(project.startDate, today || new Date()),
      taxaInadimplencia: (() => { const r = div(s.inadimplente, s.faturado); return r == null ? null : r * 100; })(),
      mrr,
      timeToValueCampanhaDias: daysBetween(project.contractDate, project.campaignStartDate),
      timeToValuePrimeiraVendaDias: daysBetween(project.campaignStartDate, project.firstSaleDate),
      timeToValueContratoPrimeiraVendaDias: daysBetween(project.contractDate, project.firstSaleDate),
      nps: avg(list, 'nps'),
      indiceReclamacao: (() => { const r = div(s.reclamacoes, s.contatosCliente); return r == null ? null : r * 100; })(),
      reunioesRealizadas: s.reunioesRealizadas,
      reunioesPlanejadas: s.reunioesPlanejadas,
      aderenciaReunioes: div(s.reunioesRealizadas, s.reunioesPlanejadas),
      reunioesPorMes: s.reunioesRealizadas == null || !keys.length ? null : s.reunioesRealizadas / keys.length,
      contatosEspontaneos: s.contatosEspontaneos,
      contatosEspontaneosSemana: s.contatosEspontaneos == null || !keys.length
        ? null : s.contatosEspontaneos / (keys.length * SEMANAS_POR_MES),
      dinheiroColetado: s.dinheiroColetado,
    };

    result.nivelAnsiedade = anxietyLevel(result.contatosEspontaneosSemana);

    // Funil: cada etapa como % da etapa anterior preenchida
    result.funil = buildFunnel(result);

    const manualHealth = last(keys, months, 'healthScore');
    const auto = computeHealth(result, num(project.roasTarget));
    result.healthScoreAuto = auto;
    result.healthScore = manualHealth != null ? manualHealth : auto ? auto.score : null;
    result.healthScoreManual = manualHealth != null;
    result.healthBand = healthBand(result.healthScore);
    return result;
  }

  function buildFunnel(r) {
    const steps = [
      ['Leads', r.leads],
      ['Leads qualificados', r.leadsQualificados],
      ['Responderam o 1º contato', r.leadsResponderam],
      ['Cotações enviadas', r.cotacoes],
      ['Em negociação', r.negociacoes],
      ['Vendas', r.vendas],
    ];
    const top = r.leads;
    let prev = null;
    return steps.map(([label, value]) => {
      const out = {
        label, value,
        pctOfLeads: div(value, top),
        pctOfPrev: prev == null ? null : div(value, prev),
      };
      if (value != null) prev = value;
      return out;
    });
  }

  /** Série mensal para gráficos/tabela de evolução. */
  function series(client, today) {
    return Object.keys(client.months || {}).sort().map((k) => ({ month: k, ...compute(client, [k], today) }));
  }

  return { compute, series, sumMonths, SUM_FIELDS, daysBetween, monthsBetween, anxietyLevel, healthBand, computeHealth };
});

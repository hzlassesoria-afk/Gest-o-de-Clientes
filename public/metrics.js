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

    result.aderenciaReunioesPct = result.aderenciaReunioes == null ? null : result.aderenciaReunioes * 100;
    result.nivelAnsiedade = anxietyLevel(result.contatosEspontaneosSemana);

    // Funil: conversão de cada etapa em relação à anterior
    result.funil = buildFunnel(result);

    const manualHealth = last(keys, months, 'healthScore');
    const auto = computeHealth(result, num(project.roasTarget));
    result.healthScoreAuto = auto;
    result.healthScore = manualHealth != null ? manualHealth : auto ? auto.score : null;
    result.healthScoreManual = manualHealth != null;
    result.healthBand = healthBand(result.healthScore);
    return result;
  }

  /**
   * Funil comercial em 5 etapas. `conv` = conversão em relação à etapa imediatamente anterior
   * (null se uma das duas não foi informada ou a anterior é 0). `pctOfLeads` = % sobre o topo.
   */
  function buildFunnel(r) {
    const steps = [
      ['leads', 'Leads', 'Leads gerados', r.leads],
      ['leadsQualificados', 'Qualificados', 'Leads qualificados (MQL)', r.leadsQualificados],
      ['cotacoes', 'Cotações', 'Cotações enviadas', r.cotacoes],
      ['negociacoes', 'Negociação', 'Em negociação', r.negociacoes],
      ['vendas', 'Vendas', 'Vendas fechadas', r.vendas],
    ];
    return steps.map(([key, label, title, value], i) => ({
      key, label, title, value,
      conv: i === 0 ? null : (() => { const c = div(value, steps[i - 1][3]); return c == null ? null : c * 100; })(),
      pctOfLeads: (() => { const c = div(value, r.leads); return c == null ? null : c * 100; })(),
    }));
  }

  /** Série mensal para gráficos/tabela de evolução. */
  function series(client, today) {
    return Object.keys(client.months || {}).sort().map((k) => ({ month: k, ...compute(client, [k], today) }));
  }

  /*
   * Indicadores da análise mês a mês.
   *  good: 'up' (subir é bom) | 'down' (cair é bom) | null (neutro, ex.: investimento)
   *  kind: 'rel' = variação em % | 'abs' = diferença absoluta (para métricas que já são %, notas ou escores)
   */
  const INDICATORS = [
    { group: 'Resultado do cliente', items: [
      { key: 'investimento', label: 'Investimento no Meta', fmt: 'brl', good: null, kind: 'rel' },
      { key: 'leads', label: 'Leads', fmt: 'int', good: 'up', kind: 'rel' },
      { key: 'cpl', label: 'Custo por lead', fmt: 'brl', good: 'down', kind: 'rel' },
      { key: 'leadsQualificados', label: 'Leads qualificados', fmt: 'int', good: 'up', kind: 'rel' },
      { key: 'cplQualificado', label: 'Custo por lead qualificado', fmt: 'brl', good: 'down', kind: 'rel' },
      { key: 'leadsResponderam', label: 'Responderam o 1º contato', fmt: 'int', good: 'up', kind: 'rel' },
      { key: 'cotacoes', label: 'Cotações enviadas', fmt: 'int', good: 'up', kind: 'rel' },
      { key: 'pararamResponder', label: 'Pararam de responder (pós follow-up)', fmt: 'int', good: 'down', kind: 'rel' },
      { key: 'negociacoes', label: 'Em negociação', fmt: 'int', good: 'up', kind: 'rel' },
      { key: 'vendas', label: 'Vendas', fmt: 'int', good: 'up', kind: 'rel' },
      { key: 'receita', label: 'Receita gerada em vendas', fmt: 'brl', good: 'up', kind: 'rel' },
      { key: 'ticketMedio', label: 'Ticket médio', fmt: 'brl', good: 'up', kind: 'rel' },
      { key: 'roas', label: 'ROAS', fmt: 'x', good: 'up', kind: 'rel' },
      { key: 'cac', label: 'CAC', fmt: 'brl', good: 'down', kind: 'rel' },
    ] },
    { group: 'Gestão', items: [
      { key: 'mrr', label: 'MRR', fmt: 'brl', good: 'up', kind: 'rel' },
      { key: 'taxaInadimplencia', label: 'Taxa de inadimplência', fmt: 'pct', good: 'down', kind: 'abs', unit: 'p.p.' },
      { key: 'nps', label: 'NPS', fmt: 'nps', good: 'up', kind: 'abs', unit: 'pts' },
      { key: 'healthScore', label: 'Health Score', fmt: 'int', good: 'up', kind: 'abs', unit: 'pts' },
      { key: 'indiceReclamacao', label: 'Índice de reclamação', fmt: 'pct', good: 'down', kind: 'abs', unit: 'p.p.' },
      { key: 'aderenciaReunioesPct', label: 'Aderência às reuniões', fmt: 'pct', good: 'up', kind: 'abs', unit: 'p.p.' },
      { key: 'contatosEspontaneosSemana', label: 'Contatos espontâneos / semana', fmt: 'dec', good: 'down', kind: 'abs', unit: '' },
      { key: 'dinheiroColetado', label: 'Dinheiro coletado', fmt: 'brl', good: 'up', kind: 'rel' },
    ] },
  ];
  const INDICATOR_BY_KEY = Object.fromEntries(INDICATORS.flatMap((g) => g.items).map((d) => [d.key, d]));

  /**
   * Variação entre dois valores. null quando não dá para comparar.
   * tone: 'good' | 'bad' | 'flat' (flat também para indicadores neutros).
   */
  function change(curr, prev, def) {
    if (curr == null || prev == null || !def) return null;
    let value;
    if (def.kind === 'abs') value = curr - prev;
    else if (prev === 0) return null; // variação % sobre zero não faz sentido
    else value = ((curr - prev) / Math.abs(prev)) * 100;
    if (Math.abs(value) < 0.05) return { value: 0, dir: 'flat', tone: 'flat', kind: def.kind, unit: def.unit };
    const dir = value > 0 ? 'up' : 'down';
    const tone = def.good == null ? 'flat' : dir === def.good ? 'good' : 'bad';
    return { value, dir, tone, kind: def.kind, unit: def.unit };
  }

  return { compute, series, sumMonths, INDICATORS, INDICATOR_BY_KEY, change, SUM_FIELDS, daysBetween, monthsBetween, anxietyLevel, healthBand, computeHealth };
});

/*
 * Metas da rotina comercial: mensal → semanal → diário (dias úteis).
 * Arquivo UMD: roda no navegador (window.Goals) e no Node (require).
 *
 * Você informa a meta do mês e lança o REALIZADO dia a dia. As metas de cada
 * semana e de cada dia são calculadas aqui, com compensação automática:
 *   - semana: (meta do mês − realizado até a semana anterior) ÷ dias úteis que faltam × dias úteis da semana
 *   - dia:    (meta da semana − realizado na semana até ontem) ÷ dias úteis que faltam na semana
 * Se ficou abaixo, a meta seguinte sobe. Se superou, por padrão a meta seguinte
 * NÃO cai abaixo da meta-base (opção `compensarExcedente` faz ela cair).
 *
 * Metas de pessoas (leads, qualificados, cotações, negociações, vendas) são sempre números
 * inteiros: o total do mês é arredondado para cima e a divisão por semana e por dia usa
 * inteiros (ex.: 10 vendas em 20 dias úteis = 1 venda em dias alternados). Quando o período
 * fica abaixo, o que falta é puxado para os próximos dias, também em inteiros.
 * Só o valor investido (dinheiro) é dividido com centavos.
 *
 * Cada etapa do funil (leads, qualificados, cotações, negociações, vendas) pode ser
 * definida na meta do mês de três jeitos:
 *   - número exato;
 *   - taxa: % da etapa anterior que tem meta (ex.: vendas = 20% das negociações);
 *   - custo: R$ por unidade (meta = investimento ÷ custo).
 * Linhas de custo (por lead, por lead qualificado e, quando escolhido, por cotação,
 * negociação ou venda) são tetos: a meta é a mesma em todos os níveis e o realizado é
 * investimento ÷ quantidade do período.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Goals = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Etapas do funil que têm meta, em ordem, e como cada uma pode ser definida
  const STAGES = ['leads', 'leadsQualificados', 'cotacoes', 'negociacoes', 'vendas'];
  const MODES = {
    leads: ['custo', 'numero'],
    leadsQualificados: ['custo', 'taxa', 'numero'],
    cotacoes: ['numero', 'taxa', 'custo'],
    negociacoes: ['numero', 'taxa', 'custo'],
    vendas: ['numero', 'taxa', 'custo'],
  };
  const DEFAULT_MODE = { leads: 'custo', leadsQualificados: 'custo', cotacoes: 'numero', negociacoes: 'numero', vendas: 'numero' };
  const MODE_LABEL = { numero: 'Número exato', taxa: '% da etapa anterior', custo: 'Custo (R$ por unidade)' };
  // Formato antigo (planos salvos antes das opções): cpl, cplQualificado, cotacoes, negociacoes, vendas
  const LEGACY_KEY = { leads: 'cpl', leadsQualificados: 'cplQualificado', cotacoes: 'cotacoes', negociacoes: 'negociacoes', vendas: 'vendas' };
  const META_FIELDS = ['investimento', 'cpl', 'cplQualificado', 'cotacoes', 'negociacoes', 'vendas'];
  // Realizado que o usuário lança por dia (valores brutos)
  const DAY_FIELDS = ['investimento', 'leads', 'leadsQualificados', 'cotacoes', 'negociacoes', 'vendas'];
  // Métricas de volume: somam entre dias e semanas e têm compensação
  const VOLUME = ['investimento', 'leads', 'leadsQualificados', 'cotacoes', 'negociacoes', 'vendas'];
  // Linhas exibidas, na ordem do funil
  const ROWS = [
    { key: 'investimento', label: 'Valor investido', fmt: 'brl', kind: 'volume', input: true },
    { key: 'leads', label: 'Leads', fmt: 'int', kind: 'volume', input: true, support: true, integer: true },
    { key: 'cpl', label: 'Custo por lead', fmt: 'brl', kind: 'cost', numerator: 'investimento', denominator: 'leads', stage: 'leads' },
    { key: 'leadsQualificados', label: 'Leads qualificados', fmt: 'int', kind: 'volume', input: true, support: true, integer: true },
    { key: 'cplQualificado', label: 'Custo por lead qualificado', fmt: 'brl', kind: 'cost', numerator: 'investimento', denominator: 'leadsQualificados', stage: 'leadsQualificados' },
    { key: 'cotacoes', label: 'Cotação', fmt: 'int', kind: 'volume', input: true, integer: true },
    { key: 'custoCotacao', label: 'Custo por cotação', fmt: 'brl', kind: 'cost', numerator: 'investimento', denominator: 'cotacoes', stage: 'cotacoes', optional: true },
    { key: 'negociacoes', label: 'Negociação', fmt: 'int', kind: 'volume', input: true, integer: true },
    { key: 'custoNegociacao', label: 'Custo por negociação', fmt: 'brl', kind: 'cost', numerator: 'investimento', denominator: 'negociacoes', stage: 'negociacoes', optional: true },
    { key: 'vendas', label: 'Vendas', fmt: 'int', kind: 'volume', input: true, integer: true },
    { key: 'custoVenda', label: 'Custo por venda', fmt: 'brl', kind: 'cost', numerator: 'investimento', denominator: 'vendas', stage: 'vendas', optional: true },
  ];

  // Foco de cada dia da semana (seg a sex)
  const DAY_THEME = { 1: 'Meta da Semana', 2: 'Foco no Atendimento', 3: 'Revisão da Semana', 4: 'Foco no Atendimento', 5: 'Relatório da Semana' };
  const WEEKDAY_SHORT = { 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex' };

  const EPS = 1e-9;
  const pad = (n) => String(n).padStart(2, '0');
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const div = (a, b) => (a == null || b == null || b === 0 ? null : a / b);

  // ---------- datas (sempre em UTC, sem surpresa de fuso) ----------
  const parse = (s) => new Date(s + 'T00:00:00Z');
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const dow = (s) => parse(s).getUTCDay(); // 0 = domingo
  const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

  function isRealDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = parse(s);
    return !Number.isNaN(d.getTime()) && iso(d) === s;
  }

  /** Data local de hoje (AAAA-MM-DD), a que a pessoa vê no calendário dela. */
  function todayISO(now) {
    const d = now || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ---------- feriados nacionais ----------
  function easter(y) { // algoritmo de Meeus/Jones/Butcher
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return `${y}-${pad(month)}-${pad(day)}`;
  }

  /** Feriados nacionais do ano: { 'AAAA-MM-DD': nome }. Carnaval e Corpus Christi são facultativos e ficam de fora. */
  function holidays(year) {
    const fixed = {
      '01-01': 'Confraternização Universal', '04-21': 'Tiradentes', '05-01': 'Dia do Trabalho',
      '09-07': 'Independência', '10-12': 'Nossa Sra. Aparecida', '11-02': 'Finados',
      '11-15': 'Proclamação da República', '11-20': 'Consciência Negra', '12-25': 'Natal',
    };
    const out = {};
    for (const [md, name] of Object.entries(fixed)) out[`${year}-${md}`] = name;
    out[addDays(easter(year), -2)] = 'Sexta-feira Santa';
    return out;
  }

  /** Dias de semana (seg-sex) do mês que são feriado nacional: o padrão de folgas do mês. */
  function defaultOffDays(month) {
    const h = holidays(Number(month.slice(0, 4)));
    return Object.keys(h).filter((d) => d.startsWith(month) && dow(d) >= 1 && dow(d) <= 5).sort();
  }

  // ---------- calendário ----------
  /**
   * Semanas (seg-sex) que têm ao menos um dia útil no mês.
   * Cada dia: { date, dow, inMonth, working, holiday }.
   */
  function calendar(month, offDays) {
    const off = new Set(offDays || []);
    const hol = holidays(Number(month.slice(0, 4)));
    const total = daysInMonth(month);
    const first = `${month}-01`;
    const lastDate = `${month}-${pad(total)}`;
    let monday = addDays(first, -((dow(first) + 6) % 7));
    const weeks = [];
    while (monday <= lastDate) {
      const days = [];
      for (let i = 0; i < 5; i++) {
        const date = addDays(monday, i);
        const inMonth = date.startsWith(month);
        days.push({ date, dow: i + 1, inMonth, working: inMonth && !off.has(date), holiday: hol[date] || null });
      }
      if (days.some((d) => d.working)) weeks.push({ n: weeks.length + 1, monday, days });
      monday = addDays(monday, 7);
    }
    return weeks;
  }

  // ---------- metas mensais derivadas ----------
  /** Lê a meta do mês nos dois formatos (novo: { investimento, itens }; antigo: chaves soltas). */
  function normalizeMeta(meta) {
    const m = meta || {};
    const itens = {};
    for (const k of STAGES) {
      const it = m.itens && m.itens[k];
      if (it && MODES[k].includes(it.modo)) itens[k] = { modo: it.modo, valor: num(it.valor) };
      else itens[k] = { modo: DEFAULT_MODE[k], valor: num(m[LEGACY_KEY[k]]) };
    }
    return { investimento: num(m.investimento), faturamento: num(m.faturamento), ticketVenda: num(m.ticketVenda), itens };
  }

  /**
   * Transforma as escolhas da meta do mês em totais do mês por etapa.
   * @returns {{ targets: Object, info: Object }} info[etapa] = { modo, total, custo, taxa }
   *   `custo` (R$ por unidade) e `taxa` (% da etapa anterior com meta) são sempre calculados,
   *   mesmo quando a etapa foi definida de outro jeito, para mostrar as equivalências.
   */
  // Arredonda para cima, tolerando ruído de ponto flutuante (79,999999999 vira 80)
  const ceilInt = (x) => Math.ceil(x - 1e-9);

  function resolveTargets(meta) {
    const n = normalizeMeta(meta);
    const inv = n.investimento;
    const targets = { investimento: inv };
    const info = {};
    let base = null; // total (inteiro) da última etapa que tem meta
    for (const k of STAGES) {
      const { modo, valor } = n.itens[k];
      let raw = null;
      if (valor != null) {
        if (modo === 'numero') raw = valor;
        else if (modo === 'custo') raw = div(inv, valor);
        else if (modo === 'taxa') raw = base != null ? (base * valor) / 100 : null;
      }
      const total = raw == null ? null : ceilInt(raw); // pessoas: sempre inteiro, para cima
      targets[k] = total;
      info[k] = {
        modo, total,
        // No modo custo, o teto é o valor digitado; nos outros, o custo que a meta implica
        custo: modo === 'custo' && valor != null ? valor : (total != null && total > 0 ? div(inv, total) : null),
        taxa: total != null && base ? (total / base) * 100 : null,
      };
      if (total != null) base = total;
    }
    return { targets, info };
  }

  /**
   * Do fim para o começo: quanto investir em anúncios para bater `vendas`, dadas as taxas de conversão
   * entre as etapas e o custo por lead. Acha o menor número de leads que, passando pelo funil
   * (sempre arredondando pessoas para cima, como em resolveTargets), entrega pelo menos `vendas`.
   * `taxas`: { leadsQualificados, cotacoes, negociacoes, vendas } em % da etapa anterior (0 a 100).
   * Devolve { investimento, totais, meta } (meta no formato novo, pronto para salvar) ou null se faltar dado.
   */
  function planFromSales({ vendas, taxas, cpl }) {
    const V = num(vendas), c = num(cpl);
    const steps = STAGES.slice(1);
    const rates = steps.map((k) => num(taxas && taxas[k]));
    if (!V || V <= 0 || !c || c <= 0 || rates.some((r) => r == null || r <= 0 || r > 100)) return null;
    const run = (L) => {
      const t = { leads: L };
      let prev = L;
      steps.forEach((k, i) => { prev = ceilInt((prev * rates[i]) / 100); t[k] = prev; });
      return t;
    };
    const product = rates.reduce((p, r) => p * (r / 100), 1);
    let L = Math.max(1, ceilInt(Math.ceil(V) / product));
    while (L > 1 && run(L - 1).vendas >= V) L--;                    // o início da conta pode já passar da meta
    while (run(L).vendas < V && L < 1e7) L++;                      // ou ficar abaixo dela (arredondamentos)
    const totais = run(L);
    const investimento = L * c;
    const itens = { leads: { modo: 'custo', valor: c } };
    steps.forEach((k, i) => { itens[k] = { modo: 'taxa', valor: rates[i] }; });
    return { investimento, totais, meta: { investimento, itens } };
  }

  /**
   * Da meta de FATURAMENTO ao investimento: faturamento = volume vendido × comissão (% do volume);
   * vendas = volume ÷ valor médio por venda (arredondado para cima); depois o mesmo caminho de planFromSales.
   * Devolve { investimento, totais, meta, volume, vendas, comissaoPct } ou null se faltar dado.
   */
  function planFromRevenue({ faturamento, ticketVenda, comissaoPct, taxas, cpl }) {
    const F = num(faturamento), T = num(ticketVenda), p = num(comissaoPct);
    if (!F || F <= 0 || !T || T <= 0 || !p || p <= 0) return null;
    const volume = F / (p / 100);
    const vendas = Math.max(1, ceilInt(volume / T));
    const plan = planFromSales({ vendas, taxas, cpl });
    if (!plan) return null;
    plan.meta.faturamento = F;
    plan.meta.ticketVenda = T;
    return { ...plan, volume, vendas, comissaoPct: p };
  }

  /**
   * Cenários de investimento da meta de faturamento salva, um por ponta da faixa de comissão
   * (`comissao` = { min, max } em %). Só existe quando a meta tem faturamento e valor médio por venda,
   * custo por lead e as taxas entre as etapas. Comissão maior = menos volume = menos investimento.
   */
  function revenueScenarios(meta, comissao) {
    const n = normalizeMeta(meta);
    if (!n.faturamento || !n.ticketVenda) return null;
    const leads = n.itens.leads;
    if (leads.modo !== 'custo' || leads.valor == null) return null;
    const taxas = {};
    for (const k of STAGES.slice(1)) {
      if (n.itens[k].modo !== 'taxa') return null;
      taxas[k] = n.itens[k].valor;
    }
    const mk = (pct) => planFromRevenue({ faturamento: n.faturamento, ticketVenda: n.ticketVenda, comissaoPct: pct, taxas, cpl: leads.valor });
    const out = { max: mk(comissao.max), min: mk(comissao.min) };
    return out.max && out.min ? out : null;
  }

  /**
   * Quanto investir para bater a meta do mês: leads da meta × custo por lead (teto), quando a meta de leads
   * é definida por custo; senão, o valor investido planejado. `planejado` é o que está na meta do mês.
   */
  function investmentNeeded(meta) {
    const { info, targets } = resolveTargets(meta);
    const planejado = targets.investimento;
    const leads = info.leads;
    if (leads.modo === 'custo' && leads.total != null && leads.custo != null) {
      return { necessario: leads.total * leads.custo, planejado, leads: leads.total, cpl: leads.custo, fromCpl: true };
    }
    return planejado == null ? null : { necessario: planejado, planejado, leads: leads.total, cpl: leads.custo, fromCpl: false };
  }

  /**
   * Distribui a meta de UMA métrica por semanas e dias úteis, com compensação.
   * `integer`: metas em números inteiros (pessoas); senão, contínuo (dinheiro).
   * @returns {{ week: Object<number,{meta,base}>, day: Object<string,{meta,base}> }}
   */
  function distribute(total, weeks, realized, today, compensar, integer) {
    return integer ? distributeInt(total, weeks, realized, today, compensar) : distributeCont(total, weeks, realized, today, compensar);
  }

  function distributeCont(total, weeks, realized, today, compensarExcedente) {
    const out = { week: {}, day: {} };
    const workingCount = (w) => w.days.filter((d) => d.working).length;
    let remDays = weeks.reduce((s, w) => s + workingCount(w), 0);
    const N = remDays;
    if (total == null || N === 0) return out;
    let doneBefore = 0;

    for (const w of weeks) {
      const nw = workingCount(w);
      if (!nw) continue;
      const baseW = (total * nw) / N;
      const needW = Math.max(((total - doneBefore) * nw) / remDays, 0);
      const W = compensarExcedente ? needW : Math.max(baseW, needW);
      out.week[w.n] = { meta: W, base: baseW };

      let doneWeek = 0, remW = nw;
      for (const d of w.days) {
        const actual = num(realized[d.date]);
        if (!d.working) { if (actual != null) doneWeek += actual; continue; }
        const baseD = W / nw;
        const needD = Math.max((W - doneWeek) / remW, 0);
        const D = compensarExcedente ? needD : Math.max(baseD, needD);
        out.day[d.date] = { meta: D, base: baseD };
        // Dia sem lançamento: no passado conta como 0 (não bateu); de hoje em diante, assume que bate a meta
        doneWeek += actual != null ? actual : (d.date < today ? 0 : D);
        remW--;
      }
      doneBefore += doneWeek;
      remDays -= nw;
    }
    return out;
  }

  // Parte do que falta (R) que cabe nos próximos n dias, entre m dias restantes, em inteiros.
  // Dentro do ritmo: arredonda (espalha por igual, ex.: 10 em 20 dias = dias alternados).
  // Abaixo do ritmo (`atrasado`): arredonda para cima, puxando o que falta para já.
  function share(R, m, n, atrasado) {
    let r = Math.max(R, 0), left = m, s = 0;
    for (let i = 0; i < n && left > 0; i++) {
      const a = atrasado ? Math.ceil(r / left - 1e-9) : Math.round(r / left);
      s += a; r -= a; left--;
    }
    return s;
  }

  function distributeInt(total, weeks, realized, today, compensarExcedente) {
    const out = { week: {}, day: {} };
    const workingCount = (w) => w.days.filter((d) => d.working).length;
    const N = weeks.reduce((s, w) => s + workingCount(w), 0);
    if (total == null || N === 0) return out;
    let remDays = N;
    let doneBefore = 0;          // realizado (ou projetado) até a semana anterior
    let baseRem = total, baseLeft = N; // ritmo-base: o que falta se tudo fosse batido

    for (const w of weeks) {
      const nw = workingCount(w);
      if (!nw) continue;
      const baseW = share(baseRem, baseLeft, nw, false);
      const baseDone = total - baseRem;                 // quanto o ritmo-base já teria feito
      const atrasadoW = doneBefore < baseDone - 1e-9;
      const needW = share(total - doneBefore, remDays, nw, atrasadoW);
      const W = compensarExcedente ? needW : Math.max(baseW, needW);
      out.week[w.n] = { meta: W, base: baseW };

      // metas-base dos dias da semana (sem atraso), para saber o que é "compensação"
      const baseDay = {};
      { let r = baseW, left = nw; for (const d of w.days) if (d.working) { const a = Math.round(r / left); baseDay[d.date] = a; r -= a; left--; } }

      let doneWeek = 0, remW = nw, cumBase = 0;
      for (const d of w.days) {
        const actual = num(realized[d.date]);
        if (!d.working) { if (actual != null) doneWeek += actual; continue; }
        const baseD = baseDay[d.date];
        const atrasadoD = doneWeek < cumBase - 1e-9;
        const needD = share(W - doneWeek, remW, 1, atrasadoD);
        const D = compensarExcedente ? needD : Math.max(baseD, needD);
        out.day[d.date] = { meta: D, base: baseD };
        doneWeek += actual != null ? actual : (d.date < today ? 0 : D);
        cumBase += baseD;
        remW--;
      }
      doneBefore += doneWeek;
      remDays -= nw;
      baseRem -= baseW; baseLeft -= nw;
    }
    return out;
  }

  const sum = (vals) => {
    let t = null;
    for (const v of vals) if (v != null) t = (t || 0) + v;
    return t;
  };

  function toneVolume(realizado, meta) {
    if (meta === 0) return realizado > 0 ? 'good' : null; // dia sem meta que ainda assim produziu
    if (meta == null || realizado == null || meta < 0) return null;
    const r = realizado / meta;
    return r >= 1 - EPS ? 'good' : r >= 0.7 ? 'warn' : 'bad';
  }
  function toneCost(realizado, meta) {
    if (meta == null || realizado == null || meta <= 0) return null;
    return realizado <= meta + EPS ? 'good' : realizado <= meta * 1.2 ? 'warn' : 'bad';
  }

  /**
   * Calcula o plano do mês inteiro.
   * @param {string} month   'AAAA-MM'
   * @param {object} goal    { meta, naoUteis?, compensarExcedente?, days: { 'AAAA-MM-DD': {...} } }
   * @param {string} today   'AAAA-MM-DD' (injetável para teste)
   */
  function compute(month, goal, today) {
    goal = goal || {};
    today = today || todayISO();
    const days = goal.days || {};
    const offDays = Array.isArray(goal.naoUteis) ? goal.naoUteis : defaultOffDays(month);
    const weeks = calendar(month, offDays);
    const { targets, info } = resolveTargets(goal.meta);
    const norm = normalizeMeta(goal.meta);
    const rowDefs = ROWS.filter((r) => !r.optional || norm.itens[r.stage].modo === 'custo');
    const compensar = !!goal.compensarExcedente;
    const workingDays = weeks.flatMap((w) => w.days.filter((d) => d.working));

    // Realizado por métrica e por data
    const realizedBy = {};
    for (const k of DAY_FIELDS) {
      realizedBy[k] = {};
      for (const [date, v] of Object.entries(days)) if (v && num(v[k]) != null) realizedBy[k][date] = num(v[k]);
    }
    const plan = {};
    for (const k of VOLUME) plan[k] = distribute(targets[k], weeks, realizedBy[k], today, compensar, k !== 'investimento');

    // Monta uma "linha" (por métrica) de um período: meta, base, realizado, tom
    const buildRows = (dates, metaOf, baseOf, closedCount, workingCount) => {
      const real = {};
      for (const k of DAY_FIELDS) real[k] = sum(dates.map((d) => realizedBy[k][d] ?? null));
      const rows = {};
      for (const r of ROWS) {
        if (r.kind === 'volume') {
          const meta = metaOf(r.key), base = baseOf(r.key), realizado = real[r.key];
          // Ritmo: realizado vs. a meta proporcional aos dias já encerrados
          const esperado = meta != null && workingCount ? (meta * closedCount) / workingCount : null;
          rows[r.key] = {
            meta, base, realizado,
            pct: meta ? (realizado == null ? null : realizado / meta) : null,
            falta: meta != null ? Math.max(meta - (realizado || 0), 0) : null,
            tone: closedCount > 0 ? toneVolume(realizado || 0, esperado) : null,
            raised: meta != null && base != null && meta > base * (1 + 1e-6) + EPS,
          };
        } else {
          const metaCost = info[r.stage].custo;
          const realizado = div(real[r.numerator], real[r.denominator]);
          rows[r.key] = { meta: metaCost, base: metaCost, realizado, pct: null, falta: null, tone: toneCost(realizado, metaCost), raised: false };
        }
      }
      return rows;
    };
    const closedIn = (ds) => ds.filter((d) => d.working && d.date < today).length;

    const weekOut = weeks.map((w) => {
      const working = w.days.filter((d) => d.working);
      const rows = buildRows(
        w.days.map((d) => d.date),
        (k) => (plan[k].week[w.n] ? plan[k].week[w.n].meta : null),
        (k) => (plan[k].week[w.n] ? plan[k].week[w.n].base : null),
        closedIn(w.days), working.length,
      );
      const dayOut = w.days.map((d) => {
        const dayRows = buildRows(
          [d.date],
          (k) => (plan[k].day[d.date] ? plan[k].day[d.date].meta : null),
          (k) => (plan[k].day[d.date] ? plan[k].day[d.date].base : null),
          0, 1,
        );
        const closed = d.working && d.date < today;
        for (const r of ROWS) {
          const c = dayRows[r.key];
          // Tom do dia: dia encerrado, ou hoje/futuro já com lançamento
          const hasEntry = r.kind === 'volume' ? c.realizado != null : (realizedBy[r.numerator][d.date] != null && realizedBy[r.denominator][d.date] != null);
          const evaluated = closed || (d.working && hasEntry);
          c.tone = !evaluated ? null : r.kind === 'volume' ? toneVolume(c.realizado || 0, c.meta) : toneCost(c.realizado, c.meta);
        }
        return {
          ...d, label: WEEKDAY_SHORT[d.dow], theme: DAY_THEME[d.dow],
          closed, isToday: d.date === today, rows: dayRows,
          hasEntry: DAY_FIELDS.some((f) => realizedBy[f][d.date] != null),
        };
      });
      return { n: w.n, from: working[0].date, to: working[working.length - 1].date, workingDays: working.length, days: dayOut, rows };
    });

    const allDates = weeks.flatMap((w) => w.days.map((d) => d.date));
    const monthRows = buildRows(
      allDates,
      (k) => targets[k],
      (k) => targets[k],
      closedIn(weeks.flatMap((w) => w.days)), workingDays.length,
    );

    const semLancamento = workingDays
      .filter((d) => d.date < today && !DAY_FIELDS.some((f) => realizedBy[f][d.date] != null))
      .map((d) => d.date);

    return {
      month, today, workingDays: workingDays.length, offDays, weeks: weekOut, rows: monthRows, rowDefs, info,
      hasTargets: VOLUME.some((k) => targets[k] != null), semLancamento,
    };
  }

  return {
    META_FIELDS, DAY_FIELDS, ROWS, STAGES, MODES, MODE_LABEL, DEFAULT_MODE, DAY_THEME, WEEKDAY_SHORT,
    compute, calendar, holidays, defaultOffDays, normalizeMeta, resolveTargets, planFromSales, planFromRevenue, revenueScenarios, investmentNeeded, isRealDate, todayISO, daysInMonth,
  };
});

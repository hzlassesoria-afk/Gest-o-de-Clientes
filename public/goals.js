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
 * Custo por lead (CPL) e custo por lead qualificado (CPLQ) são tetos: a meta é a
 * mesma em todos os níveis e o realizado é investimento ÷ leads do período.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Goals = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Metas que o usuário informa no mês
  const META_FIELDS = ['investimento', 'cpl', 'cplQualificado', 'cotacoes', 'negociacoes', 'vendas'];
  // Realizado que o usuário lança por dia (valores brutos)
  const DAY_FIELDS = ['investimento', 'leads', 'leadsQualificados', 'cotacoes', 'negociacoes', 'vendas'];
  // Métricas de volume: somam entre dias e semanas e têm compensação
  const VOLUME = ['investimento', 'leads', 'leadsQualificados', 'cotacoes', 'negociacoes', 'vendas'];
  // Linhas exibidas, na ordem do funil
  const ROWS = [
    { key: 'investimento', label: 'Valor investido', fmt: 'brl', kind: 'volume', input: true },
    { key: 'leads', label: 'Leads', fmt: 'dec', kind: 'volume', input: true, support: true },
    { key: 'cpl', label: 'Custo por lead', fmt: 'brl', kind: 'cost', numerator: 'investimento', denominator: 'leads' },
    { key: 'leadsQualificados', label: 'Leads qualificados', fmt: 'dec', kind: 'volume', input: true, support: true },
    { key: 'cplQualificado', label: 'Custo por lead qualificado', fmt: 'brl', kind: 'cost', numerator: 'investimento', denominator: 'leadsQualificados' },
    { key: 'cotacoes', label: 'Cotação', fmt: 'dec', kind: 'volume', input: true },
    { key: 'negociacoes', label: 'Negociação', fmt: 'dec', kind: 'volume', input: true },
    { key: 'vendas', label: 'Vendas', fmt: 'dec', kind: 'volume', input: true },
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
  function monthlyTargets(meta) {
    const m = meta || {};
    const inv = num(m.investimento), cpl = num(m.cpl), cplq = num(m.cplQualificado);
    return {
      investimento: inv,
      leads: div(inv, cpl),
      leadsQualificados: div(inv, cplq),
      cotacoes: num(m.cotacoes),
      negociacoes: num(m.negociacoes),
      vendas: num(m.vendas),
    };
  }

  /**
   * Distribui a meta de UMA métrica de volume por semanas e dias úteis, com compensação.
   * @returns {{ week: Object<number,{meta,base}>, day: Object<string,{meta,base}> }}
   */
  function distribute(total, weeks, realized, today, compensarExcedente) {
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

  const sum = (vals) => {
    let t = null;
    for (const v of vals) if (v != null) t = (t || 0) + v;
    return t;
  };

  function toneVolume(realizado, meta) {
    if (meta == null || realizado == null || meta <= 0) return null;
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
    const targets = monthlyTargets(goal.meta);
    const compensar = !!goal.compensarExcedente;
    const workingDays = weeks.flatMap((w) => w.days.filter((d) => d.working));

    // Realizado por métrica e por data
    const realizedBy = {};
    for (const k of DAY_FIELDS) {
      realizedBy[k] = {};
      for (const [date, v] of Object.entries(days)) if (v && num(v[k]) != null) realizedBy[k][date] = num(v[k]);
    }
    const plan = {};
    for (const k of VOLUME) plan[k] = distribute(targets[k], weeks, realizedBy[k], today, compensar);

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
          const metaCost = num(r.key === 'cpl' ? (goal.meta || {}).cpl : (goal.meta || {}).cplQualificado);
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
      month, today, workingDays: workingDays.length, offDays, weeks: weekOut, rows: monthRows,
      hasTargets: VOLUME.some((k) => targets[k] != null), semLancamento,
    };
  }

  return {
    META_FIELDS, DAY_FIELDS, ROWS, DAY_THEME, WEEKDAY_SHORT,
    compute, calendar, holidays, defaultOffDays, monthlyTargets, isRealDate, todayISO, daysInMonth,
  };
});

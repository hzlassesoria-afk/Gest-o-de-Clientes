/*
 * Infográfico da meta: uma métrica por vez, dia a dia (barras: realizado; traço: meta do dia)
 * ou acumulada no mês (linha do realizado contra a linha da meta). Gera SVG como texto.
 * Arquivo UMD: roda no navegador (window.GoalChart) e no Node (require).
 *
 * As cores vêm de classes CSS (.gc-*) definidas nas folhas de estilo, para seguir o tema.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GoalChart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const WEEKDAY_INITIAL = { Seg: 'S', Ter: 'T', Qua: 'Q', Qui: 'Q', Sex: 'S' };

  /** Passo "redondo" para o eixo: 1, 2, 2,5, 5 × 10^n, com ~4 divisões. */
  function niceStep(max) {
    const raw = max / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  }

  /**
   * Pontos do gráfico: um por dia útil do mês.
   * Cada ponto: { date, day, weekday, isToday, closed, meta, real, hasEntry }
   *  - modo 'dia':  meta = meta do dia; real = realizado do dia (custo: razão do dia)
   *  - modo 'acum': meta = meta-base acumulada (custo: teto); real = realizado acumulado (custo: razão acumulada)
   */
  function points(res, plan, key, mode) {
    const row = res.rowDefs.find((r) => r.key === key) || res.rowDefs[0];
    const out = [];
    const days = [];
    for (const w of res.weeks) for (const d of w.days) if (d.working) days.push(d);
    const raw = (d) => ((plan.days || {})[d.date]) || {};
    let accNum = 0, accDen = 0, accReal = 0, accMeta = 0, seenEntry = false;
    for (const d of days) {
      const cell = d.rows[row.key];
      const r = raw(d);
      let meta, real, hasEntry;
      if (row.kind === 'volume') {
        hasEntry = num(r[row.key]) != null;
        if (mode === 'acum') {
          accMeta += cell.base || 0;
          if (hasEntry) accReal += num(r[row.key]);
          meta = accMeta;
          // A linha do realizado vai até o último dia já encerrado ou lançado
          const upto = d.closed || hasEntry || d.isToday;
          real = upto ? accReal : null;
          if (hasEntry) seenEntry = true;
        } else {
          meta = cell.meta;
          real = hasEntry ? num(r[row.key]) : null;
        }
      } else {
        const n = num(r[row.numerator]), q = num(r[row.denominator]);
        hasEntry = n != null && q != null;
        if (mode === 'acum') {
          if (hasEntry) { accNum += n; accDen += q; }
          real = accDen > 0 ? accNum / accDen : null;
        } else {
          real = hasEntry && q > 0 ? n / q : null;
        }
        meta = cell.meta;
      }
      out.push({ date: d.date, day: d.date.slice(8), dm: d.date.slice(8) + '/' + d.date.slice(5, 7), weekday: d.label, isToday: !!d.isToday, closed: !!d.closed, meta, real, hasEntry });
    }
    return { row, points: out };
  }

  /**
   * @param {object} o  { res, plan, key, mode: 'dia'|'acum', fmtVal(row, v) -> texto }
   * @returns {string}  HTML: legenda + SVG + resumo
   */
  function build(o) {
    const mode = o.mode === 'acum' ? 'acum' : 'dia';
    const { row, points: pts } = points(o.res, o.plan, o.key, mode);
    const fv = o.fmtVal;
    const short = (v) => (v == null ? '' : row.fmt === 'brl' ? String(Math.round(v)) : String(Math.round(v * 10) / 10).replace('.', ','));
    if (!pts.length) return '<div class="gc-empty">Sem dias úteis neste mês.</div>';

    const vals = pts.flatMap((p) => [p.meta, p.real]).filter((v) => v != null && Number.isFinite(v));
    const max = Math.max(...vals, 0);
    const step = niceStep(max > 0 ? max * 1.08 : 1);
    const yMax = Math.max(step * Math.ceil((max * 1.08 || 1) / step), step);
    const W = 760, H = 300, padL = 48, padR = 14, padT = 22, padB = 44;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const y = (v) => padT + innerH * (1 - v / yMax);
    const slot = innerW / pts.length;
    const cx = (i) => padL + slot * i + slot / 2;

    let grid = '';
    for (let t = 0; t <= yMax + 1e-9; t += step) {
      const yy = y(t);
      grid += `<line class="gc-grid" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"/>`
        + `<text class="gc-axis" x="${padL - 8}" y="${yy + 4}" text-anchor="end">${esc(short(t))}</text>`;
    }

    const labels = pts.map((p, i) => `<g><text class="gc-day${p.isToday ? ' gc-today' : ''}" x="${cx(i)}" y="${H - padB + 16}" text-anchor="middle">${esc(p.day)}</text>`
      + `<text class="gc-wd" x="${cx(i)}" y="${H - padB + 30}" text-anchor="middle">${esc(WEEKDAY_INITIAL[p.weekday] || '')}</text></g>`).join('');

    let marks = '';
    if (mode === 'dia') {
      const bw = Math.max(Math.min(slot * 0.58, 28), 4);
      marks = pts.map((p, i) => {
        const x = cx(i);
        const tip = `${p.weekday} ${p.dm} · Meta ${p.meta == null ? '—' : fv(row, p.meta)} · Realizado ${p.real == null ? '—' : fv(row, p.real)}`;
        let g = `<g><title>${esc(tip)}</title>`;
        if (p.real != null) {
          const h = Math.max(y(0) - y(p.real), p.real > 0 ? 2 : 0);
          g += `<rect class="gc-bar" x="${x - bw / 2}" y="${y(0) - h}" width="${bw}" height="${h}" rx="2"/>`;
          if (slot >= 22) g += `<text class="gc-val" x="${x}" y="${y(0) - h - 5}" text-anchor="middle">${esc(short(p.real))}</text>`;
        }
        if (p.meta != null) g += `<line class="gc-meta" x1="${x - bw / 2 - 4}" y1="${y(p.meta)}" x2="${x + bw / 2 + 4}" y2="${y(p.meta)}"/>`;
        return g + '<rect class="gc-hit" x="' + (x - slot / 2) + '" y="' + padT + '" width="' + slot + '" height="' + innerH + '"/></g>';
      }).join('');
    } else {
      const line = (get) => {
        let d = '', started = false;
        pts.forEach((p, i) => {
          const v = get(p);
          if (v == null) return;
          d += `${started ? 'L' : 'M'}${cx(i).toFixed(1)} ${y(v).toFixed(1)} `;
          started = true;
        });
        return d.trim();
      };
      const metaPath = line((p) => p.meta), realPath = line((p) => p.real);
      const dots = pts.map((p, i) => (p.real == null ? '' : `<circle class="gc-dot" cx="${cx(i)}" cy="${y(p.real)}" r="3.2"><title>${esc(`${p.weekday} ${p.dm} · ${row.kind === 'cost' ? 'Custo acumulado' : 'Realizado acumulado'} ${fv(row, p.real)} · Meta ${p.meta == null ? '—' : fv(row, p.meta)}`)}</title></circle>`)).join('');
      marks = (metaPath ? `<path class="gc-line-meta" d="${metaPath}"/>` : '') + (realPath ? `<path class="gc-line-real" d="${realPath}"/>` : '') + dots;
      const last = [...pts].reverse().find((p) => p.real != null);
      if (last) {
        const i = pts.indexOf(last);
        marks += `<text class="gc-val gc-end" x="${Math.min(cx(i), W - padR - 4)}" y="${y(last.real) - 9}" text-anchor="middle">${esc(short(last.real))}</text>`;
      }
    }

    const m = o.res.rows[row.key];
    let caption = '';
    if (row.kind === 'volume') {
      caption = m.meta != null
        ? `No mês: <b>${esc(fv(row, m.realizado || 0))}</b> de ${esc(fv(row, m.meta))}${m.pct != null ? ` (${Math.round(m.pct * 100)}%)` : ''}`
        : `No mês: <b>${esc(fv(row, m.realizado || 0))}</b> (sem meta definida)`;
    } else {
      caption = `Teto: ${m.meta != null ? esc(fv(row, m.meta)) : '—'}${m.realizado != null ? ` · No mês: <b>${esc(fv(row, m.realizado))}</b>` : ''}`;
    }
    const legend = mode === 'dia'
      ? `<span class="gc-key"><i class="gc-sw gc-sw-bar"></i>${row.kind === 'cost' ? 'Custo do dia' : 'Realizado'}</span><span class="gc-key"><i class="gc-sw gc-sw-meta"></i>${row.kind === 'cost' ? 'Teto' : 'Meta do dia'}</span>`
      : `<span class="gc-key"><i class="gc-sw gc-sw-real"></i>${row.kind === 'cost' ? 'Custo acumulado' : 'Realizado acumulado'}</span><span class="gc-key"><i class="gc-sw gc-sw-dash"></i>${row.kind === 'cost' ? 'Teto' : 'Meta acumulada'}</span>`;

    return `<div class="gc-legend">${legend}<span class="gc-unit">${row.fmt === 'brl' ? 'valores em R$' : 'quantidade'}</span></div>
      <svg class="gc-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(row.label)} por dia útil (${mode === 'dia' ? 'dia a dia' : 'acumulado'})">
        ${grid}${marks}${labels}
      </svg>
      <div class="gc-caption">${caption}</div>`;
  }

  return { build, points, niceStep };
});

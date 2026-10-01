/*
 * Funil comercial em formato de funil (SVG): Leads → Leads qualificados → Cotações → Negociação → Vendas,
 * com a taxa de conversão entre cada etapa. Arquivo UMD: roda no navegador (window.Funnel) e no Node.
 *
 * Largura de cada etapa é proporcional ao volume (com um piso, para a etapa final continuar legível);
 * o número exato e a conversão aparecem escritos. Cores vêm de classes CSS (.fn-*).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Funnel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

  // Etapas do funil (a de "responderam o 1º contato" fica só nos cards).
  const STAGES = [
    { key: 'leads', label: 'Leads' },
    { key: 'leadsQualificados', label: 'Leads qualificados' },
    { key: 'cotacoes', label: 'Cotações enviadas' },
    { key: 'negociacoes', label: 'Em negociação' },
    { key: 'vendas', label: 'Vendas' },
  ];

  /**
   * Etapas com valor, largura relativa (0–1) e conversão sobre a etapa anterior.
   * `conversion` é % (0–100+) ou null quando não dá para calcular (valor ausente ou etapa anterior zerada).
   */
  function stages(m) {
    const vals = STAGES.map((s) => ({ ...s, value: num(m && m[s.key]) }));
    const max = Math.max(0, ...vals.map((s) => s.value || 0));
    return vals.map((s, i) => {
      const prev = i ? vals[i - 1].value : null;
      return {
        ...s,
        share: max ? (s.value || 0) / max : 0,
        conversion: i && s.value != null && prev ? (s.value / prev) * 100 : null,
      };
    });
  }

  /** Conversão do topo ao fim do funil (vendas ÷ leads), % ou null. */
  function overall(m) {
    const leads = num(m && m.leads), vendas = num(m && m.vendas);
    return leads && vendas != null ? (vendas / leads) * 100 : null;
  }

  const W = 360, TIER = 66, GAP = 34, FLOOR = 0.46, TAPER = 0.8;

  /**
   * HTML do funil. `fmtInt` e `fmtPct` formatam número e percentual (pt-BR no app).
   * Devolve string vazia quando não há nenhum valor.
   */
  function build({ m, fmtInt, fmtPct }) {
    const st = stages(m);
    if (!st.some((s) => s.value)) return '';
    const widths = st.map((s) => W * (FLOOR + (1 - FLOOR) * s.share));
    const H = st.length * TIER + (st.length - 1) * GAP;
    const tiers = st.map((s, i) => {
      const top = widths[i];
      const bottom = top * TAPER;
      const y = i * (TIER + GAP);
      const cx = W / 2;
      const d = `M${cx - top / 2},${y} L${cx + top / 2},${y} L${cx + bottom / 2},${y + TIER} L${cx - bottom / 2},${y + TIER} Z`;
      const value = s.value == null ? '—' : fmtInt(s.value);
      let out = `<path class="fn-tier fn-t${i}" d="${d}" stroke-linejoin="round"/>
        <text class="fn-num" x="${cx}" y="${y + TIER / 2 + 2}" text-anchor="middle">${esc(value)}</text>
        <text class="fn-label" x="${cx}" y="${y + TIER / 2 + 20}" text-anchor="middle">${esc(s.label)}</text>`;
      if (i) {
        const gy = y - GAP;
        const conv = s.conversion == null ? 'sem dados' : `${fmtPct(s.conversion)} de conversão`;
        out += `<path class="fn-arrow" d="M${cx},${gy + 4} L${cx},${y - 4} M${cx - 5},${y - 10} L${cx},${y - 4} L${cx + 5},${y - 10}" fill="none"/>
          <text class="fn-conv" x="${cx + 14}" y="${gy + GAP / 2 + 4}">${esc(conv)}</text>`;
      }
      return out;
    }).join('');
    const label = st.map((s) => `${s.label}: ${s.value == null ? 'sem dado' : fmtInt(s.value)}`).join('; ');
    const total = overall(m);
    return `<svg class="fn-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Funil comercial. ${esc(label)}">${tiers}</svg>`
      + (total != null ? `<div class="fn-total">Conversão total (leads → vendas): <b>${esc(fmtPct(total))}</b></div>` : '');
  }

  return { STAGES, stages, overall, build };
});

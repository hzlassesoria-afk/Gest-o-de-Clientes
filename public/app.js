'use strict';

// ---------- utilidades ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nfInt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nfDec = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const nfBrl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = {
  int: (v) => nfInt.format(v),
  dec: (v) => nfDec.format(v),
  brl: (v) => nfBrl.format(v),
  pct: (v) => nfDec.format(v) + '%',
  x: (v) => nfDec.format(v).replace(/\.0$/, '') + 'x',
  dias: (v) => nfInt.format(v) + (v === 1 ? ' dia' : ' dias'),
  meses: (v) => nfDec.format(v) + (Math.round(v * 10) / 10 === 1 ? ' mês' : ' meses'),
  nps: (v) => (v > 0 ? '+' : '') + nfDec.format(v),
};
const show = (v, f) => (v == null ? null : fmt[f](v));

const MONTH_NAMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (k) => `${MONTH_NAMES[Number(k.slice(5, 7)) - 1]}/${k.slice(2, 4)}`;
const currentMonth = () => new Date().toISOString().slice(0, 7);

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

// ---------- estado ----------
const state = { clients: [], client: null, period: null, view: 'periodo', chartMetric: 'roas', goalMonth: null, gcKey: 'vendas', gcMode: 'dia', saveChain: Promise.resolve() };

// ---------- roteamento: #/<cliente>/<aba> ----------
function parseRoute() {
  const [, id, tab] = location.hash.split('/');
  return { id: id || null, tab: tab === 'monday' || tab === 'metas' ? tab : 'metricas' };
}

async function render() {
  const route = parseRoute();
  state.clients = await api('/clients');
  if (!route.id && state.clients.length) { location.hash = `#/${state.clients[0].id}/metricas`; return; }

  $('#client-list').innerHTML = state.clients.map((c) =>
    `<a href="#/${esc(c.id)}/metricas" ${c.id === route.id ? 'aria-current="page"' : ''}>${esc(c.name)}</a>`).join('');

  if (!route.id) { $('#main').innerHTML = '<div class="empty-state">Nenhum cliente ainda. Clique em “Novo cliente”.</div>'; return; }

  try {
    if (!state.client || state.client.id !== route.id) state.period = null;
    state.client = await api(`/clients/${encodeURIComponent(route.id)}`);
  } catch (err) {
    $('#main').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`; return;
  }
  const c = state.client;

  $('#main').innerHTML = `
    <div class="page-head">
      <div><h1>${esc(c.name)}</h1><div class="sub">${esc(c.segment || '')}</div></div>
    </div>
    <div class="tabs" role="tablist">
      <a href="#/${esc(c.id)}/metricas" ${route.tab === 'metricas' ? 'aria-current="page"' : ''}>Métricas do Projeto</a>
      <a href="#/${esc(c.id)}/metas" ${route.tab === 'metas' ? 'aria-current="page"' : ''}>Metas (Rotina Comercial)</a>
      <a href="#/${esc(c.id)}/monday" ${route.tab === 'monday' ? 'aria-current="page"' : ''}>Entrada de Clientes (Monday)</a>
    </div>
    <div id="tab"></div>`;

  if (route.tab === 'metricas') renderMetrics(); else if (route.tab === 'metas') renderGoals(); else renderMonday();
}

// ---------- aba: Métricas ----------
function monthOptions(c) {
  const keys = new Set(Object.keys(c.months));
  keys.add(currentMonth());
  return [...keys].sort().reverse();
}

function renderMetrics() {
  const c = state.client;
  const opts = monthOptions(c);
  if (!state.period) {
    const withData = Object.keys(c.months).sort().reverse()[0];
    state.period = withData || currentMonth();
  }
  if (state.view === 'mes') return renderMonthly();
  const keys = state.period === 'all' ? Object.keys(c.months).sort() : [state.period];
  const m = Metrics.compute(c, keys);

  // Comparação com o mês anterior (só quando um único mês está selecionado)
  const prevKey = state.period === 'all' ? null : Object.keys(c.months).sort().filter((k) => k < state.period).pop();
  const mp = prevKey ? Metrics.compute(c, [prevKey]) : null;
  const dlt = (key) => deltaHtml(Metrics.change(m[key], mp && mp[key], Metrics.INDICATOR_BY_KEY[key]), prevKey);
  const hasData = keys.some((k) => c.months[k] && Object.values(c.months[k]).some((v) => v != null && v !== ''));

  const card = (label, value, f, note, cls = '') => {
    const v = show(value, f);
    return `<div class="card ${cls}"><div class="label">${esc(label)}</div>
      <div class="value ${v == null ? 'empty' : ''}">${v == null ? '—' : esc(v)}</div>
      ${note ? `<div class="note">${note}</div>` : ''}</div>`;
  };
  const ofLeads = (v) => (v != null && m.leads ? `${fmt.pct((v / m.leads) * 100)} dos leads` : '');

  const bandCls = { 'Saudável': 'good', 'Atenção': 'warn', 'Risco': 'bad' }[m.healthBand] || '';
  const ansCls = { Baixo: 'good', 'Médio': 'warn', Alto: 'bad' }[m.nivelAnsiedade] || '';
  const mondayHint = c.project.contractDate || c.project.startDate ? '' : ' Preencha as datas em “Dados do projeto”.';

  $('#tab').innerHTML = `
    ${toolbarHtml(c, true)}
    ${demoBanner(c, hasData, mondayHint)}

    <h2 class="section">Métricas de resultado do cliente</h2>
    <div class="resultado">
    <div class="grid">
      ${card('Investimento no Meta', m.investimento, 'brl', dlt('investimento'))}
      ${card('Leads', m.leads, 'int', dlt('leads'))}
      ${card('Custo por lead (CPL)', m.cpl, 'brl', dlt('cpl'))}
      ${card('Leads qualificados', m.leadsQualificados, 'int', ofLeads(m.leadsQualificados) + dlt('leadsQualificados'))}
      ${card('Custo por lead qualificado', m.cplQualificado, 'brl', dlt('cplQualificado'))}
      ${card('Responderam o 1º contato', m.leadsResponderam, 'int', ofLeads(m.leadsResponderam) + dlt('leadsResponderam'))}
      ${card('Cotações enviadas', m.cotacoes, 'int', ofLeads(m.cotacoes) + dlt('cotacoes'))}
      ${card('Pararam de responder (pós 7 dias de follow-up)', m.pararamResponder, 'int', dlt('pararamResponder'))}
      ${card('Em negociação', m.negociacoes, 'int', dlt('negociacoes'))}
      ${card('Vendas', m.vendas, 'int', ofLeads(m.vendas) + dlt('vendas'))}
      ${card('Ticket médio', m.ticketMedio, 'brl', (m.receita != null ? `Receita gerada: ${esc(fmt.brl(m.receita))}` : '') + dlt('ticketMedio'))}
      ${card('ROAS', m.roas, 'x', 'Receita ÷ investimento no Meta' + dlt('roas'))}
      ${card('CAC', m.cac, 'brl', (c.project.cacIncludesFee === false ? 'Investimento ÷ vendas' : '(Investimento + mensalidade) ÷ vendas') + dlt('cac'))}
    </div>
    <aside class="panel fn-panel" aria-label="Funil comercial">
      <h3 class="fn-title">Funil comercial</h3>
      ${funnelHtml(m)}
    </aside>
    </div>

    <h2 class="section">Métricas de gestão</h2>
    <div class="grid">
      ${card('Tempo de projeto', m.tempoProjetoMeses, 'meses', c.project.startDate ? `Desde ${esc(c.project.startDate.split('-').reverse().join('/'))}` : 'Informe o início em “Dados do projeto”')}
      ${card('Taxa de inadimplência', m.taxaInadimplencia, 'pct', 'Inadimplente ÷ faturado' + dlt('taxaInadimplencia'))}
      ${card('MRR', m.mrr, 'brl', dlt('mrr'))}
      ${card('Time to Value: contrato → campanhas no ar', m.timeToValueCampanhaDias, 'dias')}
      ${card('Time to Value: campanhas → 1ª venda', m.timeToValuePrimeiraVendaDias, 'dias',
        m.timeToValueContratoPrimeiraVendaDias != null ? `Contrato → 1ª venda: ${esc(fmt.dias(m.timeToValueContratoPrimeiraVendaDias))}` : '')}
      ${card('NPS', m.nps, 'nps', (state.period === 'all' ? 'Média dos meses informados' : 'No mês') + dlt('nps'))}
      <div class="card"><div class="label">Health Score</div>
        <div class="value ${m.healthScore == null ? 'empty' : ''}">${m.healthScore == null ? '—' : esc(m.healthScore)}
          ${m.healthBand ? `<span class="pill ${bandCls}">${esc(m.healthBand)}</span>` : ''}</div>
        <div class="note">${healthNote(m)}${dlt('healthScore')}</div></div>
      ${card('Índice de reclamação', m.indiceReclamacao, 'pct', 'Reclamações ÷ contatos do cliente' + dlt('indiceReclamacao'))}
      <div class="card"><div class="label">Reuniões de alinhamento</div>
        <div class="value ${m.reunioesRealizadas == null ? 'empty' : ''}">${m.reunioesRealizadas == null ? '—' : esc(fmt.int(m.reunioesRealizadas)) + (m.reunioesPlanejadas != null ? ` / ${esc(fmt.int(m.reunioesPlanejadas))}` : '')}</div>
        <div class="note">${m.aderenciaReunioes != null ? `Aderência: ${esc(fmt.pct(m.aderenciaReunioes * 100))}` : 'Realizadas / planejadas'}${dlt('aderenciaReunioesPct')}</div></div>
      <div class="card"><div class="label">Alinhamento de expectativa (ansiedade)</div>
        <div class="value ${m.nivelAnsiedade == null ? 'empty' : ''}">${m.nivelAnsiedade == null ? '—' : `<span class="pill ${ansCls}">${esc(m.nivelAnsiedade)}</span>`}</div>
        <div class="note">${m.contatosEspontaneosSemana != null ? `${esc(fmt.dec(m.contatosEspontaneosSemana))} contatos espontâneos/semana` : 'Contatos fora do horário ou cobrando venda'}${dlt('contatosEspontaneosSemana')}</div></div>
      ${card('Dinheiro coletado', m.dinheiroColetado, 'brl', dlt('dinheiroColetado'))}
    </div>

    <h2 class="section">Evolução mensal</h2>
    ${trendHtml(c)}
  `;

  bindToolbar();
  bindDemo();
}

function toolbarHtml(c, showPeriod) {
  const pressed = (v) => (state.view === v ? 'true' : 'false');
  return `<div class="toolbar">
      <div class="seg" role="group" aria-label="Tipo de análise">
        <button type="button" data-view="periodo" aria-pressed="${pressed('periodo')}">Período</button>
        <button type="button" data-view="mes" aria-pressed="${pressed('mes')}">Mês a mês</button>
      </div>
      ${showPeriod ? `<label>Mês
        <select id="period">
          <option value="all" ${state.period === 'all' ? 'selected' : ''}>Acumulado</option>
          ${monthOptions(c).map((k) => `<option value="${k}" ${state.period === k ? 'selected' : ''}>${monthLabel(k)}</option>`).join('')}
        </select>
      </label>` : ''}
      <span class="spacer"></span>
      <button class="btn btn-ghost" id="edit-project">Dados do projeto</button>
      <button class="btn" id="edit-month">Registrar dados do mês</button>
    </div>`;
}

function bindToolbar() {
  document.querySelectorAll('.seg button').forEach((b) => {
    b.onclick = () => { state.view = b.dataset.view; renderMetrics(); };
  });
  const period = $('#period');
  if (period) period.onchange = (e) => { state.period = e.target.value; renderMetrics(); };
  $('#edit-month').onclick = () => openMonthDialog(state.period && state.period !== 'all' ? state.period : currentMonth());
  $('#edit-project').onclick = openProjectDialog;
}

function bindDemo() {
  const loadBtn = $('#load-demo'), clearBtn = $('#clear-demo');
  if (loadBtn) loadBtn.onclick = () => demoAction('POST', loadBtn);
  if (clearBtn) clearBtn.onclick = () => {
    if (confirm('Remover os meses simulados? Meses que você editou ou lançou continuam.')) demoAction('DELETE', clearBtn);
  };
}

function deltaHtml(ch, prevKey) {
  if (!ch || !prevKey) return '';
  const arrow = ch.dir === 'up' ? '▲' : ch.dir === 'down' ? '▼' : '▬';
  const abs = Math.abs(ch.value);
  const text = ch.dir === 'flat' ? 'igual'
    : ch.kind === 'rel' ? `${fmt.dec(abs)}%` : `${fmt.dec(abs)}${ch.unit ? ' ' + ch.unit : ''}`;
  return `<div class="delta ${ch.tone}"><span>${arrow} ${esc(text)}</span> <span class="vs">vs ${esc(monthLabel(prevKey))}</span></div>`;
}

function demoBanner(c, hasData, mondayHint) {
  const demo = Object.keys(c.months).filter((k) => c.months[k]._demo).sort();
  if (demo.length) {
    return `<div class="notice warn"><b>Dados simulados</b> (exemplo, não são do cliente): ${demo.map(monthLabel).map(esc).join(', ')}.
      Para lançar os números reais, abra “Registrar dados do mês” no mês desejado e salve: ele deixa de ser simulado.
      <button class="btn btn-danger" id="clear-demo" style="margin-left:8px;padding:4px 10px">Limpar dados simulados</button></div>`;
  }
  if (!Object.keys(c.months).length) {
    return `<div class="notice warn">Ainda não há dados. Lance os números em “Registrar dados do mês” ou veja como o painel fica com dados de exemplo.${esc(mondayHint)}
      <button class="btn" id="load-demo" style="margin-left:8px;padding:4px 10px">Carregar dados de exemplo</button></div>`;
  }
  return hasData ? '' : `<div class="notice warn">Ainda não há dados neste período. Use “Registrar dados do mês” para lançar os números.${esc(mondayHint)}</div>`;
}

async function demoAction(method, btn) {
  btn.disabled = true;
  try {
    await api(`/clients/${encodeURIComponent(state.client.id)}/demo`, { method });
    state.period = null;
    await render();
  } catch (err) { btn.disabled = false; alert(err.message); }
}

function renderMonthly() {
  const c = state.client;
  const rows = Metrics.series(c);
  const flat = Metrics.INDICATORS.flatMap((g) => g.items);
  if (!flat.some((d) => d.key === state.chartMetric)) state.chartMetric = 'roas';

  const head = rows.map((r) => `<th>${esc(monthLabel(r.month))}${c.months[r.month]._demo ? '<br><span class="pill warn">simulado</span>' : ''}</th>`).join('');
  const body = Metrics.INDICATORS.map((g) => `
    <tr class="grp"><td colspan="${rows.length + 1}">${esc(g.group)}</td></tr>
    ${g.items.map((d) => `<tr><td>${esc(d.label)}</td>${rows.map((r, i) => {
      const v = r[d.key];
      const ch = i ? Metrics.change(v, rows[i - 1][d.key], d) : null;
      return `<td>${v == null ? '<span class="na">—</span>' : esc(fmt[d.fmt](v))}${ch ? deltaHtml(ch, rows[i - 1].month).replace(/ <span class="vs">.*<\/span>/, '') : ''}</td>`;
    }).join('')}</tr>`).join('')}`).join('');

  $('#tab').innerHTML = `
    ${toolbarHtml(c, false)}
    ${demoBanner(c, true, '')}
    ${rows.length ? `
    <div class="panel" style="margin-bottom:16px">
      <label>Gráfico da métrica
        <select id="chart-metric">${Metrics.INDICATORS.map((g) => `<optgroup label="${esc(g.group)}">${g.items.map((d) => `<option value="${d.key}" ${d.key === state.chartMetric ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</optgroup>`).join('')}</select>
      </label>
      <div id="metric-chart">${metricChartHtml(rows, Metrics.INDICATOR_BY_KEY[state.chartMetric])}</div>
    </div>
    <div class="panel scroll"><table class="data mm"><thead><tr><th>Indicador</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="hint">A seta compara cada mês com o mês anterior com dados. Verde = melhorou, vermelho = piorou (custo menor é melhor); cinza = neutro (ex.: investimento).</div>`
    : '<div class="panel empty-state">Lance os dados de pelo menos um mês para ver a análise mês a mês.</div>'}`;

  bindToolbar();
  bindDemo();
  const sel = $('#chart-metric');
  if (sel) sel.onchange = (e) => {
    state.chartMetric = e.target.value;
    $('#metric-chart').innerHTML = metricChartHtml(rows, Metrics.INDICATOR_BY_KEY[state.chartMetric]);
  };
}

// Barras de uma métrica por mês, com o valor sobre cada barra (aceita valores negativos, ex.: NPS)
function metricChartHtml(rows, def) {
  const pts = rows.map((r) => ({ month: r.month, v: r[def.key] }));
  const vals = pts.map((p) => p.v).filter((v) => v != null);
  if (!vals.length) return '<div class="empty-state">Sem dados desta métrica.</div>';
  const W = 720, H = 240, padL = 16, padR = 16, padT = 26, padB = 30;
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / span);
  const slot = (W - padL - padR) / pts.length;
  const bw = Math.min(48, slot * 0.55);
  const bars = pts.map((p, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    const label = `<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(monthLabel(p.month))}</text>`;
    if (p.v == null) return label + `<text x="${x + bw / 2}" y="${y(0) - 6}" text-anchor="middle">—</text>`;
    const top = Math.min(y(p.v), y(0)), h = Math.max(Math.abs(y(p.v) - y(0)), 1);
    const ly = p.v >= 0 ? top - 6 : top + h + 12;
    return `<rect x="${x}" y="${top}" width="${bw}" height="${h}" rx="3" fill="var(--bar)"><title>${esc(monthLabel(p.month))}: ${esc(fmt[def.fmt](p.v))}</title></rect>
      <text class="val" x="${x + bw / 2}" y="${ly}" text-anchor="middle">${esc(fmt[def.fmt](p.v))}</text>${label}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(def.label)} por mês">
    <line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" stroke="var(--border)"/>${bars}</svg>`;
}

function healthNote(m) {
  if (m.healthScore == null) return 'Calculado com NPS, ROAS vs meta, inadimplência, ansiedade, reuniões e reclamações';
  if (m.healthScoreManual) return 'Valor informado manualmente';
  return 'Calculado: ' + m.healthScoreAuto.parts.map((p) => esc(p.key)).join(', ');
}

function funnelHtml(m) {
  const svg = Funnel.build({ m, fmtInt: fmt.int, fmtPct: fmt.pct });
  if (!svg) return '<div class="empty-state">Sem dados de funil neste período.</div>';
  const lost = m.pararamResponder != null
    ? `<div class="lost">${esc(fmt.int(m.pararamResponder))} lead(s) pararam de responder após o envio da cotação e 7 dias de follow-up${m.cotacoes ? ` (${esc(fmt.pct((m.pararamResponder / m.cotacoes) * 100))} das cotações)` : ''}.</div>` : '';
  return svg + lost;
}

function trendHtml(c) {
  const rows = Metrics.series(c);
  if (!rows.length) return '<div class="panel empty-state">A evolução aparece aqui depois do primeiro lançamento mensal.</div>';
  const cell = (v, f) => (v == null ? '—' : esc(fmt[f](v)));
  const table = `<div class="panel scroll"><table class="data"><thead><tr>
    <th>Mês</th><th>Investimento</th><th>Leads</th><th>CPL</th><th>Qualificados</th><th>Vendas</th><th>Receita</th><th>ROAS</th><th>CAC</th><th>NPS</th><th>Health</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${esc(monthLabel(r.month))}${c.months[r.month] && c.months[r.month]._demo ? ' <span class="pill warn">simulado</span>' : ''}</td><td>${cell(r.investimento, 'brl')}</td><td>${cell(r.leads, 'int')}</td><td>${cell(r.cpl, 'brl')}</td>
    <td>${cell(r.leadsQualificados, 'int')}</td><td>${cell(r.vendas, 'int')}</td><td>${cell(r.receita, 'brl')}</td>
    <td>${cell(r.roas, 'x')}</td><td>${cell(r.cac, 'brl')}</td><td>${cell(r.nps, 'nps')}</td><td>${cell(r.healthScore, 'int')}</td>
    </tr>`).join('')}</tbody></table></div>`;
  return chartHtml(rows) + table;
}

// Barras agrupadas: investimento x receita por mês
function chartHtml(rows) {
  const data = rows.filter((r) => r.investimento != null || r.receita != null);
  if (!data.length) return '';
  const W = 720, H = 220, padL = 92, padB = 28, padT = 16;
  const max = Math.max(...data.flatMap((r) => [r.investimento || 0, r.receita || 0]), 1);
  const slot = (W - padL - 10) / data.length;
  const bw = Math.min(28, slot / 3);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const bars = data.map((r, i) => {
    const x0 = padL + slot * i + slot / 2;
    const bar = (v, dx, cls, label) => v == null ? '' :
      `<rect x="${x0 + dx}" y="${y(v)}" width="${bw}" height="${H - padB - y(v)}" rx="3" fill="var(${cls})"><title>${esc(label)}: ${esc(fmt.brl(v))}</title></rect>`;
    return bar(r.investimento, -bw - 1, '--bar-2', 'Investimento') + bar(r.receita, 1, '--bar', 'Receita') +
      `<text x="${x0}" y="${H - 8}" text-anchor="middle">${esc(monthLabel(r.month))}</text>`;
  }).join('');
  return `<div class="panel" style="margin-bottom:12px"><svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Investimento e receita por mês">
    <line x1="${padL}" y1="${H - padB}" x2="${W - 10}" y2="${H - padB}" stroke="var(--border)"/>
    <text x="${padL - 6}" y="${padT + 4}" text-anchor="end">${esc(fmt.brl(max))}</text>
    <text x="${padL - 6}" y="${H - padB}" text-anchor="end">R$ 0</text>${bars}</svg>
    <div class="hint"><span style="color:var(--bar-2)">■</span> Investimento no Meta &nbsp; <span style="color:var(--bar)">■</span> Receita gerada em vendas</div></div>`;
}

// ---------- aba: Metas (rotina comercial: mensal → semanal → diário) ----------
const shortDate = (d) => d.slice(8, 10) + '/' + d.slice(5, 7);
const goalPlan = (c, month) => (c.goals && c.goals[month]) || null;
const shiftMonth = (k, n) => { const d = new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };

function goalMonthOptions(c) {
  const keys = new Set(Object.keys(c.goals || {}));
  const now = Goals.todayISO().slice(0, 7);
  keys.add(now); keys.add(shiftMonth(now, 1));
  if (state.goalMonth) keys.add(state.goalMonth);
  return [...keys].sort().reverse();
}

const ROW_BY_KEY = Object.fromEntries(Goals.ROWS.map((r) => [r.key, r]));
const fval = (row, v) => (v == null ? '—' : row.fmt === 'brl' ? fmt.brl(v) : row.fmt === 'int' ? fmt.int(v) : fmt.dec(v));

// Textos de cada "slot" (trechos que mudam quando o realizado muda) e o tom de cada célula de dia
function goalSlots(res) {
  const html = {}, tone = {};
  const setCell = (prefix, row, cell) => {
    html[`${prefix}:meta`] = cell.meta == null ? '<span class="na">—</span>'
      : `<span title="${cell.raised ? `Meta-base ${esc(fval(row, cell.base))}; sobe para compensar o que ficou abaixo` : ''}">${row.kind === 'cost' ? 'Teto ' : ''}${cell.raised ? '<span class="up">▲</span> ' : ''}${esc(fval(row, cell.meta))}</span>`;
    html[`${prefix}:real`] = cell.realizado == null ? '<span class="na">—</span>' : esc(fval(row, cell.realizado));
    tone[prefix] = cell.tone;
  };
  for (const row of Goals.ROWS) {
    const m = res.rows[row.key];
    setCell(`m:${row.key}`, row, m);
    html[`m:${row.key}:bar`] = row.kind === 'volume' && m.meta
      ? `<div class="bar"><div class="t-${m.tone || 'none'}" style="width:${Math.min((m.pct || 0) * 100, 100)}%"></div></div>
         <div class="note">${m.pct != null ? esc(fmt.pct(m.pct * 100)) + ' da meta' : 'Sem lançamento'}${m.falta ? ` · faltam ${esc(fval(row, m.falta))}` : m.pct != null ? ' · meta batida' : ''}</div>`
      : row.kind === 'cost' ? `<div class="note">${m.tone === 'good' ? 'Dentro do teto' : m.tone === 'warn' ? 'Até 20% acima do teto' : m.tone === 'bad' ? 'Acima do teto' : 'Aguardando lançamentos'}</div>` : '';
    for (const w of res.weeks) {
      setCell(`w${w.n}:${row.key}`, row, w.rows[row.key]);
      for (const d of w.days) if (d.working) setCell(`d:${d.date}:${row.key}`, row, d.rows[row.key]);
    }
  }
  html.alert = res.semLancamento.length
    ? `<div class="notice warn"><b>${res.semLancamento.length} dia(s) útil(eis) sem lançamento:</b> ${res.semLancamento.map(shortDate).join(', ')}.
       Eles contam como zero e já empurram a meta dos próximos dias. Lance o realizado (pode ser 0) para a conta ficar certa.</div>` : '';
  return { html, tone };
}

// Infográfico: uma métrica por vez, por dia útil (barras) ou acumulada (linhas)
function chartPanelHtml(res, plan) {
  if (!res.rowDefs.some((r) => r.key === state.gcKey)) state.gcKey = 'vendas';
  const opts = res.rowDefs.map((r) => `<option value="${r.key}" ${r.key === state.gcKey ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
  const pressed = (m) => (state.gcMode === m ? 'true' : 'false');
  return `<section class="panel gc-panel" aria-label="Infográfico por dia">
      <div class="gc-head">
        <label class="gc-pick">Métrica <select id="gc-metric">${opts}</select></label>
        <div class="seg" role="group" aria-label="Tipo de gráfico">
          <button type="button" data-gc-mode="dia" aria-pressed="${pressed('dia')}">Dia a dia</button>
          <button type="button" data-gc-mode="acum" aria-pressed="${pressed('acum')}">Acumulado</button>
        </div>
      </div>
      <div id="gc-box">${GoalChart.build({ res, plan, key: state.gcKey, mode: state.gcMode, fmtVal: fval })}</div>
    </section>`;
}

function refreshChart(month) {
  const box = document.getElementById('gc-box');
  const plan = goalPlan(state.client, month);
  if (!box || !plan) return;
  const res = Goals.compute(month, plan);
  box.innerHTML = GoalChart.build({ res, plan, key: state.gcKey, mode: state.gcMode, fmtVal: fval });
  document.querySelectorAll('[data-gc-mode]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.gcMode === state.gcMode ? 'true' : 'false'));
}

function applySlots(slots) {
  document.querySelectorAll('[data-slot]').forEach((el) => {
    const h = slots.html[el.dataset.slot];
    if (h != null && el.innerHTML !== h) el.innerHTML = h;
  });
  document.querySelectorAll('[data-tone-of]').forEach((el) => {
    const t = slots.tone[el.dataset.toneOf];
    if (t) el.dataset.tone = t; else delete el.dataset.tone;
  });
}

function renderGoals() {
  const c = state.client;
  if (!state.goalMonth) state.goalMonth = Goals.todayISO().slice(0, 7);
  const month = state.goalMonth;
  const plan = goalPlan(c, month);

  const toolbar = `<div class="toolbar">
      <label>Mês <select id="goal-month">${goalMonthOptions(c).map((k) => `<option value="${k}" ${k === month ? 'selected' : ''}>${esc(monthLabel(k))}${goalPlan(c, k) ? ' ✓' : ''}</option>`).join('')}</select></label>
      <span class="spacer"></span>
      <button class="btn" id="edit-goal">${plan ? 'Editar meta do mês' : 'Definir meta do mês'}</button>
    </div>`;

  if (!plan) {
    $('#tab').innerHTML = `${toolbar}<div class="panel empty-state">
      <p><b>Ainda não há meta para ${esc(monthLabel(month))}.</b></p>
      <p>Defina a meta do mês e o sistema desdobra sozinho em semanas e dias úteis. Você só lança o realizado de cada dia;
      quando a meta do dia (ou da semana) não é batida, a diferença é somada às metas seguintes automaticamente.</p></div>`;
    $('#goal-month').onchange = (e) => { state.goalMonth = e.target.value; renderGoals(); };
    $('#edit-goal').onclick = () => openGoalDialog(month);
    return;
  }

  const res = Goals.compute(month, plan);
  const slots = goalSlots(res);
  const slot = (id) => `<span data-slot="${esc(id)}">${slots.html[id] ?? ''}</span>`;

  const monthCards = res.rowDefs.map((row) => `
    <div class="card" data-tone-of="m:${row.key}">
      <div class="label">${esc(row.label)}${row.support ? ' <span class="pill">apoio</span>' : ''}</div>
      <div class="value">${slot(`m:${row.key}:real`)}</div>
      <div class="note">Meta do mês: ${slot(`m:${row.key}:meta`)}</div>
      ${slot(`m:${row.key}:bar`)}
    </div>`).join('');

  const weekHtml = res.weeks.map((w) => {
    const head = w.days.map((d) => {
      const cls = ['dayhead', d.isToday ? 'today' : '', d.working ? '' : 'off'].join(' ');
      if (!d.inMonth) return `<th class="${cls}">${esc(d.label)}</th>`;
      return `<th class="${cls}">
        <div>${esc(d.label)} <span class="muted">${esc(shortDate(d.date))}</span></div>
        ${d.working ? `<div class="theme">${esc(d.theme)}</div>` : `<div class="theme">${esc(d.holiday ? 'Feriado: ' + d.holiday : 'Folga')}</div>`}
        <button type="button" class="linkbtn" data-toggle-off="${d.date}">${d.working ? 'marcar folga' : 'reativar dia'}</button></th>`;
    }).join('');
    const body = res.rowDefs.map((row) => {
      const cells = w.days.map((d) => {
        if (!d.working) return '<td class="offcell">—</td>';
        const real = row.input
          ? `<input class="dayin" type="number" min="0" step="${row.integer ? 1 : 'any'}" inputmode="${row.integer ? 'numeric' : 'decimal'}" aria-label="${esc(row.label)} realizado em ${esc(shortDate(d.date))}"
              data-date="${d.date}" data-key="${row.key}" value="${esc(((plan.days || {})[d.date] || {})[row.key] ?? '')}">`
          : `<div class="calc">${slot(`d:${d.date}:${row.key}:real`)}</div>`;
        return `<td class="daycell" data-tone-of="d:${d.date}:${row.key}"><div class="dmeta">${slot(`d:${d.date}:${row.key}:meta`)}</div>${real}</td>`;
      }).join('');
      return `<tr class="${row.support ? 'support' : ''}"><th scope="row">${esc(row.label)}</th>
        <td class="wk" data-tone-of="w${w.n}:${row.key}"><div class="dmeta">${slot(`w${w.n}:${row.key}:meta`)}</div><div class="calc">${slot(`w${w.n}:${row.key}:real`)}</div></td>${cells}</tr>`;
    }).join('');
    return `<h2 class="section">Semana ${String(w.n).padStart(2, '0')} · ${esc(shortDate(w.from))} a ${esc(shortDate(w.to))} <span class="muted">(${w.workingDays} dia${w.workingDays === 1 ? '' : 's'} útil${w.workingDays === 1 ? '' : 'eis'})</span></h2>
      <div class="panel scroll"><table class="goal-table"><thead><tr><th>Métrica</th><th class="wk">Semana<div class="theme">meta / realizado</div></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }).join('');

  $('#tab').innerHTML = `${toolbar}
    <div id="goal-alert"><span data-slot="alert">${slots.html.alert}</span></div>
    ${res.hasTargets ? '' : '<div class="notice warn">A meta do mês está vazia. Use “Editar meta do mês” para preencher.</div>'}
    <h2 class="section">Mensal · ${esc(monthLabel(month))} <span class="muted">(${res.workingDays} dias úteis)</span></h2>
    <div class="mensal">
      <div class="grid grid-sm">${monthCards}</div>
      ${chartPanelHtml(res, plan)}
    </div>
    ${weekHtml}
    <p class="hint">Digite só o <b>realizado</b> de cada dia; as metas se ajustam sozinhas. Em cada célula, a linha de cima é a meta e a de baixo é o realizado.
    <span class="up">▲</span> = meta acima da base porque o período anterior ficou abaixo. Custo por lead é um teto (meta fixa), calculado como investimento ÷ leads.
    Feriados nacionais já entram como folga; ajuste com “marcar folga” no cabeçalho do dia.</p>`;

  $('#goal-month').onchange = (e) => { state.goalMonth = e.target.value; renderGoals(); };
  $('#edit-goal').onclick = () => openGoalDialog(month);
  applySlots(slots);

  const tab = $('#tab');
  tab.onchange = (e) => {
    const el = e.target;
    if (el.id === 'gc-metric') { state.gcKey = el.value; refreshChart(month); return; }
    if (!el.matches || !el.matches('input.dayin')) return;
    saveGoalDay(month, el.dataset.date, el.dataset.key, el.value);
  };
  // Tab/Enter descem a coluna do dia (e passam para o dia seguinte), em vez de andar pela linha
  tab.onkeydown = (e) => {
    const el = e.target;
    if (!el.matches || !el.matches('input.dayin') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'Tab' && e.key !== 'Enter') return;
    const table = el.closest('table');
    const rowOf = (i) => i.closest('tr').rowIndex;
    const inputs = [...table.querySelectorAll('input.dayin')]
      .sort((a, b) => (a.dataset.date < b.dataset.date ? -1 : a.dataset.date > b.dataset.date ? 1 : rowOf(a) - rowOf(b)));
    const next = inputs[inputs.indexOf(el) + (e.shiftKey && e.key === 'Tab' ? -1 : 1)];
    if (!next) return; // fim da tabela: segue o comportamento normal
    e.preventDefault();
    next.focus(); next.select();
  };
  tab.onclick = async (e) => {
    const mb = e.target.closest && e.target.closest('[data-gc-mode]');
    if (mb) { state.gcMode = mb.dataset.gcMode; refreshChart(month); return; }
    const btn = e.target.closest && e.target.closest('[data-toggle-off]');
    if (!btn) return;
    const date = btn.dataset.toggleOff;
    const cur = new Set(Goals.compute(month, goalPlan(state.client, month)).offDays);
    if (cur.has(date)) cur.delete(date); else cur.add(date);
    await state.saveChain;
    try {
      state.client = await api(`/clients/${encodeURIComponent(c.id)}/goals/${month}`, { method: 'PUT', body: { naoUteis: [...cur] } });
    } catch (err) { alert(err.message); }
    renderGoals();
  };
}

// Atualiza na tela na hora e grava em segundo plano (em fila, para não embaralhar gravações)
function saveGoalDay(month, date, key, raw) {
  const c = state.client;
  const plan = goalPlan(c, month);
  const value = raw === '' ? null : Number(raw);
  if (value != null && (!Number.isFinite(value) || value < 0)) { alert('Informe um número maior ou igual a zero.'); renderGoals(); return; }
  if (value != null && ROW_BY_KEY[key] && ROW_BY_KEY[key].integer && !Number.isInteger(value)) { alert('Use um número inteiro: não existe meio lead ou meia venda.'); renderGoals(); return; }
  plan.days = plan.days || {};
  plan.days[date] = { ...plan.days[date], [key]: value };
  if (Object.values(plan.days[date]).every((v) => v == null)) delete plan.days[date];
  applySlots(goalSlots(Goals.compute(month, plan)));
  refreshChart(month);
  document.getElementById('goal-alert').innerHTML = `<span data-slot="alert">${goalSlots(Goals.compute(month, plan)).html.alert}</span>`;
  state.saveChain = state.saveChain
    .then(() => api(`/clients/${encodeURIComponent(c.id)}/goals/${month}/days/${date}`, { method: 'PUT', body: { [key]: raw } }))
    .catch(async (err) => { alert('Não foi possível salvar: ' + err.message); state.client = await api(`/clients/${encodeURIComponent(c.id)}`); renderGoals(); });
}

// Nome de cada etapa e a etapa de que a porcentagem é tirada
const STAGE_TEXT = {
  leads: { unit: 'lead', base: null },
  leadsQualificados: { unit: 'lead qualificado', base: 'dos leads' },
  cotacoes: { unit: 'cotação', base: 'dos leads qualificados' },
  negociacoes: { unit: 'negociação', base: 'das cotações' },
  vendas: { unit: 'venda', base: 'das negociações' },
};
const stageLabel = (k) => ({ leads: 'Leads', leadsQualificados: 'Leads qualificados', cotacoes: 'Cotações', negociacoes: 'Negociações', vendas: 'Vendas' }[k]);
const modeText = (k, modo) => (modo === 'numero' ? 'Número exato' : modo === 'taxa' ? `% ${STAGE_TEXT[k].base}` : `Custo por ${STAGE_TEXT[k].unit} (R$)`);
const modeUnit = (modo) => (modo === 'numero' ? 'un.' : modo === 'taxa' ? '%' : 'R$');

function openGoalDialog(month) {
  const c = state.client;
  const plan = goalPlan(c, month);
  const prev = goalPlan(c, shiftMonth(month, -1));
  const cur = Goals.normalizeMeta((plan && plan.meta) || (prev && prev.meta) || {});

  const stageRow = (k) => {
    const it = cur.itens[k];
    return `<div class="stage-row">
      <div class="stage-name">${esc(stageLabel(k))}</div>
      <label class="stage-mode"><span class="sr-only">Como definir ${esc(stageLabel(k))}</span>
        <select name="modo-${k}" data-stage="${k}">${Goals.MODES[k].map((m) => `<option value="${m}" ${it.modo === m ? 'selected' : ''}>${esc(modeText(k, m))}</option>`).join('')}</select></label>
      <label class="stage-val"><span class="sr-only">Valor de ${esc(stageLabel(k))}</span>
        <span class="inwrap"><input type="number" min="0" step="${it.modo === 'numero' ? 1 : 'any'}" inputmode="decimal" name="val-${k}" value="${esc(it.valor ?? '')}"><span class="unit" data-unit="${k}">${esc(modeUnit(it.modo))}</span></span></label>
      <div class="stage-eq hint" data-eq="${k}"></div>
    </div>`;
  };

  openDialog(`<form method="dialog" id="goal-form">
    <div class="dlg-head"><h3>Meta de ${esc(monthLabel(month))}</h3></div>
    <div class="dlg-body">
      ${!plan && prev ? '<div class="notice good">Valores preenchidos com a meta do mês anterior. Ajuste o que precisar.</div>' : ''}
      <div class="form-grid"><label>Valor investido no mês (R$)<input type="number" min="0" step="any" inputmode="decimal" name="investimento" value="${esc(cur.investimento ?? '')}"></label></div>
      <p class="hint">Para cada etapa do funil, escolha como definir a meta: <b>número exato</b>, <b>porcentagem</b> da etapa anterior ou <b>custo</b> por unidade (investimento ÷ custo). Ao lado aparece o que isso equivale nas outras formas.</p>
      <div class="stage-grid">${Goals.STAGES.map(stageRow).join('')}</div>
      <label class="check-row"><input type="checkbox" name="compensarExcedente" ${plan && plan.compensarExcedente ? 'checked' : ''}>
        Quando eu superar a meta, reduzir as metas seguintes (por padrão elas só sobem quando fico abaixo)</label>
      <p class="hint">Custos por lead e por lead qualificado são tetos fixos no acompanhamento diário. Se você escolher custo por cotação, negociação ou venda, a linha de custo correspondente também aparece nas tabelas. A meta é dividida pelos dias úteis de cada semana (feriados nacionais descontados) e se ajusta a cada lançamento de realizado.</p>
      <div id="form-error" class="notice bad" hidden></div></div>
    <div class="dlg-foot">
      ${plan ? '<button type="button" class="btn btn-danger" id="del-goal">Apagar plano do mês</button>' : ''}<span style="flex:1"></span>
      <button type="button" class="btn btn-ghost" id="cancel">Cancelar</button>
      <button type="submit" class="btn">Salvar</button></div></form>`);

  const form = $('#goal-form');
  const readMeta = () => {
    const meta = { investimento: form.elements.investimento.value === '' ? null : Number(form.elements.investimento.value), itens: {} };
    for (const k of Goals.STAGES) {
      const raw = form.elements['val-' + k].value;
      meta.itens[k] = { modo: form.elements['modo-' + k].value, valor: raw === '' ? null : Number(raw) };
    }
    return meta;
  };
  const preview = () => {
    const meta = readMeta();
    const { info } = Goals.resolveTargets(meta);
    for (const k of Goals.STAGES) {
      const i = info[k];
      $(`[data-unit="${k}"]`).textContent = modeUnit(i.modo);
      form.elements['val-' + k].step = i.modo === 'numero' ? '1' : 'any'; // número exato de pessoas: inteiro
      const parts = [];
      if (i.total != null) parts.push(`${fmt.int(i.total)} no mês`);
      if (i.modo !== 'custo' && i.custo != null) parts.push(`${fmt.brl(i.custo)} por ${STAGE_TEXT[k].unit}`);
      if (i.modo !== 'taxa' && i.taxa != null) parts.push(`${fmt.dec(i.taxa)}% ${STAGE_TEXT[k].base}`);
      const needBase = i.modo === 'taxa' && i.total == null && meta.itens[k].valor != null;
      const needInv = i.modo === 'custo' && i.total == null && meta.itens[k].valor != null;
      $(`[data-eq="${k}"]`).textContent = needBase ? 'Defina a etapa anterior para calcular.' : needInv ? 'Informe o valor investido para calcular.' : parts.join(' · ');
    }
  };
  form.oninput = preview;
  form.onchange = preview;
  preview();
  $('#cancel').onclick = closeDialog;
  const del = $('#del-goal');
  if (del) del.onclick = async () => {
    if (!confirm(`Apagar a meta de ${monthLabel(month)} E todo o realizado lançado nos dias? Não dá para desfazer.`)) return;
    state.client = await api(`/clients/${encodeURIComponent(c.id)}/goals/${month}`, { method: 'DELETE' });
    closeDialog(); renderGoals();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = { meta: readMeta(), compensarExcedente: form.elements.compensarExcedente.checked };
    try {
      state.client = await api(`/clients/${encodeURIComponent(c.id)}/goals/${month}`, { method: 'PUT', body });
      closeDialog(); renderGoals();
    } catch (err) { const box = $('#form-error'); box.hidden = false; box.textContent = err.message; }
  };
}

// ---------- aba: Monday ----------
function renderMonday() {
  const c = state.client;
  const cfg = c.monday || {};
  const snap = cfg.snapshot;
  const p = c.project;
  const fmtDate = (d) => (d ? d.split('-').reverse().join('/') : null);
  $('#tab').innerHTML = `
    ${c.mondayConfigured ? '' : `<div class="notice warn">O servidor não tem <code>MONDAY_API_TOKEN</code> configurado, então a sincronização está desligada. Veja o README.</div>`}
    ${cfg.error ? `<div class="notice bad">Última sincronização falhou: ${esc(cfg.error)}</div>` : ''}
    <div class="toolbar">
      <div><b>Quadro:</b> ${esc(cfg.boardName || 'Entrada de Clientes')} · <b>Item:</b> ${esc(cfg.itemName || c.name)}
        ${cfg.syncedAt ? `<div class="hint">Última tentativa: ${esc(new Date(cfg.syncedAt).toLocaleString('pt-BR'))}</div>` : ''}</div>
      <span class="spacer"></span>
      <button class="btn" id="sync" ${c.mondayConfigured ? '' : 'disabled'}>Sincronizar com o Monday</button>
    </div>
    <div id="sync-result"></div>
    <h2 class="section">Dados do projeto usados nas métricas</h2>
    <div class="panel"><dl class="kv">
      <dt>Início do projeto</dt><dd>${esc(fmtDate(p.startDate) || '—')}</dd>
      <dt>Assinatura do contrato</dt><dd>${esc(fmtDate(p.contractDate) || '—')}</dd>
      <dt>Início das campanhas</dt><dd>${esc(fmtDate(p.campaignStartDate) || '—')}</dd>
      <dt>Primeira venda</dt><dd>${esc(fmtDate(p.firstSaleDate) || '—')}</dd>
      <dt>MRR</dt><dd>${p.mrr != null ? esc(fmt.brl(p.mrr)) : '—'}</dd>
    </dl></div>
    <h2 class="section">De onde vem cada dado</h2>
    <div class="panel"><dl class="kv">
      <dt>Do Monday (quando sincronizado)</dt><dd>MRR e as datas do projeto (início, contrato, campanhas, primeira venda) — só preenchem campos vazios.</dd>
      <dt>Manual, todo mês</dt><dd>Investimento no Meta, leads, qualificados, respostas, cotações, pararam de responder, negociações, vendas e receita; faturado, inadimplente e dinheiro coletado; NPS, Health Score (opcional), reclamações, reuniões e contatos espontâneos.</dd>
      <dt>Calculado sozinho</dt><dd>CPL, CPL qualificado, ticket médio, ROAS, CAC, taxa de inadimplência, índice de reclamação, Time to Value, tempo de projeto, nível de ansiedade e Health Score.</dd>
    </dl><div class="hint">Tudo que vem do Monday também pode ser digitado à mão em “Dados do projeto”.</div></div>
    <h2 class="section">Dados do cliente no Monday</h2>
    <div class="panel">${snap
      ? `<dl class="kv">${snap.fields.map((f) => `<dt>${esc(f.title)}</dt><dd>${esc(f.text)}</dd>`).join('')}</dl>`
      : '<div class="empty-state">Ainda não sincronizado.</div>'}</div>`;

  $('#sync').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Sincronizando…';
    try {
      const r = await api(`/clients/${encodeURIComponent(c.id)}/monday/sync`, { method: 'POST' });
      state.client = r.client;
      await render();
      $('#sync-result').innerHTML = `<div class="notice good">Sincronizado. ${r.applied.length
        ? 'Campos preenchidos: ' + r.applied.map((a) => esc(`${a.key} (de “${a.from}”)`)).join(', ') + '.'
        : 'Nenhum campo novo foi preenchido automaticamente — ajuste em “Dados do projeto” se precisar.'}</div>`;
    } catch (err) {
      await render();
    }
  };
}

// ---------- diálogos ----------
const dlg = () => $('#dialog');
function openDialog(html) { dlg().innerHTML = html; dlg().showModal(); }
function closeDialog() { dlg().close(); }

const MONTH_FIELDS = [
  ['Resultado — funil e investimento', [
    ['investimento', 'Investimento no Meta (R$)'], ['leads', 'Leads'], ['leadsQualificados', 'Leads qualificados'],
    ['leadsResponderam', 'Leads que responderam o 1º contato'], ['cotacoes', 'Cotações enviadas'],
    ['pararamResponder', 'Pararam de responder (pós envio + 7 dias de follow-up)'], ['negociacoes', 'Em negociação'],
    ['vendas', 'Vendas'], ['receita', 'Receita gerada em vendas (R$)'],
  ]],
  ['Gestão — financeiro', [
    ['mrr', 'MRR do mês (R$)'], ['faturado', 'Valor faturado (R$)'], ['inadimplente', 'Valor inadimplente (R$)'],
    ['dinheiroColetado', 'Dinheiro coletado (R$)'],
  ]],
  ['Gestão — relacionamento', [
    ['nps', 'NPS do mês (-100 a 100)'], ['healthScore', 'Health Score manual (0-100, opcional)'],
    ['reclamacoes', 'Reclamações no mês'], ['contatosCliente', 'Total de contatos do cliente no mês'],
    ['reunioesRealizadas', 'Reuniões de alinhamento realizadas'], ['reunioesPlanejadas', 'Reuniões planejadas'],
    ['contatosEspontaneos', 'Contatos espontâneos (fora do horário / cobrando venda)'],
  ]],
];

function openMonthDialog(month) {
  const c = state.client;
  const fieldsHtml = (values) => MONTH_FIELDS.map(([title, fields]) => `
    <fieldset><legend>${esc(title)}</legend><div class="form-grid">
      ${fields.map(([k, label]) => `<label>${esc(label)}<input type="number" step="any" name="${k}" value="${esc(values[k] ?? '')}"></label>`).join('')}
    </div></fieldset>`).join('') +
    `<fieldset><legend>Observações</legend><textarea name="observacoes" rows="3" style="width:100%">${esc(values.observacoes || '')}</textarea></fieldset>`;

  openDialog(`<form method="dialog" id="month-form">
    <div class="dlg-head"><h3>Registrar dados do mês</h3>
      <input type="month" id="month-pick" value="${esc(month)}" required></div>
    <div class="dlg-body"><div id="month-fields">${fieldsHtml(c.months[month] || {})}</div>
      <p class="hint">Deixe em branco o que ainda não tem. CPL, ROAS, CAC, ticket médio e as taxas são calculados automaticamente.</p>
      <div id="form-error" class="notice bad" hidden></div></div>
    <div class="dlg-foot">
      <button type="button" class="btn btn-danger" id="del-month">Apagar mês</button><span style="flex:1"></span>
      <button type="button" class="btn btn-ghost" id="cancel">Cancelar</button>
      <button type="submit" class="btn">Salvar</button></div></form>`);

  $('#month-pick').onchange = (e) => { $('#month-fields').innerHTML = fieldsHtml(c.months[e.target.value] || {}); };
  $('#cancel').onclick = closeDialog;
  $('#del-month').onclick = async () => {
    const mk = $('#month-pick').value;
    if (!mk || !c.months[mk] || !confirm(`Apagar todos os dados de ${monthLabel(mk)}?`)) return;
    await api(`/clients/${encodeURIComponent(c.id)}/months/${mk}`, { method: 'DELETE' });
    closeDialog(); state.period = null; await render();
  };
  $('#month-form').onsubmit = async (e) => {
    e.preventDefault();
    const mk = $('#month-pick').value;
    if (!mk) return;
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api(`/clients/${encodeURIComponent(c.id)}/months/${mk}`, { method: 'PUT', body });
      closeDialog(); state.period = mk; await render();
    } catch (err) { const box = $('#form-error'); box.hidden = false; box.textContent = err.message; }
  };
}

function openProjectDialog() {
  const p = state.client.project;
  const date = (k, label) => `<label>${label}<input type="date" name="${k}" value="${esc(p[k] ?? '')}"></label>`;
  openDialog(`<form method="dialog" id="project-form">
    <div class="dlg-head"><h3>Dados do projeto</h3></div>
    <div class="dlg-body"><div class="form-grid">
      ${date('startDate', 'Início do projeto')}${date('contractDate', 'Assinatura do contrato')}
      ${date('campaignStartDate', 'Início das campanhas')}${date('firstSaleDate', 'Primeira venda')}
      <label>MRR padrão (R$)<input type="number" step="any" name="mrr" value="${esc(p.mrr ?? '')}"></label>
      <label>Meta de ROAS (para o Health Score)<input type="number" step="any" name="roasTarget" value="${esc(p.roasTarget ?? '')}"></label>
      <label class="full" style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" name="cacIncludesFee" ${p.cacIncludesFee === false ? '' : 'checked'}>
        Incluir a mensalidade da agência (MRR) no cálculo do CAC</label>
    </div>
    <p class="hint">Se o Monday estiver sincronizado, as datas e o MRR encontrados lá preenchem os campos vazios.</p>
    <div id="form-error" class="notice bad" hidden></div></div>
    <div class="dlg-foot"><button type="button" class="btn btn-ghost" id="cancel">Cancelar</button>
      <button type="submit" class="btn">Salvar</button></div></form>`);
  $('#cancel').onclick = closeDialog;
  $('#project-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.cacIncludesFee = fd.has('cacIncludesFee');
    try {
      await api(`/clients/${encodeURIComponent(state.client.id)}/project`, { method: 'PUT', body });
      closeDialog(); await render();
    } catch (err) { const box = $('#form-error'); box.hidden = false; box.textContent = err.message; }
  };
}

$('#add-client').onclick = () => {
  openDialog(`<form method="dialog" id="client-form">
    <div class="dlg-head"><h3>Novo cliente</h3></div>
    <div class="dlg-body"><div class="form-grid">
      <label class="full">Nome (igual ao item no Monday)<input name="name" required></label>
      <label class="full">Segmento<input name="segment"></label></div>
      <div id="form-error" class="notice bad" hidden></div></div>
    <div class="dlg-foot"><button type="button" class="btn btn-ghost" id="cancel">Cancelar</button>
      <button type="submit" class="btn">Criar</button></div></form>`);
  $('#cancel').onclick = closeDialog;
  $('#client-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const created = await api('/clients', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
      closeDialog(); location.hash = `#/${created.id}/metricas`;
    } catch (err) { const box = $('#form-error'); box.hidden = false; box.textContent = err.message; }
  };
};

window.addEventListener('hashchange', render);
render();

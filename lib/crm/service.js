'use strict';
/*
 * Regras de negócio do CRM sobre o banco (um objeto JSON):
 * { leads: {id: lead}, queue: {id: item}, config: {clientId: cfg}, routing: {...}, log: [] }
 * Todas as funções alteram `db` em memória; quem chama grava depois.
 */
const crypto = require('crypto');
const engine = require('./engine');

const newDb = () => ({ leads: {}, queue: {}, config: {}, routing: {}, log: [] });
const uid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const iso = (d) => d.toISOString();

function addLog(db, type, data) {
  db.log.push({ at: iso(new Date()), type, ...data });
  if (db.log.length > 500) db.log.splice(0, db.log.length - 500);
}
const cfgOf = (db, clientId) => engine.mergeConfig(db.config[clientId]);

function pushMsg(lead, dir, m) {
  lead.messages = lead.messages || [];
  lead.messages.push({ dir, at: m.at, text: m.text, ...(m.mode ? { mode: m.mode } : {}), ...(m.step ? { step: m.step } : {}), ...(m.id ? { id: m.id } : {}), ...(m.provider ? { provider: m.provider } : {}), ...(m.auto != null ? { auto: m.auto } : {}) });
  if (lead.messages.length > 200) lead.messages.splice(0, lead.messages.length - 200);
}

/** Cria o lead (ou devolve o já existente com o mesmo telefone/lead do Meta). */
function createLead(db, input, now = new Date()) {
  const phone = engine.normalizePhone(input.phone);
  if (!input.clientId) throw Object.assign(new Error('Informe o cliente (clientId)'), { status: 400 });
  if (!phone) throw Object.assign(new Error('Telefone inválido'), { status: 400 });
  const dup = Object.values(db.leads).find((l) => l.clientId === input.clientId && (l.phone === phone || (input.source && input.source.leadgenId && l.source && l.source.leadgenId === input.source.leadgenId)));
  if (dup) return { lead: dup, created: false };
  const lead = { id: uid('lead'), clientId: input.clientId, name: String(input.name || '').trim() || null, phone, email: input.email || null, stage: 'novo', createdAt: iso(now), stageAt: iso(now),
    source: input.source || { channel: 'manual' }, answers: input.answers || {}, vars: input.vars || {}, reached: ['novo'], optOut: false, humanTakeover: false, lastInboundAt: null, lastOutboundAt: null, sent: [], skipped: [], autoCount: 0, messages: [] };
  db.leads[lead.id] = lead;
  addLog(db, 'lead.criado', { leadId: lead.id, clientId: lead.clientId, origem: lead.source.channel });
  return { lead, created: true };
}

/** Mudança de etapa: reinicia a contagem de prazos da etapa. */
function setStage(db, leadId, stage, extra = {}, now = new Date()) {
  const lead = db.leads[leadId];
  if (!lead) throw Object.assign(new Error('Lead não encontrado'), { status: 404 });
  if (!engine.STAGES.includes(stage)) throw Object.assign(new Error('Etapa inválida'), { status: 400 });
  for (const k of ['appointmentAt', 'procedureAt']) {
    if (extra[k] !== undefined) {
      if (extra[k] !== null && Number.isNaN(Date.parse(extra[k]))) throw Object.assign(new Error(`${k} inválido (use data e hora ISO)`), { status: 400 });
      lead[k] = extra[k] === null ? null : iso(new Date(extra[k]));
    }
  }
  if (stage === 'agendado' && !lead.appointmentAt) throw Object.assign(new Error('Informe appointmentAt para a etapa "agendado"'), { status: 400 });
  if (stage === 'noshow' && !lead.appointmentAt) throw Object.assign(new Error('Informe appointmentAt para "noshow"'), { status: 400 });
  if (stage === 'vendido' && !lead.procedureAt) lead.procedureAt = null;
  if (stage !== lead.stage) {
    if (stage === 'cotacao' && !['cotacao', 'negociacao'].includes(lead.stage)) lead.quoteAt = iso(now);
    if (!['cotacao', 'negociacao'].includes(stage)) lead.quoteAt = null;
    lead.stage = stage; lead.stageAt = iso(now);
    lead.reached = [...new Set([...(lead.reached || []), stage])];
    addLog(db, 'lead.etapa', { leadId, stage });
  }
  return lead;
}

/** Mensagem recebida do lead. Para a cadência, avança "novo" para "respondeu" e respeita o pedido de parar. */
function recordInbound(db, { clientId, phone, name, text, id, at }, now = new Date()) {
  const p = engine.normalizePhone(phone);
  if (!p) return { ignored: 'telefone inválido' };
  if (id && Object.values(db.leads).some((l) => (l.messages || []).some((m) => m.id === id))) return { ignored: 'duplicada' };
  let lead = Object.values(db.leads).find((l) => l.phone === p && (!clientId || l.clientId === clientId));
  let created = false;
  if (!lead) {
    const cid = clientId || db.routing.defaultClientId;
    if (!cid) { addLog(db, 'whatsapp.sem-cliente', { phone: p }); return { ignored: 'sem cliente configurado para este número' }; }
    ({ lead, created } = createLead(db, { clientId: cid, name, phone: p, source: { channel: 'whatsapp' } }, now));
  }
  const when = at ? new Date(at) : now;
  lead.lastInboundAt = iso(when);
  if (!lead.name && name) lead.name = name;
  pushMsg(lead, 'in', { at: iso(when), text: text || '', id });
  const result = { leadId: lead.id, created, optOut: false };
  if (engine.isOptOut(text)) {
    lead.optOut = true; lead.optOutAt = iso(now);
    for (const q of Object.values(db.queue)) if (q.leadId === lead.id && q.status === 'pendente') q.status = 'cancelado';
    addLog(db, 'lead.optout', { leadId: lead.id });
    result.optOut = true;
  } else if (lead.stage === 'novo') {
    lead.stage = 'respondeu'; lead.stageAt = iso(now);
    lead.reached = [...new Set([...(lead.reached || []), 'respondeu'])];
  }
  return result;
}

/**
 * Uma rodada de follow-up. Em modo "approval" cria itens na fila; em "auto" envia pelo provedor.
 * Devolve um resumo com o que foi enviado, enfileirado, bloqueado e descartado.
 */
async function runFollowups(db, { now = new Date(), provider }) {
  const summary = { enviados: 0, enfileirados: 0, bloqueados: [], descartados: 0, foraDoHorario: false };
  const byClient = {};
  const used = {};
  for (const lead of Object.values(db.leads)) {
    const cfg = byClient[lead.clientId] || (byClient[lead.clientId] = cfgOf(db, lead.clientId));
    used[lead.clientId] = used[lead.clientId] || 0;
    const due = engine.evaluate(lead, now, cfg);
    for (const d of due) {
      if (d.state === 'expired') { lead.skipped.push(engine.stepKey(lead, d.step)); summary.descartados += 1; addLog(db, 'followup.descartado', { leadId: lead.id, step: d.step.id, motivo: 'atrasado demais' }); }
      if (d.state === 'skip') lead.skipped.push(engine.stepKey(lead, d.step));
    }
    const next = due.filter((d) => d.state === 'due').sort((a, b) => a.dueAt - b.dueAt)[0];
    if (!next) continue;
    if (!engine.withinHours(now, cfg)) { summary.foraDoHorario = true; continue; }
    if (lead.autoCount >= cfg.maxAuto) continue;
    if (!next.step.ignoreGap && lead.lastOutboundAt && now - Date.parse(lead.lastOutboundAt) < cfg.minGapMin * 60000) continue;
    if (used[lead.clientId] >= cfg.batch) continue;
    const key = engine.stepKey(lead, next.step);
    const msg = engine.buildMessage(next.step.template, lead, now, cfg);
    if (!msg.ok) {
      const have = Object.values(db.queue).find((q) => q.leadId === lead.id && q.key === key);
      if (!have) { summary.bloqueados.push({ leadId: lead.id, step: next.step.id, motivo: msg.reason }); }
      continue;
    }
    if (cfg.mode === 'auto') {
      const r = await deliver(db, lead, { ...msg, step: next.step.id }, key, provider, now, true);
      if (r.ok) { summary.enviados += 1; used[lead.clientId] += 1; } else summary.bloqueados.push({ leadId: lead.id, step: next.step.id, motivo: r.error });
    } else {
      if (Object.values(db.queue).some((q) => q.leadId === lead.id && q.key === key)) continue;
      const id = uid('q');
      db.queue[id] = { id, leadId: lead.id, clientId: lead.clientId, key, step: next.step.id, status: 'pendente', createdAt: iso(now), message: msg };
      summary.enfileirados += 1; used[lead.clientId] += 1;
      addLog(db, 'followup.enfileirado', { leadId: lead.id, step: next.step.id });
    }
  }
  return summary;
}

async function deliver(db, lead, msg, key, provider, now, auto) {
  // Rechecagem de segurança no instante do envio
  if (lead.optOut) return { ok: false, error: 'lead pediu para parar' };
  const r = await provider.send(lead, msg);
  if (!r.ok) {
    lead.failures = lead.failures || {};
    lead.failures[key] = (lead.failures[key] || 0) + 1;
    if (lead.failures[key] >= 3) { lead.skipped.push(key); addLog(db, 'followup.falhou', { leadId: lead.id, step: msg.step, erro: r.error }); }
    return { ok: false, error: r.error || 'falha no envio' };
  }
  lead.sent.push(key);
  lead.lastOutboundAt = iso(now);
  if (auto) lead.autoCount = (lead.autoCount || 0) + 1;
  pushMsg(lead, 'out', { at: iso(now), text: msg.body, mode: msg.mode, step: msg.step, id: r.id, provider: provider.name, auto });
  addLog(db, 'followup.enviado', { leadId: lead.id, step: msg.step, canal: provider.name });
  return { ok: true, id: r.id };
}

/** Aprova um item da fila e envia. Rechecagem: janela de 24h, opt-out e etapa ainda valem agora. */
async function approve(db, queueId, { provider, now = new Date() }) {
  const q = db.queue[queueId];
  if (!q) throw Object.assign(new Error('Item não encontrado'), { status: 404 });
  if (q.status !== 'pendente') throw Object.assign(new Error('Item já foi tratado'), { status: 409 });
  const lead = db.leads[q.leadId];
  const cfg = cfgOf(db, q.clientId);
  const due = engine.evaluate(lead, now, cfg).find((d) => engine.stepKey(lead, d.step) === q.key);
  if (!due || due.state !== 'due') { q.status = 'cancelado'; q.reason = 'não vale mais (lead respondeu, mudou de etapa ou prazo passou)'; throw Object.assign(new Error(q.reason), { status: 409 }); }
  const msg = engine.buildMessage(due.step.template, lead, now, cfg);
  if (!msg.ok) throw Object.assign(new Error(msg.reason), { status: 422 });
  if (!engine.withinHours(now, cfg)) throw Object.assign(new Error('Fora do horário de envio. Aprove dentro do horário comercial.'), { status: 422 });
  const r = await deliver(db, lead, { ...msg, step: q.step }, q.key, provider, now, false);
  if (!r.ok) throw Object.assign(new Error(r.error), { status: 502 });
  q.status = 'enviado'; q.sentAt = iso(now);
  return q;
}

function reject(db, queueId) {
  const q = db.queue[queueId];
  if (!q) throw Object.assign(new Error('Item não encontrado'), { status: 404 });
  if (q.status !== 'pendente') throw Object.assign(new Error('Item já foi tratado'), { status: 409 });
  q.status = 'recusado';
  db.leads[q.leadId].skipped.push(q.key);
  return q;
}

/** Contagem por etapa alcançada: alimenta o painel de métricas. */
function summary(db, clientId, month) {
  const leads = Object.values(db.leads).filter((l) => l.clientId === clientId && (!month || l.createdAt.startsWith(month)));
  const reached = (stages) => leads.filter((l) => stages.includes(l.stage) || (l.reached || []).some((s) => stages.includes(s))).length;
  return {
    leads: leads.length,
    leadsResponderam: leads.filter((l) => l.lastInboundAt).length,
    leadsQualificados: reached(['qualificado', 'agendado', 'noshow', 'compareceu', 'cotacao', 'negociacao', 'vendido']),
    cotacoes: reached(['cotacao', 'negociacao', 'vendido']),
    negociacoes: reached(['negociacao', 'vendido']),
    vendas: reached(['vendido']),
    optOut: leads.filter((l) => l.optOut).length,
  };
}

module.exports = { newDb, createLead, setStage, recordInbound, runFollowups, approve, reject, summary, cfgOf, addLog, uid };

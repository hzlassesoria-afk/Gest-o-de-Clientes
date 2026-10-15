'use strict';
/*
 * Motor de follow-up: decide, a cada rodada, quem deve receber qual mensagem agora. Funções puras (sem rede, sem disco).
 *
 * Regras que protegem o lead e a conta do WhatsApp:
 *  - nunca contata quem pediu para parar (opt-out) nem lead em atendimento humano;
 *  - a cadência de cada etapa só vale enquanto o lead não responde;
 *  - só envia em horário comercial (padrão 8h-20h, seg a sáb, horário de Brasília);
 *  - lembrete atrasado demais é descartado (não se manda "amanhã" depois que o dia passou);
 *  - fora da janela de 24h do WhatsApp só sai modelo aprovado; sem modelo aprovado a mensagem fica bloqueada;
 *  - mensagem com variável faltando nunca sai.
 */
const { render, TEMPLATES } = require('./templates');

const STAGES = ['novo', 'respondeu', 'qualificado', 'agendado', 'noshow', 'compareceu', 'cotacao', 'negociacao', 'vendido', 'perdido', 'desqualificado'];
const MIN = 60 * 1000;

// anchor: de onde conta o prazo · offsetMin: minutos depois (negativo = antes) · maxLateMin: depois disso o passo é descartado
const CADENCE = [
  { id: 'novo-1', stages: ['novo'], anchor: 'createdAt', offsetMin: 0, template: 'pc1', noReply: 'ever', maxLateMin: 1440 },
  { id: 'novo-2', stages: ['novo'], anchor: 'createdAt', offsetMin: 120, template: 'pc-retry', noReply: 'ever', maxLateMin: 1440 },
  { id: 'novo-3', stages: ['novo'], anchor: 'createdAt', offsetMin: 1440, template: 'pc-d1', noReply: 'ever', maxLateMin: 1440 },
  { id: 'novo-4', stages: ['novo'], anchor: 'createdAt', offsetMin: 4320, template: 'pc-d3', noReply: 'ever', maxLateMin: 2880 },
  { id: 'qual-1', stages: ['qualificado'], anchor: 'stageAt', offsetMin: 1440, template: 'ag3', noReply: 'stage', maxLateMin: 2880 },
  { id: 'qual-2', stages: ['qualificado'], anchor: 'stageAt', offsetMin: 4320, template: 'ag3b', noReply: 'stage', maxLateMin: 2880 },
  { id: 'agend-1', stages: ['agendado'], anchor: 'appointmentAt', offsetMin: -1440, template: 'cf1', maxLateMin: 360 },
  { id: 'agend-2', stages: ['agendado'], anchor: 'appointmentAt', offsetMin: -120, template: 'cf2', maxLateMin: 60, ignoreGap: true },
  { id: 'noshow-1', stages: ['noshow'], anchor: 'appointmentAt', offsetMin: 30, template: 'cf3', noReply: 'stage', maxLateMin: 720 },
  { id: 'cot-1', stages: ['cotacao', 'negociacao'], anchor: 'quoteAt', offsetMin: 1440, template: 'po2', noReply: 'stage', maxLateMin: 2880 },
  { id: 'cot-2', stages: ['cotacao', 'negociacao'], anchor: 'quoteAt', offsetMin: 4320, template: 'po3', noReply: 'stage', maxLateMin: 2880 },
  { id: 'cot-3', stages: ['cotacao', 'negociacao'], anchor: 'quoteAt', offsetMin: 10080, template: 'po4', noReply: 'stage', maxLateMin: 4320 },
  { id: 'pv-1', stages: ['vendido'], anchor: 'procedureAt', offsetMin: 1440, template: 'pv1', maxLateMin: 1440 },
  { id: 'pv-2', stages: ['vendido'], anchor: 'procedureAt', offsetMin: 10080, template: 'pv2', maxLateMin: 2880 },
  { id: 'reat-1', stages: ['perdido'], anchor: 'stageAt', offsetMin: 43200, template: 'rt1', noReply: 'stage', maxLateMin: 10080 },
];

const DEFAULT_CONFIG = {
  mode: 'approval',            // 'approval' = a equipe aprova cada envio · 'auto' = envia sozinho
  vars: {},                    // clinica, profissional, atendente, procedimento, endereco, opcao1, opcao2, valor
  hours: { start: 8, end: 20, days: [1, 2, 3, 4, 5, 6] },
  timeZone: 'America/Sao_Paulo',
  minGapMin: 90,               // intervalo mínimo entre duas mensagens automáticas ao mesmo lead
  maxAuto: 8,                  // teto de mensagens automáticas por lead
  batch: 50,                   // máximo de mensagens por rodada
  templates: {},               // { pc1: { name: 'primeiro_contato', approved: true } }  (modelos aprovados no Meta)
  language: 'pt_BR',
};

const mergeConfig = (c) => ({ ...DEFAULT_CONFIG, ...(c || {}), vars: { ...(c && c.vars) }, hours: { ...DEFAULT_CONFIG.hours, ...(c && c.hours) }, templates: { ...(c && c.templates) } });

/** Telefone só com dígitos, com 55 na frente quando vier sem o país. Devolve null se não parecer um telefone. */
function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '').replace(/^00/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 && d.length <= 15 ? d : null;
}

const firstName = (name) => {
  const f = String(name ?? '').trim().split(/\s+/)[0] || '';
  return f ? f.charAt(0).toLocaleUpperCase('pt-BR') + f.slice(1).toLocaleLowerCase('pt-BR') : '';
};

function localParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short', minute: 'numeric' }).formatToParts(date);
  const get = (t) => f.find((p) => p.type === t).value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
  return { hour: Number(get('hour')), minute: Number(get('minute')), dow };
}

/** True quando é permitido enviar mensagens agora. */
function withinHours(now, cfg) {
  const { hour, dow } = localParts(now, cfg.timeZone);
  return cfg.hours.days.includes(dow) && hour >= cfg.hours.start && hour < cfg.hours.end;
}

function fmtDateTime(iso, timeZone) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('pt-BR', { timeZone, weekday: 'long', day: '2-digit', month: '2-digit' }).format(d).replace('-feira', '');
  const { hour, minute } = localParts(d, timeZone);
  return { dia: day, hora: minute ? `${hour}h${String(minute).padStart(2, '0')}` : `${hour}h` };
}

function templateVars(lead, cfg) {
  const v = { ...cfg.vars, ...(lead.vars || {}), nome: firstName(lead.name) };
  if (lead.appointmentAt) Object.assign(v, fmtDateTime(lead.appointmentAt, cfg.timeZone), lead.vars && lead.vars.dia ? { dia: lead.vars.dia } : {});
  return v;
}

const anchorTime = (lead, anchor) => {
  const v = anchor === 'stageAt' ? (lead.stageAt || lead.createdAt) : anchor === 'quoteAt' ? (lead.quoteAt || lead.stageAt) : lead[anchor];
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};

/** Chave que marca um passo como já tratado. Inclui a âncora: se a avaliação for remarcada, os lembretes valem de novo. */
const stepKey = (lead, step) => `${step.id}@${anchorTime(lead, step.anchor)}`;

/**
 * Passos da cadência que estão no prazo para este lead.
 * Cada item: { step, dueAt, state: 'due' | 'wait' | 'expired' | 'skip' }
 */
function evaluate(lead, now, cfgIn) {
  const cfg = mergeConfig(cfgIn);
  const out = [];
  if (lead.optOut || lead.humanTakeover || lead.stage === 'desqualificado') return out;
  const t = now.getTime();
  const done = new Set([...(lead.sent || []), ...(lead.skipped || [])]);
  const inboundAt = lead.lastInboundAt ? Date.parse(lead.lastInboundAt) : null;
  const stageAt = lead.stageAt ? Date.parse(lead.stageAt) : null;
  for (const step of CADENCE) {
    const base = anchorTime(lead, step.anchor);
    if (!step.stages.includes(lead.stage) || base == null || done.has(stepKey(lead, step))) continue;
    const dueAt = base + step.offsetMin * MIN;
    let state = 'due';
    if (step.noReply === 'ever' && inboundAt != null) state = 'skip';
    else if (step.noReply === 'stage' && inboundAt != null && stageAt != null && inboundAt > stageAt) state = 'skip';
    else if (t < dueAt) state = 'wait';
    else if (step.maxLateMin != null && t - dueAt > step.maxLateMin * MIN) state = 'expired';
    // lembrete cujo horário já passou antes de o lead entrar na etapa não faz sentido
    if (state === 'due' && stageAt != null && dueAt < stageAt - MIN && step.offsetMin < 0) state = 'expired';
    out.push({ step, dueAt, state });
  }
  return out;
}

/**
 * Monta o envio de um passo: texto livre (dentro da janela de 24h) ou modelo aprovado (fora dela).
 * Devolve { ok:true, mode, body, template? } ou { ok:false, reason }.
 */
function buildMessage(templateId, lead, now, cfgIn) {
  const cfg = mergeConfig(cfgIn);
  const vars = templateVars(lead, cfg);
  const r = render(templateId, vars);
  if (r.unknown) return { ok: false, reason: `modelo "${templateId}" não existe` };
  if (r.missing.length) return { ok: false, reason: `faltam dados: ${r.missing.join(', ')}` };
  const inWindow = lead.lastInboundAt && now.getTime() - Date.parse(lead.lastInboundAt) < 24 * 60 * MIN;
  if (inWindow) return { ok: true, mode: 'text', body: r.text };
  const tpl = cfg.templates[templateId];
  if (!tpl || !tpl.approved || !tpl.name) return { ok: false, reason: 'fora da janela de 24h e sem modelo aprovado no Meta para esta mensagem' };
  return { ok: true, mode: 'template', body: r.text, template: { name: tpl.name, language: tpl.language || cfg.language, params: TEMPLATES[templateId].vars.map((k) => String(vars[k])) } };
}

const OPT_OUT_RE = /(^|\b)(parar|pare|sair|cancelar|descadastrar|remover|n[aã]o quero (mais )?(receber|mensagem|contato)|n[aã]o me (envie|mande|chame)|stop)(\b|$)/i;
// Só mensagens curtas: numa frase longa, "parar" quase sempre quer dizer outra coisa
const isOptOut = (text) => { const t = String(text ?? '').normalize('NFC').trim(); return t.length <= 60 && OPT_OUT_RE.test(t); };

module.exports = { STAGES, CADENCE, DEFAULT_CONFIG, mergeConfig, normalizePhone, firstName, withinHours, evaluate, stepKey, buildMessage, templateVars, isOptOut, localParts };

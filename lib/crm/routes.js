'use strict';
/* Rotas do CRM: /api/crm/*, /api/webhooks/meta e /api/cron/followups. */
const crypto = require('crypto');
const engine = require('./engine');
const svc = require('./service');
const meta = require('./meta');
const { TEMPLATES, metaVersion } = require('./templates');
const { createCrmStore } = require('./store');

const err = (status, message) => Object.assign(new Error(message), { status });
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-api-key'] || ''; };

const publicLead = (l, full) => {
  const { messages, sent, skipped, failures, ...rest } = l;
  return full ? { ...l } : { ...rest, mensagens: (messages || []).length, ultimaMensagem: (messages || []).slice(-1)[0] || null };
};

function cleanConfig(input) {
  const out = {};
  if ('mode' in input) { if (!['approval', 'auto'].includes(input.mode)) throw err(400, 'mode deve ser "approval" ou "auto"'); out.mode = input.mode; }
  if ('vars' in input) {
    if (typeof input.vars !== 'object' || input.vars === null) throw err(400, '"vars" deve ser um objeto');
    out.vars = {};
    for (const [k, v] of Object.entries(input.vars)) out.vars[k] = v == null ? '' : String(v).slice(0, 300);
  }
  if ('hours' in input) {
    const h = input.hours || {};
    const hours = {};
    for (const k of ['start', 'end']) if (k in h) { if (!Number.isInteger(h[k]) || h[k] < 0 || h[k] > 24) throw err(400, `hours.${k} deve ser inteiro de 0 a 24`); hours[k] = h[k]; }
    if ('days' in h) { if (!Array.isArray(h.days) || h.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw err(400, 'hours.days deve ser lista de 0 (domingo) a 6'); hours.days = [...new Set(h.days)]; }
    out.hours = hours;
  }
  for (const [k, max] of [['minGapMin', 10080], ['maxAuto', 50], ['batch', 500]]) {
    if (k in input) { if (!Number.isInteger(input[k]) || input[k] < 0 || input[k] > max) throw err(400, `${k} deve ser inteiro de 0 a ${max}`); out[k] = input[k]; }
  }
  if ('templates' in input) {
    out.templates = {};
    for (const [id, t] of Object.entries(input.templates || {})) {
      if (!TEMPLATES[id]) throw err(400, `Modelo desconhecido: ${id}`);
      out.templates[id] = { name: String((t && t.name) || '').trim(), approved: !!(t && t.approved) };
      if (t && t.language) out.templates[id].language = String(t.language);
    }
  }
  return out;
}

async function handleCrm(req, res, url, parts, ctx) {
  const { send, readBody, readRaw, dataDir, env = process.env, fetchImpl = fetch, now = () => new Date() } = ctx;
  const store = ctx.crmStore || (ctx.crmStore = createCrmStore(dataDir));
  const provider = meta.createProvider(env, fetchImpl);

  /* ---------- webhook do Meta ---------- */
  if (parts[0] === 'webhooks' && parts[1] === 'meta') {
    if (req.method === 'GET') {
      const ch = meta.verifyChallenge(url.searchParams, env.META_VERIFY_TOKEN);
      if (ch == null) return send(res, 403, { error: 'Verificação recusada' });
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ch);
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido' });
    if (!env.META_APP_SECRET) return send(res, 503, { error: 'META_APP_SECRET não configurado' });
    const raw = await readRaw(req);
    if (!meta.verifySignature(raw, req.headers['x-hub-signature-256'], env.META_APP_SECRET)) return send(res, 401, { error: 'Assinatura inválida' });
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'JSON inválido' }); }
    const parsed = meta.parseWebhook(body);
    const db = await store.load();
    const result = { leads: 0, mensagens: 0, erros: [] };
    for (const lg of parsed.leadgens) {
      try {
        const clientId = (db.routing.forms || {})[lg.formId] || (db.routing.pages || {})[lg.pageId] || db.routing.defaultClientId;
        if (!clientId) throw new Error('nenhum cliente configurado para este formulário');
        const data = await meta.fetchLead(lg.leadgenId, env.META_ACCESS_TOKEN, fetchImpl);
        const f = meta.leadFromFieldData(data.field_data);
        if (!f.phone) throw new Error('lead sem telefone válido');
        const r = svc.createLead(db, { clientId, name: f.name, phone: f.phone, email: f.email, answers: f.answers, source: { channel: 'meta-lead-ads', leadgenId: lg.leadgenId, formId: lg.formId, adId: lg.adId || data.ad_id, campaignId: data.campaign_id, adsetId: data.adset_id } }, now());
        if (r.created) result.leads += 1;
      } catch (e) { result.erros.push({ leadgenId: lg.leadgenId, erro: e.message }); svc.addLog(db, 'meta.lead-erro', { leadgenId: lg.leadgenId, erro: e.message }); }
    }
    for (const m of parsed.messages) {
      const clientId = (db.routing.phones || {})[m.phoneNumberId];
      const r = svc.recordInbound(db, { clientId, phone: m.from, name: m.name, text: m.text, id: m.id, at: m.timestamp }, now());
      if (r.leadId) result.mensagens += 1;
    }
    for (const s of parsed.statuses) if (s.status === 'failed') svc.addLog(db, 'whatsapp.falha-entrega', { id: s.id, erro: s.error });
    await store.save(db);
    return send(res, 200, result); // sempre 200: o Meta reenvia tudo se receber erro
  }

  /* ---------- rodada automática (Vercel Cron ou chamada manual) ---------- */
  if (parts[0] === 'cron' && parts[1] === 'followups') {
    if (!env.CRON_SECRET) return send(res, 503, { error: 'CRON_SECRET não configurado' });
    if (!safeEq(bearer(req), env.CRON_SECRET)) return send(res, 401, { error: 'Não autorizado' });
    const db = await store.load();
    const out = await svc.runFollowups(db, { now: now(), provider });
    await store.save(db);
    return send(res, 200, { canal: provider.name, ...out });
  }

  if (parts[0] !== 'crm') return send(res, 404, { error: 'Rota não encontrada' });

  /* ---------- API do CRM (protegida por CRM_API_KEY quando definida) ---------- */
  if (env.CRM_API_KEY) { if (!safeEq(bearer(req), env.CRM_API_KEY)) return send(res, 401, { error: 'Não autorizado' }); }
  else if (env.VERCEL && !env.CRM_ALLOW_OPEN) return send(res, 503, { error: 'Defina CRM_API_KEY antes de usar o CRM em produção: ele guarda dados pessoais de pacientes.' });

  const db = await store.load();
  const r = parts[1];

  if (r === 'status' && req.method === 'GET') {
    return send(res, 200, { canal: provider.name, envioReal: provider.real, webhookConfigurado: !!(env.META_APP_SECRET && env.META_VERIFY_TOKEN), leituraDeLeads: !!env.META_ACCESS_TOKEN, cron: !!env.CRON_SECRET, protegido: !!env.CRM_API_KEY });
  }

  if (r === 'templates' && req.method === 'GET') {
    const cfg = svc.cfgOf(db, url.searchParams.get('clientId'));
    return send(res, 200, Object.keys(TEMPLATES).map((id) => ({ id, texto: TEMPLATES[id].text, ...metaVersion(id), configurado: cfg.templates[id] || null })));
  }

  if (r === 'config' && parts[2]) {
    if (req.method === 'GET') return send(res, 200, svc.cfgOf(db, parts[2]));
    if (req.method === 'PUT') {
      const prev = db.config[parts[2]] || {};
      const c = cleanConfig(await readBody(req));
      db.config[parts[2]] = { ...prev, ...c, vars: { ...prev.vars, ...c.vars }, hours: { ...prev.hours, ...c.hours }, templates: { ...prev.templates, ...c.templates } };
      await store.save(db);
      return send(res, 200, svc.cfgOf(db, parts[2]));
    }
  }

  if (r === 'routing') {
    if (req.method === 'GET') return send(res, 200, db.routing);
    if (req.method === 'PUT') {
      const b = await readBody(req);
      for (const k of ['forms', 'pages', 'phones']) if (b[k]) db.routing[k] = { ...(db.routing[k] || {}), ...Object.fromEntries(Object.entries(b[k]).map(([a, c]) => [String(a), String(c)])) };
      if ('defaultClientId' in b) db.routing.defaultClientId = b.defaultClientId ? String(b.defaultClientId) : null;
      await store.save(db);
      return send(res, 200, db.routing);
    }
  }

  if (r === 'summary' && req.method === 'GET') {
    const clientId = url.searchParams.get('clientId');
    if (!clientId) return send(res, 400, { error: 'Informe clientId' });
    return send(res, 200, svc.summary(db, clientId, url.searchParams.get('month')));
  }

  if (r === 'leads') {
    if (parts.length === 2) {
      if (req.method === 'GET') {
        const cid = url.searchParams.get('clientId'), st = url.searchParams.get('stage');
        const list = Object.values(db.leads).filter((l) => (!cid || l.clientId === cid) && (!st || l.stage === st)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return send(res, 200, list.map((l) => publicLead(l)));
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const out = svc.createLead(db, { clientId: b.clientId, name: b.name, phone: b.phone, email: b.email, vars: b.vars && typeof b.vars === 'object' ? b.vars : {}, source: { channel: 'manual' } }, now());
        await store.save(db);
        return send(res, out.created ? 201 : 200, { ...publicLead(out.lead), created: out.created });
      }
    }
    const lead = db.leads[parts[2]];
    if (!lead) return send(res, 404, { error: 'Lead não encontrado' });
    if (parts.length === 3 && req.method === 'GET') return send(res, 200, publicLead(lead, true));
    if (parts[3] === 'stage' && (req.method === 'PUT' || req.method === 'PATCH')) {
      const b = await readBody(req);
      svc.setStage(db, lead.id, b.stage, { appointmentAt: b.appointmentAt, procedureAt: b.procedureAt }, now());
      await store.save(db);
      return send(res, 200, publicLead(lead));
    }
    if (parts[3] === 'takeover' && req.method === 'PUT') {
      lead.humanTakeover = !!(await readBody(req)).on;
      await store.save(db);
      return send(res, 200, publicLead(lead));
    }
    if (parts[3] === 'optout' && req.method === 'PUT') {
      // Para desfazer um pedido de parar registrado por engano: só com o lead confirmando por escrito
      lead.optOut = !!(await readBody(req)).on;
      svc.addLog(db, lead.optOut ? 'lead.optout-manual' : 'lead.optout-removido', { leadId: lead.id });
      await store.save(db);
      return send(res, 200, publicLead(lead));
    }
    if (parts[3] === 'inbound' && req.method === 'POST') {
      if (provider.real) return send(res, 403, { error: 'Com o WhatsApp real, as respostas chegam pelo webhook' });
      const b = await readBody(req);
      const out = svc.recordInbound(db, { clientId: lead.clientId, phone: lead.phone, text: String(b.text || ''), at: b.at }, now());
      await store.save(db);
      return send(res, 200, out);
    }
  }

  if (r === 'queue') {
    if (parts.length === 2 && req.method === 'GET') {
      const st = url.searchParams.get('status') || 'pendente';
      return send(res, 200, Object.values(db.queue).filter((q) => q.status === st).map((q) => ({ ...q, lead: db.leads[q.leadId] && { id: q.leadId, name: db.leads[q.leadId].name, phone: db.leads[q.leadId].phone } })));
    }
    if (parts.length === 4 && req.method === 'POST' && ['approve', 'reject'].includes(parts[3])) {
      const out = parts[3] === 'approve' ? await svc.approve(db, parts[2], { provider, now: now() }) : svc.reject(db, parts[2]);
      await store.save(db);
      return send(res, 200, out);
    }
  }

  if (r === 'run' && req.method === 'POST') {
    const out = await svc.runFollowups(db, { now: now(), provider });
    await store.save(db);
    return send(res, 200, { canal: provider.name, ...out });
  }

  return send(res, 404, { error: 'Rota não encontrada' });
}

module.exports = { handleCrm };

'use strict';
/*
 * Integração com o Meta: validação e leitura dos webhooks (leads de formulário e WhatsApp)
 * e envio pela API oficial do WhatsApp Business (Cloud API).
 * Variáveis de ambiente: META_APP_SECRET, META_VERIFY_TOKEN, META_ACCESS_TOKEN (leitura dos leads),
 * WHATSAPP_TOKEN e WHATSAPP_PHONE_ID (envio). Sem WHATSAPP_*, o envio é simulado.
 */
const crypto = require('crypto');
const { normalizePhone } = require('./engine');

const GRAPH = 'https://graph.facebook.com/v21.0';

/** Confere a assinatura X-Hub-Signature-256 do corpo bruto com o segredo do app. */
function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !String(header).startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let got;
  try { got = Buffer.from(String(header).slice(7), 'hex'); } catch { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** Resposta ao desafio de verificação do webhook (GET). Devolve o texto ou null. */
function verifyChallenge(query, verifyToken) {
  if (query.get('hub.mode') === 'subscribe' && verifyToken && query.get('hub.verify_token') === verifyToken) return query.get('hub.challenge') || '';
  return null;
}

/** Separa o payload em avisos de lead (formulário), mensagens recebidas e status de entrega. */
function parseWebhook(body) {
  const out = { leadgens: [], messages: [], statuses: [] };
  for (const entry of (body && body.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field === 'leadgen' && v.leadgen_id) {
        out.leadgens.push({ leadgenId: String(v.leadgen_id), formId: v.form_id && String(v.form_id), pageId: String(v.page_id || entry.id || ''), adId: v.ad_id && String(v.ad_id), adgroupId: v.adgroup_id && String(v.adgroup_id), createdTime: v.created_time });
      }
      if (ch.field === 'messages') {
        const phoneNumberId = v.metadata && v.metadata.phone_number_id;
        const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));
        for (const m of v.messages || []) {
          const text = m.type === 'text' ? (m.text && m.text.body) : m.type === 'button' ? (m.button && m.button.text) : m.type === 'interactive' ? ((m.interactive && ((m.interactive.button_reply && m.interactive.button_reply.title) || (m.interactive.list_reply && m.interactive.list_reply.title))) || '') : '';
          out.messages.push({ id: m.id, from: m.from, name: names[m.from] || null, type: m.type, text: text || '', timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null, phoneNumberId });
        }
        for (const s of v.statuses || []) out.statuses.push({ id: s.id, status: s.status, to: s.recipient_id, error: s.errors && s.errors[0] && (s.errors[0].title || s.errors[0].message) });
      }
    }
  }
  return out;
}

/** Converte field_data do formulário do Meta em { name, phone, email, answers }. */
function leadFromFieldData(fieldData) {
  const map = {};
  for (const f of fieldData || []) map[String(f.name || '').toLowerCase()] = (f.values || [])[0];
  const pick = (...keys) => { for (const k of keys) if (map[k]) return map[k]; return null; };
  const phone = normalizePhone(pick('phone_number', 'phone', 'telefone', 'whatsapp', 'celular'));
  const name = pick('full_name', 'nome', 'name', 'nome_completo') || [pick('first_name'), pick('last_name')].filter(Boolean).join(' ') || null;
  return { name, phone, email: pick('email', 'e-mail'), answers: map };
}

/** Busca os dados do lead no Graph API. `fetchImpl` permite trocar a rede nos testes. */
async function fetchLead(leadgenId, token, fetchImpl = fetch) {
  if (!token) throw new Error('META_ACCESS_TOKEN não configurado');
  const r = await fetchImpl(`${GRAPH}/${encodeURIComponent(leadgenId)}?fields=field_data,created_time,ad_id,adset_id,campaign_id,form_id&access_token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Graph API ${r.status}`);
  return j;
}

/**
 * Provedor de envio. Retorna { name, send(lead, message) } e send devolve { ok, id?, error? }.
 * Sem credenciais do WhatsApp, o provedor é "simulado": registra o envio, mas nada sai de verdade.
 */
function createProvider(env = process.env, fetchImpl = fetch) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) {
    let n = 0;
    return { name: 'simulado', real: false, async send() { n += 1; return { ok: true, id: `sim-${Date.now()}-${n}` }; } };
  }
  return {
    name: 'whatsapp', real: true,
    async send(lead, msg) {
      const body = { messaging_product: 'whatsapp', to: lead.phone };
      if (msg.mode === 'template') {
        body.type = 'template';
        body.template = { name: msg.template.name, language: { code: msg.template.language }, components: msg.template.params.length ? [{ type: 'body', parameters: msg.template.params.map((text) => ({ type: 'text', text })) }] : [] };
      } else { body.type = 'text'; body.text = { body: msg.body, preview_url: false }; }
      try {
        const r = await fetchImpl(`${GRAPH}/${encodeURIComponent(env.WHATSAPP_PHONE_ID)}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, error: (j.error && j.error.message) || `WhatsApp API ${r.status}` };
        return { ok: true, id: j.messages && j.messages[0] && j.messages[0].id };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  };
}

module.exports = { verifySignature, verifyChallenge, parseWebhook, leadFromFieldData, fetchLead, createProvider };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-'));
delete process.env.BLOB_READ_WRITE_TOKEN;
const engine = require('../lib/crm/engine');
const svc = require('../lib/crm/service');
const meta = require('../lib/crm/meta');
const tpl = require('../lib/crm/templates');
const { server, crmCtx } = require('../server');

// 2026-10-14 é quarta. 13:00 UTC = 10:00 em Brasília (dentro do horário)
const at = (iso) => new Date(iso);
const T0 = at('2026-10-14T13:00:00Z');
const plus = (d, min) => new Date(d.getTime() + min * 60000);
const VARS = { clinica: 'Clínica Aurora', profissional: 'Dra. Ana', atendente: 'Carla', procedimento: 'harmonização facial', endereco: 'Rua X, 1', opcao1: 'terça às 14h', opcao2: 'quinta às 10h' };
const okProvider = () => { const sent = []; return { name: 'teste', real: false, sent, async send(lead, msg) { sent.push({ to: lead.phone, ...msg }); return { ok: true, id: 'w' + sent.length }; } }; };
const dbWith = (cfg = {}) => { const db = svc.newDb(); db.config.c1 = { vars: VARS, ...cfg }; return db; };

test('telefone: normaliza e rejeita lixo', () => {
  assert.equal(engine.normalizePhone('(11) 98888-7777'), '5511988887777');
  assert.equal(engine.normalizePhone('+55 11 98888-7777'), '5511988887777');
  assert.equal(engine.normalizePhone('123'), null);
  assert.equal(engine.normalizePhone(''), null);
});

test('horário comercial: seg a sáb, 8h às 20h de Brasília', () => {
  const cfg = engine.mergeConfig();
  assert.equal(engine.withinHours(at('2026-10-14T13:00:00Z'), cfg), true);   // qua 10h
  assert.equal(engine.withinHours(at('2026-10-14T10:59:00Z'), cfg), false);  // qua 7h59
  assert.equal(engine.withinHours(at('2026-10-14T23:00:00Z'), cfg), false);  // qua 20h
  assert.equal(engine.withinHours(at('2026-10-18T15:00:00Z'), cfg), false);  // domingo
});

test('opt-out reconhece pedidos de parar e não confunde conversa normal', () => {
  for (const t of ['PARAR', 'Pare de me mandar mensagem', 'não quero mais receber', 'sair', 'não me envie mais']) assert.equal(engine.isOptOut(t), true, t);
  for (const t of ['quero agendar', 'oi, tudo bem?', 'qual o endereço?', 'Oi! Tenho muita vontade de fazer, mas ando sem conseguir parar pra pensar nisso com a correria do trabalho e da casa']) assert.equal(engine.isOptOut(t), false, t);
});

test('modelos: variável faltando bloqueia, nada sai com buraco', () => {
  const r = tpl.render('pc1', { nome: 'Maria', clinica: 'X' });
  assert.deepEqual(r.missing.sort(), ['atendente', 'procedimento']);
  const ok = tpl.render('pc1', { nome: 'Maria', clinica: 'X', atendente: 'Carla', procedimento: 'botox' });
  assert.deepEqual(ok.missing, []);
  assert.ok(!/\{\w+\}/.test(ok.text));
  const m = tpl.metaVersion('pc1');
  assert.ok(m.body.includes('{{1}}') && m.vars.length === 4);
});

test('lead de formulário: 1ª mensagem exige modelo aprovado (fora da janela de 24h)', async () => {
  const db = dbWith({ mode: 'auto' });
  svc.createLead(db, { clientId: 'c1', name: 'maria souza', phone: '11988887777' }, T0);
  const p = okProvider();
  let s = await svc.runFollowups(db, { now: T0, provider: p });
  assert.equal(s.enviados, 0);
  assert.match(s.bloqueados[0].motivo, /modelo aprovado/);
  db.config.c1.templates = { pc1: { name: 'primeiro_contato', approved: true } };
  s = await svc.runFollowups(db, { now: plus(T0, 1), provider: p });
  assert.equal(s.enviados, 1);
  assert.equal(p.sent[0].mode, 'template');
  assert.deepEqual(p.sent[0].template.params, ['Maria', 'Carla', 'Clínica Aurora', 'harmonização facial']);
  assert.equal(p.sent[0].to, '5511988887777');
});

test('cadência de "novo": respeita o intervalo, não repete e para quando o lead responde', async () => {
  const db = dbWith({ mode: 'auto', templates: { pc1: { name: 'a', approved: true }, 'pc-retry': { name: 'b', approved: true }, 'pc-d1': { name: 'c', approved: true }, 'pc-d3': { name: 'd', approved: true } } });
  const { lead } = svc.createLead(db, { clientId: 'c1', name: 'Joana', phone: '11977776666' }, T0);
  const p = okProvider();
  await svc.runFollowups(db, { now: T0, provider: p });
  await svc.runFollowups(db, { now: plus(T0, 5), provider: p });          // mesma coisa de novo: nada
  assert.equal(p.sent.length, 1);
  await svc.runFollowups(db, { now: plus(T0, 60), provider: p });         // ainda cedo para o 2º
  assert.equal(p.sent.length, 1);
  await svc.runFollowups(db, { now: plus(T0, 125), provider: p });        // 2º passo
  assert.equal(p.sent.length, 2);
  svc.recordInbound(db, { clientId: 'c1', phone: lead.phone, text: 'oi, quero saber mais', id: 'in1' }, plus(T0, 130));
  assert.equal(lead.stage, 'respondeu');
  await svc.runFollowups(db, { now: plus(T0, 1500), provider: p });      // 24h depois: não manda mais nada da cadência de "novo"
  assert.equal(p.sent.length, 2);
});

test('pedido de parar cancela tudo e nunca mais envia', async () => {
  const db = dbWith({ mode: 'approval', templates: { pc1: { name: 'a', approved: true } } });
  const { lead } = svc.createLead(db, { clientId: 'c1', name: 'Ana', phone: '11955554444' }, T0);
  const p = okProvider();
  const s = await svc.runFollowups(db, { now: T0, provider: p });
  assert.equal(s.enfileirados, 1);
  svc.recordInbound(db, { clientId: 'c1', phone: lead.phone, text: 'PARAR', id: 'in2' }, plus(T0, 2));
  assert.equal(lead.optOut, true);
  assert.equal(Object.values(db.queue)[0].status, 'cancelado');
  await assert.rejects(svc.approve(db, Object.keys(db.queue)[0], { provider: p, now: plus(T0, 3) }), /Item já foi tratado/);
  await svc.runFollowups(db, { now: plus(T0, 5000), provider: p });
  assert.equal(p.sent.length, 0);
});

test('modo aprovação: cria fila, aprova e envia uma vez só', async () => {
  const db = dbWith({ mode: 'approval', templates: { pc1: { name: 'a', approved: true } } });
  svc.createLead(db, { clientId: 'c1', name: 'Bia', phone: '11944443333' }, T0);
  const p = okProvider();
  let s = await svc.runFollowups(db, { now: T0, provider: p });
  assert.equal(s.enfileirados, 1); assert.equal(p.sent.length, 0);
  s = await svc.runFollowups(db, { now: plus(T0, 1), provider: p });      // não duplica o item da fila
  assert.equal(s.enfileirados, 0);
  const id = Object.keys(db.queue)[0];
  await svc.approve(db, id, { provider: p, now: plus(T0, 2) });
  assert.equal(p.sent.length, 1);
  await assert.rejects(svc.approve(db, id, { provider: p, now: plus(T0, 3) }), /já foi tratado/);
});

test('fora do horário nada é enviado; no horário seguinte sai', async () => {
  const db = dbWith({ mode: 'auto', templates: { pc1: { name: 'a', approved: true } } });
  const night = at('2026-10-14T01:00:00Z'); // 22h do dia 13 em Brasília
  svc.createLead(db, { clientId: 'c1', name: 'Cris', phone: '11933332222' }, night);
  const p = okProvider();
  let s = await svc.runFollowups(db, { now: night, provider: p });
  assert.equal(s.foraDoHorario, true); assert.equal(p.sent.length, 0);
  s = await svc.runFollowups(db, { now: T0, provider: p });
  assert.equal(p.sent.length, 1);
});

test('lembretes da avaliação: D-1 e 2h antes; remarcar refaz; lembrete atrasado é descartado', async () => {
  const db = dbWith({ mode: 'auto', templates: { cf1: { name: 'c1', approved: true }, cf2: { name: 'c2', approved: true } } });
  const { lead } = svc.createLead(db, { clientId: 'c1', name: 'Dani', phone: '11922221111' }, T0);
  svc.recordInbound(db, { clientId: 'c1', phone: lead.phone, text: 'oi', id: 'x1' }, plus(T0, 1));
  const appt = at('2026-10-16T18:00:00Z'); // sexta 15h
  svc.setStage(db, lead.id, 'agendado', { appointmentAt: appt.toISOString() }, plus(T0, 2));
  const p = okProvider();
  await svc.runFollowups(db, { now: at('2026-10-15T19:00:00Z'), provider: p }); // quinta 16h: D-1
  assert.equal(p.sent.length, 1);
  assert.match(p.sent[0].body, /amanhã, sexta.*15h/);
  await svc.runFollowups(db, { now: at('2026-10-16T16:00:00Z'), provider: p }); // sexta 13h: 2h antes
  assert.equal(p.sent.length, 2);
  assert.match(p.sent[1].body, /Hoje é o dia/);
  // avaliação marcada para daqui a 3 horas: o lembrete de "amanhã" nunca é enviado
  const db2 = dbWith({ mode: 'auto' });
  const l2 = svc.createLead(db2, { clientId: 'c1', name: 'Eva', phone: '11911110000' }, T0).lead;
  svc.recordInbound(db2, { clientId: 'c1', phone: l2.phone, text: 'oi', id: 'x2' }, plus(T0, 1));
  svc.setStage(db2, l2.id, 'agendado', { appointmentAt: plus(T0, 180).toISOString() }, plus(T0, 2));
  const p2 = okProvider();
  await svc.runFollowups(db2, { now: plus(T0, 3), provider: p2 });
  assert.equal(p2.sent.length, 0);
  assert.ok(l2.skipped.some((k) => k.startsWith('agend-1@')));
});

test('quem respondeu fica na janela de 24h e recebe texto livre; depois da janela só modelo', async () => {
  const db = dbWith({ mode: 'auto' });
  const { lead } = svc.createLead(db, { clientId: 'c1', name: 'Fer', phone: '11900009999' }, T0);
  svc.recordInbound(db, { clientId: 'c1', phone: lead.phone, text: 'oi', id: 'x3' }, T0);
  svc.setStage(db, lead.id, 'qualificado', {}, T0);
  const m1 = engine.buildMessage('ag3', lead, plus(T0, 60), db.config.c1);
  assert.equal(m1.mode, 'text');
  const m2 = engine.buildMessage('ag3', lead, plus(T0, 60 * 30), db.config.c1);
  assert.equal(m2.ok, false);
});

test('sem os dados da clínica configurados, nada é enviado', async () => {
  const db = svc.newDb();
  svc.createLead(db, { clientId: 'zz', name: 'Gi', phone: '11988880000' }, T0);
  const s = await svc.runFollowups(db, { now: T0, provider: okProvider() });
  assert.equal(s.enviados + s.enfileirados, 0);
  assert.match(s.bloqueados[0].motivo, /faltam dados/);
});

test('falha do provedor: não marca como enviado e desiste depois de 3 tentativas', async () => {
  const db = dbWith({ mode: 'auto', minGapMin: 0, templates: { pc1: { name: 'a', approved: true } } });
  const { lead } = svc.createLead(db, { clientId: 'c1', name: 'Hel', phone: '11977770000' }, T0);
  const bad = { name: 'x', async send() { return { ok: false, error: 'fora do ar' }; } };
  for (let i = 0; i < 3; i++) await svc.runFollowups(db, { now: plus(T0, i), provider: bad });
  assert.equal(lead.sent.length, 0);
  assert.equal(lead.skipped.length, 1);
});

test('lead duplicado (mesmo telefone) não é criado de novo', () => {
  const db = dbWith();
  const a = svc.createLead(db, { clientId: 'c1', name: 'Iza', phone: '11966665555' }, T0);
  const b = svc.createLead(db, { clientId: 'c1', name: 'Iza', phone: '+55 (11) 96666-5555' }, T0);
  assert.equal(b.created, false); assert.equal(a.lead.id, b.lead.id);
  assert.throws(() => svc.createLead(db, { clientId: 'c1', phone: 'abc' }, T0), /Telefone inválido/);
});

test('resumo de funil para o painel de métricas', () => {
  const db = dbWith();
  const mk = (n, ph) => svc.createLead(db, { clientId: 'c1', name: n, phone: ph }, T0).lead;
  const a = mk('A', '11900000001'), b = mk('B', '11900000002'), c = mk('C', '11900000003');
  svc.recordInbound(db, { clientId: 'c1', phone: a.phone, text: 'oi', id: 's1' }, T0);
  svc.setStage(db, a.id, 'qualificado', {}, T0);
  svc.setStage(db, b.id, 'cotacao', {}, T0); svc.setStage(db, b.id, 'vendido', {}, T0);
  const s = svc.summary(db, 'c1', '2026-10');
  assert.deepEqual([s.leads, s.leadsResponderam, s.leadsQualificados, s.cotacoes, s.negociacoes, s.vendas], [3, 1, 2, 1, 1, 1]);
  assert.ok(c);
});

/* ---------- Meta: assinatura, payloads, envio ---------- */
test('assinatura do webhook: aceita a correta e recusa adulterada', () => {
  const raw = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3').update(raw).digest('hex');
  assert.equal(meta.verifySignature(raw, sig, 's3'), true);
  assert.equal(meta.verifySignature(Buffer.from('{"a":2}'), sig, 's3'), false);
  assert.equal(meta.verifySignature(raw, sig, 'outro'), false);
  assert.equal(meta.verifySignature(raw, undefined, 's3'), false);
  assert.equal(meta.verifySignature(raw, 'sha256=zz', 's3'), false);
});

test('payloads do Meta: lead de formulário, mensagem e status', () => {
  const p = meta.parseWebhook({ entry: [
    { id: 'PG1', changes: [{ field: 'leadgen', value: { leadgen_id: 'L1', form_id: 'F1', page_id: 'PG1', ad_id: 'AD1' } }] },
    { id: 'W1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: '5511999990000', profile: { name: 'Lia' } }],
      messages: [{ id: 'wamid.1', from: '5511999990000', timestamp: '1760446800', type: 'text', text: { body: 'oi' } }, { id: 'wamid.2', from: '5511999990000', type: 'button', button: { text: 'Quero agendar' } }],
      statuses: [{ id: 'wamid.0', status: 'failed', recipient_id: '5511999990000', errors: [{ title: 'sem janela' }] }] } }] }] });
  assert.equal(p.leadgens[0].leadgenId, 'L1');
  assert.equal(p.messages[0].name, 'Lia'); assert.equal(p.messages[1].text, 'Quero agendar');
  assert.equal(p.statuses[0].error, 'sem janela');
  const f = meta.leadFromFieldData([{ name: 'full_name', values: ['Lia Costa'] }, { name: 'phone_number', values: ['+5511999990000'] }, { name: 'email', values: ['l@x.com'] }]);
  assert.deepEqual([f.name, f.phone, f.email], ['Lia Costa', '5511999990000', 'l@x.com']);
});

test('provedor WhatsApp monta texto e modelo no formato da Cloud API', async () => {
  const calls = [];
  const fakeFetch = async (u, o) => { calls.push({ u, body: JSON.parse(o.body), auth: o.headers.Authorization }); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }; };
  const pr = meta.createProvider({ WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_ID: '123' }, fakeFetch);
  assert.equal(pr.real, true);
  await pr.send({ phone: '5511900000000' }, { mode: 'text', body: 'olá' });
  await pr.send({ phone: '5511900000000' }, { mode: 'template', body: '', template: { name: 'primeiro_contato', language: 'pt_BR', params: ['Maria', 'Carla'] } });
  assert.match(calls[0].u, /\/123\/messages$/); assert.equal(calls[0].auth, 'Bearer tok');
  assert.deepEqual(calls[0].body.text, { body: 'olá', preview_url: false });
  assert.equal(calls[1].body.template.components[0].parameters[1].text, 'Carla');
  assert.equal(meta.createProvider({}).real, false);
});

/* ---------- API de ponta a ponta ---------- */
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const call = async (p, method = 'GET', body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};

test('API: webhook exige assinatura, cria lead via Graph API e registra resposta', async () => {
  crmCtx.env = { META_APP_SECRET: 'segredo', META_VERIFY_TOKEN: 'vt', META_ACCESS_TOKEN: 'at' };
  crmCtx.now = () => T0;
  crmCtx.fetchImpl = async (u) => ({ ok: true, json: async () => ({ field_data: [{ name: 'full_name', values: ['Paula Lima'] }, { name: 'phone_number', values: ['+5511988880001'] }], ad_id: 'AD9', campaign_id: 'CP9' }) });
  assert.equal((await call('/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc123')).body, 'abc123');
  assert.equal((await call('/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=abc')).status, 403);
  await call('/api/crm/routing', 'PUT', { forms: { F1: 'c1' } }, {});
  const payload = JSON.stringify({ entry: [{ id: 'PG', changes: [{ field: 'leadgen', value: { leadgen_id: 'LG1', form_id: 'F1', page_id: 'PG' } }] }] });
  const sign = (b) => 'sha256=' + crypto.createHmac('sha256', 'segredo').update(b).digest('hex');
  assert.equal((await call('/api/webhooks/meta', 'POST', payload)).status, 401);
  assert.equal((await call('/api/webhooks/meta', 'POST', payload, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status, 401);
  let r = await call('/api/webhooks/meta', 'POST', payload, { 'x-hub-signature-256': sign(payload) });
  assert.equal(r.status, 200); assert.equal(r.body.leads, 1);
  r = await call('/api/webhooks/meta', 'POST', payload, { 'x-hub-signature-256': sign(payload) });
  assert.equal(r.body.leads, 0); // mesmo lead do Meta: não duplica
  const leads = (await call('/api/crm/leads?clientId=c1')).body;
  assert.equal(leads.length, 1);
  assert.equal(leads[0].name, 'Paula Lima'); assert.equal(leads[0].source.adId, 'AD9');
  const msg = JSON.stringify({ entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN' }, messages: [{ id: 'wamid.A', from: '5511988880001', type: 'text', text: { body: 'Oi! Quero saber o valor' } }] } }] }] });
  r = await call('/api/webhooks/meta', 'POST', msg, { 'x-hub-signature-256': sign(msg) });
  assert.equal(r.body.mensagens, 1);
  await call('/api/webhooks/meta', 'POST', msg, { 'x-hub-signature-256': sign(msg) }); // reenvio do Meta
  const lead = (await call('/api/crm/leads/' + leads[0].id)).body;
  assert.equal(lead.stage, 'respondeu'); assert.equal(lead.messages.length, 1);
});

test('API: configuração valida, fila de aprovação, aprovar e resumo', async () => {
  crmCtx.env = { CRM_API_KEY: 'chave' };
  const H = { Authorization: 'Bearer chave' };
  assert.equal((await call('/api/crm/leads')).status, 401);
  assert.equal((await call('/api/crm/config/c2', 'PUT', { mode: 'louco' }, H)).status, 400);
  assert.equal((await call('/api/crm/config/c2', 'PUT', { hours: { start: 30 } }, H)).status, 400);
  assert.equal((await call('/api/crm/config/c2', 'PUT', { templates: { inexistente: { name: 'x', approved: true } } }, H)).status, 400);
  let r = await call('/api/crm/config/c2', 'PUT', { vars: VARS, templates: { pc1: { name: 'primeiro_contato', approved: true } } }, H);
  assert.equal(r.status, 200); assert.equal(r.body.mode, 'approval');
  r = await call('/api/crm/leads', 'POST', { clientId: 'c2', name: 'Rita', phone: '(21) 99999-1111' }, H);
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal((await call('/api/crm/leads', 'POST', { clientId: 'c2', phone: 'x' }, H)).status, 400);
  r = await call('/api/crm/run', 'POST', undefined, H);
  assert.equal(r.body.enfileirados, 1); assert.equal(r.body.canal, 'simulado');
  const q = (await call('/api/crm/queue', 'GET', undefined, H)).body;
  assert.equal(q.length, 1); assert.match(q[0].message.body, /Oi, Rita!/);
  assert.equal((await call(`/api/crm/queue/${q[0].id}/approve`, 'POST', undefined, H)).status, 200);
  assert.equal((await call(`/api/crm/queue/${q[0].id}/approve`, 'POST', undefined, H)).status, 409);
  assert.equal((await call(`/api/crm/leads/${id}/stage`, 'PUT', { stage: 'agendado' }, H)).status, 400); // falta a data
  assert.equal((await call(`/api/crm/leads/${id}/stage`, 'PUT', { stage: 'voando' }, H)).status, 400);
  assert.equal((await call(`/api/crm/leads/${id}/stage`, 'PUT', { stage: 'qualificado' }, H)).body.stage, 'qualificado');
  const s = (await call('/api/crm/summary?clientId=c2', 'GET', undefined, H)).body;
  assert.equal(s.leads, 1); assert.equal(s.leadsQualificados, 1);
  assert.equal((await call('/api/crm/status', 'GET', undefined, H)).body.protegido, true);
});

test('API: cron exige segredo; em produção o CRM exige chave', async () => {
  crmCtx.env = { CRON_SECRET: 'cs' };
  assert.equal((await call('/api/cron/followups')).status, 401);
  assert.equal((await call('/api/cron/followups', 'GET', undefined, { Authorization: 'Bearer cs' })).status, 200);
  crmCtx.env = {};
  assert.equal((await call('/api/cron/followups')).status, 503);
  crmCtx.env = { VERCEL: '1' };
  assert.equal((await call('/api/crm/leads')).status, 503);
  delete crmCtx.env; delete crmCtx.now; delete crmCtx.fetchImpl;
});

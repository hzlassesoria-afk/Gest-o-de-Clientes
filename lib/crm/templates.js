'use strict';
/*
 * Mensagens do follow-up automático (as mesmas do playbook comercial).
 * `vars` lista as variáveis exigidas: se alguma faltar, a mensagem NÃO é enviada (nunca sai texto com buracos).
 * Fora da janela de 24h do WhatsApp só podem ser enviados modelos aprovados pelo Meta: `metaBody` é o texto
 * com {{1}}, {{2}}... para submeter à aprovação, na ordem de `vars`.
 */
const T = {
  pc1: { vars: ['nome', 'atendente', 'clinica', 'procedimento'],
    text: 'Oi, {nome}! Aqui é {atendente}, da {clinica}. Vi que você pediu informações sobre {procedimento}. Que bom ter você por aqui!\n\nPra eu te orientar do jeito certo, posso te fazer 2 perguntinhas rápidas?' },
  'pc-retry': { vars: ['nome', 'procedimento'],
    text: 'Oi, {nome}! Passando só pra confirmar se você recebeu minha mensagem 🙂 Posso te ajudar com {procedimento}?' },
  'pc-d1': { vars: ['nome', 'atendente', 'clinica'],
    text: 'Oi, {nome}, tudo bem? É a {atendente}, da {clinica}. Ainda consigo te ajudar com as informações que você pediu. Quer que eu te explique como funciona a avaliação?' },
  'pc-d3': { vars: ['nome', 'clinica'],
    text: '{nome}, vou encerrar por aqui o seu atendimento na {clinica} pra não te incomodar, tá? Se fizer sentido mais para frente, é só me chamar por aqui 🙂' },
  ag3: { vars: ['nome', 'opcao1', 'opcao2'],
    text: 'Oi, {nome}! Passando pra saber se você conseguiu ver os horários que te passei. Ainda tenho {opcao1} e {opcao2} disponíveis. Quer que eu reserve um pra você?' },
  ag3b: { vars: ['nome'],
    text: 'Oi, {nome}! Posso te ajudar com mais alguma dúvida sobre a avaliação? Se quiser, me diga o melhor dia e horário pra você que eu vejo na agenda 🙂' },
  cf1: { vars: ['nome', 'dia', 'hora', 'clinica'],
    text: 'Oi, {nome}! Passando pra lembrar da sua avaliação amanhã, {dia}, às {hora}, na {clinica} 🙂\n\nPosso confirmar o seu horário?' },
  cf2: { vars: ['nome', 'hora', 'clinica', 'endereco'],
    text: 'Bom dia, {nome}! Hoje é o dia da sua avaliação, às {hora}. Estamos te esperando na {clinica}: {endereco}. Qualquer imprevisto, me avisa por aqui 🙂' },
  cf3: { vars: ['nome', 'clinica', 'opcao1', 'opcao2'],
    text: 'Oi, {nome}! Senti sua falta aqui na {clinica} hoje. Aconteceu algum imprevisto? Sem problema! Posso te encaixar {opcao1} ou {opcao2}. Qual fica melhor?' },
  po2: { vars: ['nome', 'profissional'],
    text: 'Oi, {nome}! Tudo bem? Passando pra saber se você conseguiu olhar o plano que a {profissional} montou. Ficou alguma dúvida que eu possa te ajudar a esclarecer?' },
  po3: { vars: ['nome', 'profissional'],
    text: '{nome}, lembrei de você! Se quiser, posso te explicar como seria o passo a passo do plano que a {profissional} montou, ou ver um horário pro procedimento 🙂' },
  po4: { vars: ['nome', 'profissional'],
    text: 'Oi, {nome}! Vou encerrar por aqui o acompanhamento do seu plano pra não te incomodar, tá? Se fizer sentido mais para frente, é só me chamar que a {profissional} e eu estamos à disposição. Torço pra você ficar bem 🙂' },
  pv1: { vars: ['nome', 'profissional'],
    text: 'Oi, {nome}! Como você está se sentindo hoje? Se tiver qualquer dúvida sobre os cuidados, me chama que eu falo com a {profissional} 🙂' },
  pv2: { vars: ['nome', 'profissional', 'opcao1', 'opcao2'],
    text: 'Oi, {nome}! Uma semana já! Como está sendo a evolução do seu resultado? Se a {profissional} tiver pedido retorno, posso agendar pra você agora: {opcao1} ou {opcao2}?' },
  rt1: { vars: ['nome', 'atendente', 'clinica', 'procedimento', 'profissional'],
    text: 'Oi, {nome}! Aqui é {atendente}, da {clinica}. Faz um tempinho que conversamos sobre {procedimento}. Tudo bem com você? Queria saber se esse assunto ainda faz sentido pra você. Se fizer, a {profissional} está com horários abertos e consigo te encaixar.' },
  optout: { vars: ['nome'],
    text: 'Tudo bem, {nome}. Não vou mais te enviar mensagens. Se mudar de ideia, é só nos chamar por aqui. Obrigada!' },
};

const VAR_RE = /\{(\w+)\}/g;

/** Texto com as variáveis trocadas. `missing` lista as que não tinham valor. */
function render(id, vars) {
  const t = T[id];
  if (!t) return { text: null, missing: [], unknown: true };
  const missing = [];
  const text = t.text.replace(VAR_RE, (m, k) => {
    const v = vars[k];
    if (v == null || String(v).trim() === '') { if (!missing.includes(k)) missing.push(k); return m; }
    return String(v);
  });
  return { text, missing };
}

/** Texto no formato do Meta ({{1}}, {{2}}...) e a ordem das variáveis, para pedir aprovação do modelo. */
function metaVersion(id) {
  const t = T[id];
  const order = [];
  const body = t.text.replace(VAR_RE, (m, k) => { if (!order.includes(k)) order.push(k); return `{{${order.indexOf(k) + 1}}}`; });
  return { body, vars: order };
}

module.exports = { TEMPLATES: T, render, metaVersion };

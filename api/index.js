'use strict';
// Função serverless da Vercel: toda a API (/api/*) passa por aqui via rewrite em vercel.json.
const { handler } = require('../server');
module.exports = handler;

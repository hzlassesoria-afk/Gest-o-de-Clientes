'use strict';
/* Persistência do CRM (um JSON). Vercel Blob quando houver BLOB_READ_WRITE_TOKEN; arquivo local caso contrário. */
const fs = require('fs');
const path = require('path');
const { newDb } = require('./service');

const BLOB_PATH = 'gestao-de-clientes/crm.json';
const fill = (db) => ({ ...newDb(), ...db });

function fileStore(dataDir) {
  const file = path.join(dataDir, 'crm.json');
  return {
    async load() { return fs.existsSync(file) ? fill(JSON.parse(fs.readFileSync(file, 'utf8'))) : newDb(); },
    async save(db) { fs.mkdirSync(dataDir, { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, file); },
  };
}
function blobStore() {
  const { get, put } = require('@vercel/blob');
  return {
    async load() { const r = await get(BLOB_PATH, { access: 'private', useCache: false }); return r ? fill(JSON.parse(await new Response(r.stream).text())) : newDb(); },
    async save(db) { await put(BLOB_PATH, JSON.stringify(db), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 0 }); },
  };
}
const createCrmStore = (dataDir) => (process.env.BLOB_READ_WRITE_TOKEN ? blobStore() : fileStore(dataDir));
module.exports = { createCrmStore };

'use strict';
/*
 * Persistência do cadastro de clientes (um único JSON).
 *  - Com BLOB_READ_WRITE_TOKEN (Vercel): Vercel Blob privado.
 *  - Sem ele (local): arquivo em DATA_DIR/clients.json.
 * Na primeira leitura, começa de seed/clients.json.
 */
const fs = require('fs');
const path = require('path');

const SEED_FILE = path.join(__dirname, '..', 'seed', 'clients.json');
const BLOB_PATH = 'gestao-de-clientes/clients.json';

const seed = () => JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

function fileStore(dataDir) {
  const file = path.join(dataDir, 'clients.json');
  return {
    async load() {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.copyFileSync(SEED_FILE, file);
      }
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    async save(db) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}

function blobStore() {
  const { get, put } = require('@vercel/blob');
  return {
    async load() {
      const r = await get(BLOB_PATH, { access: 'private', useCache: false });
      if (!r) { const db = seed(); await this.save(db); return db; }
      return JSON.parse(await new Response(r.stream).text());
    },
    async save(db) {
      await put(BLOB_PATH, JSON.stringify(db), {
        access: 'private', allowOverwrite: true, addRandomSuffix: false,
        contentType: 'application/json', cacheControlMaxAge: 60,
      });
    },
  };
}

function createStore(dataDir) {
  return process.env.BLOB_READ_WRITE_TOKEN ? blobStore() : fileStore(dataDir);
}

module.exports = { createStore };

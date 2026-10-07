#!/usr/bin/env node
/**
 * Index Synchroniser
 *
 * Builds every index declared by the Mongoose models against the connected
 * database, and reports what it changed.
 *
 * Why this exists: `config/db.js` connects with
 *
 *     autoIndex: process.env.NODE_ENV !== 'production'
 *
 * so a development database quietly builds its own indexes, while a production
 * one never does. Pointing production at a brand-new, empty database therefore
 * gives you a schema with **no unique constraints and no TTL expiry** until
 * something creates them. That means duplicate seller emails, duplicate payment
 * references, and auth tokens that never expire.
 *
 * Run this once against any newly created database, before it takes traffic:
 *
 *     npm run sync-indexes
 *
 * Note: `syncIndexes()` also drops indexes that are present in the database but
 * absent from the schema. That is exactly what you want on a fresh database and
 * when reconciling drift, but review the "dropped" output before running it
 * against a long-lived production database with hand-made indexes.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { connectDB, disconnectDB } = require('../config/db');

/** Load every model so mongoose.modelNames() is complete. */
function loadModels() {
  const modelsDir = path.join(__dirname, '..', 'models');
  for (const file of fs.readdirSync(modelsDir).filter((f) => f.endsWith('.js')).sort()) {
    require(path.join(modelsDir, file));
  }
}

async function main() {
  loadModels();

  const conn = await connectDB();
  console.log(`Connected: ${conn.connection.host}/${conn.connection.name}\n`);

  let created = 0;
  let dropped = 0;
  let failed = 0;

  for (const modelName of mongoose.modelNames().sort()) {
    const model = mongoose.model(modelName);
    try {
      // Returns the list of index names that were dropped to match the schema.
      const removed = await model.syncIndexes();
      const indexes = await model.collection.indexes();
      const names = indexes.map((i) => i.name).filter((n) => n !== '_id_');

      created += names.length;
      dropped += removed.length;

      console.log(`${modelName.padEnd(18)} ${String(names.length).padStart(2)} index(es)`);
      for (const index of indexes) {
        if (index.name === '_id_') continue;
        const flags = [
          index.unique ? 'unique' : null,
          index.sparse ? 'sparse' : null,
          index.expireAfterSeconds !== undefined ? `ttl=${index.expireAfterSeconds}s` : null,
        ].filter(Boolean);
        console.log(`  - ${index.name}${flags.length ? `  [${flags.join(', ')}]` : ''}`);
      }
      if (removed.length) console.log(`  dropped: ${removed.join(', ')}`);
    } catch (error) {
      failed += 1;
      console.error(`${modelName.padEnd(18)} FAILED: ${error.message}`);
    }
  }

  console.log(
    `\n${mongoose.modelNames().length} models · ${created} indexes in place · ${dropped} dropped · ${failed} failed`
  );

  if (failed > 0) process.exitCode = 1;
  await disconnectDB();
}

main().catch(async (error) => {
  console.error(`Index sync failed: ${error.message}`);
  process.exitCode = 1;
  await disconnectDB().catch(() => {});
});

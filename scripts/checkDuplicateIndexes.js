#!/usr/bin/env node
/**
 * Duplicate Index Guard
 *
 * Loads every Mongoose model and fails when two index definitions on the same
 * schema declare an identical key pattern - the condition behind the
 * "Duplicate schema index on {...}" warning Mongoose prints at startup.
 *
 * Usage: npm run check-indexes      (no database connection required)
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const modelsDir = path.join(__dirname, '..', 'models');

let failures = 0;

for (const file of fs.readdirSync(modelsDir).filter((f) => f.endsWith('.js')).sort()) {
  require(path.join(modelsDir, file));
}

for (const modelName of mongoose.modelNames()) {
  const schema = mongoose.model(modelName).schema;
  const seen = new Map();

  for (const [keys] of schema.indexes()) {
    const signature = JSON.stringify(keys);
    if (seen.has(signature)) {
      failures += 1;
      console.error(`[DUPLICATE] ${modelName}: index ${signature} is declared more than once`);
    } else {
      seen.set(signature, true);
    }
  }

  console.log(`${modelName}: ${seen.size} unique index definition(s)`);
}

if (failures > 0) {
  console.error(`\n${failures} duplicate index definition(s) found.`);
  process.exit(1);
}

console.log('\nNo duplicate schema indexes found.');

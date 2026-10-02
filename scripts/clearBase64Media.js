#!/usr/bin/env node
/**
 * Base64 Media Cleanup CLI
 *
 * Clears legacy inline `data:` images that predate the signed Cloudinary
 * upload flow. Those values are the raw file bytes stored as text, which bloat
 * every document and every API response. Sellers simply re-upload.
 *
 * Usage:
 *   npm run clear-base64                 # dry run: report only, changes nothing
 *   npm run clear-base64 -- --apply      # perform the writes
 *
 * What it touches:
 *   businesses.logo   -> '' when it starts with 'data:'
 *   products.images[] -> drops only the data: entries, keeps real URLs
 *
 * Nothing is deleted from Cloudinary: these values were never uploaded there.
 */

require('dotenv').config();

const { connectDB, disconnectDB } = require('../config/db');
const Business = require('../models/Business');
const Product = require('../models/Product');

const isDataUri = (value) => typeof value === 'string' && value.trim().toLowerCase().startsWith('data:');

async function main() {
  const apply = process.argv.includes('--apply');

  await connectDB();

  console.log(apply ? 'Mode: APPLY (writing changes)\n' : 'Mode: DRY RUN (no changes; pass --apply to write)\n');

  // --- Business logos -----------------------------------------------------
  const businesses = await Business.find({ logo: /^data:/i }).select('sellerId name logo').lean();
  console.log(`businesses with inline logo: ${businesses.length}`);
  businesses.forEach((b) =>
    console.log(`  - ${b.name || b.sellerId}  (${Math.round((b.logo || '').length / 1024)} KB inline)`)
  );

  if (apply && businesses.length > 0) {
    const result = await Business.updateMany(
      { logo: /^data:/i },
      { $set: { logo: '', logoPublicId: '' } }
    );
    console.log(`  cleared ${result.modifiedCount} logo(s)\n`);
  } else {
    console.log('');
  }

  // --- Product images -----------------------------------------------------
  const products = await Product.find({ images: /^data:/i }).select('name images').lean();
  console.log(`products with inline images: ${products.length}`);

  let totalImages = 0;
  for (const p of products) {
    const inline = (p.images || []).filter(isDataUri);
    totalImages += inline.length;
    console.log(`  - ${p.name}: ${inline.length} inline of ${(p.images || []).length}`);

    if (apply) {
      const kept = (p.images || []).filter((img) => !isDataUri(img));
      await Product.updateOne({ _id: p._id }, { $set: { images: kept } });
    }
  }

  if (apply) {
    console.log(`  removed ${totalImages} inline image(s)\n`);
  } else {
    console.log('');
  }

  if (!apply) {
    console.log('Dry run complete. Re-run with --apply to write these changes.');
  } else {
    console.log('Cleanup complete. Affected sellers should re-upload their media.');
  }

  await disconnectDB();
}

main().catch(async (err) => {
  console.error('Cleanup failed:', err.message);
  await disconnectDB().catch(() => {});
  process.exitCode = 1;
});

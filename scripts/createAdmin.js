#!/usr/bin/env node
/**
 * Admin / Platform Owner Provisioning CLI
 *
 * Replaces the old hard-coded, auto-seeded development admin accounts.
 * Privileged accounts are now created explicitly and stored in MongoDB.
 *
 * Usage:
 *   npm run create-admin -- --email admin@yourdomain.com --password 'Str0ngPass1' --name "Platform Admin"
 *   npm run create-admin -- --email owner@yourdomain.com --password 'Str0ngPass1' --role platform_owner
 *   npm run create-admin -- --email existing@yourdomain.com --role admin --promote
 *
 * Flags:
 *   --email      (required) login email
 *   --password   at least 8 chars, 1 uppercase, 1 number.
 *                Required when creating; optional with --promote (supply it to
 *                also reset the password of the existing account).
 *   --name       business/display name          (default: "Platform Administration")
 *   --phone      optional Nigerian phone number
 *   --role       seller | admin | platform_owner (default: admin)
 *   --promote    change the role of an account that already exists
 *   --verified   force isEmailVerified (default: true for admin/platform_owner,
 *                false for seller, which must still complete the signup OTP).
 *                Pass `--verified false` to make a privileged account verify.
 *
 * Provisioned privileged accounts are marked email-verified because they never
 * receive a signup OTP, and `requireVerifiedEmail` gates every role equally.
 * `--promote` also backfills the flag on accounts created before this change.
 */

require('dotenv').config();

const { connectDB, disconnectDB } = require('../config/db');
const authService = require('../services/auth/authService');
const { isStrongPassword } = require('../utils/validators');
const User = require('../models/User');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[i + 1];

    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const email = typeof args.email === 'string' ? args.email : '';
  const password = typeof args.password === 'string' ? args.password : '';
  const role = typeof args.role === 'string' ? args.role : 'admin';
  const businessName = typeof args.name === 'string' ? args.name : 'Platform Administration';
  const phone = typeof args.phone === 'string' ? args.phone : '';

  const promote = args.promote === true || args.promote === 'true';

  // Privileged accounts are provisioned verified: they never get a signup OTP,
  // and the verification gate no longer exempts any role.
  const privileged = role === 'admin' || role === 'platform_owner';
  const isEmailVerified = args.verified === undefined ? privileged : args.verified !== 'false';

  if (!email) {
    console.error('Error: --email is required.\n');
    console.error("Example: npm run create-admin -- --email admin@yourdomain.com --password 'Str0ngPass1'");
    process.exitCode = 1;
    return;
  }

  if (!password && !promote) {
    console.error('Error: --password is required when creating an account.\n');
    console.error("Example: npm run create-admin -- --email admin@yourdomain.com --password 'Str0ngPass1'");
    console.error('(Use --promote to change the role of an account that already exists.)');
    process.exitCode = 1;
    return;
  }

  if (password && !isStrongPassword(password)) {
    console.error('Error: password must be at least 8 characters and contain 1 uppercase letter and 1 number.');
    process.exitCode = 1;
    return;
  }

  if (!authService.VALID_ROLES.includes(role)) {
    console.error(`Error: invalid --role "${role}". Allowed: ${authService.VALID_ROLES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  await connectDB();

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });

  if (existing) {
    if (!promote) {
      console.error(
        `Error: a user with email "${normalizedEmail}" already exists (role: ${existing.role}).\n` +
          'Re-run with --promote to change its role.'
      );
      process.exitCode = 1;
      await disconnectDB();
      return;
    }

    const previousRole = existing.role;
    const previouslyVerified = existing.isEmailVerified === true;
    existing.role = role;
    if (password) existing.password = password; // re-hashed by the User pre('save') hook
    existing.isActive = true;
    // Backfill: a privileged account provisioned before the OTP gate landed
    // would otherwise be locked out of every seller-scoped route.
    if (isEmailVerified) existing.isEmailVerified = true;
    await existing.save();

    console.log(`Updated existing account ${normalizedEmail}:`);
    console.log(`  role:     ${previousRole} -> ${existing.role}`);
    console.log(`  password: ${password ? 'reset' : 'unchanged'}`);
    console.log(`  verified: ${previouslyVerified} -> ${existing.isEmailVerified === true}`);
    await disconnectDB();
    return;
  }

  const user = await authService.createAccount({
    businessName,
    email: normalizedEmail,
    password,
    phone,
    role,
    isEmailVerified,
  });

  console.log('Account created successfully:');
  console.log(`  id:    ${user._id.toString()}`);
  console.log(`  email: ${user.email}`);
  console.log(`  role:  ${user.role}`);
  console.log(`  email verified: ${user.isEmailVerified === true}`);

  await disconnectDB();
}

main().catch(async (err) => {
  console.error('Failed to provision account:', err.message);
  await disconnectDB().catch(() => {});
  process.exitCode = 1;
});

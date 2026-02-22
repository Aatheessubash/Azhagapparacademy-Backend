const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { User } = require('../models');

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  'mongodb://localhost:27017/video-learning-platform';

const usage = () => {
  console.log('Usage:');
  console.log('  node scripts/resetPasswordWithKey.js reset <email> <newPassword> <resetKey>');
  console.log('  node scripts/resetPasswordWithKey.js verify <email> <passwordGuess> <resetKey>');
  console.log('Legacy reset form (still supported):');
  console.log('  node scripts/resetPasswordWithKey.js <email> <newPassword> <resetKey>');
};

const parseArgs = () => {
  const modeArg = (process.argv[2] || '').trim().toLowerCase();
  const knownModes = new Set(['reset', 'verify']);

  if (knownModes.has(modeArg)) {
    return {
      mode: modeArg,
      email: (process.argv[3] || '').trim().toLowerCase(),
      secretValue: process.argv[4] || '',
      providedKey: (process.argv[5] || '').trim()
    };
  }

  // Backward compatible mode: <email> <newPassword> <resetKey>
  return {
    mode: 'reset',
    email: (process.argv[2] || '').trim().toLowerCase(),
    secretValue: process.argv[3] || '',
    providedKey: (process.argv[4] || '').trim()
  };
};

const run = async () => {
  const { mode, email, secretValue, providedKey } = parseArgs();
  const expectedKey = (process.env.PASSWORD_RESET_KEY || '').trim();

  if (!email || !secretValue || !providedKey) {
    usage();
    process.exit(1);
  }

  if (!['reset', 'verify'].includes(mode)) {
    console.error(`Unsupported mode "${mode}"`);
    usage();
    process.exit(1);
  }

  if (!expectedKey) {
    console.error('PASSWORD_RESET_KEY is missing in server/.env');
    process.exit(1);
  }

  if (providedKey !== expectedKey) {
    console.error('Invalid reset key');
    process.exit(1);
  }

  if (mode === 'reset' && secretValue.length < 6) {
    console.error('Password must be at least 6 characters');
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      console.error(`User not found: ${email}`);
      process.exit(1);
    }

    if (mode === 'verify') {
      const isMatch = await user.comparePassword(secretValue);
      console.log(`Password match for ${email}: ${isMatch ? 'YES' : 'NO'}`);
      console.log('Original password cannot be revealed because bcrypt is one-way.');
      process.exit(0);
    }

    user.password = secretValue;
    await user.save();

    console.log(`Password reset successful for ${email}`);
    process.exit(0);
  } catch (error) {
    console.error('Reset failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
};

run();

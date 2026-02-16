const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { User } = require('../models');
const { authenticate, generateToken } = require('../middleware/auth');
const { sendPasswordResetOtpEmail } = require('../utils/mail');

const OTP_EXPIRY_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;

const generateOtpCode = () => {
  if (typeof crypto.randomInt === 'function') {
    return crypto.randomInt(100000, 1000000).toString();
  }
  return (Math.floor(100000 + Math.random() * 900000)).toString();
};

// @route   POST /auth/register
// @desc    Register a new user
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validation
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide all required fields' });
    }

    // Check if user exists
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Create user
    user = await User.create({
      name,
      email,
      password,
      role: 'student'
    });

    // Generate token
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   POST /auth/login
// @desc    Login user & get token
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }

    // Check for user
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check status
    if (user.status !== 'active') {
      return res.status(403).json({ message: 'Account is inactive' });
    }

    const token = generateToken(user._id);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /auth/me
// @desc    Get current user
// @access  Private
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /auth/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { name, email } = req.body;
    const updates = {};

    if (typeof name === 'string') {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return res.status(400).json({ message: 'Name cannot be empty' });
      }
      updates.name = trimmedName;
    }

    if (typeof email === 'string') {
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail) {
        return res.status(400).json({ message: 'Email cannot be empty' });
      }

      const existingUser = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: req.user._id }
      });

      if (existingUser) {
        return res.status(400).json({ message: 'Email already in use' });
      }

      updates.email = normalizedEmail;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No profile fields provided' });
    }

    const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true, runValidators: true });

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /auth/change-password
// @desc    Change user password
// @access  Private
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user.id).select('+password');

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid current password' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /auth/forgot-password/request
// @desc    Request OTP for password reset
// @access  Public
router.post('/forgot-password/request', async (req, res) => {
  try {
    const email = req.body.email?.toString().trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await User.findOne({ email, status: 'active' });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email. Please register first.'
      });
    }

    const otpCode = generateOtpCode();
    const otpHash = crypto.createHash('sha256').update(otpCode).digest('hex');
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    user.passwordResetOtpHash = otpHash;
    user.passwordResetOtpExpiresAt = expiresAt;
    user.passwordResetOtpAttempts = 0;
    await user.save({ validateBeforeSave: false });

    try {
      const mailResult = await sendPasswordResetOtpEmail({
        to: user.email,
        userName: user.name,
        otpCode,
        expiresInMinutes: OTP_EXPIRY_MINUTES
      });

      if (mailResult?.skipped) {
        user.passwordResetOtpHash = undefined;
        user.passwordResetOtpExpiresAt = undefined;
        user.passwordResetOtpAttempts = 0;
        await user.save({ validateBeforeSave: false });
        return res.status(500).json({
          success: false,
          message: 'Email service is not configured on server. Configure SMTP or Resend.'
        });
      }
    } catch (mailError) {
      console.error('OTP mail send error:', mailError);
      user.passwordResetOtpHash = undefined;
      user.passwordResetOtpExpiresAt = undefined;
      user.passwordResetOtpAttempts = 0;
      await user.save({ validateBeforeSave: false });
      return res.status(500).json({
        success: false,
        message: 'Unable to send OTP mail. Check server mail provider configuration.'
      });
    }

    return res.json({
      success: true,
      message: 'OTP sent successfully to your email.'
    });
  } catch (error) {
    console.error('Forgot password request error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /auth/forgot-password/reset
// @desc    Reset password using OTP
// @access  Public
router.post('/forgot-password/reset', async (req, res) => {
  try {
    const email = req.body.email?.toString().trim().toLowerCase();
    const otp = req.body.otp?.toString().trim();
    const newPassword = req.body.newPassword?.toString();

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: 'Email, OTP and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const user = await User.findOne({ email, status: 'active' }).select(
      '+passwordResetOtpHash +passwordResetOtpExpiresAt +passwordResetOtpAttempts'
    );

    if (!user || !user.passwordResetOtpHash || !user.passwordResetOtpExpiresAt) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }

    if (user.passwordResetOtpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ message: 'Too many invalid OTP attempts. Please request a new OTP.' });
    }

    if (user.passwordResetOtpExpiresAt < new Date()) {
      user.passwordResetOtpHash = undefined;
      user.passwordResetOtpExpiresAt = undefined;
      user.passwordResetOtpAttempts = 0;
      await user.save({ validateBeforeSave: false });
      return res.status(400).json({ message: 'OTP expired. Please request a new OTP.' });
    }

    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    if (otpHash !== user.passwordResetOtpHash) {
      user.passwordResetOtpAttempts += 1;
      await user.save({ validateBeforeSave: false });
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    user.password = newPassword;
    user.passwordResetOtpHash = undefined;
    user.passwordResetOtpExpiresAt = undefined;
    user.passwordResetOtpAttempts = 0;
    await user.save();

    return res.json({ success: true, message: 'Password reset successful. Please login.' });
  } catch (error) {
    console.error('Forgot password reset error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /auth/setup-admin
// @desc    Create admin user (only if no admin exists usually, but keeping simple)
// @access  Public (should be protected in prod)
router.post('/setup-admin', async (req, res) => {
  try {
    const hasAdmin = await User.exists({ role: 'admin' });

    // Security: allow setup only when no admin exists yet.
    // In production, also require a one-time setup secret.
    if (hasAdmin) {
      return res.status(404).json({ message: 'Not found' });
    }

    const setupSecret = (process.env.SETUP_ADMIN_SECRET || '').trim();
    const providedSecret = req.body?.setupSecret?.toString?.().trim?.() || '';
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction) {
      if (!setupSecret) {
        return res.status(503).json({ message: 'Admin setup is disabled on this server' });
      }
      if (providedSecret !== setupSecret) {
        return res.status(401).json({ message: 'Invalid setup secret' });
      }
    } else if (setupSecret && providedSecret !== setupSecret) {
      // If a secret is configured in non-prod, enforce it as well.
      return res.status(401).json({ message: 'Invalid setup secret' });
    }

    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide all fields' });
    }

    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: 'User already exists' });
    }

    user = await User.create({
      name,
      email,
      password,
      role: 'admin'
    });

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Setup admin error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

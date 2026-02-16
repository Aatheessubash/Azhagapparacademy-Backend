const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { Payment, Course, Progress } = require('../models');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { uploadPaymentProof, handleUploadError } = require('../middleware/upload');
const {
  discardUploadedTempFile,
  persistUploadedFile,
  removeStoredLocalUpload
} = require('../utils/mediaStorage');

// Ensure a progress record exists when a payment is approved
const ensureProgress = async (userId, courseId) => {
  const progress = await Progress.findOne({ userId, courseId });
  if (progress) return progress;
  return Progress.create({
    userId,
    courseId,
    completedLevels: [],
    currentLevel: 1,
    totalProgress: 0
  });
};

// Helper to get file from either proof or proofImage field
const getProofFile = (files = {}) => {
  if (Array.isArray(files.proof) && files.proof[0]) return files.proof[0];
  if (Array.isArray(files.proofImage) && files.proofImage[0]) return files.proofImage[0];
  return null;
};

// @route   GET /payments/my-payments
// @desc    Get current user's payments
// @access  Private
router.get('/my-payments', authenticate, async (req, res) => {
  try {
    const payments = await Payment.find({ userId: req.user._id })
      .populate('courseId', 'title price')
      .sort({ createdAt: -1 });
    res.json({ payments });
  } catch (error) {
    console.error('Get my payments error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /payments/pending
// @desc    Get pending payments (Admin)
// @access  Private/Admin
router.get('/pending', authenticate, requireAdmin, async (req, res) => {
  try {
    const payments = await Payment.find({ status: 'pending' })
      .populate('userId', 'name email')
      .populate('courseId', 'title price')
      .sort({ createdAt: -1 });
    res.json({ payments });
  } catch (error) {
    console.error('Get pending payments error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /payments/all
// @desc    Alias for list all payments (Admin)
// @access  Private/Admin
router.get('/all', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const query = status ? { status } : {};
    const payments = await Payment.find(query)
      .populate('userId', 'name email')
      .populate('courseId', 'title price')
      .sort({ createdAt: -1 });
    res.json({ payments });
  } catch (error) {
    console.error('Get all payments error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /payments
// @desc    Get payments with optional status filter (Admin)
// @access  Private/Admin
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const query = status ? { status } : {};

    const payments = await Payment.find(query)
      .populate('userId', 'name email')
      .populate('courseId', 'title price')
      .sort({ createdAt: -1 });

    res.json({ payments });
  } catch (error) {
    console.error('Get all payments error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /payments/course/:courseId/status
// @desc    Get payment/access status for a course for the current user
// @access  Private
router.get('/course/:courseId/status', authenticate, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    if (req.userRole !== 'admin' && course.status !== 'published') {
      return res.status(404).json({ message: 'Course not found' });
    }

    const payment = await Payment.findOne({
      userId: req.user._id,
      courseId: req.params.courseId
    });

    const progress = await Progress.findOne({
      userId: req.user._id,
      courseId: req.params.courseId
    });

    const isFree = course.price === 0;
    res.json({
      status: payment ? payment.status : (isFree ? 'free' : 'unpaid'),
      hasAccess: isFree || payment?.status === 'approved' || false,
      progress: progress ? progress.totalProgress : 0,
      currentLevel: progress ? progress.currentLevel : 0
    });
  } catch (error) {
    console.error('Get payment status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /payments
// @desc    Submit a new payment
// @access  Private
router.post('/',
  authenticate,
  uploadPaymentProof.fields([
    { name: 'proof', maxCount: 1 },
    { name: 'proofImage', maxCount: 1 }
  ]),
  handleUploadError,
  async (req, res) => {
    const file = getProofFile(req.files);
    let uploadPersisted = false;

    try {
      const courseId = req.body.courseId?.toString().trim();
      const transactionId = req.body.transactionId?.toString().trim();

      if (!file) {
        return res.status(400).json({ message: 'Proof of payment image is required' });
      }

      if (!courseId) {
        await discardUploadedTempFile(file);
        return res.status(400).json({ message: 'Course ID is required' });
      }

      if (!mongoose.Types.ObjectId.isValid(courseId)) {
        await discardUploadedTempFile(file);
        return res.status(400).json({ message: 'Invalid course ID' });
      }

      if (!transactionId) {
        await discardUploadedTempFile(file);
        return res.status(400).json({ message: 'Transaction ID is required' });
      }

      // Check if course exists
      const course = await Course.findById(courseId);
      if (!course) {
        await discardUploadedTempFile(file);
        return res.status(404).json({ message: 'Course not found' });
      }

      if (req.userRole !== 'admin' && course.status !== 'published') {
        await discardUploadedTempFile(file);
        return res.status(404).json({ message: 'Course not found' });
      }

      if (course.price === 0) {
        await discardUploadedTempFile(file);
        return res.status(400).json({ message: 'This course is free. Payment is not required.' });
      }

      const amount = req.body.amount !== undefined && req.body.amount !== ''
        ? Number(req.body.amount)
        : course.price;
      if (!Number.isFinite(amount) || amount <= 0) {
        await discardUploadedTempFile(file);
        return res.status(400).json({ message: 'Invalid payment amount' });
      }

      // Single payment record per user+course. Rejected payments are resubmitted by reusing the same record.
      const existingPayment = await Payment.findOne({
        userId: req.user._id,
        courseId
      });

      if (existingPayment) {
        if (existingPayment.status === 'approved' || existingPayment.status === 'pending') {
          await discardUploadedTempFile(file);
          return res.status(400).json({
            message: 'You have already submitted a payment for this course'
          });
        }
      }

      const localProofPath = `/uploads/payment-proofs/${file.filename}`;
      const persistedProof = await persistUploadedFile({
        file,
        localPath: localProofPath,
        cloudFolder: 'payment-proofs',
        resourceType: 'image'
      });
      uploadPersisted = true;

      const proofImage = persistedProof.path;

      if (existingPayment && existingPayment.status === 'rejected') {
        const oldProofImage = existingPayment.proofImage;
        existingPayment.transactionId = transactionId;
        existingPayment.amount = amount;
        existingPayment.proofImage = proofImage;
        existingPayment.status = 'pending';
        existingPayment.rejectionReason = '';
        existingPayment.notes = '';
        existingPayment.verifiedBy = null;
        existingPayment.verifiedAt = null;

        await existingPayment.save();
        await removeStoredLocalUpload(oldProofImage);
        return res.status(200).json({
          payment: existingPayment,
          message: 'Payment proof resubmitted successfully'
        });
      }

      const payment = await Payment.create({
        userId: req.user._id,
        courseId,
        transactionId,
        amount,
        proofImage,
        status: 'pending'
      });

      res.status(201).json({ payment });
    } catch (error) {
      if (file && !uploadPersisted) {
        await discardUploadedTempFile(file);
      }
      console.error('Create payment error:', error);
      if (error?.code === 11000) {
        return res.status(400).json({
          message: 'A payment record already exists for this course. Please wait for verification or contact admin.'
        });
      }
      if (error?.name === 'ValidationError') {
        const firstMessage = Object.values(error.errors || {})[0]?.message || 'Invalid payment data';
        return res.status(400).json({ message: firstMessage });
      }
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// @route   GET /payments/:id
// @desc    Get payment by ID (Admin or owner)
// @access  Private
router.get('/:id', authenticate, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('userId', 'name email')
      .populate('courseId', 'title price');

    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    const isOwner = payment.userId._id.toString() === req.user._id.toString();
    if (!isOwner && req.userRole !== 'admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    res.json({ payment });
  } catch (error) {
    console.error('Get payment by id error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Unified handler for verify/status updates
const updatePaymentStatus = async (req, res) => {
  const { status, rejectionReason, notes } = req.body;

  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const payment = await Payment.findById(req.params.id);
  if (!payment) {
    return res.status(404).json({ message: 'Payment not found' });
  }

  payment.status = status;
  payment.verifiedBy = req.user._id;
  payment.verifiedAt = Date.now();
  payment.notes = notes || '';
  
  if (status === 'rejected') {
    payment.rejectionReason = rejectionReason || '';
  }

  if (status === 'approved') {
    await ensureProgress(payment.userId, payment.courseId);
  }

  await payment.save();

  const populated = await Payment.findById(payment._id)
    .populate('userId', 'name email')
    .populate('courseId', 'title price');

  return res.json({ payment: populated });
};

// @route   PUT /payments/:id/status
// @desc    Update payment status (Approve/Reject)
// @access  Private/Admin
router.put('/:id/status', authenticate, requireAdmin, async (req, res) => {
  try {
    await updatePaymentStatus(req, res);
  } catch (error) {
    console.error('Update payment status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /payments/:id/verify
// @desc    Alias for updating payment status (Admin)
// @access  Private/Admin
router.post('/:id/verify', authenticate, requireAdmin, async (req, res) => {
  try {
    await updatePaymentStatus(req, res);
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

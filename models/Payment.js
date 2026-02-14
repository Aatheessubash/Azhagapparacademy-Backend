/**
 * Payment Model
 * Stores payment records with verification status
 */

const mongoose = require('mongoose');
const {
  sendPaymentSubmittedEmail,
  sendAdminPaymentSubmittedAlertEmail,
  sendPaymentStatusEmail
} = require('../utils/mail');

const getAdminRecipientEmails = async (User) => {
  const adminUsers = await User.find({ role: 'admin', status: 'active' }).select('email').lean();
  return Array.from(
    new Set(
      adminUsers
        .map((adminUser) => (adminUser.email || '').trim())
        .filter(Boolean)
    )
  );
};

const notifyAdminsPaymentSubmitted = async ({ User, user, course, doc }) => {
  const recipients = await getAdminRecipientEmails(User);
  if (!recipients.length) {
    console.log('[mail] Admin payment notification skipped. No admin email found in database.');
    return;
  }

  const adminMailResults = await Promise.allSettled(
    recipients.map((recipient) =>
      sendAdminPaymentSubmittedAlertEmail({
        to: recipient,
        studentName: user.name,
        studentEmail: user.email,
        courseTitle: course.title,
        amount: doc.amount,
        transactionId: doc.transactionId,
        proofImage: doc.proofImage,
        paymentId: doc._id.toString(),
        submittedAt: doc.createdAt || doc.updatedAt || Date.now()
      })
    )
  );

  const failed = adminMailResults.filter((result) => result.status === 'rejected').length;
  const sent = adminMailResults.length - failed;
  console.log(
    `[mail] Admin payment notification summary (${doc._id}): attempted=${adminMailResults.length}, sent=${sent}, failed=${failed}`
  );
};

const notifyPaymentSubmitted = async ({ User, user, course, doc }) => {
  if (user.email) {
    await sendPaymentSubmittedEmail({
      to: user.email,
      userName: user.name,
      courseTitle: course.title,
      amount: doc.amount,
      transactionId: doc.transactionId
    });
    console.log(`[mail] Payment submitted email sent: ${user.email} (${doc._id})`);
  }

  await notifyAdminsPaymentSubmitted({ User, user, course, doc });
};

const paymentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: [true, 'Course ID is required']
  },
  transactionId: {
    type: String,
    required: [true, 'Transaction ID is required'],
    trim: true
  },
  proofImage: {
    type: String, // Path to payment proof image
    required: [true, 'Payment proof is required']
  },
  amount: {
    type: Number,
    required: [true, 'Payment amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  rejectionReason: {
    type: String,
    maxlength: [500, 'Rejection reason cannot exceed 500 characters'],
    default: ''
  },
  notes: {
    type: String,
    maxlength: [500, 'Notes cannot exceed 500 characters'],
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index to prevent duplicate payments for same user and course
paymentSchema.index({ userId: 1, courseId: 1 }, { unique: true });

paymentSchema.pre('save', async function(next) {
  this.$locals.wasNew = this.isNew;
  this.$locals.statusChanged = false;

  if (!this.isNew && this.isModified('status')) {
    this.$locals.statusChanged = true;
    try {
      const previous = await this.constructor.findById(this._id).select('status').lean();
      this.$locals.previousStatus = previous?.status;
    } catch (error) {
      this.$locals.previousStatus = undefined;
    }
  }

  next();
});

paymentSchema.post('save', function(doc) {
  // Run notifications in the background so API requests don't hang on SMTP/network I/O.
  setImmediate(() => {
    void (async () => {
      try {
        const User = mongoose.model('User');
        const Course = mongoose.model('Course');

        const [user, course] = await Promise.all([
          User.findById(doc.userId).select('name email').lean(),
          Course.findById(doc.courseId).select('title').lean()
        ]);

        if (!user || !course?.title) return;

        if (doc.$locals?.wasNew) {
          await notifyPaymentSubmitted({ User, user, course, doc });
          return;
        }

        const isRejectedToPendingResubmission =
          doc.$locals?.statusChanged &&
          doc.$locals?.previousStatus === 'rejected' &&
          doc.status === 'pending';

        if (isRejectedToPendingResubmission) {
          await notifyPaymentSubmitted({ User, user, course, doc });
          return;
        }

        if (doc.$locals?.statusChanged) {
          await sendPaymentStatusEmail({
            to: user.email,
            userName: user.name,
            courseTitle: course.title,
            amount: doc.amount,
            status: doc.status,
            rejectionReason: doc.rejectionReason
          });
          console.log(
            `[mail] Payment status email sent: ${user.email} (${doc._id}) ${doc.$locals?.previousStatus || 'unknown'} -> ${doc.status}`
          );
        }
      } catch (error) {
        console.error('Payment post-save notification error:', error.message);
      }
    })();
  });
});

paymentSchema.pre('findOneAndUpdate', async function(next) {
  try {
    const existing = await this.model.findOne(this.getQuery()).select('status userId courseId amount transactionId rejectionReason');
    this.setOptions({ _previousPayment: existing });
  } catch (error) {
    this.setOptions({ _previousPayment: null });
  }
  next();
});

paymentSchema.post('findOneAndUpdate', function(doc) {
  const previous = this.getOptions()._previousPayment;
  const statusChanged = doc && previous && previous.status !== doc.status;
  if (!statusChanged) return;

  // Run notifications in the background so API requests don't hang on SMTP/network I/O.
  setImmediate(() => {
    void (async () => {
      try {
        const User = mongoose.model('User');
        const Course = mongoose.model('Course');
        const [user, course] = await Promise.all([
          User.findById(doc.userId).select('name email').lean(),
          Course.findById(doc.courseId).select('title').lean()
        ]);

        if (!user?.email || !course?.title) return;

        await sendPaymentStatusEmail({
          to: user.email,
          userName: user.name,
          courseTitle: course.title,
          amount: doc.amount,
          status: doc.status,
          rejectionReason: doc.rejectionReason
        });

        console.log(`[mail] Payment status email sent (findOneAndUpdate): ${user.email} ${previous.status} -> ${doc.status}`);
      } catch (error) {
        console.error('Payment findOneAndUpdate notification error:', error.message);
      }
    })();
  });
});

module.exports = mongoose.model('Payment', paymentSchema);

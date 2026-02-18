/**
 * Course Model
 * Stores course information with QR code for payment
 */

const mongoose = require('mongoose');
const { sendNewCourseAnnouncementEmail } = require('../utils/mail');

const courseSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Course title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  description: {
    type: String,
    required: [true, 'Course description is required'],
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  price: {
    type: Number,
    required: [true, 'Course price is required'],
    min: [0, 'Price cannot be negative'],
    default: 0
  },
  qrCodeImage: {
    type: String, // Path to QR code image
    default: null
  },
  paymentUpiId: {
    type: String,
    trim: true,
    default: '772-2@oksbi'
  },
  paymentReceiverName: {
    type: String,
    trim: true,
    default: null
  },
  quizEnabled: {
    type: Boolean,
    default: false
  },
  thumbnail: {
    type: String, // Path to course thumbnail
    default: null
  },
  youtubeEmbedUrl: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['draft', 'published', 'archived'],
    default: 'draft'
  },
  totalLevels: {
    type: Number,
    default: 0
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

// Index for search
courseSchema.index({ title: 'text', description: 'text' });

const isPlaceholderEmail = (email = '') => /@example\.com$/i.test(email.trim());

courseSchema.pre('save', function(next) {
  this.$locals.wasNew = this.isNew;
  next();
});

courseSchema.post('save', function(doc) {
  if (!doc?.$locals?.wasNew) return;

  // Run notifications in the background so API requests don't hang on SMTP/network I/O.
  setImmediate(() => {
    void (async () => {
      try {
        const User = mongoose.model('User');
        const users = await User.find({ status: 'active', role: 'student' }).select('name email').lean();
        const deliverableUsers = users.filter((user) => user.email && !isPlaceholderEmail(user.email));

        if (!deliverableUsers.length) {
          console.log(
            `[mail] Course "${doc.title}" notification skipped. totalStudents=${users.length}, deliverable=0`
          );
          return;
        }

        const results = await Promise.allSettled(
          deliverableUsers.map((user) =>
            sendNewCourseAnnouncementEmail({
              to: user.email,
              userName: user.name,
              courseTitle: doc.title,
              description: doc.description,
              price: doc.price,
              status: doc.status
            })
          )
        );

        const failed = results.filter((result) => result.status === 'rejected').length;
        const sent = results.length - failed;
        console.log(
          `[mail] Course "${doc.title}" notification summary: attempted=${results.length}, sent=${sent}, failed=${failed}`
        );
      } catch (error) {
        console.error('Course post-save notification error:', error.message);
      }
    })();
  });
});

module.exports = mongoose.model('Course', courseSchema);

/**
 * Progress Model
 * Stores student progress for each course
 */

const mongoose = require('mongoose');

const levelProgressSchema = new mongoose.Schema({
  levelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Level',
    required: true
  },
  completed: {
    type: Boolean,
    default: false
  },
  completedAt: {
    type: Date,
    default: null
  },
  quizScore: {
    type: Number,
    default: 0
  },
  quizPassed: {
    type: Boolean,
    default: false
  },
  quizAttempts: {
    type: Number,
    default: 0
  },
  videoWatchedPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  }
}, { _id: false });

const progressSchema = new mongoose.Schema({
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
  completedLevels: [levelProgressSchema],
  currentLevel: {
    type: Number,
    default: 1
  },
  totalProgress: {
    type: Number,
    default: 0, // Percentage of course completed
    min: 0,
    max: 100
  },
  courseCompleted: {
    type: Boolean,
    default: false
  },
  courseCompletedAt: {
    type: Date,
    default: null
  },
  enrolledAt: {
    type: Date,
    default: Date.now
  },
  lastAccessedAt: {
    type: Date,
    default: Date.now
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

// Compound index for unique progress per user and course
progressSchema.index({ userId: 1, courseId: 1 }, { unique: true });

// Method to calculate total progress
progressSchema.methods.calculateProgress = function(totalLevels) {
  if (totalLevels === 0) return 0;
  const completedCount = this.completedLevels.filter(l => l.completed).length;
  this.totalProgress = Math.round((completedCount / totalLevels) * 100);
  return this.totalProgress;
};

module.exports = mongoose.model('Progress', progressSchema);

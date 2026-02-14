/**
 * Level Model
 * Stores course levels with video content
 */

const mongoose = require('mongoose');

const levelSchema = new mongoose.Schema({
  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: [true, 'Course ID is required']
  },
  levelNumber: {
    type: Number,
    required: [true, 'Level number is required'],
    min: [1, 'Level number must be at least 1']
  },
  title: {
    type: String,
    required: [true, 'Level title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  description: {
    type: String,
    maxlength: [1000, 'Description cannot exceed 1000 characters']
  },
  videoPath: {
    type: String, // Path to uploaded video file
    default: null
  },
  videoDuration: {
    type: Number, // Duration in seconds
    default: 0
  },
  quizId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz',
    default: null
  },
  quizEnabled: {
    type: Boolean,
    default: false
  },
  order: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
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

// Compound index to ensure unique level numbers per course
levelSchema.index({ courseId: 1, levelNumber: 1 }, { unique: true });

module.exports = mongoose.model('Level', levelSchema);

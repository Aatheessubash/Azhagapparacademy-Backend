/**
 * Quiz Model
 * Stores quizzes with MCQ questions for course levels
 */

const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  question: {
    type: String,
    required: [true, 'Question text is required'],
    maxlength: [500, 'Question cannot exceed 500 characters']
  },
  options: [{
    type: String,
    required: [true, 'Option text is required'],
    maxlength: [200, 'Option cannot exceed 200 characters']
  }],
  correctAnswer: {
    type: Number,
    required: [true, 'Correct answer index is required'],
    min: [0, 'Correct answer must be a valid option index']
  },
  explanation: {
    type: String,
    maxlength: [500, 'Explanation cannot exceed 500 characters'],
    default: ''
  }
}, { _id: true });

const quizSchema = new mongoose.Schema({
  levelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Level',
    required: [true, 'Level ID is required']
  },
  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: [true, 'Course ID is required']
  },
  title: {
    type: String,
    required: [true, 'Quiz title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  description: {
    type: String,
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  questions: [questionSchema],
  passingScore: {
    type: Number,
    default: 70, // Percentage required to pass
    min: [0, 'Passing score must be at least 0'],
    max: [100, 'Passing score cannot exceed 100']
  },
  timeLimit: {
    type: Number, // Time limit in minutes, 0 = no limit
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 3 // Maximum number of attempts allowed
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

module.exports = mongoose.model('Quiz', quizSchema);

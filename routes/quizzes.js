const express = require('express');
const router = express.Router();
const { Quiz, Level, Progress, Payment, Course } = require('../models');
const { authenticate, requireAdmin } = require('../middleware/auth');

const buildStudentQuizView = (quizDoc) => {
  const quiz = quizDoc.toObject ? quizDoc.toObject() : quizDoc;

  return {
    _id: quiz._id,
    levelId: quiz.levelId,
    courseId: quiz.courseId,
    title: quiz.title,
    description: quiz.description,
    passingScore: quiz.passingScore,
    timeLimit: quiz.timeLimit,
    maxAttempts: quiz.maxAttempts,
    status: quiz.status,
    questions: (quiz.questions || []).map((question) => ({
      _id: question._id,
      question: question.question,
      options: question.options || []
    }))
  };
};

// @route   GET /quizzes/level/:levelId
// @desc    Get quiz for a level
// @access  Private
router.get('/level/:levelId', authenticate, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ levelId: req.params.levelId });
    if (!quiz) {
      if (req.userRole === 'admin') {
        return res.json({ quiz: null }); // Allow admin to see null so they can create one
      }
      return res.status(404).json({ message: 'Quiz not found' });
    }

    if (req.userRole !== 'admin' && quiz.status !== 'active') {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    if (req.userRole === 'admin') {
      return res.json({ quiz });
    }

    // Student access control: only for published courses with access.
    const course = await Course.findById(quiz.courseId).select('price status');
    if (!course || course.status !== 'published') {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    if (course.price !== 0) {
      const approvedPayment = await Payment.findOne({
        userId: req.user._id,
        courseId: quiz.courseId,
        status: 'approved'
      });
      if (!approvedPayment) {
        return res.status(403).json({ message: 'Course locked until payment is approved' });
      }
    }

    return res.json({ quiz: buildStudentQuizView(quiz) });
  } catch (error) {
    console.error('Get quiz error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /quizzes
// @desc    Create a quiz
// @access  Private/Admin
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      levelId,
      courseId,
      title,
      description = '',
      questions = [],
      passingScore = 70,
      timeLimit = 0,
      maxAttempts = 3,
      status = 'active'
    } = req.body;

    if (!levelId || !courseId || !title) {
      return res.status(400).json({ message: 'levelId, courseId, and title are required' });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ message: 'At least one question is required' });
    }

    const level = await Level.findById(levelId).select('courseId');
    if (!level) {
      return res.status(404).json({ message: 'Level not found' });
    }

    if (level.courseId.toString() !== courseId.toString()) {
      return res.status(400).json({ message: 'levelId and courseId do not match' });
    }

    const course = await Course.findById(courseId).select('_id');
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    const existingQuiz = await Quiz.findOne({ levelId });
    if (existingQuiz) {
      return res.status(400).json({ message: 'Quiz already exists for this level' });
    }

    const quiz = await Quiz.create({
      levelId,
      courseId,
      title,
      description,
      questions,
      passingScore,
      timeLimit,
      maxAttempts,
      status
    });

    return res.status(201).json({ quiz });
  } catch (error) {
    console.error('Create quiz error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /quizzes/:id
// @desc    Update a quiz
// @access  Private/Admin
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const quiz = await Quiz.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }
    return res.json({ quiz });
  } catch (error) {
    console.error('Update quiz error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /quizzes/:id
// @desc    Delete a quiz
// @access  Private/Admin
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await Quiz.findByIdAndDelete(req.params.id);
    return res.json({ message: 'Quiz deleted' });
  } catch (error) {
    console.error('Delete quiz error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /quizzes/:id/submit
// @desc    Submit quiz answers
// @access  Private
router.post('/:id/submit', authenticate, async (req, res) => {
  try {
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
    const quiz = await Quiz.findById(req.params.id);

    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    if (quiz.status !== 'active' && req.userRole !== 'admin') {
      return res.status(403).json({ message: 'Quiz is not active' });
    }

    if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      return res.status(400).json({ message: 'Quiz has no questions configured' });
    }

    const level = await Level.findById(quiz.levelId);
    if (!level) {
      return res.status(404).json({ message: 'Level not found' });
    }

    const course = await Course.findById(quiz.courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    if (req.userRole !== 'admin' && course.status !== 'published') {
      return res.status(404).json({ message: 'Course not found' });
    }

    // Access control: ensure payment approved or course is free/admin
    const isFree = course.price === 0;
    if (req.userRole !== 'admin' && !isFree) {
      const approvedPayment = await Payment.findOne({
        userId: req.user._id,
        courseId: quiz.courseId,
        status: 'approved'
      });
      if (!approvedPayment) {
        return res.status(403).json({ message: 'Course locked until payment is approved' });
      }
    }

    // Update progress with quiz result
    let progress = await Progress.findOne({
      userId: req.user._id,
      courseId: quiz.courseId
    });

    if (!progress) {
      progress = await Progress.create({
        userId: req.user._id,
        courseId: quiz.courseId,
        completedLevels: [],
        currentLevel: 1
      });
    }

    const levelIndex = progress.completedLevels.findIndex(
      (item) => item.levelId.toString() === level._id.toString()
    );

    const existing = levelIndex > -1 ? progress.completedLevels[levelIndex].toObject() : null;
    const attemptsUsedBefore = existing?.quizAttempts || 0;

    if (req.userRole !== 'admin' && attemptsUsedBefore >= quiz.maxAttempts) {
      return res.status(400).json({
        message: 'Maximum attempts reached for this quiz',
        attemptsUsed: attemptsUsedBefore,
        maxAttempts: quiz.maxAttempts
      });
    }

    const answerMap = new Map();
    for (const item of answers) {
      const questionId = item?.questionId?.toString?.();
      if (!questionId) continue;

      const parsedAnswer = Number(item?.selectedAnswer);
      answerMap.set(questionId, Number.isInteger(parsedAnswer) ? parsedAnswer : -1);
    }

    let correctCount = 0;
    const results = quiz.questions.map((question) => {
      const mapped = answerMap.get(question._id.toString());
      const selectedAnswer = Number.isInteger(mapped) && mapped >= 0 ? mapped : null;
      const isCorrect = selectedAnswer !== null && selectedAnswer === question.correctAnswer;
      if (isCorrect) correctCount += 1;

      return {
        questionId: question._id.toString(),
        question: question.question,
        options: question.options,
        selectedAnswer,
        correctAnswer: question.correctAnswer,
        isCorrect,
        explanation: question.explanation || ''
      };
    });

    const totalQuestions = quiz.questions.length;
    const score = Math.round((correctCount / totalQuestions) * 100);
    const passed = score >= quiz.passingScore;

    const watchedEnough = existing ? (existing.videoWatchedPercent || 0) >= 90 : false;
    const completed = passed && watchedEnough;
    const attemptsUsed = attemptsUsedBefore + 1;

    const levelProgress = {
      levelId: level._id,
      completed,
      completedAt: completed ? Date.now() : existing?.completedAt || null,
      videoWatchedPercent: existing?.videoWatchedPercent || 0,
      quizScore: score,
      quizPassed: passed,
      quizAttempts: attemptsUsed
    };

    if (levelIndex > -1) {
      progress.completedLevels[levelIndex] = {
        ...progress.completedLevels[levelIndex].toObject(),
        ...levelProgress
      };
    } else {
      progress.completedLevels.push(levelProgress);
    }

    if (completed) {
      progress.currentLevel = Math.max(progress.currentLevel || 1, level.levelNumber + 1);
    }

    const totalLevels = await Level.countDocuments({ courseId: quiz.courseId });
    progress.calculateProgress(totalLevels);
    if (progress.currentLevel > totalLevels) {
      progress.courseCompleted = true;
      progress.courseCompletedAt = Date.now();
      progress.totalProgress = 100;
    }

    await progress.save();

    return res.json({
      score,
      passed,
      passingScore: quiz.passingScore,
      correctAnswers: correctCount,
      totalQuestions,
      attemptsUsed,
      maxAttempts: quiz.maxAttempts,
      canRetry: !passed && attemptsUsed < quiz.maxAttempts,
      results,
      progress
    });
  } catch (error) {
    console.error('Submit quiz error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

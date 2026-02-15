const express = require('express');
const router = express.Router();
const { Progress, Course, Level, Payment } = require('../models');
const { authenticate } = require('../middleware/auth');

// Helper: verify user has access to course (free, approved payment, or admin)
const checkCourseAccess = async (user, courseId) => {
  const course = await Course.findById(courseId);
  if (!course) {
    return { course: null, hasAccess: false };
  }

  // Hide draft/archived courses from students.
  if (user.role !== 'admin' && course.status !== 'published') {
    return { course: null, hasAccess: false };
  }

  const isFree = course.price === 0;

  if (user.role === 'admin' || isFree) {
    return { course, hasAccess: true };
  }

  const payment = await Payment.findOne({
    userId: user._id,
    courseId,
    status: 'approved'
  });

  return { course, hasAccess: !!payment };
};

// Helper: ensure progress doc exists
const ensureProgress = async (userId, courseId) => {
  let progress = await Progress.findOne({ userId, courseId });
  if (!progress) {
    progress = await Progress.create({
      userId,
      courseId,
      completedLevels: [],
      currentLevel: 1,
      totalProgress: 0
    });
  }
  return progress;
};

// @route   GET /progress/my-progress
// @desc    Get progress for all enrolled courses
// @access  Private
router.get('/my-progress', authenticate, async (req, res) => {
  try {
    const progress = await Progress.find({ userId: req.user._id })
      .populate('courseId', 'title thumbnail')
      .sort({ updatedAt: -1 });

    // Defensive: filter out orphaned progress entries (e.g., course deleted).
    res.json({ progress: progress.filter((entry) => entry.courseId) });
  } catch (error) {
    console.error('Get my progress error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /progress/course/:courseId
// @desc    Get progress for a specific course
// @access  Private
router.get('/course/:courseId', authenticate, async (req, res) => {
  try {
    const { hasAccess, course } = await checkCourseAccess(req.user, req.params.courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    if (!hasAccess) {
      return res.status(403).json({ message: 'Course locked until payment is approved' });
    }

    let progress = await ensureProgress(req.user._id, req.params.courseId);
    progress = await Progress.findById(progress._id).populate('completedLevels.levelId');

    res.json({ progress });
  } catch (error) {
    console.error('Get course progress error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /progress/level-complete
// @desc    Mark a level as complete
// @access  Private
router.post('/level-complete', authenticate, async (req, res) => {
  try {
    const { courseId, levelId, videoWatchedPercent = 0, quizScore = 0, quizPassed = false } = req.body;

    const level = await Level.findById(levelId);
    if (!level || level.courseId.toString() !== courseId) {
      return res.status(404).json({ message: 'Level not found for this course' });
    }

    const { hasAccess, course } = await checkCourseAccess(req.user, courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }
    if (!hasAccess) {
      return res.status(403).json({ message: 'Course locked until payment is approved' });
    }

    let progress = await ensureProgress(req.user._id, courseId);

    // Enforce sequential learning
    if (level.levelNumber > (progress.currentLevel || 1)) {
      return res.status(403).json({ message: 'Please complete previous levels first' });
    }

    const levelIndex = progress.completedLevels.findIndex(
      (l) => l.levelId.toString() === levelId
    );

    const videoPercent = Math.min(100, Number(videoWatchedPercent) || 0);
    const isVideoComplete = videoPercent >= 90;
    const levelCompleted = level.quizEnabled ? quizPassed : isVideoComplete;

    const levelData = {
      levelId,
      completed: levelCompleted,
      completedAt: levelCompleted ? Date.now() : null,
      videoWatchedPercent: videoPercent,
      quizScore: quizScore || 0,
      quizPassed: quizPassed || false
    };

    if (levelIndex > -1) {
      progress.completedLevels[levelIndex] = {
        ...progress.completedLevels[levelIndex].toObject(),
        ...levelData
      };
    } else {
      progress.completedLevels.push(levelData);
    }

    // Unlock next level automatically if quiz not required
    if (!level.quizEnabled && isVideoComplete) {
      progress.currentLevel = Math.max(progress.currentLevel || 1, level.levelNumber + 1);
    }

    const totalLevels = await Level.countDocuments({ courseId });
    progress.calculateProgress(totalLevels);

    if (progress.currentLevel > totalLevels) {
      progress.courseCompleted = true;
      progress.courseCompletedAt = Date.now();
      progress.totalProgress = 100;
    }

    progress.lastAccessedAt = Date.now();

    await progress.save();

    res.json({ progress });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /progress/course/:courseId/next-level
// @desc    Get next level to learn
// @access  Private
router.get('/course/:courseId/next-level', authenticate, async (req, res) => {
  try {
    const { hasAccess, course } = await checkCourseAccess(req.user, req.params.courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }
    if (!hasAccess) {
      return res.status(403).json({ message: 'Course locked until payment is approved' });
    }

    const progress = await ensureProgress(req.user._id, req.params.courseId);
    const nextLevelNumber = progress.currentLevel || 1;

    const nextLevel = await Level.findOne({
      courseId: req.params.courseId,
      levelNumber: nextLevelNumber
    });

    if (!nextLevel) {
      return res.status(404).json({ message: 'No next level found' });
    }

    res.json({ nextLevel });
  } catch (error) {
    console.error('Get next level error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

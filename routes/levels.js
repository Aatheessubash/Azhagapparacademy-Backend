const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { Level, Payment, Progress, Course } = require('../models');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { uploadVideo, handleUploadError } = require('../middleware/upload');

// @route   GET /levels/course/:courseId
// @desc    Get all levels for a course with lock info for the current user
// @access  Private
router.get('/course/:courseId', authenticate, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    // Students should not see levels for draft/archived courses.
    if (req.userRole !== 'admin' && course.status !== 'published') {
      return res.status(404).json({ message: 'Course not found' });
    }

    const [levels, payment, progress] = await Promise.all([
      Level.find({ courseId: req.params.courseId }).sort({ levelNumber: 1 }),
      Payment.findOne({ userId: req.user._id, courseId: req.params.courseId }),
      Progress.findOne({ userId: req.user._id, courseId: req.params.courseId })
    ]);

    const isFree = course.price === 0;
    const hasAccess = req.userRole === 'admin' ||
      isFree ||
      (payment && payment.status === 'approved');

    const unlockedLevelNumber =
      req.userRole === 'admin'
        ? Number.MAX_SAFE_INTEGER
        : hasAccess
          ? (progress?.currentLevel || 1)
          : 0;

    const levelsWithLock = levels.map(l => ({
      ...l.toObject(),
      locked: l.levelNumber > unlockedLevelNumber
    }));

    res.json({ 
      levels: levelsWithLock, 
      unlockedLevelNumber,
      hasAccess 
    });
  } catch (error) {
    console.error('Get levels error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /levels/:id
// @desc    Get level by ID
// @access  Private
router.get('/:id', authenticate, async (req, res) => {
  try {
    const level = await Level.findById(req.params.id);
    if (!level) {
      return res.status(404).json({ message: 'Level not found' });
    }

    // Students should not be able to fetch levels for draft/archived courses.
    if (req.userRole !== 'admin') {
      const course = await Course.findById(level.courseId).select('status');
      if (!course || course.status !== 'published') {
        return res.status(404).json({ message: 'Level not found' });
      }
    }
    res.json({ level });
  } catch (error) {
    console.error('Get level error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /levels
// @desc    Create a new level
// @access  Private/Admin
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { courseId, title, description, levelNumber, quizEnabled } = req.body;

    const level = await Level.create({
      courseId,
      title,
      description,
      levelNumber,
      quizEnabled: quizEnabled || false,
      videoPath: 'pending', // Placeholder until video is uploaded
      status: 'active'
    });

    // Keep course totalLevels in sync
    const totalLevels = await Level.countDocuments({ courseId });
    await Course.findByIdAndUpdate(courseId, { totalLevels });

    res.status(201).json(level);
  } catch (error) {
    console.error('Create level error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   PUT /levels/:id
// @desc    Update level
// @access  Private/Admin
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const level = await Level.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!level) {
      return res.status(404).json({ message: 'Level not found' });
    }

    res.json(level);
  } catch (error) {
    console.error('Update level error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /levels/:id
// @desc    Delete level
// @access  Private/Admin
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const level = await Level.findById(req.params.id);
    if (!level) {
      return res.status(404).json({ message: 'Level not found' });
    }

    await level.deleteOne();

    // Update course level count
    const totalLevels = await Level.countDocuments({ courseId: level.courseId });
    await Course.findByIdAndUpdate(level.courseId, { totalLevels });

    res.json({ message: 'Level removed' });
  } catch (error) {
    console.error('Delete level error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /levels/:id/video
// @desc    Upload level video
// @access  Private/Admin
router.post('/:id/video',
  authenticate,
  requireAdmin,
  uploadVideo.single('video'),
  handleUploadError,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Please upload a video file' });
      }

      const videoPath = `/uploads/videos/${req.file.filename}`;
      
      const level = await Level.findByIdAndUpdate(
        req.params.id,
        { videoPath: videoPath },
        { new: true }
      );

      res.json(level);
    } catch (error) {
      console.error('Upload video error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// @route   GET /levels/:id/stream
// @desc    Stream video with auth & sequential access checks
// @access  Private
router.get('/:id/stream', authenticate, async (req, res) => {
  try {
    const level = await Level.findById(req.params.id);
    if (!level || !level.videoPath) {
      return res.status(404).json({ message: 'Video not found' });
    }

    const course = await Course.findById(level.courseId);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    if (req.userRole !== 'admin' && course.status !== 'published') {
      return res.status(404).json({ message: 'Course not found' });
    }

    const approvedPayment = await Payment.findOne({
      userId: req.user._id,
      courseId: course._id,
      status: 'approved'
    });

    const hasAccess = req.userRole === 'admin' || course.price === 0 || approvedPayment;
    if (!hasAccess) {
      return res.status(403).json({ message: 'Course locked until payment is approved' });
    }

    // Ensure sequential access for students only. Admins can stream any level.
    if (req.userRole !== 'admin') {
      let progress = await Progress.findOne({ userId: req.user._id, courseId: course._id });
      if (!progress) {
        progress = await Progress.create({
          userId: req.user._id,
          courseId: course._id,
          completedLevels: [],
          currentLevel: 1
        });
      }

      if (level.levelNumber > (progress.currentLevel || 1)) {
        return res.status(403).json({ message: 'You must complete previous levels first' });
      }

      // Update last access timestamp
      progress.lastAccessedAt = Date.now();
      await progress.save();
    }

    const normalizedPath = level.videoPath.startsWith('/')
      ? level.videoPath.substring(1)
      : level.videoPath;
    const videoAbsolutePath = path.join(__dirname, '..', normalizedPath);
    
    if (!fs.existsSync(videoAbsolutePath)) {
      return res.status(404).json({ message: 'Video file missing on server' });
    }

    const stat = fs.statSync(videoAbsolutePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const ext = path.extname(videoAbsolutePath).toLowerCase();
    const contentType =
      ext === '.webm' ? 'video/webm' :
      ext === '.ogg' || ext === '.ogv' ? 'video/ogg' :
      ext === '.mov' ? 'video/quicktime' :
      'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (Number.isNaN(start) || start >= fileSize) {
        res.status(416).set({ 'Content-Range': `bytes */${fileSize}` }).end();
        return;
      }

      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(videoAbsolutePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': contentType,
      };
      res.writeHead(200, head);
      fs.createReadStream(videoAbsolutePath).pipe(res);
    }

  } catch (error) {
    console.error('Stream video error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

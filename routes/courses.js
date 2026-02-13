const express = require('express');
const router = express.Router();
const fs = require('fs');
const { Course, Payment, Progress, Level, User } = require('../models');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { uploadQRCode, uploadThumbnail, handleUploadError } = require('../middleware/upload');

const YOUTUBE_VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

const extractYouTubeVideoId = (value) => {
  const trimmed = value.trim();

  if (YOUTUBE_VIDEO_ID_REGEX.test(trimmed)) {
    return trimmed;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

  if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
    const shortId = pathParts[0] || '';
    return YOUTUBE_VIDEO_ID_REGEX.test(shortId) ? shortId : null;
  }

  const validYouTubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
  if (!validYouTubeHosts.has(hostname)) {
    return null;
  }

  const queryId = parsedUrl.searchParams.get('v');
  if (queryId && YOUTUBE_VIDEO_ID_REGEX.test(queryId)) {
    return queryId;
  }

  if (['embed', 'shorts', 'live'].includes(pathParts[0])) {
    const pathId = pathParts[1] || '';
    return YOUTUBE_VIDEO_ID_REGEX.test(pathId) ? pathId : null;
  }

  return null;
};

const parseYouTubeEmbedUrl = (value) => {
  if (value === undefined) {
    return { hasValue: false };
  }

  if (value === null) {
    return { hasValue: true, url: null };
  }

  if (typeof value !== 'string') {
    return { hasValue: true, error: 'YouTube link must be a valid URL string' };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { hasValue: true, url: null };
  }

  const videoId = extractYouTubeVideoId(trimmed);
  if (!videoId) {
    return { hasValue: true, error: 'Invalid YouTube link. Use a YouTube watch/share/embed URL.' };
  }

  return {
    hasValue: true,
    url: `https://www.youtube.com/embed/${videoId}`
  };
};


// @route   GET /courses
// @desc    Get all courses with optional filtering
// @access  Private (returns access info per user)
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, status } = req.query;
    
    // Build query
    const query = {};

    const isAdmin = req.userRole === 'admin';
    const allowedStatuses = new Set(['draft', 'published', 'archived']);

    // Students can only see published courses. Admins can filter by status.
    if (!isAdmin) {
      query.status = 'published';
    } else if (status && allowedStatuses.has(status)) {
      query.status = status;
    }
    
    if (search) {
      query.title = { $regex: search, $options: 'i' };
    }

    const [courses, payments, progresses] = await Promise.all([
      Course.find(query).sort({ createdAt: -1 }),
      Payment.find({ userId: req.user._id }),
      Progress.find({ userId: req.user._id })
    ]);

    // Map additional access + progress fields for UI
    const coursesWithAccess = await Promise.all(
      courses.map(async (course) => {
        const courseObj = course.toObject();
        const payment = payments.find(p => p.courseId.toString() === course._id.toString());
        const progress = progresses.find(p => p.courseId.toString() === course._id.toString());
        const totalLevels = course.totalLevels || await Level.countDocuments({ courseId: course._id });

        const isFree = course.price === 0;
        const hasAccess = req.userRole === 'admin' ||
          isFree ||
          (payment && payment.status === 'approved');

        return {
          ...courseObj,
          totalLevels,
          paymentStatus: payment ? payment.status : (isFree ? 'free' : 'unpaid'),
          hasAccess,
          progress: progress ? progress.totalProgress : 0
        };
      })
    );

    res.json({ courses: coursesWithAccess });
  } catch (error) {
    console.error('Get courses error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /courses/:id
// @desc    Get course by ID
// @access  Private (returns access info for requesting user)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    // Students should not be able to fetch draft/archived courses by ID.
    if (req.userRole !== 'admin' && course.status !== 'published') {
      return res.status(404).json({ message: 'Course not found' });
    }

    const [levels, payment, progress] = await Promise.all([
      Level.find({ courseId: course._id }).sort({ levelNumber: 1 }),
      Payment.findOne({ userId: req.user._id, courseId: course._id }),
      Progress.findOne({ userId: req.user._id, courseId: course._id })
    ]);

    const isFree = course.price === 0;
    const hasAccess = req.userRole === 'admin' ||
      isFree ||
      (payment && payment.status === 'approved');

    // Auto-create progress for students when they have access (free or approved payment).
    let ensuredProgress = progress;
    if (hasAccess && !progress && req.userRole !== 'admin') {
      ensuredProgress = await Progress.create({
        userId: req.user._id,
        courseId: course._id,
        completedLevels: [],
        currentLevel: 1
      });
    }

    const unlockedLevelNumber =
      req.userRole === 'admin'
        ? Number.MAX_SAFE_INTEGER
        : hasAccess
          ? (ensuredProgress?.currentLevel || 1)
          : 0;
    const safeLevels = levels.map(l => ({
      _id: l._id,
      levelNumber: l.levelNumber,
      title: l.title,
      description: l.description,
      quizEnabled: l.quizEnabled,
      locked: l.levelNumber > unlockedLevelNumber
    }));

    const courseResponse = {
      ...course.toObject(),
      levels: safeLevels,
      paymentStatus: payment ? payment.status : (isFree ? 'free' : 'unpaid'),
      hasAccess,
      userProgress: ensuredProgress || null
    };

    res.json({ course: courseResponse });
  } catch (error) {
    console.error('Get course error:', error);
    if (error.kind === 'ObjectId') {
      return res.status(404).json({ message: 'Course not found' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /courses
// @desc    Create new course
// @access  Private/Admin
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, description, price, quizEnabled, status, youtubeEmbedUrl } = req.body;

    const numericPrice = price !== undefined ? Number(price) : 0;
    if (Number.isNaN(numericPrice) || numericPrice < 0) {
      return res.status(400).json({ message: 'Price must be 0 for free or greater than 0 for paid courses' });
    }

    const parsedYouTube = parseYouTubeEmbedUrl(youtubeEmbedUrl);
    if (parsedYouTube.error) {
      return res.status(400).json({ message: parsedYouTube.error });
    }

    const allowedStatuses = ['draft', 'published', 'archived'];
    const safeStatus = allowedStatuses.includes(status) ? status : 'draft';

    const course = await Course.create({
      title,
      description,
      price: numericPrice,
      quizEnabled: quizEnabled || false,
      youtubeEmbedUrl: parsedYouTube.hasValue ? parsedYouTube.url : null,
      status: safeStatus // Default to draft unless explicitly provided
    });

    res.status(201).json(course);
  } catch (error) {
    console.error('Create course error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   PUT /courses/:id
// @desc    Update course
// @access  Private/Admin
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const updates = { ...req.body };

    const parsedYouTube = parseYouTubeEmbedUrl(updates.youtubeEmbedUrl);
    if (parsedYouTube.error) {
      return res.status(400).json({ message: parsedYouTube.error });
    }
    if (parsedYouTube.hasValue) {
      updates.youtubeEmbedUrl = parsedYouTube.url;
    }

    if (updates.price !== undefined) {
      const numericPrice = Number(updates.price);
      if (Number.isNaN(numericPrice) || numericPrice < 0) {
        return res.status(400).json({ message: 'Price must be 0 for free or greater than 0 for paid courses' });
      }
      updates.price = numericPrice;
    }

    if (updates.status) {
      const allowedStatuses = ['draft', 'published', 'archived'];
      if (!allowedStatuses.includes(updates.status)) {
        return res.status(400).json({ message: 'Invalid status value' });
      }
    }

    const course = await Course.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    res.json(course);
  } catch (error) {
    console.error('Update course error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /courses/:id
// @desc    Delete course
// @access  Private/Admin
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ message: 'Course not found' });
    }

    await course.deleteOne();
    res.json({ message: 'Course removed' });
  } catch (error) {
    console.error('Delete course error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /courses/:id/qr-code
// @desc    Upload course QR code
// @access  Private/Admin
router.post('/:id/qr-code', 
  authenticate, 
  requireAdmin, 
  uploadQRCode.single('qrCode'),
  handleUploadError,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Please upload a file' });
      }

      const { adminPassword } = req.body;
      if (!adminPassword || typeof adminPassword !== 'string') {
        if (req.file?.path) {
          fs.unlink(req.file.path, () => {});
        }
        return res.status(400).json({ message: 'Admin password is required to change QR code' });
      }

      const adminUser = await User.findById(req.user._id).select('+password');
      if (!adminUser) {
        if (req.file?.path) {
          fs.unlink(req.file.path, () => {});
        }
        return res.status(404).json({ message: 'Admin user not found' });
      }

      const isPasswordValid = await adminUser.comparePassword(adminPassword);
      if (!isPasswordValid) {
        if (req.file?.path) {
          fs.unlink(req.file.path, () => {});
        }
        return res.status(401).json({ message: 'Invalid admin password' });
      }

      const qrCodePath = `/uploads/qr-codes/${req.file.filename}`;
      
      const course = await Course.findByIdAndUpdate(
        req.params.id,
        { qrCodeImage: qrCodePath },
        { new: true }
      );

      res.json(course);
    } catch (error) {
      console.error('Upload QR code error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// @route   POST /courses/:id/thumbnail
// @desc    Upload course thumbnail
// @access  Private/Admin
router.post('/:id/thumbnail', 
  authenticate, 
  requireAdmin, 
  uploadThumbnail.single('thumbnail'),
  handleUploadError,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Please upload a file' });
      }

      const thumbnailPath = `/uploads/thumbnails/${req.file.filename}`;
      
      const course = await Course.findByIdAndUpdate(
        req.params.id,
        { thumbnail: thumbnailPath },
        { new: true }
      );

      res.json(course);
    } catch (error) {
      console.error('Upload thumbnail error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

module.exports = router;

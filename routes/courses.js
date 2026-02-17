const express = require('express');
const router = express.Router();
const { Course, Payment, Progress, Level, User } = require('../models');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { uploadQRCode, uploadThumbnail, handleUploadError } = require('../middleware/upload');
const {
  discardUploadedTempFile,
  isRemoteUrl,
  persistUploadedFile,
  removeStoredLocalUpload
} = require('../utils/mediaStorage');

const YOUTUBE_VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const DRIVE_FILE_ID_REGEX = /^[a-zA-Z0-9_-]{20,}$/;

const EXTRA_ALLOWED_IMAGE_HOSTS = (process.env.ALLOWED_EXTERNAL_IMAGE_HOSTS || '')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_EXTERNAL_IMAGE_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
  'drive.usercontent.google.com',
  'res.cloudinary.com',
  ...EXTRA_ALLOWED_IMAGE_HOSTS
]);

const isAllowedExternalImageHost = (hostname = '') => {
  const host = hostname.toLowerCase();
  if (!host) return false;

  if (host.endsWith('.googleusercontent.com')) return true;
  if (ALLOWED_EXTERNAL_IMAGE_HOSTS.has(host)) return true;

  return EXTRA_ALLOWED_IMAGE_HOSTS.some((allowedHost) => {
    if (!allowedHost) return false;
    if (allowedHost.startsWith('*.')) {
      return host.endsWith(allowedHost.slice(1));
    }
    if (allowedHost.startsWith('.')) {
      return host.endsWith(allowedHost);
    }
    return host === allowedHost;
  });
};

const extractGoogleDriveFileId = (rawValue = '') => {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  if (!trimmed.includes('/') && DRIVE_FILE_ID_REGEX.test(trimmed)) {
    return trimmed;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const validHosts = new Set(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com']);
  if (!validHosts.has(hostname)) {
    return null;
  }

  const idFromPath = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (idFromPath?.[1] && DRIVE_FILE_ID_REGEX.test(idFromPath[1])) {
    return idFromPath[1];
  }

  const genericPathId = parsed.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (genericPathId?.[1] && DRIVE_FILE_ID_REGEX.test(genericPathId[1])) {
    return genericPathId[1];
  }

  const idFromQuery = parsed.searchParams.get('id');
  if (idFromQuery && DRIVE_FILE_ID_REGEX.test(idFromQuery)) {
    return idFromQuery;
  }

  return null;
};

const normalizeExternalImageUrl = (rawUrl = '') => {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;

  const driveFileId = extractGoogleDriveFileId(trimmed);
  if (driveFileId) {
    return `https://drive.google.com/uc?export=view&id=${driveFileId}`;
  }

  return trimmed;
};

const verifyAdminPassword = async (adminId, adminPassword) => {
  if (!adminPassword || typeof adminPassword !== 'string') {
    return { ok: false, status: 400, message: 'Admin password is required to change QR code' };
  }

  const adminUser = await User.findById(adminId).select('+password');
  if (!adminUser) {
    return { ok: false, status: 404, message: 'Admin user not found' };
  }

  const isPasswordValid = await adminUser.comparePassword(adminPassword);
  if (!isPasswordValid) {
    return { ok: false, status: 401, message: 'Invalid admin password' };
  }

  return { ok: true };
};

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
          // Only return the YouTube embed URL after the course is unlocked.
          // This keeps it hidden for unpaid users (UI also gates it).
          youtubeEmbedUrl: hasAccess ? courseObj.youtubeEmbedUrl : null,
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
      // Only return YouTube embed URL after unlock (paid/free/admin).
      youtubeEmbedUrl: hasAccess ? course.youtubeEmbedUrl : null,
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

    const safeTitle = typeof title === 'string' ? title.trim() : '';
    const safeDescription = typeof description === 'string' ? description.trim() : '';
    if (!safeTitle || !safeDescription) {
      return res.status(400).json({ message: 'Title and description are required' });
    }

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
      title: safeTitle,
      description: safeDescription,
      price: numericPrice,
      quizEnabled: quizEnabled || false,
      youtubeEmbedUrl: parsedYouTube.hasValue ? parsedYouTube.url : null,
      status: safeStatus // Default to draft unless explicitly provided
    });

    res.status(201).json(course);
  } catch (error) {
    console.error('Create course error:', error);
    if (error?.name === 'ValidationError') {
      const firstMessage = Object.values(error.errors || {})[0]?.message || 'Invalid course data';
      return res.status(400).json({ message: firstMessage });
    }
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

    const oldQrCodePath = course.qrCodeImage;
    const oldThumbnailPath = course.thumbnail;
    await course.deleteOne();
    await Promise.all([
      removeStoredLocalUpload(oldQrCodePath),
      removeStoredLocalUpload(oldThumbnailPath)
    ]);

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
    let uploadPersisted = false;
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Please upload a file' });
      }

      const course = await Course.findById(req.params.id);
      if (!course) {
        await discardUploadedTempFile(req.file);
        return res.status(404).json({ message: 'Course not found' });
      }

      const passwordCheck = await verifyAdminPassword(req.user._id, req.body?.adminPassword);
      if (!passwordCheck.ok) {
        await discardUploadedTempFile(req.file);
        return res.status(passwordCheck.status).json({ message: passwordCheck.message });
      }

      const localQrCodePath = `/uploads/qr-codes/${req.file.filename}`;
      const persistedQr = await persistUploadedFile({
        file: req.file,
        localPath: localQrCodePath,
        cloudFolder: 'qr-codes',
        resourceType: 'image'
      });
      uploadPersisted = true;

      const oldQrCodePath = course.qrCodeImage;
      course.qrCodeImage = persistedQr.path;
      await course.save();
      await removeStoredLocalUpload(oldQrCodePath);

      res.json(course);
    } catch (error) {
      if (req.file && !uploadPersisted) {
        await discardUploadedTempFile(req.file);
      }
      console.error('Upload QR code error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// @route   PUT /courses/:id/qr-code-link
// @desc    Set course QR code image from external link (Google Drive supported)
// @access  Private/Admin
router.put('/:id/qr-code-link',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const course = await Course.findById(req.params.id);
      if (!course) {
        return res.status(404).json({ message: 'Course not found' });
      }

      const passwordCheck = await verifyAdminPassword(req.user._id, req.body?.adminPassword);
      if (!passwordCheck.ok) {
        return res.status(passwordCheck.status).json({ message: passwordCheck.message });
      }

      const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!rawUrl) {
        return res.status(400).json({ message: 'QR image link is required' });
      }

      const normalized = normalizeExternalImageUrl(rawUrl);
      let parsed;
      try {
        parsed = new URL(normalized);
      } catch {
        return res.status(400).json({ message: 'Invalid QR image link URL' });
      }

      if (!['https:', 'http:'].includes(parsed.protocol)) {
        return res.status(400).json({ message: 'QR image link must start with http:// or https://' });
      }

      if (!isAllowedExternalImageHost(parsed.hostname)) {
        return res.status(400).json({ message: 'Only Google Drive image links are allowed' });
      }

      const oldQrCodePath = course.qrCodeImage;
      course.qrCodeImage = normalized;
      await course.save();

      // Clean up only when the old value points to a local upload.
      if (!isRemoteUrl(oldQrCodePath)) {
        await removeStoredLocalUpload(oldQrCodePath);
      }

      res.json(course);
    } catch (error) {
      console.error('Set QR code link error:', error);
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
    let uploadPersisted = false;
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Please upload a file' });
      }

      const course = await Course.findById(req.params.id);
      if (!course) {
        await discardUploadedTempFile(req.file);
        return res.status(404).json({ message: 'Course not found' });
      }

      const localThumbnailPath = `/uploads/thumbnails/${req.file.filename}`;
      const persistedThumbnail = await persistUploadedFile({
        file: req.file,
        localPath: localThumbnailPath,
        cloudFolder: 'thumbnails',
        resourceType: 'image'
      });
      uploadPersisted = true;

      const oldThumbnailPath = course.thumbnail;
      course.thumbnail = persistedThumbnail.path;
      await course.save();
      await removeStoredLocalUpload(oldThumbnailPath);

      res.json(course);
    } catch (error) {
      if (req.file && !uploadPersisted) {
        await discardUploadedTempFile(req.file);
      }
      console.error('Upload thumbnail error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

module.exports = router;

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { Level, Payment, Progress, Course } = require('../models');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { uploadVideo, handleUploadError } = require('../middleware/upload');
const {
  discardUploadedTempFile,
  isRemoteUrl,
  persistUploadedFile,
  removeStoredLocalUpload
} = require('../utils/mediaStorage');

const DRIVE_FILE_ID_REGEX = /^[a-zA-Z0-9_-]{20,}$/;

const EXTRA_ALLOWED_VIDEO_HOSTS = (process.env.ALLOWED_EXTERNAL_VIDEO_HOSTS || '')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_EXTERNAL_VIDEO_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
  'drive.usercontent.google.com',
  'res.cloudinary.com',
  ...EXTRA_ALLOWED_VIDEO_HOSTS
]);

const isAllowedExternalVideoHost = (hostname = '') => {
  const host = hostname.toLowerCase();
  if (!host) return false;

  if (host.endsWith('.googleusercontent.com')) return true;
  if (ALLOWED_EXTERNAL_VIDEO_HOSTS.has(host)) return true;

  return EXTRA_ALLOWED_VIDEO_HOSTS.some((allowedHost) => {
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

  // Allow admins to paste only the Drive file ID.
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

const normalizeExternalVideoUrl = (rawUrl = '') => {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;

  const driveFileId = extractGoogleDriveFileId(trimmed);
  if (driveFileId) {
    return `https://drive.google.com/uc?export=download&id=${driveFileId}`;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'drive.google.com') return trimmed;

  // Convert common Drive share URLs into a "download" URL.
  // Note: large Drive files may still require a manual confirmation page.
  const fileMatch = parsed.pathname.match(/^\/file\/d\/([a-zA-Z0-9_-]+)\//);
  if (fileMatch) {
    return `https://drive.google.com/uc?export=download&id=${fileMatch[1]}`;
  }

  if (parsed.pathname === '/open' || parsed.pathname === '/uc') {
    const id = parsed.searchParams.get('id');
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  }

  return trimmed;
};

const proxyRemoteVideo = async (remoteUrl, req, res) => {
  const controller = new AbortController();
  const cleanup = () => controller.abort();

  res.setHeader('Cache-Control', 'private, max-age=0, no-store');

  // Abort upstream fetch if client disconnects.
  req.on('close', cleanup);

  try {
    const upstream = await fetch(remoteUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: req.headers.range ? { Range: req.headers.range } : undefined
    });

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    if (upstream.ok && contentType.includes('text/html')) {
      res.status(502).json({
        message: 'External video link is not directly streamable. Ensure the Google Drive file is public.'
      });
      return;
    }

    res.status(upstream.status);

    const passthroughHeaders = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
    passthroughHeaders.forEach((header) => {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error('Proxy remote video error:', error);

    if (!res.headersSent) {
      res.status(502).json({ message: 'Failed to stream remote video' });
      return;
    }

    res.end();
  } finally {
    req.removeListener('close', cleanup);
  }
};

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

    const levelsWithLock = levels.map((l) => {
      const obj = l.toObject();
      const hasVideo = Boolean(obj.videoPath && obj.videoPath !== 'pending');

      // Never leak external URLs to students (they could bypass the paywall).
      if (req.userRole !== 'admin') {
        delete obj.videoPath;
      }

      return {
        ...obj,
        hasVideo,
        locked: l.levelNumber > unlockedLevelNumber
      };
    });

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
    const obj = level.toObject();
    const hasVideo = Boolean(obj.videoPath && obj.videoPath !== 'pending');

    // Never leak external URLs to students (they could bypass the paywall).
    if (req.userRole !== 'admin') {
      delete obj.videoPath;
    }

    res.json({ level: { ...obj, hasVideo } });
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
      videoPath: null, // Uploaded later
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

    const oldVideoPath = level.videoPath;
    await level.deleteOne();
    await removeStoredLocalUpload(oldVideoPath);

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
    let uploadPersisted = false;
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Please upload a video file' });
      }

      const level = await Level.findById(req.params.id);
      if (!level) {
        await discardUploadedTempFile(req.file);
        return res.status(404).json({ message: 'Level not found' });
      }

      const localVideoPath = `/uploads/videos/${req.file.filename}`;
      const persistedVideo = await persistUploadedFile({
        file: req.file,
        localPath: localVideoPath,
        cloudFolder: 'videos',
        resourceType: 'video'
      });
      uploadPersisted = true;

      const previousVideoPath = level.videoPath;
      level.videoPath = persistedVideo.path;
      await level.save();
      await removeStoredLocalUpload(previousVideoPath);

      res.json(level);
    } catch (error) {
      if (req.file && !uploadPersisted) {
        await discardUploadedTempFile(req.file);
      }
      console.error('Upload video error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// @route   PUT /levels/:id/video-link
// @desc    Set level video from an external (Google Drive) link
// @access  Private/Admin
router.put('/:id/video-link', authenticate, requireAdmin, async (req, res) => {
  try {
    const rawValue = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!rawValue) {
      return res.status(400).json({ message: 'Video link is required' });
    }

    const normalized = normalizeExternalVideoUrl(rawValue);

    let parsedNormalized;
    try {
      parsedNormalized = new URL(normalized);
    } catch {
      return res.status(400).json({ message: 'Invalid video link URL' });
    }

    if (!['https:', 'http:'].includes(parsedNormalized.protocol)) {
      return res.status(400).json({ message: 'Video link must start with http:// or https://' });
    }

    if (!isAllowedExternalVideoHost(parsedNormalized.hostname)) {
      return res.status(400).json({ message: 'Video host is not allowed. Use a Google Drive link.' });
    }

    const level = await Level.findById(req.params.id);
    if (!level) {
      return res.status(404).json({ message: 'Level not found' });
    }

    const previousVideoPath = level.videoPath;
    level.videoPath = normalized;
    await level.save();
    await removeStoredLocalUpload(previousVideoPath);

    res.json(level);
  } catch (error) {
    console.error('Set video link error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /levels/:id/stream
// @desc    Stream video with auth & sequential access checks
// @access  Private
router.get('/:id/stream', authenticate, async (req, res) => {
  try {
    const level = await Level.findById(req.params.id);
    if (!level || !level.videoPath || level.videoPath === 'pending') {
      return res.status(404).json({ message: 'Video not uploaded yet' });
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

    // External video link support (Google Drive). Proxy so the link is not leaked to clients.
    if (isRemoteUrl(level.videoPath)) {
      const normalizedUrl = normalizeExternalVideoUrl(level.videoPath);

      let parsed;
      try {
        parsed = new URL(normalizedUrl);
      } catch {
        return res.status(400).json({ message: 'Invalid external video URL' });
      }

      if (!isAllowedExternalVideoHost(parsed.hostname)) {
        return res.status(400).json({ message: 'External video host not allowed' });
      }

      await proxyRemoteVideo(normalizedUrl, req, res);
      return;
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

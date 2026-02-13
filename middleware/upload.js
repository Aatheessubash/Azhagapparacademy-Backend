/**
 * File Upload Middleware
 * Multer configuration for video, image, and document uploads
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

// Ensure upload directories exist
const createUploadDirs = () => {
  const dirs = [
    'videos',
    'qr-codes',
    'payment-proofs',
    'thumbnails'
  ];
  
  dirs.forEach(dir => {
    const fullPath = path.join(UPLOAD_ROOT, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  });
};

createUploadDirs();

// Generate unique filename
const generateFilename = (originalname) => {
  const timestamp = Date.now();
  const random = Math.round(Math.random() * 1E9);
  const ext = path.extname(originalname);
  return `${timestamp}-${random}${ext}`;
};

// Video upload configuration
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(UPLOAD_ROOT, 'videos'));
  },
  filename: (req, file, cb) => {
    cb(null, generateFilename(file.originalname));
  }
});

// QR Code upload configuration
const qrCodeStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(UPLOAD_ROOT, 'qr-codes'));
  },
  filename: (req, file, cb) => {
    cb(null, generateFilename(file.originalname));
  }
});

// Payment proof upload configuration
const paymentProofStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(UPLOAD_ROOT, 'payment-proofs'));
  },
  filename: (req, file, cb) => {
    cb(null, generateFilename(file.originalname));
  }
});

// Thumbnail upload configuration
const thumbnailStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(UPLOAD_ROOT, 'thumbnails'));
  },
  filename: (req, file, cb) => {
    cb(null, generateFilename(file.originalname));
  }
});

// File filter for videos
const videoFileFilter = (req, file, cb) => {
  const allowedTypes = /mp4|webm|ogg|mov/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    return cb(null, true);
  }
  cb(new Error('Only video files (mp4, webm, ogg, mov) are allowed!'));
};

// File filter for images
const imageFileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    return cb(null, true);
  }
  cb(new Error('Only image files (jpeg, jpg, png, gif, webp) are allowed!'));
};

// Upload configurations
const uploadVideo = multer({
  storage: videoStorage,
  fileFilter: videoFileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB max file size
  }
});

const uploadQRCode = multer({
  storage: qrCodeStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max file size
  }
});

const uploadPaymentProof = multer({
  storage: paymentProofStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max file size
  }
});

const uploadThumbnail = multer({
  storage: thumbnailStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max file size
  }
});

// Error handler for multer
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        message: 'File size too large.',
        code: 'FILE_TOO_LARGE'
      });
    }
    return res.status(400).json({
      message: err.message,
      code: 'UPLOAD_ERROR'
    });
  }
  
  if (err) {
    return res.status(400).json({
      message: err.message,
      code: 'UPLOAD_ERROR'
    });
  }
  
  next();
};

module.exports = {
  uploadVideo,
  uploadQRCode,
  uploadPaymentProof,
  uploadThumbnail,
  handleUploadError
};

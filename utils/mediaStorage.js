const fs = require('fs');
const path = require('path');

let cloudinaryClient = null;
try {
  cloudinaryClient = require('cloudinary').v2;
} catch {
  cloudinaryClient = null;
}

const cloudinaryCloudName = (
  process.env.CLOUDINARY_CLOUD_NAME ||
  process.env.CLOUD_NAME ||
  ''
).trim();
const cloudinaryApiKey = (
  process.env.CLOUDINARY_API_KEY ||
  process.env.API_KEY ||
  ''
).trim();
const cloudinaryApiSecret = (
  process.env.CLOUDINARY_API_SECRET ||
  process.env.API_SECRET ||
  ''
).trim();
const cloudinaryUploadRoot = (process.env.CLOUDINARY_UPLOAD_ROOT || 'video-learning-platform')
  .trim()
  .replace(/^\/+|\/+$/g, '');
const requireCloudStorage = process.env.REQUIRE_CLOUD_STORAGE !== 'false';
const isProduction = process.env.NODE_ENV === 'production';

const cloudinaryConfigured = Boolean(
  cloudinaryClient &&
  cloudinaryCloudName &&
  cloudinaryApiKey &&
  cloudinaryApiSecret
);

if (cloudinaryConfigured && cloudinaryClient) {
  cloudinaryClient.config({
    cloud_name: cloudinaryCloudName,
    api_key: cloudinaryApiKey,
    api_secret: cloudinaryApiSecret,
    secure: true
  });
}

const isRemoteUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());

const isLocalUploadPath = (value) =>
  typeof value === 'string' && value.trim().startsWith('/uploads/');

const removeLocalFile = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[media] Failed to delete file "${filePath}": ${error.message}`);
    }
  }
};

const discardUploadedTempFile = async (file) => {
  if (!file?.path) return;
  await removeLocalFile(file.path);
};

const resolveLocalUploadAbsolutePath = (storedPath) => {
  const normalized = storedPath.startsWith('/') ? storedPath.slice(1) : storedPath;
  return path.join(__dirname, '..', normalized);
};

const removeStoredLocalUpload = async (storedPath) => {
  if (!isLocalUploadPath(storedPath)) return;
  await removeLocalFile(resolveLocalUploadAbsolutePath(storedPath));
};

const buildCloudinaryFolder = (folder = '') => {
  const cleanedFolder = folder.trim().replace(/^\/+|\/+$/g, '');
  return [cloudinaryUploadRoot, cleanedFolder].filter(Boolean).join('/');
};

const persistUploadedFile = async ({
  file,
  localPath,
  cloudFolder,
  resourceType = 'image'
}) => {
  if (!file) {
    throw new Error('Upload file missing');
  }

  if (!cloudinaryConfigured || !cloudinaryClient) {
    if (isProduction && requireCloudStorage) {
      throw new Error(
        'Cloudinary is not configured in production. Set CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET (or CLOUD_NAME/API_KEY/API_SECRET).'
      );
    }
    return {
      path: localPath,
      provider: 'local'
    };
  }

  try {
    const uploadOptions = {
      folder: buildCloudinaryFolder(cloudFolder),
      resource_type: resourceType,
      use_filename: true,
      unique_filename: true,
      overwrite: false
    };

    const shouldUseLargeUpload = resourceType === 'video' || Number(file.size) > 100 * 1024 * 1024;
    const uploadResult = shouldUseLargeUpload
      ? await cloudinaryClient.uploader.upload_large(file.path, uploadOptions)
      : await cloudinaryClient.uploader.upload(file.path, uploadOptions);

    return {
      path: uploadResult.secure_url || uploadResult.url,
      provider: 'cloudinary',
      publicId: uploadResult.public_id
    };
  } catch (error) {
    throw new Error(`Cloud upload failed: ${error.message}`);
  } finally {
    await discardUploadedTempFile(file);
  }
};

module.exports = {
  cloudinaryConfigured,
  isRemoteUrl,
  isLocalUploadPath,
  discardUploadedTempFile,
  removeStoredLocalUpload,
  persistUploadedFile
};

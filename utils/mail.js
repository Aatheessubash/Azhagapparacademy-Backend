const nodemailer = require('nodemailer');

const parseBoolean = (value, fallback = false) => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeAddress = (value) => (typeof value === 'string' ? value.trim() : '');
const isAbsoluteHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());

const mailProvider = (process.env.MAIL_PROVIDER || '').trim().toLowerCase();
const mailFrom = normalizeAddress(process.env.MAIL_FROM || process.env.MAIL_USER || process.env.SMTP_USER || '');

// SMTP configuration (works for Gmail and custom SMTP providers)
const smtpHost = normalizeAddress(process.env.MAIL_HOST || process.env.SMTP_HOST || '');
const smtpService = normalizeAddress(process.env.MAIL_SERVICE || process.env.SMTP_SERVICE || '');
const smtpUser = normalizeAddress(process.env.MAIL_USER || process.env.SMTP_USER || '');
const smtpPassword = normalizeAddress(
  process.env.MAIL_APP_PASSWORD || process.env.MAIL_PASSWORD || process.env.SMTP_PASS || ''
).replace(/\s+/g, '');

const configuredPort = Number(process.env.MAIL_PORT || process.env.SMTP_PORT);
const defaultPort = smtpHost ? 587 : 465;
const smtpPort = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : defaultPort;

const smtpSecure = parseBoolean(
  process.env.MAIL_SECURE ?? process.env.SMTP_SECURE,
  smtpPort === 465
);

const smtpConfigured = Boolean(
  smtpUser &&
  smtpPassword &&
  (smtpHost || smtpService || !mailProvider || mailProvider === 'smtp' || mailProvider === 'gmail')
);

// Resend (API-based email, useful on hosts that block SMTP ports)
const resendApiKey = normalizeAddress(process.env.RESEND_API_KEY || '');
const resendConfigured = Boolean(resendApiKey && mailFrom);

const prefersResend = mailProvider === 'resend';
const shouldUseResend = prefersResend ? resendConfigured : (!smtpConfigured && resendConfigured);

const transporter = !shouldUseResend && smtpConfigured
  ? nodemailer.createTransport({
      service: smtpService || undefined,
      host: smtpService ? undefined : (smtpHost || 'smtp.gmail.com'),
      port: smtpService ? undefined : smtpPort,
      secure: smtpService ? undefined : smtpSecure,
      family: 4,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      auth: {
        user: smtpUser,
        pass: smtpPassword
      }
    })
  : null;

let smtpVerifyPromise = null;
let smtpVerified = false;

const ensureSmtpReady = async () => {
  if (!transporter || smtpVerified) return;
  if (smtpVerifyPromise) {
    await smtpVerifyPromise;
    return;
  }

  smtpVerifyPromise = transporter.verify()
    .then(() => {
      smtpVerified = true;
      console.log('[mail] SMTP transport verified.');
    })
    .finally(() => {
      smtpVerifyPromise = null;
    });

  await smtpVerifyPromise;
};

const sendViaResend = async ({ to, subject, text, html }) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: mailFrom,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      html
    })
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Resend API error (${response.status}): ${bodyText}`);
  }

  return response.json();
};

const formatINR = (amount) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2
  }).format(amount || 0);

const getPaymentStatusLabel = (status) => {
  if (status === 'approved') return 'Approved';
  if (status === 'rejected') return 'Rejected';
  if (status === 'pending') return 'Processing (Pending)';
  if (status === 'processing') return 'Processing';
  return 'Updated';
};

const buildPublicAssetUrl = (value) => {
  if (!value) return value;
  if (isAbsoluteHttpUrl(value)) return value;

  const publicBaseUrl = normalizeAddress(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  if (!publicBaseUrl) return value;
  return `${publicBaseUrl}${value.startsWith('/') ? '' : '/'}${value}`;
};

const sendMail = async ({ to, subject, text, html }) => {
  if (!to) {
    return { skipped: true, reason: 'MISSING_RECIPIENT' };
  }

  if (shouldUseResend) {
    return sendViaResend({ to, subject, text, html });
  }

  if (!transporter) {
    console.warn('[mail] No email provider configured. Set SMTP values or RESEND_API_KEY.');
    return { skipped: true, reason: 'NOT_CONFIGURED' };
  }

  await ensureSmtpReady();
  return transporter.sendMail({
    from: mailFrom || smtpUser,
    to,
    subject,
    text,
    html
  });
};

const sendPaymentSubmittedEmail = async ({ to, userName, courseTitle, amount, transactionId }) => {
  const subject = 'Payment received - Processing (Pending Verification)';
  const amountText = formatINR(amount);
  const text = [
    `Hi ${userName || 'Learner'},`,
    '',
    'We received your payment submission.',
    `Course: ${courseTitle}`,
    `Amount: ${amountText}`,
    `Transaction ID: ${transactionId}`,
    '',
    'Current status: Processing (Pending Verification).',
    '',
    'Thanks.'
  ].join('\n');

  const html = `
    <p>Hi ${userName || 'Learner'},</p>
    <p>We received your payment submission.</p>
    <p><strong>Course:</strong> ${courseTitle}</p>
    <p><strong>Amount:</strong> ${amountText}</p>
    <p><strong>Transaction ID:</strong> ${transactionId}</p>
    <p>Current status: <strong>Processing (Pending Verification)</strong>.</p>
    <p>Thanks.</p>
  `;

  return sendMail({ to, subject, text, html });
};

const sendAdminPaymentSubmittedAlertEmail = async ({
  to,
  studentName,
  studentEmail,
  courseTitle,
  amount,
  transactionId,
  proofImage,
  paymentId,
  submittedAt
}) => {
  const subject = `New payment proof submitted - ${courseTitle}`;
  const amountText = formatINR(amount);
  const proofUrl = buildPublicAssetUrl(proofImage);
  const submittedAtText = new Date(submittedAt || Date.now()).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  const text = [
    'A student submitted a payment proof that requires verification.',
    '',
    `Student: ${studentName || 'Student'} (${studentEmail || 'N/A'})`,
    `Course: ${courseTitle}`,
    `Amount: ${amountText}`,
    `Transaction ID: ${transactionId}`,
    `Payment ID: ${paymentId || 'N/A'}`,
    `Proof: ${proofUrl || 'N/A'}`,
    `Submitted At: ${submittedAtText}`,
    '',
    'Please review it in the admin payments dashboard.'
  ].join('\n');

  const html = `
    <p>A student submitted a payment proof that requires verification.</p>
    <p><strong>Student:</strong> ${studentName || 'Student'} (${studentEmail || 'N/A'})</p>
    <p><strong>Course:</strong> ${courseTitle}</p>
    <p><strong>Amount:</strong> ${amountText}</p>
    <p><strong>Transaction ID:</strong> ${transactionId}</p>
    <p><strong>Payment ID:</strong> ${paymentId || 'N/A'}</p>
    <p><strong>Proof:</strong> ${proofUrl ? `<a href="${proofUrl}">${proofUrl}</a>` : (proofImage || 'N/A')}</p>
    <p><strong>Submitted At:</strong> ${submittedAtText}</p>
    <p>Please review it in the admin payments dashboard.</p>
  `;

  return sendMail({ to, subject, text, html });
};

const sendPaymentStatusEmail = async ({ to, userName, courseTitle, amount, status, rejectionReason }) => {
  const prettyStatus = getPaymentStatusLabel(status);
  const subject = `Payment ${prettyStatus} - ${courseTitle}`;
  const amountText = formatINR(amount);

  const lines = [
    `Hi ${userName || 'Learner'},`,
    '',
    `Your payment status has been updated to: ${prettyStatus}.`,
    `Course: ${courseTitle}`,
    `Amount: ${amountText}`
  ];

  if (status === 'rejected' && rejectionReason) {
    lines.push(`Reason: ${rejectionReason}`);
  }

  lines.push('', 'Please login to your dashboard for more details.', '', 'Thanks.');

  const text = lines.join('\n');
  const html = `
    <p>Hi ${userName || 'Learner'},</p>
    <p>Your payment status has been updated to: <strong>${prettyStatus}</strong>.</p>
    <p><strong>Course:</strong> ${courseTitle}</p>
    <p><strong>Amount:</strong> ${amountText}</p>
    ${status === 'rejected' && rejectionReason ? `<p><strong>Reason:</strong> ${rejectionReason}</p>` : ''}
    <p>Please login to your dashboard for more details.</p>
    <p>Thanks.</p>
  `;

  return sendMail({ to, subject, text, html });
};

const sendNewCourseAnnouncementEmail = async ({ to, userName, courseTitle, description, price, status }) => {
  const subject = `New Course Added: ${courseTitle}`;
  const priceText = Number(price) === 0 ? 'Free' : formatINR(price);
  const visibility = status === 'published' ? 'Published now' : `Status: ${status || 'draft'}`;
  const safeDescription = (description || '').toString().trim();
  const descriptionText = safeDescription ? safeDescription.slice(0, 220) : 'A new course has been added to the platform.';

  const text = [
    `Hi ${userName || 'Learner'},`,
    '',
    'A new course has been added on the platform.',
    `Course: ${courseTitle}`,
    `Price: ${priceText}`,
    visibility,
    '',
    descriptionText,
    '',
    'Login to your dashboard to check details.'
  ].join('\n');

  const html = `
    <p>Hi ${userName || 'Learner'},</p>
    <p>A new course has been added on the platform.</p>
    <p><strong>Course:</strong> ${courseTitle}</p>
    <p><strong>Price:</strong> ${priceText}</p>
    <p><strong>${visibility}</strong></p>
    <p>${descriptionText}</p>
    <p>Login to your dashboard to check details.</p>
  `;

  return sendMail({ to, subject, text, html });
};

const sendPasswordResetOtpEmail = async ({ to, userName, otpCode, expiresInMinutes = 10 }) => {
  const subject = 'Password Reset OTP';
  const text = [
    `Hi ${userName || 'Learner'},`,
    '',
    'We received a request to reset your password.',
    `Your OTP code is: ${otpCode}`,
    `This OTP will expire in ${expiresInMinutes} minutes.`,
    '',
    'If you did not request this, you can ignore this email.'
  ].join('\n');

  const html = `
    <p>Hi ${userName || 'Learner'},</p>
    <p>We received a request to reset your password.</p>
    <p><strong>Your OTP code is: ${otpCode}</strong></p>
    <p>This OTP will expire in <strong>${expiresInMinutes} minutes</strong>.</p>
    <p>If you did not request this, you can ignore this email.</p>
  `;

  return sendMail({ to, subject, text, html });
};

module.exports = {
  sendMail,
  sendPaymentSubmittedEmail,
  sendAdminPaymentSubmittedAlertEmail,
  sendPaymentStatusEmail,
  sendNewCourseAnnouncementEmail,
  sendPasswordResetOtpEmail
};

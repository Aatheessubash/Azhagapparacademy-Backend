const nodemailer = require('nodemailer');

const mailUser = process.env.MAIL_USER || '';
const mailAppPassword = (process.env.MAIL_APP_PASSWORD || '').replace(/\s+/g, '');

const isMailConfigured = Boolean(mailUser && mailAppPassword);

const transporter = isMailConfigured
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      family: 4,
      // Avoid requests hanging forever when SMTP is slow/unreachable.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      auth: {
        user: mailUser,
        pass: mailAppPassword
      }
    })
  : null;

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

const sendMail = async ({ to, subject, text, html }) => {
  if (!isMailConfigured || !transporter) {
    console.warn('[mail] MAIL_USER/MAIL_APP_PASSWORD not configured. Skipping email send.');
    return { skipped: true };
  }

  if (!to) {
    return { skipped: true };
  }

  return transporter.sendMail({
    from: process.env.MAIL_FROM || mailUser,
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
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').toString().trim().replace(/\/+$/, '');
  const proofUrl = publicBaseUrl && proofImage ? `${publicBaseUrl}${proofImage.startsWith('/') ? '' : '/'}${proofImage}` : proofImage;
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

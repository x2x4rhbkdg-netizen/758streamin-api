/** =========================================
 *  UTILS: Email (CommonJS)
 *  ========================================= */
const nodemailer = require("nodemailer");
const { env } = require("../config/env.cjs");

function isEmailConfigured() {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

async function sendResetEmail({ to, name, resetUrl }) {
  if (!isEmailConfigured()) {
    const err = new Error("email not configured");
    err.code = "EMAIL_NOT_CONFIGURED";
    throw err;
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER
      ? {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS || "",
        }
      : undefined,
  });

  const title = "Reset your 758streamin admin password";
  const greeting = name ? `Hi ${name},` : "Hi,";
  const text = `${greeting}\n\nUse the link below to reset your password:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`;
  const html = `
    <p>${greeting}</p>
    <p>Use the link below to reset your password:</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>If you did not request this, you can ignore this email.</p>
  `;

  await transporter.sendMail({
    from: env.SMTP_FROM,
    to,
    subject: title,
    text,
    html,
  });
}

module.exports = { sendResetEmail, isEmailConfigured };

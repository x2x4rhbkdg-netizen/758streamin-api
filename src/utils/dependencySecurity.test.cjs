const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');

function emailFixture(overrides = {}, sendError) {
  const env = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: 587, SMTP_SECURE: false,
    SMTP_USER: 'fixture-user', SMTP_PASS: 'fixture-password', SMTP_FROM: 'StreamIN <admin@example.test>', ...overrides };
  const module = { exports: {} };
  const captured = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'email.cjs'), 'utf8'), {
    module, require(name) {
      if (name === '../config/env.cjs') return { env };
      if (name !== 'nodemailer') throw new Error('Unexpected dependency');
      return { createTransport(options) {
        captured.options = options;
        const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
        return { async sendMail(message) {
          if (sendError) throw sendError;
          captured.message = message;
          captured.result = await transport.sendMail(message);
          return captured.result;
        } };
      } };
    },
  });
  return { api: module.exports, captured };
}

test('patched Nodemailer generates existing reset emails without contacting SMTP', async () => {
  const { api, captured } = emailFixture();
  await api.sendResetEmail({ to: 'recipient@example.test', name: 'Fixture', resetUrl: 'https://admin.example.test/reset?token=fixture' });
  assert.equal(captured.options.host, 'smtp.example.test');
  assert.equal(captured.options.port, 587);
  assert.equal(captured.options.secure, false);
  assert.equal(captured.options.auth.user, 'fixture-user');
  assert.equal(captured.options.auth.pass, 'fixture-password');
  assert.deepEqual(captured.result.envelope.to, ['recipient@example.test']);
  const generated = captured.result.message.toString();
  assert.match(generated, /Reset your 758streamin admin password/);
  assert.match(generated, /multipart\/alternative/);
  assert.match(captured.message.text, /https:\/\/admin.example.test\/reset\?token=fixture/);
  assert.match(captured.message.html, /Use the link below/);
});

test('SMTP TLS configuration and unauthenticated transport remain compatible', async () => {
  const { api, captured } = emailFixture({ SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: '' });
  await api.sendResetEmail({ to: 'recipient@example.test', resetUrl: 'https://admin.example.test/reset' });
  assert.equal(captured.options.secure, true);
  assert.equal(captured.options.port, 465);
  assert.equal(captured.options.auth, undefined);
});

test('missing mail configuration and SMTP errors still propagate to reset handlers', async () => {
  const missing = emailFixture({ SMTP_HOST: '' });
  await assert.rejects(missing.api.sendResetEmail({}), { code: 'EMAIL_NOT_CONFIGURED' });
  assert.equal(missing.captured.options, undefined);
  const failure = Object.assign(new Error('Fixture SMTP failure'), { code: 'EAUTH' });
  const failing = emailFixture({}, failure);
  await assert.rejects(failing.api.sendResetEmail({ to: 'recipient@example.test', resetUrl: 'https://admin.example.test/reset' }), { code: 'EAUTH' });
});

test('patched MySQL promise pool retains API without opening database connections', async () => {
  const pool = mysql.createPool({ host: '127.0.0.1', user: 'fixture', password: 'fixture', database: 'fixture',
    waitForConnections: true, connectionLimit: 10, queueLimit: 0 });
  assert.equal(typeof pool.execute, 'function');
  assert.equal(typeof pool.getConnection, 'function');
  assert.equal(pool.pool.config.connectionLimit, 10);
  assert.equal(pool.pool.config.queueLimit, 0);
  await pool.end();
});

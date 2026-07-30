const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const mail = require('../src/services/mail.service');
let sendMailCalls = [];
let sendMailImpl = async (opts) => { sendMailCalls.push(opts); };
mail.sendMail = (...args) => sendMailImpl(...args);

const contactRoutes = require('../src/routes/contact.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/contact', contactRoutes);
  return app;
}

function validBody(overrides = {}) {
  return {
    name: 'Akosua Asare',
    email: 'akosua@example.com',
    subject: 'Sales / a demo',
    message: 'Interested in WA-B for my shop.',
    ...overrides
  };
}

test.beforeEach(() => {
  sendMailCalls = [];
  sendMailImpl = async (opts) => { sendMailCalls.push(opts); };
});

test('POST /contact sends mail with the submitted fields and replies success', async () => {
  const res = await request(buildApp()).post('/api/contact').send(validBody());

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(sendMailCalls.length, 1);
  assert.equal(sendMailCalls[0].to, 'dev@skes.tech');
  assert.equal(sendMailCalls[0].replyTo, 'akosua@example.com');
  assert.match(sendMailCalls[0].subject, /Sales \/ a demo/);
  assert.match(sendMailCalls[0].text, /Interested in WA-B/);
});

test('POST /contact rejects a missing/invalid email', async () => {
  const res = await request(buildApp()).post('/api/contact').send(validBody({ email: 'not-an-email' }));
  assert.equal(res.status, 400);
  assert.equal(sendMailCalls.length, 0);
});

test('POST /contact rejects an empty message', async () => {
  const res = await request(buildApp()).post('/api/contact').send(validBody({ message: '   ' }));
  assert.equal(res.status, 400);
  assert.equal(sendMailCalls.length, 0);
});

test('POST /contact falls back an unrecognized subject to "Something else" rather than trusting client input', async () => {
  await request(buildApp()).post('/api/contact').send(validBody({ subject: 'ignore\r\nBcc: evil@example.com' }));
  assert.match(sendMailCalls[0].subject, /Something else/);
});

test('POST /contact strips CR/LF from name before using it in the subject header', async () => {
  await request(buildApp()).post('/api/contact').send(validBody({ name: 'Evil\r\nBcc: evil@example.com' }));
  assert.doesNotMatch(sendMailCalls[0].subject, /[\r\n]/);
});

test('POST /contact silently accepts (and drops) a honeypot-filled submission', async () => {
  const res = await request(buildApp()).post('/api/contact').send(validBody({ website: 'http://spam.example' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(sendMailCalls.length, 0);
});

test('POST /contact returns 503 when SMTP is not configured', async () => {
  sendMailImpl = async () => {
    const err = new Error('Email is not configured on this server');
    err.code = 'mail_not_configured';
    throw err;
  };
  const res = await request(buildApp()).post('/api/contact').send(validBody());
  assert.equal(res.status, 503);
  assert.equal(res.body.success, false);
});

test('POST /contact returns 502 on an unexpected send failure', async () => {
  sendMailImpl = async () => { throw new Error('SMTP connection refused'); };
  const res = await request(buildApp()).post('/api/contact').send(validBody());
  assert.equal(res.status, 502);
  assert.equal(res.body.success, false);
});

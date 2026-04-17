#!/usr/bin/env node

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';
import nodemailer from 'nodemailer';

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

function parseJSON(raw) {
  return JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
}

function clearProxyEnv() {
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    delete process.env[key];
  }
}

function htmlToText(html) {
  if (!html) return '';
  const stripped = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|aside|main|h1|h2|h3|h4|h5|h6|ul|ol|li|blockquote|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return stripped.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function resolveDeliveryConfig(config) {
  const fileDelivery = config.delivery || {};
  return {
    method: process.env.DELIVERY_METHOD || fileDelivery.method || 'stdout',
    email: process.env.DELIVERY_EMAIL || fileDelivery.email
  };
}

async function getDeliveryPayload(args) {
  const payload = {
    subject: args.subject || 'AI Builders Digest',
    text: null,
    html: null
  };

  if (args.message) payload.text = args.message;
  else if (args.file) payload.text = await readFile(args.file, 'utf-8');

  if (args['html-message']) payload.html = args['html-message'];
  else if (args['html-file']) payload.html = await readFile(args['html-file'], 'utf-8');

  if (args['text-message']) payload.text = args['text-message'];
  else if (args['text-file']) payload.text = await readFile(args['text-file'], 'utf-8');

  if (!payload.text && !payload.html) {
    payload.text = await readStdin();
  }
  if (payload.html && !payload.text) payload.text = htmlToText(payload.html);
  return payload;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function getSmtpConfig() {
  const config = {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    login: process.env.SMTP_LOGIN || process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    fromEmail: process.env.SMTP_FROM_EMAIL,
    fromName: process.env.SMTP_FROM_NAME || 'AI Builders Digest',
    secure: parseBoolean(process.env.SMTP_SECURE, false),
    requireTLS: parseBoolean(process.env.SMTP_REQUIRE_TLS, true)
  };

  const missing = [];
  if (!config.host) missing.push('SMTP_HOST');
  if (!config.port) missing.push('SMTP_PORT');
  if (!config.login) missing.push('SMTP_LOGIN');
  if (!config.password) missing.push('SMTP_PASSWORD');
  if (!config.fromEmail) missing.push('SMTP_FROM_EMAIL');
  if (missing.length > 0) {
    throw new Error(`Missing SMTP config in .env: ${missing.join(', ')}`);
  }

  const numericPort = Number(config.port);
  if (!Number.isInteger(numericPort) || numericPort <= 0) {
    throw new Error('SMTP_PORT must be a positive integer');
  }

  return { ...config, port: numericPort };
}

async function sendEmail(payload, smtpConfig, toEmail) {
  clearProxyEnv();
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    requireTLS: smtpConfig.requireTLS,
    auth: {
      user: smtpConfig.login,
      pass: smtpConfig.password
    }
  });

  await transporter.verify();
  await transporter.sendMail({
    from: `"${smtpConfig.fromName}" <${smtpConfig.fromEmail}>`,
    to: toEmail,
    subject: payload.subject,
    text: payload.text || '',
    ...(payload.html ? { html: payload.html } : {})
  });
}

async function main() {
  loadEnv({ path: ENV_PATH });

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = parseJSON(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const delivery = resolveDeliveryConfig(config);
  const args = parseArgs(process.argv.slice(2));
  const payload = await getDeliveryPayload(args);

  if ((!payload.text || !payload.text.trim()) && (!payload.html || !payload.html.trim())) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest payload' }));
    return;
  }

  if (delivery.method === 'stdout') {
    console.log(payload.text || payload.html || '');
    return;
  }

  if (delivery.method !== 'email') {
    console.log(JSON.stringify({ status: 'error', method: delivery.method, message: `Unsupported delivery method: ${delivery.method}` }));
    process.exit(1);
  }

  try {
    if (!delivery.email) throw new Error('delivery.email not found in config.json');
    const smtpConfig = getSmtpConfig();
    await sendEmail(payload, smtpConfig, delivery.email);
    console.log(JSON.stringify({
      status: 'ok',
      method: 'email',
      message: `Digest sent to ${delivery.email}`,
      hasHtml: Boolean(payload.html)
    }));
  } catch (error) {
    console.log(JSON.stringify({ status: 'error', method: 'email', message: error.message }));
    process.exit(1);
  }
}

main();

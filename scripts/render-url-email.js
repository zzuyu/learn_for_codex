#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, 'output');

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

async function readInputJSON(args) {
  if (args.input) {
    return JSON.parse(String(await readFile(resolve(args.input), 'utf-8')).replace(/^\uFEFF/, ''));
  }
  const raw = await readStdin();
  if (!raw.trim()) {
    throw new Error('No input provided. Pass --input <file> or pipe publish-site.js into render-url-email.js.');
  }
  return JSON.parse(String(raw).replace(/^\uFEFF/, ''));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSubject(payload) {
  return `${payload.title || 'AI Builders 简报'} 已发布`;
}

function buildText(payload) {
  return [
    payload.title,
    payload.heroDate,
    payload.summary,
    '',
    `最新页: ${payload.latestUrl}`,
    `本期归档: ${payload.archiveUrl}`,
    '',
    '这是一封链接通知邮件，完整内容请直接打开公开页面查看。'
  ].filter(Boolean).join('\n');
}

function buildHtml(payload) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(buildSubject(payload))}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3ede6;font-family:'PingFang SC','Microsoft YaHei',sans-serif;color:#1d1b18;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f3ede6;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;max-width:720px;background:#fffdf9;border:1px solid #eaded5;border-radius:24px;overflow:hidden;">
            <tr>
              <td style="padding:34px 36px 30px;">
                <div style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#9b8577;margin-bottom:14px;">FOLLOW BUILDERS DIGEST</div>
                <div style="font-size:28px;line-height:1.2;font-weight:700;color:#1d1b18;margin-bottom:10px;">${escapeHtml(payload.title)}</div>
                <div style="font-size:15px;line-height:1.6;color:#7b685c;margin-bottom:20px;">${escapeHtml(payload.heroDate)}</div>
                <div style="font-size:16px;line-height:1.9;color:#2a2521;margin-bottom:22px;">${escapeHtml(payload.summary)}</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:20px;">
                  <tr>
                    <td style="padding:0 0 14px;">
                      <div style="font-size:12px;color:#9b8577;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">Latest</div>
                      <div style="font-size:16px;line-height:1.7;"><a href="${escapeHtml(payload.latestUrl)}" style="color:#9f4b2a;text-decoration:none;">${escapeHtml(payload.latestUrl)}</a></div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:14px 0 0;border-top:1px solid #eaded5;">
                      <div style="font-size:12px;color:#9b8577;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">Archive</div>
                      <div style="font-size:16px;line-height:1.7;"><a href="${escapeHtml(payload.archiveUrl)}" style="color:#9f4b2a;text-decoration:none;">${escapeHtml(payload.archiveUrl)}</a></div>
                    </td>
                  </tr>
                </table>
                <div style="font-size:13px;line-height:1.8;color:#8b7a6f;">这是一封链接通知邮件，完整内容请直接打开公开页面查看。</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publishResult = await readInputJSON(args);
  if (publishResult.status !== 'ok') {
    throw new Error(`publish-site.js result is not ok: ${publishResult.status || 'unknown'}`);
  }
  if (!publishResult.latestUrl || !publishResult.archiveUrl) {
    throw new Error('Missing latestUrl or archiveUrl in publish result');
  }

  const outputDir = args.outputDir ? resolve(args.outputDir) : DEFAULT_OUTPUT_DIR;
  const stamp = publishResult.date || new Date().toISOString().slice(0, 10);
  const payload = {
    title: publishResult.title || 'AI Builders 简报',
    heroDate: stamp.replace(/-/g, '年').replace(/年(\d{2})$/, '年$1日'),
    summary: publishResult.summary || '本期公开页面已更新。',
    latestUrl: publishResult.latestUrl,
    archiveUrl: publishResult.archiveUrl
  };

  const html = buildHtml(payload);
  const text = buildText(payload);
  const htmlOutput = join(outputDir, `follow-builders-url-email-${stamp}.html`);
  const textOutput = join(outputDir, `follow-builders-url-email-${stamp}.txt`);

  await mkdir(outputDir, { recursive: true });
  await writeFile(htmlOutput, html, 'utf-8');
  await writeFile(textOutput, `${text}\n`, 'utf-8');

  console.log(JSON.stringify({
    status: 'ok',
    subject: buildSubject(payload),
    htmlOutput,
    textOutput
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', message: error.message }, null, 2));
  process.exit(1);
});

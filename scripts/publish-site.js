#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  ensureArray,
  formatChineseDate,
  prioritizeBuilders,
  prioritizeTweetCards,
  buildTweetCard,
  buildBlogCard,
  buildPodcastCard,
  buildDigestSummary
} from './render-html.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DEFAULT_DOCS_ROOT = join(REPO_ROOT, 'docs');
const DEFAULT_MANIFEST_LIMIT = 90;

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
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readInputJSON(args) {
  if (args.input) {
    return JSON.parse(String(await readFile(resolve(args.input), 'utf-8')).replace(/^\uFEFF/, ''));
  }

  const raw = await readStdin();
  if (!raw.trim()) {
    throw new Error('No input provided. Pass --input <file> or pipe prepare-digest.js into publish-site.js.');
  }

  return JSON.parse(String(raw).replace(/^\uFEFF/, ''));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateStamp(dateLike) {
  const date = new Date(dateLike || Date.now());
  if (Number.isNaN(date.getTime())) {
    const fallback = new Date();
    return `${fallback.getUTCFullYear()}-${pad2(fallback.getUTCMonth() + 1)}-${pad2(fallback.getUTCDate())}`;
  }

  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function normalizeBaseUrl(value) {
  if (!value) return '';
  return String(value).replace(/\/+$/, '') + '/';
}

function buildPublicUrls(baseUrl, stamp) {
  if (!baseUrl) {
    return {
      latestUrl: '',
      archiveUrl: ''
    };
  }

  const needsExplicitIndex = /cdn\.jsdelivr\.net\/gh\//i.test(baseUrl);

  if (needsExplicitIndex) {
    return {
      latestUrl: `${baseUrl}index.html`,
      archiveUrl: `${baseUrl}archive/${stamp}/index.html`
    };
  }

  return {
    latestUrl: baseUrl,
    archiveUrl: `${baseUrl}archive/${stamp}/`
  };
}

function buildTitle(digest) {
  const sourceDate = digest?.stats?.feedGeneratedAt || digest?.generatedAt || Date.now();
  const timezone = digest?.config?.timezone || 'UTC';
  return `AI Builders 简报 - ${formatChineseDate(sourceDate, timezone)}`;
}

function hasNoContent(digest) {
  const stats = digest?.stats || {};
  return (stats.xBuilders || 0) === 0
    && (stats.blogPosts || 0) === 0
    && (stats.podcastEpisodes || 0) === 0;
}

function truncate(value, length = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function buildCards(digest) {
  return {
    tweets: prioritizeTweetCards(
      prioritizeBuilders(ensureArray(digest.x)).map(buildTweetCard).filter(Boolean)
    ),
    blogs: ensureArray(digest.blogs).map(buildBlogCard).filter(Boolean),
    podcasts: ensureArray(digest.podcasts).map(buildPodcastCard).filter(Boolean)
  };
}

function buildIssueSummary(digest, cards) {
  const primaryCard = cards.tweets[0] || cards.blogs[0] || cards.podcasts[0];
  const primarySummary = primaryCard ? buildDigestSummary(primaryCard).summary : '';
  const summaryLead = primarySummary ? truncate(primarySummary, 118) : '';

  const extraParts = [];
  if (cards.tweets.length > 0) extraParts.push(`${cards.tweets.length} 条 builder 动态`);
  if (cards.blogs.length > 0) extraParts.push(`${cards.blogs.length} 篇官方博客`);
  if (cards.podcasts.length > 0) extraParts.push(`${cards.podcasts.length} 期播客`);

  const countsLine = extraParts.length > 0
    ? `本期还整理了 ${extraParts.join('、')}。`
    : '';

  if (summaryLead && countsLine) {
    return `${summaryLead} ${countsLine}`;
  }

  if (summaryLead) return summaryLead;

  return countsLine || '本期公开页面已更新。';
}

async function runNodeScript(scriptName, args = [], input = '') {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(SCRIPT_DIR, scriptName), ...args], {
      cwd: SCRIPT_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', rejectPromise);

    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(
          `${scriptName} exited with code ${code}: ${[stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || 'Unknown error'}`
        ));
        return;
      }

      resolvePromise({
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });

    child.stdin.end(input);
  });
}

async function loadExistingManifest(path) {
  if (!existsSync(path)) {
    return { archive: [] };
  }

  try {
    return JSON.parse(String(await readFile(path, 'utf-8')).replace(/^\uFEFF/, ''));
  } catch {
    return { archive: [] };
  }
}

function buildArchiveEntry({ date, title, summary, url }) {
  return {
    date,
    title,
    summary,
    url
  };
}

function upsertArchiveEntries(existingEntries, nextEntry) {
  const merged = [
    nextEntry,
    ...ensureArray(existingEntries).filter((entry) => entry?.date !== nextEntry.date)
  ];

  merged.sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));
  return merged.slice(0, DEFAULT_MANIFEST_LIMIT);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const digest = await readInputJSON(args);

  if (hasNoContent(digest)) {
    console.log(JSON.stringify({
      status: 'skipped',
      reason: 'No new content',
      stats: digest.stats || {}
    }, null, 2));
    return;
  }

  const docsRoot = args['docs-root']
    ? resolve(args['docs-root'])
    : DEFAULT_DOCS_ROOT;
  const baseUrl = normalizeBaseUrl(args['base-url'] || process.env.PUBLIC_BASE_URL);
  const digestDate = digest?.stats?.feedGeneratedAt || digest?.generatedAt || Date.now();
  const stamp = dateStamp(digestDate);
  const title = buildTitle(digest);
  const cards = buildCards(digest);
  const summary = buildIssueSummary(digest, cards);

  const archiveDir = join(docsRoot, 'archive', stamp);
  const archivePath = join(archiveDir, 'index.html');
  const latestPath = join(docsRoot, 'index.html');
  const manifestPath = join(docsRoot, 'manifest.json');
  const noJekyllPath = join(docsRoot, '.nojekyll');

  await mkdir(archiveDir, { recursive: true });
  await mkdir(docsRoot, { recursive: true });

  await runNodeScript(
    'render-html.js',
    ['--output', archivePath],
    `${JSON.stringify(digest, null, 2)}\n`
  );

  await copyFile(archivePath, latestPath);
  await writeFile(noJekyllPath, '', 'utf-8');

  const { latestUrl, archiveUrl } = buildPublicUrls(baseUrl, stamp);

  const existingManifest = await loadExistingManifest(manifestPath);
  const archiveEntry = buildArchiveEntry({
    date: stamp,
    title,
    summary,
    url: archiveUrl
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    latest: {
      date: stamp,
      title,
      summary,
      url: latestUrl,
      archiveUrl
    },
    archive: upsertArchiveEntries(existingManifest.archive, archiveEntry)
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  console.log(JSON.stringify({
    status: 'ok',
    date: stamp,
    title,
    summary,
    latestPath,
    archivePath,
    manifestPath,
    latestUrl,
    archiveUrl,
    cards: {
      tweets: cards.tweets.length,
      blogs: cards.blogs.length,
      podcasts: cards.podcasts.length
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'error',
    message: error.message
  }, null, 2));
  process.exit(1);
});

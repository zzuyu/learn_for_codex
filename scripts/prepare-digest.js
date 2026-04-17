#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const DEFAULT_REMOTE_REPO = 'zarazhangrui/follow-builders';
const REMOTE_REPO = process.env.FOLLOW_BUILDERS_REMOTE_REPO || DEFAULT_REMOTE_REPO;
const RAW_BASE = (process.env.FOLLOW_BUILDERS_RAW_BASE || `https://raw.githubusercontent.com/${REMOTE_REPO}/main`)
  .replace(/\/+$/, '');

const FEED_X_URL = `${RAW_BASE}/feed-x.json`;
const FEED_PODCASTS_URL = `${RAW_BASE}/feed-podcasts.json`;
const FEED_BLOGS_URL = `${RAW_BASE}/feed-blogs.json`;

const PROMPTS_BASE = `${RAW_BASE}/prompts`;
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

function parseJSON(raw) {
  return JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
}

async function readJSONFile(path) {
  try {
    return parseJSON(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function loadFeed({ remoteUrl, localPath, remoteError, localError }) {
  const remote = await fetchJSON(remoteUrl);
  if (remote) {
    return { data: remote, source: 'remote' };
  }

  const local = await readJSONFile(localPath);
  if (local) {
    return {
      data: local,
      source: 'local',
      warning: `${remoteError}; used local snapshot at ${localPath}`
    };
  }

  return {
    data: null,
    source: 'missing',
    warning: `${remoteError}; ${localError}`
  };
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];
  const warnings = [];
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, '..');
  const localFeedPaths = {
    x: join(repoRoot, 'feed-x.json'),
    podcasts: join(repoRoot, 'feed-podcasts.json'),
    blogs: join(repoRoot, 'feed-blogs.json')
  };
  const trackedSourcesPath = join(repoRoot, 'config', 'default-sources.json');

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = parseJSON(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch all three feeds
  const [feedXResult, feedPodcastsResult, feedBlogsResult] = await Promise.all([
    loadFeed({
      remoteUrl: FEED_X_URL,
      localPath: localFeedPaths.x,
      remoteError: 'Could not fetch tweet feed from GitHub',
      localError: 'Could not read local tweet snapshot'
    }),
    loadFeed({
      remoteUrl: FEED_PODCASTS_URL,
      localPath: localFeedPaths.podcasts,
      remoteError: 'Could not fetch podcast feed from GitHub',
      localError: 'Could not read local podcast snapshot'
    }),
    loadFeed({
      remoteUrl: FEED_BLOGS_URL,
      localPath: localFeedPaths.blogs,
      remoteError: 'Could not fetch blog feed from GitHub',
      localError: 'Could not read local blog snapshot'
    })
  ]);

  const feedX = feedXResult.data;
  const feedPodcasts = feedPodcastsResult.data;
  const feedBlogs = feedBlogsResult.data;
  const trackedSourcesRaw = await readJSONFile(trackedSourcesPath);

  if (!feedX) errors.push('Could not load tweet feed');
  if (!feedPodcasts) errors.push('Could not load podcast feed');
  if (!feedBlogs) errors.push('Could not load blog feed');
  if (!trackedSourcesRaw) errors.push('Could not load tracked sources config');

  for (const result of [feedXResult, feedPodcastsResult, feedBlogsResult]) {
    if (result.warning) warnings.push(result.warning);
  }

  // 3. Load prompts with priority: user custom > remote (GitHub) > local default
  //
  // If the user has a custom prompt at ~/.follow-builders/prompts/<file>,
  // use that (they personalized it — don't overwrite with remote updates).
  // Otherwise, fetch the latest from GitHub so they get central improvements.
  // If GitHub is unreachable, fall back to the local copy shipped with the skill.
  const prompts = {};
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    // Priority 1: user's custom prompt (they personalized it)
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    // Priority 2: latest from GitHub (central updates)
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    // Priority 3: local copy shipped with the skill
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Build the output — everything the LLM needs in one blob
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    // User preferences
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix
    podcasts: feedPodcasts?.podcasts || [],
    x: feedX?.x || [],
    blogs: feedBlogs?.blogs || [],
    trackedSources: {
      xAccounts: trackedSourcesRaw?.x_accounts || [],
      blogs: trackedSourcesRaw?.blogs || [],
      podcasts: trackedSourcesRaw?.podcasts || []
    },

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },

    // Prompts — the LLM reads these and follows the instructions
    prompts,

    // Non-fatal errors
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});

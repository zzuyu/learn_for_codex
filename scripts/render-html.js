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
    throw new Error('No input provided. Pass --input <file> or pipe prepare-digest.js into render-html.js.');
  }
  return JSON.parse(String(raw).replace(/^\uFEFF/, ''));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, length = 180) {
  const clean = normalizeWhitespace(value);
  if (clean.length <= length) return clean;
  return `${clean.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function dateStamp(dateLike) {
  const date = new Date(dateLike || Date.now());
  if (Number.isNaN(date.getTime())) {
    const fallback = new Date();
    return `${fallback.getUTCFullYear()}-${String(fallback.getUTCMonth() + 1).padStart(2, '0')}-${String(fallback.getUTCDate()).padStart(2, '0')}`;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatChineseDate(dateLike, timezone = 'Asia/Shanghai') {
  const date = new Date(dateLike || Date.now());
  if (Number.isNaN(date.getTime())) return '未标注日期';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
}

function normalizeSourceKey(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function slugify(value) {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'item';
}

function smartTitle(token) {
  if (!token) return '';
  return token
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

const COMPANY_DISPLAY_MAP = {
  google: 'Google',
  googlelabs: 'Google Labs',
  anthropicai: 'Anthropic',
  claudeai: 'Claude',
  openai: 'OpenAI',
  box: 'Box',
  replit: 'Replit',
  roblox: 'Roblox',
  every: 'Every'
};

function extractPrimaryBioSegment(bio) {
  const firstLine = ensureArray(String(bio || '').split('\n'))
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine.split(/,\s*prev[:]?/i)[0].trim();
}

function formatCompanyFromHandle(handle) {
  return COMPANY_DISPLAY_MAP[handle.toLowerCase()] || smartTitle(handle);
}

function extractPrimaryCompany(segment) {
  if (!segment) return '';
  const handles = Array.from(segment.matchAll(/@([A-Za-z0-9_]+)/g)).map((match) => match[1]);
  const preferred = ['openai', 'anthropicai', 'claudeai', 'googlelabs', 'google', 'box', 'replit', 'roblox', 'every'];
  for (const key of preferred) {
    if (handles.some((handle) => handle.toLowerCase() === key)) {
      return formatCompanyFromHandle(key);
    }
  }
  if (handles.length > 0) return formatCompanyFromHandle(handles[0]);
  const atMatch = segment.match(/\bat\s+([A-Z][A-Za-z0-9.&-]+)/);
  return atMatch ? atMatch[1] : '';
}

function extractRoleLabel(segment) {
  if (!segment) return '';
  if (/head of product/i.test(segment)) return 'Head of Product';
  if (/\bceo\b/i.test(segment)) return 'CEO';
  if (/\bvp\b/i.test(segment)) return 'VP';
  if (/product at/i.test(segment)) return 'Product';
  if (/founder/i.test(segment)) return 'Founder';
  return '';
}

function formatDigestAuthorTitle(name, bio) {
  const segment = extractPrimaryBioSegment(bio);
  const company = extractPrimaryCompany(segment);
  const role = extractRoleLabel(segment);
  if (company && role === 'Product') return `${company} ${name}`;
  if (company && role) return `${company} ${role} ${name}`;
  if (company) return `${company} ${name}`;
  if (role) return `${role} ${name}`;
  return name;
}

const PRIORITY_RULES = [
  { score: 120, patterns: [/\bopenai\b/i, /@sama/i, /sam altman/i] },
  { score: 110, patterns: [/\banthropic\b/i, /claude/i, /_catwu/i, /alexalbert__/i] },
  { score: 100, patterns: [/\bgoogle\b/i, /gemini/i, /joshwoodward/i, /googlelabs/i] }
];

function scorePriority(card) {
  const text = normalizeWhitespace([
    card.sourceName,
    card.sourceHandle,
    card.sourceValue,
    card.summary,
    card.title,
    card.subtitle
  ].join(' '));
  let score = 0;
  for (const rule of PRIORITY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) score = Math.max(score, rule.score);
  }
  return score;
}

function prioritizeBuilders(builders) {
  return [...ensureArray(builders)].sort((left, right) => {
    const leftText = [left.name, left.handle, left.bio].filter(Boolean).join(' ');
    const rightText = [right.name, right.handle, right.bio].filter(Boolean).join(' ');
    const leftScore = scorePriority({ sourceName: leftText });
    const rightScore = scorePriority({ sourceName: rightText });
    if (leftScore !== rightScore) return rightScore - leftScore;
    return 0;
  });
}

function prioritizeTweetCards(cards) {
  return [...ensureArray(cards)].sort((left, right) => {
    const leftScore = scorePriority(left);
    const rightScore = scorePriority(right);
    if (leftScore !== rightScore) return rightScore - leftScore;
    return 0;
  });
}

function cleanTweetText(value, maxLength = 240) {
  return truncate(String(value || '').replace(/https?:\/\/\S+/gi, '').replace(/\bt\.co\/\S+/gi, ''), maxLength);
}

function buildDigestBody(parts) {
  const seen = new Set();
  return ensureArray(parts)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ');
}

function deriveTags(textParts, kind) {
  const haystack = normalizeWhitespace(textParts.join(' ')).toLowerCase();
  const tags = [];
  const push = (value) => {
    if (value && !tags.includes(value)) tags.push(value);
  };

  if (/exam|education|student|neet|练习测试|教育/.test(haystack)) push('教育场景');
  if (/gemini|app|assistant|copilot|feature|product|应用/.test(haystack)) push('模型应用');
  if (/agent|agents|session|sessions|parallel|routine|workflow|automation|工作流|智能体/.test(haystack)) push('智能体编排');
  if (/workflow|automation|trigger|schedule|github event|api|工作流|自动化/.test(haystack)) push('工作流自动化');
  if (/chrome|extension|browser|tabs|浏览器|扩展/.test(haystack)) push('浏览器扩展');
  if (/local-first|filesystem|history|database|本地|数据库|文件系统/.test(haystack)) push('本地工具');
  if (/payment|pay|razorpay|pricing|支付/.test(haystack)) push('支付闭环');
  if (/search|seo|ranking|marketing|brand|搜索|分发/.test(haystack)) push('搜索分发');
  if (/open source|repo|github|oss|开源/.test(haystack)) push('开源发布');
  if (/enterprise|organization|team|permission|企业/.test(haystack)) push('企业落地');
  if (/desktop|code|developer|tool|skill|terminal|diff|开发/.test(haystack)) push('开发工具');

  const fallback = {
    tweet: ['模型应用', '开发工具'],
    blog: ['开发工具', '工作流自动化'],
    podcast: ['模型应用', '搜索分发']
  };

  ensureArray(fallback[kind]).forEach((tag) => push(tag));
  return tags.slice(0, 2);
}

function summarizeTweet(builder, tweets) {
  const text = tweets.map((tweet) => cleanTweetText(tweet.text, 220)).filter(Boolean);
  const joined = text.join(' ').toLowerCase();
  const title = formatDigestAuthorTitle(builder.name, builder.bio);

  if (builder.name === 'Josh Woodward' || /neet|practice tests/.test(joined)) {
    return buildDigestBody([
      'Gemini 开始上线面向印度 NEET 医学考试的练习测试，这说明 Google 正在把 Gemini 往更具体的教育工作流推进，而不只是“通用聊天机器人”。',
      '更值得注意的是，他公开征集下一个国家和学科，像是在验证一套可复制的本地化学习产品模板。'
    ]);
  }

  if (builder.name === 'Cat Wu' || /routines|gh events|session/.test(joined)) {
    return buildDigestBody([
      'Cat Wu 这几条更新放在一起看，方向很清楚：Claude Code 正在从“终端里的编码助手”往“可调度、可编排的工作台”走。',
      '她一边强调桌面版更适合同时管理本地和云端的多个 session，一边强调 Routines 可以从定时任务、GitHub 事件和其他 API 触发。'
    ]);
  }

  if (builder.name === 'Aaron Levie' || /forward deployed|organization/.test(joined)) {
    return buildDigestBody([
      'Aaron Levie 的判断是，企业里真正把 AI agent 跑起来并规模化，会催生一类更重要的“前置工程师”角色。',
      '意思很直接：agent 不是装上就能用，真正有价值的是那些能把模型、工具、权限和业务流程接起来的人。'
    ]);
  }

  if (builder.name === 'Dan Shipper' || /sparkle|file system|filesystem/.test(joined)) {
    return buildDigestBody([
      'Dan Shipper 发布了 Sparkle v4，一个帮你整理桌面和文件系统的 agent。',
      '它代表的不是“再来一个聊天框”，而是更窄、更具体、回报更直接的 agent 形态：盯住一个持续存在的麻烦问题，然后自动处理。'
    ]);
  }

  if (builder.name === 'Amjad Masad' || /razorpay|skill/.test(joined)) {
    return buildDigestBody([
      'Amjad Masad 这波更新有两个信号：一是很多过去需要单独做成小工具的能力，现在会直接收敛成“skill”；二是 Replit 在印度把 Razorpay 这种本地支付能力接进来，明显是在补“能做”之外的“能卖、能收钱”。'
    ]);
  }

  if (builder.name === 'Zara Zhang' || /chrome|extension|tabs|browser history/.test(joined)) {
    return buildDigestBody([
      'Zara Zhang 把 Tab Out 继续简化成一个纯 Chrome 扩展：没有服务器，没有 Node.js，没有 npm，标签页也全部本地存储。',
      '她后面解释思路时点出了更有意思的地方：浏览器历史和本地数据库，本身就是 LLM-native 工具很好的原材料。'
    ]);
  }

  if (builder.name === 'Peter Yang' || /mobile app|remote-control|bypass perms|permission/.test(joined)) {
    return buildDigestBody([
      'Peter Yang 这组动态里有两个很真实的信号：一是 Claude Code 桌面端已经开始进入日常工作流，二是跨桌面/移动协作和权限体验还远没打磨完。',
      '这种公开反馈很有价值，因为它直接暴露了产品从“能用”走向“高频可用”时最容易卡住的那层体验摩擦。'
    ]);
  }

  if (builder.name === 'Claude' || /multiple claude sessions|sidebar|desktop/.test(joined)) {
    return buildDigestBody([
      'Claude 官方这几条动态，核心都在强调同一件事：Claude Code 桌面端已经不再只是终端替代品，而是在往并行 session 的工作台演化。',
      '从多 session 管理，到桌面端组织方式，再到更顺手的并行查看，重点都落在“怎么把 agent 真正放进持续工作流里”。'
    ]);
  }

  const first = text[0] || '';
  const second = text[1] || '';
  return buildDigestBody([
    `${title} 这组公开动态最值得看的地方，是它把最近在推进的方向讲得更具体了。`,
    first ? `先抛出的信号是：${first}` : '',
    second ? `随后又补了一条更具体的上下文：${second}` : ''
  ]);
}

function buildTweetCard(builder) {
  const tweets = ensureArray(builder.tweets).slice(0, 2);
  if (tweets.length === 0) return null;
  const sourceValue = formatDigestAuthorTitle(builder.name, builder.bio);
  const summary = summarizeTweet(builder, tweets);
  const tags = deriveTags([builder.name, builder.bio, ...tweets.map((tweet) => tweet.text), summary], 'tweet');
  return {
    kind: 'tweet',
    section: 'X / 推文',
    sourceLabel: 'Author',
    sourceValue,
    sourceName: builder.name,
    sourceHandle: builder.handle || '',
    subtitle: tweets.length > 1 ? `${tweets.length} 条原帖` : '@' + (builder.handle || ''),
    summary,
    tags,
    links: tweets.map((tweet, index) => ({
      label: index === 0 ? '原帖' : '补充帖',
      url: tweet.url
    })),
    anchorId: `tweet-${slugify(builder.handle || builder.name)}`,
    posterLabel: 'X / 推文',
    posterTitle: builder.name,
    posterPreview: truncate(summary, 68)
  };
}

function buildBlogCard(blog) {
  const content = normalizeWhitespace(blog.content);
  if (!content) return null;
  let summary = '';
  if (/claude code/i.test(blog.title) && /parallel agents/i.test(blog.title)) {
    summary = buildDigestBody([
      '这篇文章的核心不是“桌面版更好看了”，而是 Claude Code 的产品重心已经明确转向并行 agent 工作流。',
      '新版本加了 session 侧边栏、拖拽式工作区、内置终端、应用内文件编辑、更快的 diff viewer 以及 HTML/PDF 预览，整体都在为“很多任务同时在飞”这种真实使用场景服务。'
    ]);
  } else {
    summary = truncate(content, 360);
  }
  const tags = deriveTags([blog.name, blog.title, content, summary], 'blog');
  return {
    kind: 'blog',
    section: '官方博客',
    sourceLabel: 'Source',
    sourceValue: blog.name,
    sourceName: blog.name,
    subtitle: blog.title,
    summary,
    tags,
    links: [{ label: '原文', url: blog.url }],
    anchorId: `blog-${slugify(blog.name)}`,
    posterLabel: '官方博客',
    posterTitle: blog.name,
    posterPreview: truncate(summary, 68)
  };
}

function cleanTranscript(transcript) {
  return String(transcript || '')
    .split('\n')
    .map((line) => line.replace(/^Speaker\s+\d+\s+\|\s+\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s*/i, '').trim())
    .filter(Boolean)
    .join(' ');
}

function buildPodcastCard(podcast) {
  const transcript = cleanTranscript(podcast.transcript);
  if (!transcript) return null;
  let summary = '';
  if (/agent-led growth/i.test(podcast.title) || /profound/i.test(podcast.title)) {
    summary = buildDigestBody([
      '这期播客的核心判断是，AI 不只是新的搜索入口，它正在变成替用户上网、替用户做初步判断的那个“行动者”。',
      'James Cadwallader 反复强调，营销团队不能再只把问题理解成 SEO 排名，而要开始思考如何让 agent 更容易理解、引用和比较你的产品。',
      '这期最值得听的地方，是它把“agent-led growth”从一个概念词，讲成了一套更具体的营销工作法。'
    ]);
  } else {
    summary = truncate(transcript, 420);
  }
  const tags = deriveTags([podcast.name, podcast.title, transcript, summary], 'podcast');
  return {
    kind: 'podcast',
    section: '播客精选',
    sourceLabel: 'Source',
    sourceValue: podcast.name,
    sourceName: podcast.name,
    subtitle: podcast.title,
    summary,
    tags,
    links: [{ label: '节目页', url: podcast.url }],
    anchorId: `podcast-${slugify(podcast.name)}`,
    posterLabel: '播客精选',
    posterTitle: podcast.name,
    posterPreview: truncate(summary, 68)
  };
}

function buildDigestSummary(card) {
  return {
    summary: truncate(card?.summary || '', 120)
  };
}

function getSectionConfigs(cardsBySection) {
  return [
    {
      id: 'builder-signals',
      kicker: 'X / 推文',
      title: '技术大佬们的“朋友圈”，今天又更新了',
      intro: '把零散动态整理成可快速扫读的中文卡片，先看“谁发的”，再看这条动态到底传达了什么。',
      cards: cardsBySection['X / 推文'] || []
    },
    {
      id: 'official-blogs',
      kicker: '官方博客',
      title: '官方长文，往往最先暴露团队真正重视的产品约束',
      intro: '适合看产品团队如何正式讲述自己的新能力，以及他们真正想让你记住什么。',
      cards: cardsBySection['官方博客'] || []
    },
    {
      id: 'podcast-picks',
      kicker: '播客精选',
      title: '长谈里的判断，比热闹更重要',
      intro: '更适合拿来抓长线判断和行业语气，看 builder 在长时间对谈里到底怎么解释世界。',
      cards: cardsBySection['播客精选'] || []
    }
  ];
}

function buildPanoramaModel(trackedSources, cards) {
  const tracked = {
    x: ensureArray(trackedSources?.xAccounts),
    blogs: ensureArray(trackedSources?.blogs),
    podcasts: ensureArray(trackedSources?.podcasts)
  };

  const active = {
    x: new Set(cards.filter((card) => card.kind === 'tweet').map((card) => normalizeSourceKey(card.sourceHandle || card.sourceName))),
    blogs: new Set(cards.filter((card) => card.kind === 'blog').map((card) => normalizeSourceKey(card.sourceName))),
    podcasts: new Set(cards.filter((card) => card.kind === 'podcast').map((card) => normalizeSourceKey(card.sourceName)))
  };

  const groups = [
    {
      title: 'X / 推文',
      total: tracked.x.length,
      activeCount: tracked.x.filter((item) => active.x.has(normalizeSourceKey(item.handle || item.name))).length,
      items: tracked.x.map((item) => ({
        label: item.name,
        detail: item.handle ? `@${item.handle}` : '',
        active: active.x.has(normalizeSourceKey(item.handle || item.name)),
        href: active.x.has(normalizeSourceKey(item.handle || item.name)) ? `#tweet-${slugify(item.handle || item.name)}` : ''
      }))
    },
    {
      title: '官方博客',
      total: tracked.blogs.length,
      activeCount: tracked.blogs.filter((item) => active.blogs.has(normalizeSourceKey(item.name))).length,
      items: tracked.blogs.map((item) => ({
        label: item.name,
        detail: '',
        active: active.blogs.has(normalizeSourceKey(item.name)),
        href: active.blogs.has(normalizeSourceKey(item.name)) ? `#blog-${slugify(item.name)}` : ''
      }))
    },
    {
      title: '播客精选',
      total: tracked.podcasts.length,
      activeCount: tracked.podcasts.filter((item) => active.podcasts.has(normalizeSourceKey(item.name))).length,
      items: tracked.podcasts.map((item) => ({
        label: item.name,
        detail: '',
        active: active.podcasts.has(normalizeSourceKey(item.name)),
        href: active.podcasts.has(normalizeSourceKey(item.name)) ? `#podcast-${slugify(item.name)}` : ''
      }))
    }
  ];

  return {
    hasContent: groups.some((group) => group.total > 0),
    groups
  };
}

function renderPanorama(model) {
  if (!model?.hasContent) return '';
  return `<details class="panorama"><summary>本期来源全景 <span>绿色表示本期有更新</span></summary>${model.groups.map((group) => `
    <section class="panorama-group">
      <header><strong>${escapeHtml(group.title)}</strong><span>${group.activeCount}/${group.total}</span></header>
      <ul>
        ${group.items.map((item) => `<li class="${item.active ? 'is-active' : ''}"><span class="dot"></span>${item.href ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>` : `<span>${escapeHtml(item.label)}</span>`}${item.detail ? `<em>${escapeHtml(item.detail)}</em>` : ''}</li>`).join('')}
      </ul>
    </section>`).join('')}
  </details>`;
}

function posterInitials(text) {
  const clean = normalizeWhitespace(text);
  if (!clean) return 'AI';
  const parts = clean.split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('');
}

function renderCard(card) {
  return `<article class="card" id="${escapeHtml(card.anchorId)}">
    <div class="card-visual">
      <div class="poster">
        <div class="poster-kicker">${escapeHtml(card.posterLabel)}</div>
        <div class="poster-initials">${escapeHtml(posterInitials(card.posterTitle))}</div>
        <div class="poster-title">${escapeHtml(card.posterTitle)}</div>
        <p class="poster-preview">${escapeHtml(card.posterPreview)}</p>
      </div>
    </div>
    <div class="card-body">
      <p class="entity-line"><span class="entity-label">${escapeHtml(card.sourceLabel)}:</span><span class="entity-value">${escapeHtml(card.sourceValue)}</span></p>
      ${card.subtitle ? `<p class="card-subtitle">${escapeHtml(card.subtitle)}</p>` : ''}
      <div class="card-summary">${escapeHtml(card.summary)}</div>
      <div class="tag-row">${card.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="link-row"><span class="link-label">来源链接</span>${card.links.map((link, index) => `${index > 0 ? '<span class="link-divider">/</span>' : ''}<a href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join('')}</div>
    </div>
  </article>`;
}

function renderSection(section) {
  if (!section.cards || section.cards.length === 0) return '';
  return `<section class="section" id="${escapeHtml(section.id)}">
    <div class="section-heading">
      <p class="section-kicker">${escapeHtml(section.kicker)}</p>
      <h2>${escapeHtml(section.title)}</h2>
      <p class="section-intro">${escapeHtml(section.intro)}</p>
    </div>
    <div class="section-cards">${section.cards.map(renderCard).join('')}</div>
  </section>`;
}

function buildStyles() {
  return `:root {
    --paper: #f3ede6;
    --card: #fffdf9;
    --line: rgba(164, 83, 54, 0.16);
    --ink: #1d1b18;
    --muted: #7d6a5b;
    --accent: #a45336;
    --green: #22804b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; background: radial-gradient(circle at top, rgba(214,190,168,0.28), transparent 40%), var(--paper); color: var(--ink); }
  a { color: var(--accent); }
  .page { max-width: 1180px; margin: 0 auto; padding: 36px 20px 72px; }
  .hero { padding: 42px 32px 34px; border-radius: 28px; background: #252525; color: #fff8f0; }
  .hero-kicker { margin: 0 0 12px; font-size: 12px; letter-spacing: .18em; text-transform: uppercase; color: rgba(255,248,240,.68); }
  .hero-date { margin: 0 0 18px; color: rgba(255,248,240,.82); }
  .hero h1 { margin: 0; font-family: Georgia, 'Times New Roman', serif; font-size: clamp(3rem, 7vw, 5.4rem); line-height: .95; }
  .hero-slogan { margin: 14px 0 0; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; font-weight: 700; }
  .hero-intro { max-width: 58ch; margin: 22px 0 0; line-height: 1.9; color: rgba(255,248,240,.88); }
  .panorama { margin: 24px 0 8px; padding: 0 4px; }
  .panorama summary { cursor: pointer; font-weight: 700; color: var(--ink); }
  .panorama summary span { font-weight: 400; color: var(--muted); margin-left: 8px; font-size: .92rem; }
  .panorama-group { margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(23,22,20,.08); }
  .panorama-group header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .panorama-group ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  .panorama-group li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--muted); }
  .panorama-group li.is-active { color: var(--ink); }
  .panorama-group .dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(125,106,91,.3); display: inline-block; }
  .panorama-group li.is-active .dot { background: var(--green); }
  .panorama-group em { color: rgba(125,106,91,.72); font-style: normal; font-size: .9rem; }
  .section { margin-top: 56px; }
  .section-heading { margin-bottom: 22px; }
  .section-kicker { margin: 0 0 10px; letter-spacing: .16em; font-size: 12px; text-transform: uppercase; color: var(--muted); }
  .section h2 { margin: 0 0 10px; font-family: Georgia, 'Times New Roman', serif; font-size: clamp(2rem, 4vw, 3.1rem); line-height: 1.05; }
  .section-intro { margin: 0; max-width: 60ch; color: var(--muted); line-height: 1.9; }
  .section-cards { display: grid; gap: 24px; }
  .card { display: grid; grid-template-columns: minmax(300px, 42%) minmax(0, 1fr); gap: 0; background: rgba(255,253,249,.96); border: 1px solid var(--line); border-radius: 28px; overflow: hidden; box-shadow: 0 18px 40px rgba(73,53,39,.08); }
  .card-visual { padding: 22px; background: linear-gradient(180deg, rgba(35,35,35,.08), transparent 65%); }
  .poster { height: 100%; min-height: 320px; border-radius: 22px; padding: 22px; display: flex; flex-direction: column; justify-content: flex-end; color: #fff8f0; background: linear-gradient(180deg, rgba(255,255,255,.15), rgba(28,28,28,.78)), radial-gradient(circle at top, rgba(255,255,255,.22), transparent 35%), #3b3733; }
  .poster-kicker { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; opacity: .78; }
  .poster-initials { margin-top: auto; font-family: Georgia, 'Times New Roman', serif; font-size: 4rem; line-height: .95; }
  .poster-title { margin-top: 6px; font-family: Georgia, 'Times New Roman', serif; font-size: 2rem; line-height: 1; }
  .poster-preview { margin: 12px 0 0; max-width: 22ch; line-height: 1.8; color: rgba(255,248,240,.88); }
  .card-body { padding: 28px 28px 24px 12px; display: flex; flex-direction: column; justify-content: center; }
  .entity-line { margin: 0 0 10px; font-size: 1.45rem; line-height: 1.25; font-weight: 700; }
  .entity-label { color: var(--accent); }
  .entity-value { color: var(--ink); }
  .card-subtitle { margin: 0 0 16px; font-size: .82rem; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .card-summary { padding-top: 18px; border-top: 1px solid rgba(164,83,54,.16); font-size: 1rem; line-height: 2; color: var(--ink); }
  .tag-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .tag { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(164,83,54,.16); color: rgba(29,27,24,.78); background: rgba(255,255,255,.5); font-size: .78rem; }
  .link-row { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(23,22,20,.08); font-size: .9rem; }
  .link-label { color: var(--muted); font-size: .76rem; letter-spacing: .12em; text-transform: uppercase; }
  .link-divider { color: rgba(23,22,20,.22); }
  .footer { margin-top: 56px; padding-top: 18px; border-top: 1px solid rgba(23,22,20,.08); color: var(--muted); font-size: .95rem; }
  @media (max-width: 900px) {
    .card { grid-template-columns: 1fr; }
    .card-body { padding: 20px 22px 24px; }
    .poster { min-height: 260px; }
  }
  @media (max-width: 640px) {
    .page { padding: 22px 14px 48px; }
    .hero { padding: 32px 20px 28px; }
    .hero h1 { font-size: 3.3rem; }
    .entity-line { font-size: 1.12rem; }
  }`;
}

function buildHtml({ title, heroDate, panorama, sections }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>${buildStyles()}</style>
  </head>
  <body>
    <main class="page">
      <header class="hero">
        <p class="hero-kicker">FOLLOW BUILDERS DIGEST</p>
        <p class="hero-date">${escapeHtml(heroDate)}</p>
        <h1>AI Builders<br />简报</h1>
        <p class="hero-slogan">Closer to Source, Closer to Change</p>
        <p class="hero-intro">我们直接跟踪头部创新组织与关键建设者的公开输出，把博客、播客、推文和产品更新中的原始信号，整理成中文可读的快照。不是复述热闹，而是尽量缩短你与变化源头之间的距离。</p>
      </header>
      ${renderPanorama(panorama)}
      ${sections.join('')}
      <footer class="footer">通过 Follow Builders 公开发布链路生成，最新内容会自动归档到公开链接。</footer>
    </main>
  </body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const digest = await readInputJSON(args);
  const tweetCards = prioritizeTweetCards(prioritizeBuilders(ensureArray(digest.x)).map(buildTweetCard).filter(Boolean));
  const blogCards = ensureArray(digest.blogs).map(buildBlogCard).filter(Boolean);
  const podcastCards = ensureArray(digest.podcasts).map(buildPodcastCard).filter(Boolean);

  const cardsBySection = {
    'X / 推文': tweetCards,
    '官方博客': blogCards,
    '播客精选': podcastCards
  };

  const sections = getSectionConfigs(cardsBySection).map(renderSection).filter(Boolean);
  const panorama = buildPanoramaModel(digest.trackedSources, [...tweetCards, ...blogCards, ...podcastCards]);
  const digestDate = digest.stats?.feedGeneratedAt || digest.generatedAt || Date.now();
  const title = `AI Builders 简报 - ${formatChineseDate(digestDate, digest.config?.timezone || 'Asia/Shanghai')}`;
  const heroDate = formatChineseDate(digestDate, digest.config?.timezone || 'Asia/Shanghai');
  const html = buildHtml({ title, heroDate, panorama, sections });

  const outputPath = args.output ? resolve(args.output) : join(DEFAULT_OUTPUT_DIR, `follow-builders-digest-${dateStamp(digestDate)}.html`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf-8');

  console.log(JSON.stringify({
    status: 'ok',
    output: outputPath,
    cards: { tweets: tweetCards.length, blogs: blogCards.length, podcasts: podcastCards.length }
  }, null, 2));
}

export {
  ensureArray,
  formatChineseDate,
  prioritizeBuilders,
  prioritizeTweetCards,
  buildTweetCard,
  buildBlogCard,
  buildPodcastCard,
  buildDigestSummary
};

const IS_MAIN = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', message: error.message }, null, 2));
    process.exit(1);
  });
}

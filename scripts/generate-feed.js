#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (daily at 6am UTC) to fetch content and publish
// feed-x.json, feed-podcasts.json, and feed-blogs.json.
//
// Deduplication: tracks previously seen tweet IDs, episode GUIDs, and article
// URLs in state-feed.json so content is never repeated across runs.
//
// Usage: node generate-feed.js [--tweets-only | --podcasts-only | --blogs-only]
// Env vars needed: X_BEARER_TOKEN, POD2TXT_API_KEY
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const X_API_BASE = 'https://api.x.com/2';
// Some RSS hosts (notably Substack) block non-browser user agents from cloud IPs.
// Using a real Chrome UA avoids 403 errors in GitHub Actions.
const RSS_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const RSSHUB_INSTANCES = [
  'https://rsshub.app',
  'https://rss.nodeseek.com'
];
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days — podcasts publish weekly/biweekly, not daily
const BLOG_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;
const MAX_ARTICLES_PER_BLOG = 3;
const MAX_VIDEOS_PER_CHANNEL = 2;
const YOUTUBE_LOOKBACK_HOURS = 48;

// State file lives in the repo root so it gets committed by GitHub Actions
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

// Tracks which tweet IDs and video IDs we've already included in feeds
// so we never send the same content twice across runs.

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    // Ensure seenArticles exists for older state files
    if (!state.seenArticles) state.seenArticles = {};
    return state;
  } catch {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  }
}

async function saveState(state) {
  // Prune entries older than 7 days to prevent the file from growing forever
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenVideos)) {
    if (ts < cutoff) delete state.seenVideos[id];
  }
  for (const [id, ts] of Object.entries(state.seenArticles || {})) {
    if (ts < cutoff) delete state.seenArticles[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- Podcast Fetching (RSS + pod2txt) ----------------------------------------

// Parses an RSS feed XML string and returns episode objects with
// title, publishedAt, guid, link, and description. RSS feeds list newest first.
function parseRssFeed(xml) {
  const episodes = [];
  // Match each <item> block in the RSS feed
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];

    // Extract title (inside CDATA or plain text)
    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
      || block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

    // Extract GUID (unique episode identifier), stripping CDATA wrapper if present
    const guidMatch = block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/)
      || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : null;

    // Extract publish date
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;

    // Extract episode link (for the feed output URL)
    // Plain <link>url</link> in RSS items (not atom:link or namespaced variants)
    const linkMatch = block.match(/<link>([^<]+)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;

    // Extract description/show notes (prefer content:encoded, then description)
    const descMatch = block.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/)
      || block.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/)
      || block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)
      || block.match(/<description>([\s\S]*?)<\/description>/);
    const description = descMatch
      ? descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';

    if (guid) {
      episodes.push({ title, guid, publishedAt, link, description });
    }
  }
  return episodes;
}

// Main podcast fetching function. For each podcast:
// 1. Fetches the RSS feed to discover episodes
// 2. Filters by lookback window and dedup
// 3. Uses RSS description/show notes (no external API needed)
async function fetchPodcastContent(podcasts, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const podcast of podcasts) {
    if (!podcast.rssUrl) {
      errors.push(`Podcast: No rssUrl configured for ${podcast.name}`);
      continue;
    }

    try {
      console.error(`  Fetching RSS for ${podcast.name}...`);
      const rssRes = await fetch(podcast.rssUrl, {
        headers: {
          'User-Agent': RSS_USER_AGENT,
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        },
        signal: AbortSignal.timeout(30000)
      });

      if (!rssRes.ok) {
        errors.push(`Podcast: Failed to fetch RSS for ${podcast.name}: HTTP ${rssRes.status}`);
        continue;
      }

      const rssXml = await rssRes.text();
      const episodes = parseRssFeed(rssXml);
      console.error(`  ${podcast.name}: found ${episodes.length} episodes in RSS feed`);

      // Take up to 3 newest unseen episodes within the lookback window
      let added = 0;
      for (const episode of episodes) {
        if (added >= 3) break;
        if (state.seenVideos[episode.guid]) continue;
        if (episode.publishedAt && new Date(episode.publishedAt) < cutoff) continue;

        state.seenVideos[episode.guid] = Date.now();

        results.push({
          source: 'podcast',
          name: podcast.name,
          title: episode.title,
          guid: episode.guid,
          url: episode.link || podcast.url,
          publishedAt: episode.publishedAt,
          description: episode.description
        });
        added++;
      }

      console.error(`  ${podcast.name}: added ${added} episode(s)`);
    } catch (err) {
      errors.push(`Podcast: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  return results;
}

// -- X/Twitter Fetching (Official API v2) ------------------------------------

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Batch lookup all user IDs (1 API call)
  const handles = xAccounts.map(a => a.handle);
  let userMap = {};

  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(
        `${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        errors.push(`X API: User lookup failed: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || ''
        };
      }
      if (data.errors) {
        for (const err of data.errors) {
          errors.push(`X API: User not found: ${err.value || err.detail}`);
        }
      }
    } catch (err) {
      errors.push(`X API: User lookup error: ${err.message}`);
    }
  }

  // Fetch recent tweets per user (max 3, exclude retweets/replies)
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetch(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
        `max_results=5` +       // fetch 5, then filter to 3 new ones
        `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
        `&exclude=retweets,replies` +
        `&start_time=${cutoff.toISOString()}`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        if (res.status === 429) {
          errors.push(`X API: Rate limited, skipping remaining accounts`);
          break;
        }
        errors.push(`X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const allTweets = data.data || [];

      // Filter out already-seen tweets, cap at 3
      const newTweets = [];
      for (const t of allTweets) {
        if (state.seenTweets[t.id]) continue; // dedup
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          // note_tweet.text has the full untruncated text for long tweets (>280 chars)
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false,
          quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null
        });

        // Mark as seen
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: 'x',
        name: account.name,
        handle: account.handle,
        bio: userData.description,
        tweets: newTweets
      });

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- Blog Fetching (HTML scraping) -------------------------------------------

// Scrapes the Anthropic Engineering blog index page.
// The page is a Next.js app that embeds article data as JSON in <script> tags.
// We parse that JSON to extract article metadata (title, slug, date, summary).
// Falls back to regex-based HTML parsing if the JSON approach fails.
function parseAnthropicEngineeringIndex(html) {
  const articles = [];

  // Strategy 1: Look for article data in Next.js __NEXT_DATA__ script tag
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      // Navigate the Next.js page props to find article entries
      const pageProps = data?.props?.pageProps;
      const posts = pageProps?.posts || pageProps?.articles || pageProps?.entries || [];
      for (const post of posts) {
        const slug = post.slug?.current || post.slug || '';
        articles.push({
          title: post.title || 'Untitled',
          url: `https://www.anthropic.com/engineering/${slug}`,
          publishedAt: post.publishedOn || post.publishedAt || post.date || null,
          description: post.summary || post.description || ''
        });
      }
      if (articles.length > 0) return articles;
    } catch {
      // JSON parsing failed, fall through to regex approach
    }
  }

  // Strategy 2: Regex-based extraction from the rendered HTML.
  // Anthropic engineering articles follow the pattern /engineering/<slug>
  const linkRegex = /href="\/engineering\/([a-z0-9-]+)"/gi;
  const seenSlugs = new Set();
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: '', // Will be filled when we fetch the article page
      url: `https://www.anthropic.com/engineering/${slug}`,
      publishedAt: null,
      description: ''
    });
  }
  return articles;
}

// Scrapes the Claude Blog index page (claude.com/blog).
// This is a Webflow site. We extract article links, titles, and dates
// from the HTML structure.
function parseClaudeBlogIndex(html) {
  const articles = [];
  const seenSlugs = new Set();

  // Match blog post links — they follow the pattern /blog/<slug>
  // We capture surrounding context to extract titles and dates
  const linkRegex = /href="\/blog\/([a-z0-9-]+)"/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: '', // Will be filled when we fetch the article page
      url: `https://claude.com/blog/${slug}`,
      publishedAt: null,
      description: ''
    });
  }
  return articles;
}

// Extracts the main text content from an Anthropic Engineering article page.
// Tries the embedded JSON first (Next.js SSR data), then falls back to
// stripping HTML tags from the article body.
function extractAnthropicArticleContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  // Try to get structured data from Next.js __NEXT_DATA__
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const pageProps = data?.props?.pageProps;
      const post = pageProps?.post || pageProps?.article || pageProps?.entry || pageProps;
      title = post?.title || '';
      author = post?.author?.name || post?.authors?.[0]?.name || '';
      publishedAt = post?.publishedOn || post?.publishedAt || post?.date || null;

      // Extract text from the body blocks (Sanity CMS portable text format)
      const body = post?.body || post?.content || [];
      if (Array.isArray(body)) {
        const textParts = [];
        for (const block of body) {
          if (block._type === 'block' && block.children) {
            const text = block.children.map(c => c.text || '').join('');
            if (text.trim()) textParts.push(text.trim());
          }
        }
        content = textParts.join('\n\n');
      }
      if (content) return { title, author, publishedAt, content };
    } catch {
      // Fall through to HTML stripping
    }
  }

  // Fallback: extract title from <h1> and body from <article> or main content
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();

  // Try to find the article body and strip HTML tags
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyHtml = articleMatch ? articleMatch[1] : html;

  // Strip script/style tags first, then all remaining HTML tags
  content = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, author, publishedAt, content };
}

// Extracts the main text content from a Claude Blog article page.
// Uses JSON-LD schema data if present, then falls back to the rich text body.
function extractClaudeBlogArticleContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  // Try JSON-LD structured data first (most reliable for metadata)
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld['@type'] === 'BlogPosting' || ld['@type'] === 'Article') {
        title = ld.headline || ld.name || '';
        author = ld.author?.name || '';
        publishedAt = ld.datePublished || null;
        break;
      }
    } catch {
      // Not valid JSON-LD, skip
    }
  }

  // Extract body text from the Webflow rich text container
  const richTextMatch = html.match(/<div[^>]*class="[^"]*u-rich-text-blog[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (richTextMatch) {
    content = richTextMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // If rich text extraction failed, try a broader approach
  if (!content) {
    // Get title from <h1> if not already found
    if (!title) {
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
    }

    // Strip the whole page down to text as a last resort
    content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { title, author, publishedAt, content };
}

// Main blog fetching orchestrator.
// For each blog source in the config, discovers new articles, deduplicates
// against previously seen URLs, fetches full article content, and returns
// the results for feed-blogs.json.
async function fetchBlogContent(blogs, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const blog of blogs) {
    console.error(`  Processing blog: ${blog.name}...`);
    let candidates = [];

    try {
      // Step 1: Discover articles from the blog index page
      const indexRes = await fetch(blog.indexUrl, {
        headers: { 'User-Agent': 'FollowBuilders/1.0 (feed aggregator)' }
      });
      if (!indexRes.ok) {
        errors.push(`Blog: Failed to fetch index for ${blog.name}: HTTP ${indexRes.status}`);
        continue;
      }
      const indexHtml = await indexRes.text();

      // Use the right parser based on which blog this is
      if (blog.indexUrl.includes('anthropic.com')) {
        candidates = parseAnthropicEngineeringIndex(indexHtml);
      } else if (blog.indexUrl.includes('claude.com')) {
        candidates = parseClaudeBlogIndex(indexHtml);
      }

      // Step 2: Filter to unseen articles, cap at MAX_ARTICLES_PER_BLOG.
      // Blog index pages list articles newest-first. We only consider the
      // first few entries (MAX_INDEX_SCAN) to avoid crawling the entire
      // backlog on first run. Articles with a known date must fall within
      // the lookback window; articles without dates are accepted if they
      // appear near the top of the listing (likely recent).
      const MAX_INDEX_SCAN = MAX_ARTICLES_PER_BLOG; // only look at the N most recent entries
      const newArticles = [];
      for (const article of candidates.slice(0, MAX_INDEX_SCAN)) {
        if (state.seenArticles[article.url]) continue; // already seen
        // If we have a date, check it's within the lookback window
        if (article.publishedAt && new Date(article.publishedAt) < cutoff) continue;
        newArticles.push(article);
        if (newArticles.length >= MAX_ARTICLES_PER_BLOG) break;
      }

      if (newArticles.length === 0) {
        console.error(`    No new articles found`);
        continue;
      }

      console.error(`    Found ${newArticles.length} new article(s), fetching content...`);

      // Step 3: Fetch full article content for each new article
      for (const article of newArticles) {
        try {
          // Fetch the full article page
          const articleRes = await fetch(article.url, {
            headers: { 'User-Agent': 'FollowBuilders/1.0 (feed aggregator)' }
          });
          if (!articleRes.ok) {
            errors.push(`Blog: Failed to fetch article ${article.url}: HTTP ${articleRes.status}`);
            continue;
          }
          const articleHtml = await articleRes.text();

          // Use the right content extractor based on the blog
          let extracted;
          if (article.url.includes('anthropic.com/engineering')) {
            extracted = extractAnthropicArticleContent(articleHtml);
          } else if (article.url.includes('claude.com/blog')) {
            extracted = extractClaudeBlogArticleContent(articleHtml);
          }

          if (!extracted || !extracted.content) {
            errors.push(`Blog: No content extracted from ${article.url}`);
            continue;
          }

          // Merge extracted data with what we already have from the index
          results.push({
            source: 'blog',
            name: blog.name,
            title: extracted.title || article.title || 'Untitled',
            url: article.url,
            publishedAt: extracted.publishedAt || article.publishedAt || null,
            author: extracted.author || '',
            description: article.description || '',
            content: extracted.content
          });

          // Mark as seen
          state.seenArticles[article.url] = Date.now();

          // Small delay between article fetches to be polite
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          errors.push(`Blog: Error fetching article ${article.url}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`Blog: Error processing ${blog.name}: ${err.message}`);
    }
  }

  return results;
}

// -- YouTube Fetching (RSS, no API key needed) --------------------------------

// Parses a YouTube Atom RSS feed. Each <entry> has <title>, <link>,
// <published>, and <media:group> with <media:description>.
function parseYouTubeRss(xml) {
  const videos = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];

    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

    // Atom <link> with rel="alternate" has the video URL
    const linkMatch = block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)
      || block.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"/)
      || block.match(/<link[^>]*href="([^"]+)"/);
    const url = linkMatch ? linkMatch[1].trim() : null;

    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/);
    const publishedAt = publishedMatch ? publishedMatch[1].trim() : null;

    // Video description from media:group
    const descMatch = block.match(/<media:description>([\s\S]*?)<\/media:description>/);
    const description = descMatch ? descMatch[1].trim() : '';

    if (url) {
      videos.push({ title, url, publishedAt, description });
    }
  }
  return videos;
}

async function fetchYouTubeContent(channels, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - YOUTUBE_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const channel of channels) {
    try {
      const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`;
      const res = await fetch(feedUrl, {
        headers: { 'User-Agent': 'FollowBuilders/1.0 (feed aggregator)' },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        errors.push(`YouTube: Failed to fetch ${channel.name}: HTTP ${res.status}`);
        continue;
      }

      const xml = await res.text();
      const videos = parseYouTubeRss(xml);

      const newVideos = [];
      for (const video of videos) {
        // Dedup by URL
        if (state.seenVideos[video.url]) continue;
        // Filter by lookback window
        if (video.publishedAt && new Date(video.publishedAt) < cutoff) continue;

        newVideos.push(video);
        state.seenVideos[video.url] = Date.now();
        if (newVideos.length >= MAX_VIDEOS_PER_CHANNEL) break;
      }

      if (newVideos.length === 0) continue;

      results.push({
        source: 'youtube',
        name: channel.name,
        channelId: channel.channelId,
        videos: newVideos
      });

      // Small delay to be polite
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      errors.push(`YouTube: Error fetching ${channel.name}: ${err.message}`);
    }
  }

  return results;
}

// -- RSSHub X Fetcher (free, no API key) ---------------------------------------

// Fetches tweets for extra X accounts via RSSHub.
// RSSHub converts X user timelines to RSS. Tries multiple instances for reliability.
async function fetchXExtraViaRSSHub(accounts, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const account of accounts) {
    let fetched = false;

    for (const instance of RSSHUB_INSTANCES) {
      if (fetched) break;

      try {
        const rssUrl = `${instance}/twitter/user/${account.handle}`;
        const res = await fetch(rssUrl, {
          headers: { 'User-Agent': RSS_USER_AGENT },
          signal: AbortSignal.timeout(15000)
        });

        if (!res.ok) continue;

        const xml = await res.text();

        // Parse RSS items
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        const tweets = [];
        let itemMatch;

        while ((itemMatch = itemRegex.exec(xml)) !== null && tweets.length < MAX_TWEETS_PER_USER) {
          const block = itemMatch[1];

          const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
            || block.match(/<title>([\s\S]*?)<\/title>/);
          const text = titleMatch ? titleMatch[1].replace(/^RT @[^:]+: /, '').trim() : '';

          const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
          const url = linkMatch ? linkMatch[1].trim() : '';

          const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          const createdAt = pubMatch ? new Date(pubMatch[1].trim()).toISOString() : null;

          if (!text || !url) continue;
          if (createdAt && new Date(createdAt) < cutoff) continue;
          if (state.seenTweets[url]) continue;

          tweets.push({ text, url, createdAt });
          state.seenTweets[url] = Date.now();
        }

        if (tweets.length > 0) {
          results.push({
            source: 'x_extra',
            name: account.name,
            handle: account.handle,
            bio: '',
            tweets
          });
          fetched = true;
        }
      } catch (err) {
        // Try next instance
      }

      if (!fetched) await new Promise(r => setTimeout(r, 500));
    }

    if (!fetched) {
      errors.push(`RSSHub: Failed to fetch @${account.handle}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');
  const blogsOnly = args.includes('--blogs-only');
  const youtubeOnly = args.includes('--youtube-only');

  // If a specific --*-only flag is set, only that feed type runs.
  // If no flag is set, all run.
  const runTweets = tweetsOnly || (!podcastsOnly && !blogsOnly && !youtubeOnly);
  const runPodcasts = podcastsOnly || (!tweetsOnly && !blogsOnly && !youtubeOnly);
  const runBlogs = blogsOnly || (!tweetsOnly && !podcastsOnly && !youtubeOnly);
  const runYoutube = youtubeOnly || (!tweetsOnly && !podcastsOnly && !blogsOnly && !xExtraOnly);
  const xExtraOnly = args.includes('--x-extra-only');
  const runXExtra = xExtraOnly || (!tweetsOnly && !podcastsOnly && !blogsOnly && !youtubeOnly);

  const xBearerToken = process.env.X_BEARER_TOKEN;

  if (runTweets && !xBearerToken) {
    console.error('X_BEARER_TOKEN not set');
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets
  if (runTweets) {
    console.error('Fetching X/Twitter content...');
    const allXAccounts = [...(sources.x_accounts || []), ...(sources.x_accounts_extra || [])];
    const xContent = await fetchXContent(allXAccounts, xBearerToken, state, errors);
    console.error(`  Found ${xContent.length} builders with new tweets`);

    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      x: xContent,
      stats: { xBuilders: xContent.length, totalTweets },
      errors: errors.filter(e => e.startsWith('X API')).length > 0
        ? errors.filter(e => e.startsWith('X API')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
    console.error(`  feed-x.json: ${xContent.length} builders, ${totalTweets} tweets`);
  }

  // Fetch podcasts
  if (runPodcasts) {
    console.error('Fetching podcast content (RSS + pod2txt)...');
    const podcasts = await fetchPodcastContent(sources.podcasts, state, errors);
    console.error(`  Found ${podcasts.length} new episodes`);

    const podcastFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: PODCAST_LOOKBACK_HOURS,
      podcasts,
      stats: { podcastEpisodes: podcasts.length },
      errors: errors.filter(e => e.startsWith('Podcast')).length > 0
        ? errors.filter(e => e.startsWith('Podcast')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(podcastFeed, null, 2));
    console.error(`  feed-podcasts.json: ${podcasts.length} episodes`);
  }

  // Fetch blog posts
  if (runBlogs && sources.blogs && sources.blogs.length > 0) {
    console.error('Fetching blog content...');
    const blogContent = await fetchBlogContent(sources.blogs, state, errors);
    console.error(`  Found ${blogContent.length} new blog post(s)`);

    const blogFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: BLOG_LOOKBACK_HOURS,
      blogs: blogContent,
      stats: { blogPosts: blogContent.length },
      errors: errors.filter(e => e.startsWith('Blog')).length > 0
        ? errors.filter(e => e.startsWith('Blog')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-blogs.json'), JSON.stringify(blogFeed, null, 2));
    console.error(`  feed-blogs.json: ${blogContent.length} posts`);
  }

  // Fetch YouTube
  if (runYoutube && sources.youtube && sources.youtube.length > 0) {
    console.error('Fetching YouTube content (RSS)...');
    const youtubeContent = await fetchYouTubeContent(sources.youtube, state, errors);
    console.error(`  Found ${youtubeContent.length} channels with new videos`);

    const totalVideos = youtubeContent.reduce((sum, c) => sum + c.videos.length, 0);
    const youtubeFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: YOUTUBE_LOOKBACK_HOURS,
      youtube: youtubeContent,
      stats: { youtubeChannels: youtubeContent.length, totalVideos },
      errors: errors.filter(e => e.startsWith('YouTube')).length > 0
        ? errors.filter(e => e.startsWith('YouTube')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-youtube.json'), JSON.stringify(youtubeFeed, null, 2));
    console.error(`  feed-youtube.json: ${youtubeContent.length} channels, ${totalVideos} videos`);
  }

  // Fetch extra X accounts via RSSHub (free, no API key)
  if (runXExtra && sources.x_accounts_extra && sources.x_accounts_extra.length > 0) {
    console.error('Fetching extra X accounts via RSSHub...');
    const xExtra = await fetchXExtraViaRSSHub(sources.x_accounts_extra, state, errors);
    console.error(`  ${xExtra.length} extra accounts with new tweets`);

    const totalExtra = xExtra.reduce((sum, a) => sum + a.tweets.length, 0);
    const xExtraFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      xExtra,
      stats: { xExtraAccounts: xExtra.length, totalExtraTweets: totalExtra },
      errors: errors.filter(e => e.startsWith('RSSHub')).length > 0
        ? errors.filter(e => e.startsWith('RSSHub')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x-extra.json'), JSON.stringify(xExtraFeed, null, 2));
    console.error(`  feed-x-extra.json: ${xExtra.length} accounts, ${totalExtra} tweets`);
  }

  // Save dedup state
  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors`);
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});

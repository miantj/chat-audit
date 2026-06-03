/**
 * Business-oriented CSV: one row per conversation, flat columns + a transcript
 * built only from messages whose `text` is non-empty after trim (images/voice
 * placeholders without text are skipped in the transcript column).
 *
 * Input: full dataset `.json` (uses `conversations[]`) or `.jsonl` (one
 * conversation object per line — lower memory for large exports).
 *
 * Usage:
 *   node scripts/json-to-csv-business.js --in=./exports/chat-audit-2026-04-27.json
 *   node scripts/json-to-csv-business.js --in=./exports/chat-audit-2026-04-27.jsonl --out=./exports/out.csv
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

/** Parse `--key=value` / `--flag` style argv into a plain object. */
export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const value = eq === -1 ? true : body.slice(eq + 1);
    opts[key] = value;
  }
  return opts;
}

function showUsage() {
  console.error(
    [
      'Usage: node json-to-csv-business.js --in=PATH.json[.jsonl] [options]',
      '',
      'Options:',
      '  --out=PATH.csv       Output path (default: same basename as --in, .csv)',
      '  --no-bom             Omit UTF-8 BOM (Excel 业务场景默认写入 BOM 便于中文)',
      '  --max-transcript=N   Truncate transcript cell to N chars (default 32700)',
      '  --split-by-day       Write one CSV per message date: <basename>.YYYY-MM-DD.business.csv',
      '  --help               Show this message'
    ].join('\n')
  );
}

/** RFC 4180 CSV field: wrap in quotes, escape internal quotes. */
export function escapeCsvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Map dataset role to a short Chinese label for transcript lines. */
export function roleLabel(role) {
  if (role === 'customer') return '客户';
  if (role === 'official') return '官方';
  return role || '未知';
}

/**
 * Check if a message type is image-related.
 */
export function isImageType(type) {
  return /image|emotion/i.test(type || '');
}

/**
 * Check if a message type is voice-related.
 */
export function isVoiceType(type) {
  return /voice/i.test(type || '');
}

/**
 * Check if a message type is video-related.
 */
export function isVideoType(type) {
  return /video/i.test(type || '');
}

/**
 * Format attachments for transcript inclusion.
 * Filters out SVG play buttons (common in WeChat video placeholders).
 */
export function formatAttachmentSuffix(attachments) {
  const parts = [];
  const isPlaySvg = (url) => /^data:image\/svg/i.test(url || '');
  const imgList = Array.isArray(attachments?.images) ? attachments.images : [];
  if (imgList.length > 0) {
    const urls = imgList.map((img) => img.url || '').filter(Boolean).filter((u) => !isPlaySvg(u));
    if (urls.length > 0) {
      parts.push(`[图片: ${urls.join(' ')}]`);
    }
  }
  const vidList = Array.isArray(attachments?.videos) ? attachments.videos : [];
  if (vidList.length > 0) {
    const urls = vidList.map((v) => v.url || '').filter(Boolean).filter((u) => !isPlaySvg(u));
    if (urls.length > 0) {
      parts.push(`[视频: ${urls.join(' ')}]`);
    }
  }
  if (Array.isArray(attachments?.weapp_cards) && attachments.weapp_cards.length > 0) {
    parts.push(`[小程序: ${attachments.weapp_cards.map((c) => c.title || c.app_name || '').filter(Boolean).join(', ')}]`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

/**
 * Join non-empty text messages in order; each line prefixed by [客户]/[官方].
 * - Images/emojis without text: outputs [角色] [图片] url1 url2 ...
 * - Voice rows: outputs [角色] [语音] text or transcribed text
 * - Pure text: outputs as before
 */
export function buildTranscript(messages, maxChars) {
  const list = Array.isArray(messages) ? [...messages] : [];
  list.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  const lines = [];
  for (const m of list) {
    const raw = typeof m.text === 'string' ? m.text : '';
    const t = raw.trim();
    const att = m.attachments || {};
    const imgCount = Array.isArray(att.images) ? att.images.length : 0;
    const mtype = m.type || '';

    // Video message: show video URLs (fallback to images if no <video> tag found)
    const videoCount = Array.isArray(att.videos) ? att.videos.length : 0;
    if (isVideoType(mtype) || videoCount > 0) {
      // Build effective attachments: if no real videos, use images as video cover
      const vidUrls = videoCount > 0
        ? att.videos.map((v) => v.url || '').filter(Boolean).filter((u) => !/^data:image\/svg/i.test(u))
        : (att.images || []).map((img) => img.url || '').filter(Boolean).filter((u) => !/^data:image\/svg/i.test(u));
      const suffix = vidUrls.length > 0 ? ` [视频: ${vidUrls.join(' ')}]` : '';
      lines.push(`[${roleLabel(m.role)}] [视频]${suffix}`);
      continue;
    }

    // Voice message: always include placeholder + text (transcription)
    if (isVoiceType(mtype)) {
      const suffix = t ? ` ${t}` : '';
      lines.push(`[${roleLabel(m.role)}] [语音]${suffix}`);
      continue;
    }

    // Pure image/emoji (no text, has images): show image URLs
    if (!t && imgCount > 0) {
      const suffix = formatAttachmentSuffix(att);
      lines.push(`[${roleLabel(m.role)}] [图片]${suffix}`);
      continue;
    }

    // Text with images attached
    if (t) {
      const suffix = imgCount > 0 ? formatAttachmentSuffix(att) : '';
      lines.push(`[${roleLabel(m.role)}] ${t}${suffix}`);
      continue;
    }

    // Fallback: skip truly empty messages
    // (weapp cards without text are already handled above via attachments)
    if (imgCount === 0 && !t) {
      continue;
    }
  }
  let out = lines.join('\n');
  if (maxChars > 0 && out.length > maxChars) {
    // Reserve space for ellipsis marker (Excel cell limit safety).
    out = `${out.slice(0, Math.max(0, maxChars - 20))}\n…(内容已截断，见 max-transcript)`;
  }
  return out;
}

/** Count messages that contribute at least one line to the transcript (text, voice, video, or image). */
export function countTextMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((m) => {
    const t = typeof m.text === 'string' ? m.text.trim() : '';
    const imgCount = Array.isArray(m.attachments?.images) ? m.attachments.images.length : 0;
    const vidCount = Array.isArray(m.attachments?.videos) ? m.attachments.videos.length : 0;
    return t || imgCount > 0 || vidCount > 0 || isVoiceType(m.type || '');
  }).length;
}

export function conversationToRow(conv, maxTranscriptChars) {
  const sm = conv.source_meta && typeof conv.source_meta === 'object' ? conv.source_meta : {};
  return {
    conversation_id: conv.conversation_id ?? '',
    employee_name: conv.employee_name ?? '',
    customer_name: conv.customer_name ?? '',
    source_friend_label: conv.source_friend_label ?? '',
    started_at: conv.started_at ?? '',
    ended_at: conv.ended_at ?? '',
    message_count: conv.message_count ?? (Array.isArray(conv.messages) ? conv.messages.length : ''),
    text_message_count: countTextMessages(conv.messages),
    department: sm.department ?? '',
    friend_count: sm.friend_count ?? '',
    last_chat_at: sm.last_chat_at ?? '',
    transcript: buildTranscript(conv.messages, maxTranscriptChars)
  };
}

export const HEADER = [
  'conversation_id',
  'employee_name',
  'customer_name',
  'source_friend_label',
  'started_at',
  'ended_at',
  'message_count',
  'text_message_count',
  'department',
  'friend_count',
  'last_chat_at',
  'transcript'
];

export function rowToCsvLine(row) {
  return HEADER.map((key) => escapeCsvCell(row[key])).join(',');
}

export function messageDate(value) {
  if (typeof value !== 'string') return '';
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function dateFallbackForConversation(conv) {
  return messageDate(conv.started_at) || messageDate(conv.ended_at) || 'unknown-date';
}

export function splitConversationByMessageDate(conv) {
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  if (messages.length === 0) {
    const date = dateFallbackForConversation(conv);
    return [{ date, conversation: { ...conv, messages: [], message_count: 0 } }];
  }

  const groups = new Map();
  for (const message of messages) {
    const date = messageDate(message.timestamp) || dateFallbackForConversation(conv);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(message);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayMessages]) => {
      const sorted = [...dayMessages].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      return {
        date,
        conversation: {
          ...conv,
          conversation_id: `${conv.conversation_id ?? 'conversation'}__date_${date}`,
          started_at: first?.timestamp || conv.started_at || '',
          ended_at: last?.timestamp || conv.ended_at || '',
          message_count: sorted.length,
          messages: sorted,
          source_meta: {
            ...(conv.source_meta || {}),
            split_by_day: true,
            split_date: date,
            original_conversation_id: conv.conversation_id ?? ''
          }
        }
      };
    });
}

/** Load all conversations from a full dataset JSON file. */
export async function loadConversationsFromJson(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  const data = JSON.parse(text);
  const list = data.conversations;
  if (!Array.isArray(list)) {
    throw new Error('Expected top-level `conversations` array in JSON dataset');
  }
  return list;
}

/**
 * Stream JSONL: one conversation JSON per line (same shape as each element of
 * `conversations[]`). Yields each parsed object for constant-ish memory use.
 */
export async function* iterateJsonlConversations(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed);
  }
}

export async function* iterateConversations(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jsonl') {
    yield* iterateJsonlConversations(filePath);
    return;
  }
  for (const conv of await loadConversationsFromJson(filePath)) {
    yield conv;
  }
}

function defaultOutPath(inputPath) {
  return inputPath.replace(/\.jsonl?$/i, '') + '.business.csv';
}

function splitOutPath(inputPath, date) {
  return inputPath.replace(/\.jsonl?$/i, '') + `.${date}.business.csv`;
}

async function writeCsvFile(outPath, rows, { useBom }) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  if (useBom) {
    out.write('\uFEFF');
  }
  out.write(`${HEADER.map(escapeCsvCell).join(',')}\n`);
  for (const row of rows) {
    out.write(`${row}\n`);
  }
  await new Promise((resolve, reject) => {
    out.end(resolve);
    out.on('error', reject);
  });
}

async function writeSingleCsv(inputPath, outPath, { useBom, maxTranscript }) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  if (useBom) out.write('\uFEFF');
  out.write(`${HEADER.map(escapeCsvCell).join(',')}\n`);
  for await (const conv of iterateConversations(inputPath)) {
    out.write(`${rowToCsvLine(conversationToRow(conv, maxTranscript))}\n`);
  }
  await new Promise((resolve, reject) => {
    out.end(resolve);
    out.on('error', reject);
  });
  return [outPath];
}

async function writeSplitByDayCsv(inputPath, { useBom, maxTranscript }) {
  const byDate = new Map();
  for await (const conv of iterateConversations(inputPath)) {
    for (const part of splitConversationByMessageDate(conv)) {
      if (!byDate.has(part.date)) byDate.set(part.date, []);
      byDate.get(part.date).push(rowToCsvLine(conversationToRow(part.conversation, maxTranscript)));
    }
  }

  const written = [];
  for (const [date, rows] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const outPath = splitOutPath(inputPath, date);
    await writeCsvFile(outPath, rows, { useBom });
    written.push(outPath);
  }
  return written;
}

export async function runCsvBusiness(opts) {
  const inputPath = path.resolve(process.cwd(), opts.in || '');
  if (!opts.in) {
    throw new Error('Missing --in');
  }
  const useBom = !opts['no-bom'];
  const maxTranscript = Number(opts['max-transcript'] ?? 32700);
  if (opts['split-by-day']) {
    if (opts.out) {
      throw new Error('--out is not supported with --split-by-day');
    }
    return writeSplitByDayCsv(inputPath, { useBom, maxTranscript });
  }
  const outPath = opts.out ? path.resolve(process.cwd(), opts.out) : defaultOutPath(inputPath);
  return writeSingleCsv(inputPath, outPath, { useBom, maxTranscript });
}

async function main() {
  const opts = parseArgs();
  if (opts.help || opts.h) {
    showUsage();
    return;
  }
  const written = await runCsvBusiness(opts);
  for (const outPath of written) {
    console.error(`Wrote ${outPath}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

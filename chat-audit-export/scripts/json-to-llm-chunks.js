/**
 * Build LLM-friendly JSONL chunks from exported chat-audit JSON/JSONL.
 *
 * This is a local post-processing step. It does not connect to CRM.
 *
 * Usage:
 *   node scripts/json-to-llm-chunks.js --in=./exports/chat-audit.json
 *   node scripts/json-to-llm-chunks.js --in=./exports/chat-audit.jsonl --by=day,employee --max-conversations=50
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTranscript,
  formatAttachmentSuffix,
  iterateConversations,
  messageDate,
  parseArgs,
  splitConversationByMessageDate
} from './json-to-csv-business.js';

function showUsage() {
  console.error(
    [
      'Usage: node json-to-llm-chunks.js --in=PATH.json[.jsonl] [options]',
      '',
      'Options:',
      '  --by=day,employee       Group keys, comma-separated (default: day,employee)',
      '  --max-conversations=N   Max conversations per chunk (default: 50)',
      '  --out-dir=DIR           Output directory (default: <input basename>.llm_chunks)',
      '  --max-transcript=N      Truncate transcript per record (default: no truncation)',
      '  --help                  Show this message'
    ].join('\n')
  );
}

function sanitizeName(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function compactAttachments(attachments) {
  const att = attachments && typeof attachments === 'object' ? attachments : {};
  const cleanUrlList = (list) => Array.isArray(list)
    ? list.map((item) => item?.url || '').filter(Boolean).filter((url) => !/^data:image\/svg/i.test(url))
    : [];
  return {
    images: cleanUrlList(att.images),
    videos: cleanUrlList(att.videos),
    files: Array.isArray(att.files)
      ? att.files.map((file) => ({
        name: file?.name || '',
        url: file?.url || ''
      })).filter((file) => file.name || file.url)
      : [],
    links: Array.isArray(att.links)
      ? att.links.map((link) => ({
        title: link?.title || '',
        url: link?.url || ''
      })).filter((link) => link.title || link.url)
      : [],
    weapp_cards: Array.isArray(att.weapp_cards)
      ? att.weapp_cards.map((card) => ({
        title: card?.title || '',
        app_name: card?.app_name || ''
      })).filter((card) => card.title || card.app_name)
      : []
  };
}

function attachmentSummary(attachments) {
  const suffix = formatAttachmentSuffix(attachments).trim();
  return suffix || '';
}

function compactMessage(message) {
  const attachments = compactAttachments(message?.attachments);
  return {
    timestamp: message?.timestamp || '',
    role: message?.role || '',
    sender_name: message?.sender_name || '',
    type: message?.type || '',
    text: message?.text || '',
    attachment_summary: attachmentSummary(message?.attachments),
    attachments
  };
}

function dateForConversation(conv) {
  return messageDate(conv.started_at) || messageDate(conv.ended_at) || 'unknown-date';
}

function llmRecordFromPart(date, conv, maxTranscript) {
  const messages = Array.isArray(conv.messages) ? [...conv.messages] : [];
  messages.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  return {
    conversation_id: conv.source_meta?.original_conversation_id || conv.conversation_id || '',
    date,
    employee_name: conv.employee_name || '',
    customer_id: conv.customer_id || conv.source_meta?.customer_id || '',
    customer_name: conv.customer_name || '',
    started_at: conv.started_at || '',
    ended_at: conv.ended_at || '',
    message_count: messages.length,
    transcript: buildTranscript(messages, maxTranscript),
    messages: messages.map(compactMessage)
  };
}

function groupKeyForRecord(record, by) {
  const keys = by.map((part) => {
    if (part === 'day' || part === 'date') return record.date || 'unknown-date';
    if (part === 'employee') return record.employee_name || 'unknown-employee';
    throw new Error(`Unsupported --by key: ${part}`);
  });
  return keys.join('__');
}

function chunkFileName(groupKey, index) {
  return `${sanitizeName(groupKey)}.part-${String(index).padStart(3, '0')}.jsonl`;
}

async function writeJsonl(filePath, records) {
  const out = fs.createWriteStream(filePath, { encoding: 'utf8' });
  for (const record of records) {
    out.write(`${JSON.stringify(record)}\n`);
  }
  await new Promise((resolve, reject) => {
    out.end(resolve);
    out.on('error', reject);
  });
}

function defaultOutDir(inputPath) {
  return inputPath.replace(/\.jsonl?$/i, '') + '.llm_chunks';
}

export async function runLlmChunks(opts) {
  if (!opts.in) throw new Error('Missing --in');
  const inputPath = path.resolve(process.cwd(), opts.in);
  const by = String(opts.by || 'day,employee').split(',').map((part) => part.trim()).filter(Boolean);
  const maxConversations = Number(opts['max-conversations'] || 50);
  if (!Number.isFinite(maxConversations) || maxConversations <= 0) {
    throw new Error('--max-conversations must be a positive number');
  }
  const maxTranscript = opts['max-transcript'] == null ? 0 : Number(opts['max-transcript']);
  const outDir = path.resolve(process.cwd(), opts['out-dir'] || defaultOutDir(inputPath));
  await fsp.mkdir(outDir, { recursive: true });

  const groups = new Map();
  for await (const conv of iterateConversations(inputPath)) {
    for (const { date, conversation } of splitConversationByMessageDate(conv)) {
      const record = llmRecordFromPart(date || dateForConversation(conversation), conversation, maxTranscript);
      const key = groupKeyForRecord(record, by);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
  }

  const manifest = {
    source: inputPath,
    by,
    max_conversations: maxConversations,
    chunks: []
  };

  for (const [groupKey, records] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (let offset = 0; offset < records.length; offset += maxConversations) {
      const part = Math.floor(offset / maxConversations) + 1;
      const chunk = records.slice(offset, offset + maxConversations);
      const fileName = chunkFileName(groupKey, part);
      const filePath = path.join(outDir, fileName);
      await writeJsonl(filePath, chunk);
      manifest.chunks.push({
        file: filePath,
        group: groupKey,
        part,
        date: by.includes('day') || by.includes('date') ? chunk[0]?.date || '' : '',
        employee_name: by.includes('employee') ? chunk[0]?.employee_name || '' : '',
        conversation_count: chunk.length,
        message_count: chunk.reduce((sum, record) => sum + (Number(record.message_count) || 0), 0)
      });
    }
  }

  const manifestPath = path.join(outDir, 'manifest.json');
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { outDir, manifestPath, chunkCount: manifest.chunks.length };
}

async function main() {
  const opts = parseArgs();
  if (opts.help || opts.h) {
    showUsage();
    return;
  }
  const result = await runLlmChunks(opts);
  console.error(`Wrote ${result.chunkCount} chunks to ${result.outDir}`);
  console.error(`Wrote ${result.manifestPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

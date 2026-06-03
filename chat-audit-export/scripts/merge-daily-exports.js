import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmptyDataset } from './lib/dataset.js';
import { appendJsonlRecord, readJsonlRecords } from './lib/jsonl-store.js';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { in: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, ...rest] = arg.slice(2).split('=');
    const value = rest.length > 0 ? rest.join('=') : true;
    if (key === 'in') {
      opts.in.push(value);
    } else {
      opts[key] = value;
    }
  }
  return opts;
}

function showUsage() {
  console.error([
    'Usage: node scripts/merge-daily-exports.js --in=day1.json --in=day2.json --out=merged.json',
    '',
    'Merges daily target-list exports into one month-level dataset without re-visiting CRM.',
    '',
    'Options:',
    '  --in=PATH            Daily .json or .jsonl input. Repeatable.',
    '  --inputs=A,B,C       Comma-separated daily .json/.jsonl inputs.',
    '  --out=PATH           Output merged dataset JSON.',
    '  --jsonl=PATH         Output merged JSONL. Default: <out basename>.jsonl',
    '  --help               Show this help.'
  ].join('\n'));
}

function dateFromPath(inputPath) {
  const match = path.basename(inputPath).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function dateFromTimestamp(value) {
  const match = String(value || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function messageKey(message) {
  return [
    message.timestamp || '',
    message.role || '',
    message.sender_name || '',
    message.type || '',
    message.text || ''
  ].join('\u001f');
}

function sortMessages(messages) {
  return [...messages].sort((a, b) => {
    const at = a.timestamp || '';
    const bt = b.timestamp || '';
    if (at !== bt) return at.localeCompare(bt);
    return (a.seq || 0) - (b.seq || 0);
  });
}

function reindexMessages(conversationId, messages) {
  return messages.map((message, index) => ({
    ...message,
    message_id: `${conversationId}__msg_${String(index + 1).padStart(4, '0')}`,
    seq: index + 1
  }));
}

function fingerprint(messages) {
  return JSON.stringify(
    messages.map((message) => ({
      timestamp: message.timestamp || '',
      role: message.role || '',
      sender_name: message.sender_name || '',
      type: message.type || '',
      text: message.text || ''
    }))
  );
}

function mergeDateValue(a, b, direction) {
  const values = [a, b].filter(Boolean).sort();
  if (!values.length) return null;
  return direction === 'max' ? values[values.length - 1] : values[0];
}

function mergeCategories(a = [], b = []) {
  return [...new Set([...a, ...b].filter(Boolean))];
}

function mergeMetricRows(a = [], b = []) {
  const seen = new Set();
  const rows = [];
  for (const row of [...a, ...b]) {
    const key = JSON.stringify(row || {});
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function mergeConversation(existing, incoming, sourceDate) {
  if (!existing) {
    const messages = reindexMessages(
      incoming.conversation_id,
      sortMessages(incoming.messages || [])
    );
    const timestamps = messages.map((item) => item.timestamp).filter(Boolean);
    return {
      ...incoming,
      started_at: timestamps[0] || incoming.started_at || null,
      ended_at: timestamps[timestamps.length - 1] || incoming.ended_at || null,
      message_count: messages.length,
      messages,
      source_meta: {
        ...(incoming.source_meta || {}),
        daily_export_dates: [sourceDate].filter(Boolean),
        merged_from_daily_exports: true,
        message_fingerprint: fingerprint(messages)
      }
    };
  }

  const byKey = new Map();
  for (const message of existing.messages || []) {
    byKey.set(messageKey(message), message);
  }
  for (const message of incoming.messages || []) {
    byKey.set(messageKey(message), message);
  }

  const messages = reindexMessages(existing.conversation_id, sortMessages([...byKey.values()]));
  const timestamps = messages.map((item) => item.timestamp).filter(Boolean);
  const existingMeta = existing.source_meta || {};
  const incomingMeta = incoming.source_meta || {};
  const dailyExportDates = mergeCategories(existingMeta.daily_export_dates || [], [sourceDate].filter(Boolean));

  return {
    ...existing,
    customer_name: existing.customer_name || incoming.customer_name,
    source_friend_label: existing.source_friend_label || incoming.source_friend_label,
    started_at: timestamps[0] || mergeDateValue(existing.started_at, incoming.started_at, 'min'),
    ended_at: timestamps[timestamps.length - 1] || mergeDateValue(existing.ended_at, incoming.ended_at, 'max'),
    message_count: messages.length,
    messages,
    source_meta: {
      ...existingMeta,
      message_date_start: mergeDateValue(existingMeta.message_date_start, incomingMeta.message_date_start, 'min') || '',
      message_date_end: mergeDateValue(existingMeta.message_date_end, incomingMeta.message_date_end, 'max') || '',
      filtered_out_message_count:
        Number(existingMeta.filtered_out_message_count || 0) + Number(incomingMeta.filtered_out_message_count || 0),
      total_observed_message_count:
        Number(existingMeta.total_observed_message_count || 0) + Number(incomingMeta.total_observed_message_count || 0),
      source_metric_categories: mergeCategories(
        existingMeta.source_metric_categories || [],
        incomingMeta.source_metric_categories || []
      ),
      metric_rows: mergeMetricRows(existingMeta.metric_rows || [], incomingMeta.metric_rows || []),
      scroll_incomplete: Boolean(existingMeta.scroll_incomplete || incomingMeta.scroll_incomplete),
      scroll_stop_reason: mergeCategories(
        String(existingMeta.scroll_stop_reason || '').split(',').filter(Boolean),
        String(incomingMeta.scroll_stop_reason || '').split(',').filter(Boolean)
      ).join(','),
      daily_export_dates: dailyExportDates,
      merged_from_daily_exports: true,
      message_fingerprint: fingerprint(messages)
    }
  };
}

async function loadConversations(inputPath) {
  if (/\.jsonl$/i.test(inputPath)) {
    return readJsonlRecords(inputPath);
  }
  const text = await fs.readFile(inputPath, 'utf8');
  const json = JSON.parse(text);
  return Array.isArray(json.conversations) ? json.conversations : [];
}

async function loadProgress(inputPath) {
  if (/\.jsonl$/i.test(inputPath)) {
    return { completed_conversation_ids: [], failed_conversation_ids: [] };
  }
  try {
    const text = await fs.readFile(inputPath, 'utf8');
    const json = JSON.parse(text);
    return json.progress || { completed_conversation_ids: [], failed_conversation_ids: [] };
  } catch {
    return { completed_conversation_ids: [], failed_conversation_ids: [] };
  }
}

export async function mergeDailyExports({ inputs, out, jsonl }) {
  if (!inputs.length) {
    throw new Error('at least one --in or --inputs path is required');
  }
  if (!out) {
    throw new Error('--out is required');
  }

  const outputPath = path.resolve(process.cwd(), out);
  const jsonlPath = path.resolve(
    process.cwd(),
    jsonl || path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.jsonl`)
  );
  const resolvedInputs = inputs.map((input) => path.resolve(process.cwd(), input));
  const byConversation = new Map();
  const dailyFailed = new Set();
  const dailyCompleted = new Set();
  const dailySummary = [];

  for (const inputPath of resolvedInputs) {
    const sourceDate = dateFromPath(inputPath);
    const conversations = await loadConversations(inputPath);
    const progress = await loadProgress(inputPath);

    for (const conversationId of progress.completed_conversation_ids || []) {
      dailyCompleted.add(sourceDate ? `${conversationId}__date_${sourceDate}` : conversationId);
    }
    for (const conversationId of progress.failed_conversation_ids || []) {
      dailyFailed.add(sourceDate ? `${conversationId}__date_${sourceDate}` : conversationId);
    }

    for (const conversation of conversations) {
      const conversationDate =
        sourceDate || dateFromTimestamp(conversation.source_meta?.message_date_start) || dateFromTimestamp(conversation.started_at);
      byConversation.set(
        conversation.conversation_id,
        mergeConversation(byConversation.get(conversation.conversation_id), conversation, conversationDate)
      );
    }

    dailySummary.push({
      input_path: inputPath,
      date: sourceDate,
      conversation_count: conversations.length,
      completed_count: (progress.completed_conversation_ids || []).length,
      failed_count: (progress.failed_conversation_ids || []).length
    });
  }

  const dataset = createEmptyDataset();
  dataset.dataset_meta = {
    ...dataset.dataset_meta,
    merged_from_daily_exports: true,
    daily_export_count: resolvedInputs.length,
    daily_exports: dailySummary,
    date_start: dailySummary.map((item) => item.date).filter(Boolean).sort()[0] || '',
    date_end: dailySummary.map((item) => item.date).filter(Boolean).sort().at(-1) || ''
  };
  dataset.conversations = [...byConversation.values()].sort((a, b) => {
    const employeeCompare = String(a.employee_name || '').localeCompare(String(b.employee_name || ''));
    if (employeeCompare !== 0) return employeeCompare;
    return String(a.customer_id || '').localeCompare(String(b.customer_id || ''));
  });
  dataset.progress.completed_conversation_ids = dataset.conversations.map((item) => item.conversation_id);
  const completed = new Set(dataset.progress.completed_conversation_ids);
  dataset.progress.failed_conversation_ids = [
    ...new Set(
      [...dailyFailed].map((id) => String(id).replace(/__date_\d{4}-\d{2}-\d{2}$/, '')).filter((id) => !completed.has(id))
    )
  ];
  dataset.progress.failed_daily_conversation_ids = [...dailyFailed].sort();
  dataset.progress.completed_daily_conversation_ids = [...dailyCompleted].sort();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(dataset, null, 2), 'utf8');
  await fs.rm(jsonlPath, { force: true });
  for (const conversation of dataset.conversations) {
    await appendJsonlRecord(jsonlPath, conversation);
  }

  return {
    event: 'merge-daily-exports-complete',
    outputPath,
    jsonlPath,
    inputs: resolvedInputs.length,
    conversations: dataset.conversations.length,
    failed: dataset.progress.failed_conversation_ids.length,
    failedDaily: dataset.progress.failed_daily_conversation_ids.length
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs();
  if (opts.help || opts.h) {
    showUsage();
    process.exit(0);
  }
  const inputs = [
    ...opts.in,
    ...String(opts.inputs || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  ];
  try {
    const result = await mergeDailyExports({ inputs, out: opts.out, jsonl: opts.jsonl });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message || String(error)}`);
    process.exit(1);
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';

import { createEmptyDataset, upsertDatasetConversation } from './lib/dataset.js';
import { getDefaultCheckpointPath } from './lib/checkpoint.js';
import { readJsonlRecords } from './lib/jsonl-store.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      opts[key] = rest.join('=') || true;
    }
  }
  return opts;
}

function parseCheckpointFromConversationId(conversationId) {
  const parts = String(conversationId || '').split('__');
  return {
    employee_name: parts[0] || null,
    friend_page: Number(parts[1] || '1'),
    friend_index: Number(parts[2] || '-1'),
    conversation_id: conversationId || null,
    updated_at: new Date().toISOString()
  };
}

const opts = parseArgs();

if (opts.help || opts.h) {
  console.error([
    'Usage: node reconcile.js --in=dataset.json [--jsonl=dataset.jsonl] [--checkpoint]',
    '',
    'Reads JSONL records, deduplicates, and writes a final dataset JSON.',
    'Optionally regenerates the checkpoint from the last conversation.',
    '',
    'Options:',
    '  --in=PATH          Path to the existing dataset JSON (will be updated in place)',
    '  --jsonl=PATH       Path to JSONL file (default: derived from --in)',
    '  --checkpoint       Also regenerate the checkpoint file'
  ].join('\n'));
  process.exit(0);
}

const outputPath = path.resolve(process.cwd(), opts.in || process.env.OUTPUT_PATH || 'chat-audit-dataset-v1.json');
const jsonlPath = path.resolve(
  process.cwd(),
  opts.jsonl ||
    process.env.JSONL_PATH ||
    path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.jsonl`)
);
const checkpointPath = path.resolve(
  process.cwd(),
  process.env.CHECKPOINT_PATH || getDefaultCheckpointPath(outputPath)
);

const dataset = createEmptyDataset();
const records = await readJsonlRecords(jsonlPath);

for (const conversation of records) {
  upsertDatasetConversation(dataset, conversation);
}

await fs.writeFile(outputPath, JSON.stringify(dataset, null, 2), 'utf8');

const lastConversationId =
  dataset.progress.completed_conversation_ids[dataset.progress.completed_conversation_ids.length - 1] || null;

if (opts.checkpoint) {
  await fs.writeFile(
    checkpointPath,
    JSON.stringify(parseCheckpointFromConversationId(lastConversationId), null, 2),
    'utf8'
  );
}

console.log(
  JSON.stringify(
    {
      event: 'reconcile-complete',
      outputPath,
      jsonlPath,
      checkpointPath,
      conversations: dataset.conversations.length,
      lastConversationId
    },
    null,
    2
  )
);

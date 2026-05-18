function normalizeText(value) {
  return (value || '').replace(/\r/g, '').trim();
}

function inferRole(direction) {
  return direction === 'right' ? 'official' : 'customer';
}

function extractCustomerName(friendLabel) {
  return normalizeText((friendLabel || '').split('|')[0]);
}

function createAttachmentBuckets() {
  return {
    images: [],
    links: [],
    weapp_cards: [],
    files: [],
    videos: []
  };
}

function isWeappIconUrl(url) {
  return /wx\.qlogo\.cn\/mmhead/i.test(url || '');
}

function extractWeappCard(message, attachments) {
  if (normalizeText(message.type) !== 'weapp') {
    return null;
  }

  const lines = normalizeText(message.text)
    .split('\n')
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .filter((item) => item !== '小程序');

  return {
    app_name: lines[0] || '',
    title: lines[1] || '',
    description: lines.slice(2).join('\n'),
    preview_image_url: attachments.images[0]?.url || '',
    link_url: attachments.links[0]?.url || ''
  };
}

function extractAttachments(message) {
  const attachments = createAttachmentBuckets();

  for (const image of message.images || []) {
    if (normalizeText(message.type) === 'weapp' && isWeappIconUrl(image.src || '')) {
      continue;
    }
    attachments.images.push({
      url: image.src || '',
      alt: image.alt || ''
    });
  }

  for (const video of message.videos || []) {
    attachments.videos.push({
      url: video.src || '',
      poster: video.poster || ''
    });
  }

  // Video fallback: WeChat Work renders videos as <img> posters (no <video> tag).
  // When type=video and no <video> elements found, use the cover images as video URLs.
  if (attachments.videos.length === 0 && normalizeText(message.type) === 'video' && attachments.images.length > 0) {
    const playButtonSvg = /data:image\/svg/i;
    for (const img of [...attachments.images]) {
      if (playButtonSvg.test(img.url)) continue; // skip play button SVG
      attachments.videos.push({ url: img.url, poster: img.url });
    }
  }

  for (const link of message.links || []) {
    attachments.links.push({
      url: link.href || '',
      text: link.text || ''
    });
  }

  const weappCard = extractWeappCard(message, attachments);
  if (weappCard) {
    attachments.weapp_cards.push(weappCard);
  }

  return attachments;
}

function buildMessageId(conversationId, seq) {
  return `${conversationId}__msg_${String(seq).padStart(4, '0')}`;
}

function buildConversationFingerprint(messages) {
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

export function createEmptyDataset() {
  return {
    dataset_meta: {
      name: 'chat_audit_dataset_v1',
      version: '2026-03-30',
      source: 'tmscrm.yishouapp.com',
      language: 'zh-CN',
      exported_at: new Date().toISOString(),
      target_conversation_count: 2000
    },
    progress: {
      completed_conversation_ids: [],
      failed_conversation_ids: []
    },
    conversations: []
  };
}

export function upsertDatasetConversation(dataset, conversation) {
  const index = dataset.conversations.findIndex(
    (item) => item.conversation_id === conversation.conversation_id
  );

  if (index >= 0) {
    dataset.conversations[index] = conversation;
  } else {
    dataset.conversations.push(conversation);
  }

  if (!dataset.progress.completed_conversation_ids.includes(conversation.conversation_id)) {
    dataset.progress.completed_conversation_ids.push(conversation.conversation_id);
  }

  dataset.dataset_meta.exported_at = new Date().toISOString();
}

export function convertConversationToDataset({
  conversationId,
  employee,
  friendLabel,
  friendPage,
  customerId = null,
  sourceCustomerInfo = '',
  sourceMetricCategories = [],
  metricRows = [],
  messageDateStart = '',
  messageDateEnd = '',
  filteredOutMessageCount = 0,
  scrollStopReason = '',
  scrollIncomplete = false,
  totalObservedMessageCount = null,
  messages
}) {
  const normalizedMessages = messages.map((message, index) => ({
    message_id: buildMessageId(conversationId, index + 1),
    seq: index + 1,
    timestamp: normalizeText(message.time),
    role: inferRole(message.direction),
    sender_name: normalizeText(message.sender),
    type: normalizeText(message.type || 'unknown'),
    text: normalizeText(message.text),
    raw_html: message.html || '',
    attachments: extractAttachments(message),
    meta: {
      direction: message.direction || '',
      source_type: message.type || '',
      has_rich_content: Boolean(
        (message.images || []).length ||
          (message.videos || []).length ||
          (message.links || []).length ||
          normalizeText(message.type) === 'weapp'
      )
    }
  }));

  const timestamps = normalizedMessages
    .map((item) => item.timestamp)
    .filter(Boolean);

  return {
    conversation_id: conversationId,
    employee_id: null,
    employee_name: normalizeText(employee.employeeName),
    customer_id: customerId || null,
    customer_name: extractCustomerName(friendLabel),
    source_friend_label: friendLabel,
    source_friend_page: friendPage,
    started_at: timestamps[0] || null,
    ended_at: timestamps[timestamps.length - 1] || null,
    message_count: normalizedMessages.length,
    messages: normalizedMessages,
    labels: {},
    source_meta: {
      department: normalizeText(employee.department),
      friend_count: normalizeText(employee.friendCount),
      last_chat_at: normalizeText(employee.lastChatAt),
      customer_id: customerId || null,
      source_customer_info: normalizeText(sourceCustomerInfo),
      source_metric_categories: sourceMetricCategories,
      metric_rows: metricRows,
      message_date_start: normalizeText(messageDateStart),
      message_date_end: normalizeText(messageDateEnd),
      filtered_out_message_count: filteredOutMessageCount,
      scroll_stop_reason: normalizeText(scrollStopReason),
      scroll_incomplete: Boolean(scrollIncomplete),
      total_observed_message_count: totalObservedMessageCount,
      message_fingerprint: buildConversationFingerprint(normalizedMessages)
    }
  };
}
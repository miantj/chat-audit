const LOADING_TEXT = '消息内容正在加载';

function normalizeValue(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

export function messageContainsLoadingPlaceholder(message) {
  return [message?.text, message?.html, message?.sender, message?.time].some((value) =>
    normalizeValue(value).includes(LOADING_TEXT)
  );
}

export function conversationHasLoadingPlaceholder(messages) {
  return (messages || []).some((message) => messageContainsLoadingPlaceholder(message));
}

export function conversationHasMeaningfulContent(messages) {
  return (messages || []).some((message) => {
    const text = normalizeValue(message?.text);
    const html = normalizeValue(message?.html);
    const hasAttachment = Boolean((message?.images || []).length || (message?.links || []).length);
    return Boolean(text || html || hasAttachment);
  });
}

function buildMessageFingerprint(message) {
  return JSON.stringify({
    direction: normalizeValue(message?.direction),
    type: normalizeValue(message?.type),
    sender: normalizeValue(message?.sender),
    time: normalizeValue(message?.time),
    text: normalizeValue(message?.text),
    html: normalizeValue(message?.html)
  });
}

export function buildConversationFingerprint(messages) {
  return JSON.stringify({
    count: messages?.length || 0,
    first: messages?.[0] ? buildMessageFingerprint(messages[0]) : null,
    last: messages?.length ? buildMessageFingerprint(messages[messages.length - 1]) : null
  });
}

export function isConversationReady(messages) {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    conversationHasMeaningfulContent(messages) &&
    !conversationHasLoadingPlaceholder(messages)
  );
}

export function shouldPersistSnapshot({ previousFingerprint, currentMessages }) {
  const currentFingerprint = buildConversationFingerprint(currentMessages);
  return {
    currentFingerprint,
    ready: isConversationReady(currentMessages),
    stable: Boolean(previousFingerprint) && previousFingerprint === currentFingerprint
  };
}


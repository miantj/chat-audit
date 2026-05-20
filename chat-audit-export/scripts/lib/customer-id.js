/**
 * 从 CRM「客户信息」列解析客户 ID，并生成外部好友搜索词。
 * 常见坑：昵称/地名里嵌入短数字（如 广场1186、。1989）不是探马好友 ID；
 * 应优先 +号后 ID、空格/连字符分隔的 5–8 位数字。
 */

export const FAILED_CONVERSATION_MARKER = '__customer_';

/** @returns {{ employeeName: string, customerPart: string } | null} */
export function parseFailedConversationId(conversationId) {
  const text = String(conversationId || '');
  const idx = text.indexOf(FAILED_CONVERSATION_MARKER);
  if (idx < 0) return null;
  return {
    employeeName: text.slice(0, idx),
    customerPart: text.slice(idx + FAILED_CONVERSATION_MARKER.length)
  };
}

/** @returns {string[]} 去重，保持发现顺序 */
export function extractAllCustomerIds(customerInfoText) {
  const text = String(customerInfoText || '').trim();
  if (!text) return [];

  const ordered = [];
  const seen = new Set();
  const push = (id) => {
    const s = String(id || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    ordered.push(s);
  };

  for (const m of text.matchAll(/[+＋]\s*(\d{4,8})(?!\d)/g)) {
    push(m[1]);
  }
  for (const m of text.matchAll(/(?:^|[\s\-_／/（(【\[])(\d{5,8})(?!\d)/g)) {
    push(m[1]);
  }
  for (const m of text.matchAll(/(^|\D)(\d{4,8})(?!\d)/g)) {
    push(m[2]);
  }
  return ordered;
}

function scoreCustomerIdCandidate(id, text) {
  let score = Number(id.length) * 10;
  if (/[+＋]\s*$/.test(text.slice(0, text.indexOf(id) + id.length))) {
    score += 80;
  }
  if (new RegExp(`(?:^|[\\s\\-_/（(【\\[])${id}(?:[\\-－_／/\\s）)】\\]]|$)`).test(text)) {
    score += 50;
  }
  if (new RegExp(`${id}\\s*[-－_／/]`).test(text)) {
    score += 40;
  }
  if (id.length <= 4) {
    score -= 35;
  }
  if (new RegExp(`[A-Za-z\u4e00-\u9fff]${id}(?![\\d])`).test(text)) {
    score -= 30;
  }
  return score;
}

export function extractCustomerId(customerInfoText) {
  const text = String(customerInfoText || '').trim();
  if (!text) return '';

  const plusMatch = text.match(/[+＋]\s*(\d{4,8})(?!\d)/);
  if (plusMatch) return plusMatch[1];

  const candidates = extractAllCustomerIds(text);
  if (candidates.length === 0) return '';
  if (candidates.length === 1) return candidates[0];

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const id of candidates) {
    const s = scoreCustomerIdCandidate(id, text);
    if (s > bestScore) {
      bestScore = s;
      best = id;
    }
  }
  return best;
}

/** 搜索词：主 ID 优先，其余候选 ID 用于主词未命中时回退 */
export function extractCustomerSearchTerms(customerInfoText, customerId = '') {
  const primary = String(customerId || '').trim() || extractCustomerId(customerInfoText);
  const terms = [];
  const seen = new Set();
  const push = (t) => {
    const s = String(t || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    terms.push(s);
  };

  push(primary);
  for (const id of extractAllCustomerIds(customerInfoText)) {
    push(id);
  }
  return terms;
}

/** 导出成功后，移除 failed 中与本次 customerInfo 关联的旧版错误 ID */
export function pruneFailedConversationIdsForSuccess(
  failedConversationIds,
  employeeName,
  customerId,
  customerInfoText = ''
) {
  if (!Array.isArray(failedConversationIds)) {
    return [];
  }
  const resolvedIds = new Set(
    [String(customerId || '').trim(), ...extractAllCustomerIds(customerInfoText)].filter(
      Boolean
    )
  );
  return failedConversationIds.filter((failedId) => {
    const parsed = parseFailedConversationId(failedId);
    if (!parsed) {
      return true;
    }
    if (parsed.employeeName !== String(employeeName)) {
      return true;
    }
    return !resolvedIds.has(parsed.customerPart);
  });
}

export function isRetryConversationTarget(
  failedConversationIds,
  employeeName,
  customerId,
  customerInfoText = ''
) {
  if (!Array.isArray(failedConversationIds) || failedConversationIds.length === 0) {
    return false;
  }
  const convId = `${employeeName}${FAILED_CONVERSATION_MARKER}${customerId}`;
  if (failedConversationIds.includes(convId)) {
    return true;
  }
  const infoIds = extractAllCustomerIds(customerInfoText);
  return failedConversationIds.some((failedId) => {
    const parsed = parseFailedConversationId(failedId);
    if (!parsed || parsed.employeeName !== String(employeeName)) {
      return false;
    }
    return (
      parsed.customerPart === String(customerId) || infoIds.includes(parsed.customerPart)
    );
  });
}

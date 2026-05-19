export function extractCustomerId(customerInfoText) {
  const text = String(customerInfoText || '').trim();
  if (!text) return '';

  const plusMatch = text.match(/[+＋]\s*(\d{4,8})(?!\d)/);
  if (plusMatch) return plusMatch[1];

  const standaloneMatch = text.match(/(^|\D)(\d{4,8})(?!\d)/);
  return standaloneMatch ? standaloneMatch[2] : '';
}

/** Skill：外部好友搜索仅用客户 ID（不用中文昵称，避免误匹配） */
export function extractCustomerSearchTerms(_customerInfoText, customerId = '') {
  const id = String(customerId || '').trim();
  return id ? [id] : [];
}

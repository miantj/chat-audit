export function extractCustomerId(customerInfoText) {
  const text = String(customerInfoText || '').trim();
  if (!text) return '';

  const plusMatch = text.match(/[+＋]\s*(\d{4,8})(?!\d)/);
  if (plusMatch) return plusMatch[1];

  const standaloneMatch = text.match(/(^|\D)(\d{4,8})(?!\d)/);
  return standaloneMatch ? standaloneMatch[2] : '';
}

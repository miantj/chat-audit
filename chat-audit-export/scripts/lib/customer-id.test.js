import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAllCustomerIds,
  extractCustomerId,
  extractCustomerSearchTerms,
  isRetryConversationTarget
} from './customer-id.js';

test('extracts customer id after plus sign', () => {
  assert.equal(extractCustomerId('大客+5255314-有活动找+SOUL'), '5255314');
});

test('extracts first standalone numeric id when no plus sign exists', () => {
  assert.equal(extractCustomerId('依卡儿女装·婷婷 1288724'), '1288724');
});

test('returns empty string when no customer id exists', () => {
  assert.equal(extractCustomerId('没有数字的客户信息'), '');
});

test('ignores phone-like numbers before customer id', () => {
  assert.equal(extractCustomerId('崔阳13942243120 1671584'), '1671584');
});

test('prefers spaced long id over nickname-embedded short id (168888 case)', () => {
  assert.equal(extractCustomerId('pcs168888 17765527另一个微信'), '17765527');
});

test('prefers long id over 4-digit suffix (0318 / 鸭鸭 case)', () => {
  assert.equal(extractCustomerId('0318 12737275-小熊空标女'), '12737275');
});

test('prefers trailing id over nickname suffix (1989 case)', () => {
  assert.equal(extractCustomerId('妞。1989 售后无补偿-2230889'), '2230889');
});

test('prefers hyphenated id over address suffix (1186 case)', () => {
  assert.equal(extractCustomerId('小慧家地下广场1186 3330374-喊小慧-描述'), '3330374');
});

test('extractCustomerSearchTerms includes fallback ids', () => {
  assert.deepEqual(extractCustomerSearchTerms('pcs168888 17765527另一个微信', '17765527'), [
    '17765527',
    '168888'
  ]);
});

test('isRetryConversationTarget matches corrected id to legacy failed id', () => {
  const failed = ['一手专属VIP客服-Miumiu__customer_168888'];
  assert.equal(
    isRetryConversationTarget(
      failed,
      '一手专属VIP客服-Miumiu',
      '17765527',
      'pcs168888 17765527另一个微信'
    ),
    true
  );
});

test('isRetryConversationTarget rejects unrelated employee', () => {
  const failed = ['一手专属VIP客服-Miumiu__customer_168888'];
  assert.equal(
    isRetryConversationTarget(failed, '一手专属VIP客服-提莫', '1999', 'foo 3044842'),
    false
  );
});

test('isRetryConversationTarget returns false for empty failed list', () => {
  assert.equal(
    isRetryConversationTarget([], '一手专属VIP客服-Miumiu', '17765527', 'pcs168888 17765527'),
    false
  );
});

test('extractAllCustomerIds collects multiple candidates', () => {
  assert.deepEqual(
    new Set(extractAllCustomerIds('pcs168888 17765527另一个微信')),
    new Set(['168888', '17765527'])
  );
});

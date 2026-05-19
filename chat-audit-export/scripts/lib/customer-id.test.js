import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCustomerId, extractCustomerSearchTerms } from './customer-id.js';

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

test('extractCustomerSearchTerms uses customer id only', () => {
  assert.deepEqual(extractCustomerSearchTerms('大客+5255314-有活动找+SOUL', '5255314'), ['5255314']);
  assert.deepEqual(extractCustomerSearchTerms('菲菲 401230-菲菲姐', '401230'), ['401230']);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTargetListSearchExport,
  shouldScheduleFailedRetry
} from './failed-retry-meta.mjs';

test('search target-list disables failed retry scheduling', () => {
  const opts = {
    targetsFile: '/tmp/list.xlsx',
    targetListStrategy: 'search'
  };
  assert.equal(isTargetListSearchExport(opts), true);
  assert.equal(shouldScheduleFailedRetry(opts), false);
});

test('visible target-list keeps failed retry scheduling', () => {
  const opts = {
    targetsFile: '/tmp/list.xlsx',
    targetListStrategy: 'visible'
  };
  assert.equal(isTargetListSearchExport(opts), false);
  assert.equal(shouldScheduleFailedRetry(opts), true);
});

test('metric export keeps failed retry scheduling', () => {
  assert.equal(shouldScheduleFailedRetry({}), true);
});

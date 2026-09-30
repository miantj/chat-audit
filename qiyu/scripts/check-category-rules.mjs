#!/usr/bin/env node
import assert from 'node:assert/strict';
import { CATEGORY_RULES, resolveCategory, thirdCategory } from './lib/category-rules.mjs';

assert.equal(CATEGORY_RULES.length, 68);
assert.equal(resolveCategory('', '售前/商品详情咨询/款式咨询').category, '款式咨询');
assert.equal(resolveCategory('', '售前/商品详情咨询').category, '');
assert.equal(thirdCategory('售前/商品详情咨询/款式咨询/四级'), '款式咨询');
assert.equal(thirdCategory('售前/商品详情咨询'), '');
for (const [question, expected] of [
  ['直播间优惠券怎么用', '直播活动咨询'],
  ['批量拿货能便宜吗', '价格咨询'],
  ['同款两个售价为什么不一样', '价格咨询'],
  ['铺货到淘宝失败了', '铺货失败'],
  ['订单物流没有同步', '物流信息同步'],
  ['童装宝宝90码穿多大', '童装尺码咨询'],
  ['价格上涨了', '价格咨询'],
  ['加价规则', '价格咨询'],
  ['童装优惠多少', '童装价格咨询'],
  ['有黑色吗', '颜色咨询'],
  ['比档口贵', '价格咨询'],
  ['这个多少钱', '价格咨询'],
  ['包邮吗', '运费收取规则'],
  ['想合作', '合作意向'],
  ['推荐个商家合作', '推荐合作'],
  ['童装多少钱', '童装价格咨询']
]) {
  assert.equal(resolveCategory(question, '原分类').category, expected, question);
}
console.log('category rules ok');

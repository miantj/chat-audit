#!/usr/bin/env node
/**
 * 按文档「11. 分类」关键词，核对七鱼导出「咨询分类」是否合理
 *   node scripts/check-category.mjs
 *   node scripts/check-category.mjs --in exports/xxx.xlsx
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byHeader, latestXlsx, parseSheet } from './lib/xlsx.mjs';
import { scoreCategories as scoreText } from './lib/category-rules.mjs';
import { parseContent } from './to-register.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function leafOf(categoryPath) {
  const parts = String(categoryPath || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[parts.length - 1] || '';
}

function main() {
  const inFile = path.resolve(arg('--in', latestXlsx(path.join(ROOT, 'exports'))));
  const { hdr, rows } = parseSheet(inFile);

  const results = [];
  let judged = 0;
  let match = 0;
  let mismatch = 0;
  let weak = 0; // 关键词命中不足
  const mismatchSamples = [];
  const multiIntent = [];

  for (const row of rows) {
    const sessionId = byHeader(hdr, row, '会话ID');
    const qiyuCat = byHeader(hdr, row, '咨询分类');
    const qiyuLeaf =
      byHeader(hdr, row, '三级分类') || leafOf(qiyuCat);
    const userId =
      byHeader(hdr, row, '用户唯一标识') || byHeader(hdr, row, '访客用户名');
    const content = byHeader(hdr, row, '会话内容');
    const question = parseContent(
      content,
      userId,
      byHeader(hdr, row, '访客用户名')
    ).userQuestion;
    const scores = scoreText(question);
    const top = scores[0];
    const second = scores[1];

    const item = {
      sessionId,
      qiyuCat,
      qiyuLeaf,
      question: question.slice(0, 120),
      top: top?.name,
      topScore: top?.score || 0,
      topHits: top?.hits || [],
      second: second?.name,
      secondScore: second?.score || 0
    };

    if (!question || !top || top.score <= 0) {
      weak++;
      item.verdict = '无关键词可判';
      results.push(item);
      continue;
    }

    judged++;
    const ok =
      qiyuLeaf === top.name ||
      qiyuCat.includes(top.name) ||
      // 七鱼叶子是「尺码咨询」文档也是「尺码咨询」
      leafOf(qiyuCat) === top.name;

    if (ok) {
      match++;
      item.verdict = '一致';
    } else {
      mismatch++;
      item.verdict = '不一致';
      if (mismatchSamples.length < 25) mismatchSamples.push(item);
    }

    // 一会话多意图：第二名也明显命中，且与七鱼叶子不同
    if (
      second.score >= 2 &&
      second.score >= top.score * 0.6 &&
      second.name !== qiyuLeaf &&
      top.name !== second.name
    ) {
      multiIntent.push({
        sessionId,
        qiyuLeaf,
        top: `${top.name}(${top.score})`,
        second: `${second.name}(${second.score})`,
        question: question.slice(0, 80)
      });
    }

    results.push(item);
  }

  const report = {
    source: inFile,
    total: rows.length,
    judged,
    match,
    mismatch,
    weak,
    accuracy_among_judged:
      judged > 0 ? Number(((match / judged) * 100).toFixed(1)) : null,
    note:
      '规则来自文档「11. 分类」关键词（商详相关叶子）；仅用访客「用户问题」文本打分，未看图/视频。命中分=0 记为「无关键词可判」，不计入准确率分母。',
    mismatchSamples,
    multiIntentSamples: multiIntent.slice(0, 15)
  };

  const outJson = path.join(ROOT, 'exports', '分类核对报告.json');
  const outCsv = path.join(ROOT, 'exports', '分类核对明细.csv');
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2), 'utf8');

  const cols = [
    'sessionId',
    'verdict',
    'qiyuLeaf',
    'top',
    'topScore',
    'second',
    'secondScore',
    'qiyuCat',
    'question'
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(
    outCsv,
    '\uFEFF' +
      [cols.join(',')]
        .concat(results.map((r) => cols.map((c) => esc(r[c])).join(',')))
        .join('\n'),
    'utf8'
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        total: report.total,
        judged: report.judged,
        match: report.match,
        mismatch: report.mismatch,
        weak: report.weak,
        accuracy_among_judged: report.accuracy_among_judged,
        report: outJson,
        detail: outCsv,
        mismatchPreview: mismatchSamples.slice(0, 8).map((x) => ({
          sessionId: x.sessionId,
          qiyu: x.qiyuLeaf,
          docSuggest: x.top,
          hits: x.topHits,
          q: x.question
        }))
      },
      null,
      2
    )
  );
}

main();

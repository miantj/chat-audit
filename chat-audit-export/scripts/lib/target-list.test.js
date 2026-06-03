import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadTargetList, normalizeOwnerName, resolvePythonCommand } from './target-list.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chat-audit-target-list-'));
}

test('resolvePythonCommand prefers CHAT_AUDIT_PYTHON_BIN', () => {
  const prev = process.env.CHAT_AUDIT_PYTHON_BIN;
  process.env.CHAT_AUDIT_PYTHON_BIN = '/custom/python';
  try {
    assert.equal(resolvePythonCommand(), '/custom/python');
  } finally {
    if (prev === undefined) delete process.env.CHAT_AUDIT_PYTHON_BIN;
    else process.env.CHAT_AUDIT_PYTHON_BIN = prev;
  }
});

test('resolvePythonCommand uses python on win32', () => {
  const prev = process.env.CHAT_AUDIT_PYTHON_BIN;
  delete process.env.CHAT_AUDIT_PYTHON_BIN;
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(resolvePythonCommand(), 'python');
  } finally {
    Object.defineProperty(process, 'platform', { value: platform });
    if (prev !== undefined) process.env.CHAT_AUDIT_PYTHON_BIN = prev;
  }
});

test('normalizes owner names without using fuzzy contains matching', () => {
  assert.equal(normalizeOwnerName('一手专属 VIP 客服-鸭鸭'), normalizeOwnerName('一手专属VIP客服-鸭鸭'));
  assert.notEqual(normalizeOwnerName('一手专属VIP客服-乔巴'), normalizeOwnerName('一手专属VIP客服-乔巴new'));
});

test('loads target pairs from csv with BOM, skips blanks, and dedupes', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'targets.csv');
  fs.writeFileSync(
    file,
    '\ufeff外部客户ID,负责人\n6913516,一手专属VIP客服-KK\n6913516,一手专属VIP客服-KK\n,一手专属VIP客服-KK\n16953160, 一手专属 VIP 客服-鸭鸭 \n',
    'utf8'
  );

  const list = await loadTargetList(file);
  assert.equal(list.targetCount, 2);
  assert.equal(list.ownerCount, 2);
  assert.equal(list.duplicateRows.length, 1);
  assert.equal(list.skippedRows.length, 1);
  assert.deepEqual(
    list.targets.map((target) => [target.customerId, target.ownerName.trim()]),
    [
      ['6913516', '一手专属VIP客服-KK'],
      ['16953160', '一手专属 VIP 客服-鸭鸭']
    ]
  );
});

test('loads target pairs from xlsx first sheet', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'targets.xlsx');
  execFileSync('python3', ['-c', `
import os, zipfile
file_path = ${JSON.stringify(file)}
os.makedirs(os.path.dirname(file_path), exist_ok=True)
files = {
  '[Content_Types].xml': '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>''',
  '_rels/.rels': '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>''',
  'xl/workbook.xml': '''<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>''',
  'xl/_rels/workbook.xml.rels': '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>''',
  'xl/worksheets/sheet1.xml': '''<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>外部客户ID</t></is></c><c r="B1" t="inlineStr"><is><t>负责人</t></is></c></row>
    <row r="2"><c r="A2"><v>6913516</v></c><c r="B2" t="inlineStr"><is><t>一手专属VIP客服-KK</t></is></c></row>
    <row r="3"><c r="A3"><v>16953160</v></c><c r="B3" t="inlineStr"><is><t>一手专属VIP客服-鸭鸭</t></is></c></row>
  </sheetData>
</worksheet>'''
}
with zipfile.ZipFile(file_path, 'w') as z:
    for name, content in files.items():
        z.writestr(name, content)
`]);

  const list = await loadTargetList(file);
  assert.equal(list.sheetName, 'Sheet1');
  assert.equal(list.targetCount, 2);
  assert.deepEqual(list.targets.map((target) => target.customerId), ['6913516', '16953160']);
});

test('fails clearly when required columns are missing', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'bad.csv');
  fs.writeFileSync(file, '客户,人员\n6913516,KK\n', 'utf8');

  await assert.rejects(
    () => loadTargetList(file),
    /missing owner column|missing customer ID column/
  );
});

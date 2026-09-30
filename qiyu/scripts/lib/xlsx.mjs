import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export function latestXlsx(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$'))
    .map((f) => ({ f, t: fs.statSync(`${dir}/${f}`).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error('exports/ 下没有 xlsx');
  return `${dir}/${files[0].f}`;
}

export function byHeader(hdr, row, name) {
  const letter = Object.keys(hdr).find((key) => hdr[key] === name);
  return letter ? row[letter] || '' : '';
}

export function parseSheet(xlsxPath) {
  const py = `
import xml.etree.ElementTree as ET, zipfile, re, sys, json
ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as z:
    data = z.read('xl/worksheets/sheet1.xml')
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        sroot = ET.fromstring(z.read('xl/sharedStrings.xml'))
        shared = [
            ''.join((t.text or '') for t in si.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'))
            for si in sroot.findall('m:si', ns)
        ]
root = ET.fromstring(data)

def cell_text(c):
    is_el = c.find('m:is', ns)
    if is_el is not None:
        return ''.join((t.text or '') for t in is_el.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'))
    v = c.find('m:v', ns)
    if v is None or not v.text:
        return ''
    return shared[int(v.text)] if c.get('t') == 's' else v.text

def col(ref):
    return re.match(r'([A-Z]+)', ref).group(1)

rows = root.findall('m:sheetData/m:row', ns)
hdr = {col(c.get('r')): cell_text(c) for c in rows[0].findall('m:c', ns)}
out = []
for row in rows[1:]:
    out.append({col(c.get('r')): cell_text(c) for c in row.findall('m:c', ns)})
print(json.dumps({'hdr': hdr, 'rows': out}, ensure_ascii=False))
`;
  const result = spawnSync('python3', ['-c', py, xlsxPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(result.stderr || 'parse failed');
  const parsed = JSON.parse(result.stdout);
  if (!Object.keys(parsed.hdr || {}).length) throw new Error('xlsx 没有表头');
  return parsed;
}

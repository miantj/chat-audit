#!/usr/bin/env node
/**
 * 方案 A：下载 Node 官方二进制 + PyInstaller 打包 crm-preflight
 * 输出到 electron/runtime/（打包时打入 extraResources/runtime）
 *
 * 用法：
 *   node scripts/prepare-runtime.cjs           # 当前平台
 *   node scripts/prepare-runtime.cjs --all     # darwin/win 常用架构（耗时长）
 *   node scripts/prepare-runtime.cjs --force   # 强制重新下载
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');

const NODE_VERSION = '22.14.0';
const ELECTRON_ROOT = path.join(__dirname, '..');
const RUNTIME_ROOT = path.join(ELECTRON_ROOT, 'runtime');
const REPO_ROOT = path.join(ELECTRON_ROOT, '..');
const PREFLIGHT_PY = path.join(
  REPO_ROOT,
  'chat-audit-export',
  'scripts',
  'crm-preflight.py'
);

const force = process.argv.includes('--force');
const buildAll = process.argv.includes('--all');

const TARGETS = buildAll
  ? [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['win32', 'x64']
    ]
  : [[process.platform, process.arch]];

function log(msg) {
  console.log(`[prepare-runtime] ${msg}`);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const getter = url.startsWith('https') ? https.get : http.get;
    getter(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function nodeDist(platform, arch) {
  const os = platform === 'darwin' ? 'darwin' : 'win32';
  const ext = platform === 'win32' ? 'zip' : 'tar.xz';
  const folder = `node-v${NODE_VERSION}-${os}-${arch}`;
  const file = `${folder}.${ext}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${file}`;
  return { url, file, folder, ext };
}

async function ensureNode(platform, arch) {
  const destName = `node-${platform}-${arch}`;
  const destDir = path.join(RUNTIME_ROOT, destName);
  const nodeBin =
    platform === 'win32'
      ? path.join(destDir, 'bin', 'node.exe')
      : path.join(destDir, 'bin', 'node');
  if (!force && fs.existsSync(nodeBin)) {
    log(`Node 已存在: ${destName}`);
    return;
  }

  const { url, file, folder, ext } = nodeDist(platform, arch);
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  const archivePath = path.join(RUNTIME_ROOT, file);

  log(`下载 Node ${NODE_VERSION} ${platform}-${arch}…`);
  await download(url, archivePath);

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  if (ext === 'zip') {
    execSync(
      `unzip -q -o "${archivePath}" -d "${RUNTIME_ROOT}"`,
      { stdio: 'inherit' }
    );
    const extracted = path.join(RUNTIME_ROOT, folder);
    fs.renameSync(extracted, destDir);
  } else {
    execSync(`tar -xJf "${archivePath}" -C "${RUNTIME_ROOT}"`, {
      stdio: 'inherit'
    });
    const extracted = path.join(RUNTIME_ROOT, folder);
    fs.renameSync(extracted, destDir);
  }

  fs.unlinkSync(archivePath);
  if (!fs.existsSync(nodeBin)) {
    throw new Error(`Node 解压后未找到: ${nodeBin}`);
  }
  log(`Node 就绪: ${nodeBin}`);
}

function hasPyInstaller() {
  try {
    execSync('pyinstaller --version', { stdio: 'pipe' });
    return true;
  } catch {
    try {
      execSync('python3 -m PyInstaller --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

function pyinstallerCmd() {
  try {
    execSync('pyinstaller --version', { stdio: 'pipe' });
    return 'pyinstaller';
  } catch {
    return 'python3 -m PyInstaller';
  }
}

function ensurePreflight(platform, arch) {
  const destDir = path.join(RUNTIME_ROOT, `python-${platform}-${arch}`);
  const outName = platform === 'win32' ? 'crm-preflight.exe' : 'crm-preflight';
  const outPath = path.join(destDir, outName);

  if (!force && fs.existsSync(outPath)) {
    log(`crm-preflight 已存在: ${outPath}`);
    return;
  }

  if (platform !== process.platform || arch !== process.arch) {
    log(`跳过跨平台 PyInstaller（需在 ${platform}-${arch} 机器上构建）: ${outName}`);
    return;
  }

  if (!fs.existsSync(PREFLIGHT_PY)) {
    throw new Error(`找不到 ${PREFLIGHT_PY}`);
  }

  if (!hasPyInstaller()) {
    log('未安装 PyInstaller，跳过 crm-preflight 打包（请 pip install pyinstaller websockets）');
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const buildDir = path.join(RUNTIME_ROOT, '.pyinstaller-build');
  const distDir = path.join(buildDir, 'dist');
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }

  log('PyInstaller 打包 crm-preflight…');
  const cmd = `${pyinstallerCmd()} --onefile --name crm-preflight --distpath "${distDir}" --workpath "${path.join(buildDir, 'work')}" --specpath "${buildDir}" --clean "${PREFLIGHT_PY}"`;
  execSync(cmd, {
    stdio: 'inherit',
    cwd: path.dirname(PREFLIGHT_PY),
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1'
    }
  });

  const built = path.join(distDir, outName);
  if (!fs.existsSync(built)) {
    throw new Error(`PyInstaller 未生成 ${built}`);
  }
  fs.copyFileSync(built, outPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(outPath, 0o755);
  }
  fs.rmSync(buildDir, { recursive: true, force: true });
  log(`crm-preflight 就绪: ${outPath}`);
}

async function main() {
  log(`runtime 目录: ${RUNTIME_ROOT}`);
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });

  for (const [platform, arch] of TARGETS) {
    if (platform === 'darwin' && arch === 'ia32') {
      continue;
    }
    if (platform === 'win32' && arch !== 'x64') {
      log(`跳过 win32-${arch}（仅支持 x64）`);
      continue;
    }
    await ensureNode(platform, arch);
    ensurePreflight(platform, arch);
  }

  log('完成。打包前请执行: cd electron && pnpm run build / build:mac');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

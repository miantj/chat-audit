/**
 * 本地打包后通过 GitLab API 上传 dist 产物到 GitLab Release。
 * 用法：
 *   node scripts/run-release.cjs --mac
 *   node scripts/run-release.cjs --mac --upload-only
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const electronDir = path.join(__dirname, "..");
const envPath = path.join(electronDir, ".env");
const pkgPath = path.join(electronDir, "package.json");
const distDir = path.join(electronDir, "dist");

const LARGE_FILE_EXTS = new Set([".dmg", ".exe", ".zip"]);
const SMALL_FILE_EXTS = new Set([".yml", ".blockmap"]);

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(envPath);

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const gitlabBaseUrl = (process.env.GITLAB_BASE_URL || "http://gitlab.yishou.com").replace(/\/$/, "");
const projectId = process.env.GITLAB_PROJECT_ID || "yishou-front/chat-audit-export";
const packageName = process.env.GITLAB_PACKAGE_NAME || "chat-audit-export";
const packageVersion = process.env.GITLAB_PACKAGE_VERSION || pkg.version;
const tagName = process.env.GITLAB_RELEASE_TAG || `v${pkg.version}`;
const releaseRef = process.env.GITLAB_RELEASE_REF || "main";
const releaseName = process.env.GITLAB_RELEASE_NAME || `${pkg.productName || pkg.name} ${tagName}`;

if (!process.env.GITLAB_TOKEN) {
  console.error(
    "[release] 缺少 GITLAB_TOKEN。请复制 .env.example 为 .env 并填入 Token："
  );
  console.error("  cp .env.example .env");
  console.error(
    "  https://gitlab.yishou.com/-/user_settings/personal_access_tokens"
  );
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const uploadOnly = rawArgs.includes("--upload-only");
const builderArgs = rawArgs.filter((arg) => arg !== "--upload-only");

if (builderArgs.length === 0) {
  console.error("[release] 请传入打包平台参数，例如 --mac 或 --win --x64");
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: electronDir,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function detectPlatform(args) {
  if (args.includes("--mac")) return "mac";
  if (args.includes("--win")) return "win";
  return null;
}

function collectArtifacts(platform) {
  if (!fs.existsSync(distDir)) return [];

  const names = fs.readdirSync(distDir);
  if (platform === "mac") {
    return names
      .filter((name) => name.endsWith(".dmg"))
      .map((name) => path.join(distDir, name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  }

  return names
    .filter((name) => name.endsWith(".exe") && name.includes("Setup"))
    .map((name) => path.join(distDir, name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function parseResponse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function gitlabRequest(method, apiPath, body, extraHeaders = {}) {
  const response = await fetch(`${gitlabBaseUrl}/api/v4${apiPath}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": process.env.GITLAB_TOKEN,
      ...extraHeaders,
    },
    body,
  });

  const text = await response.text();
  const data = parseResponse(text);
  if (!response.ok) {
    const message = data?.message || data?.error || text || response.statusText;
    const error = new Error(`[GitLab ${response.status}] ${message}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function ensureRelease(encodedProjectId) {
  try {
    await gitlabRequest(
      "POST",
      `/projects/${encodedProjectId}/releases`,
      JSON.stringify({
        name: releaseName,
        tag_name: tagName,
        ref: releaseRef,
        description: `本地打包发布 ${releaseName}`,
      }),
      { "Content-Type": "application/json" }
    );
    console.log(`[release] 已创建 GitLab Release：${tagName}`);
  } catch (error) {
    if (error.status === 409) {
      console.log(`[release] GitLab Release 已存在：${tagName}`);
      return;
    }
    throw error;
  }
}

async function deleteExistingAssetLink(encodedProjectId, name) {
  const links = await gitlabRequest(
    "GET",
    `/projects/${encodedProjectId}/releases/${encodeURIComponent(tagName)}/assets/links`
  );
  const existing = links.find((link) => link.name === name);
  if (!existing) return;
  await gitlabRequest(
    "DELETE",
    `/projects/${encodedProjectId}/releases/${encodeURIComponent(tagName)}/assets/links/${existing.id}`
  );
}

async function attachReleaseLink(encodedProjectId, name, assetUrl) {
  await deleteExistingAssetLink(encodedProjectId, name);
  await gitlabRequest(
    "POST",
    `/projects/${encodedProjectId}/releases/${encodeURIComponent(tagName)}/assets/links`,
    JSON.stringify({
      name,
      url: assetUrl,
      link_type: "package",
    }),
    { "Content-Type": "application/json" }
  );
}

async function getReleaseLinks(encodedProjectId) {
  return gitlabRequest(
    "GET",
    `/projects/${encodedProjectId}/releases/${encodeURIComponent(tagName)}/assets/links`
  );
}

function buildReleaseDescription(links) {
  const byName = new Map(links.map((link) => [link.name, link.url]));
  const macArm64 = byName.get(`一手聊天审计导出-${pkg.version}-arm64.dmg`);
  const macX64 = byName.get(`一手聊天审计导出-${pkg.version}.dmg`);
  const win = byName.get(`一手聊天审计导出 Setup ${pkg.version}.exe`);

  const lines = [
    `# ${releaseName}`,
    "",
    "## 下载安装",
    "",
  ];

  if (macArm64) lines.push(`- macOS Apple 芯片： [一手聊天审计导出-${pkg.version}-arm64.dmg](${macArm64})`);
  if (macX64) lines.push(`- macOS Intel： [一手聊天审计导出-${pkg.version}.dmg](${macX64})`);
  if (win) lines.push(`- Windows： [一手聊天审计导出 Setup ${pkg.version}.exe](${win})`);

  lines.push(
    "",
    "## 使用说明",
    "",
    "1. 安装并启动软件。",
    "2. 在专用 Chrome 窗口中登录 CRM。",
    "3. 选择日期、部门和输出目录后开始导出。",
    "",
    "## macOS 提示",
    "",
    "当前安装包未做 Apple 公证。如提示无法打开，可在应用程序中右键打开，或执行：",
    "",
    "```bash",
    "xattr -dr com.apple.quarantine \"/Applications/一手聊天审计导出.app\"",
    "open \"/Applications/一手聊天审计导出.app\"",
    "```",
    "",
    "Apple 芯片推荐下载 `arm64` 包，Intel 设备下载普通 `.dmg` 包。"
  );

  return lines.join("\n");
}

async function updateReleaseDescription(encodedProjectId) {
  const links = await getReleaseLinks(encodedProjectId);
  await gitlabRequest(
    "PUT",
    `/projects/${encodedProjectId}/releases/${encodeURIComponent(tagName)}`,
    JSON.stringify({ description: buildReleaseDescription(links) }),
    { "Content-Type": "application/json" }
  );
  console.log("[release] 已更新 Release Markdown 描述");
}

function toSafePackageFileName(filePath) {
  const originalName = path.basename(filePath);
  const version = pkg.version;

  if (originalName.endsWith(".dmg") && originalName.includes("arm64")) {
    return `chat-audit-export-${version}-arm64.dmg`;
  }
  if (originalName.endsWith(".dmg")) {
    return `chat-audit-export-${version}-x64.dmg`;
  }
  if (originalName.endsWith(".exe")) {
    return `chat-audit-export-${version}-setup.exe`;
  }

  return originalName.replace(/[^\w.-]+/g, "-");
}

function genericPackageDownloadUrl(safeFileName) {
  return `${gitlabBaseUrl}/${projectId}/-/packages/generic/${packageName}/${packageVersion}/${encodeURIComponent(safeFileName)}`;
}

async function uploadLargeArtifact(encodedProjectId, file) {
  const displayName = path.basename(file);
  const safeFileName = toSafePackageFileName(file);
  const apiPath = `/projects/${encodedProjectId}/packages/generic/${packageName}/${packageVersion}/${encodeURIComponent(safeFileName)}`;

  console.log(`[release] 上传安装包（Generic Package）：${displayName} -> ${safeFileName}`);
  await gitlabRequest("PUT", apiPath, fs.readFileSync(file), {
    "Content-Type": "application/octet-stream",
  });

  const assetUrl = genericPackageDownloadUrl(safeFileName);
  await attachReleaseLink(encodedProjectId, displayName, assetUrl);
}

async function uploadSmallArtifact(encodedProjectId, file) {
  const name = path.basename(file);
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)]), name);

  console.log(`[release] 上传附件：${name}`);
  const upload = await gitlabRequest("POST", `/projects/${encodedProjectId}/uploads`, form);
  const assetUrl = upload.full_path
    ? `${gitlabBaseUrl}${upload.full_path}`
    : `${gitlabBaseUrl}/${projectId}${upload.url}`;

  await attachReleaseLink(encodedProjectId, name, assetUrl);
}

async function uploadArtifact(encodedProjectId, file) {
  const ext = path.extname(file);
  if (LARGE_FILE_EXTS.has(ext)) {
    await uploadLargeArtifact(encodedProjectId, file);
    return;
  }
  if (SMALL_FILE_EXTS.has(ext)) {
    await uploadSmallArtifact(encodedProjectId, file);
    return;
  }
}

async function main() {
  const platform = detectPlatform(builderArgs);
  if (!platform) {
    console.error("[release] 暂只支持 --mac 或 --win 发布。");
    process.exit(1);
  }

  if (!uploadOnly) {
    const prebuildScript = platform === "mac" ? "prebuild:mac" : "prebuild";
    console.log(`[release] 准备运行时资源：${prebuildScript}`);
    run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", prebuildScript]);

    console.log(`[release] 开始本地打包：electron-builder ${builderArgs.join(" ")}`);
    run(process.platform === "win32" ? "npx.cmd" : "npx", [
      "electron-builder",
      ...builderArgs,
      "--publish",
      "never",
    ]);
  } else {
    console.log("[release] 跳过打包，仅上传 dist/ 现有产物");
  }

  const artifacts = collectArtifacts(platform);
  if (artifacts.length === 0) {
    console.error("[release] 未在 dist/ 找到可上传产物。");
    process.exit(1);
  }

  const encodedProjectId = encodeURIComponent(projectId);
  await ensureRelease(encodedProjectId);
  for (const artifact of artifacts) {
    await uploadArtifact(encodedProjectId, artifact);
  }
  await updateReleaseDescription(encodedProjectId);

  console.log(`[release] 发布完成：${gitlabBaseUrl}/${projectId}/-/releases/${tagName}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

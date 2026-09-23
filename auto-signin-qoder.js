/**
 * Qoder / Qoder CN 每日自动领取 100 Credits —— 独立脚本（不改动 auto-signin.js）
 *
 * 为什么单独一个文件：auto-signin.js（WorkBuddy + Trae）已在计划任务里稳定运行，
 * 本脚本刻意与之解耦 —— 独立的锁、独立的状态文件，两者可并行运行互不干扰；
 * 日志仍写入同一个 ~/.daily-checkin/logs/，方便一处查看全部产品的时间线。
 *
 * 凭据全部从 Qoder 客户端本地登录态实时解密读取（应用自身负责续期），脚本不落盘任何令牌。
 * 请求头按官方桌面端的 Cosy-* 约定构造（Cosy-ClientType / Cosy-Version / Cosy-MachineOS /
 * Cosy-MachineHostname / Cosy-MachineId / Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType）。
 * 其中两类头是"能不能领到"的关键，缺任何一个都会让服务端返回的活动列表缺项，
 * 表现为"桌面端明明显示可领取，脚本却查不到"：
 *   Cosy-Version   必须与已安装客户端版本一致；
 *   Cosy-Machine*  机器身份，取自客户端本地的 auth.machine-id 与自带 runtime-info.exe。
 *
 * 用法（Node.js >= 18，零依赖）:
 *   node auto-signin-qoder.js [--once] [--dry-run] [--status] [--only=qoder|qoder-cn]
 *   默认进入守护循环，每天自动领取；--once 只执行一轮立即退出；
 *   --dry-run 只读预演（同样只跑一轮）；--status 仅查询活动状态（只读调试）；--only 只处理指定产品。
 *
 * 环境变量:
 *   QODER_CHECKIN_TIME / QODER_CHECKIN_TIMES  领取时间点（默认 10:05；后者逗号分隔多时间点）
 *   CHECKIN_BASE_DIR                          状态/日志目录（默认 ~/.daily-checkin，与主脚本共用）
 *   QODER_AUTH_FILE / QODER_CN_AUTH_FILE      指定 auth.v1.dat 路径（默认自动探测）
 *   QODER_OPENAPI_BASE / QODER_CN_OPENAPI_BASE 覆盖接口基址（默认读客户端 endpoint-cache）
 *   QODER_RETRY_MAX                           拿不到可领取活动时的额外重试次数（默认 2，0 关闭）
 *   QODER_RETRY_INTERVAL_MIN                  重试间隔分钟数（默认 10）
 *
 * 活动规则（2026-09-18 起）：每天 10:00（UTC+8）刷新，Qoder 桌面端内主动领取 100 Credits，
 * 领取窗口至次日 09:59，奖励自领取起 30 天有效。故默认领取时间取 10:05。
 * 注意：10:00 只是名义开窗时间，服务端对单个账号的"放量"可能晚于此
 *（2026-09-19 出现过 Qoder CN 已可领、Qoder 国际版活动列表里还没有的情况），
 * 因此拿不到可领取活动时会有界重试，并记为 [注意] 写入 critical.log，而不是当作成功。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

// ---------------- CLI / 环境解析 ----------------
const DRY_RUN = process.argv.includes('--dry-run');
const ONCE = process.argv.includes('--once');
const STATUS_MODE = process.argv.includes('--status');
// --dry-run 是调试用途，默认只跑一轮就退出（否则会进入守护循环睡到明天，非常反直觉）
const LOOP = !ONCE && !STATUS_MODE && !DRY_RUN; // 默认守护循环

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

// 领取时间点（默认 10:05 —— 活动每天 10:00 UTC+8 开新一轮，必须晚于 10:00）
const CHECKIN_TIME = (process.env.QODER_CHECKIN_TIME || '10:05').trim();
const CHECKIN_TIMES = (process.env.QODER_CHECKIN_TIMES || CHECKIN_TIME)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
if (CHECKIN_TIMES.length === 0) CHECKIN_TIMES.push('10:05');

// 拿不到可领取活动时的重试（服务端对单个账号"放量"可能晚于 10:00，
// 2026-09-19 就出现过 Qoder CN 已可领、Qoder 国际版列表里还没有该活动的情况）
const RETRY_MAX = Math.max(0, parseInt(process.env.QODER_RETRY_MAX || '2', 10) || 0);
const RETRY_INTERVAL_MIN = Math.max(1, parseInt(process.env.QODER_RETRY_INTERVAL_MIN || '10', 10) || 10);
const RETRY_INTERVAL_MS = RETRY_INTERVAL_MIN * 60 * 1000;

// 状态/日志目录：与主脚本共用 BASE_DIR，但状态文件与锁名独立，避免互相覆盖
const BASE_DIR = process.env.CHECKIN_BASE_DIR
  ? path.resolve(process.env.CHECKIN_BASE_DIR)
  : path.join(HOME, '.daily-checkin');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const LOCK_DIR = path.join(BASE_DIR, 'locks');
const STATE_FILE = path.join(BASE_DIR, 'state-qoder.json');
const CRITICAL_FILE = path.join(BASE_DIR, 'critical.log');
const BACKUP_DIR = path.join(BASE_DIR, 'backups');

function ensureDirs() {
  for (const d of [LOG_DIR, LOCK_DIR]) fs.mkdirSync(d, { recursive: true });
}

// ---------------- 通用工具 ----------------
function pad(n) { return String(n).padStart(2, '0'); }

function tsOf(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function log(lines) {
  ensureDirs();
  const now = new Date();
  const text = lines.map((l) => `[${tsOf(now)}] ${l}`).join('\n') + '\n';
  process.stdout.write(text);
  const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  fs.appendFileSync(path.join(LOG_DIR, `checkin-${month}.log`), text, 'utf8');
}

function logCritical(title, detail) {
  ensureDirs();
  const line = `[${tsOf()}] ${title}: ${detail}`;
  log([`${title}: ${detail}`]); // log() 会补时间戳，这里不要再拼一次
  fs.appendFileSync(CRITICAL_FILE, line + '\n', 'utf8');
}

// 防重入锁：以产品 key 为锁名，独占创建（wx）实现无竞态互斥，超时 10 分钟视为残留锁接管
function withLock(name, fn) {
  const lockFile = path.join(LOCK_DIR, `${name}.lock`);
  const token = `${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, token);
    fs.closeSync(fd);
  } catch {
    let stale = false;
    try {
      stale = Date.now() - fs.statSync(lockFile).mtimeMs > 10 * 60 * 1000;
    } catch { stale = true; }
    if (stale) {
      try { fs.rmSync(lockFile, { force: true }); } catch {}
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeSync(fd, token);
        fs.closeSync(fd);
      } catch (e2) {
        throw new Error(`产品 ${name} 正被另一个进程处理，已跳过（锁获取失败: ${e2.message}）`);
      }
    } else {
      throw new Error(`产品 ${name} 正被另一个进程处理，本次跳过`);
    }
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      try { fs.rmSync(lockFile, { force: true }); } catch {}
    }
  })();
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// 记录"某产品今天确实领取成功过"（含幂等 replay 之外的首次领取），
// 用于同日重跑时不再重复报 [注意]（服务端此时已把该活动变为 CLAIMED、claimable=false）
function markClaimed(product) {
  const s = readState();
  if (!s.claims || typeof s.claims !== 'object') s.claims = {};
  s.claims[product.key] = todayStr();
  writeState(s);
}

function claimedToday(product) {
  const s = readState();
  return Boolean(s.claims && s.claims[product.key] === todayStr());
}

async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, headers: res.headers, data, text };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hhmmOf(ms) {
  const s = Math.round(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`;
}

function msUntilNextCheckin(timeList) {
  const now = new Date();
  let best = Infinity;
  for (const timeStr of timeList) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(timeStr).trim());
    if (!m) throw new Error(`领取时间格式错误: "${timeStr}"（应为 HH:MM）`);
    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) throw new Error(`领取时间越界: "${timeStr}"`);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0);
    let diff = today.getTime() - now.getTime();
    if (diff <= 0) diff += 24 * 3600 * 1000;
    if (diff < best) best = diff;
  }
  return best;
}

// 人类可读的时间（本地时区），用于日志展示
function localTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------- 产品定义 ----------------
// dataDir:     %APPDATA% 下的客户端数据目录（product.json 的 dataDirectoryName）
// homeDir:     用户主目录下的客户端目录（存放 endpoint-cache.json）
// launcherDir: %LOCALAPPDATA% 下的启动器目录（product.json 的 windowsLauncherDirectory），
//              其 state.ini 里的 targetVersion 即"当前实际运行的客户端版本"
// fallbackVersion: 仅在本地探测不到版本时使用（Cosy-Version 缺失会让服务端少返回活动）
const PRODUCTS = [
  {
    key: 'qoder',
    name: 'Qoder',
    dataDir: 'com.qoder.app.stable',
    homeDir: '.qoder',
    launcherDir: path.join('Qoder', 'Qoder Launcher'),
    fallbackVersion: '0.2.3',
    regionEnv: 3, // 客户端 regionCode==="global" → environment=3
    defaultBase: 'https://openapi.qoder.sh',
    envAuth: 'QODER_AUTH_FILE',
    envBase: 'QODER_OPENAPI_BASE',
  },
  {
    key: 'qoder-cn',
    name: 'Qoder CN',
    dataDir: 'com.qodercn.app.stable',
    homeDir: '.qoder-cn',
    launcherDir: path.join('Qoder CN', 'Qoder CN Launcher'),
    fallbackVersion: '0.3.4',
    regionEnv: 0, // 非 global 区域 → environment=0
    defaultBase: 'https://openapi.qoder.com.cn',
    envAuth: 'QODER_CN_AUTH_FILE',
    envBase: 'QODER_CN_OPENAPI_BASE',
  },
];

// ---------------- 凭据读取（Electron safeStorage / Windows DPAPI） ----------------
// Qoder 客户端把登录态写在 %APPDATA%\<dataDir>\auth.v1.dat：
//   [3B "v10"] [12B nonce] [AES-256-GCM 密文] [16B tag]
// 密钥不落盘于该文件，而是 Chromium 的 os_crypt 密钥：Local State 里
//   os_crypt.encrypted_key = base64("DPAPI" + CryptProtectData(32B AES 密钥))
// 因此：先用 DPAPI 解出 AES 密钥，再用它做 AES-256-GCM 解密 auth.v1.dat。
// Node 无法直接调用 DPAPI，故借 PowerShell 的 ProtectedData 做这一步（Windows 自带，无第三方依赖）。

const OS_CRYPT_PREFIX = 'DPAPI';
const AUTH_MAGIC = 'v10';

function authFilePath(product) {
  const override = process.env[product.envAuth];
  if (override) return override;
  return path.join(APPDATA, product.dataDir, 'auth.v1.dat');
}

function localStatePath(product) {
  return path.join(APPDATA, product.dataDir, 'Local State');
}

function powershellPath() {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

// 批量用 DPAPI 解开 os_crypt 密钥（一次 PowerShell 调用处理多个产品，避免重复起进程）
function dpapiUnprotectAll(b64Blobs) {
  const args = b64Blobs.map((b) => `'${b}'`).join(',');
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    `foreach ($s in @(${args})) {`,
    '  $b = [Convert]::FromBase64String($s)',
    '  $k = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '  [Convert]::ToBase64String($k)',
    '}',
  ].join('; ');
  const out = execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

const OS_CRYPT_KEY_CACHE = new Map();

// 取出某产品本次运行可用的 32 字节 AES 密钥（进程内缓存）
function getOsCryptKey(product) {
  if (OS_CRYPT_KEY_CACHE.has(product.key)) return OS_CRYPT_KEY_CACHE.get(product.key);
  if (process.platform !== 'win32') {
    throw new Error('当前脚本的凭据解密仅支持 Windows（Qoder 客户端在 macOS/Linux 使用系统钥匙串存储登录态）');
  }
  const lsPath = localStatePath(product);
  if (!fs.existsSync(lsPath)) {
    throw new Error(`未找到 Qoder 客户端数据目录（${lsPath}），请先在本机登录 Qoder 桌面端`);
  }
  let encryptedKey;
  try {
    encryptedKey = JSON.parse(fs.readFileSync(lsPath, 'utf8'))?.os_crypt?.encrypted_key;
  } catch (e) {
    throw new Error(`读取 Local State 失败: ${e.message}`);
  }
  if (!encryptedKey) throw new Error('Local State 中缺少 os_crypt.encrypted_key，请先在本机登录 Qoder 桌面端');

  const raw = Buffer.from(encryptedKey, 'base64');
  const prefix = raw.subarray(0, OS_CRYPT_PREFIX.length).toString('ascii');
  if (prefix !== OS_CRYPT_PREFIX) {
    throw new Error(`os_crypt 密钥格式非预期（前缀 "${prefix}"），可能是客户端版本更新，请反馈以更新脚本`);
  }
  let keyB64;
  try {
    [keyB64] = dpapiUnprotectAll([raw.subarray(OS_CRYPT_PREFIX.length).toString('base64')]);
  } catch (e) {
    throw new Error(`DPAPI 解密 os_crypt 密钥失败（当前用户需与登录 Qoder 的 Windows 用户一致）: ${(e.stderr || e.message || '').toString().trim().slice(0, 200)}`);
  }
  if (!keyB64) throw new Error('DPAPI 解密 os_crypt 密钥未返回结果');
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error(`os_crypt 密钥长度异常（${key.length} 字节，期望 32）`);
  OS_CRYPT_KEY_CACHE.set(product.key, key);
  return key;
}

// 解密 auth.v1.dat → 登录态 JSON
function decryptAuthBlob(raw, key) {
  const magic = raw.subarray(0, AUTH_MAGIC.length).toString('ascii');
  if (magic !== AUTH_MAGIC) {
    throw new Error(`auth.v1.dat 格式非预期（头部 "${magic}"），可能是客户端版本更新，请反馈以更新脚本`);
  }
  const body = raw.subarray(AUTH_MAGIC.length);
  if (body.length <= 12 + 16) throw new Error('auth.v1.dat 内容过短，疑似损坏');
  const nonce = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(12, body.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch (e) {
    throw new Error(`auth.v1.dat 解密失败（${e.message}），请确认脚本与当前 Windows 用户一致，或重新登录 Qoder 桌面端`);
  }
}

// 接口基址：优先读客户端自己缓存的 endpoint-cache，失败则用内置默认值
function resolveBaseUrl(product) {
  const override = process.env[product.envBase];
  if (override) return String(override).replace(/\/+$/, '');
  const cache = path.join(HOME, product.homeDir, '.cache', 'endpoint-cache.json');
  try {
    const j = JSON.parse(fs.readFileSync(cache, 'utf8'));
    const ep = j?.entries?.prod?.openapiEndpoint;
    if (ep) return String(ep).replace(/\/+$/, '');
  } catch { /* 缓存不可读时用默认值 */ }
  return product.defaultBase;
}

// ---------------- 客户端身份（Cosy-* 请求头） ----------------
// 服务端会依据 Cosy-* 头判断"这是不是官方桌面端"，并据此决定返回哪些活动。
// 2026-09-20 实测复现：只发 Cosy-ClientType 时活动列表只有 1 条，
// 补上 Cosy-Version 后变成 2 条 —— 少的那条正是权益活动，也就是"脚本领不到"的根因。
// 客户端实现（app.asar 内 tUt/I0/h9e/I9e）：
//   Cosy-Version          = 应用版本（Et.getVersion()）
//   Cosy-MachineOS        = "<arch>_<platform>"，x64→x86_64、arm64→aarch64
//   Cosy-MachineHostname  = 主机名（可打印 ASCII 原样发送，超 96 字符才截断加哈希）
// 注：Cosy-MachineId/Token/Code/Type 由客户端原生 runtime-info.exe 生成，脚本不伪造（实测对活动列表无影响）。

function iniValue(file, section, key) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let cur = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith(';') || line.startsWith('#')) continue;
      const sec = /^\[(.+)\]$/.exec(line);
      if (sec) { cur = sec[1]; continue; }
      const kv = /^([^=]+)=(.*)$/.exec(line);
      if (!kv) continue;
      if (cur.toLowerCase() !== section.toLowerCase()) continue;
      if (kv[1].trim().toLowerCase() !== key.toLowerCase()) continue;
      return kv[2].trim();
    }
  } catch { /* 文件不存在或不可读，交给调用方兜底 */ }
  return null;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function pickHighestVersion(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const versions = names.filter((n) => /^\d+\.\d+\.\d+$/.test(n));
  if (versions.length === 0) return null;
  return versions.sort(compareVersions).pop();
}

// 扁平安装布局没有 .qoder-versions 目录，改读安装目录内的 build-manifest.json（版本最准）
function buildManifestVersion(installDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(installDir, 'resources', 'build-manifest.json'), 'utf8'));
    const v = j && j.productVersion;
    return v ? String(v).trim() : null;
  } catch {
    return null;
  }
}

const CLIENT_VERSION_CACHE = new Map();

// 探测客户端版本：启动器 state.ini 的 targetVersion（最准）→ 安装目录里最高的 .qoder-versions 版本 → 内置兜底
function resolveClientVersion(product) {
  if (CLIENT_VERSION_CACHE.has(product.key)) return CLIENT_VERSION_CACHE.get(product.key);

  const stateFile = path.join(LOCALAPPDATA, product.launcherDir, 'state.ini');
  const installDir = iniValue(stateFile, 'launcher', 'installDir');
  const target = iniValue(stateFile, 'launcher', 'targetVersion');

  let v = null;
  // targetVersion 对应的版本目录确实存在才采信，避免升级中途读到半成品
  if (target && installDir && fs.existsSync(path.join(installDir, '.qoder-versions', target))) {
    v = target;
  }
  if (!v && installDir) v = pickHighestVersion(path.join(installDir, '.qoder-versions'));
  if (!v && installDir) v = buildManifestVersion(installDir);
  if (!v) v = target;
  let fromFallback = false;
  if (!v) { v = product.fallbackVersion; fromFallback = true; }

  const ver = String(v).trim();
  CLIENT_VERSION_CACHE.set(product.key, ver);
  if (fromFallback) {
    log([`${product.name}: 未能从本机客户端读到版本号，暂用兜底版本 ${ver}（若活动列表异常，请检查客户端安装目录）`]);
  }
  return ver;
}

// Cosy-MachineOS：客户端格式 "<arch>_<platform>"
function machineOsHeader() {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  return `${arch}_${process.platform}`;
}

// Cosy-MachineHostname：与客户端一致 —— 必须是可打印 ASCII（首尾非空格）才发送
function machineHostnameHeader() {
  try {
    const h = os.hostname().trim();
    if (!h || h.length > 96) return null;
    return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

// ---- 机器身份（Cosy-MachineId / Token / Code / Type）----
// 这一组是"日常权益活动是否对该账号可见"的决定性因素。2026-09-20 实测对照：
//   只发 Cosy-ClientType+Version+MachineOS+Hostname → claimable=false，活动列表缺当天的 CLAIM_BENEFIT 活动
//   再补上 MachineId+Token+Code+Type              → claimable=true，当天的 CLAIM_BENEFIT 活动正常出现（CLAIMABLE）
// 取值来源（均取自本机客户端自身，不伪造）：
//   Cosy-MachineId    ← %APPDATA%\<dataDir>\auth.machine-id（客户端持久化的 UUID）
//   Cosy-MachineToken ← runtime-info.exe（客户端自带原生程序）输出
//   Cosy-MachineCode  ← 同上
//   Cosy-MachineType  ← 同上
// runtime-info.exe 调用约定（见 app.asar 内 C9e/E9e）：
//   runtime-info.exe <environment> --account-stdin
//   stdin  : {"account":"<用户id>}.        ← 结尾那个 "." 是协议终止符
//   stdout : 以 "." 结尾的 JSON，取第一个 "." 之前的部分
const MACHINE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function machineIdOf(product) {
  try {
    const id = fs.readFileSync(path.join(APPDATA, product.dataDir, 'auth.machine-id'), 'utf8').trim();
    return MACHINE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

const MACHINE_IDENTITY_CACHE = new Map();
const MACHINE_IDENTITY_TTL_MS = 30 * 60 * 1000; // 令牌可能有时效，半小时后重新取
const IDENTITY_WARNED = new Set();

// 取不到机器身份是"活动被隐藏"的根因，但以前是静默降级（catch 吞掉），
// 表现成"桌面端明明可领、脚本却查不到"且日志里毫无线索。这里每个产品只提示一次。
function warnIdentityOnce(product, reason) {
  if (IDENTITY_WARNED.has(product.key)) return;
  IDENTITY_WARNED.add(product.key);
  log([`${product.name}: 未能取到机器身份头（${reason}）；服务端可能因此隐藏日常权益活动（Cosy-Machine* 缺失）`]);
}

function runtimeInfoPath(product) {
  const installDir = iniValue(path.join(LOCALAPPDATA, product.launcherDir, 'state.ini'), 'launcher', 'installDir');
  if (!installDir) return null;
  // 客户端有两种安装布局，都要覆盖（否则机器身份头取不到 → 日常权益活动被服务端隐藏）：
  //   分层布局（新版安装器，如 Qoder CN）: <installDir>\.qoder-versions\<version>\resources\umid\runtime-info.exe
  //   扁平布局（2026-09-22 国际版更新后）: <installDir>\resources\umid\runtime-info.exe
  const candidates = [
    path.join(installDir, '.qoder-versions', resolveClientVersion(product), 'resources', 'umid', 'runtime-info.exe'),
    path.join(installDir, 'resources', 'umid', 'runtime-info.exe'),
  ];
  for (const exe of candidates) if (fs.existsSync(exe)) return exe;
  return null;
}

// 返回 { machineToken, machineCode, machineType } 或 null（拿不到时由调用方降级处理）
function machineIdentityOf(product, userId) {
  const cached = MACHINE_IDENTITY_CACHE.get(product.key);
  if (cached && Date.now() - cached.at < MACHINE_IDENTITY_TTL_MS) return cached.value;

  const exe = runtimeInfoPath(product);
  if (!exe) {
    warnIdentityOnce(product, '未找到 runtime-info.exe，客户端安装布局可能已变化');
    return null;
  }
  let value = null;
  try {
    const out = execFileSync(exe, [String(product.regionEnv), '--account-stdin'], {
      input: `${JSON.stringify({ account: userId })}.`,
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    const cut = out.indexOf('.');
    const parsed = JSON.parse(cut >= 0 ? out.slice(0, cut) : out);
    if (parsed && parsed.machineToken && parsed.machineCode && parsed.machineType) {
      value = {
        machineToken: String(parsed.machineToken),
        machineCode: String(parsed.machineCode),
        machineType: String(parsed.machineType),
      };
    }
  } catch (e) {
    value = null; // 失败不缓存，下次重试
    warnIdentityOnce(product, `调用 runtime-info.exe 失败: ${(e.message || String(e)).slice(0, 120)}`);
  }
  if (value) MACHINE_IDENTITY_CACHE.set(product.key, { at: Date.now(), value });
  return value;
}

function loadProduct(product) {
  const file = authFilePath(product);
  if (!fs.existsSync(file)) {
    throw new Error(`未找到 Qoder 登录凭据（${file}）。请先在本机登录 Qoder 桌面端，或设置环境变量 ${product.envAuth} 指向 auth.v1.dat`);
  }
  const key = getOsCryptKey(product);
  const auth = decryptAuthBlob(fs.readFileSync(file), key);
  if (!auth.token) throw new Error('登录信息中缺少 token，请重新登录 Qoder 桌面端');
  const base = resolveBaseUrl(product);
  const version = resolveClientVersion(product);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Qoder',
    Authorization: `Bearer ${auth.token}`,
    'Cosy-ClientType': '10', // 客户端类型（桌面端固定为 10）
    // 下面三个头是"活动列表是否完整"的前提：缺 Cosy-Version 会被服务端少给活动
    'Cosy-Version': version,
    'Cosy-MachineOS': machineOsHeader(),
  };
  const hostname = machineHostnameHeader();
  if (hostname) headers['Cosy-MachineHostname'] = hostname;

  // 机器身份：决定日常权益活动是否出现在列表里，缺了就会"明明可领却查不到"
  const machineId = machineIdOf(product);
  if (machineId) headers['Cosy-MachineId'] = machineId;
  const identity = machineIdentityOf(product, auth.user && auth.user.id);
  if (identity) {
    headers['Cosy-MachineToken'] = identity.machineToken;
    headers['Cosy-MachineCode'] = identity.machineCode;
    headers['Cosy-MachineType'] = identity.machineType;
  }
  const identityOk = Boolean(machineId && identity);
  return { file, auth, base, headers, version, identityOk };
}

// ---------------- 活动接口 ----------------
// 活动列表：GET  {base}/sash/api/v1/me/campaigns
// 领取权益：POST {base}/sash/api/v1/me/campaigns/{campaignId}/claim（幂等，重复领取返回 replayed=true）
function campaignTitle(campaign) {
  const popup = (campaign.placements || []).find((p) => p && p.type === 'POPUP');
  const content = popup && popup.content;
  if (!content) return null;
  return (content.zh && content.zh.title) || (content.en && content.en.title) || null;
}

function describeCampaign(campaign) {
  const benefit = campaign.benefit || {};
  const amount = benefit.kind === 'CREDITS' && Number.isFinite(benefit.amount) ? `${benefit.amount} Credits` : null;
  return amount || benefit.kind || '权益';
}

async function listCampaigns(headers, base) {
  const res = await httpJson(`${base}/sash/api/v1/me/campaigns`, { method: 'GET', headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Qoder 登录态已失效（HTTP ${res.status}），请打开 Qoder 桌面端重新登录`);
  }
  if (res.status < 200 || res.status >= 300 || !res.data || typeof res.data !== 'object') {
    throw new Error(`查询活动列表失败（HTTP ${res.status}）: ${String(res.text || '').slice(0, 200)}`);
  }
  return res.data;
}

// 挑出"需要领取"的活动：
// 主判据是 actionType=CLAIM_BENEFIT；若服务端改了命名，则回退到任何 claimStatus=CLAIMABLE 的活动，
// 避免因为字段值变化而"静默跳过"（2026-09-19 Qoder 国际版就是被静默跳过的）。
function pickTargets(list) {
  const camps = (list.campaigns || []).filter((c) => c && typeof c === 'object');
  const primary = camps.filter((c) => c.actionType === 'CLAIM_BENEFIT');
  if (primary.length > 0) return primary;
  return camps.filter((c) => c.claimStatus === 'CLAIMABLE');
}

// 列表中是否存在"现在就能领"的活动：服务端聚合标记 claimable 与逐条 claimStatus 双重判断
function hasClaimable(list) {
  if (list && list.claimable === true) return true;
  const camps = (list && list.campaigns) || [];
  return camps.some((c) => c && c.claimStatus === 'CLAIMABLE');
}

// 拿不到可领取活动时，把接口返回的关键信息落进日志，便于下次定位（而不是只报一句"无活动"）
function describeList(list) {
  const camps = (list.campaigns || []).filter((c) => c && typeof c === 'object');
  const items = camps.map((c) => `${c.campaignKey || c.campaignId || '?'}(${c.actionType || '?'}/${c.claimStatus || '?'})`);
  return [
    `showCampaign=${list.showCampaign}`,
    `claimable=${list.claimable}`,
    `campaigns=${camps.length}${items.length ? ': ' + items.join(', ') : ''}`,
  ].join(' | ');
}

// 令牌剩余有效期不足 24 小时时给出预警（脚本不自行续期，由桌面端负责）
function expiryWarning(auth) {
  const exp = Date.parse(auth.expiresAt);
  if (!Number.isFinite(exp)) return null;
  const remainMs = exp - Date.now();
  const at = localTime(auth.expiresAt);
  if (remainMs <= 0) return `登录令牌已过期（${at}），请打开 Qoder 桌面端一次以刷新登录态`;
  if (remainMs < 24 * 3600 * 1000) return `登录令牌将在 ${at} 过期，届时请打开 Qoder 桌面端一次`;
  return null;
}

// 返回 { msg, pending, detail?, warn? }
//   pending=true 表示"服务端当前没有可领取的活动"（不是失败，但也不能算完成，交由上层重试）
//   warn=true    表示"列表里根本没有任何可领取活动（存量已领活动掩盖不了）"——记 [注意]，不重试
async function checkinProduct(product) {
  const { auth, base, headers, identityOk } = loadProduct(product);
  const list = await listCampaigns(headers, base);
  const warn = expiryWarning(auth);
  const identityWarn = identityOk
    ? ''
    : '；未能取到机器身份头（Cosy-MachineId/Token/Code/Type），日常活动可能被服务端隐藏，请确认 Qoder 桌面端已在本机安装并登录';

  const targets = pickTargets(list);
  if (targets.length === 0) {
    const detail = describeList(list);
    return {
      pending: true,
      detail,
      msg: `暂无可领取的权益活动（${detail}）${warn ? `；${warn}` : ''}${identityWarn}`,
    };
  }

  const parts = [];
  let claimedNow = false; // 本轮是否真的领到了新权益（幂等 replay 不算）
  for (const campaign of targets) {
    const title = campaignTitle(campaign) || campaign.campaignKey || '活动';
    const amount = describeCampaign(campaign);

    if (campaign.claimStatus === 'CLAIMED') {
      // 已领取：从活动列表拿不到到期时间，做一次幂等领取以取回 grant 详情（服务端返回 replayed=true）
      if (DRY_RUN) { parts.push(`${title}：今日已领取（${amount}）`); continue; }
      const replay = await claimCampaign(headers, base, campaign);
      const exp = localTime(replay.expiresAt);
      parts.push(`${title}：今日已领取 ${amount}${exp ? `（有效期至 ${exp}）` : ''}`);
      continue;
    }

    if (campaign.claimStatus !== 'CLAIMABLE') {
      parts.push(`${title}：不可领取（状态 ${campaign.claimStatus || '未知'}）`);
      continue;
    }

    if (DRY_RUN) { parts.push(`${title}：尚未领取（dry-run，跳过领取）`); continue; }

    const claim = await claimCampaign(headers, base, campaign);
    const exp = localTime(claim.expiresAt);
    const gained = claim.replayed ? `今日已领取 ${amount}` : `成功领取 ${amount}`;
    if (!claim.replayed) claimedNow = true;
    parts.push(`${title}：${gained}${exp ? `（有效期至 ${exp}）` : ''}`);
  }

  if (warn) parts.push(warn);

  if (claimedNow) markClaimed(product);

  // 漏报修复（2026-09-23 实测踩到）：pickTargets 只看 actionType=CLAIM_BENEFIT，
  // 存量活动（如「久等了，感谢您还在」500 Credits，状态 CLAIMED）同样会命中，
  // 于是"今天的日常活动根本没出现在列表里"被当作成功糊弄过去
  // —— 当时国际版只回 2 条已领活动、claimable=false，脚本却报 [成功]，
  // 真正的原因是机器身份头（Cosy-Machine*）缺失导致服务端隐藏了日常活动。
  // 现在按"列表里没有任何可领取活动 + 今日尚未领取成功过"补一条 [注意]，而不是静默通过。
  if (!hasClaimable(list) && !(claimedNow || claimedToday(product))) {
    parts.push('[注意] 今日列表中没有可领取的权益活动（已领的存量活动不算）：可能服务端尚未放量，或机器身份头（Cosy-Machine*）缺失导致活动被隐藏');
    return { pending: false, warn: true, msg: parts.join('；') };
  }

  return { pending: false, msg: parts.join('；') };
}

async function claimCampaign(headers, base, campaign) {
  const res = await httpJson(`${base}/sash/api/v1/me/campaigns/${encodeURIComponent(campaign.campaignId)}/claim`, {
    method: 'POST',
    headers,
    body: {},
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Qoder 登录态已失效（HTTP ${res.status}），请打开 Qoder 桌面端重新登录`);
  }
  if (res.status < 200 || res.status >= 300 || !res.data || typeof res.data !== 'object') {
    throw new Error(`领取失败（HTTP ${res.status}）: ${String(res.text || '').slice(0, 200)}`);
  }
  if (res.data.status !== 'CLAIMED') {
    throw new Error(`领取未成功（status=${res.data.status}）: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  return res.data;
}

async function statusProduct(product) {
  const { auth, base, headers, version, identityOk } = loadProduct(product);
  const list = await listCampaigns(headers, base);
  const lines = [];
  const camps = (list.campaigns || []).filter((c) => c && typeof c === 'object');
  for (const campaign of camps) {
    const title = campaignTitle(campaign) || campaign.campaignKey;
    const win = campaign.endAt ? `，截止 ${localTime(new Date(campaign.endAt * 1000).toISOString())}` : '';
    lines.push(`${title}：${campaign.claimStatus}${campaign.actionType === 'CLAIM_BENEFIT' ? `（${describeCampaign(campaign)}）` : ''}${win}`);
  }
  if (lines.length === 0) lines.push('暂无可参与的活动');
  lines.push(`客户端: Cosy-Version=${version} | Cosy-MachineOS=${headers['Cosy-MachineOS']} | 机器身份=${identityOk ? '已带上' : '缺失（活动可能被隐藏）'}`);
  lines.push(`活动入口: ${describeList(list)}`);
  if (!hasClaimable(list)) lines.push('[注意] 列表中没有可领取的权益活动（已领的存量活动不算；若在领取窗口内，多半是服务端尚未放量，或机器身份头缺失导致活动被隐藏）');
  const warn = expiryWarning(auth);
  if (warn) lines.push(`[注意] ${warn}`);
  return lines;
}

// ---------------- 编排 ----------------
function parseOnly() {
  let only = '';
  const onlyEq = process.argv.find((a) => a.startsWith('--only='));
  if (onlyEq) only = onlyEq.split('=')[1].toLowerCase();
  else {
    const idx = process.argv.indexOf('--only');
    if (idx >= 0 && process.argv[idx + 1]) only = process.argv[idx + 1].toLowerCase();
  }
  return only.trim();
}

function filterProducts() {
  const only = parseOnly();
  if (!only) return PRODUCTS;
  // 先按 key 精确匹配（--only=qoder 只处理国际版，不牵连 Qoder CN）
  const exact = PRODUCTS.filter((p) => p.key === only);
  if (exact.length > 0) return exact;
  return PRODUCTS.filter((p) => p.key.includes(only) || p.name.toLowerCase().includes(only));
}

async function runRound(mode = 'auto') {
  const products = filterProducts();
  if (products.length === 0) {
    log([`未找到匹配 --only=${parseOnly()} 的产品（可用: qoder / qoder-cn）`]);
    return [];
  }
  const results = [];
  for (const p of products) {
    try {
      // 产品之间加随机 2~8 秒间隔，避免整齐划一的请求特征
      await sleep(2000 + Math.floor(Math.random() * 6000));

      if (mode === 'status') {
        const lines = await withLock(p.key, () => statusProduct(p));
        for (const l of lines) results.push({ name: p.name, ok: true, msg: l });
        continue;
      }

      // 服务端可能晚于 10:00 才对某个账号"放量"（2026-09-19 已遇到），
      // 因此拿不到可领取活动时按固定间隔重试；每次重试都重新抢锁，避免长时间持锁。
      let r;
      let attempt = 0;
      for (;;) {
        r = await withLock(p.key, () => checkinProduct(p));
        if (!r.pending || DRY_RUN || attempt >= RETRY_MAX) break;
        attempt += 1;
        log([`${p.name}: 暂无可领取活动，${RETRY_INTERVAL_MIN} 分钟后重试（第 ${attempt}/${RETRY_MAX} 次）`]);
        await sleep(RETRY_INTERVAL_MS);
      }

      if (r.pending) {
        // 到点还是没放量：算"未完成"，写 CRITICAL 引起注意，而不是当成成功糊弄过去
        results.push({ name: p.name, ok: true, warn: true, msg: r.msg });
        logCritical(`${p.name} 未领取`, r.msg);
      } else if (r.warn) {
        // 活动列表里压根没有可领取的权益（存量活动掩盖不了）——同样只算 [注意]，不算失败
        results.push({ name: p.name, ok: true, warn: true, msg: r.msg });
        logCritical(`${p.name} 未取得今日新权益`, r.msg);
      } else {
        results.push({ name: p.name, ok: true, msg: r.msg });
      }
    } catch (err) {
      const msg = err.message || String(err);
      results.push({ name: p.name, ok: false, msg });
      // 凭证缺失/失效/格式变更/网络异常都会导致"这次没领到"，一律写入 CRITICAL
      if (/(过期|失效|重新登录|未找到|未登录|非预期|失败|网络|超时|fetch|timeout)/i.test(msg)) logCritical(p.name, msg);
    }
  }
  return results;
}

function summarize(results, mode = 'auto') {
  if (results.length === 0) return;
  if (mode === 'auto') {
    const state = readState();
    state.lastRun = {
      when: tsOf(),
      date: todayStr(),
      mode: DRY_RUN ? 'dry-run' : 'real',
      success: results.filter((r) => r.ok).length,
      warned: results.filter((r) => r.warn).length,
      total: results.length,
      detail: results.map((r) => ({ name: r.name, ok: r.ok, warn: !!r.warn, msg: r.msg })),
    };
    writeState(state);
  }
  const successCount = results.filter((r) => r.ok).length;
  const lines = results.map((r) => {
    const tag = !r.ok ? '[失败]'
      : r.warn ? '[注意]'
      : mode === 'status' ? '[状态]'
      : '[成功]';
    return `${tag} ${r.name}: ${r.msg}`;
  });
  const warnCount = results.filter((r) => r.warn).length;
  lines.push(`本轮汇总: ${successCount}/${results.length} 成功${warnCount ? `，${warnCount} 项需注意` : ''}${DRY_RUN ? '（dry-run 模式）' : ''}`);
  log(lines);
}

async function daemonLoop() {
  log([`Qoder 守护模式已启动，每天在 [${CHECKIN_TIMES.join(', ')}] 自动领取。可用 Ctrl+C 退出。`]);
  const results = await runRound();
  summarize(results);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let ms;
    try {
      ms = msUntilNextCheckin(CHECKIN_TIMES);
    } catch (err) {
      log([`配置错误: ${err.message}，30 分钟后重试`]);
      await sleep(30 * 60 * 1000);
      continue;
    }
    log([`距下次领取约 ${hhmmOf(ms)}，睡等待中…`]);
    await sleep(ms);
    const roundResults = await runRound();
    summarize(roundResults);
  }
}

async function onceRound() {
  const results = await runRound();
  summarize(results);
  if (results.length > 0 && results.every((r) => !r.ok)) return 1;
  return 0;
}

// ---------------- 入口 ----------------
(async () => {
  ensureDirs();
  try {
    if (STATUS_MODE) {
      const results = await runRound('status');
      summarize(results, 'status');
      process.exitCode = results.length > 0 && results.every((r) => !r.ok) ? 1 : 0;
    } else if (LOOP) {
      await daemonLoop();
    } else {
      process.exitCode = await onceRound();
    }
  } catch (err) {
    log([`运行时错误: ${err.message || String(err)}`]);
    logCritical('Qoder 运行时错误', err.message || String(err));
    process.exitCode = 1;
  }
})();

/**
 * 每日自动签到脚本（整合版）：Trae Work CN / WorkBuddy
 *
 * 整合自 daily-auto-checkin、trae-auto-signin、workbuddy-auto-signin 三份脚本（已移除 DuMate）。
 * 凭据全部从各应用本地存储实时读取（应用自身负责刷新令牌），脚本不落盘任何令牌。
 *
 * 用法（Node.js >= 18；WorkBuddy 加密凭据路径需 >= 22.5，零第三方依赖）:
 *   node auto-signin.js [--once] [--dry-run] [--only=trae|workbuddy] [--status] [--refresh] [--growth] [--claim]
 *   默认进入守护循环，每天自动签到；--once 只执行一轮立即退出；
 *   --status 仅查询各产品签到状态（只读调试；WorkBuddy 附带成长中心各任务完成情况）；--refresh 强制执行一次 Trae 令牌续期（调试）。
 *   --growth 仅跑 WorkBuddy 成长中心，不签到（原 signin.py growth 模式）；--claim 仅调用 Trae 领取接口（调试，原 signin.js claim 模式）。
 *
 * 特性:
 *   - WorkBuddy：签到 + 成长中心（领 Buddy 旅行礼物 / 派 Buddy 出发 / 开盲盒 / 领任务奖）
 *     凭据获取：优先读 workbuddy-desktop.info 的明文 accessToken；若已被客户端加密
 *     （5.6.2 起为 {"$wbEncrypted":1,"envelope":"..."}，密钥在原生层、独立 Node 取不到），
 *     则自动改从 CodeBuddy CN 的 SecretStorage（state.vscdb）解密同一登录态：
 *     Chromium os_crypt = [3B "v10"][12B nonce][AES-256-GCM 密文][16B tag]，
 *     其 AES-256 密钥存于 Local State 的 os_crypt.encrypted_key（DPAPI 保护）。
 *     DPAPI 优先用 WorkBuddy 自带 koffi 直接调用 crypt32（**不创建子进程**，受限会话亦可），
 *     失败再回退 PowerShell / 内置 Python。
 *   - Trae：签到 + 令牌自动续期（临近过期时用设备密钥对调用官方接口，写回 storage.json）
 *   - 内置每日自动运行（常驻守护，默认每天 09:30，可用环境变量 CHECKIN_TIME / CHECKIN_TIMES 覆盖）
 *   - 幂等保护（已在检查查询层兜底"今日已签到"）
 *   - 防重入锁（lock 目录，避免多实例同时领取）
 *   - 合并关键日志落盘 ~/.daily-checkin/logs/ 与 critical.log 持久文件
 *
 * 环境变量:
 *   CHECKIN_TIME / CHECKIN_TIMES  签到时间点（默认 09:30；后者可配多个，逗号分隔）
 *   CHECKIN_BASE_DIR              状态/日志目录（默认 ~/.daily-checkin）
 *   TRAE_AUTH_FILE                Trae storage.json 路径（默认按已安装版本自动探测）
 *   WORKBUDDY_AUTH_FILE           WorkBuddy 凭据文件路径（默认自动探测）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

// ---------------- CLI / 环境解析 ----------------
const DRY_RUN = process.argv.includes('--dry-run');
const ONCE = process.argv.includes('--once');
const STATUS_MODE = process.argv.includes('--status');
const REFRESH_MODE = process.argv.includes('--refresh');
const GROWTH_MODE = process.argv.includes('--growth'); // 仅跑 WorkBuddy 成长中心（不签到）
const CLAIM_MODE = process.argv.includes('--claim');    // 仅调用 Trae 领取接口（调试）
const LOOP = !ONCE && !STATUS_MODE && !REFRESH_MODE && !GROWTH_MODE && !CLAIM_MODE; // 默认守护循环
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

// 每日自动签到时间点（HH:MM，24 小时制），可由环境变量覆盖
const CHECKIN_TIME = (process.env.CHECKIN_TIME || '09:30').trim();
// 多签到时间点：逗号分隔的 HH:MM 列表，可用 CHECKIN_TIMES 环境变量配置，
// 例如 "00:05,09:30,18:00"（适合想在多个时段补签的场景）。默认仅 09:30 一次。
const CHECKIN_TIMES = (process.env.CHECKIN_TIMES || CHECKIN_TIME)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
// 配置值全为非法（如 "," 或纯空格）过滤后为空时，回退默认 09:30，
// 避免 msUntilNextCheckin 对空列表返回 Infinity 导致 sleep(Infinity) 溢出
if (CHECKIN_TIMES.length === 0) CHECKIN_TIMES.push('09:30');

// 状态/日志基础目录；默认用户主目录，可用环境变量 CHECKIN_BASE_DIR 覆盖
const BASE_DIR = process.env.CHECKIN_BASE_DIR
  ? path.resolve(process.env.CHECKIN_BASE_DIR)
  : path.join(HOME, '.daily-checkin');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const LOCK_DIR = path.join(BASE_DIR, 'locks');
const STATE_FILE = path.join(BASE_DIR, 'state.json');
// CRITICAL 日志：仅记录"间歇性失败/凭证失效"等需要人工关注的信息，可长期保留
const CRITICAL_FILE = path.join(BASE_DIR, 'critical.log');
// Trae 续期时 storage.json 的备份目录
const BACKUP_DIR = path.join(BASE_DIR, 'backups');

function ensureDirs() {
  for (const d of [LOG_DIR, LOCK_DIR]) fs.mkdirSync(d, { recursive: true });
}

// ---------------- 通用工具 ----------------
function pad(n) { return String(n).padStart(2, '0'); }

function tsOf(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 文本形式的"今天日期"，用于幂等/状态记录去重
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

// 记录需要人工关注的关键问题（间歇性失败 / 凭证失效 / 频控），追加写入以便快速查看
function logCritical(title, detail) {
  ensureDirs();
  const line = `[${tsOf()}] ${title}: ${detail}`;
  log([line]);
  fs.appendFileSync(CRITICAL_FILE, line + '\n', 'utf8');
}

// 防重入锁：以产品名为锁名，使用跨平台可靠的"独占创建"语义（不依赖文件锁权限位）
function withLock(name, fn) {
  const lockFile = path.join(LOCK_DIR, `${name}.lock`);
  const token = `${process.pid}-${Date.now()}`;
  // 使用 fs.open 的 wx 标志实现独占创建，比写文件后检查存在更可靠、无竞态
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, token);
    fs.closeSync(fd);
  } catch (err) {
    // 若锁已过期（超过 10 分钟未清理），视为残留锁并接管，避免长期卡死
    let stale = false;
    try {
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      stale = age > 10 * 60 * 1000;
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

// 读取/写入轻量状态文件（用于幂等判断与外部感知）
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
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

// 在可能被 data/result 包裹的响应里找字段，兼容信封结构（移植自 workbuddy-auto-signin）
function dig(obj, key) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    for (const k of ['data', 'result', 'resp', 'response']) {
      const sub = obj[k];
      if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
        const r = dig(sub, key);
        if (r !== null && r !== undefined) return r;
      }
    }
  }
  return null;
}

// 毫秒到 HH 时间文本（用于日志展示）
function hhmmOf(ms) {
  const s = Math.round(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`;
}

// 计算从此刻到下一个签到时间点（HH:MM 列表）的相对毫秒数；当天已过则顺延到明天
function msUntilNextCheckin(timeList) {
  const now = new Date();
  let best = Infinity;
  for (const timeStr of timeList) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(timeStr).trim());
    if (!m) throw new Error(`签到时间格式错误: "${timeStr}"（应为 HH:MM）`);
    const targetH = parseInt(m[1], 10);
    const targetM = parseInt(m[2], 10);
    if (targetH > 23 || targetM > 59) throw new Error(`签到时间越界: "${timeStr}"`);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetH, targetM, 0, 0);
    let diff = today.getTime() - now.getTime();
    if (diff <= 0) diff += 24 * 3600 * 1000; // 今天该点已过，顺延到明天
    if (diff < best) best = diff;
  }
  return best;
}

// ---------------- WorkBuddy ----------------
const WORKBUDDY_DEFAULT_ENDPOINT = 'https://copilot.tencent.com';

// 按平台探测 WorkBuddy 桌面端写出的登录凭据文件，支持环境变量覆盖
function findWorkbuddyAuthFile() {
  const override = process.env.WORKBUDDY_AUTH_FILE;
  if (override) return override;
  const candidates = [
    path.join(LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),  // Windows
    path.join(HOME, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'), // macOS
    path.join(HOME, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'), // Linux
    path.join(HOME, '.workbuddy', 'auth', 'workbuddy-desktop.info'), // 兜底
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// ---------------- WorkBuddy 凭据解密（Chromium os_crypt + Windows DPAPI） ----------------
// 背景：WorkBuddy 桌面端自 5.6.2（2026-09-23 起生效）把 workbuddy-desktop.info 的
// accessToken / refreshToken 由明文改为 at-rest 加密对象 {"$wbEncrypted":1,"envelope":"..."}，
// 其密钥来自定制 Electron 原生绑定（独立 Node 无法获取），脚本读到 [object Object] → 401。
// 但同一登录态在 CodeBuddy CN 扩展的 SecretStorage 中仍以明文语义保存，外层只是
// Chromium os_crypt：[3B "v10"][12B nonce][AES-256-GCM 密文][16B tag]，
// 其 AES-256 密钥存于 Local State 的 os_crypt.encrypted_key（DPAPI 保护，需同机同 Windows 用户）。
// Node 不能直调 DPAPI，故借 PowerShell 的 ProtectedData（主路径，仓库既有做法），
// 受限会话下 PowerShell 可能不可用（EBUSY），回退到内置 Python 的 ctypes 调用同一 API。

const OS_CRYPT_PREFIX = 'DPAPI';
const OS_CRYPT_MAGIC = 'v10';
const CODEBUDDY_CN_DIR = path.join(APPDATA, 'CodeBuddy CN');
const OS_CRYPT_KEY_CACHE = new Map();

function powershellPath() {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

function pythonCandidates() {
  const list = [];
  if (process.env.WORKBUDDY_HELPER_PYTHON) list.push(process.env.WORKBUDDY_HELPER_PYTHON);
  const managed = path.join(HOME, '.workbuddy', 'binaries', 'python', 'versions', '3.13.12', 'python.exe');
  if (fs.existsSync(managed)) list.push(managed);
  list.push('python', 'python3');
  return list;
}

// Python 版 DPAPI（等价于 PowerShell 的 ProtectedData.Unprotect，CurrentUser 作用域）
const DPAPI_PY_SCRIPT = [
  'import ctypes, base64, sys',
  'from ctypes import wintypes',
  'class B(ctypes.Structure):',
  '    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]',
  'd = base64.b64decode(sys.argv[1])',
  'bi = B(len(d), ctypes.cast(ctypes.create_string_buffer(d, len(d)), ctypes.POINTER(ctypes.c_char)))',
  'bo = B()',
  'ok = ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(bi), None, None, None, None, 0, ctypes.byref(bo))',
  'if not ok: raise SystemExit("CryptUnprotectData failed")',
  'buf = ctypes.create_string_buffer(bo.cbData)',
  'ctypes.memmove(buf, bo.pbData, bo.cbData)',
  'ctypes.windll.kernel32.LocalFree(bo.pbData)',
  'sys.stdout.write(base64.b64encode(buf.raw).decode())',
].join('\n');

// WorkBuddy 自带 CLI 里打包了 koffi（FFI 库），可在**不创建子进程**的前提下调用
// crypt32 的 CryptUnprotectData —— 这是最可靠的路径（受限会话会禁止 spawn 子进程）。
let KOFFI_DPAPI;
function loadKoffiDpapi() {
  if (KOFFI_DPAPI !== undefined) return KOFFI_DPAPI;
  const candidates = [];
  if (process.env.WORKBUDDY_KOFFI_PATH) candidates.push(process.env.WORKBUDDY_KOFFI_PATH);
  for (const base of [
    path.join(LOCALAPPDATA, 'Programs', 'WorkBuddy'),
    path.join(LOCALAPPDATA, 'Programs', 'workbuddy'),
  ]) {
    candidates.push(path.join(base, 'resources', 'app.asar.unpacked', 'cli', 'node_modules', 'koffi'));
  }
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const koffi = require(dir);
      const crypt32 = koffi.load('crypt32.dll');
      koffi.struct('DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
      const CryptUnprotectData = crypt32.func('int CryptUnprotectData(_In_ DATA_BLOB *pDataIn, void *p1, DATA_BLOB *p2, void *p3, void *p4, uint32 dwFlags, _Out_ DATA_BLOB *pDataOut)');
      const LocalFree = koffi.load('kernel32.dll').func('void *LocalFree(void *hMem)');
      KOFFI_DPAPI = { koffi, CryptUnprotectData, LocalFree };
      return KOFFI_DPAPI;
    } catch { /* 该候选不可用，尝试下一个 */ }
  }
  KOFFI_DPAPI = false;
  return false;
}

function dpapiUnprotectViaKoffi(body) {
  const m = loadKoffiDpapi();
  if (!m) return null;
  const { koffi, CryptUnprotectData, LocalFree } = m;
  const inBlob = { cbData: body.length, pbData: koffi.as(body, 'void *') };
  const outBlob = { cbData: 0, pbData: null };
  const rc = CryptUnprotectData(inBlob, null, null, null, null, 0, outBlob);
  if (!rc || !outBlob.cbData || !outBlob.pbData) return null;
  try {
    return Buffer.from(koffi.decode(outBlob.pbData, 'uint8', outBlob.cbData));
  } finally {
    try { LocalFree(outBlob.pbData); } catch { /* 忽略 */ }
  }
}

// 用 DPAPI 解开 os_crypt 的 32B AES 密钥；优先 koffi（无子进程），再 PowerShell / Python
function dpapiUnprotect(b64) {
  const errors = [];
  if (process.platform === 'win32') {
    const body = Buffer.from(b64, 'base64');
    try {
      const key = dpapiUnprotectViaKoffi(body);
      if (key && key.length === 32) return key;
      errors.push('koffi: 未返回有效密钥');
    } catch (e) {
      errors.push('koffi: ' + String(e.message || e).slice(0, 120));
    }
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      `$b = [Convert]::FromBase64String('${b64}')`,
      '$k = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Convert]::ToBase64String($k)',
    ].join('; ');
    try {
      const out = execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 30000, windowsHide: true,
      }).trim();
      const key = Buffer.from(out, 'base64');
      if (key.length === 32) return key;
      errors.push(`PowerShell 返回 ${key.length} 字节（期望 32）`);
    } catch (e) {
      errors.push('PowerShell: ' + String(e.stderr || e.message || e).trim().slice(0, 120));
    }
    for (const py of pythonCandidates()) {
      try {
        const out = execFileSync(py, ['-c', DPAPI_PY_SCRIPT, b64], {
          encoding: 'utf8', timeout: 30000, windowsHide: true,
        }).trim();
        const key = Buffer.from(out, 'base64');
        if (key.length === 32) return key;
        errors.push(`${py}: 返回 ${key.length} 字节`);
      } catch (e) {
        errors.push(`${py}: ` + String(e.stderr || e.message || e).trim().slice(0, 120));
      }
    }
  }
  throw new Error('DPAPI 解密 os_crypt 密钥失败（需与登录 CodeBuddy 的同一 Windows 用户）: ' + errors.join(' | '));
}

function osCryptAesKey() {
  const cached = OS_CRYPT_KEY_CACHE.get('codebuddy');
  if (cached) return cached;
  const lsPath = process.env.CODEBUDDY_LOCAL_STATE || path.join(CODEBUDDY_CN_DIR, 'Local State');
  if (!fs.existsSync(lsPath)) throw new Error(`未找到 CodeBuddy CN 的 Local State：${lsPath}`);
  const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
  const b64 = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
  if (!b64) throw new Error('Local State 缺少 os_crypt.encrypted_key');
  const raw = Buffer.from(b64, 'base64');
  if (raw.subarray(0, OS_CRYPT_PREFIX.length).toString() !== OS_CRYPT_PREFIX) {
    throw new Error(`os_crypt 密钥前缀非预期（${raw.subarray(0, 5).toString()}），可能客户端加密方式已变更`);
  }
  const key = dpapiUnprotect(raw.subarray(OS_CRYPT_PREFIX.length).toString('base64'));
  OS_CRYPT_KEY_CACHE.set('codebuddy', key);
  return key;
}

// [3B "v10"][12B nonce][密文][16B tag] → AES-256-GCM 明文
function osCryptDecrypt(blob, key) {
  if (blob.subarray(0, 3).toString() !== OS_CRYPT_MAGIC) {
    throw new Error('密文缺少 v10 头，可能客户端加密方式已变更');
  }
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(15, blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// 从 CodeBuddy CN 的 SecretStorage（state.vscdb）取出登录态原始字节
function readCodeBuddySecretBytes(keyNeedle) {
  const dbPath = process.env.CODEBUDDY_STATE_DB
    || path.join(CODEBUDDY_CN_DIR, 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(dbPath)) throw new Error(`未找到 CodeBuddy 状态库：${dbPath}`);
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch {
    throw new Error('当前 Node 缺少 node:sqlite（需 Node >= 22.5），无法读取 CodeBuddy 状态库');
  }
  const query = (file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const st = db.prepare('SELECT value FROM ItemTable WHERE key LIKE ? ORDER BY length(value) DESC LIMIT 1');
      const row = st.get('%' + keyNeedle + '%');
      return row ? row.value : null;
    } finally { try { db.close(); } catch { /* 忽略关闭异常 */ } }
  };
  let value;
  try {
    value = query(dbPath);
  } catch (e) {
    // 数据库可能被运行中的客户端以写模式占用，复制副本后以只读方式再读
    const tmp = path.join(os.tmpdir(), `wb-state-${process.pid}-${Date.now()}.vscdb`);
    fs.copyFileSync(dbPath, tmp);
    try { value = query(tmp); } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ } }
  }
  if (value == null) throw new Error('状态库中未找到登录态（secret key 缺失），请确认已登录 CodeBuddy CN 客户端');
  if (Buffer.isBuffer(value)) return value;
  const text = String(value);
  // SecretStorage 以 {"type":"Buffer","data":[...]} 形式序列化
  try {
    const obj = JSON.parse(text);
    if (obj && obj.type === 'Buffer' && Array.isArray(obj.data)) return Buffer.from(obj.data);
    if (typeof obj === 'string') return Buffer.from(obj, 'utf8');
  } catch { /* 非 JSON：按原始文本处理 */ }
  return Buffer.from(text, 'utf8');
}

// 还原出与 workbuddy-desktop.info 同结构的登录态（含 account / auth）
function loadWorkbuddySessionFromSecretStore() {
  const keyNeedle = process.env.CODEBUDDY_SECRET_KEY || 'planning-genie.new.accessTokencn';
  const blob = readCodeBuddySecretBytes(keyNeedle);
  const plain = (blob.length > 3 && blob.subarray(0, 3).toString() === OS_CRYPT_MAGIC)
    ? osCryptDecrypt(blob, osCryptAesKey())
    : blob; // 少数版本可能明文存放
  const session = JSON.parse(plain.toString('utf8'));
  if (!session || !session.auth || typeof session.auth.accessToken !== 'string') {
    throw new Error('解密后的登录态结构异常（缺少 auth.accessToken）');
  }
  return session;
}

// 统一入口：优先用旧的明文凭据文件；若其 accessToken 已被加密（$wbEncrypted 对象），
// 则改从 CodeBuddy CN 的 SecretStorage 解密同一登录态。
function resolveWorkbuddySession() {
  const authFile = findWorkbuddyAuthFile();
  if (authFile && fs.existsSync(authFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      if (s && s.auth && typeof s.auth.accessToken === 'string' && s.auth.accessToken) return s;
    } catch { /* 解析失败则走加密路径 */ }
  }
  return loadWorkbuddySessionFromSecretStore();
}

function loadWorkbuddy() {
  const session = resolveWorkbuddySession();
  const auth = session.auth || {};
  const account = session.account || {};
  const token = auth.accessToken;
  const uid = account.uid;
  if (!token || !uid) throw new Error('本地会话缺少 accessToken/uid，请先在 WorkBuddy 客户端登录');
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-User-Id': uid,
    'User-Agent': 'WorkBuddy/5.3.13',
  };
  if (account.enterpriseId) {
    headers['X-Enterprise-Id'] = account.enterpriseId;
    headers['X-Tenant-Id'] = account.enterpriseId;
  }
  if (auth.domain) headers['X-Domain'] = auth.domain;
  const endpoint = String(auth.endpoint || WORKBUDDY_DEFAULT_ENDPOINT).replace(/\/+$/, '');
  return { headers, endpoint };
}

// 领取接口返回是否表示"今日已签"（兼容 2xx+null 与 400+code10001 两种形态，均按"已签"处理）。
// 注意：null 响应体只有在 HTTP 2xx 时才代表"已签"（原 Python 版契约）；
// 5xx 网关错误页/空响应（httpJson 解析失败时 data=null）不算已签，否则漏签会被误报为成功。
function workbuddyIsAlreadyCheckedIn(httpStatus, cbody) {
  if (cbody && typeof cbody === 'object') {
    const msg = cbody.msg || '';
    if (cbody.code === 10001 || String(msg).includes('已签')) return true;
  }
  if (cbody === null || cbody === undefined) {
    return httpStatus >= 200 && httpStatus < 300;
  }
  return false;
}

// 根据状态构造"今日已签"汇报文本
function workbuddyAlreadyReport(status, via) {
  const todayCredit = dig(status, 'today_credit') ?? dig(status, 'daily_credit');
  const streakDays = dig(status, 'streak_days');
  const totalCredits = dig(status, 'total_credits');
  const inner = [];
  if (todayCredit != null) inner.push(`今日 +${todayCredit}`);
  if (streakDays != null) inner.push(`累计签到 ${streakDays} 天`);
  if (totalCredits != null) inner.push(`共 ${totalCredits} 积分`);
  const prefix = via || '今日已签过';
  return inner.length ? `${prefix}（${inner.join('，')}）` : prefix;
}

async function workbuddyCheckin(headers, endpoint) {
  const statusUrl = `${endpoint}/v2/billing/meter/checkin-activity-status`;
  const claimUrl = `${endpoint}/v2/billing/meter/daily-checkin`;

  // 1) 查询签到状态（幂等预检）
  const status = await httpJson(statusUrl, { method: 'POST', headers, body: {} });
  if (status.status === 401 || status.status === 403) {
    throw new Error(`WorkBuddy 登录态已失效（HTTP ${status.status}），请打开 WorkBuddy 客户端重新登录`);
  }
  if (status.status < 200 || status.status >= 300 || !status.data || typeof status.data !== 'object'
    || (status.data.code !== 0 && status.data.code !== undefined)) {
    throw new Error(`查询签到状态失败: HTTP ${status.status}, code=${status.data?.code}, msg=${status.data?.msg}`);
  }
  const st = status.data;
  if (dig(st, 'active') === false) {
    const activityName = dig(st, 'activity_name');
    return '签到活动未开启' + (activityName ? `（${activityName}）` : '');
  }
  if (dig(st, 'today_checked_in') === true || dig(st, 'checked_in') === true) {
    return workbuddyAlreadyReport(st);
  }
  if (DRY_RUN) return '尚未签到（dry-run，跳过领取）';

  // 2) 领取今日积分
  const claim = await httpJson(claimUrl, { method: 'POST', headers, body: {} });
  const cbody = claim.data;
  // 先判定登录态失效（401/403 可能带空响应体，若放在"已签"判断之后会被误判为已签）
  if (claim.status === 401 || claim.status === 403) {
    throw new Error(`WorkBuddy 登录态已失效（HTTP ${claim.status}），请打开 WorkBuddy 客户端重新登录`);
  }
  if (workbuddyIsAlreadyCheckedIn(claim.status, cbody)) {
    // 服务端判定已领取：回查一次状态给出完整汇报
    const fresh = await httpJson(statusUrl, { method: 'POST', headers, body: {} });
    const freshSt = (fresh.status === 200 && fresh.data && typeof fresh.data === 'object'
      && (fresh.data.code === 0 || fresh.data.code === undefined)) ? fresh.data : st;
    return workbuddyAlreadyReport(freshSt, '今日已签过（服务端判定已领取）');
  }
  const credit = dig(cbody, 'credit');
  if (credit != null) {
    // 领取成功：回查状态取累计天数/累计积分
    const fresh = await httpJson(statusUrl, { method: 'POST', headers, body: {} });
    const freshSt = (fresh.status === 200 && fresh.data && typeof fresh.data === 'object'
      && (fresh.data.code === 0 || fresh.data.code === undefined)) ? fresh.data : st;
    const streakDays = dig(freshSt, 'streak_days') ?? dig(st, 'streak_days');
    const totalCredits = dig(freshSt, 'total_credits');
    const isStreakDay = dig(freshSt, 'is_streak_day');
    const bonus = isStreakDay ? '，且为连签奖励日' : '';
    const cum = totalCredits != null ? `，共 ${totalCredits} 积分` : '';
    return `成功领取 ${credit} 积分${bonus}（累计签到 ${streakDays ?? '?'} 天${cum}）`;
  }
  if (cbody && typeof cbody === 'object' && ('code' in cbody || 'msg' in cbody)) {
    throw new Error(`领取失败：${cbody.msg || `code ${cbody.code}`}（HTTP ${claim.status}）`);
  }
  // 非 JSON 响应（如 5xx 网关错误页）或无法识别的结构：带状态码与原始片段报错，进 critical.log
  const detail = cbody != null ? JSON.stringify(cbody) : String(claim.text || '').trim();
  throw new Error(`未识别的领取返回（HTTP ${claim.status}）: ${detail.slice(0, 200)}`);
}

// 成长中心自动化：领旅行礼物→派 Buddy 出发→开盲盒→领任务奖（移植自 workbuddy-auto-signin）
async function workbuddyGrowth(headers, endpoint) {
  const base = `${endpoint}/v2/activity/growth`;
  const parts = [];
  let creditsGained = 0;

  // --- 1. Buddy 旅行：领礼物 + 派出发 ---
  const s = await httpJson(`${base}/buddy/travel/status`, { method: 'GET', headers });
  if (s.status === 401 || s.status === 403) {
    throw new Error(`登录态已失效（HTTP ${s.status}），请重新登录 WorkBuddy 桌面端`);
  }
  let travel = (s.status >= 200 && s.status < 300 && s.data) ? dig(s.data, 'state') : null;

  if (travel === 'arrived') {
    const recordId = dig(s.data, 'record_id');
    const c = await httpJson(`${base}/buddy/travel/claim`, { method: 'POST', headers, body: { record_id: recordId ?? null } });
    const got = (c.status >= 200 && c.status < 300) ? dig(c.data, 'reward_credit') : null;
    if (got != null) {
      creditsGained += got;
      parts.push(`领旅行礼物 +${got} 积分`);
    } else {
      parts.push(`领旅行礼物失败（HTTP ${c.status}）`);
    }
    travel = 'idle'; // 领完后变 idle
  }
  if (travel === 'idle') {
    // 今日旅行次数已用完时不再尝试派发（服务端会拒绝）
    if (dig(s.data, 'daily_limit_reached') === true) {
      parts.push('Buddy 旅行今日次数已用完');
    } else {
      const cfg = await httpJson(`${base}/buddy/travel/config`, { method: 'GET', headers });
      const locs = (cfg.status >= 200 && cfg.status < 300) ? dig(cfg.data, 'locations') : null;
      if (Array.isArray(locs) && locs.length > 0) {
        const loc = locs[0];
        const dep = await httpJson(`${base}/buddy/travel/depart`, { method: 'POST', headers, body: { location_id: loc.id ?? null } });
        if (dep.status >= 200 && dep.status < 300) {
          const dLoc = dig(dep.data, 'location') || {};
          const locName = dLoc.name ?? '?';
          const dur = dig(dep.data, 'duration_hours') ?? dLoc.duration_hours ?? '?';
          parts.push(`派 Buddy 去${locName}（${dur} 小时后回）`);
        } else {
          const msg = dig(dep.data, 'msg') || '';
          parts.push(`派 Buddy 失败：${msg || `HTTP ${dep.status}`}`);
        }
      }
    }
  } else if (travel === 'traveling') {
    const locName = (dig(s.data, 'location') || {}).name ?? '?';
    parts.push(`Buddy 旅行中（${locName}）`);
  }

  // --- 2. 盲盒/抽奖 ---
  const l = await httpJson(`${base}/lottery/chances`, { method: 'GET', headers });
  const chances = (l.status >= 200 && l.status < 300) ? dig(l.data, 'balance') : 0;
  if (chances && chances > 0) {
    const d = await httpJson(`${base}/lottery/draw`, { method: 'POST', headers, body: {} });
    if (d.status >= 200 && d.status < 300) {
      let prize = dig(d.data, 'prize_name') ?? dig(d.data, 'prize') ?? '未知';
      if (prize && typeof prize === 'object') prize = JSON.stringify(prize);
      parts.push(`开盲盒获得：${prize}`);
    } else {
      parts.push(`开盲盒失败（HTTP ${d.status}）`);
    }
  }

  // --- 3. 任务领奖 ---
  const t = await httpJson(`${base}/tasks`, { method: 'GET', headers });
  if (t.status >= 200 && t.status < 300) {
    const tasks = dig(t.data, 'tasks') || [];
    for (const task of tasks) {
      const prog = task.progress || {};
      const done = (prog.current ?? 0) >= (prog.target ?? 1);
      if (done && task.accept_status !== 'claimed' && task.has_reward) {
        const a = await httpJson(`${base}/tasks/accept`, { method: 'POST', headers, body: { task_code: task.task_code ?? null } });
        if (a.status >= 200 && a.status < 300) {
          const rc = task.reward_credit ?? 0;
          const re = task.reward_energy ?? 0;
          creditsGained += rc;
          parts.push(`领任务奖「${task.title || task.task_code}」+积分${rc}+能量${re}`);
        }
      }
    }
  }

  // --- 4. 能量 & 连签状态 ---
  const e = await httpJson(`${base}/energy`, { method: 'GET', headers });
  const energy = (e.status >= 200 && e.status < 300) ? dig(e.data, 'balance') : null;
  const s2 = await httpJson(`${base}/streak`, { method: 'GET', headers });
  const streakObj = dig(s2.data, 'streak');
  const streakDays = (streakObj && typeof streakObj === 'object' && !Array.isArray(streakObj))
    ? (streakObj.days ?? null) : null;

  const tail = [];
  if (energy != null) tail.push(`能量 ${energy}`);
  if (streakDays != null) tail.push(`连签 ${streakDays} 天`);
  if (creditsGained) tail.push(`本次 +共 ${creditsGained} 积分`);

  let report = parts.length ? parts.join('；') : '成长中心无可领取项';
  if (tail.length) report += `（${tail.join('，')}）`;
  return { report, creditsGained };
}

async function checkinWorkbuddy() {
  const { headers, endpoint } = loadWorkbuddy();
  let msg = await workbuddyCheckin(headers, endpoint);
  if (DRY_RUN) return msg;

  // 签到后顺带跑成长中心（成长礼物的领取与签到相互独立）；报告始终附加，便于核对做没做
  try {
    const g = await workbuddyGrowth(headers, endpoint);
    msg += '；[成长中心] ' + g.report;
  } catch (err) {
    const gmsg = err.message || String(err);
    msg += `；[成长中心失败] ${gmsg}`;
    if (/(过期|失效|重新登录)/.test(gmsg)) logCritical('WorkBuddy 成长中心', gmsg);
  }
  return msg;
}

async function workbuddyStatus() {
  const { headers, endpoint } = loadWorkbuddy();
  const r = await httpJson(`${endpoint}/v2/billing/meter/checkin-activity-status`, { method: 'POST', headers, body: {} });
  const growth = await workbuddyGrowthStatus(headers, endpoint);
  return { http: r.status, body: r.data, growth };
}

// 成长中心各子任务状态（只读查询，不领取）：逐项汇报"做没做"
async function workbuddyGrowthStatus(headers, endpoint) {
  const base = `${endpoint}/v2/activity/growth`;
  const lines = [];

  // 1. Buddy 旅行
  const s = await httpJson(`${base}/buddy/travel/status`, { method: 'GET', headers });
  const state = (s.status >= 200 && s.status < 300 && s.data) ? dig(s.data, 'state') : null;
  if (state === 'arrived') {
    lines.push(`Buddy 旅行: 已到达，礼物待领取（+${dig(s.data, 'reward_credit') ?? '?'} 积分）→ [未做] 领礼物`);
  } else if (state === 'traveling') {
    const loc = dig(s.data, 'location') || {};
    lines.push(`Buddy 旅行: 旅行中（${loc.name ?? '?'}）→ [已做] 派出`);
  } else if (state === 'idle') {
    // daily_limit_reached=true 表示今日旅行次数已用完（已派过并领回），并非"未做"
    const limitReached = dig(s.data, 'daily_limit_reached') === true;
    lines.push(limitReached
      ? 'Buddy 旅行: 待命中（今日次数已用完）→ [已做] 今日旅行已完成'
      : 'Buddy 旅行: 待命中 → [未做] 派 Buddy 出发');
  } else {
    lines.push(`Buddy 旅行: 状态未知（state=${state}, HTTP ${s.status}）`);
  }

  // 2. 盲盒
  const l = await httpJson(`${base}/lottery/chances`, { method: 'GET', headers });
  const chances = (l.status >= 200 && l.status < 300) ? dig(l.data, 'balance') : null;
  if (chances == null) {
    lines.push(`盲盒: 查询失败（HTTP ${l.status}）`);
  } else {
    lines.push(`盲盒: 剩余 ${chances} 次${chances > 0 ? ' → [未做] 可抽' : ' → [已做] 抽完/无次数'}`);
  }

  // 3. 任务领奖
  const t = await httpJson(`${base}/tasks`, { method: 'GET', headers });
  if (t.status >= 200 && t.status < 300 && t.data) {
    const tasks = dig(t.data, 'tasks') || [];
    const claimed = [];
    const claimable = [];
    const unfinished = [];
    for (const task of tasks) {
      const prog = task.progress || {};
      const finished = (prog.current ?? 0) >= (prog.target ?? 1);
      const label = task.title || task.task_code;
      if (task.accept_status === 'claimed') claimed.push(label);
      else if (finished && task.has_reward) claimable.push(label);
      else unfinished.push(`${label}(${prog.current ?? 0}/${prog.target ?? 1})`);
    }
    let line = `任务: 共 ${tasks.length} 项，已领奖 ${claimed.length}`;
    if (claimable.length) line += ` → [未做] 待领: ${claimable.join('、')}`;
    if (unfinished.length) line += `；未完成: ${unfinished.join('、')}`;
    lines.push(line);
  } else {
    lines.push(`任务: 查询失败（HTTP ${t.status}）`);
  }

  // 4. 能量 & 连签
  const e = await httpJson(`${base}/energy`, { method: 'GET', headers });
  const energy = (e.status >= 200 && e.status < 300) ? dig(e.data, 'balance') : null;
  if (energy != null) lines.push(`能量: ${energy}`);
  return lines;
}

// 仅跑成长中心，不签到（--growth 独立入口，对应原 signin.py growth 模式）；
// dry-run 时降级为只读状态查询
async function workbuddyGrowthOnly() {
  const { headers, endpoint } = loadWorkbuddy();
  if (DRY_RUN) {
    const lines = await workbuddyGrowthStatus(headers, endpoint);
    return '（dry-run 只读）' + lines.join('；');
  }
  const g = await workbuddyGrowth(headers, endpoint);
  return g.report;
}

// ---------------- Trae Work CN ----------------
// Trae 前端内置的 2 个 64 字节 salt（tc 格式密钥派生用）
const TRAE_SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const TRAE_SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);
const TRAE_CLIENT_ID = 'en1oxy7wnw8j9n'; // TRAE SOLO CN (Lite) 稳定渠道 ClientID

// 已安装版本目录（Roaming 下）→ 展示名
const TRAE_EDITION_DIRS = [
  ['TRAE SOLO CN', 'Trae Work CN (TRAE SOLO CN)'],
  ['Trae CN', 'Trae CN'],
  ['TRAE SOLO', 'TRAE SOLO'],
  ['Trae', 'Trae'],
];

// 探测各 Trae 版本写出的 storage.json，支持环境变量覆盖
function findTraeAuthFile() {
  const override = process.env.TRAE_AUTH_FILE;
  if (override) return { file: override, edition: 'TRAE_AUTH_FILE' };
  for (const [dir, edition] of TRAE_EDITION_DIRS) {
    const c = path.join(APPDATA, dir, 'User', 'globalStorage', 'storage.json');
    if (fs.existsSync(c)) return { file: c, edition };
  }
  return { file: null, edition: null };
}

function traeSha512(buf) {
  return new Uint8Array(crypto.createHash('sha512').update(Buffer.from(buf)).digest());
}

// tc 格式密钥派生：SHA-512(随机32B) 拼接 XOR salt 再 SHA-512，取前 32B（key+iv）
function traeDeriveKeyIV(random32) {
  const pad64 = new Uint8Array(64);
  for (let i = 0; i < 64; i++) pad64[i] = TRAE_SALT_A[i] ^ TRAE_SALT_B[i];
  const n = new Uint8Array(128);
  n.set(traeSha512(random32), 0);
  n.set(pad64, 64);
  n.set(traeSha512(n), 0);
  return { key: Buffer.from(n.slice(0, 16)), iv: Buffer.from(n.slice(16, 32)) };
}

// 解密 storage 加密值：[6B头][32B随机数][AES-128-CBC密文]，明文前 64B 为 SHA-512 校验。
// 已知两种头部格式（tc 与 private），均使用 SALT_A^SALT_B 派生密钥。
function traeDecryptBlob(b64) {
  const t = Buffer.from(b64, 'base64');
  const isTc = t[0] === 0x74 && t[1] === 0x63; // "tc"
  const isPrivate = t[0] === 18 && t[1] === 57 && t[2] === 32 && t[3] === 32 && t[4] === 2 && t[5] === 3;
  if (!isTc && !isPrivate) {
    throw new Error('未知的加密格式（头部 ' + t.subarray(0, 6).toString('hex') + '），可能需要更新脚本');
  }
  const { key, iv } = traeDeriveKeyIV(t.subarray(6, 38));
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(t.subarray(38)), decipher.final()]);
  const hash = traeSha512(plain.subarray(64));
  for (let i = 0; i < 64; i++) if (hash[i] !== plain[i]) throw new Error('解密校验失败');
  return plain.subarray(64).toString('utf8');
}

// Trae 凭据 blob 的加密（traeDecryptBlob 的逆运算）。
// header 保留原 blob 的前 6 字节（版本标识），随后是 32 字节随机密钥 + AES-128-CBC 密文，
// 明文 = sha512(json) 64 字节 + json。
function traeEncryptBlob(json, oldB64) {
  const old = Buffer.from(oldB64, 'base64');
  const header = old.subarray(0, 6);
  const random32 = crypto.randomBytes(32);
  const { key, iv } = traeDeriveKeyIV(random32);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const jsonBuf = Buffer.from(json, 'utf8');
  const plain = Buffer.concat([Buffer.from(traeSha512(jsonBuf)), jsonBuf]);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, random32, ct]).toString('base64');
}

// 读取 storage.json 并解密认证信息（SG 版直接存明文 JSON，CN 版为 tc 加密）
function loadTrae() {
  const { file, edition } = findTraeAuthFile();
  if (!file || !fs.existsSync(file)) {
    throw new Error('未找到 Trae 登录凭据。请先在本机登录 Trae 客户端（已探测目录: '
      + TRAE_EDITION_DIRS.map(([d]) => d).join(' / ')
      + '），或设置环境变量 TRAE_AUTH_FILE 指向 storage.json');
  }
  const storage = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = storage['iCubeAuthInfo://icube.cloudide'];
  if (!raw) {
    throw new Error('storage.json 中未找到 iCubeAuthInfo://icube.cloudide，请先在 Trae 客户端登录');
  }
  const info = JSON.parse(String(raw).trim().startsWith('{') ? raw : traeDecryptBlob(raw));
  if (!info.token) throw new Error('Trae 登录信息中缺少 token');
  return { storagePath: file, edition, storage, info };
}

// 提取 Trae 的 AHA 设备 ID：
// 1) storage.json 中 iCubeAuthInfo://icube-dc:<设备ID> 键名（主来源，稳定）
// 2) 回退：解析最近的 Trae 客户端日志中 [ICDRS] 设备注册记录
// 3) 兜底：telemetry.devDeviceId（旧值，可能导致 9074 风控）
function extractTraeDeviceId(storage) {
  const keyHit = /iCubeAuthInfo:\/\/icube-dc:(\d+)/.exec(Object.keys(storage).join('\n'));
  if (keyHit) return keyHit[1];
  try {
    for (const [dir] of TRAE_EDITION_DIRS) {
      const logsDir = path.join(APPDATA, dir, 'logs');
      let sessions;
      try { sessions = fs.readdirSync(logsDir); } catch { continue; }
      const candidates = sessions
        .filter((n) => /^\d{8}T\d{6}$/.test(n))
        .sort()
        .reverse()
        .slice(0, 5);
      for (const s of candidates) {
        const mainLog = path.join(logsDir, s, 'main.log');
        if (!fs.existsSync(mainLog)) continue;
        const fd = fs.openSync(mainLog, 'r');
        try {
          const buf = Buffer.alloc(262144);
          const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
          const head = buf.subarray(0, bytes).toString('utf8');
          const m = /\[ICDRS\] \(constructor\) did: (\d+)/.exec(head)
            || /\[ICDRS\] \(init\) initialization done, did: (\d+)/.exec(head);
          if (m) return m[1];
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  } catch { /* 日志不可读时走兜底 */ }
  return storage['telemetry.devDeviceId'] || storage['telemetry.machineId'] || '';
}

// Trae 客户端是否正在运行（刷新令牌时会轮换 refresh token，
// 客户端运行期间写回 storage.json 会被其退出时的内存态覆盖，导致互相失效）
function isTraeRunning() {
  try {
    const cmd = process.platform === 'win32' ? 'tasklist /NH' : 'ps -ef';
    const out = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    return /trae/i.test(out);
  } catch {
    return false; // 无法检测时不阻止签到（续期逻辑自行兜底）
  }
}

function buildTraeHeaders(token, deviceId) {
  // 应用本体发送的 x-device-id 是 AHA 设备注册服务的数字设备 ID（纯数字），
  // 不是 telemetry.devDeviceId 的 UUID。发送错误/未注册的设备 ID 会被服务端风控软拒，
  // 返回业务码 9074「当前参与用户太多」（缺失则报 9004 订单参数错误）。
  return {
    'Content-Type': 'application/json',
    authorization: `Cloud-IDE-JWT ${token}`,
    ...(deviceId ? { 'x-device-id': deviceId } : {}),
    'x-device-type': 'Windows',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

// Trae 令牌自动续期：
// 逆向自客户端 oauth 模块 —— POST {host}/trae/api/v3/oauth/ExchangeToken，
// 请求需设备密钥对（存储于 iCubeAuthInfo://icube-dc:<设备ID>）对
// "POST\n路径\nClientID\nrefreshToken\n时间戳\n随机数" 做 ECDSA-P256/sha256 签名。
// 续期成功后把新令牌按原格式加密写回 storage.json（客户端下次启动直接可用）。
// 触发条件：令牌剩余有效期不足 24 小时（或已过期但 refresh token 仍有效）且客户端未运行；
// force=true 时无视剩余时间强制执行。
async function refreshTraeTokenIfNeeded(storagePath, storage, info, deviceId, force = false) {
  const remainMs = Date.parse(info.expiredAt) - Date.now();
  if (!force && Number.isFinite(remainMs) && remainMs > 24 * 3600 * 1000) return null; // 未到期，无需续期
  if (!info.refreshToken) throw new Error('令牌临近过期但缺少 refreshToken，请打开 Trae 客户端登录一次');
  if (info.refreshExpiredAt && Date.now() > Date.parse(info.refreshExpiredAt)) {
    throw new Error('refresh token 已过期，请打开 Trae 客户端重新登录');
  }
  if (isTraeRunning()) {
    return { skipped: true, msg: 'Trae 客户端正在运行，跳过脚本续期（客户端会自行续期）' };
  }

  const kpKey = `iCubeAuthInfo://icube-dc:${deviceId}`;
  const kpBlob = deviceId ? storage[kpKey] : null;
  if (!kpBlob) {
    throw new Error('未找到 Trae 设备密钥对（' + (deviceId ? kpKey : 'iCubeAuthInfo://icube-dc:<设备ID>') + '），请打开 Trae 客户端重新登录');
  }
  const kp = JSON.parse(traeDecryptBlob(kpBlob));
  if (!kp.privateKeyPEM || !kp.publicKeyPEM) throw new Error('设备密钥对内容异常');

  const ideVersion = storage['iCubeLastVersion'] || '2.3.78099';
  const host = (info.host || 'https://api.trae.cn').replace(/\/+$/, '');
  const urlPath = '/trae/api/v3/oauth/ExchangeToken';

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  // 签名载荷：POST\n路径\nClientID\nrefreshToken\n时间戳\n随机数
  const payload = ['POST', urlPath, TRAE_CLIENT_ID, info.refreshToken, String(timestamp), nonce].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(payload), kp.privateKeyPEM).toString('base64');

  const cpuModel = (os.cpus()[0] || {}).model || '';
  const body = {
    ClientID: TRAE_CLIENT_ID,
    ClientSecret: '',
    RefreshToken: info.refreshToken,
    DeviceInfo: {
      DeviceID: deviceId,
      MachineID: storage['telemetry.machineId'] || '',
      PlatformCode: 'SOLO_PC',
      DeviceType: 'PC',
      DeviceName: process.env.USERNAME || process.env.USER || '',
      DeviceModel: '',
      ClientVersion: ideVersion,
      DevicePublicKey: kp.publicKeyPEM,
      DeviceBrand: '',
      DeviceCPU: cpuModel,
      OSInfo: 'Windows',
      OSVersion: os.release(),
    },
    DeviceProof: { Signature: signature, Timestamp: timestamp, Nonce: nonce },
    IDEVersion: ideVersion,
  };

  const res = await httpJson(`${host}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cloudide-token': info.token },
    body,
  });
  const errCode = res.data?.ResponseMetadata?.Error?.Code;
  if (errCode) {
    throw new Error(`Trae 令牌续期失败: ${errCode} ${res.data.ResponseMetadata.Error.Message || ''}`);
  }
  const r = res.data?.Result;
  if (!r || !r.Token || !r.RefreshToken) throw new Error('Trae 令牌续期响应异常: ' + JSON.stringify(res.data).slice(0, 200));

  // 校验新令牌有效（等价于客户端续期后的 GetUserInfo 步骤）
  const verify = await httpJson(`${host}/cloudide/api/v3/trae/GetUserInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cloudide-token': r.Token },
    body: { ReqSource: 'Lite', IDEVersion: ideVersion },
  });
  if (verify.data?.ResponseMetadata?.Error?.Code || !verify.data?.Result?.UserID) {
    throw new Error('Trae 新令牌校验失败: ' + JSON.stringify(verify.data).slice(0, 200));
  }
  if (verify.data.Result.UserID !== info.userId) {
    throw new Error(`续期返回的账号(${verify.data.Result.UserID})与当前账号(${info.userId})不一致，已放弃写回`);
  }

  // 按客户端 X9 结构重建令牌信息（account 保持原值，属同一账号的展示信息）
  const nowMs = Date.now();
  const expireAtMs = Number(r.TokenExpireAt);
  const expireDur = Number(r.TokenExpireDuration);
  const expiredAt = (Number.isFinite(expireAtMs) && nowMs > expireAtMs && Number.isFinite(expireDur))
    ? new Date(nowMs + expireDur).toISOString()
    : Number.isFinite(expireAtMs) ? new Date(expireAtMs).toISOString()
    : new Date(nowMs + 7 * 86400000).toISOString(); // 字段缺失时的保守兜底
  const refreshExpMs = Date.parse(r.RefreshExpireAt);
  const refreshExpiredAt = Number.isFinite(refreshExpMs)
    ? new Date(refreshExpMs).toISOString()
    : new Date(nowMs + 30 * 86400000).toISOString();
  const newInfo = {
    token: r.Token,
    refreshToken: r.RefreshToken,
    expiredAt,
    refreshExpiredAt,
    tokenReleaseAt: new Date().toISOString(),
    userId: info.userId,
    host: info.host,
    userRegion: info.userRegion,
    account: info.account,
  };

  // 备份后原子写回（保持 storage.json 的 4 空格缩进格式）
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(storagePath, path.join(BACKUP_DIR, `storage.json.${todayStr().replace(/-/g, '')}.${Date.now()}.bak`));
  const fresh = JSON.parse(fs.readFileSync(storagePath, 'utf8')); // 防御并发修改
  fresh['iCubeAuthInfo://icube.cloudide'] = traeEncryptBlob(JSON.stringify(newInfo), storage['iCubeAuthInfo://icube.cloudide']);
  fs.writeFileSync(storagePath, JSON.stringify(fresh, null, 4), 'utf8');

  // 写回后立即复核：能解密且令牌字段正确
  const reread = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const check = JSON.parse(traeDecryptBlob(reread['iCubeAuthInfo://icube.cloudide']));
  if (check.token !== newInfo.token || check.refreshToken !== newInfo.refreshToken) {
    throw new Error('写回 storage.json 后复核失败，请从备份恢复: ' + BACKUP_DIR);
  }
  log(['Trae 令牌自动续期成功，新有效期至 ' + expiredAt]);
  return newInfo;
}

async function checkinTrae() {
  const { storagePath, storage, info } = loadTrae();
  const deviceId = extractTraeDeviceId(storage);
  const host = (info.host || 'https://api.trae.cn').replace(/\/+$/, '');

  // 令牌临近过期/已过期时自动续期（客户端未运行时），续期成功则使用新令牌
  if (!DRY_RUN) {
    try {
      const refreshed = await refreshTraeTokenIfNeeded(storagePath, storage, info, deviceId);
      if (refreshed && !refreshed.skipped) Object.assign(info, refreshed);
      else if (refreshed && refreshed.skipped) log([refreshed.msg]);
    } catch (err) {
      logCritical('Trae 令牌自动续期失败', String(err.message || err));
      log(['[警告] Trae 令牌自动续期失败: ' + (err.message || err)]);
    }
  }

  if (info.expiredAt && Date.now() > Date.parse(info.expiredAt)) {
    throw new Error('Trae 令牌已过期且自动续期未成功，请打开 Trae 客户端刷新登录');
  }

  const headers = buildTraeHeaders(info.token, deviceId);

  const status = await httpJson(`${host}/trae/api/v2/ug/checkin_credits/status`, { method: 'POST', headers, body: {} });
  if (status.status === 401 || status.status === 403) {
    throw new Error(`Trae 登录态已失效（HTTP ${status.status}），请打开 Trae 客户端重新登录`);
  }
  if (!status.data || typeof status.data !== 'object') {
    throw new Error('接口响应异常(非JSON)，请检查网络');
  }
  const st = status.data;
  if (st.code === 1001) {
    throw new Error('Trae 凭证已过期，请打开 Trae 客户端重新登录一次');
  }
  if (st.code === 9074 || /频繁/.test(String(st.message || st.msg || ''))) {
    return '命中风控 9074（多为设备指纹校验未通过，请重启一次 Trae 客户端后重试）';
  }
  if (st.code !== 0 && st.code !== undefined) {
    throw new Error(`查询签到状态失败: code=${st.code}, message=${st.message || st.msg || ''}`);
  }
  const stData = st.data || st;
  if (stData.enable === false) {
    return '签到功能未开放';
  }
  if (stData.checked_in) {
    const credits = stData.credits ?? stData.points ?? '?';
    const days = stData.continuous_days ?? stData.continuousDays ?? stData.streak ?? '?';
    const extras = [];
    if (credits !== '?') extras.push(`积分 ${credits}`);
    if (days !== '?') extras.push(`连签 ${days} 天`);
    return `今日已签到${extras.length ? `（${extras.join(' / ')}）` : ''}，无需重复领取`;
  }
  if (DRY_RUN) return '尚未签到（dry-run，跳过领取）';

  // 领取命中服务端量控(9074)时，做有界间隔重试：9074 是瞬时并发/容量闸门，
  // 未必立刻解锁。采用递增间隔、限制次数，避免高频盲试触发更严风控；仍失败则留给次日。
  const retryDelays = [10, 15, 22, 30, 40, 55];
  let cl = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    const claim = await httpJson(`${host}/trae/api/v2/ug/checkin_credits/claim`, {
      method: 'POST', headers, body: {},
    });
    if (claim.status === 401 || claim.status === 403) {
      throw new Error(`Trae 登录态已失效（HTTP ${claim.status}），请打开 Trae 客户端重新登录`);
    }
    if (!claim.data || typeof claim.data !== 'object') {
      throw new Error('接口响应异常(非JSON)，请检查网络');
    }
    cl = claim.data;
    if (cl.code === 1001) {
      throw new Error('Trae 凭证已过期，请打开 Trae 客户端重新登录一次');
    }
    const isThrottle =
      cl.code === 9074 ||
      /频繁/.test(String(cl.message || '')) ||
      /频繁/.test(String(cl.msg || ''));
    if (!isThrottle) break; // 非频控结果，跳出重试
    if (attempt < retryDelays.length) await sleep(retryDelays[attempt] * 1000);
  }
  if (cl.code === 9074 || /频繁/.test(String(cl.message || cl.msg || ''))) {
    return '命中风控 9074（设备指纹校验未通过；重启 Trae 客户端可刷新设备注册），余下次日定时任务自动重试';
  }
  if (cl.code !== 0) {
    throw new Error(`签到失败: code=${cl.code}, message=${cl.message || cl.msg || ''}`);
  }
  // 领取成功后回查一次状态，取最新积分（claim 响应通常只含 code/message）
  const r2 = await httpJson(`${host}/trae/api/v2/ug/checkin_credits/status`, { method: 'POST', headers, body: {} });
  const fresh = (r2.status === 200 && r2.data && typeof r2.data === 'object' && (r2.data.data || r2.data)) || stData;
  const credits = fresh.credits ?? stData.credits ?? '?';
  return credits !== '?' ? `签到成功，积分 +${credits}` : '签到成功';
}

async function traeStatus() {
  const { storage, info } = loadTrae();
  const deviceId = extractTraeDeviceId(storage);
  const host = (info.host || 'https://api.trae.cn').replace(/\/+$/, '');
  const r = await httpJson(`${host}/trae/api/v2/ug/checkin_credits/status`, {
    method: 'POST', headers: buildTraeHeaders(info.token, deviceId), body: {},
  });
  return { http: r.status, body: r.data };
}

// 仅领取签到（--claim 调试入口，对应原 signin.js claim 模式）：
// 单次调用领取接口并输出原始响应（不走状态预检/频控重试/令牌续期）；
// dry-run 时降级为只查状态，不实际领取
async function traeClaim() {
  const { storage, info } = loadTrae();
  const deviceId = extractTraeDeviceId(storage);
  const host = (info.host || 'https://api.trae.cn').replace(/\/+$/, '');
  const headers = buildTraeHeaders(info.token, deviceId);
  if (DRY_RUN) {
    const r = await httpJson(`${host}/trae/api/v2/ug/checkin_credits/status`, { method: 'POST', headers, body: {} });
    return { http: r.status, body: r.data, note: 'dry-run: 跳过领取，仅查状态' };
  }
  const c = await httpJson(`${host}/trae/api/v2/ug/checkin_credits/claim`, { method: 'POST', headers, body: {} });
  return { http: c.status, body: c.data };
}

// 强制执行一次 Trae 令牌续期（--refresh 调试入口）
async function traeRefresh() {
  const { storagePath, storage, info } = loadTrae();
  const deviceId = extractTraeDeviceId(storage);
  const r = await refreshTraeTokenIfNeeded(storagePath, storage, info, deviceId, true);
  if (!r) return '无需续期（令牌仍在有效期内）';
  if (r.skipped) return r.msg;
  return '令牌续期成功，新有效期至 ' + r.expiredAt;
}

// ---------------- 签到编排 ----------------
const PRODUCTS = [
  { name: 'WorkBuddy', run: checkinWorkbuddy, status: workbuddyStatus, growth: workbuddyGrowthOnly },
  { name: 'Trae Work CN', run: checkinTrae, status: traeStatus, refresh: traeRefresh, claim: traeClaim },
];

function parseOnly() {
  let only = '';
  const onlyEq = process.argv.find((a) => a.startsWith('--only='));
  if (onlyEq) {
    only = onlyEq.split('=')[1].toLowerCase();
  } else {
    const onlyIdx = process.argv.indexOf('--only');
    if (onlyIdx >= 0 && process.argv[onlyIdx + 1]) only = process.argv[onlyIdx + 1].toLowerCase();
  }
  return only;
}

function filterProducts(mode = 'auto') {
  const only = parseOnly();
  // 按模式先收敛到具备该能力的产品（growth 仅 WorkBuddy / claim 仅 Trae）
  let pool = PRODUCTS;
  if (mode === 'growth') pool = PRODUCTS.filter((p) => p.growth);
  if (mode === 'claim') pool = PRODUCTS.filter((p) => p.claim);
  if (!only) return pool;
  return pool.filter((p) => p.name.toLowerCase().includes(only));
}

// 执行一轮（mode: auto=签到 / status=查状态 / refresh=强制续期 / growth=仅成长中心 / claim=仅领取调试），返回结果数组
async function runRound(mode = 'auto') {
  const products = filterProducts(mode);
  if (products.length === 0) {
    log([`未找到匹配 --only=${parseOnly()} 的产品（可用: trae / workbuddy）`]);
    return [];
  }
  const results = [];
  for (const p of products) {
    try {
      // 每个产品之间加随机 2~8 秒间隔，避免整齐划一的请求特征
      await sleep(2000 + Math.floor(Math.random() * 6000));
      let msg;
      if (mode === 'status') {
        const s = await withLock(p.name, p.status);
        // WorkBuddy 会附带成长中心各任务"做没做"的逐项状态，逐行展示
        const { growth, ...brief } = s;
        results.push({ name: p.name, ok: true, msg: JSON.stringify(brief) });
        for (const g of growth || []) results.push({ name: `${p.name} 成长中心`, ok: true, msg: g });
        continue;
      } else if (mode === 'refresh') {
        if (!p.refresh) {
          results.push({ name: p.name, ok: true, msg: '无令牌续期能力，跳过' });
          continue;
        }
        msg = await withLock(p.name, p.refresh);
      } else if (mode === 'growth') {
        msg = await withLock(p.name, p.growth);
      } else if (mode === 'claim') {
        msg = JSON.stringify(await withLock(p.name, p.claim));
      } else {
        msg = await withLock(p.name, p.run);
      }
      results.push({ name: p.name, ok: true, msg });
    } catch (err) {
      const msg = err.message || String(err);
      results.push({ name: p.name, ok: false, msg });
      // 凭证缺失/失效/频控/漏签（如领取接口 5xx 网关错误导致的未识别返回）均可间歇发生，写入 CRITICAL 以便人工关注
      if (/(过期|失效|频控|重新登录|强制退出|未登录|未找到|未识别)/.test(msg)) {
        logCritical(p.name, msg);
      }
    }
  }
  return results;
}

function summarize(results, mode = 'auto') {
  if (results.length === 0) return;
  if (mode === 'auto') {
    // 落盘状态：记录最后一次全天执行的状态，便于外部/后续轮次感知
    const state = readState();
    const successCount = results.filter((r) => r.ok).length;
    state.lastRun = {
      when: tsOf(),
      date: todayStr(),
      mode: DRY_RUN ? 'dry-run' : 'real',
      success: successCount,
      total: results.length,
      detail: results.map((r) => ({ name: r.name, ok: r.ok, msg: r.msg })),
    };
    writeState(state);
  }
  const successCount = results.filter((r) => r.ok).length;
  const lines = results.map((r) => {
    const tag = !r.ok ? '[失败]'
      : mode === 'status' ? '[状态]'
      : mode === 'refresh' ? '[续期]'
      : mode === 'growth' ? '[成长]'
      : mode === 'claim' ? '[领取]'
      : '[成功]';
    return `${tag} ${r.name}: ${r.msg}`;
  });
  lines.push(`本轮汇总: ${successCount}/${results.length} 成功${DRY_RUN ? '（dry-run 模式）' : ''}`);
  log(lines);
}

// 守护循环：常驻后台，按多个签到时间点自动签到
async function daemonLoop() {
  log([`守护模式已启动，每天在 [${CHECKIN_TIMES.join(', ')}] 自动签到。可用 Ctrl+C 退出。`]);
  // 启动时先跑一轮（幂等：若今天已签到会自动跳过），之后按时间点触发
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
    log([`距下次签到约 ${hhmmOf(ms)}，睡等待中…`]);
    await sleep(ms);

    // 醒来后（可能因休眠跨时间点）直接执行一轮
    const roundResults = await runRound();
    summarize(roundResults);
    // 若恰好跨过一天边界，则本次执行已覆盖"今天"，sleep 会在下一轮重新计算
  }
}

// 单次执行：跑一轮然后按结果退出码返回
async function onceRound() {
  const results = await runRound();
  summarize(results);
  if (results.length > 0 && results.every((r) => !r.ok)) return 1; // 全部失败
  return 0;
}

// ---------------- 入口 ----------------
// 注意：不使用 process.exit() 强制退出（Windows 上会触发 libuv 断言），
// 改用 exitCode 让事件循环自然排空后退出
(async () => {
  ensureDirs();
  try {
    if (STATUS_MODE) {
      const results = await runRound('status');
      summarize(results, 'status');
      process.exitCode = results.length > 0 && results.every((r) => !r.ok) ? 1 : 0;
    } else if (REFRESH_MODE) {
      const results = await runRound('refresh');
      summarize(results, 'refresh');
      process.exitCode = results.length > 0 && results.every((r) => !r.ok) ? 1 : 0;
    } else if (GROWTH_MODE) {
      const results = await runRound('growth');
      summarize(results, 'growth');
      process.exitCode = results.length > 0 && results.every((r) => !r.ok) ? 1 : 0;
    } else if (CLAIM_MODE) {
      const results = await runRound('claim');
      summarize(results, 'claim');
      process.exitCode = results.length > 0 && results.every((r) => !r.ok) ? 1 : 0;
    } else if (LOOP) {
      await daemonLoop();
    } else {
      process.exitCode = await onceRound();
    }
  } catch (err) {
    log([`运行时错误: ${err.message || String(err)}`]);
    logCritical('运行时错误', err.message || String(err));
    process.exitCode = 1;
  }
})();

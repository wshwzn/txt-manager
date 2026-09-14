// ============================================================
// 个人文档管理器 —— 后端服务（Node.js，零第三方依赖）
//
// 启动方式：双击同目录下的 start.bat（会自动打开浏览器）
// 功能：左侧文件列表 + 右侧查看/编辑，支持 UTF-8 / GBK 自动识别、
//       新建、删除（进回收站）、切换工作目录
// ============================================================
// 左侧文件列表 + 右侧查看/编辑，支持 UTF-8 / GBK 自动识别
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextDecoder } = require('util');

// 默认文档目录：程序所在目录本身（clone 后必定存在，无需额外创建）
// 首次启动若没有 config.json，就用这里；在页面里切换目录后会记住，之后不再看这个默认值
const DEFAULT_DOC_DIR = __dirname;
const PORT = 5177;
const HOST = '127.0.0.1';

// 配置存放位置：与程序同目录（doc-manager\config.json）
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ---------- 配置持久化（记住当前目录 + 最近使用的目录） ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch (e) { return {}; }
}
const _cfg = loadConfig();
let DOC_DIR = (_cfg.dir && fs.existsSync(_cfg.dir)) ? _cfg.dir : DEFAULT_DOC_DIR;
let RECENT_DIRS = Array.isArray(_cfg.recent) ? _cfg.recent.slice(0, 8) : [];
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ dir: DOC_DIR, recent: RECENT_DIRS }, null, 2), 'utf-8');
  } catch (e) { /* 配置写入失败不影响使用 */ }
}

// ---------- 工具函数 ----------
function safeResolve(name) {
  const p = path.resolve(DOC_DIR, name);
  if (!p.startsWith(path.resolve(DOC_DIR) + path.sep) && p !== path.resolve(DOC_DIR)) {
    return null; // 防止路径穿越
  }
  return p;
}

// ---------- 目录浏览（给页面里的文件夹选择器用） ----------
// 不传 dir 时返回盘符列表；parent 为 null 表示已在最顶层，没有上一级。
function listDrives() {
  const out = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const root = letter + ':\\';
    try {
      if (fs.statSync(root).isDirectory()) out.push({ name: letter + ':', path: root });
    } catch (e) { /* 该盘符不存在或未就绪 */ }
  }
  return out;
}

function listDir(dir) {
  const raw = String(dir || '').trim();
  if (!raw) return { path: '', parent: null, entries: listDrives() };

  let p;
  try { p = path.resolve(raw); } catch (e) { return { error: '路径无效：' + raw }; }
  if (!fs.existsSync(p)) return { error: '目录不存在：' + p };

  try { if (!fs.statSync(p).isDirectory()) p = path.dirname(p); } catch (e) { return { error: '无法访问：' + p }; }

  const root = path.parse(p).root;
  const parent = (p === root) ? '' : path.dirname(p); // 到盘符根目录时回到「此电脑」
  let entries = [];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink()) // 顺带支持 junction/快捷方式式目录
      .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } catch (e) {
    return { error: '无法读取该目录（可能没有权限）：' + p, path: p, parent, entries: [] };
  }
  return { path: p, parent, entries };
}

function detectAndDecode(buf) {
  if (!buf || buf.length === 0) return { content: '', encoding: 'utf-8', binary: false };
  // 含 NUL 字节的几乎一定是二进制文件（快捷方式/程序/图片/压缩包等）
  // 直接拒绝按文本打开，避免误保存把文件写坏
  if (buf.includes(0)) {
    return { content: '', encoding: '二进制文件', binary: true };
  }
  // 去掉 UTF-8 BOM
  let b = buf;
  let hadBom = false;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    b = b.slice(3);
    hadBom = true;
  }
  try {
    const strict = new TextDecoder('utf-8', { fatal: true });
    return { content: strict.decode(b), encoding: 'utf-8' + (hadBom ? ' (BOM)' : ''), binary: false };
  } catch (e) {
    // 不是合法 UTF-8，尝试 GBK
    try {
      const gbk = new TextDecoder('gbk');
      const content = gbk.decode(b);
      if (content.includes('\uFFFD')) {
        return { content, encoding: '未知(按GBK尽力解码)', binary: false };
      }
      return { content, encoding: 'gbk', binary: false };
    } catch (e2) {
      return { content: '', encoding: '二进制文件', binary: true };
    }
  }
}

function listFiles() {
  const entries = fs.readdirSync(DOC_DIR, { withFileTypes: true });
  const files = entries.filter(e => e.isFile()).map(e => {
    const full = path.join(DOC_DIR, e.name);
    const st = fs.statSync(full);
    return {
      name: e.name,
      size: st.size,
      mtime: st.mtimeMs,
      mtimeText: formatTime(st.mtime),
    };
  });
  files.sort((a, b) => b.mtime - a.mtime); // 最近修改在前
  return files;
}

function formatTime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// ---------- 前端页面 ----------
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>我的文档管理</title>
<style>
  /* ---------- 配色变量：日间（默认） ---------- */
  :root {
    color-scheme: light;
    --bg: #f5f6f8;
    --text: #2c3e50;
    --panel: #ffffff;
    --border: #e4e7ed;
    --border-soft: #e8eaee;
    --input-border: #dcdfe6;
    --muted: #909399;
    --muted-2: #a0a6b0;
    --muted-3: #b8bdc7;
    --accent: #4a7cf7;
    --accent-hover: #3a6ae6;
    --accent-soft: #f2f6ff;
    --accent-soft-2: #e8efff;
    --accent-text: #2b5fd9;
    --chip-bg: #f0f2f5;
    --chip-text: #7a8494;
    --item-bg: #f6f7f9;
    --danger: #e04b4b;
    --danger-text: #d94848;
    --danger-border: #f0b8b8;
    --danger-soft: #fdeeee;
    --ok: #2fa15a;
    --warn: #f7a23b;
    --shadow: 0 8px 30px rgba(0,0,0,0.18);
    --mask: rgba(0,0,0,0.35);
    --scroll-bar: #c9cdd4;
    --scroll-bar-hover: #aeb4be;
  }
  /* ---------- 配色变量：夜间 ---------- */
  body.dark {
    color-scheme: dark;
    --bg: #1b1d21;
    --text: #d6dae1;
    --panel: #24262b;
    --border: #34373d;
    --border-soft: #34373d;
    --input-border: #3f434a;
    --muted: #868d97;
    --muted-2: #767d87;
    --muted-3: #666d77;
    --accent: #5b8cff;
    --accent-hover: #6f9bff;
    --accent-soft: #2b3141;
    --accent-soft-2: #333b52;
    --accent-text: #8fb0ff;
    --chip-bg: #303338;
    --chip-text: #9aa1ac;
    --item-bg: #2b2e34;
    --danger: #ff6b6b;
    --danger-text: #ff7b7b;
    --danger-border: #6b3a3a;
    --danger-soft: #3a2626;
    --ok: #4cc07a;
    --warn: #f2a94b;
    --shadow: 0 8px 30px rgba(0,0,0,0.55);
    --mask: rgba(0,0,0,0.6);
    --scroll-bar: #454951;
    --scroll-bar-hover: #5c626c;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* ---------- 滚动条：跟随主题变量，夜间不再露出系统浅色条 ---------- */
  ::-webkit-scrollbar { width: 12px; height: 12px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: var(--scroll-bar);
    border: 3px solid transparent;
    background-clip: content-box;
    border-radius: 6px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: var(--scroll-bar-hover);
    border: 3px solid transparent;
    background-clip: content-box;
  }
  ::-webkit-scrollbar-corner { background: transparent; }
  html, body { height: 100%; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
  }
  header {
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 12px 20px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  header .logo {
    width: 30px; height: 30px;
    background: var(--accent);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 16px; font-weight: bold;
  }
  header h1 { font-size: 16px; font-weight: 600; }
  header .path { font-size: 12px; color: var(--muted); cursor: pointer; }
  header .path:hover { color: var(--accent); text-decoration: underline; }
  header .refresh-btn {
    border: 1px solid var(--input-border); background: var(--panel); color: var(--text);
    padding: 5px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
  }
  header .refresh-btn:hover { border-color: var(--accent); color: var(--accent); }
  header .push-right { margin-left: auto; }
  header .icon-btn { padding: 5px 9px; font-size: 15px; line-height: 1.25; min-width: 38px; }
  header .ext-btn { min-width: 84px; }

  .main { flex: 1; display: flex; overflow: hidden; }

  /* 左侧列表 */
  .sidebar {
    width: 280px; flex-shrink: 0;
    background: var(--panel);
    display: flex; flex-direction: column;
  }
  /* 可左右拖动的分栏线 */
  .resizer {
    width: 6px; flex-shrink: 0; cursor: col-resize;
    background: var(--panel); position: relative;
    display: flex; justify-content: center; align-items: stretch;
    touch-action: none;
  }
  .resizer::after { content: ''; width: 1px; background: var(--border); }
  .resizer:hover::after, .resizer.dragging::after { width: 2px; background: var(--accent); }
  body.resizing { cursor: col-resize; }
  body.resizing * { user-select: none !important; }

  .sidebar .top-bar { padding: 12px; display: flex; gap: 8px; }
  .sidebar input[type=text] {
    flex: 1; border: 1px solid var(--input-border); border-radius: 6px;
    padding: 7px 10px; font-size: 13px; outline: none;
    background: var(--panel); color: var(--text);
  }
  .sidebar input[type=text]:focus { border-color: var(--accent); }
  .sidebar input[type=text]::placeholder { color: var(--muted-3); }
  .new-btn {
    border: none; background: var(--accent); color: #fff;
    border-radius: 6px; padding: 7px 12px; font-size: 13px;
    cursor: pointer; white-space: nowrap;
  }
  .new-btn:hover { background: var(--accent-hover); }
  .file-list { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
  .file-item {
    padding: 9px 10px; border-radius: 8px; cursor: pointer;
    margin-bottom: 2px; user-select: none;
  }
  .file-item:hover { background: var(--accent-soft); }
  .file-item.active { background: var(--accent-soft-2); }
  .file-item .fname {
    font-size: 13.5px; font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .file-item.active .fname { color: var(--accent-text); }
  .file-item .fmeta { font-size: 11.5px; color: var(--muted-2); margin-top: 3px; display: flex; gap: 8px; }
  .file-item .dirty-dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: var(--warn); margin-left: 5px; vertical-align: 2px;
  }
  .empty-hint { color: var(--muted-3); font-size: 13px; text-align: center; padding: 30px 10px; }

  /* 右侧编辑区 */
  .content { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .content .placeholder {
    flex: 1; display: flex; align-items: center; justify-content: center;
    color: var(--muted-3); font-size: 14px; flex-direction: column; gap: 10px;
  }
  .doc-header {
    background: var(--panel); border-bottom: 1px solid var(--border);
    padding: 10px 20px; display: flex; align-items: center; gap: 12px;
    flex-shrink: 0; min-height: 54px;
  }
  .doc-title { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .enc-badge {
    font-size: 11px; color: var(--chip-text); background: var(--chip-bg);
    border-radius: 4px; padding: 2px 7px; flex-shrink: 0;
  }
  .save-btn {
    margin-left: auto; border: none; background: var(--accent); color: #fff;
    padding: 7px 20px; border-radius: 6px; font-size: 13px; cursor: pointer;
    flex-shrink: 0;
  }
  .save-btn:hover { background: var(--accent-hover); }
  .save-btn:disabled { opacity: .55; cursor: default; }
  .status-text { font-size: 12px; color: var(--muted); flex-shrink: 0; }
  .status-text.saved { color: var(--ok); }
  .status-text.error { color: var(--danger); }
  textarea.editor {
    flex: 1; border: none; outline: none; resize: none;
    padding: 20px 24px; font-size: var(--editor-fs, 14px); line-height: 1.8;
    font-family: Consolas, "Microsoft YaHei", monospace;
    background: var(--panel); color: var(--text); white-space: pre; overflow: auto;
  }
  /* 自动折行模式：长行换行显示，不再横向滚动 */
  textarea.editor.wrap {
    white-space: pre-wrap; overflow-wrap: break-word; overflow-x: hidden;
  }

  /* 弹窗 */
  .modal-mask {
    display: none; position: fixed; inset: 0;
    background: var(--mask); z-index: 10;
    align-items: center; justify-content: center;
  }
  .modal-mask.show { display: flex; }
  .modal {
    background: var(--panel); border-radius: 10px; padding: 22px;
    width: 360px; box-shadow: var(--shadow);
  }
  .modal h3 { font-size: 15px; margin-bottom: 14px; }
  .modal input[type=text] {
    width: 100%; border: 1px solid var(--input-border); border-radius: 6px;
    padding: 8px 10px; font-size: 13.5px; outline: none;
    background: var(--panel); color: var(--text);
  }
  .modal input[type=text]:focus { border-color: var(--accent); }
  .modal input[type=text]::placeholder { color: var(--muted-3); }
  .modal .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .modal button {
    border: 1px solid var(--input-border); background: var(--panel); color: var(--text);
    padding: 7px 18px; border-radius: 6px; font-size: 13px; cursor: pointer;
  }
  .modal button:hover { border-color: var(--accent); color: var(--accent); }
  .modal button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .modal button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: #fff; }
  .modal button.primary:disabled { opacity: .55; color: #fff; cursor: default; }
  .modal .msg { font-size: 12px; color: var(--danger); margin-top: 8px; min-height: 15px; }

  /* 删除相关 */
  .del-btn {
    border: 1px solid var(--danger-border); background: var(--panel); color: var(--danger-text);
    padding: 7px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
    flex-shrink: 0;
  }
  .del-btn:hover { background: var(--danger-soft); border-color: var(--danger); }

  /* 正文视图工具（字号 / 自动折行） */
  .view-tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .tool-btn {
    border: 1px solid var(--input-border); background: var(--panel); color: var(--text);
    padding: 6px 9px; border-radius: 6px; font-size: 13px; cursor: pointer;
    line-height: 1.2; min-width: 32px; flex-shrink: 0;
  }
  .tool-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .tool-btn:disabled { opacity: .4; cursor: default; }
  .tool-btn.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); }
  .file-item .del-x {
    margin-left: auto; display: none; color: var(--muted-3);
    font-size: 12px; padding: 0 3px; cursor: pointer;
  }
  .file-item:hover .del-x { display: inline; }
  .file-item .del-x:hover { color: var(--danger); }
  .modal .del-info { font-size: 13.5px; line-height: 1.8; color: var(--text); word-break: break-all; }
  .modal button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  .modal button.danger:hover { background: var(--danger); border-color: var(--danger); color: #fff; filter: brightness(.88); }
  .modal button.danger:disabled { opacity: .55; color: #fff; cursor: default; }

  /* 切换目录弹窗 */
  .dir-row { display: flex; gap: 8px; }
  .dir-row input[type=text] { flex: 1; width: auto; min-width: 0; }
  .dir-row button {
    border: 1px solid var(--input-border); background: var(--panel); color: var(--text);
    padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
    white-space: nowrap;
  }
  .dir-row button:hover { border-color: var(--accent); color: var(--accent); }
  .dir-row button:disabled { color: var(--muted-3); border-color: var(--border-soft); cursor: default; }
  .dir-recent { margin-top: 14px; }
  .dir-recent-title { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .dir-item {
    font-size: 12.5px; color: var(--text); background: var(--item-bg);
    border-radius: 6px; padding: 6px 8px 6px 10px; margin-bottom: 5px;
    cursor: pointer; white-space: nowrap; overflow: hidden;
    display: flex; align-items: center; gap: 6px;
  }
  .dir-item:hover { background: var(--accent-soft-2); color: var(--accent-text); }
  .dir-item .dir-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .dir-del {
    flex: none; width: 17px; height: 17px; line-height: 15px; text-align: center;
    border-radius: 50%; font-size: 14px; color: var(--muted-3); cursor: pointer;
    user-select: none;
  }
  .dir-del:hover { color: var(--danger); background: var(--danger-soft); }
  .dir-empty { font-size: 12.5px; color: var(--muted-3); }
  .pick-path { font-size: 12.5px; color: var(--text); background: var(--bg); border: 1px solid var(--border-soft); border-radius: 6px; padding: 7px 10px; margin-bottom: 10px; min-height: 32px; word-break: break-all; }
  .pick-list { height: 240px; overflow-y: auto; border: 1px solid var(--border-soft); border-radius: 6px; padding: 4px; }
  .pick-list .dir-empty { padding: 8px 10px; }
  .pick-item { font-size: 13px; padding: 7px 10px; border-radius: 5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pick-item:hover { background: var(--accent-soft-2); color: var(--accent-text); }
  .modal button:disabled { color: var(--muted-3); cursor: default; }
</style>
</head>
<body>
<script>
  // 尽早套用上次选择的主题，避免刷新时先闪一下日间色
  try { if (localStorage.getItem('docmgr-theme') === 'dark') document.body.classList.add('dark'); } catch (e) {}
</script>
<header>
  <div class="logo">文</div>
  <div style="min-width: 0;">
    <h1>我的文档管理</h1>
    <div class="path" id="dirPath" title="点击切换工作目录" onclick="openDirModal()">加载中…</div>
  </div>
  <button class="refresh-btn push-right" onclick="openDirModal()">切换目录</button>
  <button class="refresh-btn" onclick="loadList()">刷新列表</button>
  <button class="refresh-btn ext-btn" id="extBtn" onclick="toggleExt()" title="显示 / 隐藏文件名后缀">隐藏后缀</button>
  <button class="refresh-btn icon-btn" id="themeBtn" onclick="toggleTheme()" title="切换日间 / 夜间模式">🌙</button>
</header>
<div class="main">
  <div class="sidebar">
    <div class="top-bar">
      <input type="text" id="searchBox" placeholder="搜索文件名…" oninput="renderList()">
      <button class="new-btn" onclick="openNewModal()">＋新建</button>
    </div>
    <div class="file-list" id="fileList"></div>
  </div>
  <div class="resizer" id="resizer" title="拖动调整左侧宽度，双击恢复默认"></div>
  <div class="content" id="contentArea">
    <div class="placeholder">
      <div style="font-size:40px;">📄</div>
      <div>从左侧选择一个文档开始阅读 / 编辑</div>
      <div style="font-size:12px;color:var(--muted-3);">支持 Ctrl+S 快捷保存</div>
    </div>
  </div>
</div>

<div class="modal-mask" id="newModal">
  <div class="modal">
    <h3>新建文档</h3>
    <input type="text" id="newName" placeholder="文件名，例如：备忘录.txt">
    <div class="msg" id="newMsg"></div>
    <div class="btns">
      <button onclick="closeNewModal()">取消</button>
      <button class="primary" onclick="createFile()">创建</button>
    </div>
  </div>
</div>

<div class="modal-mask" id="delModal">
  <div class="modal">
    <h3>删除文档</h3>
    <div class="del-info" id="delInfo"></div>
    <div class="btns">
      <button onclick="closeDelModal()">取消</button>
      <button class="danger" id="delConfirmBtn" onclick="doDelete()">移到回收站</button>
    </div>
  </div>
</div>

<div class="modal-mask" id="dirModal">
  <div class="modal" style="width: 460px;">
    <h3>切换工作目录</h3>
    <div class="dir-row">
      <input type="text" id="dirInput" placeholder="例如：D:\\文档  或  \\\\NAS\\共享">
      <button id="browseBtn" onclick="openPicker()">浏览…</button>
    </div>
    <div class="msg" id="dirMsg"></div>
    <div class="dir-recent">
      <div class="dir-recent-title">最近使用</div>
      <div id="dirRecentList"></div>
    </div>
    <div class="btns">
      <button onclick="closeDirModal()">取消</button>
      <button class="primary" id="dirConfirmBtn" onclick="applyDir()">切换到此目录</button>
    </div>
  </div>
</div>

<div class="modal-mask" id="pickModal">
  <div class="modal" style="width: 520px;">
    <h3>浏览文件夹</h3>
    <div class="pick-path" id="pickPath">此电脑</div>
    <div class="pick-list" id="pickList"></div>
    <div class="msg" id="pickMsg"></div>
    <div class="btns">
      <button onclick="closePickModal()">取消</button>
      <button id="pickUpBtn" onclick="pickUp()">上一级</button>
      <button class="primary" onclick="pickChoose()">选择此文件夹</button>
    </div>
  </div>
</div>

<script>
  let files = [];
  let current = null;        // 当前打开的文件名
  let dirty = false;         // 有未保存修改
  let saving = false;
  let showExt = true;        // 左侧列表是否显示文件后缀名

  async function loadList() {
    const res = await fetch('/api/files');
    files = await res.json();
    if (current && !files.some(f => f.name === current)) {
      // 当前文件被外部删除等情况
      current = null;
      showPlaceholder();
    }
    renderList();
  }

  function renderList() {
    const kw = document.getElementById('searchBox').value.trim().toLowerCase();
    const box = document.getElementById('fileList');
    const list = kw ? files.filter(f => f.name.toLowerCase().includes(kw)) : files;
    if (!list.length) {
      box.innerHTML = '<div class="empty-hint">' + (kw ? '没有匹配的文件' : '目录是空的') + '</div>';
      return;
    }
    box.innerHTML = list.map(f => {
      const dirtyDot = (f.name === current && dirty) ? '<span class="dirty-dot" title="有未保存修改"></span>' : '';
      const label = showExt ? f.name : stripExt(f.name);
      return '<div class="file-item' + (f.name === current ? ' active' : '') + '" onclick="openFile(this.dataset.n)" data-n="' + escapeAttr(f.name) + '" title="' + escapeAttr(f.name) + '">' +
        '<div class="fname">' + escapeHtml(label) + dirtyDot + '</div>' +
        '<div class="fmeta"><span>' + f.mtimeText + '</span><span>' + f.sizeText + '</span>' +
        '<span class="del-x" data-n="' + escapeAttr(f.name) + '" onclick="event.stopPropagation();askDelete(this.dataset.n)" title="移到回收站">✕</span></div>' +
        '</div>';
    }).join('');
  }

  async function openFile(name) {
    if (dirty && current && current !== name && !confirm('当前文档有未保存的修改，直接切换将丢失修改。确定切换吗？')) return;
    const res = await fetch('/api/file?name=' + encodeURIComponent(name));
    if (!res.ok) { alert('读取失败：' + (await res.text())); return; }
    const data = await res.json();
    current = name;
    dirty = false;
    // 二进制文件（快捷方式/程序/图片等）不提供编辑，避免误保存损坏文件
    if (data.binary) {
      document.getElementById('contentArea').innerHTML =
        '<div class="doc-header">' +
        '<div class="doc-title">' + escapeHtml(name) + '</div>' +
        '<span class="enc-badge">' + escapeHtml(data.encoding) + '</span>' +
        '<button class="del-btn" id="delBtn" onclick="askDelete(current)">删除</button>' +
        '</div>' +
        '<div class="placeholder"><div style="font-size:40px;">🚫</div>' +
        '<div>这不是文本文件（如快捷方式、程序、图片、压缩包等）</div>' +
        '<div style="font-size:12px;color:var(--muted-3);">为避免损坏文件，已禁止在此编辑；如需删除请用上方按钮</div></div>';
      renderList();
      return;
    }
    document.getElementById('contentArea').innerHTML =
      '<div class="doc-header">' +
      '<div class="doc-title">' + escapeHtml(name) + '</div>' +
      '<span class="enc-badge">编码: ' + escapeHtml(data.encoding) + '</span>' +
      '<span class="status-text" id="statusText"></span>' +
      '<div class="view-tools">' +
      '<button class="tool-btn" id="fsMinus" onclick="stepFont(-1)" title="缩小正文字号">A−</button>' +
      '<button class="tool-btn" id="fsPlus" onclick="stepFont(1)" title="放大正文字号">A+</button>' +
      '<button class="tool-btn" id="wrapBtn" onclick="toggleWrap()" title="切换自动折行">自动折行</button>' +
      '</div>' +
      '<button class="del-btn" id="delBtn" onclick="askDelete(current)">删除</button>' +
      '<button class="save-btn" id="saveBtn" onclick="saveFile()">保存</button>' +
      '</div>' +
      '<textarea class="editor" id="editor" spellcheck="false"></textarea>';
    const editor = document.getElementById('editor');
    editor.value = data.content;
    editor.addEventListener('input', () => { setDirty(true); });
    applyFontSize(editorFS);
    applyWrap(autoWrap);
    renderList();
    editor.focus();
  }

  function setDirty(v) {
    dirty = v;
    const st = document.getElementById('statusText');
    if (st) {
      st.textContent = v ? '● 有未保存的修改' : '';
      st.className = 'status-text' + (v ? '' : '');
    }
    renderList();
  }

  async function saveFile() {
    if (!current || saving) return;
    saving = true;
    const btn = document.getElementById('saveBtn');
    const st = document.getElementById('statusText');
    btn.disabled = true;
    st.textContent = '保存中…'; st.className = 'status-text';
    try {
      const res = await fetch('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: current, content: document.getElementById('editor').value })
      });
      if (!res.ok) throw new Error(await res.text());
      st.textContent = '✓ 已保存 ' + new Date().toLocaleTimeString('zh-CN');
      st.className = 'status-text saved';
      dirty = false;
      renderList();
      loadList(); // 刷新修改时间
    } catch (e) {
      st.textContent = '保存失败：' + e.message;
      st.className = 'status-text error';
    } finally {
      btn.disabled = false;
      saving = false;
    }
  }

  function openNewModal() {
    document.getElementById('newName').value = '';
    document.getElementById('newMsg').textContent = '';
    document.getElementById('newModal').classList.add('show');
    document.getElementById('newName').focus();
  }
  function closeNewModal() {
    document.getElementById('newModal').classList.remove('show');
  }
  async function createFile() {
    let name = document.getElementById('newName').value.trim();
    if (!name) { document.getElementById('newMsg').textContent = '请输入文件名'; return; }
    if (!/\\.[a-zA-Z0-9]+$/.test(name)) name += '.txt';
    if (/[\\\\/:*?"<>|]/.test(name)) { document.getElementById('newMsg').textContent = '文件名不能包含 \\ / : * ? " < > |'; return; }
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) { document.getElementById('newMsg').textContent = await res.text(); return; }
    closeNewModal();
    await loadList();
    openFile(name);
  }

  let pendingDelete = null;

  function askDelete(name) {
    if (!name) return;
    pendingDelete = name;
    let html = '确定把「<b>' + escapeHtml(name) + '</b>」移到回收站吗？';
    if (name === current && dirty) {
      html += '<br><span style="color:var(--danger);">注意：该文档有未保存的修改，删除时将一并丢弃。</span>';
    }
    html += '<br><span style="font-size:12px;color:var(--muted-2);">文件会进入 Windows 回收站，需要时可以恢复。</span>';
    document.getElementById('delInfo').innerHTML = html;
    const btn = document.getElementById('delConfirmBtn');
    btn.disabled = false;
    btn.textContent = '移到回收站';
    document.getElementById('delModal').classList.add('show');
  }
  function closeDelModal() {
    document.getElementById('delModal').classList.remove('show');
    pendingDelete = null;
  }
  async function doDelete() {
    if (!pendingDelete) return;
    const btn = document.getElementById('delConfirmBtn');
    btn.disabled = true;
    btn.textContent = '删除中…';
    try {
      const res = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pendingDelete })
      });
      if (!res.ok) throw new Error(await res.text());
      if (pendingDelete === current) { current = null; dirty = false; showPlaceholder(); }
      closeDelModal();
      loadList();
    } catch (e) {
      alert('删除失败：' + e.message);
      btn.disabled = false;
      btn.textContent = '移到回收站';
    }
  }

  // ---------- 工作目录切换 ----------
  let curDir = '';

  function setDirLabel(dir) {
    curDir = dir;
    const el = document.getElementById('dirPath');
    el.textContent = dir;
    el.title = '当前工作目录：' + dir + '（点击可切换）';
  }

  async function loadDir() {
    try {
      const res = await fetch('/api/dir');
      const d = await res.json();
      setDirLabel(d.dir);
      renderRecent(d.recent);
    } catch (e) { /* 忽略 */ }
  }

  function renderRecent(list) {
    const box = document.getElementById('dirRecentList');
    if (!list || !list.length) { box.innerHTML = '<div class="dir-empty">暂无</div>'; box.onclick = null; return; }
    box.innerHTML = list.map(d =>
      '<div class="dir-item" title="' + escapeAttr(d) + '" data-d="' + escapeAttr(d) + '">' +
        '<span class="dir-name">' + escapeHtml(d) + '</span>' +
        '<span class="dir-del" data-del="' + escapeAttr(d) + '" title="从最近使用中移除（只删记录，不动文件夹）">&times;</span>' +
      '</div>'
    ).join('');
    // 点击填入输入框：用事件委托绑定，避免在内联 onclick 里嵌套引号
    // （内联写法在模板字符串里转义层数太多，曾经吞掉反斜杠导致整段脚本语法错误）
    // 点右侧的 × 则是移除记录，不再填入——所以要先判断点击目标
    box.onclick = function (e) {
      const t = e.target;
      const del = t.closest ? t.closest('.dir-del') : null;
      if (del) { e.stopPropagation(); removeRecent(del.getAttribute('data-del')); return; }
      const el = t.closest ? t.closest('.dir-item') : null;
      if (!el) return;
      document.getElementById('dirInput').value = el.dataset.d;
    };
  }

  // 移除一条「最近使用」记录（仅服务端历史列表，不影响当前目录）
  async function removeRecent(dir) {
    const msg = document.getElementById('dirMsg');
    try {
      const res = await fetch('/api/dir/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: dir })
      });
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      renderRecent(d.recent);
      msg.textContent = '';
    } catch (e) {
      msg.textContent = '移除失败：' + e.message;
    }
  }

  async function openDirModal() {
    await loadDir();
    document.getElementById('dirInput').value = curDir;
    const msg = document.getElementById('dirMsg');
    msg.textContent = ''; msg.style.color = 'var(--danger)';
    document.getElementById('dirConfirmBtn').disabled = false;
    document.getElementById('dirConfirmBtn').textContent = '切换到此目录';
    document.getElementById('dirModal').classList.add('show');
    document.getElementById('dirInput').focus();
  }
  function closeDirModal() {
    document.getElementById('dirModal').classList.remove('show');
  }

  // ---------- 文件夹选择器（页面内置，不弹系统对话框） ----------
  let pickCur = '';      // 当前正在浏览的目录，'' 代表「此电脑」（盘符列表）
  let pickParent = null; // 上一级；null 表示已经在最顶层

  function openPicker() {
    document.getElementById('pickModal').classList.add('show');
    // 从输入框里已有的路径开始浏览，没有就从「此电脑」开始
    loadPick(document.getElementById('dirInput').value.trim());
  }

  function closePickModal() {
    document.getElementById('pickModal').classList.remove('show');
  }

  async function loadPick(dir) {
    const list = document.getElementById('pickList');
    const msg = document.getElementById('pickMsg');
    msg.textContent = '';
    list.innerHTML = '<div class="dir-empty">加载中…</div>';
    try {
      const res = await fetch('/api/browse?dir=' + encodeURIComponent(dir || ''));
      const d = await res.json();
      if (d.error) { list.innerHTML = '<div class="dir-empty">' + escapeHtml(d.error) + '</div>'; return; }
      pickCur = d.path;
      pickParent = d.parent;
      document.getElementById('pickPath').textContent = d.path || '此电脑';
      document.getElementById('pickUpBtn').disabled = (d.parent === null);
      if (!d.entries.length) {
        list.innerHTML = '<div class="dir-empty">这个文件夹下面没有子文件夹</div>';
        return;
      }
      list.innerHTML = d.entries.map(function (e) {
        return '<div class="pick-item" data-p="' + escapeAttr(e.path) + '">📁 ' + escapeHtml(e.name) + '</div>';
      }).join('');
    } catch (e) {
      list.innerHTML = '<div class="dir-empty">读取失败：' + escapeHtml(e.message) + '</div>';
    }
  }

  function pickUp() {
    if (pickParent === null) return;
    loadPick(pickParent);
  }

  function pickChoose() {
    if (!pickCur) {
      document.getElementById('pickMsg').textContent = '请先进入一个文件夹，或在列表里选中一个盘符';
      return;
    }
    document.getElementById('dirInput').value = pickCur;
    closePickModal();
    const msg = document.getElementById('dirMsg');
    msg.style.color = 'var(--ok)';
    msg.textContent = '已选择：' + pickCur + '（点「切换到此目录」生效）';
  }

  async function applyDir() {
    const dir = document.getElementById('dirInput').value.trim();
    const msg = document.getElementById('dirMsg');
    if (!dir) { msg.style.color = 'var(--danger)'; msg.textContent = '请输入或选择一个目录'; return; }
    if (dir === curDir) { msg.style.color = 'var(--danger)'; msg.textContent = '这已经是当前目录了'; return; }
    if (dirty && !confirm('当前文档有未保存的修改，切换目录将丢弃这些修改。继续吗？')) return;
    const btn = document.getElementById('dirConfirmBtn');
    btn.disabled = true;
    btn.textContent = '切换中…';
    try {
      const res = await fetch('/api/dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir })
      });
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      setDirLabel(d.dir);
      renderRecent(d.recent);
      closeDirModal();
      current = null;            // 换目录后清空右侧编辑区
      dirty = false;
      showPlaceholder();
      await loadList();
    } catch (e) {
      msg.style.color = 'var(--danger)';
      msg.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '切换到此目录';
    }
  }

  function showPlaceholder() {
    document.getElementById('contentArea').innerHTML =
      '<div class="placeholder"><div style="font-size:40px;">📄</div>' +
      '<div>从左侧选择一个文档开始阅读 / 编辑</div>' +
      '<div style="font-size:12px;color:var(--muted-3);">支持 Ctrl+S 快捷保存</div></div>';
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
  });

  // 文件夹选择器：单击列表项进入该文件夹（事件委托，避免内联写法踩引号转义的坑）
  document.getElementById('pickList').onclick = function (e) {
    const el = e.target.closest ? e.target.closest('.pick-item') : null;
    if (el) loadPick(el.dataset.p);
  };

  // ---------- 文件后缀名的显示 / 隐藏 ----------
  // 只影响左侧列表的显示文字，data-n 里存的始终是完整文件名，不影响打开与保存
  function stripExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;   // i<=0 说明没有后缀或是 .gitignore 这类隐藏文件，原样显示
  }
  function applyExtBtn() {
    const btn = document.getElementById('extBtn');
    if (!btn) return;
    btn.textContent = showExt ? '隐藏后缀' : '显示后缀';
    btn.title = showExt ? '当前显示后缀名，点击隐藏' : '当前隐藏后缀名，点击显示';
  }
  function setShowExt(v, save) {
    showExt = !!v;
    applyExtBtn();
    if (save) { try { localStorage.setItem('docmgr-show-ext', showExt ? '1' : '0'); } catch (e) {} }
    renderList();
  }
  function toggleExt() { setShowExt(!showExt, true); }
  function initExt() {
    let v = true;
    try { v = localStorage.getItem('docmgr-show-ext') !== '0'; } catch (e) {}
    showExt = v;
    applyExtBtn();
  }

  // ---------- 正文字号 / 自动折行（只作用于正文编辑区，目录字号不受影响） ----------
  const FS_STEPS = [12, 13, 14, 15, 16, 18, 20, 22, 24];
  const FS_DEFAULT = 14;
  let editorFS = FS_DEFAULT;
  let autoWrap = false;

  function applyFontSize(px) {
    editorFS = px;
    document.documentElement.style.setProperty('--editor-fs', px + 'px');
    const minus = document.getElementById('fsMinus');
    const plus = document.getElementById('fsPlus');
    if (minus) {
      minus.disabled = (px <= FS_STEPS[0]);
      minus.title = '缩小正文字号（当前 ' + px + 'px）';
    }
    if (plus) {
      plus.disabled = (px >= FS_STEPS[FS_STEPS.length - 1]);
      plus.title = '放大正文字号（当前 ' + px + 'px）';
    }
  }
  function stepFont(dir) {
    let i = FS_STEPS.indexOf(editorFS);
    if (i < 0) i = FS_STEPS.indexOf(FS_DEFAULT);
    const n = Math.max(0, Math.min(FS_STEPS.length - 1, i + dir));
    if (FS_STEPS[n] === editorFS) return;
    applyFontSize(FS_STEPS[n]);
    try { localStorage.setItem('docmgr-editor-fs', String(FS_STEPS[n])); } catch (e) {}
  }
  function applyWrap(on) {
    autoWrap = !!on;
    const ed = document.getElementById('editor');
    if (ed) ed.classList.toggle('wrap', autoWrap);
    const btn = document.getElementById('wrapBtn');
    if (btn) {
      btn.classList.toggle('on', autoWrap);
      btn.title = autoWrap
        ? '当前自动折行（长行换行显示），点击改为横向滚动'
        : '当前不折行（长行横向滚动），点击开启自动折行';
    }
  }
  function toggleWrap() {
    applyWrap(!autoWrap);
    try { localStorage.setItem('docmgr-editor-wrap', autoWrap ? '1' : '0'); } catch (e) {}
  }
  function initView() {
    let px = FS_DEFAULT, wp = false;
    try {
      const v = parseInt(localStorage.getItem('docmgr-editor-fs'), 10);
      if (FS_STEPS.indexOf(v) >= 0) px = v;
      wp = localStorage.getItem('docmgr-editor-wrap') === '1';
    } catch (e) {}
    applyFontSize(px);
    applyWrap(wp);
  }

  // ---------- 日间 / 夜间主题 ----------
  function applyTheme(dark) {
    document.body.classList.toggle('dark', dark);
    const btn = document.getElementById('themeBtn');
    if (btn) {
      btn.textContent = dark ? '☀️' : '🌙';
      btn.title = dark ? '切换到日间模式' : '切换到夜间模式';
    }
  }
  function toggleTheme() {
    const dark = !document.body.classList.contains('dark');
    applyTheme(dark);
    try { localStorage.setItem('docmgr-theme', dark ? 'dark' : 'light'); } catch (e) {}
  }
  function initTheme() {
    let dark = false;
    try { dark = localStorage.getItem('docmgr-theme') === 'dark'; } catch (e) {}
    applyTheme(dark);
  }

  // ---------- 左侧栏宽度可拖动 ----------
  (function initResizer() {
    const sb = document.querySelector('.sidebar');
    const rz = document.getElementById('resizer');
    const main = document.querySelector('.main');
    const MIN = 160, MAX = 640, DEF = 280;
    function clamp(w) { return Math.max(MIN, Math.min(MAX, w)); }
    function setW(w, save) {
      w = clamp(w);
      sb.style.width = w + 'px';
      if (save) { try { localStorage.setItem('docmgr-sidebar-w', String(w)); } catch (e) {} }
    }
    try {
      const saved = parseInt(localStorage.getItem('docmgr-sidebar-w'), 10);
      if (saved >= MIN && saved <= MAX) setW(saved);
    } catch (e) {}
    let dragging = false;
    rz.addEventListener('mousedown', function (e) {
      dragging = true;
      rz.classList.add('dragging');
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      setW(e.clientX - main.getBoundingClientRect().left);
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      rz.classList.remove('dragging');
      document.body.classList.remove('resizing');
      setW(parseInt(sb.style.width, 10), true);
    });
    rz.addEventListener('dblclick', function () { setW(DEF, true); });
  })();

  initTheme();
  initExt();
  initView();
  loadDir();
  loadList();
</script>
</body>
</html>`;

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/files') {
    try {
      const files = listFiles().map(f => ({ ...f, sizeText: formatSize(f.size) }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(files));
    } catch (e) {
      res.writeHead(500); res.end('读取目录失败: ' + e.message);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/file') {
    const name = url.searchParams.get('name');
    const p = safeResolve(name);
    if (!p || !fs.existsSync(p)) { res.writeHead(400); res.end('文件不存在'); return; }
    try {
      const buf = fs.readFileSync(p);
      const { content, encoding, binary } = detectAndDecode(buf);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ content, encoding, binary: !!binary }));
    } catch (e) {
      res.writeHead(500); res.end('读取失败: ' + e.message);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/file') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, content } = JSON.parse(body);
        const p = safeResolve(name);
        if (!p) { res.writeHead(400); res.end('非法文件名'); return; }
        fs.writeFileSync(p, content, 'utf-8'); // 统一保存为 UTF-8
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
      } catch (e) {
        res.writeHead(500); res.end('保存失败: ' + e.message);
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/create') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        const p = safeResolve(name);
        if (!p) { res.writeHead(400); res.end('非法文件名'); return; }
        if (fs.existsSync(p)) { res.writeHead(400); res.end('同名文件已存在'); return; }
        fs.writeFileSync(p, '', 'utf-8');
        res.writeHead(200); res.end('ok');
      } catch (e) {
        res.writeHead(500); res.end('创建失败: ' + e.message);
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/delete') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        const p = safeResolve(name);
        if (!p || !fs.existsSync(p)) { res.writeHead(400); res.end('文件不存在'); return; }
        // 移入 Windows 回收站（可恢复），而不是永久删除
        // 注意：.NET 的 FileSystem.DeleteFile(..., SendToRecycleBin) 在文件成功移入回收站后，
        // 内部还会再访问一次该路径，因而会抛出一个 FileNotFoundException 噪音（实测文件确实已
        // 进回收站）。所以这里用 try/catch 吞掉它，并以「文件是否已从磁盘消失」作为成功判据。
        const psScript = "Add-Type -AssemblyName Microsoft.VisualBasic; try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('"
          + p.replace(/'/g, "''")
          + "', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) } catch { }";
        // 用 Base64(UTF-16LE) 编码命令，彻底避开引号/特殊字符转义问题
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        require('child_process').exec('powershell -NoProfile -EncodedCommand ' + encoded, () => {
          if (fs.existsSync(p)) {
            res.writeHead(500); res.end('删除失败：文件仍存在，可能被其他程序占用');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('ok');
        });
      } catch (e) {
        res.writeHead(500); res.end('删除失败: ' + e.message);
      }
    });
    return;
  }

  // 当前工作目录 + 最近使用列表
  if (req.method === 'GET' && url.pathname === '/api/dir') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ dir: DOC_DIR, recent: RECENT_DIRS }));
    return;
  }

  // 切换工作目录
  if (req.method === 'POST' && url.pathname === '/api/dir') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { dir } = JSON.parse(body);
        if (!dir || !String(dir).trim()) { res.writeHead(400); res.end('目录不能为空'); return; }
        const target = path.resolve(String(dir).trim());
        if (!fs.existsSync(target)) { res.writeHead(400); res.end('目录不存在：' + target); return; }
        if (!fs.statSync(target).isDirectory()) { res.writeHead(400); res.end('不是文件夹：' + target); return; }
        DOC_DIR = target;
        RECENT_DIRS = [target, ...RECENT_DIRS.filter(d => d !== target)].slice(0, 8);
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ dir: DOC_DIR, recent: RECENT_DIRS, count: listFiles().length }));
      } catch (e) {
        res.writeHead(500); res.end('切换失败: ' + e.message);
      }
    });
    return;
  }

  // 从「最近使用」里移除一条记录
  // 只影响历史列表，不动当前目录、也不碰磁盘上的文件夹
  if (req.method === 'POST' && url.pathname === '/api/dir/remove') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { dir } = JSON.parse(body);
        const target = String(dir == null ? '' : dir).trim();
        if (!target) { res.writeHead(400); res.end('缺少目录'); return; }
        RECENT_DIRS = RECENT_DIRS.filter(d => d !== target);
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ dir: DOC_DIR, recent: RECENT_DIRS }));
      } catch (e) {
        res.writeHead(500); res.end('移除失败: ' + e.message);
      }
    });
    return;
  }

  // 浏览文件夹：服务端只负责列目录，界面由页面自己渲染
  // 早期版本是用 PowerShell 调系统文件夹选择框，但那个对话框被「取消」后进程会挂住不退出，
  // Node 的 exec 回调因此永远不触发，请求悬着、按钮永远停在「选择中…」。
  // 改成这个方案后不依赖任何 GUI 子进程，也就不会再卡死。
  if (req.method === 'GET' && url.pathname === '/api/browse') {
    const dir = url.searchParams.get('dir') || '';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(listDir(dir)));
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

function openBrowser() {
  if (process.env.DOC_MGR_NO_OPEN) return; // 供后台/测试启动使用
  require('child_process').exec(
    `start "" http://${HOST}:${PORT}`,
    { shell: 'cmd.exe' },
    () => {}
  );
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 端口被占用 = 服务已经在运行，不重复启动，直接打开页面
    console.log('===========================================');
    console.log('文档管理器已经在运行了，不重复启动。');
    console.log('正在为你打开页面，此窗口 3 秒后自动关闭。');
    console.log('===========================================');
    openBrowser();
    setTimeout(() => process.exit(0), 3000);
    return;
  }
  console.error('启动失败: ' + err.message);
  // 出错时暂停窗口（双击运行时），让用户能看清错误信息
  if (process.stdin.isTTY) {
    console.log('按回车键关闭窗口…');
    process.stdin.once('data', () => process.exit(1));
    process.stdin.once('end', () => process.exit(1)); // 无交互输入时直接退出
    process.stdin.resume();
  } else {
    process.exit(1);
  }
});

// ---------- 自检：页面内嵌脚本能否通过语法解析 ----------
// 页面代码嵌在模板字符串里，一旦转义写错（比如单引号没转义），发给浏览器的
// JS 就会解析失败，表现为「左侧没内容、按钮点了没反应」，很难一眼看出原因。
// 这里在启动时先解析一遍（只做语法检查，不执行），有问题立刻在窗口里报出来。
function selfCheckPageScript() {
  try {
    const blocks = PAGE_HTML.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
    blocks.forEach((block, i) => {
      const code = block.replace(/^<script[^>]*>/, '').replace(/<\/script>\s*$/, '');
      new vm.Script(code, { filename: 'page-inline-' + i + '.js' });
    });
    return true;
  } catch (e) {
    console.error('===========================================');
    console.error('【警告】页面内嵌脚本有语法错误，页面可能无法使用！');
    console.error('  ' + e.message);
    console.error('===========================================');
    return false;
  }
}

server.listen(PORT, HOST, () => {
  console.log(`文档管理器已启动: http://${HOST}:${PORT}`);
  console.log(`文档目录: ${DOC_DIR}`);
  if (selfCheckPageScript()) console.log('页面脚本自检通过。');
  console.log('关闭此窗口即停止服务。');
  // 服务就绪后自动打开默认浏览器（监听失败时不会走到这里，不会误开）
  // 环境变量 DOC_MGR_NO_OPEN=1 时跳过，供后台/测试启动使用
  if (!process.env.DOC_MGR_NO_OPEN) openBrowser();
});

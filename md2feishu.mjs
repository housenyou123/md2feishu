#!/usr/bin/env node
/**
 * md2feishu.mjs — Convert Markdown to Feishu document
 *
 * Commands:
 *   node md2feishu.mjs login              Print OAuth URL
 *   node md2feishu.mjs login <code>       Exchange code for user token
 *   node md2feishu.mjs <file.md> [opts]   Convert file (auto MCP or tenant mode)
 *
 * Options:
 *   --title "Title"       Document title
 *   --folder fldcnXXX     Target folder token
 *   --tenant              Force tenant mode (skip OAuth/MCP)
 *   -h, --help            Show help
 *
 * MCP mode (with user token):  Rich Lark Markdown, doc under user's name
 * Tenant mode (fallback):      Basic Markdown, doc under app's name
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { createServer } from 'http';
import { execSync } from 'child_process';

const API = 'https://open.feishu.cn/open-apis';
const MCP_ENDPOINT = 'https://mcp.feishu.cn/mcp';
const TOKEN_FILE = join(homedir(), '.feishu-md2feishu-token.json');
const REDIRECT_URI = 'http://127.0.0.1:19876/callback';
const REDIRECT_URI_FALLBACK = 'https://www.feishu.cn';

// ═══════════════════════════════════════════════════════════════════
// Credentials
// ═══════════════════════════════════════════════════════════════════

function getCredentials() {
  const envId = process.env.FEISHU_APP_ID;
  const envSecret = process.env.FEISHU_APP_SECRET;
  if (envId && envSecret) return { appId: envId, appSecret: envSecret };

  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.claude/mcp.json'), 'utf8'));
    const args = config.mcpServers['lark-mcp'].args;
    const aIdx = args.indexOf('-a');
    const sIdx = args.indexOf('-s');
    return { appId: args[aIdx + 1], appSecret: args[sIdx + 1] };
  } catch {
    throw new Error('No credentials found. Set FEISHU_APP_ID+FEISHU_APP_SECRET or configure lark-mcp in ~/.claude/mcp.json');
  }
}

// ═══════════════════════════════════════════════════════════════════
// Auth: App & Tenant tokens
// ═══════════════════════════════════════════════════════════════════

async function getAppToken(appId, appSecret) {
  const res = await fetch(`${API}/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`App auth failed: ${d.msg}`);
  return d.app_access_token;
}

async function getTenantToken(appId, appSecret) {
  const res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`Tenant auth failed: ${d.msg}`);
  return d.tenant_access_token;
}

// ═══════════════════════════════════════════════════════════════════
// Auth: User OAuth
// ═══════════════════════════════════════════════════════════════════

function saveUserToken(token) {
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

function loadUserToken() {
  try {
    if (existsSync(TOKEN_FILE)) return JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  } catch {}
  return null;
}

async function exchangeCode(appToken, code) {
  const res = await fetch(`${API}/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appToken}` },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`Code exchange failed: ${d.msg} (code ${d.code})`);
  return d.data;
}

async function refreshToken(appToken, refreshTk) {
  const res = await fetch(`${API}/authen/v1/oidc/refresh_access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appToken}` },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshTk }),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`Token refresh failed: ${d.msg}`);
  return d.data;
}

/**
 * Get valid user access token: load → refresh → null
 */
async function getUserToken(appId, appSecret) {
  let saved = loadUserToken();
  if (!saved) return null;

  // Check if still valid (with 60s buffer)
  if (saved.expires_at > Date.now() + 60000) {
    return saved.access_token;
  }

  // Try refresh
  if (saved.refresh_token) {
    try {
      console.log('User token expired, refreshing...');
      const appToken = await getAppToken(appId, appSecret);
      const newData = await refreshToken(appToken, saved.refresh_token);
      const newSaved = {
        access_token: newData.access_token,
        refresh_token: newData.refresh_token,
        expires_at: Date.now() + newData.expires_in * 1000,
        app_id: appId,
      };
      saveUserToken(newSaved);
      console.log('Token refreshed successfully.');
      return newSaved.access_token;
    } catch (e) {
      console.log(`Token refresh failed: ${e.message}`);
    }
  }

  return null;
}

/**
 * Start local server and do OAuth flow automatically
 */
function oauthWithLocalServer(appId) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>✅ 授权成功！</h2><p>可以关闭此页面了。</p></body></html>');
          server.close();
          resolve(code);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h2>❌ 授权失败：未收到 code</h2></body></html>');
          server.close();
          reject(new Error('No code in callback'));
        }
      }
    });

    server.on('error', () => resolve(null)); // port busy, fallback to manual

    server.listen(19876, '127.0.0.1', () => {
      const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=md2feishu`;
      console.log('Opening browser for authorization...');
      try {
        execSync(`open "${authUrl}"`, { stdio: 'ignore' });
      } catch {
        console.log(`Please open this URL manually:\n${authUrl}`);
      }
    });

    // Timeout after 120s
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout (120s)')); }, 120000);
  });
}

// ═══════════════════════════════════════════════════════════════════
// Login command
// ═══════════════════════════════════════════════════════════════════

async function handleLogin(args) {
  const { appId, appSecret } = getCredentials();
  const code = args[0]; // login <code>

  if (code) {
    // Exchange code for token
    console.log('Exchanging code for token...');
    const appToken = await getAppToken(appId, appSecret);
    const data = await exchangeCode(appToken, code);
    const saved = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      app_id: appId,
    };
    saveUserToken(saved);
    console.log('✅ 授权成功！Token 已保存到', TOKEN_FILE);
    console.log(`有效期: ${Math.round(data.expires_in / 3600)} 小时`);
    return;
  }

  // Try local server first
  console.log('Starting OAuth flow...');
  try {
    const authCode = await oauthWithLocalServer(appId);
    if (authCode) {
      const appToken = await getAppToken(appId, appSecret);
      const data = await exchangeCode(appToken, authCode);
      const saved = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
        app_id: appId,
      };
      saveUserToken(saved);
      console.log('\n✅ 授权成功！Token 已保存。');
      console.log(`有效期: ${Math.round(data.expires_in / 3600)} 小时`);
      return;
    }
  } catch (e) {
    if (e.message.includes('redirect_uri')) {
      console.log('\n⚠️  Redirect URI 未注册。');
      console.log('请到飞书开发者后台 → 应用 → 安全设置 → 重定向 URL，添加:');
      console.log(`  ${REDIRECT_URI}\n`);
    }
  }

  // Fallback: manual flow
  const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${encodeURIComponent(REDIRECT_URI_FALLBACK)}&state=md2feishu`;
  console.log('请在浏览器中打开以下链接进行授权:\n');
  console.log(authUrl);
  console.log('\n授权后，从地址栏复制 code= 参数的值，然后运行:');
  console.log(`  node md2feishu.mjs login <code>\n`);
}

// ═══════════════════════════════════════════════════════════════════
// MCP Mode: call mcp.feishu.cn
// ═══════════════════════════════════════════════════════════════════

async function callMcp(userToken, toolName, toolArgs) {
  const body = {
    jsonrpc: '2.0',
    id: `md2feishu-${Date.now()}`,
    method: 'tools/call',
    params: { name: toolName, arguments: toolArgs },
  };
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lark-MCP-UAT': userToken,
      'X-Lark-MCP-Allowed-Tools': toolName,
      'User-Agent': 'md2feishu/1.0',
    },
    body: JSON.stringify(body),
  });
  const d = await res.json();

  // JSON-RPC error
  if (d.error) throw new Error(`MCP error: ${JSON.stringify(d.error)}`);

  // Unwrap result
  const content = d.result?.content;
  if (content?.[0]?.text) {
    try { return JSON.parse(content[0].text); } catch { return content[0].text; }
  }
  return d.result;
}

async function createViaMcp(userToken, mdContent, title, folderToken) {
  const args = { markdown: mdContent };
  if (title) args.title = title;
  if (folderToken) args.folder_token = folderToken;

  console.log('Creating document via MCP (rich formatting)...');
  const result = await callMcp(userToken, 'create-doc', args);
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Tenant Mode: direct REST API + local parser (fallback)
// ═══════════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiCall(token, method, path, body, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const opts = {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);

    // Rate limited — wait and retry
    if (res.status === 429 && attempt < retries) {
      const wait = (attempt + 1) * 1000;
      console.log(`Rate limited, waiting ${wait}ms...`);
      await sleep(wait);
      continue;
    }

    const text = await res.text();
    let d;
    try { d = JSON.parse(text); } catch { throw new Error(`API ${path}: invalid response (${res.status})`); }
    if (d.code !== 0) throw new Error(`API ${path}: ${d.msg} (code ${d.code})`);
    return d.data;
  }
}

// Code block language mapping
const LANG = {
  '': 1, plaintext: 1, text: 1, bash: 7, sh: 60, shell: 60, zsh: 60,
  c: 10, cpp: 9, 'c++': 9, csharp: 8, cs: 8, css: 12, scss: 55, dart: 15,
  dockerfile: 18, go: 22, golang: 22, html: 24, json: 28, java: 29,
  javascript: 30, js: 30, jsx: 30, kotlin: 32, kt: 32, lua: 36,
  makefile: 38, markdown: 39, md: 39, nginx: 40, objc: 41, php: 43,
  python: 49, py: 49, r: 50, ruby: 52, rb: 52, rust: 53, rs: 53,
  sql: 56, scala: 57, swift: 61, typescript: 63, ts: 63, tsx: 63,
  xml: 66, yaml: 67, yml: 67, toml: 75, graphql: 71, diff: 69,
};

function parseInline(text) {
  if (!text) return [{ text_run: { content: '', text_element_style: {} } }];
  const els = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) { els.push({ text_run: { content: text.slice(i + 1, end), text_element_style: { inline_code: true } } }); i = end + 1; continue; }
    }
    if (text.slice(i, i + 3) === '***') {
      const end = text.indexOf('***', i + 3);
      if (end > i) { els.push({ text_run: { content: text.slice(i + 3, end), text_element_style: { bold: true, italic: true } } }); i = end + 3; continue; }
    }
    if (text.slice(i, i + 2) === '**') {
      const end = text.indexOf('**', i + 2);
      if (end > i) { els.push({ text_run: { content: text.slice(i + 2, end), text_element_style: { bold: true } } }); i = end + 2; continue; }
    }
    if (text[i] === '*' && i + 1 < text.length && text[i + 1] !== '*' && text[i + 1] !== ' ') {
      const end = text.indexOf('*', i + 1);
      if (end > i + 1) { els.push({ text_run: { content: text.slice(i + 1, end), text_element_style: { italic: true } } }); i = end + 1; continue; }
    }
    if (text.slice(i, i + 2) === '~~') {
      const end = text.indexOf('~~', i + 2);
      if (end > i) { els.push({ text_run: { content: text.slice(i + 2, end), text_element_style: { strikethrough: true } } }); i = end + 2; continue; }
    }
    if (text[i] === '[') {
      const cb = text.indexOf(']', i + 1);
      if (cb > i && text[cb + 1] === '(') {
        const cp = text.indexOf(')', cb + 2);
        if (cp > cb) { els.push({ text_run: { content: text.slice(i + 1, cb), text_element_style: { link: { url: encodeURI(text.slice(cb + 2, cp)) } } } }); i = cp + 1; continue; }
      }
    }
    let end = i + 1;
    while (end < text.length && !'`*~['.includes(text[end])) end++;
    els.push({ text_run: { content: text.slice(i, end), text_element_style: {} } });
    i = end;
  }
  return els.length ? els : [{ text_run: { content: '', text_element_style: {} } }];
}

const mk = {
  text: (c) => ({ block_type: 2, text: { elements: parseInline(c) } }),
  heading: (l, c) => ({ block_type: 2 + l, [`heading${l}`]: { elements: parseInline(c) } }),
  bullet: (c) => ({ block_type: 12, bullet: { elements: parseInline(c) } }),
  ordered: (c) => ({ block_type: 13, ordered: { elements: parseInline(c) } }),
  code: (c, lang) => ({ block_type: 14, code: { style: { language: LANG[lang?.toLowerCase()] ?? 1 }, elements: [{ text_run: { content: c, text_element_style: {} } }] } }),
  quote: (c) => ({ block_type: 15, quote: { elements: parseInline(c) } }),
  todo: (c, done) => ({ block_type: 17, todo: { elements: parseInline(c), style: { done } } }),
  divider: () => ({ block_type: 22, divider: {} }),
  // Table stored as metadata — requires two-step API insertion
  // Feishu limits: max 9 rows per table creation
  table: (headers, rows) => {
    const MAX_ROWS = 8;
    const actualRows = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
    const overflowRows = rows.length > MAX_ROWS ? rows.slice(MAX_ROWS) : null;

    // Calculate column widths proportional to content display width
    // CJK chars ≈ 2x width of ASCII, measure in "display units"
    const TOTAL_WIDTH = 730;
    const MIN_COL = 100;
    const displayWidth = (str) => {
      let w = 0;
      for (const ch of str.replace(/\*\*/g, '')) {
        w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
      }
      return w;
    };
    const colMaxLen = headers.map((h, ci) => {
      let max = displayWidth(h);
      for (const row of rows) {
        const cw = displayWidth(row[ci] || '');
        if (cw > max) max = cw;
      }
      return Math.max(max, 4);
    });
    const totalLen = colMaxLen.reduce((a, b) => a + b, 0);
    let colWidths = colMaxLen.map(len => Math.max(MIN_COL, Math.round((len / totalLen) * TOTAL_WIDTH)));
    // Normalize to exactly TOTAL_WIDTH
    const rawTotal = colWidths.reduce((a, b) => a + b, 0);
    colWidths = colWidths.map(w => Math.round((w / rawTotal) * TOTAL_WIDTH));

    const prop = {
      row_size: actualRows.length + 1,
      column_size: headers.length,
      header_row: true,
      column_width: colWidths,
    };

    return {
      block_type: 31,
      _table_data: { headers, rows: actualRows },
      ...(overflowRows ? { _overflow_rows: overflowRows } : {}),
      table: { property: prop },
    };
  },
};

function parseMarkdown(md) {
  const fmMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  let frontmatter = {};
  if (fmMatch) {
    md = md.slice(fmMatch[0].length);
    const tm = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (tm) frontmatter.title = tm[1];
  }
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trimEnd();
    if (t === '') { i++; continue; }
    const hm = t.match(/^(#{1,6})\s+(.+?)(?:\s*\{.*\})?\s*$/);
    if (hm) { blocks.push(mk.heading(hm[1].length, hm[2])); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) { blocks.push(mk.divider()); i++; continue; }
    if (t.startsWith('```')) {
      const lang = t.slice(3).trim(); const cl = []; i++;
      while (i < lines.length && !lines[i].trimEnd().startsWith('```')) { cl.push(lines[i]); i++; }
      blocks.push(mk.code(cl.join('\n'), lang)); i++; continue;
    }
    const tdm = t.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)/);
    if (tdm) { blocks.push(mk.todo(tdm[2], tdm[1].toLowerCase() === 'x')); i++; continue; }
    const bm = t.match(/^\s*[-*+]\s+(.*)/);
    if (bm) { blocks.push(mk.bullet(bm[1])); i++; continue; }
    const om = t.match(/^\s*\d+\.\s+(.*)/);
    if (om) { blocks.push(mk.ordered(om[1])); i++; continue; }
    if (t.startsWith('>')) {
      const ql = [];
      while (i < lines.length && lines[i].trimEnd().startsWith('>')) { ql.push(lines[i].replace(/^>\s?/, '')); i++; }
      const c = ql.join('\n').trim(); if (c) blocks.push(mk.quote(c)); continue;
    }
    if (t.includes('|') && i + 1 < lines.length && /^\|?\s*:?-+/.test(lines[i + 1])) {
      const headers = t.split('|').map(c => c.trim()).filter(Boolean);
      i += 2; // skip header + separator
      const dataRows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = lines[i].split('|').map(c => c.trim()).filter(Boolean);
        // Pad or trim to match header column count
        while (cells.length < headers.length) cells.push('');
        dataRows.push(cells.slice(0, headers.length));
        i++;
      }
      blocks.push(mk.table(headers, dataRows));
      continue;
    }
    const im = t.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (im) { blocks.push(mk.text(`[${im[1] || 'Image'}](${im[2]})`)); i++; continue; }
    const pl = [t]; i++;
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].trimEnd().startsWith('```') && !lines[i].match(/^\s*[-*+]\s/) &&
      !lines[i].match(/^\s*\d+\.\s/) && !lines[i].startsWith('>') &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i].trimEnd())) { pl.push(lines[i].trimEnd()); i++; }
    blocks.push(mk.text(pl.join(' ')));
  }
  return { blocks, frontmatter };
}

async function setDocPublic(token, docId) {
  try {
    // Set link sharing: anyone in org can edit
    const res = await fetch(`${API}/drive/v1/permissions/${docId}/public?type=docx`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_access_entity: 'open',
        security_entity: 'anyone_can_view',
        link_share_entity: 'tenant_editable',
      }),
    });
    const d = await res.json();
    if (d.code === 0) {
      console.log('Link sharing enabled (org members can edit).');
    } else {
      console.log(`Note: Could not set sharing permissions: ${d.msg} (code ${d.code})`);
    }
  } catch (e) {
    console.log(`Note: Permission API failed: ${e.message}`);
  }
}

async function createViaTenant(appId, appSecret, mdContent, title, folderToken) {
  console.log('Using tenant mode...');
  const { blocks, frontmatter } = parseMarkdown(mdContent);
  if (!blocks.length) throw new Error('No content blocks parsed');
  if (!title) title = frontmatter.title;

  const token = await getTenantToken(appId, appSecret);
  const docData = await apiCall(token, 'POST', '/docx/v1/documents', {
    title, ...(folderToken ? { folder_token: folderToken } : {}),
  });
  const docId = docData.document.document_id;

  // Insert blocks: tables must be inserted individually, others in batches
  const BATCH = 50;
  let pending = [];
  let insertedCount = 0;

  async function flushPending() {
    if (pending.length === 0) return;
    await apiCall(token, 'POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, { children: pending, index: -1 });
    insertedCount += pending.length;
    pending = [];
    await sleep(200);
  }

  for (const block of blocks) {
    if (block.block_type === 31) {
      await flushPending();
      const td = block._table_data;
      try {
        // Step 1: Create empty table
        const { row_size, column_size } = block.table.property;
        console.log(`Creating table ${column_size}×${row_size}...`);
        const tableOnly = { block_type: 31, table: block.table };
        const res = await apiCall(token, 'POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, { children: [tableOnly], index: -1 });
        await sleep(300);

        // Step 2: Get cell IDs directly from create response
        const tableBlock = res.children?.[0];
        const cellIds = tableBlock?.table?.cells || [];
        if (cellIds.length > 0) {
          const cols = block.table.property.column_size;

          // Step 3: Fill cells with content
          const allCellData = [];
          // Header row
          for (const h of td.headers) allCellData.push(`**${h}**`);
          // Data rows
          for (const row of td.rows) {
            for (let c = 0; c < cols; c++) allCellData.push(row[c] || '');
          }

          for (let idx = 0; idx < cellIds.length && idx < allCellData.length; idx++) {
            const content = allCellData[idx];
            if (content) {
              try {
                await apiCall(token, 'POST', `/docx/v1/documents/${docId}/blocks/${cellIds[idx]}/children`, {
                  children: [mk.text(content)],
                  index: 0,
                });
                await sleep(100); // avoid rate limit
              } catch { /* skip cell errors */ }
            }
          }
        }
        insertedCount++;
        await sleep(200);
        const totalRows = td.rows.length + 1 + (block._overflow_rows?.length || 0);
        console.log(`Table inserted (${td.headers.length} cols × ${totalRows} rows${block._overflow_rows ? ', overflow→text' : ''})`);

        // Handle overflow rows as text blocks
        if (block._overflow_rows?.length) {
          const overflowBlocks = block._overflow_rows.map(row => mk.text(row.join('  |  ')));
          await apiCall(token, 'POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, { children: overflowBlocks, index: -1 });
          insertedCount += overflowBlocks.length;
          await sleep(200);
        }
      } catch (e) {
        // Fallback to text
        console.log(`Table failed: ${e.message}, using text fallback`);
        const fallback = [mk.text(td.headers.map(h => `**${h}**`).join('  |  ')), mk.divider()];
        for (const row of td.rows) fallback.push(mk.text(row.join('  |  ')));
        await apiCall(token, 'POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, { children: fallback, index: -1 });
        insertedCount += fallback.length;
      }
    } else {
      pending.push(block);
      if (pending.length >= BATCH) await flushPending();
    }
  }
  await flushPending();
  console.log(`Inserted ${insertedCount} blocks total.`);

  // Set document to be accessible via link
  await setDocPublic(token, docId);

  return { doc_id: docId, doc_url: `https://feishu.cn/docx/${docId}`, blocks_count: blocks.length, mode: 'tenant' };
}

// ═══════════════════════════════════════════════════════════════════
// Config command
// ═══════════════════════════════════════════════════════════════════

async function handleConfig(args) {
  const mcpPath = join(homedir(), '.claude/mcp.json');

  // config --id cli_xxx --secret xxx → update credentials
  let newId = null, newSecret = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && args[i + 1]) newId = args[++i];
    else if (args[i] === '--secret' && args[i + 1]) newSecret = args[++i];
  }

  if (newId || newSecret) {
    if (!newId || !newSecret) {
      console.error('Error: --id and --secret must both be provided');
      process.exit(1);
    }
    if (!newId.startsWith('cli_')) {
      console.error('Error: App ID should start with cli_');
      process.exit(1);
    }

    // Validate
    console.log('验证凭据...');
    try {
      await getTenantToken(newId, newSecret);
    } catch (e) {
      console.error(`❌ 凭据验证失败: ${e.message}`);
      process.exit(1);
    }
    console.log('✅ 凭据有效');

    // Write
    let config = {};
    try { config = JSON.parse(readFileSync(mcpPath, 'utf8')); } catch {}
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers['lark-mcp'] = { command: 'echo', args: ['-a', newId, '-s', newSecret] };
    writeFileSync(mcpPath, JSON.stringify(config, null, 2));
    console.log(`✅ 凭据已更新: ${newId}`);
    return;
  }

  // config (no args) → show current
  try {
    const { appId, appSecret } = getCredentials();
    const secretPreview = appSecret.slice(0, 4) + '***';
    console.log(`当前飞书应用配置:`);
    console.log(`  App ID:     ${appId}`);
    console.log(`  App Secret: ${secretPreview}`);
    console.log(`  来源:       ${process.env.FEISHU_APP_ID ? '环境变量' : mcpPath}`);

    // Validate
    try {
      await getTenantToken(appId, appSecret);
      console.log(`  状态:       ✅ 有效`);
    } catch {
      console.log(`  状态:       ❌ 已失效（请用 config --id --secret 更新）`);
    }
  } catch {
    console.log('未配置飞书应用凭据。');
    console.log('');
    console.log('使用方式:');
    console.log('  node md2feishu.mjs config --id cli_xxx --secret your_secret');
    console.log('');
    console.log('或运行安装脚本: bash setup.sh');
  }
}

// ═══════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);

  // Help
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(`
md2feishu — Markdown 转飞书文档

Commands:
  login              OAuth 登录（获取用户令牌，支持富文本排版）
  login <code>       用授权码换取令牌
  config             查看当前飞书应用配置
  config --id cli_xxx --secret xxx  更新凭据
  <file.md> [opts]   转换文件

Options:
  --title "标题"     文档标题（默认取文件名或 frontmatter title）
  --folder fldcnXXX  目标文件夹
  --tenant           强制使用应用身份（跳过 OAuth）

Modes:
  MCP mode   (有用户令牌时) 完整飞书排版：callout、分栏、表格、Mermaid
  Tenant mode (无用户令牌时) 基础 Markdown：标题、列表、代码、引用
`);
    process.exit(0);
  }

  // Login command
  if (args[0] === 'login') {
    await handleLogin(args.slice(1));
    return;
  }

  // Config command
  if (args[0] === 'config') {
    await handleConfig(args.slice(1));
    return;
  }

  // Convert file
  const filePath = args[0];
  let title = null, folderToken = null, forceTenant = false;
  for (let j = 1; j < args.length; j++) {
    if (args[j] === '--title' && args[j + 1]) title = args[++j];
    else if (args[j] === '--folder' && args[j + 1]) folderToken = args[++j];
    else if (args[j] === '--tenant') forceTenant = true;
  }

  let mdContent;
  try { mdContent = readFileSync(filePath, 'utf8'); } catch (e) {
    console.error(`Error: Cannot read "${filePath}": ${e.message}`); process.exit(1);
  }
  if (!mdContent.trim()) { console.error('Error: File is empty'); process.exit(1); }

  // Auto title from frontmatter or filename
  if (!title) {
    const fm = mdContent.match(/^---\r?\n[\s\S]*?title:\s*["']?(.+?)["']?\s*$[\s\S]*?\r?\n---/m);
    if (fm) title = fm[1];
    else title = basename(filePath, '.md');
  }

  console.log(`File: ${filePath}`);
  console.log(`Title: "${title}"`);

  const { appId, appSecret } = getCredentials();
  let result;

  // Try MCP mode first (if user token available)
  if (!forceTenant) {
    const userToken = await getUserToken(appId, appSecret);
    if (userToken) {
      try {
        result = await createViaMcp(userToken, mdContent, title, folderToken);
        result.mode = 'mcp';
        console.log('\n========================================');
        console.log('✅ Document created (MCP mode - rich formatting)');
        console.log(`URL: ${result.doc_url}`);
        console.log(`ID:  ${result.doc_id}`);
        console.log('========================================');
        console.log(JSON.stringify({ success: true, ...result }));
        return;
      } catch (e) {
        console.log(`MCP mode failed: ${e.message}`);
        console.log('Falling back to tenant mode...\n');
      }
    } else {
      console.log('No user token found. Using tenant mode.');
      console.log('Run "node md2feishu.mjs login" for rich formatting + user-owned docs.\n');
    }
  }

  // Tenant mode fallback
  result = await createViaTenant(appId, appSecret, mdContent, title, folderToken);
  console.log('\n========================================');
  console.log('✅ Document created (tenant mode - basic formatting)');
  console.log(`URL: ${result.doc_url}`);
  console.log(`ID:  ${result.doc_id}`);
  console.log(`Blocks: ${result.blocks_count}`);
  console.log('========================================');
  console.log(JSON.stringify({ success: true, ...result }));
}

main().catch(e => {
  console.error(`\nError: ${e.message}`);
  if (e.message.includes('99991663') || e.message.includes('99991664')) {
    console.error('\nHint: App may lack doc permissions. Add in developer console:');
    console.error('  docx:document, docx:document:readonly, drive:drive');
  }
  process.exit(1);
});

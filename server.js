#!/usr/bin/env node
/**
 * Figma Bridge MCP Server
 *
 * Runs in two modes:
 * - PRIMARY: Opens port 3055, waits for the Figma plugin, and listens for MCP over stdio
 * - PROXY:   If the port is in use, connects to the existing primary server over WebSocket
 *            and forwards MCP commands to it
 */

const { WebSocketServer, WebSocket } = require('ws');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const WS_PORT = 3055;
const VERSION = require('./package.json').version;

// ─── Determine whether this process should run as primary or proxy ──────────

// One context for the life of the process: the MCP stdio loop reads it on every
// request, and a proxy that takes over the port swaps it to primary in place.
const ctx = {};
let stdioStarted = false;

function ensureStdio() {
  if (stdioStarted) return;
  stdioStarted = true;
  startStdioMCP(ctx);
}

// stdin is read from the start, so a client that leaves while this process is
// still finding the primary is noticed too.
ensureStdio();
tryStartPrimary();

function tryStartPrimary() {
  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('Port is in use; switching to proxy mode...');
      startProxy();
    } else {
      log(`WebSocket error: ${err.message}`);
      process.exit(1);
    }
  });

  wss.on('listening', () => {
    log(`PRIMARY mode — listening at ws://localhost:${WS_PORT}`);
    startPrimary(wss);
  });
}

// ─── PRIMARY MODE ───────────────────────────────────────────────────────────

function startPrimary(wss) {
  const figmaClients = new Map();
  const pendingRequests = new Map();
  let requestCounter = 0;

  wss.on('connection', (ws, req) => {
    // Classify the connection by its first message:
    // - `hello` (role: figma-plugin)  → Figma plugin
    // - `_mcpProxy`                   → proxy server
    // Do not add the connection to figmaClients until it is classified. This
    // prevents proxies and unidentified connections from appearing as plugins.
    const connId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let role = null;
    log(`Connection opened: ${connId}`);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Figma plugin handshake
        if (msg.type === 'hello' && msg.role === 'figma-plugin') {
          role = 'figma-plugin';
          figmaClients.set(connId, ws);
          log(`Figma plugin registered: ${connId} (active plugins: ${figmaClients.size})`);
          return;
        }

        // MCP command received from a proxy
        if (msg._mcpProxy) {
          if (!role) { role = 'proxy'; log(`Proxy registered: ${connId}`); }
          handleProxyCommand(ws, msg, figmaClients, pendingRequests, requestCounter++);
          return;
        }
        // Response received from the Figma plugin
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
          const pending = pendingRequests.get(msg.requestId);
          pendingRequests.delete(msg.requestId);
          clearTimeout(pending.timeout);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.result);
          return;
        }
        log(`Unhandled message: ${JSON.stringify(msg).slice(0, 100)}`);
      } catch (e) {
        log(`Invalid message: ${e.message}`);
      }
    });

    ws.on('close', () => {
      if (figmaClients.delete(connId)) {
        log(`Figma plugin disconnected: ${connId} (active plugins: ${figmaClients.size})`);
      } else {
        log(`Connection closed: ${connId} (${role || 'unclassified'})`);
      }
    });

    ws.on('error', (err) => log(`WebSocket error [${connId}]: ${err.message}`));
  });

  function handleProxyCommand(proxyWs, msg, figmaClients, pendingRequests, counter) {
    const { _mcpProxy: proxyId, command, params } = msg;

    // figma_status
    if (command === 'figma_status') {
      pickFigmaClient(figmaClients); // Remove stale connections
      const figmaCount = figmaClients.size;
      proxyWs.send(JSON.stringify({
        _mcpProxyResponse: proxyId,
        result: (figmaCount > 0
          ? `✅ Figma plugin connected (${figmaCount} instance)`
          : '❌ No Figma plugin connected. Open Figma and run the Figma Bridge plugin.') + ` · bridge ${VERSION} (pid ${process.pid})`
      }));
      return;
    }

    // Forward to the most recently connected open Figma plugin and remove
    // stale connections.
    const figmaWs = pickFigmaClient(figmaClients);
    if (!figmaWs) {
      proxyWs.send(JSON.stringify({
        _mcpProxyResponse: proxyId,
        error: 'No Figma plugin connected. Open Figma and run the bridge plugin.'
      }));
      return;
    }

    const requestId = `req_${counter}_${Date.now()}`;
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      proxyWs.send(JSON.stringify({
        _mcpProxyResponse: proxyId,
        error: `Timeout waiting for Figma response (${timeoutFor(params) / 1000}s)`
      }));
    }, timeoutFor(params));

    pendingRequests.set(requestId, {
      resolve: (result) => {
        proxyWs.send(JSON.stringify({ _mcpProxyResponse: proxyId, result }));
      },
      reject: (err) => {
        proxyWs.send(JSON.stringify({ _mcpProxyResponse: proxyId, error: err.message }));
      },
      timeout
    });

    figmaWs.send(JSON.stringify({ requestId, command, params }));
  }

  // In primary mode, MCP communicates directly over stdio.
  for (const k of Object.keys(ctx)) delete ctx[k];
  Object.assign(ctx, { direct: true, figmaClients, pendingRequests, requestCounterRef: { v: 0 } });
  ensureStdio();
}

// ─── PROXY MODE ─────────────────────────────────────────────────────────────

function startProxy() {
  log('PROXY mode — connecting to the primary server...');

  let proxyWs = null;
  let proxyCounter = 0;
  const pendingProxy = new Map();

  function connect() {
    proxyWs = new WebSocket(`ws://localhost:${WS_PORT}`);

    proxyWs.on('open', () => {
      log('Connected to the primary server');
      for (const k of Object.keys(ctx)) delete ctx[k];
      Object.assign(ctx, { direct: false, proxyWs, pendingProxy, proxyCounterRef: { v: 0 } });
      ensureStdio();
    });

    proxyWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg._mcpProxyResponse && pendingProxy.has(msg._mcpProxyResponse)) {
          const { resolve, reject } = pendingProxy.get(msg._mcpProxyResponse);
          pendingProxy.delete(msg._mcpProxyResponse);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      } catch (e) {
        log(`Proxy message error: ${e.message}`);
      }
    });

    proxyWs.on('error', (err) => log(`Proxy WebSocket error: ${err.message}`));
    // The primary is usually a bridge started by another session. When it
    // exits, take the port over (or follow whoever did) instead of leaving
    // this MCP client stranded until it is restarted.
    proxyWs.on('close', () => {
      log('Disconnected from the primary server; taking over or reconnecting...');
      for (const [, { reject }] of pendingProxy) reject(new Error('The primary bridge server closed during the request; retry it.'));
      pendingProxy.clear();
      setTimeout(tryStartPrimary, 300 + Math.random() * 1000);
    });
  }

  connect();
}

// ─── Stdio MCP ────────────────────────────────────────────────────────────────

function startStdioMCP(ctx) {
  const rl = readline.createInterface({ input: process.stdin });

  // The MCP client owns this process through stdin. When the client goes away
  // (window closed, session crashed) stdin closes, but the WebSocket server
  // would keep the process alive forever — and an orphaned primary keeps the
  // port with stale code. Exit instead; a proxy elsewhere takes the port over.
  rl.on('close', () => {
    log('MCP client closed stdin; exiting');
    process.exit(0);
  });

  rl.on('line', async (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    const response = await handleMCPRequest(request, ctx);
    process.stdout.write(JSON.stringify(response) + '\n');
  });

  log('MCP stdio ready');
}

async function handleMCPRequest(req, ctx) {
  const { id, method, params } = req;
  try {
    switch (method) {
      case 'initialize':
        return mcpResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'figma-bridge-mcp', version: VERSION }
        });
      case 'tools/list':
        return mcpResult(id, { tools: MCP_TOOLS });
      case 'tools/call':
        return mcpResult(id, await callTool(params.name, params.arguments || {}, ctx));
      case 'notifications/initialized':
      case 'ping':
        return mcpResult(id, {});
      default:
        return mcpError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (err) {
    return mcpError(id, -32603, err.message);
  }
}

async function callTool(name, args, ctx) {
  let resultText;

  if (name === 'figma_status' && ctx.direct) {
    const { figmaClients } = ctx;
    pickFigmaClient(figmaClients); // Remove stale connections
    resultText = (figmaClients.size > 0
      ? `✅ Figma plugin connected (${figmaClients.size} instance)`
      : '❌ No Figma plugin connected. Open Figma and run the Figma Bridge plugin.') + ` · bridge ${VERSION} (pid ${process.pid}, primary)`;
    return { content: [{ type: 'text', text: resultText }] };
  }

  if (!('direct' in ctx)) throw new Error('The bridge server is still connecting; retry in a moment.');

  // Files are read here, in the process the MCP client talks to, so relative
  // paths resolve against the client's working directory in both modes.
  const { command, params, sourceMap } = prepareRequest(name, args);

  let result;
  try {
    result = ctx.direct ? await sendDirect(ctx, command, params) : await sendViaProxy(ctx, command, params);
  } catch (err) {
    throw new Error(sourceMap ? mapScriptError(err.message, sourceMap) : err.message);
  }

  // Written here rather than on the primary, so the file lands next to the
  // MCP client that asked for it — the primary may be another process, in
  // another working directory, on the other side of the WSL boundary.
  resultText = formatToolResult(name, args, result);
  if (name === 'figma_status' && !ctx.direct) resultText += primaryVersionNote(resultText);
  return { content: [{ type: 'text', text: resultText }] };
}

// Port 3055 belongs to whichever bridge started first, often one left over
// from an earlier session. Its version decides what the plugin round trip
// supports (timeoutMs is enforced there), so say when it is older.
function primaryVersionNote(statusText) {
  const m = / · bridge (\S+) \(pid (\d+)/.exec(statusText);
  if (m && m[1] === VERSION) return ` · this client: proxy ${VERSION}`;
  const who = m ? `bridge ${m[1]}, pid ${m[2]}` : 'a bridge older than 1.1.0';
  return `\n⚠️ Port ${WS_PORT} is held by ${who}; this client runs ${VERSION} as a proxy. ` +
    'Requests still work, but the primary decides timeouts and is not updated until it restarts — ' +
    `stop that process (\`ss -ltnp | grep ${WS_PORT}\` shows it) and restart the MCP client.`;
}

function sendDirect(ctx, command, params) {
  const { figmaClients, pendingRequests, requestCounterRef } = ctx;
  const ws = pickFigmaClient(figmaClients);
  if (!ws) throw new Error('No Figma plugin connected. Open Figma and run the bridge plugin.');
  const requestId = `req_${++requestCounterRef.v}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Timeout waiting for Figma response (${timeoutFor(params) / 1000}s)`));
    }, timeoutFor(params));
    pendingRequests.set(requestId, { resolve, reject, timeout });
    ws.send(JSON.stringify({ requestId, command, params }));
  });
}

function sendViaProxy(ctx, command, params) {
  const { proxyWs, pendingProxy, proxyCounterRef } = ctx;
  if (proxyWs.readyState !== WebSocket.OPEN) throw new Error('Reconnecting to the bridge server; retry in a moment.');
  const proxyId = `proxy_${++proxyCounterRef.v}`;
  return new Promise((resolve, reject) => {
    pendingProxy.set(proxyId, { resolve, reject });
    proxyWs.send(JSON.stringify({ _mcpProxy: proxyId, command, params }));
  });
}

const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT = 600000;
function timeoutFor(params) {
  const ms = Number(params && params.timeoutMs);
  return ms > 0 ? Math.min(ms, MAX_TIMEOUT) : DEFAULT_TIMEOUT;
}

// ─── Request preparation ─────────────────────────────────────────────────────

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp' };
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const HELPERS_ALIAS = '@helpers';
const HELPERS_PATH = path.join(__dirname, 'snippets', 'helpers.js');

function prepareRequest(name, args) {
  if (name === 'figma_upload_image') return prepareUpload(args);
  if (name === 'figma_run_script') return prepareScript(args);
  return { command: name, params: args };
}

function prepareUpload(args) {
  const files = [].concat(args.paths || [], args.path || []);
  if (!files.length) throw new Error('figma_upload_image needs `path` or `paths`');
  if (args.nodeId && files.length > 1) throw new Error('`nodeId` takes a single image; pass one `path`');
  let total = 0;
  const images = files.map((file) => {
    const abs = path.resolve(file);
    const mime = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    if (!mime) throw new Error(`${file}: unsupported image type (PNG, JPEG, GIF, WebP, AVIF or BMP; convert TIFF/HEIC first)`);
    const buffer = fs.readFileSync(abs);
    total += buffer.length;
    return { name: args.name && files.length === 1 ? args.name : path.basename(abs, path.extname(abs)), mime, base64: buffer.toString('base64') };
  });
  if (total > MAX_UPLOAD_BYTES) throw new Error(`Upload is ${Math.round(total / 1048576)} MB; send fewer or smaller files (limit ${MAX_UPLOAD_BYTES / 1048576} MB per call)`);
  const { path: _p, paths: _ps, name: _n, ...rest } = args;
  return { command: 'figma_upload_image', params: { ...rest, images, timeoutMs: args.timeoutMs || 120000 } };
}

// Concatenates files into one run_js snippet and remembers where each one
// starts, so a sandbox error can be reported as file:line.
function prepareScript(args) {
  const files = [].concat(args.files || []);
  if (!files.length) throw new Error('figma_run_script needs `files`');
  const parts = [`const ARGS = ${JSON.stringify(args.args || {})};`];
  const sourceMap = [];
  let line = 2;
  for (const file of files) {
    const abs = file === HELPERS_ALIAS ? HELPERS_PATH : path.resolve(file);
    const source = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    const lines = source.split('\n').length;
    sourceMap.push({ file: file === HELPERS_ALIAS ? HELPERS_ALIAS : abs, start: line, lines });
    parts.push(source);
    line += lines;
  }
  return { command: 'figma_run_js', params: { code: parts.join('\n'), timeoutMs: args.timeoutMs }, sourceMap };
}

function mapScriptError(message, sourceMap) {
  return message.replace(/\(snippet line (\d+):(\d+)\)/, (all, l, c) => {
    const n = Number(l);
    const hit = sourceMap.find(s => n >= s.start && n < s.start + s.lines);
    return hit ? `(${hit.file}:${n - hit.start + 1}:${c})` : all;
  });
}

// ─── MCP Tools ────────────────────────────────────────────────────────────────

const MCP_TOOLS = [
  { name: 'figma_status', description: 'Check if Figma plugin is connected', inputSchema: { type: 'object', properties: {} } },
  { name: 'figma_get_page', description: 'Get all frames/nodes on the current page', inputSchema: { type: 'object', properties: {} } },
  { name: 'figma_get_node', description: 'Get detailed info about a specific node by ID', inputSchema: { type: 'object', properties: { nodeId: { type: 'string', description: 'Node ID (e.g. "1:2" or "1-2")' } }, required: ['nodeId'] } },
  { name: 'figma_get_selection', description: 'Get currently selected nodes in Figma', inputSchema: { type: 'object', properties: {} } },
  { name: 'figma_get_styles', description: 'Get all local styles (colors, text, effects)', inputSchema: { type: 'object', properties: {} } },
  { name: 'figma_get_variables', description: 'Get all local variables and variable collections', inputSchema: { type: 'object', properties: {} } },
  { name: 'figma_get_components', description: 'Get all local components', inputSchema: { type: 'object', properties: {} } },
  { name: 'figma_export_node', description: 'Export a node as PNG/SVG/PDF. Writes the file to disk and returns its path; small SVGs are also returned inline as source.', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, format: { type: 'string', enum: ['PNG', 'SVG', 'PDF'], default: 'PNG' }, scale: { type: 'number', default: 1, description: 'Raster scale, PNG/PDF only. SVG ignores it.' }, outputPath: { type: 'string', description: 'Target file path, or a directory to write into. Defaults to ./figma-exports/ (override with $FIGMA_BRIDGE_EXPORT_DIR).' } }, required: ['nodeId'] } },
  { name: 'figma_set_text', description: 'Change text content of a text node', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, text: { type: 'string' } }, required: ['nodeId', 'text'] } },
  { name: 'figma_set_fill', description: 'Change fill color of a node (hex color)', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, hex: { type: 'string', description: 'Hex color e.g. "#FF0000"' } }, required: ['nodeId', 'hex'] } },
  { name: 'figma_create_frame', description: 'Create a new frame on current page', inputSchema: { type: 'object', properties: { name: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 } }, required: ['name', 'width', 'height'] } },
  { name: 'figma_create_text', description: 'Create a text node', inputSchema: { type: 'object', properties: { text: { type: 'string' }, x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 }, fontSize: { type: 'number', default: 16 }, fontFamily: { type: 'string', default: 'Inter' }, fontStyle: { type: 'string', default: 'Regular' }, color: { type: 'string', description: 'Hex color e.g. "#00182C"' }, parentId: { type: 'string' } }, required: ['text'] } },
  { name: 'figma_upload_image', description: 'Upload local image file(s) into Figma. The server reads the files, so no base64 passes through the conversation. Without `nodeId` each image becomes a rectangle (named after the file) on the current page or in `parentId`; with `nodeId` the image replaces that node\'s fills. Returns image hash, natural size and node id. PNG/JPEG/GIF/WebP/AVIF/BMP; larger than `maxSize` (or 4096px) is downscaled in the plugin.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Image file path (relative to the MCP client working directory)' }, paths: { type: 'array', items: { type: 'string' }, description: 'Several files in one call; laid out left to right' }, nodeId: { type: 'string', description: 'Fill this existing node instead of creating a rectangle' }, parentId: { type: 'string' }, name: { type: 'string', description: 'Layer name for a single image' }, maxSize: { type: 'number', description: 'Longest side in px after downscaling (default and max 4096)' }, width: { type: 'number', description: 'Rectangle width; height follows the aspect ratio' }, x: { type: 'number' }, y: { type: 'number' }, scaleMode: { type: 'string', enum: ['FILL', 'FIT', 'CROP', 'TILE'], default: 'FILL' } } } },
  { name: 'figma_delete_node', description: 'Delete a node by ID', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'] } },
  { name: 'figma_move_node', description: 'Move a node to new x,y position', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['nodeId', 'x', 'y'] } },
  { name: 'figma_resize_node', description: 'Resize a node', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['nodeId', 'width', 'height'] } },
  { name: 'figma_run_js', description: 'Run arbitrary Figma Plugin API JavaScript code (advanced). The snippet runs inside an async function, so top-level `await` and `return` both work. Errors report the snippet line; Symbols (figma.mixed) and nodes in the return value are converted automatically.', inputSchema: { type: 'object', properties: { code: { type: 'string' }, timeoutMs: { type: 'number', description: 'Default 30000, max 600000' } }, required: ['code'] } },
  { name: 'figma_run_script', description: 'Run JavaScript files from disk as one figma_run_js snippet — keep a helper library and long build scripts in files instead of the tool call. Files are concatenated in order; `"@helpers"` adds the bundled helper library (snippets/helpers.js: fonts, colors, frame/text/rect builders, image fills). `args` is available as `ARGS`. Errors are reported as file:line.', inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'Script paths, or "@helpers"' }, args: { type: 'object', description: 'JSON exposed to the script as ARGS' }, timeoutMs: { type: 'number', description: 'Default 30000, max 600000' } }, required: ['files'] } }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Remove stale plugin connections and return the most recently connected open
// plugin, or null when no plugin is available.
function pickFigmaClient(figmaClients) {
  let chosen = null;
  for (const [id, ws] of figmaClients) {
    if (ws.readyState !== WebSocket.OPEN) {
      figmaClients.delete(id);
      continue;
    }
    chosen = ws; // Keep the last entry, which is the most recent plugin.
  }
  return chosen;
}

// ─── Export handling ──────────────────────────────────────────────────────────

const EXPORT_EXTENSIONS = { PNG: 'png', SVG: 'svg', PDF: 'pdf' };

// Above this size an SVG is only referenced by path. Inlining the source is
// what makes an icon export directly usable; a whole illustration is not.
const INLINE_SVG_LIMIT = 16000;

// Exports come back from the plugin as base64, which is useless to a caller as
// inline text — a modest PNG is hundreds of kilobytes of it. Write the file and
// hand back the path instead. Everything else is passed through as-is.
function formatToolResult(name, args, result) {
  if (name === 'figma_export_node' && result && typeof result === 'object' && result.base64) {
    return saveExport(args, result);
  }
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

function saveExport(args, result) {
  const buffer = Buffer.from(result.base64, 'base64');
  const filePath = resolveExportPath(args, result);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    throw new Error(`Export succeeded but writing ${filePath} failed: ${err.message}`);
  }

  const node = result.name ? ` · node "${result.name}" (${args.nodeId})` : '';
  const lines = [`Exported ${result.format} → ${filePath}`, `${buffer.length} bytes${node}`];

  if (result.format === 'SVG') {
    lines.push('');
    lines.push(buffer.length <= INLINE_SVG_LIMIT
      ? buffer.toString('utf8')
      : `SVG source is ${buffer.length} bytes; read the file above instead of inlining it.`);
  }

  return lines.join('\n');
}

function resolveExportPath(args, result) {
  const extension = EXPORT_EXTENSIONS[result.format] || 'bin';
  const fileName = `${slugify(result.name)}-${String(args.nodeId).replace(/:/g, '-')}.${extension}`;

  if (args.outputPath) {
    const target = path.resolve(args.outputPath);
    const isDirectory = /[\\/]$/.test(args.outputPath)
      || (fs.existsSync(target) && fs.statSync(target).isDirectory());
    return isDirectory ? path.join(target, fileName) : target;
  }

  const dir = process.env.FIGMA_BRIDGE_EXPORT_DIR || path.join(process.cwd(), 'figma-exports');
  return path.join(path.resolve(dir), fileName);
}

// Turkish letters that either have no decomposition (ı) or decompose to the
// wrong base letter (İ -> i + combining dot), so NFD alone mangles them.
const TURKISH_LETTERS = { 'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g' };

function slugify(name) {
  return String(name || '')
    .replace(/[ıİşŞğĞ]/g, (ch) => TURKISH_LETTERS[ch])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Strip the accents NFD split off.
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'node';
}

function mcpResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function mcpError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function log(msg) { process.stderr.write(`[figma-bridge-mcp] ${msg}\n`); }

log('Starting Figma Bridge MCP Server...');

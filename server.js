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

// ─── Determine whether this process should run as primary or proxy ──────────

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
        result: figmaCount > 0
          ? `✅ Figma plugin connected (${figmaCount} instance)`
          : '❌ No Figma plugin connected. Open Figma and run the Figma Bridge plugin.'
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
        error: 'Timeout waiting for Figma response'
      }));
    }, 30000);

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
  startStdioMCP({ direct: true, figmaClients, pendingRequests, requestCounterRef: { v: 0 } });
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
      startStdioMCP({ direct: false, proxyWs, pendingProxy, proxyCounterRef: { v: 0 } });
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
    proxyWs.on('close', () => log('Disconnected from the primary server'));
  }

  connect();
}

// ─── Stdio MCP ────────────────────────────────────────────────────────────────

function startStdioMCP(ctx) {
  const rl = readline.createInterface({ input: process.stdin });

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
          serverInfo: { name: 'figma-bridge-mcp', version: '1.0.0' }
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

  if (ctx.direct) {
    // PRIMARY: Access Figma clients directly.
    const { figmaClients, pendingRequests, requestCounterRef } = ctx;

    if (name === 'figma_status') {
      pickFigmaClient(figmaClients); // Remove stale connections
      const connected = figmaClients.size > 0;
      resultText = connected
        ? `✅ Figma plugin connected (${figmaClients.size} instance)`
        : '❌ No Figma plugin connected. Open Figma and run the Figma Bridge plugin.';
    } else {
      const ws = pickFigmaClient(figmaClients);
      if (!ws) {
        throw new Error('No Figma plugin connected. Open Figma and run the bridge plugin.');
      }

      const requestId = `req_${++requestCounterRef.v}`;
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error('Timeout waiting for Figma response'));
        }, 30000);
        pendingRequests.set(requestId, { resolve, reject, timeout });
        ws.send(JSON.stringify({ requestId, command: name, params: args }));
      });
      resultText = formatToolResult(name, args, result);
    }
  } else {
    // PROXY: Forward to the primary server.
    const { proxyWs, pendingProxy, proxyCounterRef } = ctx;
    const proxyId = `proxy_${++proxyCounterRef.v}`;

    const result = await new Promise((resolve, reject) => {
      pendingProxy.set(proxyId, { resolve, reject });
      proxyWs.send(JSON.stringify({ _mcpProxy: proxyId, command: name, params: args }));
    });

    // Written here rather than on the primary, so the file lands next to the
    // MCP client that asked for it — the primary may be another process, in
    // another working directory, on the other side of the WSL boundary.
    resultText = formatToolResult(name, args, result);
  }

  return { content: [{ type: 'text', text: resultText }] };
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
  { name: 'figma_create_text', description: 'Create a text node', inputSchema: { type: 'object', properties: { text: { type: 'string' }, x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 }, fontSize: { type: 'number', default: 16 }, parentId: { type: 'string' } }, required: ['text'] } },
  { name: 'figma_delete_node', description: 'Delete a node by ID', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'] } },
  { name: 'figma_move_node', description: 'Move a node to new x,y position', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['nodeId', 'x', 'y'] } },
  { name: 'figma_resize_node', description: 'Resize a node', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['nodeId', 'width', 'height'] } },
  { name: 'figma_run_js', description: 'Run arbitrary Figma Plugin API JavaScript code (advanced). The snippet runs inside an async function, so top-level `await` and `return` both work.', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }
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

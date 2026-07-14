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
      resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }
  } else {
    // PROXY: Forward to the primary server.
    const { proxyWs, pendingProxy, proxyCounterRef } = ctx;
    const proxyId = `proxy_${++proxyCounterRef.v}`;

    const result = await new Promise((resolve, reject) => {
      pendingProxy.set(proxyId, { resolve, reject });
      proxyWs.send(JSON.stringify({ _mcpProxy: proxyId, command: name, params: args }));
    });

    resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
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
  { name: 'figma_export_node', description: 'Export a node as PNG/SVG (returns base64)', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, format: { type: 'string', enum: ['PNG', 'SVG', 'PDF'], default: 'PNG' }, scale: { type: 'number', default: 1 } }, required: ['nodeId'] } },
  { name: 'figma_set_text', description: 'Change text content of a text node', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, text: { type: 'string' } }, required: ['nodeId', 'text'] } },
  { name: 'figma_set_fill', description: 'Change fill color of a node (hex color)', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, hex: { type: 'string', description: 'Hex color e.g. "#FF0000"' } }, required: ['nodeId', 'hex'] } },
  { name: 'figma_create_frame', description: 'Create a new frame on current page', inputSchema: { type: 'object', properties: { name: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 } }, required: ['name', 'width', 'height'] } },
  { name: 'figma_create_text', description: 'Create a text node', inputSchema: { type: 'object', properties: { text: { type: 'string' }, x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 }, fontSize: { type: 'number', default: 16 }, parentId: { type: 'string' } }, required: ['text'] } },
  { name: 'figma_delete_node', description: 'Delete a node by ID', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'] } },
  { name: 'figma_move_node', description: 'Move a node to new x,y position', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['nodeId', 'x', 'y'] } },
  { name: 'figma_resize_node', description: 'Resize a node', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['nodeId', 'width', 'height'] } },
  { name: 'figma_run_js', description: 'Run arbitrary Figma Plugin API JavaScript code (advanced)', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }
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

function mcpResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function mcpError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function log(msg) { process.stderr.write(`[figma-bridge-mcp] ${msg}\n`); }

log('Starting Figma Bridge MCP Server...');

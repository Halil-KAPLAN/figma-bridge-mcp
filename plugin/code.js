// Figma Bridge MCP Plugin - code.js (sandbox)
// Runs in Figma's plugin sandbox, has access to figma API

figma.showUI(__html__, { width: 300, height: 200 });

// Receive commands from UI (which has WebSocket)
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'execute') {
    const { requestId, command, params } = msg;
    try {
      const result = await executeCommand(command, params);
      figma.ui.postMessage({ type: 'result', requestId, result: toPlain(result) });
    } catch (err) {
      figma.ui.postMessage({ type: 'result', requestId, error: describeError(err, command) });
    }
  }
};

async function executeCommand(command, params) {
  switch (command) {
    case 'figma_get_page': {
      const page = figma.currentPage;
      return {
        id: page.id,
        name: page.name,
        children: page.children.map(nodeToInfo)
      };
    }

    case 'figma_get_node': {
      const id = params.nodeId.replace(/-/g, ':');
      const node = figma.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${params.nodeId}`);
      return nodeToDetailedInfo(node);
    }

    case 'figma_get_selection': {
      return figma.currentPage.selection.map(nodeToDetailedInfo);
    }

    case 'figma_get_styles': {
      const styles = {
        paint: figma.getLocalPaintStyles().map(s => ({
          id: s.id, name: s.name, type: s.type
        })),
        text: figma.getLocalTextStyles().map(s => ({
          id: s.id, name: s.name, fontSize: s.fontSize, fontName: s.fontName
        })),
        effect: figma.getLocalEffectStyles().map(s => ({
          id: s.id, name: s.name
        }))
      };
      return styles;
    }

    case 'figma_get_variables': {
      const collections = figma.variables.getLocalVariableCollections();
      return collections.map(c => ({
        id: c.id,
        name: c.name,
        modes: c.modes,
        variables: c.variableIds.map(id => {
          const v = figma.variables.getVariableById(id);
          return v ? { id: v.id, name: v.name, type: v.resolvedType } : null;
        }).filter(Boolean)
      }));
    }

    case 'figma_get_components': {
      return figma.currentPage.findAllWithCriteria({ types: ['COMPONENT'] })
        .map(c => ({ id: c.id, name: c.name, description: c.description }));
    }

    case 'figma_export_node': {
      const id = params.nodeId.replace(/-/g, ':');
      const node = figma.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${params.nodeId}`);
      if (!('exportAsync' in node)) throw new Error('Node does not support export');
      const format = params.format || 'PNG';
      // SVG export settings carry no scale constraint; only rasterized
      // formats take one.
      const settings = format === 'SVG'
        ? { format }
        : { format, constraint: { type: 'SCALE', value: params.scale || 1 } };
      const bytes = await node.exportAsync(settings);
      // Convert to base64 in chunks. Spreading the whole byte array into
      // String.fromCharCode blows the engine's argument limit (65534) as soon
      // as the export is larger than ~64 KB.
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return { format, name: node.name, byteLength: bytes.length, base64: btoa(binary) };
    }

    case 'figma_set_text': {
      const id = params.nodeId.replace(/-/g, ':');
      const node = figma.getNodeById(id);
      if (!node || node.type !== 'TEXT') throw new Error('Text node not found');
      await figma.loadFontAsync(node.fontName);
      node.characters = params.text;
      return { success: true, nodeId: node.id };
    }

    case 'figma_set_fill': {
      const id = params.nodeId.replace(/-/g, ':');
      const node = figma.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${params.nodeId}`);
      const rgb = hexToRgb(params.hex);
      if (!rgb) throw new Error(`Invalid hex color: ${params.hex}`);
      if ('fills' in node) {
        node.fills = [{ type: 'SOLID', color: rgb }];
      }
      return { success: true };
    }

    case 'figma_create_frame': {
      const frame = figma.createFrame();
      frame.name = params.name;
      frame.resize(params.width, params.height);
      frame.x = params.x || 0;
      frame.y = params.y || 0;
      figma.currentPage.appendChild(frame);
      return { id: frame.id, name: frame.name };
    }

    case 'figma_create_text': {
      const text = figma.createText();
      const fontName = { family: params.fontFamily || 'Inter', style: params.fontStyle || 'Regular' };
      await figma.loadFontAsync(fontName);
      text.fontName = fontName;
      text.characters = params.text;
      if (params.color) {
        const rgb = hexToRgb(params.color);
        if (!rgb) throw new Error(`Invalid hex color: ${params.color}`);
        text.fills = [{ type: 'SOLID', color: rgb }];
      }
      text.x = params.x || 0;
      text.y = params.y || 0;
      if (params.fontSize) text.fontSize = params.fontSize;
      if (params.parentId) {
        const parent = figma.getNodeById(params.parentId.replace(/-/g, ':'));
        if (parent && 'appendChild' in parent) parent.appendChild(text);
        else figma.currentPage.appendChild(text);
      } else {
        figma.currentPage.appendChild(text);
      }
      return { id: text.id, name: text.name };
    }

    case 'figma_delete_node': {
      const id = params.nodeId.replace(/-/g, ':');
      const node = figma.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${params.nodeId}`);
      node.remove();
      return { success: true };
    }

    case 'figma_move_node': {
      const id = params.nodeId.replace(/-/g, ':');
      const node = figma.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${params.nodeId}`);
      if ('x' in node) { node.x = params.x; node.y = params.y; }
      return { success: true };
    }

    case 'figma_resize_node': {
      const id = params.nodeId.replace(/-/g, ':');
      const node = figma.getNodeById(id);
      if (!node) throw new Error(`Node not found: ${params.nodeId}`);
      if ('resize' in node) node.resize(params.width, params.height);
      return { success: true };
    }

    case 'figma_run_js': {
      // eval is available in plugin sandbox. The snippet is wrapped in an async
      // IIFE so it can `await` at top level and still `return` a value; the
      // newlines keep a trailing // comment from swallowing the closing bracket.
      // The wrapper shifts line numbers by RUN_JS_LINE_OFFSET — see describeError().
      const fn = new Function('figma', `return (async () => {\n${params.code}\n})();`);
      const result = await fn(figma);
      return result !== undefined ? result : { success: true };
    }

    case 'figma_upload_image': {
      // The server read the files and the UI already resized them; here they
      // only become Figma images. An image no node references is dropped when
      // the file is saved, so every upload lands on a node.
      const target = params.nodeId ? getNode(params.nodeId) : null;
      if (target && !('fills' in target)) throw new Error(`Node ${params.nodeId} cannot take an image fill`);
      const parent = params.parentId ? getNode(params.parentId) : figma.currentPage;
      if (!('appendChild' in parent)) throw new Error(`Node ${params.parentId} cannot contain children`);
      const scaleMode = params.scaleMode || 'FILL';
      let x = params.x || 0;
      const results = [];
      for (const img of params.images) {
        const image = figma.createImage(figma.base64Decode(img.base64));
        const { width, height } = await image.getSizeAsync();
        const paint = { type: 'IMAGE', scaleMode, imageHash: image.hash };
        let node = target;
        if (node) {
          node.fills = [paint];
        } else {
          node = figma.createRectangle();
          node.name = img.name;
          parent.appendChild(node);
          const w = params.width || width;
          node.resize(w, Math.round(w * height / width));
          node.x = x;
          node.y = params.y || 0;
          node.fills = [paint];
          x += node.width + 40;
        }
        results.push({ name: img.name, hash: image.hash, width, height, nodeId: node.id, resized: img.resized || null });
      }
      return results;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Lines `new Function` (2) and the async wrapper (1) put above a run_js snippet.
const RUN_JS_LINE_OFFSET = 3;

function getNode(nodeId) {
  const node = figma.getNodeById(String(nodeId).replace(/-/g, ':'));
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

// A bare "not a function" is useless in a 300-line script, so run_js errors
// carry the snippet line the sandbox stack points at.
function describeError(err, command) {
  const message = err && err.message ? `${err.name && err.name !== 'Error' ? err.name + ': ' : ''}${err.message}` : String(err);
  if (command !== 'figma_run_js' || !err || !err.stack) return message;
  const m = /<input>:(\d+):(\d+)/.exec(String(err.stack));
  if (!m) return message;
  const line = Number(m[1]) - RUN_JS_LINE_OFFSET;
  return line > 0 ? `${message} (snippet line ${line}:${m[2]})` : message;
}

// postMessage cannot clone Symbols (figma.mixed), nodes or functions, and a
// single one used to fail the whole call with "Cannot unwrap symbol".
function toPlain(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'symbol') return 'mixed';
  if (t === 'function') return undefined;
  if (t !== 'object') return value;
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (seen.has(value) || depth > 40) return '<circular>';
  if ('id' in value && 'type' in value && 'removed' in value) return value.removed ? { id: value.id, removed: true } : nodeToInfo(value);
  seen.add(value);
  let out;
  if (Array.isArray(value)) out = value.map(v => toPlain(v, depth + 1, seen));
  else {
    out = {};
    for (const k of Object.keys(value)) { const v = toPlain(value[k], depth + 1, seen); if (v !== undefined) out[k] = v; }
  }
  seen.delete(value);
  return out;
}

function nodeToInfo(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    x: 'x' in node ? node.x : undefined,
    y: 'y' in node ? node.y : undefined,
    width: 'width' in node ? node.width : undefined,
    height: 'height' in node ? node.height : undefined,
    childCount: 'children' in node ? node.children.length : undefined
  };
}

function nodeToDetailedInfo(node) {
  const info = nodeToInfo(node);
  if ('children' in node) {
    info.children = node.children.map(nodeToInfo);
  }
  if (node.type === 'TEXT') {
    info.characters = node.characters;
    info.fontSize = node.fontSize;
    info.fontName = node.fontName;
  }
  if ('fills' in node) {
    info.fills = node.fills;
  }
  if ('strokes' in node) {
    info.strokes = node.strokes;
  }
  return info;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : null;
}

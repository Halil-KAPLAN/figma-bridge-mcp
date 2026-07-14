// Figma Bridge MCP Plugin - code.js (sandbox)
// Runs in Figma's plugin sandbox, has access to figma API

figma.showUI(__html__, { width: 300, height: 200 });

// Receive commands from UI (which has WebSocket)
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'execute') {
    const { requestId, command, params } = msg;
    try {
      const result = await executeCommand(command, params);
      figma.ui.postMessage({ type: 'result', requestId, result });
    } catch (err) {
      figma.ui.postMessage({ type: 'result', requestId, error: err.message });
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
      const bytes = await node.exportAsync({
        format: params.format || 'PNG',
        constraint: { type: 'SCALE', value: params.scale || 1 }
      });
      // Convert to base64
      const base64 = btoa(String.fromCharCode(...bytes));
      return { format: params.format || 'PNG', base64 };
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
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      text.characters = params.text;
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
      // eval is available in plugin sandbox
      const fn = new Function('figma', params.code);
      const result = await fn(figma);
      return result !== undefined ? result : { success: true };
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

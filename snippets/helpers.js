// Figma Bridge helper library — load with figma_run_script({ files: ['@helpers', 'your-script.js'] }).
// Everything here is plain Plugin API; read it as documentation of the options.

// ─── Paint ───────────────────────────────────────────────────────────────────

function hex(h) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  if (!m) throw new Error(`Invalid hex color: ${h}`);
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}

function solid(h, opacity = 1) {
  return { type: 'SOLID', color: hex(h), opacity };
}

// dir: 'down' | 'right' | 'diagonal' (top-left → bottom-right); stops: [[hex, alpha, position], …]
function gradient(dir, stops) {
  const transforms = { down: [[0, 1, 0], [-1, 0, 1]], right: [[1, 0, 0], [0, 1, 0]], diagonal: [[0.5, 0.5, 0], [-0.5, 0.5, 0.5]] };
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: transforms[dir] || transforms.down,
    gradientStops: stops.map(([h, a, position]) => ({ color: Object.assign(hex(h), { a }), position })),
  };
}

function radial(h, alpha = 0.6) {
  return {
    type: 'GRADIENT_RADIAL',
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ color: Object.assign(hex(h), { a: alpha }), position: 0 }, { color: Object.assign(hex(h), { a: 0 }), position: 1 }],
  };
}

// hash from figma_upload_image, or a layer name on the page holding the uploads
function imageFill(hashOrName, scaleMode = 'FILL') {
  let hash = hashOrName;
  if (!/^[0-9a-f]{40}$/.test(hashOrName)) {
    const node = figma.currentPage.findOne(n => n.name === hashOrName && 'fills' in n && n.fills.length && n.fills[0].type === 'IMAGE');
    if (!node) throw new Error(`No image layer named "${hashOrName}" on this page`);
    hash = node.fills[0].imageHash;
  }
  return { type: 'IMAGE', scaleMode, imageHash: hash };
}

function shadow({ y = 16, blur = 40, opacity = 0.15, color = '#000000', spread = 0, inner = false } = {}) {
  return { type: inner ? 'INNER_SHADOW' : 'DROP_SHADOW', color: Object.assign(hex(color), { a: opacity }), offset: { x: 0, y }, radius: blur, spread, visible: true, blendMode: 'NORMAL' };
}

function blur(radius = 8) {
  return { type: 'BACKGROUND_BLUR', radius, visible: true };
}

// ─── Fonts ───────────────────────────────────────────────────────────────────

const LOADED_FONTS = new Set();

// loadFonts('Inter Regular', 'Inter Bold', { family: 'Open Sans', style: 'Italic' })
async function loadFonts(...fonts) {
  await Promise.all(fonts.map(f => {
    const font = typeof f === 'string' ? splitFont(f) : f;
    LOADED_FONTS.add(`${font.family}|${font.style}`);
    return figma.loadFontAsync(font);
  }));
}

function splitFont(s) {
  const i = s.lastIndexOf(' ');
  return { family: s.slice(0, i), style: s.slice(i + 1) };
}

// ─── Nodes ───────────────────────────────────────────────────────────────────

// Shared options: name, x, y, w, h, fill (hex) | fills (paints), opacity, radius,
// stroke (hex), strokeWeight, effects, rotation, clip.
function applyCommon(node, o) {
  if (o.name) node.name = o.name;
  if ('fills' in node) node.fills = o.fills || (o.fill ? [solid(o.fill, o.fillOpacity ?? 1)] : []);
  if (o.w || o.h) node.resize(o.w || node.width, o.h || node.height);
  if (o.radius != null) node.cornerRadius = o.radius;
  if (o.stroke) { node.strokes = [solid(o.stroke, o.strokeOpacity ?? 1)]; node.strokeWeight = o.strokeWeight || 1; node.strokeAlign = o.strokeAlign || 'INSIDE'; }
  if (o.effects) node.effects = o.effects;
  if (o.opacity != null) node.opacity = o.opacity;
  node.x = o.x || 0; node.y = o.y || 0;
  if (o.rotation) node.rotation = o.rotation;
  return node;
}

function frame(parent, o = {}) {
  const f = figma.createFrame();
  parent.appendChild(f);
  applyCommon(f, o);
  f.clipsContent = o.clip !== false;
  return f;
}

function rect(parent, o = {}) {
  const r = figma.createRectangle();
  parent.appendChild(r);
  return applyCommon(r, o);
}

function ellipse(parent, o = {}) {
  const e = figma.createEllipse();
  parent.appendChild(e);
  return applyCommon(e, Object.assign({ h: o.w }, o));
}

// Text options: font ('Family Style'), size, color, opacity, lineHeight (px), letterSpacing (%),
// width (fixed width, height grows), align, textCase. Load the font first with loadFonts().
function text(parent, characters, o = {}) {
  const font = splitFont(o.font || 'Inter Regular');
  if (!LOADED_FONTS.has(`${font.family}|${font.style}`)) throw new Error(`Font "${font.family} ${font.style}" not loaded — await loadFonts('${font.family} ${font.style}') first`);
  const t = figma.createText();
  t.fontName = font;
  t.characters = characters;
  t.fontSize = o.size || 16;
  t.fills = [solid(o.color || '#000000', o.opacity ?? 1)];
  if (o.lineHeight) t.lineHeight = { unit: 'PIXELS', value: o.lineHeight };
  if (o.letterSpacing != null) t.letterSpacing = { unit: 'PERCENT', value: o.letterSpacing };
  if (o.textCase) t.textCase = o.textCase;
  if (o.align) t.textAlignHorizontal = o.align;
  parent.appendChild(t);
  if (o.width) { t.textAutoResize = 'HEIGHT'; t.resize(o.width, t.height); } else t.textAutoResize = 'WIDTH_AND_HEIGHT';
  t.x = o.x || 0; t.y = o.y || 0;
  if (o.rotation) t.rotation = o.rotation;
  t.name = o.name || characters.slice(0, 40);
  return t;
}

// Restyle the first occurrence of `part`: { font, color, opacity, size }
function styleRange(t, part, o) {
  const i = t.characters.indexOf(part);
  if (i < 0) throw new Error(`"${part}" not found in text "${t.characters.slice(0, 40)}"`);
  const j = i + part.length;
  if (o.font) t.setRangeFontName(i, j, splitFont(o.font));
  if (o.color) t.setRangeFills(i, j, [solid(o.color, o.opacity ?? 1)]);
  if (o.size) t.setRangeFontSize(i, j, o.size);
  return t;
}

// Turn a frame into auto layout: { dir: 'HORIZONTAL'|'VERTICAL', gap, padding: n | [v, h] | [t, r, b, l], align, hug }
function autoLayout(f, o = {}) {
  f.layoutMode = o.dir || 'HORIZONTAL';
  f.itemSpacing = o.gap || 0;
  const p = [].concat(o.padding ?? 0);
  const [t, r, b, l] = p.length === 1 ? [p[0], p[0], p[0], p[0]] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p;
  Object.assign(f, { paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l });
  if (o.align) f.counterAxisAlignItems = o.align;
  if (o.hug !== false) { f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO'; }
  return f;
}

// Remove any child called `name` so a rebuild replaces instead of stacking copies.
function replaceChild(parent, name) {
  parent.children.filter(c => c.name === name).forEach(c => c.remove());
}

async function page(name, { create = true, select = true } = {}) {
  let p = figma.root.children.find(x => x.name === name);
  if (!p && create) { p = figma.createPage(); p.name = name; }
  if (!p) throw new Error(`Page not found: ${name}`);
  if (select) await figma.setCurrentPageAsync(p);
  return p;
}

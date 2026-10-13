import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline';
import {
  PDFDocument, PDFDict, PDFName, PDFHexString, StandardFonts, rgb, degrees, BlendMode, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, showText, setFillingRgbColor,
} from 'pdf-lib';
import './style.css';

GlobalWorkerOptions.workerPort = new PdfWorker();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let uidCounter = 0;
const uid = () => `u${++uidCounter}`;

const FONTS = {
  sans: { css: 'Helvetica, Arial, "Liberation Sans", sans-serif', std: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique] },
  serif: { css: '"Times New Roman", Times, "Liberation Serif", serif', std: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic] },
  mono: { css: '"Courier New", Courier, "Liberation Mono", monospace', std: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique] },
};
const LINE_HEIGHT = 1.2;
const THUMB_WIDTH = 130;

const S = {
  name: 'document.pdf',
  sources: new Map(), // id -> { bytes, pdf }
  images: new Map(), // id -> dataURL (kept out of pages so undo snapshots stay small)
  pages: [], // { id, src, index, view, rotation, annots }
  selected: new Set(),
  current: null,
  active: null, // { pageId, annotId }
  tool: 'select',
  zoom: 1,
  undo: [],
  redo: [],
  dirty: false,
  textDefaults: { font: 'sans', size: 12, color: '#000000', bold: false },
};

// ---------- geometry ----------

// Mirrors pdf.js PageViewport: maps PDF user space to screen pixels.
function viewport(p, scale) {
  const [x0, y0, x1, y1] = p.view;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const [A, B, C, D] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[p.rotation];
  let ox, oy, width, height;
  if (A === 0) {
    ox = Math.abs(cy - y0) * scale; oy = Math.abs(cx - x0) * scale;
    width = (y1 - y0) * scale; height = (x1 - x0) * scale;
  } else {
    ox = Math.abs(cx - x0) * scale; oy = Math.abs(cy - y0) * scale;
    width = (x1 - x0) * scale; height = (y1 - y0) * scale;
  }
  const t = [A * scale, B * scale, C * scale, D * scale, ox - A * scale * cx - C * scale * cy, oy - B * scale * cx - D * scale * cy];
  const det = t[0] * t[3] - t[1] * t[2];
  return {
    width, height, scale,
    toView: (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]],
    toPdf: (vx, vy) => {
      const dx = vx - t[4], dy = vy - t[5];
      return [(t[3] * dx - t[2] * dy) / det, (-t[1] * dx + t[0] * dy) / det];
    },
  };
}

// Annotations live in PDF space: (x, y) is the top-left corner, axes rotated
// counter-clockwise by `angle` degrees. These are the unit vectors of that frame.
function axes(angle) {
  const r = (angle * Math.PI) / 180;
  return { right: [Math.cos(r), Math.sin(r)], down: [Math.sin(r), -Math.cos(r)] };
}
const add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];

// Distance from the top of a text line box to its baseline, as a fraction of font size.
const baselineCache = {};
function baselineRatio(an) {
  const key = `${fontCss(an)}|${fontWeight(an)}|${an.italic}`;
  if (baselineCache[key]) return baselineCache[key];
  const d = document.createElement('div');
  d.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-size:100px;line-height:${LINE_HEIGHT}`;
  Object.assign(d.style, { fontFamily: fontCss(an), fontWeight: fontWeight(an), fontStyle: an.italic ? 'italic' : 'normal' });
  d.innerHTML = 'Hg<span style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>';
  document.body.append(d);
  const r = d.lastChild.offsetTop / 100;
  d.remove();
  return (baselineCache[key] = r);
}

// Text copied from the PDF remembers its original font (`css` for display, `pdfFont`
// for saving); otherwise one of the standard fonts is used.
const fontCss = (an) => (an.css ? `${an.css}, ${FONTS[an.font].css}` : FONTS[an.font].css);
const fontWeight = (an) => an.weight ?? (an.bold ? 700 : 400);

// "ABCDEF+Roboto-MediumItalic" -> CSS family and style.
function parseFontName(name) {
  const base = name.replace(/^[A-Z]{6}\+/, '');
  const [fam, style = ''] = base.split(/[-,]/);
  const s = (style || fam).toLowerCase();
  const weight = /black|heavy/.test(s) ? 900 : /extrabold|ultrabold/.test(s) ? 800 : /semibold|demibold/.test(s) ? 600
    : /bold/.test(s) ? 700 : /medium/.test(s) ? 500 : /light/.test(s) ? 300 : /thin/.test(s) ? 100 : 400;
  const clean = fam.replace(/[^\w ]/g, '');
  const bare = clean.replace(/(PSMT|MT|PS)$/, '');
  // The family name has no spaces in the PDF, so try a few spellings:
  // "SourceSansPro" -> "Source Sans Pro", "DejaVuSerif" -> "DejaVu Serif".
  const names = new Set([clean, bare.replace(/([a-z])([A-Z])/g, '$1 $2'), bare.replace(/([a-z])([A-Z][a-z]+)$/, '$1 $2')]);
  return { css: [...names].map((n) => `"${n}"`).join(', '), weight, italic: /italic|oblique/.test(s) };
}

// ---------- loading ----------

async function loadPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pdf;
  try {
    pdf = await getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
  } catch (e) {
    throw new Error(e?.name === 'PasswordException' ? `${file.name} is password protected.` : `Could not open ${file.name}.`);
  }
  const src = uid();
  S.sources.set(src, { bytes, pdf });
  const pages = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const pg = await pdf.getPage(i + 1);
    pages.push({ id: uid(), src, index: i, view: pg.view.slice(), rotation: pg.rotate % 360, annots: [] });
  }
  return pages;
}

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

async function openFiles(files) {
  files = [...files].filter(isPdf);
  if (!files.length) return;
  if (S.pages.length && S.dirty && !confirm('Discard unsaved changes?')) return;
  try {
    const pages = [];
    const old = [...S.sources.keys()];
    for (const f of files) pages.push(...(await loadPdf(f)));
    for (const id of old) { S.sources.get(id).pdf.destroy(); S.sources.delete(id); }
    S.images.clear();
    textCache.clear();
    S.name = files[0].name;
    S.pages = pages;
    S.undo = []; S.redo = []; S.dirty = files.length > 1;
    S.selected = new Set([pages[0].id]);
    S.current = pages[0].id;
    S.active = null;
    document.title = `${S.name} – PDF Editor`;
    $('#viewer').scrollTop = 0;
    fitZoom();
    renderAll();
  } catch (e) {
    toast(e.message);
  }
}

async function insertFiles(files, index) {
  files = [...files].filter(isPdf);
  if (!files.length) return;
  if (!S.pages.length) return openFiles(files);
  try {
    const pages = [];
    for (const f of files) pages.push(...(await loadPdf(f)));
    checkpoint();
    S.pages.splice(index ?? S.pages.length, 0, ...pages);
    S.selected = new Set(pages.map((p) => p.id));
    renderAll();
    scrollToPage(pages[0].id);
  } catch (e) {
    toast(e.message);
  }
}

// ---------- history ----------

const snapshot = () => structuredClone(S.pages);

function checkpoint(snap = snapshot()) {
  S.undo.push(snap);
  if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
  S.dirty = true;
  updateButtons();
}

function restore(from, to) {
  if (!from.length) return;
  endEditing();
  to.push(snapshot());
  S.pages = from.pop();
  const ids = new Set(S.pages.map((p) => p.id));
  S.selected = new Set([...S.selected].filter((id) => ids.has(id)));
  S.active = null;
  S.dirty = true;
  renderAll();
}
const undo = () => restore(S.undo, S.redo);
const redo = () => restore(S.redo, S.undo);

// ---------- rendering ----------

const pageEls = new Map();
const thumbEls = new Map();
const pageById = (id) => S.pages.find((p) => p.id === id);

async function paint(canvas, p, scale) {
  const key = `${p.src}:${p.index}:${p.rotation}@${scale}`;
  if (canvas.dataset.key === key) return;
  canvas.dataset.key = key;
  canvas._task?.cancel();
  if (!p.src) {
    canvas.width = canvas.height = 1;
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const page = await S.sources.get(p.src).pdf.getPage(p.index + 1);
  if (canvas.dataset.key !== key) return;
  const vp = page.getViewport({ scale: scale * dpr, rotation: p.rotation });
  const tmp = document.createElement('canvas');
  tmp.width = Math.ceil(vp.width);
  tmp.height = Math.ceil(vp.height);
  const task = page.render({ canvasContext: tmp.getContext('2d'), viewport: vp });
  canvas._task = task;
  try {
    await task.promise;
  } catch {
    return; // cancelled
  }
  if (canvas.dataset.key !== key) return;
  canvas.width = tmp.width;
  canvas.height = tmp.height;
  canvas.getContext('2d').drawImage(tmp, 0, 0);
}

function release(canvas) {
  canvas._task?.cancel();
  canvas.dataset.key = '';
  canvas.width = canvas.height = 0;
}

const pageObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const p = pageById(e.target.dataset.id);
      const canvas = e.target.querySelector('canvas');
      if (!p) continue;
      if (e.isIntersecting) paint(canvas, p, S.zoom);
      else release(canvas);
    }
  },
  { root: $('#viewer'), rootMargin: '1500px 0px' },
);

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const p = pageById(e.target.dataset.id);
      if (p && e.isIntersecting) paint(e.target.querySelector('canvas'), p, thumbScale(p));
    }
  },
  { root: $('#thumbs'), rootMargin: '600px 0px' },
);

const thumbScale = (p) => THUMB_WIDTH / Math.max(viewport(p, 1).width, viewport(p, 1).height);

function renderAll() {
  const ids = new Set(S.pages.map((p) => p.id));
  for (const [id, el] of pageEls) if (!ids.has(id)) { pageObserver.unobserve(el); release(el.querySelector('canvas')); el.remove(); pageEls.delete(id); }
  for (const [id, el] of thumbEls) if (!ids.has(id)) { thumbObserver.unobserve(el); el.remove(); thumbEls.delete(id); }

  const pagesBox = $('#pages');
  const thumbsBox = $('#thumbs');
  S.pages.forEach((p, i) => {
    let el = pageEls.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'page';
      el.dataset.id = p.id;
      el.innerHTML = '<canvas></canvas><div class="layer"></div>';
      pageEls.set(p.id, el);
      pageObserver.observe(el);
    }
    const vp = viewport(p, S.zoom);
    el.style.width = `${vp.width}px`;
    el.style.height = `${vp.height}px`;
    pagesBox.append(el);
    // Repaint if already on screen (the observer only fires on visibility changes).
    const c = el.querySelector('canvas');
    if (c.dataset.key) paint(c, p, S.zoom);
    renderLayer(p);

    let th = thumbEls.get(p.id);
    if (!th) {
      th = document.createElement('div');
      th.className = 'thumb';
      th.dataset.id = p.id;
      th.draggable = true;
      th.innerHTML = '<div class="frame"><canvas></canvas></div><div class="num"></div>';
      thumbEls.set(p.id, th);
      thumbObserver.observe(th);
    }
    const tvp = viewport(p, thumbScale(p));
    const tc = th.querySelector('canvas');
    tc.style.width = `${tvp.width}px`;
    tc.style.height = `${tvp.height}px`;
    if (tc.dataset.key) paint(tc, p, thumbScale(p));
    th.querySelector('.num').textContent = i + 1;
    th.classList.toggle('selected', S.selected.has(p.id));
    thumbsBox.append(th);
  });
  $('#empty').hidden = S.pages.length > 0;
  updateButtons();
}

function renderLayer(p) {
  const el = pageEls.get(p.id);
  if (!el) return;
  const layer = el.querySelector('.layer');
  layer.replaceChildren();
  const vp = viewport(p, S.zoom);
  for (const an of p.annots) layer.append(annotEl(an, p, vp));
  if (S.tool === 'edit') addTextSpans(p, layer, vp);
}

function place(el, an, p, vp) {
  const [vx, vy] = vp.toView(an.x, an.y);
  el.style.left = `${vx}px`;
  el.style.top = `${vy}px`;
  el.style.transform = `rotate(${p.rotation - an.angle}deg)`;
}

function annotEl(an, p, vp) {
  let el;
  if (an.type === 'text') {
    el = document.createElement('div');
    el.className = 'annot text';
    el.textContent = an.text;
    Object.assign(el.style, {
      fontFamily: fontCss(an),
      fontSize: `${an.size * vp.scale}px`,
      fontWeight: fontWeight(an),
      fontStyle: an.italic ? 'italic' : 'normal',
      color: an.pending ? 'transparent' : an.color,
      caretColor: an.color,
    });
  } else {
    el = document.createElement(an.type === 'image' ? 'img' : 'div');
    el.className = `annot ${an.type}`;
    if (an.type === 'image') {
      el.src = S.images.get(an.img);
      el.draggable = false;
    } else {
      el.style.background = an.kind === 'highlight' ? 'rgba(255, 230, 0, .4)' : an.color || '#fff';
      if (an.pending) el.style.visibility = 'hidden';
      if (an.kind === 'highlight') el.style.mixBlendMode = 'multiply';
    }
    el.style.width = `${an.w * vp.scale}px`;
    el.style.height = `${an.h * vp.scale}px`;
  }
  el.dataset.id = an.id;
  place(el, an, p, vp);
  if (S.active?.annotId === an.id) {
    el.classList.add('active');
    if (an.type !== 'text') el.append(Object.assign(document.createElement('div'), { className: 'handle' }));
  }
  return el;
}

// Hover boxes over the page's existing text, for the "Edit text" tool.
const textCache = new Map();
function textContent(p) {
  const key = `${p.src}:${p.index}`;
  if (!textCache.has(key)) {
    textCache.set(key, (async () => {
      const page = await S.sources.get(p.src).pdf.getPage(p.index + 1);
      const tc = await page.getTextContent();
      return { page, items: tc.items, styles: tc.styles };
    })());
  }
  return textCache.get(key);
}

let spanGen = 0;
async function addTextSpans(p, layer, vp) {
  if (!p.src) return;
  const gen = (layer._gen = ++spanGen);
  const { page, items, styles } = await textContent(p);
  if (S.tool !== 'edit' || layer._gen !== gen) return;
  const replaced = new Set(p.annots.map((a) => a.replaces).filter((r) => r != null));
  const frag = document.createDocumentFragment();
  items.forEach((item, i) => {
    if (!item.str?.trim() || replaced.has(i)) return;
    const g = spanGeometry(item, styles[item.fontName]);
    if (!g.size || !g.width) return;
    const span = document.createElement('div');
    span.className = 'tspan';
    span.dataset.item = i;
    span.style.width = `${g.width * vp.scale}px`;
    span.style.height = `${g.height * vp.scale}px`;
    place(span, g, p, vp);
    span._edit = (at) => replaceText(p, i, item, g, page, styles[item.fontName], at);
    frag.append(span);
  });
  layer.prepend(frag);
}

function spanGeometry(item, style) {
  const [a, b, c, d, e, f] = item.transform;
  const size = Math.hypot(c, d) || item.height;
  const angle = (Math.atan2(b, a) * 180) / Math.PI;
  const ascent = Math.min(Math.max(style?.ascent || 0.88, 0.7), 1.05);
  const descent = Math.min(Math.max(Math.abs(style?.descent || 0.24), 0.15), 0.35);
  const { down, right } = axes(angle);
  const pad = size * 0.05;
  const [x, y] = add(add([e, f], down, -ascent * size), right, -pad);
  return { x, y, angle, size, width: item.width + pad * 2, height: (ascent + descent) * size, origin: [e, f], pad };
}

// Clicking existing text puts an invisible editor over it. Nothing changes on the
// page until the text is actually edited; then it's covered and redrawn.
function replaceText(p, index, item, g, page, style, at) {
  let fontName = '';
  try { fontName = page.commonObjs.get(item.fontName)?.name || ''; } catch {}
  const family = style?.fontFamily || '';
  const font = /mono|courier/i.test(family + fontName) ? 'mono'
    : /^serif$|times|roman|georgia|garamond|cambria|minion/i.test(family) || /times|roman|georgia|garamond|cambria|minion/i.test(fontName) ? 'serif'
    : 'sans';
  const parsed = fontName ? parseFontName(fontName) : { weight: 400, italic: false };
  const colors = sampleColors(p, g);
  const size = Math.round(g.size * 100) / 100;
  const revert = { undoLen: S.undo.length, dirty: S.dirty };
  checkpoint();
  const cover = {
    id: uid(), type: 'rect', kind: 'whiteout', x: g.x, y: g.y, angle: g.angle, w: g.width, h: g.height,
    color: colors?.bg || '#ffffff', replaces: index, pending: true,
  };
  const text = {
    id: uid(), type: 'text', angle: g.angle, text: item.str, size, font, bold: parsed.weight >= 600,
    weight: parsed.weight, italic: parsed.italic, css: fontName ? parsed.css : undefined, pdfFont: fontName || undefined,
    color: colors?.text || '#000000', cover: cover.id, pending: true,
  };
  [text.x, text.y] = add(g.origin, axes(g.angle).down, -baselineRatio(text) * size);
  p.annots.push(cover, text);
  setActive(p.id, text.id);
  startEditing(p, text, true, null, at);
  if (editing) editing.revert = revert;
}

// Reads the text and background colors under a text run from the rendered page.
function sampleColors(p, g) {
  const canvas = pageEls.get(p.id)?.querySelector('canvas');
  if (!canvas?.width || !canvas.dataset.key) return null;
  const vp = viewport(p, S.zoom);
  const k = canvas.width / vp.width;
  const { right, down } = axes(g.angle);
  const o = [g.x, g.y];
  const pts = [o, add(o, right, g.width), add(o, down, g.height), add(add(o, right, g.width), down, g.height)].map((c) => vp.toView(...c));
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((c) => c[0])) * k));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((c) => c[1])) * k));
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(...pts.map((c) => c[0])) * k));
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(...pts.map((c) => c[1])) * k));
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return null;
  const data = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
  const px = (x, y) => data.subarray((y * w + x) * 4, (y * w + x) * 4 + 3);
  // Background: the most common color along the edge of the box.
  const counts = new Map();
  const tally = (c) => {
    const key = (c[0] >> 3) << 10 | (c[1] >> 3) << 5 | (c[2] >> 3);
    const e = counts.get(key) || { n: 0, c };
    e.n++;
    counts.set(key, e);
  };
  for (let x = 0; x < w; x++) { tally(px(x, 0)); tally(px(x, h - 1)); }
  for (let y = 0; y < h; y++) { tally(px(0, y)); tally(px(w - 1, y)); }
  const bg = [...counts.values()].sort((a, b) => b.n - a.n)[0].c;
  // Text: the pixel that differs most from the background.
  let best = null, bestD = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = px(x, y);
    const d = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
    if (d > bestD) { bestD = d; best = c; }
  }
  const hex = (c) => `#${[...c].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return { bg: hex(bg), text: bestD > 60 ? hex(best) : null };
}

// Makes a pending text replacement visible (called on the first real change).
function reveal(p, an) {
  if (!an.pending) return;
  an.pending = false;
  const cover = p.annots.find((a) => a.id === an.cover);
  if (cover) cover.pending = false;
  const layer = pageEls.get(p.id)?.querySelector('.layer');
  const el = layer?.querySelector(`.annot[data-id="${an.id}"]`);
  if (el) el.style.color = an.color;
  const cel = cover && layer?.querySelector(`.annot[data-id="${cover.id}"]`);
  if (cel) cel.style.visibility = '';
}

// ---------- annotations ----------

function setActive(pageId, annotId) {
  const prev = S.active;
  S.active = annotId ? { pageId, annotId } : null;
  const prevPage = prev && prev.pageId !== pageId && pageById(prev.pageId);
  if (prevPage) renderLayer(prevPage);
  const p = pageById(pageId);
  if (p) renderLayer(p);
  syncTextProps();
}

function activeAnnot() {
  if (!S.active) return null;
  const p = pageById(S.active.pageId);
  const an = p?.annots.find((a) => a.id === S.active.annotId);
  return an ? { p, an } : null;
}

function deleteAnnot(p, an) {
  checkpoint();
  p.annots = p.annots.filter((a) => a.id !== an.id && a.id !== an.cover);
  S.active = null;
  renderLayer(p);
  syncTextProps();
}

let editing = null; // { p, an, el, snap, isNew }

function startEditing(p, an, isNew = false, snap = null, at = null) {
  const el = pageEls.get(p.id)?.querySelector(`.annot[data-id="${an.id}"]`);
  if (!el) return;
  editing = { p, an, el, snap: snap ?? (isNew ? null : snapshot()), isNew, original: an.text };
  el.contentEditable = 'plaintext-only';
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.focus();
  let range = null;
  if (at && document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(at.x, at.y);
    if (pos && el.contains(pos.offsetNode)) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    }
  } else if (at && document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(at.x, at.y);
    if (r && el.contains(r.startContainer)) range = r;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  el.oninput = () => {
    an.text = el.innerText.replace(/\n$/, '');
    if (an.pending && an.text !== editing?.original) reveal(p, an);
  };
  el.onblur = endEditing;
  el.onpaste = (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  };
}

function endEditing() {
  if (!editing) return;
  const { p, an, el, snap, original, revert } = editing;
  editing = null;
  el.contentEditable = 'false';
  an.text = el.innerText.replace(/\n+$/, '');
  if (an.pending) {
    // Clicked existing text but didn't change it: leave the page untouched.
    p.annots = p.annots.filter((a) => a.id !== an.id && a.id !== an.cover);
    if (S.active?.annotId === an.id) S.active = null;
    if (revert && S.undo.length === revert.undoLen + 1) {
      S.undo.pop();
      S.dirty = revert.dirty;
      updateButtons();
    }
    renderLayer(p);
    syncTextProps();
  } else if (!an.text.trim()) {
    p.annots = p.annots.filter((a) => a.id !== an.id && a.id !== an.cover);
    if (S.active?.annotId === an.id) S.active = null;
    renderLayer(p);
    syncTextProps();
  } else if (snap && an.text !== original) {
    checkpoint(snap);
  }
}

function syncTextProps() {
  const a = activeAnnot();
  const t = a?.an.type === 'text' ? a.an : S.tool === 'text' || S.tool === 'edit' ? S.textDefaults : null;
  $('#textprops').hidden = !t;
  if (!t) return;
  $('#font').value = t.font;
  $('#size').value = t.size;
  $('#color').value = t.color;
  $('#bold').classList.toggle('active', t.bold);
}

function setTextProp(key, value) {
  const a = activeAnnot();
  if (a?.an.type === 'text') {
    const wasEditing = editing?.an === a.an;
    if (a.an[key] !== value) reveal(a.p, a.an);
    endEditing();
    if (a.an[key] === value) return;
    checkpoint();
    a.an[key] = value;
    if (key === 'font' || key === 'bold') {
      // A different font was chosen; stop using the PDF's original one.
      delete a.an.css;
      delete a.an.pdfFont;
      delete a.an.weight;
    }
    renderLayer(a.p);
    if (wasEditing) startEditing(a.p, a.an);
  }
  S.textDefaults[key] = value;
  syncTextProps();
}

$('#font').onchange = (e) => setTextProp('font', e.target.value);
$('#size').onchange = (e) => {
  const v = Math.min(Math.max(parseFloat(e.target.value) || 12, 4), 200);
  setTextProp('size', v);
};
$('#color').onchange = (e) => setTextProp('color', e.target.value);
$('#bold').onclick = () => {
  const a = activeAnnot();
  setTextProp('bold', !(a?.an.type === 'text' ? a.an.bold : S.textDefaults.bold));
};

// Pointer handling on pages: create, select, move and resize annotations.
$('#pages').addEventListener('pointerdown', (e) => {
  const pageEl = e.target.closest('.page');
  if (!pageEl || e.button !== 0) return;
  const p = pageById(pageEl.dataset.id);
  const vp = viewport(p, S.zoom);
  const layerRect = pageEl.getBoundingClientRect();
  const local = (ev) => [ev.clientX - layerRect.left, ev.clientY - layerRect.top];
  const start = local(e);
  S.current = p.id;
  focusArea = 'pages';

  const annotNode = e.target.closest('.annot');
  if (annotNode && editing?.el === annotNode) return; // let the caret move inside text

  if (e.target.classList.contains('tspan')) {
    e.preventDefault();
    e.target._edit({ x: e.clientX, y: e.clientY });
    return;
  }

  if (annotNode) {
    const an = p.annots.find((a) => a.id === annotNode.dataset.id);
    const wasActive = S.active?.annotId === an.id;
    const resizing = e.target.classList.contains('handle');
    e.preventDefault();
    endEditing();
    if (!wasActive) setActive(p.id, an.id);
    const el = pageEl.querySelector(`.annot[data-id="${an.id}"]`);
    const orig = { x: an.x, y: an.y, w: an.w, h: an.h };
    const p0 = vp.toPdf(...start);
    const snap = snapshot();
    let moved = false;
    const onMove = (ev) => {
      const cur = local(ev);
      if (!moved && Math.hypot(cur[0] - start[0], cur[1] - start[1]) < 3) return;
      if (!moved) { moved = true; checkpoint(snap); }
      const p1 = vp.toPdf(...cur);
      const delta = [p1[0] - p0[0], p1[1] - p0[1]];
      if (resizing) {
        const { right, down } = axes(an.angle);
        an.w = Math.max(4, orig.w + delta[0] * right[0] + delta[1] * right[1]);
        an.h = an.type === 'image' ? an.w * (orig.h / orig.w) : Math.max(2, orig.h + delta[0] * down[0] + delta[1] * down[1]);
        el.style.width = `${an.w * vp.scale}px`;
        el.style.height = `${an.h * vp.scale}px`;
      } else {
        an.x = orig.x + delta[0];
        an.y = orig.y + delta[1];
        place(el, an, p, vp);
      }
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      if (!moved && an.type === 'text' && (wasActive || S.tool === 'edit')) startEditing(p, an);
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    return;
  }

  if (S.tool === 'text') {
    e.preventDefault();
    endEditing();
    const d = S.textDefaults;
    const [x, y] = vp.toPdf(start[0], start[1] - d.size * LINE_HEIGHT * S.zoom * 0.5);
    const an = { id: uid(), type: 'text', x, y, angle: p.rotation, text: '', ...d };
    const snap = snapshot();
    p.annots.push(an);
    setActive(p.id, an.id);
    startEditing(p, an, true, snap);
    editing.original = '';
    setTool('select');
    return;
  }

  if (S.tool === 'whiteout' || S.tool === 'highlight') {
    e.preventDefault();
    endEditing();
    const layer = pageEl.querySelector('.layer');
    const box = Object.assign(document.createElement('div'), { className: 'drawing' });
    layer.append(box);
    let end = start;
    const onMove = (ev) => {
      end = local(ev);
      Object.assign(box.style, {
        left: `${Math.min(start[0], end[0])}px`, top: `${Math.min(start[1], end[1])}px`,
        width: `${Math.abs(end[0] - start[0])}px`, height: `${Math.abs(end[1] - start[1])}px`,
      });
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      box.remove();
      const w = Math.abs(end[0] - start[0]) / S.zoom;
      const h = Math.abs(end[1] - start[1]) / S.zoom;
      if (w < 2 || h < 2) return;
      const [x, y] = vp.toPdf(Math.min(start[0], end[0]), Math.min(start[1], end[1]));
      checkpoint();
      const an = { id: uid(), type: 'rect', kind: S.tool, x, y, angle: p.rotation, w, h };
      p.annots.push(an);
      setActive(p.id, an.id);
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    return;
  }

  // Plain click on a page: select it.
  endEditing();
  if (S.active) setActive(null, null);
  if (!(S.selected.size === 1 && S.selected.has(p.id))) {
    S.selected = new Set([p.id]);
    updateSelection();
  }
});

function setTool(tool) {
  if (tool !== 'select' && tool === S.tool) tool = 'select';
  const wasEdit = S.tool === 'edit';
  S.tool = tool;
  document.body.dataset.tool = tool;
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  if (wasEdit !== (tool === 'edit')) S.pages.forEach(renderLayer);
  syncTextProps();
}
for (const b of $$('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);

$('#image').onclick = () => $('#file-img').click();
$('#file-img').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const p = pageById(S.current) || S.pages[0];
  try {
    const { dataUrl, width, height } = await readImage(file);
    const vp = viewport(p, S.zoom);
    let w = width * 0.75, h = height * 0.75; // px -> pt
    const maxW = (vp.width / S.zoom) * 0.5;
    if (w > maxW) { h *= maxW / w; w = maxW; }
    const [x, y] = vp.toPdf(vp.width / 2 - (w * S.zoom) / 2, vp.height / 2 - (h * S.zoom) / 2);
    const img = uid();
    S.images.set(img, dataUrl);
    checkpoint();
    const an = { id: uid(), type: 'image', img, x, y, angle: p.rotation, w, h };
    p.annots.push(an);
    setActive(p.id, an.id);
    scrollToPage(p.id);
  } catch {
    toast('Could not read that image.');
  }
};

function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const jpeg = file.type === 'image/jpeg';
      resolve({ dataUrl: c.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92), width: c.width, height: c.height });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(); };
    img.src = url;
  });
}

// ---------- pages ----------

const orderedSelection = () => S.pages.filter((p) => S.selected.has(p.id));

function updateSelection() {
  for (const [id, th] of thumbEls) th.classList.toggle('selected', S.selected.has(id));
  updateButtons();
}

function rotateSelected(delta) {
  const sel = orderedSelection();
  if (!sel.length) return;
  endEditing();
  checkpoint();
  for (const p of sel) p.rotation = (p.rotation + delta + 360) % 360;
  renderAll();
}

function deleteSelected() {
  const sel = orderedSelection();
  if (!sel.length) return;
  if (sel.length === S.pages.length) return toast('A PDF needs at least one page.');
  endEditing();
  checkpoint();
  const first = S.pages.indexOf(sel[0]);
  S.pages = S.pages.filter((p) => !S.selected.has(p.id));
  const next = S.pages[Math.min(first, S.pages.length - 1)];
  S.selected = new Set([next.id]);
  S.active = null;
  renderAll();
}

function insertBlank() {
  const sel = orderedSelection();
  const ref = sel[sel.length - 1] || pageById(S.current) || S.pages[S.pages.length - 1];
  const vp = viewport(ref, 1);
  checkpoint();
  const page = { id: uid(), src: null, index: 0, view: [0, 0, vp.width, vp.height], rotation: 0, annots: [] };
  S.pages.splice(S.pages.indexOf(ref) + 1, 0, page);
  S.selected = new Set([page.id]);
  renderAll();
  scrollToPage(page.id);
}

function movePages(ids, targetId, after) {
  if (ids.includes(targetId)) return;
  const moving = S.pages.filter((p) => ids.includes(p.id));
  const rest = S.pages.filter((p) => !ids.includes(p.id));
  const idx = targetId ? rest.findIndex((p) => p.id === targetId) + (after ? 1 : 0) : rest.length;
  rest.splice(idx, 0, ...moving);
  if (rest.every((p, i) => p === S.pages[i])) return;
  checkpoint();
  S.pages = rest;
  renderAll();
}

function scrollToPage(id) {
  pageEls.get(id)?.scrollIntoView({ block: 'start' });
  thumbEls.get(id)?.scrollIntoView({ block: 'nearest' });
}

$('#rot-left').onclick = () => rotateSelected(-90);
$('#rot-right').onclick = () => rotateSelected(90);
$('#del').onclick = deleteSelected;
$('#blank').onclick = insertBlank;

// Thumbnails: click to select, drag to reorder, drop PDFs to insert.
let lastClicked = null;
let focusArea = 'pages'; // where the Delete key applies to pages
$('#thumbs').addEventListener('pointerdown', () => { focusArea = 'thumbs'; });
$('#thumbs').addEventListener('click', (e) => {
  const th = e.target.closest('.thumb');
  if (!th) return;
  const id = th.dataset.id;
  if (e.shiftKey && lastClicked) {
    const a = S.pages.findIndex((p) => p.id === lastClicked);
    const b = S.pages.findIndex((p) => p.id === id);
    S.selected = new Set(S.pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id));
  } else if (e.ctrlKey || e.metaKey) {
    S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
    lastClicked = id;
  } else {
    S.selected = new Set([id]);
    lastClicked = id;
    S.current = id;
    pageEls.get(id)?.scrollIntoView({ block: 'start' });
  }
  updateSelection();
});

let dragIds = null;
let dropTarget = null; // { id, after }

function clearDropMarks() {
  for (const t of $$('.drop-before, .drop-after')) t.classList.remove('drop-before', 'drop-after');
}

$('#thumbs').addEventListener('dragstart', (e) => {
  const th = e.target.closest('.thumb');
  const id = th.dataset.id;
  dragIds = S.selected.has(id) ? orderedSelection().map((p) => p.id) : [id];
  for (const d of dragIds) thumbEls.get(d)?.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
});
$('#thumbs').addEventListener('dragend', () => {
  for (const t of $$('.thumb.dragging')) t.classList.remove('dragging');
  clearDropMarks();
  dragIds = null;
});
$('#thumbs').addEventListener('dragover', (e) => {
  if (!dragIds && !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  e.stopPropagation();
  const th = e.target.closest('.thumb') || [...thumbEls.values()].at(-1);
  clearDropMarks();
  if (!th) return (dropTarget = null);
  const r = th.getBoundingClientRect();
  const after = e.target.closest('.thumb') ? e.clientY > r.top + r.height / 2 : true;
  th.classList.add(after ? 'drop-after' : 'drop-before');
  dropTarget = { id: th.dataset.id, after };
});
$('#thumbs').addEventListener('dragleave', (e) => {
  if (!e.currentTarget.contains(e.relatedTarget)) clearDropMarks();
});
$('#thumbs').addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearDropMarks();
  const t = dropTarget;
  if (dragIds) {
    if (t) movePages(dragIds, t.id, t.after);
  } else if (e.dataTransfer.files.length) {
    const idx = t ? S.pages.findIndex((p) => p.id === t.id) + (t.after ? 1 : 0) : S.pages.length;
    insertFiles(e.dataTransfer.files, idx);
  }
});

// Drop PDFs on the viewer: open (if empty) or append.
const viewer = $('#viewer');
viewer.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  viewer.classList.add('drop');
});
viewer.addEventListener('dragleave', (e) => { if (!viewer.contains(e.relatedTarget)) viewer.classList.remove('drop'); });
viewer.addEventListener('drop', (e) => {
  e.preventDefault();
  viewer.classList.remove('drop');
  if (S.pages.length) insertFiles(e.dataTransfer.files);
  else openFiles(e.dataTransfer.files);
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => e.preventDefault());

// Track the page most in view (used for "Image").
let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
    for (const [id, el] of pageEls) {
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) { S.current = id; break; }
    }
  });
});

// ---------- zoom ----------

function setZoom(z) {
  z = Math.min(Math.max(z, 0.25), 5);
  const ratio = viewer.scrollTop / (viewer.scrollHeight || 1);
  endEditing();
  S.zoom = Math.round(z * 100) / 100;
  renderAll();
  viewer.scrollTop = ratio * viewer.scrollHeight;
}

function fitZoom() {
  const widest = Math.max(...S.pages.map((p) => viewport(p, 1).width));
  S.zoom = Math.round(Math.min((viewer.clientWidth - 60) / widest, 1.5) * 100) / 100;
}

$('#zoom-in').onclick = () => setZoom(S.zoom * 1.2);
$('#zoom-out').onclick = () => setZoom(S.zoom / 1.2);
$('#zoom-fit').onclick = () => { fitZoom(); setZoom(S.zoom); };

// ---------- saving ----------

const hexToRgb = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

// Standard PDF fonts only cover Latin-1-ish characters; replace anything else.
function encodable(font, text) {
  let out = '';
  for (const ch of text) {
    try { font.encodeText(ch); out += ch; } catch { out += '?'; }
  }
  return out;
}

// Finds the font already in the page that covers most of `sample`, so edited text
// keeps its original look. Uses the font's ToUnicode map to turn characters back
// into codes. Embedded fonts usually only contain the characters the PDF uses.
const fontInfoCache = new WeakMap();
function originalFont(page, baseName, sample) {
  const fonts = page.node.Resources()?.lookup(PDFName.of('Font'));
  if (!(fonts instanceof PDFDict)) return null;
  const strip = (n) => n.replace(/^[A-Z]{6}\+/, '');
  const candidates = [];
  for (const [key, ref] of fonts.entries()) {
    const dict = page.doc.context.lookup(ref);
    if (!(dict instanceof PDFDict)) continue;
    const name = dict.lookup(PDFName.of('BaseFont'))?.decodeText?.() || '';
    if (name === baseName) candidates.unshift({ key, dict });
    else if (strip(name) === strip(baseName)) candidates.push({ key, dict });
  }
  let best = null, bestHits = 0;
  for (const { key, dict } of candidates) {
    if (!fontInfoCache.has(dict)) {
      let info = null;
      try {
        const stream = dict.lookup(PDFName.of('ToUnicode'));
        const width = fontWidths(dict);
        if (stream && width) info = { codes: parseToUnicode(decodePDFRawStream(stream).decode()), width };
      } catch {}
      fontInfoCache.set(dict, info);
    }
    const info = fontInfoCache.get(dict);
    const hits = info ? [...sample].filter((ch) => info.codes.has(ch)).length : 0;
    if (hits > bestHits) { best = { key, ...info }; bestHits = hits; }
  }
  return best;
}

// Glyph widths (in 1/1000 em) by hex code, or null if the font isn't one we can write with.
function fontWidths(dict) {
  const num = (o) => o?.asNumber?.() ?? 0;
  if (dict.lookup(PDFName.of('Subtype'))?.decodeText?.() === 'Type0') {
    if (dict.lookup(PDFName.of('Encoding'))?.decodeText?.() !== 'Identity-H') return null;
    const cid = dict.lookup(PDFName.of('DescendantFonts'))?.lookup(0);
    if (!(cid instanceof PDFDict)) return null;
    const dw = cid.has(PDFName.of('DW')) ? num(cid.lookup(PDFName.of('DW'))) : 1000;
    const widths = new Map();
    const w = cid.lookup(PDFName.of('W'));
    for (let i = 0; w && i < w.size();) {
      const first = num(w.lookup(i));
      const next = w.lookup(i + 1);
      if (next?.size) {
        for (let j = 0; j < next.size(); j++) widths.set(first + j, num(next.lookup(j)));
        i += 2;
      } else {
        for (let c = first; c <= num(next); c++) widths.set(c, num(w.lookup(i + 2)));
        i += 3;
      }
    }
    return (hex) => widths.get(parseInt(hex, 16)) ?? dw;
  }
  const first = num(dict.lookup(PDFName.of('FirstChar')));
  const list = dict.lookup(PDFName.of('Widths'));
  if (!list?.size) return null;
  return (hex) => num(list.lookup(parseInt(hex, 16) - first));
}

// Parses a ToUnicode CMap into a map of character -> hex character code.
function parseToUnicode(bytes) {
  const src = new TextDecoder('latin1').decode(bytes);
  const codes = new Map();
  const toStr = (hex) => {
    hex = hex.padStart(Math.ceil(hex.length / 4) * 4, '0');
    let out = '';
    for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  };
  const set = (str, code) => { if (!codes.has(str)) codes.set(str, code); };
  for (const [, body] of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, from, to] of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) set(toStr(to), from);
  }
  for (const [, body] of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, to] of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const a = parseInt(lo, 16), b = parseInt(hi, 16);
      if (b < a || b - a > 0xffff) continue;
      const list = to.startsWith('[') ? [...to.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1]) : null;
      const base = list ? null : to.slice(1, -1).padStart(4, '0');
      for (let c = a; c <= b; c++) {
        const dst = list ? list[c - a] : base.slice(0, -4) + (parseInt(base.slice(-4), 16) + c - a).toString(16).padStart(4, '0');
        if (!dst) break;
        set(toStr(dst), c.toString(16).padStart(lo.length, '0'));
      }
    }
  }
  return codes;
}

async function buildPdf(list) {
  const out = await PDFDocument.create();
  const copied = new Map();
  const bySrc = new Map();
  for (const p of list) if (p.src) (bySrc.get(p.src) ?? bySrc.set(p.src, []).get(p.src)).push(p.index);
  // One copy per source document so shared resources (fonts, images) are not duplicated.
  for (const [src, indices] of bySrc) {
    const doc = await PDFDocument.load(S.sources.get(src).bytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = await out.copyPages(doc, indices);
    indices.forEach((i, k) => copied.set(`${src}:${i}`, pages[k]));
  }
  const fonts = new Map();
  const font = async (name) => fonts.get(name) ?? fonts.set(name, await out.embedFont(name)).get(name);
  const images = new Map();

  for (const p of list) {
    let page;
    if (p.src) {
      page = out.addPage(copied.get(`${p.src}:${p.index}`));
    } else {
      page = out.addPage([p.view[2], p.view[3]]);
    }
    page.setRotation(degrees(p.rotation));
    for (const an of p.annots) {
      if (an.pending) continue;
      const { down } = axes(an.angle);
      const rotate = degrees(an.angle);
      if (an.type === 'rect') {
        const [x, y] = add([an.x, an.y], down, an.h);
        page.drawRectangle({
          x, y, width: an.w, height: an.h, rotate,
          color: an.kind === 'highlight' ? rgb(1, 0.9, 0) : hexToRgb(an.color || '#ffffff'),
          opacity: an.kind === 'highlight' ? 0.4 : 1,
          blendMode: an.kind === 'highlight' ? BlendMode.Multiply : undefined,
        });
      } else if (an.type === 'image') {
        const url = S.images.get(an.img);
        if (!images.has(an.img)) {
          const bytes = await (await fetch(url)).arrayBuffer();
          images.set(an.img, url.startsWith('data:image/jpeg') ? await out.embedJpg(bytes) : await out.embedPng(bytes));
        }
        const [x, y] = add([an.x, an.y], down, an.h);
        page.drawImage(images.get(an.img), { x, y, width: an.w, height: an.h, rotate });
      } else if (an.type === 'text') {
        const text = an.text.replace(/\t/g, '    ');
        const chars = [...text.replace(/\n/g, '')];
        const orig = an.pdfFont && originalFont(page, an.pdfFont, chars.join(''));
        const inOrig = (ch) => orig?.codes.has(ch);
        // Characters the original font lacks are drawn with a standard font.
        const f = chars.every(inOrig) ? null : await font(FONTS[an.font].std[(an.bold ? 1 : 0) + (an.italic ? 2 : 0)]);
        const base = baselineRatio(an) * an.size;
        const { right } = axes(an.angle);
        const r = (an.angle * Math.PI) / 180;
        const color = hexToRgb(an.color);
        text.split('\n').forEach((line, i) => {
          let pos = add([an.x, an.y], down, base + i * LINE_HEIGHT * an.size);
          const runs = [];
          for (const ch of line) {
            const o = inOrig(ch);
            if (runs.length && runs.at(-1).o === o) runs.at(-1).s += ch;
            else runs.push({ o, s: ch });
          }
          for (const { o, s } of runs) {
            if (o) {
              const codes = [...s].map((ch) => orig.codes.get(ch));
              page.pushOperators(
                pushGraphicsState(), setFillingRgbColor(color.red, color.green, color.blue), beginText(),
                setFontAndSize(orig.key, an.size), setTextMatrix(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), ...pos),
                showText(PDFHexString.of(codes.join(''))), endText(), popGraphicsState(),
              );
              pos = add(pos, right, (codes.reduce((sum, c) => sum + orig.width(c), 0) / 1000) * an.size);
            } else {
              const t = encodable(f, s);
              page.drawText(t, { x: pos[0], y: pos[1], size: an.size, font: f, color, rotate });
              pos = add(pos, right, f.widthOfTextAtSize(t, an.size));
            }
          }
        });
      }
    }
  }
  return out.save();
}

async function saveBytes(bytes, name) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return true;
}

let saving = false;
async function save(list, name) {
  if (saving || !list.length) return;
  endEditing();
  saving = true;
  try {
    const bytes = await buildPdf(list);
    if ((await saveBytes(bytes, name)) && list === S.pages) S.dirty = false;
  } catch (e) {
    console.error(e);
    toast('Saving failed. The PDF may be damaged or encrypted.');
  } finally {
    saving = false;
  }
}

const baseName = () => S.name.replace(/\.pdf$/i, '');
$('#save').onclick = () => save(S.pages, `${baseName()}.pdf`);
$('#extract').onclick = () => save(orderedSelection(), `${baseName()} (extract).pdf`);

// ---------- misc UI ----------

function updateButtons() {
  const hasDoc = S.pages.length > 0;
  for (const el of $$('[data-needs-doc]')) {
    if (el.tagName === 'BUTTON') el.disabled = !hasDoc;
    else el.hidden = !hasDoc;
  }
  for (const b of $$('[data-needs-sel]')) b.disabled = !S.selected.size;
  $('#undo').disabled = !S.undo.length;
  $('#redo').disabled = !S.redo.length;
  $('#zoom-label').textContent = `${Math.round(S.zoom * 100)}%`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

$('#open').onclick = $('#open2').onclick = () => { $('#file-pdf').dataset.mode = 'open'; $('#file-pdf').click(); };
$('#add').onclick = () => { $('#file-pdf').dataset.mode = 'add'; $('#file-pdf').click(); };
$('#file-pdf').onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (e.target.dataset.mode === 'add') {
    const sel = orderedSelection();
    insertFiles(files, sel.length ? S.pages.indexOf(sel[sel.length - 1]) + 1 : S.pages.length);
  } else {
    openFiles(files);
  }
};
$('#undo').onclick = undo;
$('#redo').onclick = redo;

addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = editing || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
  const key = e.key.toLowerCase();
  if (mod && key === 's') { e.preventDefault(); if (S.pages.length) $('#save').click(); return; }
  if (mod && key === 'o') { e.preventDefault(); $('#open').click(); return; }
  if (e.key === 'Escape') {
    if (editing) { editing.el.blur(); return; }
    if (S.active) setActive(null, null);
    setTool('select');
    return;
  }
  if (typing || !S.pages.length) return;
  if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && key === 'y') { e.preventDefault(); redo(); }
  else if (mod && (key === '=' || key === '+')) { e.preventDefault(); setZoom(S.zoom * 1.2); }
  else if (mod && key === '-') { e.preventDefault(); setZoom(S.zoom / 1.2); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    const a = activeAnnot();
    if (a) { e.preventDefault(); deleteAnnot(a.p, a.an); }
    else if (e.key === 'Delete' && focusArea === 'thumbs') deleteSelected();
  }
});

addEventListener('beforeunload', (e) => {
  if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
});

document.body.dataset.tool = 'select';
updateButtons();

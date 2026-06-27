/**
 * App orchestration.
 *
 * Layers per page (bottom to top): canvas → annotation layer (the PDF's own
 * links, re-created as clickable areas) → overlay (drawing + new-link
 * rectangles + destination pins).
 *
 * Interaction:
 *   - Add link: draw a box, then pick a destination (three modes in one row).
 *   - Click any link on the page (new or existing) to select it. It jumps to
 *     its target (like a real PDF link) and the right panel shows the same
 *     three destination modes to re-point it, plus delete.
 */
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

import { loadPdf } from './pdfRenderer.js';
import { PDFViewer, EventBus, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  viewportRectToPdfRect,
  viewportPointToPdfPoint,
  pdfRectToViewportBox,
} from './coords.js';
import { readExistingLinks, buildPdf, bytesToPdfBlob } from './pdfExporter.js';
import { LinkStore } from './linkManager.js';

const $ = (id) => document.getElementById(id);

// ---------- DOM ----------
const fileInput = $('file-input');
const dropzone = $('dropzone');
const viewerContainer = $('viewer-container');
const viewerEl = $('viewer');

const zoomInBtn = $('zoom-in');
const zoomOutBtn = $('zoom-out');
const zoomLabel = $('zoom-label');
const undoBtn = $('undo-btn');
const redoBtn = $('redo-btn');
const exportBtn = $('export-btn');
const themeBtn = $('theme-btn');
const helpBtn = $('help-btn');
const helpPanel = $('help-panel');
const helpClose = $('help-close');

const addLinkBtn = $('add-link');
const targetPanel = $('target-panel');
const chooserDot = $('chooser-dot');
const chooserTitle = $('chooser-title');
const chooserMeta = $('chooser-meta');
const chooserActions = $('chooser-actions');
const targetPageInput = $('target-page');
const confirmTopBtn = $('confirm-top');
const modePickBtn = $('mode-pick');
const modeViewBtn = $('mode-view');
const modeUrlBtn = $('mode-url');
const urlRow = $('url-row');
const targetUrlInput = $('target-url');
const confirmUrlBtn = $('confirm-url');
const cancelTargetBtn = $('cancel-target');
const selSource = $('sel-source');
const selOpen = $('sel-open');
const selReset = $('sel-reset');
const selDelete = $('sel-delete');
const selDone = $('sel-done');

const statusBar = $('status-bar');
const statusText = $('status-text');
const statusCancel = $('status-cancel');

const linkList = $('link-list');
const linkTotal = $('link-total');
const existingBlock = $('existing-block');
const existingList = $('existing-list');
const existingTotal = $('existing-total');
const toastEl = $('toast');

// ---------- State ----------
const state = {
  rawBytes: null,
  fileName: 'document.pdf',
  pdf: null,
  numPages: 0,
  existingLinks: [],
  edits: {}, // existing-link id -> { deleted?, target?, rect? } (fields compose)
  mode: 'idle', // idle | draw | pick
  pending: null, // new link being drawn { srcPage, rect }
  selected: null, // the link being edited { kind:'new'|'existing', id }
};

const store = new LinkStore();

// ============================================================
// Undo / redo. The whole editable state is store.links + state.edits, both
// small and serializable, so we just snapshot them onto a linear history.
// ============================================================
let history = [];
let hIndex = -1;
const snapshot = () => ({ links: structuredClone(store.links), edits: structuredClone(state.edits) });
function resetHistory() {
  history = [snapshot()];
  hIndex = 0;
  updateHistoryButtons();
}
function pushHistory() {
  history = history.slice(0, hIndex + 1);
  history.push(snapshot());
  hIndex = history.length - 1;
  updateHistoryButtons();
}
function restoreHistory() {
  const s = history[hIndex];
  store.links = structuredClone(s.links);
  state.edits = structuredClone(s.edits);
  state.selected = state.pending = null;
  targetPanel.hidden = true;
  setMode('idle');
  refresh();
  updateHistoryButtons();
}
function undo() {
  if (hIndex <= 0) return;
  const focus = diffFocus(history[hIndex], history[hIndex - 1]);
  hIndex--;
  restoreHistory();
  focusStep(focus);
}
function redo() {
  if (hIndex >= history.length - 1) return;
  const focus = diffFocus(history[hIndex], history[hIndex + 1]);
  hIndex++;
  restoreHistory();
  focusStep(focus);
}

/** Find where two snapshots differ, so undo/redo can scroll there. */
function diffFocus(a, b) {
  const key = (v) => JSON.stringify(v ?? null);
  // New links: an added, removed or changed link.
  const am = new Map(a.links.map((l) => [l.id, l]));
  const bm = new Map(b.links.map((l) => [l.id, l]));
  for (const [id, bl] of bm) {
    if (key(am.get(id)) !== key(bl)) return { page: bl.srcPage, rect: bl.rect };
  }
  for (const [id, al] of am) {
    if (!bm.has(id)) return { page: al.srcPage, rect: al.rect };
  }
  // Existing-link edits: locate the source link to scroll to.
  const ids = new Set([...Object.keys(a.edits), ...Object.keys(b.edits)]);
  for (const id of ids) {
    if (key(a.edits[id]) === key(b.edits[id])) continue;
    const link = existingById(id);
    if (!link) continue;
    return { page: link.page, rect: b.edits[id]?.rect || a.edits[id]?.rect || link.rect };
  }
  return null;
}
function focusStep(focus) {
  if (focus) scrollToPage(focus.page, { x: focus.rect[0], y: focus.rect[3] });
}
function updateHistoryButtons() {
  undoBtn.disabled = hIndex <= 0;
  redoBtn.disabled = hIndex >= history.length - 1;
}
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
document.addEventListener('keydown', (e) => {
  if (!state.pdf || /^(input|textarea)$/i.test(e.target.tagName)) return;
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (k === 'y') { e.preventDefault(); redo(); }
});

// ============================================================
// PDF.js viewer (rendering, virtualization, scroll, zoom)
// ============================================================
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const viewer = new PDFViewer({
  container: viewerContainer,
  viewer: viewerEl,
  eventBus,
  linkService,
  textLayerMode: 0, // disable text + annotation layers; our overlay handles links
  annotationMode: 0,
  removePageBorders: true,
});
linkService.setViewer(viewer);

// Our editing layers, keyed by 1-based page number, built as pages render.
const pageRecs = new Map();

eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width'; });
eventBus.on('scalechanging', (e) => {
  zoomLabel.textContent = `${Math.round(e.scale * 100)}%`;
  viewerContainer.classList.add('is-zooming'); // hide overlays mid-zoom (avoid drift)
});
eventBus.on('pagerendered', (e) => {
  viewerContainer.classList.remove('is-zooming');
  attachPage(e.pageNumber);
});

/** Attach (or refresh) our overlay + annotation layer onto a rendered page. */
function attachPage(pageNumber) {
  const pv = viewer.getPageView(pageNumber - 1);
  if (!pv?.div || !pv.viewport) return;
  const div = pv.div;

  if (!div.querySelector(':scope > .overlay')) {
    const badge = document.createElement('span');
    badge.className = 'page__badge';
    badge.textContent = String(pageNumber);
    const annotLayer = document.createElement('div');
    annotLayer.className = 'annot-layer';
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    div.append(badge, annotLayer, overlay);
    const p = { index: pageNumber - 1, wrapper: div, overlay, annotLayer, viewport: pv.viewport };
    pageRecs.set(pageNumber, p);
    wireOverlay(p);
  }

  const p = pageRecs.get(pageNumber);
  p.wrapper = div;
  p.overlay = div.querySelector(':scope > .overlay');
  p.annotLayer = div.querySelector(':scope > .annot-layer');
  p.viewport = pv.viewport;
  applyMode(p);
  buildAnnotLayer(p);
  redrawOverlay(p);
}

function applyMode(p) {
  const active = state.mode !== 'idle';
  p.overlay.classList.toggle('is-active', active);
  p.overlay.classList.toggle('mode-draw', state.mode === 'draw');
  p.overlay.classList.toggle('mode-pick', state.mode === 'pick');
  p.annotLayer.classList.toggle('is-muted', active);
}

// ============================================================
// Theme
// ============================================================
const currentTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch { /* ignore */ }
  updateThemeBtn();
}
function updateThemeBtn() {
  const dark = currentTheme() === 'dark';
  themeBtn.textContent = dark ? '◐' : '◑';
  themeBtn.title = dark ? 'Switch to light' : 'Switch to dark';
}
themeBtn.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
updateThemeBtn();

// ============================================================
// Open a local PDF (read in-browser, never uploaded)
// ============================================================
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
});
['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('is-drag'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('is-drag'); })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file?.type === 'application/pdf') handleFile(file);
});

async function handleFile(file) {
  let bytes, pdf, existing;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    pdf = await loadPdf(bytes);
    existing = await readExistingLinks(bytes);
  } catch {
    toast('Could not open this PDF');
    return;
  }
  fileInput.value = ''; // allow re-opening the same file (re-fires change)

  state.fileName = file.name || 'document.pdf';
  state.rawBytes = bytes;
  state.pdf = pdf;
  state.numPages = pdf.numPages;
  state.existingLinks = existing;
  await resolveNamedTargets();
  await computeLinkLabels();

  // Reset everything so a previously opened file leaves nothing behind.
  store.clear();
  state.edits = {};
  state.selected = state.pending = null;
  state.mode = 'idle';
  targetPanel.hidden = true;
  pageRecs.clear();
  textItemsCache.clear();
  indexExistingByPage();
  resetHistory();

  dropzone.hidden = true;
  viewerContainer.hidden = false;
  document.querySelectorAll('[data-needs-pdf]').forEach((el) => (el.hidden = false));
  addLinkBtn.disabled = false;
  targetPageInput.max = String(state.numPages);

  linkService.setDocument(state.pdf, null);
  viewer.setDocument(state.pdf); // renders, virtualizes; pagerendered builds our layers
  renderLists();
}

/**
 * Named destinations (common in Word-exported TOCs) are stored in the PDF's
 * /Names tree, which our pdf-lib reader does not resolve. PDF.js does, so we
 * use it to fill in the target page and XYZ point for those links.
 */
async function resolveNamedTargets() {
  for (const l of state.existingLinks) {
    if (l.kind !== 'internal' || l.targetPage != null || !l.name) continue;
    try {
      const dest = await state.pdf.getDestination(l.name);
      if (Array.isArray(dest) && dest[0]) {
        l.targetPage = (await state.pdf.getPageIndex(dest[0])) + 1;
        if (dest[1]?.name === 'XYZ' && typeof dest[3] === 'number') {
          l.point = { x: typeof dest[2] === 'number' ? dest[2] : 0, y: dest[3] };
        }
      }
    } catch { /* leave unresolved; delete/re-point still work */ }
  }
}

// ============================================================
// Existing PDF links -> clickable areas
// ============================================================
const existingByPage = new Map(); // page number -> ExistingLink[]
function indexExistingByPage() {
  existingByPage.clear();
  for (const l of state.existingLinks) {
    const arr = existingByPage.get(l.page) || [];
    arr.push(l);
    existingByPage.set(l.page, arr);
  }
}
const existingById = (id) => state.existingLinks.find((x) => x.id === id);

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** The visible text under a rectangle, e.g. "3. Results" for a TOC link. */
function textUnderRect(items, [x1, y1, x2, y2]) {
  const hits = items.filter((it) => {
    if (!it.str?.trim()) return false;
    const x = it.transform[4], y = it.transform[5], w = it.width || 0;
    return x < x2 && x + w > x1 && y >= y1 - 3 && y <= y2; // baseline within the line
  });
  hits.sort((a, b) => a.transform[4] - b.transform[4]);
  return hits.map((it) => it.str).join('').replace(/\s+/g, ' ').trim();
}

/** Text-content items per page, cached for the current document. */
const textItemsCache = new Map();
async function pageTextItems(pageNum) {
  if (!textItemsCache.has(pageNum)) {
    const page = await state.pdf.getPage(pageNum);
    textItemsCache.set(pageNum, (await page.getTextContent()).items);
  }
  return textItemsCache.get(pageNum);
}

/** The page text under a rect, e.g. "3. Results", used as a link's title. */
async function labelForRect(pageNum, rect) {
  try {
    return truncate(textUnderRect(await pageTextItems(pageNum), rect), 42);
  } catch {
    return '';
  }
}

/** Label each existing link with the text it covers (so the list is meaningful). */
async function computeLinkLabels() {
  for (const l of state.existingLinks) l.label = await labelForRect(l.page, l.rect);
}

function effectiveTarget(link) {
  const edit = state.edits[link.id];
  if (edit?.target) return edit.target.type === 'internal' ? edit.target.targetPage : null;
  return link.targetPage ?? null;
}

/** Current rect of an existing link, honouring a resize edit. */
function existingRect(link) {
  return state.edits[link.id]?.rect || link.rect;
}

/** One-line summary of a LinkTarget, used in toasts and lists. */
function summarizeTarget(t) {
  if (!t) return 'link';
  if (t.type === 'external') return truncate(t.url || 'URL', 26);
  return t.dest?.type === 'page-top' ? `top of page ${t.targetPage}` : `page ${t.targetPage}`;
}

function buildAnnotLayer(p) {
  if (!p.viewport || !p.annotLayer.isConnected) return; // not on screen
  p.annotLayer.innerHTML = '';
  p.annotLayer.classList.toggle('is-muted', state.mode !== 'idle');

  for (const link of existingByPage.get(p.index + 1) || []) {
    const box = pdfRectToViewportBox(p.viewport, existingRect(link));
    const el = document.createElement('div');
    el.className = 'annot-link';
    const deleted = state.edits[link.id]?.deleted;
    if (deleted) el.classList.add('is-deleted');
    if (state.selected?.kind === 'existing' && state.selected.id === link.id) el.classList.add('is-selected');
    Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    el.title = describeTarget(link);
    if (!deleted) {
      wireRect(el, p, {
        kind: 'existing', id: link.id,
        setRect: (rect) => { state.edits[link.id] = { ...state.edits[link.id], rect }; pushHistory(); refresh(); },
        select: () => selectLink('existing', link.id),
      });
    }
    p.annotLayer.appendChild(el);
  }
}
function rebuildAnnotLayers() { for (const p of pageRecs.values()) buildAnnotLayer(p); }

function describeTarget(link) {
  const edit = state.edits[link.id];
  if (edit?.deleted) return 'Will be removed';
  if (edit?.target) return 'Now: ' + summarizeTarget(edit.target);
  if (link.kind === 'external') return link.url || 'External link';
  if (link.kind === 'internal') return link.targetPage ? `Page ${link.targetPage}` : 'Internal link';
  return 'Link';
}

// ============================================================
// Zoom (delegated to the PDF.js viewer: smooth scale + cursor anchoring)
// ============================================================
zoomInBtn.addEventListener('click', () => viewer.increaseScale({ drawingDelay: 400 }));
zoomOutBtn.addEventListener('click', () => viewer.decreaseScale({ drawingDelay: 400 }));

// Trackpad pinch / ctrl+wheel. updateScale does the live CSS-scale during the
// gesture and a single crisp re-render afterwards, anchored at the cursor.
viewerContainer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  viewer.updateScale({
    scaleFactor: Math.exp(-e.deltaY * 0.01),
    drawingDelay: 400,
    origin: [e.clientX, e.clientY],
  });
}, { passive: false });

// ============================================================
// Drawing + pick
// ============================================================
let drag = null; // active drag: { p, start, el }

function wireOverlay(p) {
  p.overlay.addEventListener('mousedown', (e) => {
    if (state.mode === 'draw') {
      const start = overlayPoint(p.overlay, e);
      const el = document.createElement('div');
      el.className = 'link-rect link-rect--pending';
      el.style.left = `${start.x}px`;
      el.style.top = `${start.y}px`;
      p.overlay.appendChild(el);
      drag = { p, start, el };
    } else if (state.mode === 'pick') {
      const pt = overlayPoint(p.overlay, e);
      const pdf = viewportPointToPdfPoint(p.viewport, pt);
      commitTarget({ type: 'internal', targetPage: p.index + 1, dest: { type: 'point', x: pdf.x, y: pdf.y } });
    }
  });
}

// The drag is tracked at module level, so we register just two window listeners
// instead of a pair per page (and nothing leaks when a new PDF is opened).
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const pt = overlayPoint(drag.p.overlay, e);
  Object.assign(drag.el.style, {
    left: `${Math.min(pt.x, drag.start.x)}px`,
    top: `${Math.min(pt.y, drag.start.y)}px`,
    width: `${Math.abs(pt.x - drag.start.x)}px`,
    height: `${Math.abs(pt.y - drag.start.y)}px`,
  });
});
window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const { p, start, el } = drag;
  drag = null;
  const pt = overlayPoint(p.overlay, e);
  el.remove();
  if (Math.abs(pt.x - start.x) < 5 || Math.abs(pt.y - start.y) < 5) return;
  state.pending = { srcPage: p.index + 1, rect: viewportRectToPdfRect(p.viewport, start, pt) };
  openCreateChooser();
});

function overlayPoint(overlay, e) {
  const r = overlay.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// click empty canvas to deselect / close the chooser
viewerContainer.addEventListener('click', (e) => {
  if (state.mode !== 'idle' || !targetPanel.hidden) return;
  if (!e.target.closest('.annot-link, .link-rect')) finishFlow();
});

// ============================================================
// Chooser (shared by "new link" and "edit selected link")
// ============================================================
addLinkBtn.addEventListener('click', () => {
  if (!state.pdf) return; // no link work until a PDF is loaded
  state.pending = null;
  state.selected = null;
  targetPanel.hidden = true;
  refresh();
  setMode('draw');
});
statusCancel.addEventListener('click', finishFlow);
cancelTargetBtn.addEventListener('click', finishFlow);
selDone.addEventListener('click', finishFlow);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!helpPanel.hidden) helpPanel.hidden = true;
  else if (state.mode !== 'idle' || !targetPanel.hidden) finishFlow();
});

function setMode(mode) {
  state.mode = mode;
  for (const p of pageRecs.values()) applyMode(p);
  addLinkBtn.classList.toggle('is-active', mode !== 'idle');
  if (mode === 'idle') {
    statusBar.hidden = true;
  } else {
    statusBar.hidden = false;
    statusText.textContent =
      mode === 'draw'
        ? 'Step 1 of 2: drag a box on the page'
        : 'Step 2 of 2: click where it should jump';
  }
}

// New link: after drawing a box.
function openCreateChooser() {
  state.selected = null;
  setMode('idle');
  refresh();

  chooserDot.hidden = false;
  chooserDot.className = 'dot dot--new';
  // The title is editable and seeded from the text under the box.
  chooserTitle.readOnly = false;
  chooserTitle.value = '';
  labelForRect(state.pending.srcPage, state.pending.rect).then((t) => {
    if (state.pending && !state.selected && !chooserTitle.value) chooserTitle.value = t;
  });
  chooserMeta.innerHTML = `Source page <strong>${state.pending.srcPage}</strong> <code class="mono dim">${rectText(state.pending.rect)}</code>`;
  targetPageInput.value = String(state.pending.srcPage);
  targetUrlInput.value = '';
  urlRow.hidden = true;
  chooserActions.hidden = true;
  cancelTargetBtn.hidden = false;
  targetPanel.hidden = false;
}

// Edit: a link on the page (new or existing) was selected.
function openEditChooser(kind, id) {
  const found = kind === 'new' ? store.get(id) : existingById(id);
  if (!found) return;
  const page = kind === 'new' ? found.srcPage : found.page;

  state.selected = { kind, id };
  setMode('idle');

  const url = currentExternalUrl();
  chooserDot.hidden = false;
  chooserDot.className = 'dot ' + (kind === 'new' ? 'dot--new' : 'dot--existing');
  // New links own an editable title; existing links show their text label.
  chooserTitle.readOnly = kind !== 'new';
  chooserTitle.value = kind === 'new'
    ? (found.title || '')
    : (found.label || `Link on page ${page}`);
  chooserMeta.innerHTML = `page ${page} <span class="arrow">→</span> ${selectedRouteText()}`;
  targetPageInput.value = String(selectedTargetPage() || page);
  targetUrlInput.value = url || '';
  urlRow.hidden = !url;
  selOpen.hidden = !url;
  updateChooserReset();
  chooserActions.hidden = false;
  cancelTargetBtn.hidden = true;
  targetPanel.hidden = false;
  refresh();
}

/** Display + nav helpers that read state.selected. */
function selectedRouteText() {
  const sel = state.selected;
  if (!sel) return '';
  if (sel.kind === 'new') { const l = store.get(sel.id); return l ? summarizeTarget(l.target) : ''; }
  const l = existingById(sel.id);
  return l ? existingTargetText(l) : '';
}
function selectedTargetPage() {
  const sel = state.selected;
  if (!sel) return null;
  if (sel.kind === 'new') { const l = store.get(sel.id); return l?.target.type === 'internal' ? l.target.targetPage : null; }
  const l = existingById(sel.id);
  return l ? effectiveTarget(l) : null;
}
function urlOf(kind, id) {
  if (kind === 'new') { const l = store.get(id); return l?.target.type === 'external' ? l.target.url : null; }
  const l = existingById(id);
  if (!l) return null;
  const edit = state.edits[l.id];
  if (edit?.target) return edit.target.type === 'external' ? edit.target.url : null;
  return l.kind === 'external' ? l.url || null : null;
}
function currentExternalUrl() {
  const sel = state.selected;
  return sel ? urlOf(sel.kind, sel.id) : null;
}

function selectLink(kind, id) {
  if (state.mode !== 'idle') return;
  openEditChooser(kind, id);
}

/** Where a link's clickable area sits: its source page and current rect. */
function linkSource(kind, id) {
  const l = kind === 'new' ? store.get(id) : existingById(id);
  if (!l) return null;
  return {
    page: kind === 'new' ? l.srcPage : l.page,
    rect: kind === 'new' ? l.rect : existingRect(l),
  };
}
function scrollToSource(kind, id) {
  const src = linkSource(kind, id);
  if (src) scrollToPage(src.page, { x: src.rect[0], y: src.rect[3] }); // rect top-left
}

/** Click a list row: select it for editing and scroll to where the link sits. */
function openItem(kind, id) {
  selectLink(kind, id);
  scrollToSource(kind, id);
}

// Double-click follows the link: scroll to its target, or open its URL.
function jumpToLink(kind, id) {
  const nav = navFor(kind, id);
  if (nav && nav.page) { scrollToPage(nav.page, nav.point); return; }
  const url = urlOf(kind, id);
  if (url) window.open(url, '_blank', 'noopener');
}

// ============================================================
// Resize / move a rectangle without visible handles.
//
// Hovering a rectangle briefly (ARM_DELAY) "arms" it. Once armed, the zone decides
// the action: corner = resize, edge = move, middle = click (jump). Arming via
// hover means you never have to click first (which would jump away).
// ============================================================
const ARM_DELAY = 300;
let armed = null; // { kind, id } currently armed for resize/move
let armTimer = null;
let rectDrag = null;
let ignoreClick = false;

function zoneAt(el, e) {
  const r = el.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  // corner band is a fraction of the short side, so thin rects keep a middle.
  const m = Math.max(4, Math.min(14, Math.min(r.width, r.height) * 0.28));
  const l = x <= m, rt = x >= r.width - m, t = y <= m, b = y >= r.height - m;
  if ((l || rt) && (t || b)) return { kind: 'corner', corner: (t ? 't' : 'b') + (l ? 'l' : 'r') };
  if (l || rt || t || b) return { kind: 'edge' };
  return { kind: 'inner' };
}
function zoneCursor(z) {
  if (z.kind === 'corner') return z.corner === 'tl' || z.corner === 'br' ? 'nwse-resize' : 'nesw-resize';
  if (z.kind === 'edge') return 'move';
  return 'pointer';
}

/**
 * Make a rectangle resizable/movable by hover, and clickable to select+jump.
 * @param el   rectangle element (positioned in overlay px)
 * @param p    page view (for px<->PDF conversion)
 * @param ctx  { kind, id, setRect(rect), select() }
 */
function wireRect(el, p, ctx) {
  // Armed = hovered briefly OR already selected (clicking it once arms it too,
  // so resize/move works immediately without another hover).
  const isArmed = () =>
    (armed && armed.kind === ctx.kind && armed.id === ctx.id) ||
    (state.selected && state.selected.kind === ctx.kind && state.selected.id === ctx.id);
  if (isArmed()) el.classList.add('is-armed'); // keep armed across re-renders

  el.addEventListener('mouseenter', () => {
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armed = { kind: ctx.kind, id: ctx.id };
      el.classList.add('is-armed');
    }, ARM_DELAY);
  });
  el.addEventListener('mouseleave', () => {
    clearTimeout(armTimer);
    if (!rectDrag && isArmed()) armed = null;
    el.classList.remove('is-armed');
    el.style.cursor = '';
  });
  el.addEventListener('mousemove', (e) => {
    if (rectDrag) return;
    el.style.cursor = isArmed() ? zoneCursor(zoneAt(el, e)) : 'pointer';
  });
  el.addEventListener('mousedown', (e) => {
    if (!isArmed()) return; // not armed yet -> the click will select/jump
    const z = zoneAt(el, e);
    if (z.kind === 'inner') return; // middle stays a click
    e.preventDefault();
    e.stopPropagation();
    rectDrag = {
      el, p, ctx, mode: z.kind === 'corner' ? 'resize' : 'move', corner: z.corner, moved: false,
      start: overlayPoint(p.overlay, e),
      box: {
        left: parseFloat(el.style.left), top: parseFloat(el.style.top),
        w: parseFloat(el.style.width), h: parseFloat(el.style.height),
      },
    };
  });
  // Single click opens the editor; double click follows the link. We wait one
  // click window so a re-render on select doesn't break double-click detection.
  let clickTimer = null;
  el.addEventListener('click', (e) => {
    if (ignoreClick) { ignoreClick = false; return; } // swallow the click after a drag
    e.stopPropagation();
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      jumpToLink(ctx.kind, ctx.id);
    } else {
      clickTimer = setTimeout(() => { clickTimer = null; ctx.select(); }, 250);
    }
  });
}

window.addEventListener('mousemove', (e) => {
  if (!rectDrag) return;
  const { el, p, mode, corner, start, box } = rectDrag;
  const pt = overlayPoint(p.overlay, e);
  const dx = pt.x - start.x, dy = pt.y - start.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) rectDrag.moved = true;

  if (mode === 'move') {
    el.style.left = `${box.left + dx}px`;
    el.style.top = `${box.top + dy}px`;
  } else {
    // The grabbed corner follows the cursor; the opposite corner stays fixed.
    const fixedX = corner.includes('l') ? box.left + box.w : box.left;
    const fixedY = corner.includes('t') ? box.top + box.h : box.top;
    el.style.left = `${Math.min(fixedX, pt.x)}px`;
    el.style.top = `${Math.min(fixedY, pt.y)}px`;
    el.style.width = `${Math.abs(pt.x - fixedX)}px`;
    el.style.height = `${Math.abs(pt.y - fixedY)}px`;
  }
});

window.addEventListener('mouseup', () => {
  if (!rectDrag) return;
  const { el, p, ctx, moved } = rectDrag;
  rectDrag = null;
  if (!moved) return; // a click, not a drag -> handled by the click -> select
  ignoreClick = true; // a drag is followed by a click; swallow it
  const left = parseFloat(el.style.left), top = parseFloat(el.style.top);
  const w = parseFloat(el.style.width), h = parseFloat(el.style.height);
  ctx.setRect(viewportRectToPdfRect(p.viewport, { x: left, y: top }, { x: left + w, y: top + h }));
});

function navFor(kind, id) {
  if (kind === 'new') {
    const l = store.get(id);
    return l ? targetNav(l.target) : null;
  }
  const l = existingById(id);
  if (!l) return null;
  if (l.kind === 'external' && !state.edits[l.id]?.target) return null;
  return existingLinkNav(l);
}

confirmTopBtn.addEventListener('click', () => {
  const page = parseInt(targetPageInput.value, 10);
  if (!validPage(page)) return;
  commitTarget({ type: 'internal', targetPage: page, dest: { type: 'page-top' } });
});
modePickBtn.addEventListener('click', () => setMode('pick'));
modeViewBtn.addEventListener('click', () => {
  const t = currentViewTarget();
  if (!t) return toast('Could not read the current view');
  commitTarget({ type: 'internal', targetPage: t.page, dest: { type: 'point', x: t.x, y: t.y } });
});
modeUrlBtn.addEventListener('click', () => {
  urlRow.hidden = false;
  targetUrlInput.focus();
});
confirmUrlBtn.addEventListener('click', commitUrl);
targetUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitUrl(); }
});

// Editing a selected new link's title (commit on blur/Enter, not per keystroke).
chooserTitle.addEventListener('change', () => {
  if (state.selected?.kind !== 'new') return;
  const l = store.get(state.selected.id);
  if (!l) return;
  l.title = chooserTitle.value.trim();
  pushHistory();
  refresh();
});
chooserTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); chooserTitle.blur(); }
});
function commitUrl() {
  let url = targetUrlInput.value.trim();
  if (!url) return toast('Enter a URL first');
  // Add a scheme if the user typed a bare domain.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  commitTarget({ type: 'external', url });
}

function validPage(page) {
  if (!page || page < 1 || page > state.numPages) {
    toast(`Target page must be 1 to ${state.numPages}`);
    return false;
  }
  return true;
}
function currentViewTarget() {
  const viewTop = viewerContainer.getBoundingClientRect().top + 4;
  const recs = [...pageRecs.values()].sort((a, b) => a.index - b.index);
  for (const p of recs) {
    if (!p.viewport) continue;
    const r = p.wrapper.getBoundingClientRect();
    if (r.bottom <= viewTop) continue;
    const cssY = Math.max(0, viewTop - r.top);
    const pdf = viewportPointToPdfPoint(p.viewport, { x: 0, y: cssY });
    return { page: p.index + 1, x: pdf.x, y: pdf.y };
  }
  return null;
}

function commitTarget(target) {
  if (state.selected) {
    const { kind, id } = state.selected;
    if (kind === 'new') store.update(id, target);
    else state.edits[id] = { ...state.edits[id], target };
    toast(`Updated: ${summarizeTarget(target)}`);
    pushHistory();
    // Re-point of an existing link keeps the panel open, so the Reset button
    // appears the moment a change exists.
    if (kind === 'existing') return openEditChooser(kind, id);
  } else if (state.pending) {
    const link = store.add(state.pending.srcPage, state.pending.rect, target);
    link.title = chooserTitle.value.trim();
    toast(`Link added: ${summarizeTarget(target)}`);
    pushHistory();
  } else {
    return;
  }
  finishFlow();
}

// selected-link actions. Clicking a link already jumps to its target, so the
// panel offers the reverse: scroll back to where the link sits.
selSource.addEventListener('click', () => {
  if (state.selected) scrollToSource(state.selected.kind, state.selected.id);
});
selOpen.addEventListener('click', () => {
  const url = currentExternalUrl();
  if (url) window.open(url, '_blank', 'noopener');
});
selReset.addEventListener('click', () => {
  const sel = state.selected;
  if (sel?.kind !== 'existing' || !state.edits[sel.id]) return;
  delete state.edits[sel.id]; // drop re-point, resize and delete in one go
  pushHistory();
  finishFlow();
  toast('Link reset to original');
});
selDelete.addEventListener('click', () => {
  const sel = state.selected;
  if (!sel) return;
  if (sel.kind === 'new') store.remove(sel.id);
  else state.edits[sel.id] = { ...state.edits[sel.id], deleted: true };
  pushHistory();
  finishFlow();
  toast('Link deleted');
});

function finishFlow() {
  state.pending = null;
  state.selected = null;
  targetPanel.hidden = true;
  setMode('idle');
  refresh();
}

// ============================================================
// Navigation
// ============================================================
/** Scroll so a destination lands near the top of the viewport (like /XYZ).
 * Delegated to the viewer, which resolves the page position and renders it. */
function scrollToPage(pageNo, point = null) {
  if (pageNo < 1 || pageNo > state.numPages) return;
  const destArray = point
    ? [null, { name: 'XYZ' }, point.x, point.y, null]
    : [null, { name: 'XYZ' }, null, null, null];
  viewer.scrollPageIntoView({ pageNumber: pageNo, destArray });
}
function targetNav(t) {
  if (!t || t.type !== 'internal') return { page: null };
  return { page: t.targetPage, point: t.dest.type === 'point' ? { x: t.dest.x, y: t.dest.y } : null };
}
function existingLinkNav(l) {
  const edit = state.edits[l.id];
  if (edit?.target) return targetNav(edit.target);
  return { page: l.targetPage, point: l.point || null };
}

// ============================================================
// Overlay decorations
// ============================================================
function redrawAll() { for (const p of pageRecs.values()) redrawOverlay(p); }
function redrawOverlay(p) {
  if (!p.viewport || !p.overlay.isConnected) return; // not on screen
  p.overlay.querySelectorAll('.link-rect, .dest-pin').forEach((el) => el.remove());
  const pageNo = p.index + 1;

  for (const link of store.forSourcePage(pageNo)) {
    const box = pdfRectToViewportBox(p.viewport, link.rect);
    const t = link.target;
    const tag = t.type === 'external'
      ? '↗ URL'
      : t.dest.type === 'page-top' ? `top of p.${t.targetPage}` : `p.${t.targetPage}`;
    const el = rectEl(box, tag, false);
    if (state.selected?.kind === 'new' && state.selected.id === link.id) el.classList.add('is-selected');
    wireRect(el, p, {
      kind: 'new', id: link.id,
      setRect: (rect) => { store.setRect(link.id, rect); pushHistory(); refresh(); },
      select: () => selectLink('new', link.id),
    });
    p.overlay.appendChild(el);
  }
  for (const link of store.forTargetPage(pageNo)) {
    const { x, y } = link.target.dest;
    const [vx, vy] = p.viewport.convertToViewportPoint(x, y);
    p.overlay.appendChild(pinEl(vx, vy, `from p.${link.srcPage}`));
  }
  if (state.pending && state.pending.srcPage === pageNo) {
    const box = pdfRectToViewportBox(p.viewport, state.pending.rect);
    p.overlay.appendChild(rectEl(box, 'choose target', true));
  }
}
function rectEl(box, tagText, pending) {
  const el = document.createElement('div');
  el.className = 'link-rect' + (pending ? ' link-rect--pending' : '');
  Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  const tag = document.createElement('span');
  tag.className = 'link-rect__tag';
  tag.textContent = tagText;
  el.appendChild(tag);
  return el;
}
function pinEl(x, y, tagText) {
  const el = document.createElement('div');
  el.className = 'dest-pin';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const tag = document.createElement('span');
  tag.className = 'dest-pin__tag';
  tag.textContent = tagText;
  el.appendChild(tag);
  return el;
}

// ============================================================
// Inspector lists
// ============================================================
function rectText(rect) {
  const [a, b, c, d] = rect.map((n) => Math.round(n));
  return `[${a}, ${b}, ${c}, ${d}]`;
}

function renderLists() {
  linkTotal.textContent = String(store.count);
  linkList.innerHTML = '';
  if (store.count === 0) {
    linkList.innerHTML = '<li class="empty">Nothing yet.</li>';
  } else {
    for (const link of store.all()) {
      linkList.appendChild(itemEl({
        kind: 'new', id: link.id, dotClass: 'dot--new',
        selected: state.selected?.kind === 'new' && state.selected.id === link.id,
        route: esc(link.title || `Link on page ${link.srcPage}`),
        sub: `page ${link.srcPage} <span class="arrow">→</span> ${summarizeTarget(link.target)}`,
        actions: [
          { label: 'Edit', onClick: () => selectLink('new', link.id) },
          { label: 'Delete', danger: true, onClick: () => { store.remove(link.id); if (state.selected?.id === link.id) finishFlow(); else refresh(); } },
        ],
      }));
    }
  }

  const ex = state.existingLinks;
  existingBlock.hidden = ex.length === 0;
  existingTotal.textContent = String(ex.length);
  existingList.innerHTML = '';
  for (const link of ex) {
    const edit = state.edits[link.id];
    const deleted = edit?.deleted;
    const actions = deleted
      ? [{ label: 'Undo', title: 'Restore this link', onClick: () => { undeleteExisting(link.id); pushHistory(); refresh(); } }]
      : [
          ...(edit?.rect ? [{ label: '↻', title: 'Revert to original size', onClick: () => { revertResize(link.id); pushHistory(); refresh(); } }] : []),
          { label: 'Edit', onClick: () => selectLink('existing', link.id) },
          { label: 'Delete', danger: true, onClick: () => { state.edits[link.id] = { ...state.edits[link.id], deleted: true }; pushHistory(); refresh(); } },
        ];
    existingList.appendChild(itemEl({
      kind: 'existing', id: link.id, dotClass: 'dot--existing', deleted,
      selected: state.selected?.kind === 'existing' && state.selected.id === link.id,
      route: esc(link.label || `Link on page ${link.page}`),
      sub: `<span class="arrow">→</span> ${existingTargetText(link)}`,
      actions,
    }));
  }
}

/** Remove the delete flag, dropping the edit entirely if nothing else remains. */
function undeleteExisting(id) {
  const e = state.edits[id];
  if (!e) return;
  delete e.deleted;
  if (!e.target && !e.rect) delete state.edits[id];
}
/** Drop a resize edit, restoring the link's original rectangle. */
function revertResize(id) {
  const e = state.edits[id];
  if (!e) return;
  delete e.rect;
  if (!e.target && !e.deleted) delete state.edits[id];
}

function existingTargetText(link) {
  const edit = state.edits[link.id];
  if (edit?.deleted) return 'removed';
  if (edit?.target) return `${summarizeTarget(edit.target)} (edited)`;
  if (link.kind === 'external') return truncate(link.url || 'external link', 28);
  if (link.kind === 'internal') return link.targetPage ? `page ${link.targetPage}` : 'internal link';
  return 'link';
}
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function itemEl({ kind, id, dotClass, route, sub, actions, deleted, selected }) {
  const li = document.createElement('li');
  li.className = 'item' + (kind === 'existing' ? ' item--existing' : '') +
    (deleted ? ' is-deleted' : '') + (selected ? ' is-selected' : '');

  const main = document.createElement('div');
  main.className = 'item__main';
  main.innerHTML =
    `<span class="item__route"><span class="dot ${dotClass}"></span>${route}</span>` +
    `<span class="item__sub">${sub}</span>`;
  main.addEventListener('click', () => openItem(kind, id));

  const acts = document.createElement('div');
  acts.className = 'item__actions';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'iconbtn' + (a.danger ? ' iconbtn--danger' : '');
    b.textContent = a.label;
    if (a.title) b.title = a.title;
    b.addEventListener('click', (e) => { e.stopPropagation(); a.onClick(); });
    acts.appendChild(b);
  }
  li.append(main, acts);
  return li;
}

/** Re-render on-screen overlays, annotation layers, and the inspector lists. */
function refresh() {
  redrawAll();
  rebuildAnnotLayers();
  renderLists();
  updateChooserReset();
}

// Show Reset whenever the selected existing link has unsaved edits, so it
// appears the instant a change is made (re-point, resize, delete) rather than
// only when the panel is re-opened.
function updateChooserReset() {
  const sel = state.selected;
  selReset.hidden = !(sel?.kind === 'existing' && !!state.edits[sel.id]);
}

// ============================================================
// Help + toast + export
// ============================================================
helpBtn.addEventListener('click', () => (helpPanel.hidden = false));
helpClose.addEventListener('click', () => (helpPanel.hidden = true));
helpPanel.addEventListener('click', (e) => { if (e.target === helpPanel) helpPanel.hidden = true; });

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
}

exportBtn.addEventListener('click', async () => {
  const hasEdits = Object.values(state.edits).some((e) => e.deleted || e.target || e.rect);
  if (store.count === 0 && !hasEdits) return toast('Add or edit a link first');
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';
  try {
    const bytes = await buildPdf(state.rawBytes, { newLinks: store.all(), edits: state.edits });
    downloadBlob(bytesToPdfBlob(bytes), suggestName(state.fileName));
    toast('Exported PDF');
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + err.message);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = 'Export';
  }
});
function suggestName(name) { return name.replace(/\.pdf$/i, '') + '-linked.pdf'; }
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

renderLists();

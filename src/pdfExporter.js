/**
 * PDF reading + writing with pdf-lib.
 *
 *  - readExistingLinks(): parse the original PDF's existing Link annotations so
 *    the UI can show, re-point, or delete them.
 *  - buildPdf(): write a new PDF that (a) edits/deletes existing links and
 *    (b) appends newly drawn internal links — WITHOUT rasterizing the pages.
 *
 * We never touch page content streams, so the visual appearance is preserved;
 * we only register/modify/remove annotation objects.
 */
import {
  PDFDocument,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFArray,
  PDFDict,
  PDFRef,
  PDFString,
  PDFHexString,
} from 'pdf-lib';

const N = (s) => PDFName.of(s);
const refKey = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

/**
 * @typedef {Object} LinkTarget   where a link points
 * @property {'internal'|'external'} type
 * @property {number} [targetPage]  for internal
 * @property {{type:'page-top'|'point', x?:number, y?:number}} [dest]  for internal
 * @property {string} [url]  for external
 *
 * @typedef {Object} NewLink
 * @property {number} srcPage
 * @property {[number,number,number,number]} rect
 * @property {LinkTarget} target
 * @property {string} [title]  optional label, written as the annotation tooltip
 *
 * @typedef {Object} ExistingLink
 * @property {string} id           stable id "ex:<pageIndex>:<linkIndex>"
 * @property {number} page         1-based source page
 * @property {[number,number,number,number]} rect
 * @property {'internal'|'external'|'other'} kind
 * @property {number|null} [targetPage]  resolved page for internal links
 * @property {{x:number,y:number}|null} [point]  XYZ destination point, if any
 * @property {string} [url]              for external links
 *
 * @typedef {Object} Edit         keyed by ExistingLink.id (fields compose)
 * @property {boolean} [deleted]   remove the annotation
 * @property {LinkTarget} [target] re-point it
 * @property {[number,number,number,number]} [rect]  resize/move it
 */

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

/**
 * Enumerate existing Link annotations in document order. The id encodes the
 * page index and the link's position among links on that page, so the exact
 * same enumeration during buildPdf() can re-find each annotation.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<ExistingLink[]>}
 */
export async function readExistingLinks(bytes) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  const refToIndex = new Map();
  pages.forEach((p, i) => refToIndex.set(refKey(p.ref), i));

  const out = [];
  pages.forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) return;
    let li = 0;
    for (let i = 0; i < annots.size(); i++) {
      const a = pdf.context.lookup(annots.get(i));
      if (!(a instanceof PDFDict)) continue;
      if (a.get(N('Subtype'))?.toString() !== '/Link') continue;

      const rect = readRect(a);
      if (!rect) continue;
      const target = readTarget(a, pdf, refToIndex);
      out.push({ id: `ex:${pi}:${li}`, page: pi + 1, rect, ...target });
      li++;
    }
  });
  return out;
}

function readRect(a) {
  const arr = a.get(N('Rect'));
  if (!(arr instanceof PDFArray) || arr.size() < 4) return null;
  const v = [0, 1, 2, 3].map((i) => arr.get(i).asNumber());
  return [
    Math.min(v[0], v[2]),
    Math.min(v[1], v[3]),
    Math.max(v[0], v[2]),
    Math.max(v[1], v[3]),
  ];
}

function readTarget(a, pdf, refToIndex) {
  const action = a.get(N('A'));
  if (action instanceof PDFRef || action instanceof PDFDict) {
    const A = action instanceof PDFRef ? pdf.context.lookup(action) : action;
    const s = A?.get(N('S'))?.toString();
    if (s === '/URI') {
      return { kind: 'external', url: readString(A.get(N('URI'))) };
    }
    if (s === '/GoTo') {
      return internalFromDest(A.get(N('D')), pdf, refToIndex);
    }
    return { kind: 'other' };
  }
  const dest = a.get(N('Dest'));
  if (dest) return internalFromDest(dest, pdf, refToIndex);
  return { kind: 'other' };
}

function internalFromDest(dest, pdf, refToIndex) {
  if (!dest) return { kind: 'other' };

  // /Dest (or /A /D) is often an INDIRECT reference to the destination object.
  // Dereference it before inspecting.
  if (dest instanceof PDFRef) dest = pdf.context.lookup(dest);
  if (!dest) return { kind: 'other' };

  // A destination may also be a dictionary that wraps the array under /D.
  if (dest instanceof PDFDict) {
    const d = dest.get(N('D'));
    if (d) return internalFromDest(d, pdf, refToIndex);
  }

  // Named destination: try the catalog's /Dests dictionary. If that fails we
  // return the name so the caller can resolve it with PDF.js (which also reads
  // the /Names destination tree that Word-exported PDFs typically use).
  if (dest instanceof PDFName || dest instanceof PDFString || dest instanceof PDFHexString) {
    const name = dest instanceof PDFName ? dest.asString().replace(/^\//, '') : readString(dest);
    const resolved = resolveNamedDest(pdf, name);
    if (resolved) return internalFromDest(resolved, pdf, refToIndex);
    return { kind: 'internal', targetPage: null, name }; // resolve later via PDF.js
  }

  if (dest instanceof PDFArray) {
    const first = dest.get(0);
    if (first instanceof PDFRef) {
      const idx = refToIndex.get(refKey(first));
      return {
        kind: 'internal',
        targetPage: idx == null ? null : idx + 1,
        point: readXyzPoint(dest),
      };
    }
  }
  return { kind: 'internal', targetPage: null };
}

/**
 * Pull the (left, top) point out of an explicit destination array
 * [ page, /XYZ, left, top, zoom ]. Returns null for non-XYZ fits (e.g. /Fit)
 * or when top is null (meaning "retain current"), in which case the caller
 * should fall back to the page top.
 */
function readXyzPoint(dest) {
  if (dest.get(1)?.toString() !== '/XYZ') return null;
  const top = dest.get(3);
  if (!(top instanceof PDFNumber)) return null;
  const left = dest.get(2);
  return { x: left instanceof PDFNumber ? left.asNumber() : 0, y: top.asNumber() };
}

function resolveNamedDest(pdf, name) {
  try {
    const dests = pdf.catalog.lookup(N('Dests'), PDFDict);
    const entry = dests?.get(N(name));
    if (!entry) return null;
    const d = entry instanceof PDFRef ? pdf.context.lookup(entry) : entry;
    // /Dests entries may be the dest array directly or a dict with /D.
    if (d instanceof PDFArray) return d;
    if (d instanceof PDFDict) return d.get(N('D'));
  } catch {
    /* best-effort only */
  }
  return null;
}

function readString(obj) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return '';
}

// ---------------------------------------------------------------------------
// WRITE
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} originalBytes
 * @param {Object} opts
 * @param {NewLink[]} [opts.newLinks]
 * @param {Record<string, Edit>} [opts.edits]   keyed by ExistingLink.id
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf(originalBytes, { newLinks = [], edits = {} } = {}) {
  const pdf = await PDFDocument.load(originalBytes, { updateMetadata: false });
  const pages = pdf.getPages();
  const ctx = pdf.context;

  // ---- 1. Apply edits to existing links (re-enumerate identically) --------
  pages.forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) return;

    const removeKeys = new Set();
    let li = 0;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const a = pdf.context.lookup(ref);
      if (!(a instanceof PDFDict) || a.get(N('Subtype'))?.toString() !== '/Link') continue;

      const edit = edits[`ex:${pi}:${li}`];
      li++;
      if (!edit) continue;

      if (edit.deleted) {
        if (ref instanceof PDFRef) removeKeys.add(refKey(ref));
        continue;
      }
      if (edit.rect) a.set(N('Rect'), ctx.obj(edit.rect)); // resize / move
      if (edit.target) setLinkAction(ctx, a, pages, edit.target); // re-point
    }

    if (removeKeys.size) {
      const kept = [];
      for (let i = 0; i < annots.size(); i++) {
        const r = annots.get(i);
        if (r instanceof PDFRef && removeKeys.has(refKey(r))) continue;
        kept.push(r);
      }
      page.node.set(N('Annots'), ctx.obj(kept));
    }
  });

  // ---- 2. Append newly drawn internal links -------------------------------
  for (const link of newLinks) {
    const srcPage = pages[link.srcPage - 1];
    if (!srcPage) continue;

    const annotation = ctx.obj({
      Type: N('Annot'),
      Subtype: N('Link'),
      Rect: link.rect,
      Border: [0, 0, 0], // transparent clickable area
    });
    // The title doubles as the annotation's tooltip. Hex (UTF-16BE) keeps
    // non-ASCII titles intact.
    if (link.title) annotation.set(N('Contents'), PDFHexString.fromText(link.title));
    setLinkAction(ctx, annotation, pages, link.target);
    const ref = ctx.register(annotation);

    const existing = srcPage.node.Annots();
    if (existing instanceof PDFArray) existing.push(ref);
    else srcPage.node.set(N('Annots'), ctx.obj([ref]));
  }

  return pdf.save();
}

/**
 * Set (or replace) an annotation's action from a LinkTarget.
 *
 * External: a /URI action.
 * Internal: a /GoTo with destination [ targetPageRef, /XYZ, left, top, zoom ].
 *  - 'page-top': left = null (retain x), top = page height -> top of page.
 *  - 'point':    left = x, top = y -> the exact spot the user chose.
 *  - zoom is always null so the viewer keeps the current zoom.
 */
function setLinkAction(ctx, annot, pages, target) {
  if (!target) return;

  if (target.type === 'external') {
    const action = ctx.obj({ Type: N('Action'), S: N('URI'), URI: PDFString.of(target.url) });
    annot.set(N('A'), action);
    annot.delete(N('Dest'));
    return;
  }

  const page = pages[target.targetPage - 1];
  if (!page) return;
  const { height } = page.getSize();
  const dest = target.dest;
  const left = dest?.type === 'point' ? dest.x : PDFNull;
  const top = dest?.type === 'point' ? dest.y : height;

  const destination = ctx.obj([page.ref, N('XYZ'), left, top, PDFNull]);
  const action = ctx.obj({ Type: N('Action'), S: N('GoTo'), D: destination });

  annot.set(N('A'), action);
  annot.delete(N('Dest')); // avoid a stale /Dest competing with /A
}

export function bytesToPdfBlob(bytes) {
  return new Blob([bytes], { type: 'application/pdf' });
}

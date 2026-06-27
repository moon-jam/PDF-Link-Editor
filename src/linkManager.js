/**
 * In-memory store for the links the user is building before export.
 * Rects and destination points are stored in PDF points, so they are
 * independent of the current zoom.
 */
let nextId = 1;

/**
 * @typedef {Object} LinkTarget
 * Where a link points. Either an internal page destination or an external URL.
 * @property {'internal'|'external'} type
 * @property {number} [targetPage]  1-based, for internal
 * @property {{type:'page-top'|'point', x?:number, y?:number}} [dest]  for internal
 * @property {string} [url]  for external
 *
 * @typedef {Object} Link
 * @property {number} id
 * @property {number} srcPage      1-based source page.
 * @property {[number,number,number,number]} rect  PDF-space [x1,y1,x2,y2].
 * @property {LinkTarget} target
 */

export class LinkStore {
  constructor() {
    /** @type {Link[]} */
    this.links = [];
  }

  clear() {
    this.links = [];
  }

  add(srcPage, rect, target) {
    const link = { id: nextId++, srcPage, rect, target };
    this.links.push(link);
    return link;
  }

  remove(id) {
    this.links = this.links.filter((l) => l.id !== id);
  }

  update(id, target) {
    const l = this.links.find((x) => x.id === id);
    if (l) l.target = target;
    return l;
  }

  setRect(id, rect) {
    const l = this.links.find((x) => x.id === id);
    if (l) l.rect = rect;
    return l;
  }

  get(id) {
    return this.links.find((x) => x.id === id);
  }

  /** Links whose source rectangle is on the given page. */
  forSourcePage(pageNumber) {
    return this.links.filter((l) => l.srcPage === pageNumber);
  }

  /** Links that land on a specific point of the given page (used to draw pins). */
  forTargetPage(pageNumber) {
    return this.links.filter(
      (l) =>
        l.target.type === 'internal' &&
        l.target.dest.type === 'point' &&
        l.target.targetPage === pageNumber
    );
  }

  all() {
    return this.links;
  }

  get count() {
    return this.links.length;
  }
}

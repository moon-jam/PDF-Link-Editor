import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb, PDFName, PDFNull } from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = (name) => resolve(__dirname, '../test-results', name);

// A small multi-page sample: page 1 is a table of contents, pages 2-5 are
// content. "3. Results" carries an internal link pointing at the WRONG page
// (page 2 instead of 4), so the tests can exercise re-pointing an existing link.
let sampleBytes;
test.beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const SIZE = [612, 792];

  const toc = doc.addPage(SIZE);
  toc.drawText('Table of Contents', { x: 60, y: 720, size: 26, font: bold });
  const entries = [
    ['1. Introduction', 'page 2'],
    ['2. Methodology', 'page 3'],
    ['3. Results', 'page 4'],
    ['4. Conclusion', 'page 5'],
  ];
  entries.forEach(([label, page], i) => {
    const y = 650 - i * 44;
    toc.drawText(label, { x: 70, y, size: 16, font });
    toc.drawText(page, { x: 460, y, size: 16, font, color: rgb(0.4, 0.4, 0.4) });
  });

  const pages = ['1. Introduction', '2. Methodology', '3. Results', '4. Conclusion'].map((title) => {
    const p = doc.addPage(SIZE);
    p.drawText(title, { x: 60, y: 720, size: 24, font: bold });
    return p;
  });

  const resultsRowY = 650 - 2 * 44; // the "3. Results" row
  const link = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [66, resultsRowY - 6, 320, resultsRowY + 18],
    Border: [0, 0, 0],
    A: doc.context.obj({
      Type: PDFName.of('Action'),
      S: PDFName.of('GoTo'),
      D: doc.context.obj([pages[0].ref, PDFName.of('XYZ'), 0, 792, PDFNull]), // page 2
    }),
  });
  toc.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));

  sampleBytes = Buffer.from(await doc.save());
});

async function drawRect(page, pageNo, from, to) {
  await page.locator(`.page[data-page-number="${pageNo}"]`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  const box = await page.locator(`.page[data-page-number="${pageNo}"] .overlay`).boundingBox();
  const x1 = box.x + box.width * from[0];
  const y1 = box.y + box.height * from[1];
  const x2 = box.x + box.width * to[0];
  const y2 = box.y + box.height * to[1];
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 6 });
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();
}

async function loadSample(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', {
    name: 'sample.pdf', mimeType: 'application/pdf', buffer: sampleBytes,
  });
  await page.waitForSelector('.page[data-page-number="1"] .overlay');
}

// Suppress the first-visit intro modal so it doesn't sit over the UI in tests.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('intro-dismissed', '1'); } catch { /* ignore */ }
  });
});

test('fix an existing link, add a new one, export', async ({ page }) => {
  await loadSample(page);

  // The sample has a link on "3. Results" pointing to the WRONG page (2).
  await expect(page.locator('#existing-total')).toHaveText('1');
  await expect(page.locator('#existing-list')).toContainText('page 2');

  // Click it (jumps + opens editor), then re-point to the correct page 4.
  await page.click('.page[data-page-number="1"] .annot-link');
  await page.fill('#target-page', '4');
  await page.click('#confirm-top');
  await expect(page.locator('#existing-list')).toContainText('page 4 (edited)');

  // Add a new link over "1. Introduction" -> top of page 2.
  await page.click('#add-link');
  await drawRect(page, 1, [0.11, 0.16], [0.48, 0.205]);
  await page.fill('#target-page', '2');
  await page.click('#confirm-top');
  await expect(page.locator('#link-total')).toHaveText('1');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-btn'),
  ]);
  const outPath = OUT('exported.pdf');
  await download.saveAs(outPath);

  // page 1 should have two Link annotations: the fixed existing one (page 4)
  // and the new one (page 2).
  const pdf = await PDFDocument.load(readFileSync(outPath));
  const pages = pdf.getPages();
  const p4 = pages[3].ref.toString();
  const p2 = pages[1].ref.toString();
  const annots = pages[0].node.Annots();
  expect(annots.size()).toBe(2);

  const dests = [];
  for (let i = 0; i < annots.size(); i++) {
    const a = pdf.context.lookup(annots.get(i));
    expect(a.get(PDFName.of('Subtype')).toString()).toBe('/Link');
    const action = pdf.context.lookup(a.get(PDFName.of('A')));
    expect(action.get(PDFName.of('S')).toString()).toBe('/GoTo');
    dests.push(action.get(PDFName.of('D')).get(0).toString());
  }
  expect(dests).toContain(p4);
  expect(dests).toContain(p2);
});

test('opening another PDF resets new links', async ({ page }) => {
  await loadSample(page);
  await page.click('#add-link');
  await drawRect(page, 1, [0.11, 0.16], [0.48, 0.205]);
  await page.fill('#target-page', '2');
  await page.click('#confirm-top');
  await expect(page.locator('#link-total')).toHaveText('1');

  // Open a different PDF: the previous file's new links must not carry over.
  const other = await PDFDocument.create();
  other.addPage([612, 792]);
  await page.setInputFiles('#file-input', {
    name: 'other.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await other.save()),
  });
  await page.waitForSelector('.page[data-page-number="1"] .overlay');
  await expect(page.locator('#link-total')).toHaveText('0');
});

test('undo and redo a new link', async ({ page }) => {
  await loadSample(page);
  await page.click('#add-link');
  await drawRect(page, 1, [0.11, 0.16], [0.48, 0.205]);
  await page.fill('#target-page', '2');
  await page.click('#confirm-top');
  await expect(page.locator('#link-total')).toHaveText('1');

  await page.click('#undo-btn');
  await expect(page.locator('#link-total')).toHaveText('0');
  await page.click('#redo-btn');
  await expect(page.locator('#link-total')).toHaveText('1');
});

test('undo scrolls back to where the change was made', async ({ page }) => {
  await loadSample(page);

  // Add a link on page 3, then scroll back to the top (page 1).
  await page.click('#add-link');
  await drawRect(page, 3, [0.11, 0.16], [0.48, 0.205]);
  await page.fill('#target-page', '1');
  await page.click('#confirm-top');
  await page.locator('.page[data-page-number="1"]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  await expect(page.locator('.page[data-page-number="3"]')).not.toBeInViewport();

  // Undo should jump back to page 3, where the edit happened.
  await page.click('#undo-btn');
  await expect(page.locator('.page[data-page-number="3"]')).toBeInViewport();
});

test('a new link carries a custom title into the PDF', async ({ page }) => {
  await loadSample(page);

  await page.click('#add-link');
  await drawRect(page, 1, [0.11, 0.16], [0.48, 0.205]);
  await expect(page.locator('#chooser-title')).toBeVisible();
  await page.fill('#chooser-title', 'Go to chapter two');
  await page.fill('#target-page', '2');
  await page.click('#confirm-top');

  // The title shows as the row's key in the New links list.
  await expect(page.locator('#link-list')).toContainText('Go to chapter two');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-btn'),
  ]);
  const out = OUT('titled-export.pdf');
  await download.saveAs(out);

  const pdf = await PDFDocument.load(readFileSync(out));
  const annots = pdf.getPages()[0].node.Annots();
  const a = pdf.context.lookup(annots.get(annots.size() - 1));
  expect(a.get(PDFName.of('Contents')).decodeText()).toBe('Go to chapter two');
});

test('create an external URL link', async ({ page }) => {
  await loadSample(page);

  await page.click('#add-link');
  await drawRect(page, 1, [0.11, 0.26], [0.45, 0.3]);
  await page.click('#mode-url');
  await page.fill('#target-url', 'example.com/docs'); // no scheme on purpose
  await page.click('#confirm-url');
  await expect(page.locator('#link-total')).toHaveText('1');
  await expect(page.locator('#link-list')).toContainText('https://example.com/docs');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-btn'),
  ]);
  const out = OUT('external-export.pdf');
  await download.saveAs(out);

  const pdf = await PDFDocument.load(readFileSync(out));
  const annots = pdf.getPages()[0].node.Annots();
  const a = pdf.context.lookup(annots.get(annots.size() - 1));
  const action = pdf.context.lookup(a.get(PDFName.of('A')));
  expect(action.get(PDFName.of('S')).toString()).toBe('/URI');
  expect(action.get(PDFName.of('URI')).toString()).toContain('https://example.com/docs');
});

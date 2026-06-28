import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFNull, StandardFonts } from 'pdf-lib';
import { readExistingLinks } from '../src/pdfExporter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'with-links.pdf');
const OUT = (n) => resolve(__dirname, '../test-results', n);

// Build a 4-page PDF that already contains one internal link (p1 -> p2).
test.beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [];
  for (let i = 0; i < 4; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${i + 1}`, { x: 50, y: 740, size: 24, font });
    pages.push(p);
  }
  const annot = doc.context.obj({
    Type: PDFName.of('Annot'), Subtype: PDFName.of('Link'),
    Rect: [50, 690, 320, 715], Border: [0, 0, 0],
    A: doc.context.obj({
      Type: PDFName.of('Action'), S: PDFName.of('GoTo'),
      D: doc.context.obj([pages[1].ref, PDFName.of('XYZ'), 0, 792, 0]),
    }),
  });
  pages[0].node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
  writeFileSync(FIXTURE, await doc.save());
});

// Suppress the first-visit intro modal so it doesn't sit over the UI in tests.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('intro-dismissed', '1'); } catch { /* ignore */ }
  });
});

// Regression: some PDFs store /Dest as an indirect reference to the dest array
// (e.g. "/Dest 61 0 R"). The reader must dereference it, not give up.
test('resolves a /Dest given as an indirect reference', async () => {
  const doc = await PDFDocument.create();
  const pages = [];
  for (let i = 0; i < 3; i++) pages.push(doc.addPage([612, 792]));
  const destArray = doc.context.obj([pages[1].ref, PDFName.of('XYZ'), 50, 400, PDFNull]);
  const destRef = doc.context.register(destArray); // store the dest as its own object
  const annot = doc.context.obj({
    Type: PDFName.of('Annot'), Subtype: PDFName.of('Link'),
    Rect: [50, 690, 320, 715], Border: [0, 0, 0],
    Dest: destRef,
  });
  pages[0].node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));

  const links = await readExistingLinks(await doc.save());
  expect(links).toHaveLength(1);
  expect(links[0].targetPage).toBe(2);
  expect(links[0].point).toEqual({ x: 50, y: 400 });
});

test('read, re-point and delete an existing link', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('.page[data-page-number="1"] .overlay');

  // The existing link is detected and shown (p1 -> page 2).
  await expect(page.locator('#existing-block')).toBeVisible();
  await expect(page.locator('#existing-total')).toHaveText('1');
  await expect(page.locator('#existing-list')).toContainText('page 2');

  // Re-point it to the top of page 4 (Edit opens the one-row chooser).
  await page.locator('#existing-list .iconbtn', { hasText: 'Edit' }).click();
  await expect(page.locator('#chooser-dot')).toHaveClass(/dot--existing/);
  await page.fill('#target-page', '4');
  await page.click('#confirm-top');
  await expect(page.locator('#existing-list')).toContainText('page 4 (edited)');

  // Export and confirm the annotation now targets page 4 (index 3).
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-btn'),
  ]);
  const out = OUT('existing-export.pdf');
  await dl.saveAs(out);

  const pdf = await PDFDocument.load(readFileSync(out));
  const p4ref = pdf.getPages()[3].ref;
  const annots = pdf.getPages()[0].node.Annots();
  const a = pdf.context.lookup(annots.get(0));
  const action = pdf.context.lookup(a.get(PDFName.of('A')));
  const dest = action.get(PDFName.of('D'));
  expect(dest.get(0).toString()).toBe(p4ref.toString());

  // Now delete it and confirm export removes the annotation.
  await page.locator('#existing-list .iconbtn', { hasText: 'Delete' }).click();
  await expect(page.locator('#existing-list')).toContainText('removed');
  const [dl2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-btn'),
  ]);
  const out2 = OUT('existing-deleted.pdf');
  await dl2.saveAs(out2);
  const pdf2 = await PDFDocument.load(readFileSync(out2));
  const annots2 = pdf2.getPages()[0].node.Annots();
  expect(annots2 == null || annots2.size() === 0).toBeTruthy();
});

test('reset reverts an edited existing link to its original target', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('.page[data-page-number="1"] .overlay');

  // Reset is hidden until there is an edit.
  await page.locator('#existing-list .iconbtn', { hasText: 'Edit' }).click();
  await expect(page.locator('#sel-reset')).toBeHidden();

  // Re-point to page 4: the panel stays open and Reset appears immediately.
  await page.fill('#target-page', '4');
  await page.click('#confirm-top');
  await expect(page.locator('#existing-list')).toContainText('page 4 (edited)');
  await expect(page.locator('#sel-reset')).toBeVisible();

  await page.click('#sel-reset');

  // Back to the original target, with no "edited" marker.
  await expect(page.locator('#existing-list')).toContainText('page 2');
  await expect(page.locator('#existing-list')).not.toContainText('edited');
});

test('"Back to source" scrolls to where the selected link sits', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('.page[data-page-number="1"] .overlay');

  // Select the existing link (it sits on page 1), then scroll away to page 4.
  await page.locator('#existing-list .iconbtn', { hasText: 'Edit' }).click();
  await page.locator('.page[data-page-number="4"]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  await expect(page.locator('.page[data-page-number="1"]')).not.toBeInViewport();

  await page.click('#sel-source');
  await expect(page.locator('.page[data-page-number="1"]')).toBeInViewport();
});

test('resize an existing link updates its /Rect', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('.page[data-page-number="1"] .overlay');

  // Hover the link to "arm" it (no click needed, so no jump), then drag the
  // bottom-right corner outward to resize.
  await page.locator('.page[data-page-number="1"]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  const box = await page.locator('.page[data-page-number="1"] .annot-link').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(650); // wait past the 0.5s arm delay
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 45, box.y + box.height + 30, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#existing-list')).toContainText('↻');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  const out = OUT('resize-export.pdf');
  await dl.saveAs(out);
  const pdf = await PDFDocument.load(readFileSync(out));
  const a = pdf.context.lookup(pdf.getPages()[0].node.Annots().get(0));
  const rect = a.get(PDFName.of('Rect')).asArray().map((n) => n.asNumber());
  // original was [50, 690, 320, 715]; dragging out grows width and lowers the
  // bottom edge (smaller y2 in PDF space).
  expect(rect[2]).toBeGreaterThan(320);
  expect(rect[1]).toBeLessThan(690);
});

/**
 * Loads a PDF with PDF.js (for previewing) and configures the worker.
 * The PDFViewer in main.js does the actual page rendering; here we only open
 * the document. The PDF is never modified here (that is pdf-lib in exporter.js).
 */
import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves this to a hashed URL for the worker bundle.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Load a PDF for previewing.
 * @param {Uint8Array} bytes - raw PDF bytes (kept separately for pdf-lib).
 * @returns {Promise<pdfjsLib.PDFDocumentProxy>}
 */
export async function loadPdf(bytes) {
  // IMPORTANT: pass a *copy* to PDF.js. PDF.js transfers/neuters the buffer it
  // receives, which would corrupt the bytes we still need for pdf-lib export.
  const copy = bytes.slice(0);
  const task = pdfjsLib.getDocument({ data: copy });
  return task.promise;
}

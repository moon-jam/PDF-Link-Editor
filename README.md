# PDF Link Editor

A fully client-side web app for fixing and adding internal "jump to page"
hyperlinks in a PDF. Open a PDF, draw clickable areas, point them at any page,
and export a new PDF with `/GoTo` link annotations. You can also re-point or
delete links that are already in the file.

The PDF never leaves your browser. There is no backend and no upload: the file
is read, edited, and re-saved entirely on your device. (The app and its
libraries load like any static website, but your PDF is never sent anywhere.)
Original page content, fonts, and images are preserved exactly. The tool only
adds, edits, or removes annotation objects. It never rasterizes or rebuilds the
pages.

Typical use case: a Word-exported PDF whose table-of-contents links are broken,
where you want to visually re-point clickable areas to the right pages.

## Features

- Open a PDF by click or drag and drop. Everything runs locally.
- Continuous vertical scroll of all pages, with zoom (buttons or trackpad pinch,
  which is Ctrl or Cmd plus wheel).
- Draw a clickable box, then choose where it points. Four modes in a 2x2 grid:
  - Top of a page (enter a page number).
  - A clicked position on any page.
  - The current view (scroll a page into place, then capture it).
  - An external URL (a `/URI` link).
- Single-click a link (new or existing) to edit it; the chooser opens on the
  right to re-point or delete it. Double-click to follow it (jump to the target
  page, or open the URL).
- Reshape a rectangle without handles: hover it briefly to arm, then the cursor
  decides the action (corner = resize, edge = move, middle = click). Works for
  new and existing links; existing ones get their `/Rect` updated on export.
- The PDF's existing links are read back, including named destinations from the
  /Names tree (typical of Word exports), resolved through PDF.js.
- A list of every new link and every existing link, with delete and undo.
- Light and dark themes (Catppuccin Latte and Mocha). Defaults to the system
  setting, with a toggle that is remembered.
- Export the modified PDF as a download.

## Project structure

```
pdf-link-editor/
├── index.html              # UI shell (app bar, canvas, inspector, help modal)
├── package.json
├── vite.config.js
├── playwright.config.js     # drives the app in a headless browser for tests
├── tests/
│   ├── demo.spec.js          # add-link + external-URL flow, with export checks
│   └── existing-links.spec.js# read, re-point, delete, resize existing links
└── src/
    ├── main.js               # orchestration: viewer wiring, drawing, editing, export
    ├── pdfRenderer.js        # PDF.js: open the document + configure the worker
    ├── coords.js             # browser to PDF coordinate conversion
    ├── pdfExporter.js        # pdf-lib: read existing links, write new PDF
    ├── linkManager.js        # in-memory store of new links
    └── style.css             # editor design system (light + dark)
```

Rendering, scrolling, virtualization, and zoom are handled by PDF.js's official
`PDFViewer` (the component that powers Firefox's PDF viewer). The editing layer
(draw, select, resize, existing-link rectangles) is our own overlay attached to
each viewer page on render. pdf-lib is used only to read and write annotations.
PDF.js and pdf-lib share nothing but the raw bytes.

## Install and run

```bash
npm install
npm run dev      # start the dev server
# or
npm run build && npm run preview
```

Requires Node 18 or newer.

## How to use

1. Open a PDF and scroll to browse pages.
2. Click **Add link**, then drag a box on the source page.
3. Choose where it points: the top of a page, a clicked position, the current
   view, or an external URL.
4. To fix links already in the file, use the **Existing links** panel on the
   right to re-point or delete them.
5. Click **Export** to download `<name>-linked.pdf`.

## How annotation writing works (`pdfExporter.js`)

The output PDF is built by loading the original bytes with pdf-lib and only
touching annotation objects, so the visual appearance is identical.

A new link is a Link annotation appended to the source page:

```
<< /Type /Annot
   /Subtype /Link
   /Rect [x1 y1 x2 y2]          % clickable area, PDF user space
   /Border [0 0 0]             % transparent (no visible border)
   /A << /Type /Action
         /S /GoTo              % internal jump
         /D [ <targetPageRef> /XYZ left top null ] >>
>>
```

Key points:

- The destination is `[page, /XYZ, left, top, zoom]`. `zoom` is null so the
  viewer keeps the current zoom. For "top of page" the left is null and top is
  the page height. For a clicked position or current view, left and top are the
  exact point the user chose.
- The destination's first element is the target page object reference, which is
  what makes the jump land on the correct page across viewers.
- Existing `/Annots` are preserved. New links are appended, never replacing.
- Editing existing links: `readExistingLinks()` enumerates Link annotations in
  document order and gives each a stable id. On export, `buildPdf()` walks the
  same order and either rewrites a link's GoTo action (re-point) or drops it from
  the page's `/Annots` array (delete). Links the user did not touch are kept.

## How coordinate conversion works (`coords.js`)

The user draws in browser pixels (origin top left, Y down, scaled by zoom). A
PDF annotation needs PDF points (origin bottom left, Y up, zoom independent).

Rather than doing the Y flip by hand, the code uses the PDF.js page viewport,
which already encodes scale, rotation, and box offset:

```js
viewport.convertToPdfPoint(x, y)       // viewport px  -> PDF points
viewport.convertToViewportPoint(x, y)  // PDF points    -> viewport px
```

Rectangles and destination points are stored in PDF points, so they stay correct
when the zoom changes. To keep mouse pixels aligned with viewport pixels, each
canvas renders at devicePixelRatio for sharpness while its CSS size equals the
viewport size, and the drawing overlay matches.

## Testing

```bash
npm test     # runs the Playwright specs
```

Each spec builds its own sample PDF in memory, then drives the app in a headless
browser and asserts the exported PDF contains the expected annotations (GoTo
destinations, URI actions, re-pointed targets, deletions, resized rects). Video
and trace are kept only on failure, for debugging.

## Known limitations

- Targets normal, non-rotated pages with a MediaBox origin at (0,0). The code
  goes through the viewport transform, so it is structured to extend to rotated
  pages and offset boxes, but those are not yet validated.
- All pages render eagerly. Very large PDFs use more memory.
- Named destinations are resolved through PDF.js (covering the `/Dests`
  dictionary and the `/Names` destination tree). If a name cannot be resolved
  the link still supports delete and re-point; its current target just shows as
  "internal link".
- New link rectangles are invisible in the output (`/Border [0 0 0]`). Add a
  color or border in `pdfExporter.js` if you want a visible box.

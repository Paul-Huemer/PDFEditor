# PDF Editor

A simple PDF editor that runs in your browser. Files never leave your computer.

## Use

```
npm install
npm run build
```

Open `dist/index.html` by double-clicking it. It's a single file that works offline, so you can copy it anywhere.

For development: `npm run dev`.

## What it does

- **Open / Add PDF**: open a PDF, or insert another one after the selected page (merging). You can also drop files onto the window or the page list.
- **Pages**: drag thumbnails to reorder. Rotate, delete, insert blank pages, or **Extract** the selected pages to a new PDF. Ctrl/Shift-click selects multiple pages.
- **Edit text**: click existing text to change it. Edited text keeps its original font, size and color.
- **Add text**, **Whiteout**, **Highlight**, **Image**: click or drag on a page. Drag to move; use the corner handle to resize. Click selected text again to edit it.
- **Undo / Redo**, zoom, and **Save** (Ctrl+S).

## Limitations

- Edit text and Whiteout cover the original rather than delete it. The old text is hidden but still in the file. Don't rely on them to remove sensitive information.
- PDFs usually embed only the characters they use. If you type a character the original font doesn't have, that character uses a standard font (Helvetica, Times or Courier).
- While editing, text is shown in the matching font installed on your computer, if there is one. The saved file always uses the PDF's own font.
- Saving rebuilds the document. Fillable form fields, bookmarks, and password-protected PDFs aren't supported.

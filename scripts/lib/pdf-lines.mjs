// scripts/lib/pdf-lines.mjs
// A PDF's text as positioned lines, for parsing tables an operator publishes as
// a PDF rather than a page (JR West's Sunrise timetable).
//
// Each page comes back top to bottom as [{ y, cells: [{ x, text }] }], x/y in
// whole PDF points from the page's top-left. Text items whose baselines lie
// within `tolerance` points share a line; a table row stays one line, and a
// column is its x.

import { getDocumentProxy } from "unpdf";

export async function pdfLines(bytes, { tolerance = 2 } = {}) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { height } = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    const cells = items
      .filter((it) => typeof it.str === "string" && it.str.trim())
      .map((it) => ({ x: Math.round(it.transform[4]), y: Math.round(height - it.transform[5]), text: it.str.trim() }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const cell of cells) {
      const line = lines.at(-1);
      if (line && Math.abs(cell.y - line.y) <= tolerance) line.cells.push({ x: cell.x, text: cell.text });
      else lines.push({ y: cell.y, cells: [{ x: cell.x, text: cell.text }] });
    }
    for (const line of lines) line.cells.sort((a, b) => a.x - b.x);
    pages.push(lines);
  }
  return pages;
}

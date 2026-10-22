// Extracts plain text from a PDF so the chat model can read attached documents.
// Uses Mozilla's pdf.js (legacy build for Node). Scanned PDFs (images only) return no text.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PAGES = 30;

export async function extractPdfText(buffer, maxChars = 20000) {
  const task = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });

  const pdf = await task.promise;
  try {
    const pageCount = Math.min(pdf.numPages, MAX_PAGES);
    const pages = [];
    let length = 0;

    for (let pageNumber = 1; pageNumber <= pageCount && length < maxChars; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      // hasEOL marks line breaks inside the page; keep them so headings/lists stay readable
      const text = content.items
        .map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`)
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      pages.push(text);
      length += text.length;
    }

    const full = pages.join("\n\n").trim();
    return {
      text: full.slice(0, maxChars),
      pages: pdf.numPages,
      truncated: full.length > maxChars || pdf.numPages > MAX_PAGES,
    };
  } finally {
    await pdf.destroy();
  }
}

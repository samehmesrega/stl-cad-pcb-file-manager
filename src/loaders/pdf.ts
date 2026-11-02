import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function openPdf(buffer: ArrayBuffer) {
  return pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
}

export type PdfDocument = Awaited<ReturnType<typeof openPdf>>;

export function closePdf(document: PdfDocument) {
  return document.loadingTask.destroy();
}

export async function renderPage(document: PdfDocument, pageNumber: number, canvas: HTMLCanvasElement, scale: number) {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return { width: viewport.width / scale, height: viewport.height / scale };
}

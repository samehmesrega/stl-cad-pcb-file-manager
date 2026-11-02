import { useEffect, useRef, useState } from 'react';
import { fetchBuffer } from '../loaders/parseClient.ts';
import { closePdf, openPdf, renderPage } from '../loaders/pdf.ts';
import type { PdfDocument } from '../loaders/pdf.ts';
import { ViewerError, ViewerLoading } from './common.tsx';
import { t } from '../i18n.ts';

const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4];

export function PdfViewer({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(2);

  useEffect(() => {
    let cancelled = false;
    let opened: PdfDocument | null = null;
    fetchBuffer(url)
      .then(openPdf)
      .then((loaded) => {
        opened = loaded;
        if (cancelled) void closePdf(loaded);
        else setDocument(loaded);
      })
      .catch((loadError) => {
        console.warn(loadError);
        if (!cancelled) setError(t('This file is not PDF-compatible. Save older AI files with the PDF Compatible option.'));
      });
    return () => {
      cancelled = true;
      if (opened) void closePdf(opened);
    };
  }, [url]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    const dpr = window.devicePixelRatio || 1;
    const target = canvas.current;
    let stale = false;
    renderPage(document, page, target, ZOOMS[zoom] * dpr)
      .then(({ width, height }) => {
        if (stale) return;
        target.style.width = `${width * ZOOMS[zoom]}px`;
        target.style.height = `${height * ZOOMS[zoom]}px`;
      })
      .catch((renderError) => {
        if (renderError?.name !== 'RenderingCancelledException') console.warn(renderError);
      });
    return () => {
      stale = true;
    };
  }, [document, page, zoom]);

  return (
    <div className="stage stage-pdf">
      {!document && !error && <ViewerLoading label={t('Opening the file')} />}
      {error && <ViewerError message={error} />}
      {document && (
        <>
          <div className="pdf-scroll">
            <canvas ref={canvas} className="pdf-page" />
          </div>
          <div className="hud hud-top">
            <div className="seg">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('Previous')}</button>
              <span className="seg-label" dir="ltr">{page} / {document.numPages}</span>
              <button disabled={page >= document.numPages} onClick={() => setPage(page + 1)}>{t('Next')}</button>
            </div>
            <div className="seg">
              <button disabled={zoom <= 0} onClick={() => setZoom(zoom - 1)} aria-label={t('Zoom out')}>−</button>
              <span className="seg-label" dir="ltr">{ZOOMS[zoom] * 100}%</span>
              <button disabled={zoom >= ZOOMS.length - 1} onClick={() => setZoom(zoom + 1)} aria-label={t('Zoom in')}>+</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { resolveImage } from '../loaders/raster.ts';
import { ViewerError, ViewerLoading } from './common.tsx';
import { FULL_VIEW, usePanZoom } from './usePanZoom.ts';
import { t } from '../i18n.ts';

/** Also used for CorelDRAW files, which only offer the small preview stored inside them. */
export function ImageViewer({ url, ext, note }: { url: string; ext: string; note?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [natural, setNatural] = useState<[number, number] | null>(null);
  const { view, setView, handlers } = usePanZoom(stage);

  useEffect(() => {
    let cancelled = false;
    let revoke = '';
    resolveImage(url, ext)
      .then((result) => {
        if (result.revoke) revoke = result.src;
        if (!cancelled) setSrc(result.src);
      })
      .catch((loadError) => {
        console.warn(loadError);
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [url, ext]);

  return (
    <div className="stage stage-image" ref={stage} {...handlers}>
      {!src && !error && <ViewerLoading label={t('Loading the image')} />}
      {error && <ViewerError message={error} />}
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          className="stage-img"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onLoad={(event) => setNatural([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])}
          onError={() => setError(t('This image cannot be opened'))}
        />
      )}
      <div className="hud hud-top">
        <button
          className="hud-btn"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setView(FULL_VIEW)}
        >{t('Fit to screen')}</button>
      </div>
      {note && <div className="viewer-banner">{note}</div>}
      {natural && natural[0] > 0 && (
        <div className="hud hud-bottom readout" dir="ltr">
          <span>{natural[0]} × {natural[1]} px</span>
          <span>{Math.round(view.scale * 100)}%</span>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardRender } from '../loaders/board.ts';
import { renderBoard } from '../loaders/parseClient.ts';
import type { DesignFile } from '../types.ts';
import { ViewerError, ViewerLoading, formatNumber } from './common.tsx';
import { FULL_VIEW, usePanZoom } from './usePanZoom.ts';
import { t } from '../i18n.ts';

type Mode = 'top' | 'bottom' | 'layers';

const TYPE_LABELS: Record<string, string> = {
  copper: t('Copper'),
  soldermask: t('Solder mask'),
  silkscreen: t('Silkscreen'),
  solderpaste: t('Solder paste'),
  drill: t('Drill holes'),
  outline: t('Board outline'),
  drawing: t('Extra drawing'),
};
const SIDE_LABELS: Record<string, string> = { top: t('top'), bottom: t('bottom'), inner: t('inner') };

function layerLabel(layer: { type: string; side: string | null }) {
  const name = TYPE_LABELS[layer.type] ?? layer.type;
  return layer.side && SIDE_LABELS[layer.side] ? `${name} (${SIDE_LABELS[layer.side]})` : name;
}

const svgUrl = (svg: string) => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));

export function BoardViewer({ files }: { files: DesignFile[] }) {
  const stage = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<BoardRender | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<Mode>('top');
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const { view, setView, handlers } = usePanZoom(stage);
  const sourcesKey = files.map((file) => file.url).join('|');

  useEffect(() => {
    let cancelled = false;
    renderBoard(files.map((file) => ({ name: file.name, url: file.url })))
      .then((result) => {
        if (cancelled) return;
        setBoard(result);
        setHidden(new Set(result.layers.flatMap((layer, index) => (layer.visible ? [] : [index]))));
        // Without an outline or a copper layer there is no finished board to look at.
        if (!result.hasShape || !result.layers.some((layer) => layer.type === 'copper')) setMode('layers');
      })
      .catch((loadError) => {
        console.warn(loadError);
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sourcesKey]);

  const images = useMemo(() => {
    if (!board) return null;
    return { top: svgUrl(board.top), bottom: svgUrl(board.bottom), layers: board.layers.map((layer) => svgUrl(layer.svg)) };
  }, [board]);

  useEffect(() => {
    if (!images) return;
    return () => {
      for (const url of [images.top, images.bottom, ...images.layers]) URL.revokeObjectURL(url);
    };
  }, [images]);

  const toggleLayer = (index: number) => {
    const next = new Set(hidden);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setHidden(next);
  };

  return (
    <div className="stage stage-grid board-stage" ref={stage} {...handlers}>
      {!board && !error && <ViewerLoading label={t('Preparing the board')} />}
      {error && <ViewerError message={error} />}
      {board && images && (
        <>
          <div
            className="board-sheet"
            style={{
              aspectRatio: `${board.width} / ${board.height}`,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            {mode === 'top' && <img src={images.top} alt={t('Top of the board')} draggable={false} />}
            {mode === 'bottom' && <img src={images.bottom} alt={t('Bottom of the board')} draggable={false} />}
            {mode === 'layers' && images.layers.map((url, index) => (
              !hidden.has(index) && <img key={url} src={url} alt="" draggable={false} />
            ))}
          </div>
          <div className="hud hud-top" onPointerDown={(event) => event.stopPropagation()}>
            <div className="seg" role="group" aria-label={t('Board view')}>
              {([['top', t('Top')], ['bottom', t('Bottom')], ['layers', t('Layers')]] as [Mode, string][]).map(([name, label]) => (
                <button key={name} className={mode === name ? 'on' : ''} aria-pressed={mode === name} onClick={() => setMode(name)}>
                  {label}
                </button>
              ))}
            </div>
            <button className="hud-btn" onClick={() => setView(FULL_VIEW)}>{t('Fit to screen')}</button>
          </div>
          {mode === 'layers' && (
            <div className="layers-panel" onPointerDown={(event) => event.stopPropagation()}>
              {board.layers.map((layer, index) => (
                <label key={index} className={hidden.has(index) ? 'off' : ''}>
                  <input type="checkbox" checked={!hidden.has(index)} onChange={() => toggleLayer(index)} />
                  <span className="swatch" style={{ background: layer.color }} />
                  <span className="layer-name">
                    {layerLabel(layer)}
                  </span>
                  <span className="layer-detail" dir="ltr" title={layer.name}>{layer.name}</span>
                </label>
              ))}
            </div>
          )}
          {board.skipped.length > 0 && <div className="viewer-banner board-skipped" dir="auto">{t('Could not read: {names}', { names: board.skipped.join(', ') })}</div>}
          <div className="hud hud-bottom readout" dir="ltr">
            <span>{formatNumber(board.width)} × {formatNumber(board.height)} {board.units}</span>
            <span>{board.layers.length} layers</span>
            <span>{Math.round(view.scale * 100)}%</span>
          </div>
        </>
      )}
    </div>
  );
}

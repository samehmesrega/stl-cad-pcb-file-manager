import { useCallback, useEffect, useRef, useState } from 'react';
import type { Drawing } from '../loaders/drawing.ts';
import { fetchBuffer, parseDrawing } from '../loaders/parseClient.ts';
import { ViewerError, ViewerLoading, formatNumber } from './common.tsx';
import { fitView, prepareDrawing, renderDrawing } from './renderDrawing.ts';
import type { PreparedDrawing, View } from './renderDrawing.ts';
import { t, tr } from '../i18n.ts';

export function DrawingViewer({ url, ext }: { url: string; ext: string }) {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const preparedRef = useRef<PreparedDrawing | null>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const hiddenRef = useRef<Set<number>>(new Set());
  const frame = useRef(0);

  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [layersOpen, setLayersOpen] = useState(true);
  const [cursor, setCursor] = useState<[number, number] | null>(null);

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    const prepared = preparedRef.current;
    if (!canvas || !prepared) return;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    renderDrawing(ctx, prepared, viewRef.current, hiddenRef.current, window.devicePixelRatio || 1);
  }, []);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const fit = useCallback(() => {
    const prepared = preparedRef.current;
    const container = host.current;
    if (!prepared || !container) return;
    viewRef.current = fitView(prepared.drawing.bounds, container.clientWidth, container.clientHeight, 48);
    schedule();
  }, [schedule]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const parsed = await parseDrawing(ext, await fetchBuffer(url));
        if (cancelled) return;
        preparedRef.current = prepareDrawing(parsed);
        const initiallyHidden = new Set(parsed.layers.flatMap((layer, index) => (layer.hidden ? [index] : [])));
        hiddenRef.current = initiallyHidden;
        setHidden(initiallyHidden);
        setDrawing(parsed);
      } catch (loadError) {
        console.warn(loadError);
        if (!cancelled) setError((loadError as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      preparedRef.current = null;
    };
  }, [url, ext]);

  useEffect(() => {
    const container = host.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || !drawing) return;
    let first = true;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, container.clientWidth * dpr);
      canvas.height = Math.max(1, container.clientHeight * dpr);
      if (first) {
        first = false;
        fit();
      } else {
        schedule();
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    // A non-passive listener is required to stop the wheel from scrolling the page.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const view = viewRef.current;
      const factor = Math.exp(-event.deltaY * 0.0015);
      viewRef.current = {
        scale: view.scale * factor,
        x: px - (px - view.x) * factor,
        y: py - (py - view.y) * factor,
      };
      schedule();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [drawing, fit, schedule]);

  const drag = useRef<{ x: number; y: number } | null>(null);

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const prepared = preparedRef.current;
    if (!prepared) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (drag.current) {
      viewRef.current = {
        ...viewRef.current,
        x: viewRef.current.x + event.clientX - drag.current.x,
        y: viewRef.current.y + event.clientY - drag.current.y,
      };
      drag.current = { x: event.clientX, y: event.clientY };
      schedule();
    }
    const view = viewRef.current;
    setCursor([
      (event.clientX - rect.left - view.x) / view.scale + prepared.centerX,
      -(event.clientY - rect.top - view.y) / view.scale + prepared.centerY,
    ]);
  };

  const toggleLayer = (index: number) => {
    const next = new Set(hidden);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    hiddenRef.current = next;
    setHidden(next);
    schedule();
  };

  const width = drawing ? drawing.bounds.maxX - drawing.bounds.minX : 0;
  const height = drawing ? drawing.bounds.maxY - drawing.bounds.minY : 0;

  return (
    <div className="stage stage-grid" ref={host}>
      {!drawing && !error && <ViewerLoading label={t('Reading the drawing')} />}
      {error && <ViewerError message={error} />}
      {drawing && (
        <>
          <canvas
            ref={canvasRef}
            className="drawing-canvas"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerLeave={() => setCursor(null)}
            onPointerMove={onPointerMove}
            onDoubleClick={fit}
          />
          <div className="hud hud-top">
            <button className="hud-btn" onClick={fit}>{t('Fit to screen')}</button>
            <button
              className={`hud-btn ${layersOpen ? 'on' : ''}`}
              aria-pressed={layersOpen}
              onClick={() => setLayersOpen(!layersOpen)}
            >
              {t('Layers')} ({drawing.layers.length})
            </button>
          </div>
          {layersOpen && (
            <div className="layers-panel">
              {drawing.layers.map((layer, index) => (
                <label key={index} className={hidden.has(index) ? 'off' : ''}>
                  <input type="checkbox" checked={!hidden.has(index)} onChange={() => toggleLayer(index)} />
                  <span className="swatch" style={{ background: layer.color }} />
                  <span className="layer-name" dir="auto">{layer.name}</span>
                  {layer.detail && <span className="layer-detail" dir="ltr">{layer.detail}</span>}
                </label>
              ))}
              {drawing.info.length > 0 && (
                <dl className="drawing-info">
                  {drawing.info.map(([key, value]) => (
                    <div key={key}>
                      <dt>{tr(key)}</dt>
                      <dd dir="auto">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
          <div className="hud hud-bottom readout" dir="ltr">
            <span>{formatNumber(width)} × {formatNumber(height)}{drawing.unit ? ` ${drawing.unit}` : ''}</span>
            {cursor && <span className="cursor-pos">{formatNumber(cursor[0])}, {formatNumber(cursor[1])}</span>}
          </div>
        </>
      )}
    </div>
  );
}

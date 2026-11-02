import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, RefObject } from 'react';

export const FULL_VIEW = { scale: 1, x: 0, y: 0 };

/** Wheel zooms toward the cursor and dragging pans. For content shown with a CSS transform. */
export function usePanZoom(stage: RefObject<HTMLElement | null>) {
  const [view, setView] = useState(FULL_VIEW);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      const factor = Math.exp(-event.deltaY * 0.0015);
      setView((current) => ({
        scale: Math.min(64, Math.max(0.05, current.scale * factor)),
        x: px - (px - current.x) * factor,
        y: py - (py - current.y) * factor,
      }));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [stage]);

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY };
    },
    onPointerUp: () => {
      drag.current = null;
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      const dx = event.clientX - drag.current.x;
      const dy = event.clientY - drag.current.y;
      drag.current = { x: event.clientX, y: event.clientY };
      setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    },
    onDoubleClick: () => setView(FULL_VIEW),
  };

  return { view, setView, handlers };
}

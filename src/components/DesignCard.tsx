import { useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { CATEGORY_LABELS, displayExt } from '../../shared/formats.ts';
import { thumbUrl } from '../api.ts';
import { canHaveThumb, requestThumb } from '../thumbs.ts';
import type { Design } from '../types.ts';
import { t, typeLabel } from '../i18n.ts';

export function DesignCard({ design, selected, selecting, onOpen, onUpdate, onToggle }: {
  design: Design;
  selected: boolean;
  /** Once anything is selected, a click on any card adds to the selection instead of opening it. */
  selecting: boolean;
  onOpen: (design: Design) => void;
  onUpdate: (design: Design) => void;
  onToggle: (design: Design, range: boolean) => void;
}) {
  const card = useRef<HTMLButtonElement>(null);
  const pending = design.thumb_state === 'none' && canHaveThumb(design);
  const label = displayExt(design.ext);

  // Thumbnails for cards scrolled out of sight can wait until they are near the viewport.
  useEffect(() => {
    if (!pending || !card.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          requestThumb(design, onUpdate);
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [pending, design, onUpdate]);

  const onClick = (event: MouseEvent) => {
    if (selecting || event.shiftKey || event.ctrlKey) onToggle(design, event.shiftKey);
    else onOpen(design);
  };

  return (
    <div className={`card-wrap ${selected ? 'selected' : ''} ${selecting ? 'selecting' : ''}`}>
      <button ref={card} className="card" onClick={onClick}>
        <span className="thumb">
          {design.thumb_state === 'ok' ? (
            <img src={thumbUrl(design)} alt="" loading="lazy" />
          ) : pending ? (
            <span className="thumb-pending" aria-label={t('Preparing preview')} />
          ) : (
            <span className="thumb-ext" dir="ltr">{label}</span>
          )}
        </span>
        <span className="card-body">
          <span className="card-name" dir="auto" title={design.name}>{design.name}</span>
          <span className="card-place" dir="auto">
            {design.project_name}
            {design.product_name && <> / {design.product_name}</>}
          </span>
          <span className="card-meta">
            <span className="ext-badge" dir="ltr">{label}</span>
            {design.extra_files > 0 && <span className="file-count" dir="ltr">+{design.extra_files}</span>}
            <span className="card-type" dir="auto">{design.type_name ? typeLabel(design.type_name) : t(CATEGORY_LABELS[design.category])}</span>
            <span className="card-date" dir="ltr">{design.design_date}</span>
          </span>
        </span>
      </button>
      <label className="card-check" title={t('Select')}>
        <input
          type="checkbox"
          checked={selected}
          aria-label={t('Select {name}', { name: design.name })}
          onChange={() => {}}
          onClick={(event) => onToggle(design, event.shiftKey)}
        />
      </label>
    </div>
  );
}

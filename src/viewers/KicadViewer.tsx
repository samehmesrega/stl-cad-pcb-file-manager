import { createElement, useEffect, useState } from 'react';
import type { DesignFile } from '../types.ts';
import { ViewerError, ViewerLoading } from './common.tsx';
import { t } from '../i18n.ts';

let script: Promise<void> | null = null;

/** Loaded on demand and only once, because it registers its element for the whole page. */
function loadKicanvas(): Promise<void> {
  script ??= new Promise((resolve, reject) => {
    const element = document.createElement('script');
    element.type = 'module';
    element.src = '/vendor/kicanvas/kicanvas.js';
    element.onload = () => resolve();
    element.onerror = () => reject(new Error(t('Could not load the KiCad viewer')));
    document.head.append(element);
  });
  return script;
}

export function KicadViewer({ file, files }: { file: DesignFile; files: DesignFile[] }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadKicanvas()
      .then(() => !cancelled && setReady(true))
      .catch((loadError) => !cancelled && setError(loadError.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // A schematic can span several sheets, and it reads them by file name.
  const siblings = file.ext === 'kicad_sch' ? files.filter((other) => other.ext === 'kicad_sch' && other.url !== file.url) : [];

  return (
    <div className="stage kicad-stage">
      {!ready && !error && <ViewerLoading label={t('Preparing the KiCad viewer')} />}
      {error && <ViewerError message={error} />}
      {ready && createElement(
        'kicanvas-embed',
        { key: file.url, src: file.url, controls: 'basic', controlslist: 'nodownload', theme: 'kicad', style: { width: '100%', height: '100%', display: 'block' } },
        siblings.map((other) => createElement('kicanvas-source', { key: other.url, src: other.url })),
      )}
    </div>
  );
}

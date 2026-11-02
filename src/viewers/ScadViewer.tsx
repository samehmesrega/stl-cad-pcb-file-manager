import { useEffect, useState } from 'react';
import { SCAD_VIEW_TIMEOUT_MS, renderScad } from '../loaders/scadClient.ts';
import { DrawingViewer } from './DrawingViewer.tsx';
import { ModelViewer } from './ModelViewer.tsx';
import { TextViewer } from './TextViewer.tsx';
import { ViewerLoading } from './common.tsx';
import { t, tr } from '../i18n.ts';

type Tab = 'model' | 'code';

export function ScadViewer({ url, name, designId }: { url: string; name: string; designId: number }) {
  const [tab, setTab] = useState<Tab>('model');
  const [output, setOutput] = useState<{ url: string; ext: 'stl' | 'dxf' } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let blobUrl = '';
    setOutput(null);
    setError('');
    setTab('model');
    renderScad(url, name, designId, SCAD_VIEW_TIMEOUT_MS)
      .then((result) => {
        if (cancelled) return;
        blobUrl = URL.createObjectURL(new Blob([result.buffer]));
        setOutput({ url: blobUrl, ext: result.format });
      })
      .catch((renderError) => {
        console.warn(renderError);
        if (cancelled) return;
        setError(renderError.message);
        setTab('code');
      });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url, name, designId]);

  return (
    <>
      {tab === 'code' && <TextViewer url={url} />}
      {tab === 'model' && !output && !error && (
        <div className="stage">
          <ViewerLoading label={t('Computing the model. Large files take time')} />
        </div>
      )}
      {tab === 'model' && output?.ext === 'stl' && <ModelViewer url={output.url} ext="stl" />}
      {tab === 'model' && output?.ext === 'dxf' && <DrawingViewer url={output.url} ext="dxf" />}
      <div className="scad-tabs">
        {error && <span className="scad-note" dir="auto">{tr(error)}</span>}
        <div className="seg" role="group" aria-label={t('View mode')}>
          <button className={tab === 'model' ? 'on' : ''} aria-pressed={tab === 'model'} disabled={Boolean(error)} onClick={() => setTab('model')}>{t('Model')}</button>
          <button className={tab === 'code' ? 'on' : ''} aria-pressed={tab === 'code'} onClick={() => setTab('code')}>{t('Code')}</button>
        </div>
      </div>
    </>
  );
}

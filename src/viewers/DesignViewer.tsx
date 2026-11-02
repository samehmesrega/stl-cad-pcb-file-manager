import { Suspense, lazy } from 'react';
import { formatOf } from '../../shared/formats.ts';
import type { DesignFile } from '../types.ts';
import { TextViewer } from './TextViewer.tsx';
import { ViewerLoading } from './common.tsx';
import { t } from '../i18n.ts';

const ModelViewer = lazy(() => import('./ModelViewer.tsx').then((m) => ({ default: m.ModelViewer })));
const DrawingViewer = lazy(() => import('./DrawingViewer.tsx').then((m) => ({ default: m.DrawingViewer })));
const ToolpathViewer = lazy(() => import('./ToolpathViewer.tsx').then((m) => ({ default: m.ToolpathViewer })));
const ImageViewer = lazy(() => import('./ImageViewer.tsx').then((m) => ({ default: m.ImageViewer })));
const PdfViewer = lazy(() => import('./PdfViewer.tsx').then((m) => ({ default: m.PdfViewer })));
const BoardViewer = lazy(() => import('./BoardViewer.tsx').then((m) => ({ default: m.BoardViewer })));
const KicadViewer = lazy(() => import('./KicadViewer.tsx').then((m) => ({ default: m.KicadViewer })));
const ScadViewer = lazy(() => import('./ScadViewer.tsx').then((m) => ({ default: m.ScadViewer })));

function NoPreview({ ext, canOpen }: { ext: string; canOpen: boolean }) {
  return (
    <div className="stage stage-grid">
      <div className="viewer-message">
        <p className="ext-big" dir="ltr">.{ext.toUpperCase() || '?'}</p>
        <p className="viewer-title">{t('This format has no preview in the app')}</p>
        <p className="viewer-note">
          {canOpen
            ? t('The file is saved. You can open it in its program or download it. To show its picture in the library, upload a preview image from the side panel.')
            : t('The file is saved. You can download it and open it in its program. To show its picture in the library, upload a preview image from the side panel.')}
        </p>
      </div>
    </div>
  );
}

/** Shows one file of a design, or with `board` set, all of its Gerber files together as one board. */
export function DesignViewer({ file, board, files, designId, canOpen }: {
  file: DesignFile;
  board?: DesignFile[];
  files: DesignFile[];
  designId: number;
  canOpen: boolean;
}) {
  const { url, ext } = file;
  const { viewer } = formatOf(ext);
  return (
    <Suspense fallback={<div className="stage"><ViewerLoading label={t('Preparing the viewer')} /></div>}>
      {board ? <BoardViewer files={board} /> : (
        <>
          {viewer === 'model' && <ModelViewer url={url} ext={ext} />}
          {viewer === 'scad' && <ScadViewer url={url} name={file.name} designId={designId} />}
          {viewer === 'drawing' && <DrawingViewer url={url} ext={ext} />}
          {viewer === 'toolpath' && <ToolpathViewer url={url} />}
          {viewer === 'image' && <ImageViewer url={url} ext={ext} />}
          {viewer === 'embedded' && (
            <ImageViewer url={url} ext={ext} note={t('This is the thumbnail stored inside the CorelDRAW file, not the full drawing.')} />
          )}
          {viewer === 'pdf' && <PdfViewer url={url} />}
          {viewer === 'text' && <TextViewer url={url} />}
          {viewer === 'gerber' && <BoardViewer files={[file]} />}
          {viewer === 'kicad' && <KicadViewer file={file} files={files} />}
          {viewer === 'none' && <NoPreview ext={ext} canOpen={canOpen} />}
        </>
      )}
    </Suspense>
  );
}

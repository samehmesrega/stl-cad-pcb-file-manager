import { useEffect, useState } from 'react';
import { ViewerError, ViewerLoading } from './common.tsx';
import { t } from '../i18n.ts';

const MAX_TEXT = 2 * 1024 * 1024;

export function TextViewer({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch(url, { headers: { Range: `bytes=0-${MAX_TEXT - 1}` } })
      .then((response) => response.text())
      .then((value) => !cancelled && setText(value))
      .catch((loadError) => !cancelled && setError(loadError.message));
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (error) return <div className="stage"><ViewerError message={error} /></div>;
  if (text === null) return <div className="stage"><ViewerLoading label={t('Opening the file')} /></div>;
  return <pre className="text-viewer" dir="auto">{text}</pre>;
}

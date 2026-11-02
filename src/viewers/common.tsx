import { t, tr } from '../i18n.ts';
export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function ViewerLoading({ label }: { label: string }) {
  return (
    <div className="viewer-message">
      <div className="spinner" aria-hidden />
      <p>{label}</p>
    </div>
  );
}

export function ViewerError({ message }: { message: string }) {
  return (
    <div className="viewer-message">
      <p className="viewer-title">{t('Could not display the file')}</p>
      <p className="viewer-note" dir="auto">{tr(message)}</p>
      <p className="viewer-note">{t('The file itself is safe in the library and can be downloaded.')}</p>
    </div>
  );
}

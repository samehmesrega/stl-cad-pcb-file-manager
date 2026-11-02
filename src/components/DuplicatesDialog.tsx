import { useCallback, useEffect, useState } from 'react';
import { displayExt } from '../../shared/formats.ts';
import { api, thumbUrl } from '../api.ts';
import type { DuplicateGroup, DuplicateItem } from '../types.ts';
import { Dialog, formatSize } from './ui.tsx';
import { t, plural } from '../i18n.ts';

const itemKey = (item: DuplicateItem) => (item.file_id === null ? `d${item.design.id}` : `f${item.file_id}`);

const UNKNOWN_PROJECT = /^unknown$/i;

/** The copy worth keeping by default is the one that has been classified best. The user can pick another. */
function bestToKeep(group: DuplicateGroup): string {
  const score = (item: DuplicateItem) =>
    (item.removable ? 0 : 100) +
    (item.file_id !== null ? 8 : 0) +
    (item.design.product_id ? 4 : 0) +
    (UNKNOWN_PROJECT.test(item.design.project_name) ? 0 : 2);
  return itemKey([...group.items].sort((a, b) => score(b) - score(a) || a.design.id - b.design.id)[0]);
}

const POLL_MS = 2000;

export function DuplicatesDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [pending, setPending] = useState(0);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const result = await api.duplicates();
    setGroups(result.groups);
    setPending(result.pending);
    setKeep((current) => {
      const next: Record<string, string> = {};
      for (const group of result.groups) next[group.sha256] = current[group.sha256] ?? bestToKeep(group);
      return next;
    });
  }, []);

  useEffect(() => {
    load().catch((loadError) => setError(loadError.message));
  }, [load]);

  // Fingerprints are computed in the background, so more groups may appear while this is open.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => load().catch(() => {}), POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, load]);

  const active = (groups ?? []).filter((group) => !ignored.has(group.sha256));
  const toRemove = active.flatMap((group) => group.items.filter((item) => item.removable && itemKey(item) !== keep[group.sha256]));
  const savedBytes = active.reduce(
    (sum, group) => sum + group.size * group.items.filter((item) => item.removable && itemKey(item) !== keep[group.sha256]).length,
    0,
  );

  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    setError('');
    try {
      await api.removeDuplicates(
        toRemove.filter((item) => item.file_id === null).map((item) => item.design.id),
        toRemove.filter((item) => item.file_id !== null).map((item) => item.file_id as number),
      );
      onChanged();
      await load();
    } catch (removeError) {
      setError((removeError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('Duplicate files')} onClose={onClose} wide locked={busy}>
      <div className="dialog-body dup-body">
        {pending > 0 && <p className="hint" role="status">{plural(pending, 'Still fingerprinting {n} file, so more groups may appear.', 'Still fingerprinting {n} files, so more groups may appear.')}</p>}
        {groups === null && !error && <p className="hint">{t('Searching…')}</p>}
        {groups?.length === 0 && pending === 0 && <p className="dup-empty">{t('There are no duplicate files in the library.')}</p>}
        {groups && groups.length > 0 && (
          <p className="hint">{t('These files are identical, byte for byte. Choose the copy to keep from each group, or leave a group as it is if the copies are intentional.')}</p>
        )}
        {active.length < (groups?.length ?? 0) && (
          <button className="link-btn" onClick={() => setIgnored(new Set())}>{t('Show ignored groups again ({n})', { n: (groups?.length ?? 0) - active.length })}</button>
        )}
        <ul className="dup-groups">
          {active.map((group) => (
            <li key={group.sha256} className="dup-group">
              <header>
                <span dir="ltr">{group.items.length} × {formatSize(group.size)}</span>
                <button className="link-btn" onClick={() => setIgnored(new Set(ignored).add(group.sha256))}>{t('Leave as is')}</button>
              </header>
              {group.items.map((item) => {
                const key = itemKey(item);
                const kept = keep[group.sha256] === key;
                return (
                  <label key={key} className={`dup-item ${kept ? 'kept' : ''}`}>
                    <input
                      type="radio"
                      name={`keep-${group.sha256}`}
                      checked={kept}
                      onChange={() => setKeep({ ...keep, [group.sha256]: key })}
                    />
                    <span className="dup-thumb">
                      {item.design.thumb_state === 'ok'
                        ? <img src={thumbUrl(item.design)} alt="" loading="lazy" />
                        : <span dir="ltr">{displayExt(item.design.ext)}</span>}
                    </span>
                    <span className="dup-text">
                      <span className="dup-name" dir="auto">{item.design.name}</span>
                      <span className="dup-place" dir="auto">
                        {item.design.project_name}{item.design.product_name && ` / ${item.design.product_name}`}
                        {item.file_id !== null && t(' · inside the design: {name}', { name: item.file_name })}
                      </span>
                    </span>
                    {!item.removable && <span className="dup-lock">{t('Has other files, will not be deleted')}</span>}
                    <span className="dup-date" dir="ltr">{item.design.design_date}</span>
                  </label>
                );
              })}
            </li>
          ))}
        </ul>
      </div>
      <footer className="dialog-foot">
        {error && <span className="field-error" role="alert">{error}</span>}
        {confirming ? (
          <>
            <span className="dup-confirm">{plural(toRemove.length, '{n} file will be permanently deleted. This cannot be undone.', '{n} files will be permanently deleted. This cannot be undone.')}</span>
            <button className="btn" onClick={() => setConfirming(false)}>{t('Back')}</button>
            <button className="btn btn-danger" onClick={remove}>{t('Delete permanently')}</button>
          </>
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={onClose}>{t('Close')}</button>
            <button className="btn btn-accent" disabled={busy || !toRemove.length} onClick={() => setConfirming(true)}>
              {busy ? t('Deleting…') : toRemove.length ? t(toRemove.length === 1 ? 'Delete {n} copy ({size})' : 'Delete {n} copies ({size})', { n: toRemove.length, size: formatSize(savedBytes) }) : t('Delete extra copies')}
            </button>
          </>
        )}
      </footer>
    </Dialog>
  );
}

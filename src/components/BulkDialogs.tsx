import { useEffect, useState } from 'react';
import { displayExt } from '../../shared/formats.ts';
import { api } from '../api.ts';
import type { BulkPatch, Design, Meta } from '../types.ts';
import { Dialog, formatSize, toLocalDate } from './ui.tsx';
import { t, plural, typeLabel } from '../i18n.ts';

const KEEP = 'keep';

/** Every field starts on "no change", so only what the user picks is touched. */
export function BulkEditDialog({ ids, meta, onClose, onDone }: {
  ids: number[];
  meta: Meta;
  onClose: () => void;
  onDone: () => void;
}) {
  const [project, setProject] = useState(KEEP);
  const [product, setProduct] = useState(KEEP);
  const [type, setType] = useState(KEEP);
  const [date, setDate] = useState('');
  const [changeDate, setChangeDate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosenProject = meta.projects.find((p) => String(p.id) === project);
  // Without a chosen project, the list would mix products from projects these designs may not belong to.
  const productOptions = chosenProject?.products ?? [];
  const nothing = project === KEEP && product === KEEP && type === KEEP && !changeDate;

  const save = async () => {
    const patch: BulkPatch = {};
    if (project !== KEEP) patch.project_id = Number(project);
    if (product !== KEEP) patch.product_id = product ? Number(product) : null;
    if (type !== KEEP) patch.type_id = type ? Number(type) : null;
    if (changeDate) patch.design_date = date;
    setBusy(true);
    setError('');
    try {
      await api.bulkUpdate(ids, patch);
      onDone();
    } catch (saveError) {
      setError((saveError as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title={plural(ids.length, 'Edit {n} design', 'Edit {n} designs')} onClose={onClose} locked={busy}>
      <div className="dialog-body bulk-form">
        <label className="field">
          <span className="field-label">{t('Project')}</span>
          <select value={project} onChange={(event) => { setProject(event.target.value); setProduct(KEEP); }}>
            <option value={KEEP}>{t('No change')}</option>
            {meta.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('Product')}</span>
          <select value={product} onChange={(event) => setProduct(event.target.value)}>
            <option value={KEEP}>{chosenProject ? t('No product (general file)') : t('No change')}</option>
            {!chosenProject && <option value="">{t('No product (general file)')}</option>}
            {productOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {!chosenProject && <span className="hint">{t('To pick a product, choose its project first.')}</span>}
        </label>
        <label className="field">
          <span className="field-label">{t('Design type')}</span>
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value={KEEP}>{t('No change')}</option>
            <option value="">{t('No type')}</option>
            {meta.types.map((item) => <option key={item.id} value={item.id}>{typeLabel(item.name)}</option>)}
          </select>
        </label>
        <fieldset className="field date-mode">
          <legend className="field-label">{t('Design date')}</legend>
          <label>
            <input
              type="checkbox"
              checked={changeDate}
              onChange={(event) => {
                setChangeDate(event.target.checked);
                if (!date) setDate(toLocalDate(new Date()));
              }}
            />{t('Change the date for all')}</label>
          {changeDate && <input type="date" value={date} aria-label={t('Date')} onChange={(event) => setDate(event.target.value)} />}
        </fieldset>
      </div>
      <footer className="dialog-foot">
        {error && <span className="field-error" role="alert">{error}</span>}
        <button className="btn" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
        <button className="btn btn-accent" disabled={busy || nothing || (changeDate && !date)} onClick={save}>
          {busy ? t('Saving…') : t('Save')}
        </button>
      </footer>
    </Dialog>
  );
}

export const MAX_MERGE = 50;

export function MergeDialog({ ids, onClose, onDone }: {
  ids: number[];
  onClose: () => void;
  onDone: (design: Design) => void;
}) {
  const [designs, setDesigns] = useState<Design[] | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all(ids.map((id) => api.design(id)))
      .then((list) => {
        if (cancelled) return;
        setDesigns(list);
        setTarget(list[0]?.id ?? null);
      })
      .catch((loadError) => !cancelled && setError(loadError.message));
    return () => {
      cancelled = true;
    };
  }, [ids]);

  const merge = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      onDone(await api.merge(target, ids));
    } catch (mergeError) {
      setError((mergeError as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('Merge {n} designs into one', { n: ids.length })} onClose={onClose} locked={busy}>
      <div className="dialog-body merge-body">
        <p className="hint">{t('All the files move into the design you choose, which keeps its name and place. You can split any file out later.')}</p>
        <ul className="merge-list">
          {designs?.map((design) => (
            <li key={design.id}>
              <label>
                <input type="radio" name="merge-target" checked={target === design.id} onChange={() => setTarget(design.id)} />
                <span className="ext-badge" dir="ltr">{displayExt(design.ext)}</span>
                <span className="merge-name" dir="auto">{design.name}</span>
                <span className="merge-size" dir="ltr">{formatSize(design.total_size)}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      <footer className="dialog-foot">
        {error && <span className="field-error" role="alert">{error}</span>}
        <button className="btn" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
        <button className="btn btn-accent" disabled={busy || !target} onClick={merge}>{busy ? t('Merging…') : t('Merge files')}</button>
      </footer>
    </Dialog>
  );
}

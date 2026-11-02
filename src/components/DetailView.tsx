import { useEffect, useRef, useState } from 'react';
import { CATEGORY_LABELS, displayExt, isGerber } from '../../shared/formats.ts';
import { api, uploadDesignFile } from '../api.ts';
import { canHaveThumb, regenerateThumb, uploadCustomThumb } from '../thumbs.ts';
import type { Design, DesignFile, Meta } from '../types.ts';
import { DesignViewer } from '../viewers/DesignViewer.tsx';
import { ConfirmDialog, Icon, formatSize } from './ui.tsx';
import { t, typeLabel, isRtl } from '../i18n.ts';

/** What the stage shows: the whole board, the primary file, or one attached file. */
type Selection = 'board' | 'primary' | number;

const selectionOf = (file: DesignFile): Selection => file.id ?? 'primary';

function folderOf(file: DesignFile) {
  const at = file.rel_path.lastIndexOf('/');
  return at < 0 ? '' : file.rel_path.slice(0, at);
}

export function DetailView({ design, meta, onClose, onChange, onDeleted, onFilesChanged, onPrev, onNext, onError }: {
  design: Design;
  meta: Meta;
  onClose: () => void;
  onChange: (design: Design) => void;
  onDeleted: (id: number) => void;
  /** The list of designs changed because a file was added, removed or split off. */
  onFilesChanged: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(design);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [files, setFiles] = useState<DesignFile[] | null>(design.files ?? null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirmFile, setConfirmFile] = useState<DesignFile | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // The form follows the design shown, but a thumbnail update must not discard edits in progress.
  useEffect(() => {
    setDraft(design);
  }, [design.id, design.updated_at]);

  useEffect(() => {
    let cancelled = false;
    setFiles(design.files ?? null);
    api.design(design.id)
      .then((full) => {
        if (!cancelled) setFiles(full.files ?? []);
      })
      .catch((error) => !cancelled && onError(error.message));
    return () => {
      cancelled = true;
    };
  }, [design.id]);

  useEffect(() => {
    setSelection(null);
  }, [design.id]);

  useEffect(() => {
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      const target = event.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key === 'Escape') onClose();
      if (typing) return;
      // Arrow keys follow the visual direction: in RTL the next item sits to the left.
      if (event.key === (isRtl ? 'ArrowLeft' : 'ArrowRight')) onNext?.();
      if (event.key === (isRtl ? 'ArrowRight' : 'ArrowLeft')) onPrev?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNext, onPrev]);

  const project = meta.projects.find((p) => p.id === draft.project_id);
  const dirty =
    draft.name !== design.name ||
    draft.project_id !== design.project_id ||
    draft.product_id !== design.product_id ||
    draft.type_id !== design.type_id ||
    draft.design_date !== design.design_date ||
    draft.notes !== design.notes;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      onChange(await api.updateDesign(design.id, {
        name: draft.name,
        project_id: draft.project_id,
        product_id: draft.product_id,
        type_id: draft.type_id,
        design_date: draft.design_date,
        notes: draft.notes,
      }));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setConfirming(false);
    try {
      await api.deleteDesign(design.id);
      onDeleted(design.id);
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const withThumb = async (work: () => Promise<Design>) => {
    setThumbBusy(true);
    try {
      onChange(await work());
    } catch (error) {
      console.warn(error);
      onError(t('Could not prepare the preview image'));
    } finally {
      setThumbBusy(false);
    }
  };

  const applyFiles = (updated: Design) => {
    setFiles(updated.files ?? []);
    onChange(updated);
    onFilesChanged();
  };

  const addFiles = async (picked: File[]) => {
    try {
      let latest: Design | null = null;
      for (const [index, file] of picked.entries()) {
        setAdding(`${index + 1} / ${picked.length}`);
        const relPath = file.webkitRelativePath || file.name;
        latest = await uploadDesignFile(design.id, file, relPath, () => {}).done;
      }
      if (latest) applyFiles(latest);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setAdding(null);
    }
  };

  const deleteFile = async (file: DesignFile) => {
    setConfirmFile(null);
    try {
      if (selection === file.id) setSelection('primary');
      applyFiles(await api.deleteFile(design.id, file.id as number));
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const splitFile = async (file: DesignFile) => {
    try {
      if (selection === file.id) setSelection('primary');
      applyFiles((await api.splitFile(design.id, file.id as number)).design);
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const known = files ?? [];
  const primaryFile = known[0] ?? null;
  const gerbers = known.filter((file) => isGerber(file.ext));
  const hasBoard = gerbers.length > 1;
  const effective: Selection = selection ?? (hasBoard ? 'board' : 'primary');
  const shownFile = effective === 'board' || effective === 'primary'
    ? primaryFile
    : known.find((file) => file.id === effective) ?? primaryFile;
  const actionFile = shownFile && effective !== 'board' ? shownFile : primaryFile;

  const runOnFile = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const folders = new Map<string, DesignFile[]>();
  for (const file of known) {
    const list = folders.get(folderOf(file)) ?? [];
    list.push(file);
    folders.set(folderOf(file), list);
  }
  const canAuto = canHaveThumb({ ...design, extra_files: Math.max(0, known.length - 1) });

  return (
    <div className="detail" role="dialog" aria-modal="true" aria-label={design.name} ref={root} tabIndex={-1}>
      <div className="detail-stage">
        {shownFile && (
          <DesignViewer
            key={`${design.id}-${effective}`}
            file={shownFile}
            board={effective === 'board' ? gerbers : undefined}
            files={known}
            designId={design.id}
            canOpen={meta.can_open}
          />
        )}
      </div>
      <aside className="detail-panel">
        <header className="detail-nav">
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')}><Icon name="close" /></button>
          <span className="detail-pager">
            <button className="icon-btn" disabled={!onPrev} onClick={onPrev} aria-label={t('Previous')}><Icon name={isRtl ? 'next' : 'prev'} /></button>
            <button className="icon-btn" disabled={!onNext} onClick={onNext} aria-label={t('Next')}><Icon name={isRtl ? 'prev' : 'next'} /></button>
          </span>
        </header>

        <form className="detail-form" onSubmit={save}>
          <label className="field">
            <span className="field-label">{t('Name')}</span>
            <input dir="auto" required className="name-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>

          <div className="spec">
            <span className="ext-badge" dir="ltr">{displayExt(design.ext)}</span>
            <span>{t(CATEGORY_LABELS[design.category])}</span>
            <span className="spec-size" dir="ltr">{formatSize(design.total_size ?? design.size)}</span>
            {known.length > 1 && <span>{t('{n} files', { n: known.length })}</span>}
          </div>
          <p className="original-name" dir="ltr" title={design.original_name}>{design.original_name}</p>

          <label className="field">
            <span className="field-label">{t('Project')}</span>
            <select
              value={draft.project_id}
              onChange={(event) => setDraft({ ...draft, project_id: Number(event.target.value), product_id: null })}
            >
              {meta.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('Product')}</span>
            <select
              value={draft.product_id ?? ''}
              onChange={(event) => setDraft({ ...draft, product_id: event.target.value ? Number(event.target.value) : null })}
            >
              <option value="">{t('No product (general file)')}</option>
              {project?.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('Design type')}</span>
            <select
              value={draft.type_id ?? ''}
              onChange={(event) => setDraft({ ...draft, type_id: event.target.value ? Number(event.target.value) : null })}
            >
              <option value="">{t('No type')}</option>
              {meta.types.map((item) => <option key={item.id} value={item.id}>{typeLabel(item.name)}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('Design date')}</span>
            <input type="date" required value={draft.design_date} onChange={(event) => setDraft({ ...draft, design_date: event.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">{t('Notes')}</span>
            <textarea dir="auto" rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
          </label>

          {dirty && (
            <div className="save-bar">
              <button className="btn btn-accent" disabled={saving}>{saving ? t('Saving…') : t('Save changes')}</button>
              <button type="button" className="btn" onClick={() => setDraft(design)}>{t('Undo')}</button>
            </div>
          )}
        </form>

        {known.length > 1 && (
          <section className="file-list" aria-label={t('Design files')}>
            <h3 className="field-label">{t('Design files')}</h3>
            {hasBoard && (
              <button className={`file-row ${effective === 'board' ? 'active' : ''}`} onClick={() => setSelection('board')}>
                <span className="ext-badge" dir="ltr">PCB</span>
                <span className="file-name">{t('Whole board')}</span>
                <span className="file-size" dir="ltr">{gerbers.length} layers</span>
              </button>
            )}
            {[...folders.entries()].map(([folder, list]) => (
              <div key={folder} className="file-folder">
                {folder && <p className="file-folder-name" dir="ltr" title={folder}>{folder}</p>}
                {list.map((file) => {
                  const key = selectionOf(file);
                  return (
                    <div key={String(key)} className={`file-row-wrap ${effective === key ? 'active' : ''}`}>
                      <button className="file-row" onClick={() => setSelection(key)}>
                        <span className="ext-badge" dir="ltr">{file.ext.toUpperCase() || 'FILE'}</span>
                        <span className="file-name" dir="ltr" title={file.name}>{file.name}</span>
                        <span className="file-size" dir="ltr">{formatSize(file.size)}</span>
                      </button>
                      {file.id !== null && (
                        <span className="file-actions">
                          <button className="icon-btn" aria-label={t('Split {name} into its own design', { name: file.name })} title={t('Split into its own design')} onClick={() => splitFile(file)}><Icon name="split" size={15} /></button>
                          <button className="icon-btn" aria-label={t('Delete {name}', { name: file.name })} title={t('Delete file')} onClick={() => setConfirmFile(file)}><Icon name="trash" size={15} /></button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        )}

        <div className="detail-actions">
          {meta.can_open && actionFile && (
            <button
              className="btn btn-ink"
              title={t('Opens the copy in the library, so saving in that program changes it')}
              onClick={() => runOnFile(() => api.openFile(design.id, actionFile.id))}
            >
              <Icon name="open" />{t('Open in its program')}</button>
          )}
          <div className="action-pair">
            {actionFile && <a className="btn" href={`${actionFile.url}?download=1`}><Icon name="download" />{t('Download')}</a>}
            {meta.can_open && actionFile && (
              <button className="btn" onClick={() => runOnFile(() => api.revealFile(design.id, actionFile.id))}>
                <Icon name="folder" />{t('Show in folder')}</button>
            )}
          </div>
          {known.length > 1 && effective !== 'board' && actionFile && (
            <p className="hint action-target" dir="ltr" title={actionFile.name}>{actionFile.name}</p>
          )}

          <div className="cover-row">
            <span className="field-label">{t('More files')}</span>
            <div>
              <button className="link-btn" disabled={Boolean(adding)} onClick={() => addInput.current?.click()}>
                {adding ? t('Uploading {progress}', { progress: adding }) : t('Add files')}
              </button>
            </div>
            <input
              ref={addInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const picked = [...(event.target.files ?? [])];
                event.target.value = '';
                if (picked.length) void addFiles(picked);
              }}
            />
          </div>

          <div className="cover-row">
            <span className="field-label">{t('Preview image')}</span>
            <div>
              <button className="link-btn" disabled={thumbBusy} onClick={() => coverInput.current?.click()}>{t('Upload image')}</button>
              {canAuto && (
                <button className="link-btn" disabled={thumbBusy} onClick={() => withThumb(() => regenerateThumb({ ...design, extra_files: Math.max(0, known.length - 1) }))}>{t('Auto-generate')}</button>
              )}
            </div>
            <input
              ref={coverInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void withThumb(() => uploadCustomThumb(design, file));
              }}
            />
          </div>

          <button className="btn btn-quiet-danger" onClick={() => setConfirming(true)}><Icon name="trash" />{t('Delete')}</button>
        </div>
      </aside>

      {confirming && (
        <ConfirmDialog
          title={t('Delete design')}
          message={known.length > 1
            ? t('"{name}" and its {n} files will be permanently deleted. This cannot be undone.', { name: design.name, n: known.length })
            : t('"{name}" and its file will be permanently deleted. This cannot be undone.', { name: design.name })}
          confirmLabel={t('Delete permanently')}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
      {confirmFile && (
        <ConfirmDialog
          title={t('Delete file')}
          message={t('"{name}" will be permanently deleted from this design. This cannot be undone.', { name: confirmFile.name })}
          confirmLabel={t('Delete permanently')}
          onConfirm={() => deleteFile(confirmFile)}
          onCancel={() => setConfirmFile(null)}
        />
      )}
    </div>
  );
}

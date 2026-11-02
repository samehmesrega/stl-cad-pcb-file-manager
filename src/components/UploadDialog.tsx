import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_LABELS, detectGrouping, displayExt, extensionOf, formatOf, groupPaths } from '../../shared/formats.ts';
import type { Grouping } from '../../shared/formats.ts';
import { api, uploadDesign, uploadDesignFile } from '../api.ts';
import type { Filters, Meta } from '../types.ts';
import { prepareSources, sourcesFromDrop, sourcesFromFiles } from '../uploadSources.ts';
import type { UploadSource } from '../uploadSources.ts';
import { Dialog, Icon, PickOrCreate, formatSize, toLocalDate } from './ui.tsx';
import { t, plural, typeLabel } from '../i18n.ts';

interface Entry {
  key: string;
  defaultName: string;
  /** The primary file comes first. */
  files: { source: UploadSource; rel: string }[];
  size: number;
}

interface EntryState {
  status: 'waiting' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
  /** Lets a retry continue a design whose first files already arrived. */
  designId?: number;
  sent?: number;
  duplicates?: number;
}

const CONCURRENCY = 2;

const VIEW_LABELS: Record<string, string> = {
  model: t('3D preview'),
  scad: t('3D preview'),
  drawing: t('2D preview'),
  toolpath: t('Toolpath preview'),
  image: t('Image preview'),
  pdf: t('Page preview'),
  text: t('Text preview'),
  embedded: t('Thumbnail preview'),
  gerber: t('Board preview'),
  kicad: t('KiCad preview'),
  none: t('Stored only'),
};

export function UploadDialog({ meta, filters, initialSources, onClose, onUploaded, onMetaChange }: {
  meta: Meta;
  filters: Filters;
  initialSources: UploadSource[];
  onClose: () => void;
  onUploaded: (count: number, duplicates: number) => void;
  onMetaChange: () => Promise<void>;
}) {
  const [sources, setSources] = useState<UploadSource[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [grouping, setGrouping] = useState<Grouping>('separate');
  const [groupingChosen, setGroupingChosen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, EntryState>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [preparing, setPreparing] = useState(false);
  const [projectId, setProjectId] = useState(filters.project ? String(filters.project) : '');
  const [productId, setProductId] = useState(typeof filters.product === 'number' ? String(filters.product) : '');
  const [typeId, setTypeId] = useState('auto');
  const [dateMode, setDateMode] = useState<'file' | 'custom'>('file');
  const [customDate, setCustomDate] = useState(toLocalDate(new Date()));
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const aborters = useRef(new Set<() => void>());
  const cancelled = useRef(false);

  const addSources = async (raw: UploadSource[]) => {
    setPreparing(true);
    setMessage('');
    try {
      const prepared = await prepareSources(raw);
      setSources((current) => [...current, ...prepared.sources]);
      setSkipped((current) => current + prepared.skipped);
    } finally {
      setPreparing(false);
    }
  };

  useEffect(() => {
    if (initialSources.length) void addSources(initialSources);
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
    if (!groupingChosen) setGrouping(detectGrouping(sources.map((source) => source.path)));
  }, [sources, groupingChosen]);

  const entries = useMemo<Entry[]>(() => {
    const groups = groupPaths(sources.map((source) => source.path), grouping);
    return groups.map((group) => {
      // A file with nothing in it cannot be stored. In a group, that must not stop the files next to it.
      const present = group.files.length > 1 ? group.files.filter(({ index }) => sources[index].file.size > 0) : group.files;
      const files = (present.length ? present : group.files).map(({ index, rel }) => ({ source: sources[index], rel }));
      return {
        key: `${grouping}:${group.name}:${files[0].source.path}`,
        defaultName: group.name,
        files,
        size: files.reduce((sum, { source }) => sum + source.file.size, 0),
      };
    }).filter((entry) => !removed.has(entry.key));
  }, [sources, grouping, removed]);

  const stateOf = (entry: Entry): EntryState => states[entry.key] ?? { status: 'waiting', progress: 0 };
  const nameOf = (entry: Entry) => names[entry.key] ?? entry.defaultName;
  const project = meta.projects.find((p) => String(p.id) === projectId);
  const pendingCount = entries.filter((entry) => ['waiting', 'error'].includes(stateOf(entry).status)).length;
  const doneCount = entries.filter((entry) => stateOf(entry).status === 'done').length;
  const hasFolders = sources.some((source) => source.path.split('/').length > 2);
  const started = Object.keys(states).length > 0;

  const patchState = (key: string, patch: Partial<EntryState>) => {
    setStates((current) => ({ ...current, [key]: { ...(current[key] ?? { status: 'waiting', progress: 0 }), ...patch } }));
  };

  const uploadEntry = async (entry: Entry, resume: EntryState) => {
    const grouped = entry.files.length > 1;
    let designId = resume.designId;
    let sent = resume.sent ?? 0;
    let sentBytes = entry.files.slice(0, sent).reduce((sum, { source }) => sum + source.file.size, 0);
    let duplicates = resume.duplicates ?? 0;
    for (let index = sent; index < entry.files.length; index++) {
      const { source, rel } = entry.files[index];
      const onProgress = (fraction: number) => patchState(entry.key, { progress: (sentBytes + fraction * source.file.size) / entry.size });
      const { done, abort } = designId
        ? uploadDesignFile(designId, source.file, rel, onProgress)
        : uploadDesign(
          source.file,
          {
            project_id: Number(projectId),
            product_id: productId ? Number(productId) : null,
            type_id: typeId,
            design_date: dateMode === 'custom' ? customDate : toLocalDate(new Date(source.file.lastModified)),
            name: nameOf(entry),
            rel_path: grouped ? rel : undefined,
          },
          onProgress,
        );
      aborters.current.add(abort);
      try {
        const design = await done;
        designId = design.id;
        sent = index + 1;
        sentBytes += source.file.size;
        if (design.duplicate_of) duplicates++;
        patchState(entry.key, { designId, sent, duplicates });
      } finally {
        aborters.current.delete(abort);
      }
      if (cancelled.current && sent < entry.files.length) throw new Error(t('Cancelled'));
    }
    return duplicates;
  };

  const start = async () => {
    if (!projectId) {
      setMessage(t('Choose a project first.'));
      return;
    }
    setRunning(true);
    setMessage('');
    cancelled.current = false;
    const work = entries.filter((entry) => ['waiting', 'error'].includes(stateOf(entry).status));
    let done = 0;
    let duplicates = 0;
    let index = 0;

    const runner = async () => {
      while (index < work.length && !cancelled.current) {
        const entry = work[index++];
        const resume = stateOf(entry);
        patchState(entry.key, { status: 'uploading', progress: 0, error: undefined });
        try {
          duplicates += await uploadEntry(entry, resume);
          done++;
          patchState(entry.key, { status: 'done', progress: 1 });
        } catch (error) {
          patchState(entry.key, { status: 'error', error: (error as Error).message });
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, runner));
    setRunning(false);
    if (done) onUploaded(done, duplicates);
    if (done === work.length && !cancelled.current) onClose();
  };

  const cancel = () => {
    cancelled.current = true;
    for (const abort of aborters.current) abort();
  };

  return (
    <Dialog title={t('Add designs')} onClose={onClose} wide locked={running}>
      <div className="upload-layout">
        <div className="upload-files">
          <div
            className={`dropzone ${dragOver ? 'over' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDragOver(false);
              void sourcesFromDrop(event.dataTransfer).then(addSources);
            }}
          >
            <Icon name="upload" size={26} />
            <p>{t('Drag files or folders here')}</p>
            <div className="dropzone-actions">
              <button type="button" className="btn" disabled={running} onClick={() => fileInput.current?.click()}>{t('Choose files')}</button>
              <button type="button" className="btn" disabled={running} onClick={() => folderInput.current?.click()}>{t('Choose folder')}</button>
            </div>
            <p className="hint">{t('Any format is accepted: STL, STEP, DXF, DWG, G-code, RD, Gerber, KiCad and more')}</p>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) void addSources(sourcesFromFiles(event.target.files));
                event.target.value = '';
              }}
            />
            <input
              ref={folderInput}
              type="file"
              hidden
              onChange={(event) => {
                if (event.target.files) void addSources(sourcesFromFiles(event.target.files));
                event.target.value = '';
              }}
            />
          </div>

          {sources.length > 1 && (
            <fieldset className="field grouping" disabled={running || started}>
              <legend className="field-label">{t('How should the files be grouped?')}</legend>
              {([
                ['separate', t('Each file is its own design')],
                ['one', hasFolders ? t('Each chosen folder is one design') : t('All in one design')],
                ...(hasFolders ? [['sub', t('Each subfolder is one design')]] : []),
              ] as [Grouping, string][]).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="grouping"
                    checked={grouping === value}
                    onChange={() => {
                      setGrouping(value);
                      setGroupingChosen(true);
                    }}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          )}
          {preparing && <p className="hint">{t('Preparing files…')}</p>}
          {skipped > 0 && <p className="hint">{plural(skipped, 'Skipped {n} file that KiCad generates automatically (backups and cache).', 'Skipped {n} files that KiCad generates automatically (backups and cache).')}</p>}

          {entries.length > 0 && (
            <ul className="queue">
              {entries.map((entry) => {
                const state = stateOf(entry);
                const primary = entry.files[0].source.file;
                const ext = extensionOf(primary.name);
                const format = formatOf(ext);
                return (
                  <li key={entry.key} className={`queue-item ${state.status}`}>
                    <span className="ext-badge" dir="ltr">{displayExt(ext)}</span>
                    <div className="queue-main">
                      <input
                        dir="auto"
                        value={nameOf(entry)}
                        disabled={state.status !== 'waiting' || started}
                        aria-label={t('Design name')}
                        onChange={(event) => setNames({ ...names, [entry.key]: event.target.value })}
                      />
                      <span className="queue-meta">
                        {state.error ? (
                          <span className="field-error">{state.error}</span>
                        ) : state.status === 'done' ? (
                          t('Uploaded')
                        ) : (
                          <>
                            <span dir="ltr">{formatSize(entry.size)}</span>
                            {entry.files.length > 1 && <> · {t('{n} files', { n: entry.files.length })}</>}
                            {' · '}{t(CATEGORY_LABELS[format.category])} · {VIEW_LABELS[format.viewer]}
                          </>
                        )}
                      </span>
                      {state.status === 'uploading' && (
                        <span className="progress"><i style={{ width: `${state.progress * 100}%` }} /></span>
                      )}
                    </div>
                    {!running && state.status !== 'done' && !state.designId && (
                      <button
                        className="icon-btn"
                        aria-label={t('Remove {name}', { name: nameOf(entry) })}
                        onClick={() => setRemoved(new Set(removed).add(entry.key))}
                      >
                        <Icon name="close" size={15} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="upload-meta">
          <PickOrCreate
            label={t('Project')}
            value={projectId}
            options={meta.projects.map((p) => ({ value: String(p.id), label: p.name }))}
            emptyLabel={t('Choose a project')}
            addLabel={t('New project')}
            disabled={running}
            onChange={(value) => {
              setProjectId(value);
              setProductId('');
            }}
            onCreate={async (name) => {
              const created = await api.createProject(name);
              await onMetaChange();
              return String(created.id);
            }}
          />
          <PickOrCreate
            label={t('Product')}
            value={productId}
            options={(project?.products ?? []).map((p) => ({ value: String(p.id), label: p.name }))}
            emptyLabel={t('No product (general file)')}
            addLabel={t('New product')}
            disabled={running || !projectId}
            onChange={setProductId}
            onCreate={projectId ? async (name) => {
              const created = await api.createProduct(Number(projectId), name);
              await onMetaChange();
              return String(created.id);
            } : undefined}
          />
          <PickOrCreate
            label={t('Design type')}
            value={typeId}
            options={[
              { value: 'auto', label: t('Automatic, from the file format') },
              ...meta.types.map((item) => ({ value: String(item.id), label: typeLabel(item.name) })),
              { value: 'none', label: t('No type') },
            ]}
            addLabel={t('New type')}
            disabled={running}
            onChange={setTypeId}
            onCreate={async (name) => {
              const created = await api.createType(name);
              await onMetaChange();
              return String(created.id);
            }}
          />
          <fieldset className="field date-mode" disabled={running}>
            <legend className="field-label">{t('Design date')}</legend>
            <label>
              <input type="radio" name="date-mode" checked={dateMode === 'file'} onChange={() => setDateMode('file')} />{t('Last modified date of each file')}</label>
            <label>
              <input type="radio" name="date-mode" checked={dateMode === 'custom'} onChange={() => setDateMode('custom')} />{t('One date for all')}</label>
            {dateMode === 'custom' && (
              <input type="date" value={customDate} aria-label={t('Date')} onChange={(event) => setCustomDate(event.target.value)} />
            )}
          </fieldset>
        </div>
      </div>

      <footer className="dialog-foot">
        {message && <span className="field-error" role="alert">{message}</span>}
        {doneCount > 0 && !running && <span className="queue-summary">{t('{n} uploaded', { n: doneCount })}</span>}
        {running ? (
          <button className="btn" onClick={cancel}>{t('Cancel upload')}</button>
        ) : (
          <button className="btn" onClick={onClose}>{t('Close')}</button>
        )}
        <button className="btn btn-accent" disabled={running || preparing || !pendingCount} onClick={start}>
          {running ? t('Uploading…') : pendingCount === 1 ? t('Upload 1 design') : pendingCount ? t('Upload {n} designs', { n: pendingCount }) : t('Upload')}
        </button>
      </footer>
    </Dialog>
  );
}

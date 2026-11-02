// Formats the browser cannot show on its own are decoded to a blob URL, so everything uses the same image stage.
import { fetchBuffer } from './parseClient.ts';
import { msg } from '../../shared/i18n.ts';

function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error(msg('Could not display the image')))), 'image/png');
  });
}

async function decodeTiff(buffer: ArrayBuffer): Promise<string> {
  const UTIF = (await import('utif2')).default;
  const pages = UTIF.decode(buffer);
  if (!pages.length) throw new Error(msg('This TIFF file is empty'));
  UTIF.decodeImage(buffer, pages[0]);
  const rgba = UTIF.toRGBA8(pages[0]);
  const canvas = document.createElement('canvas');
  canvas.width = pages[0].width;
  canvas.height = pages[0].height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), pages[0].width, pages[0].height), 0, 0);
  return canvasToUrl(canvas);
}

async function decodePsd(buffer: ArrayBuffer): Promise<string> {
  const { readPsd } = await import('ag-psd');
  const psd = readPsd(buffer, { skipLayerImageData: true, skipThumbnail: true });
  if (!psd.canvas) throw new Error(msg('This PSD file has no composite image. Save it with Maximize Compatibility.'));
  return canvasToUrl(psd.canvas);
}

/** CorelDRAW X4 and later is a zip with a small preview inside. */
async function extractCdrPreview(buffer: ArrayBuffer): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((entry) => /(preview|thumbnail)[^/]*\.(png|jpe?g|bmp)$/i.test(entry.name));
  if (!entries.length) throw new Error(msg('This file has no preview image'));
  const blobs = await Promise.all(entries.map((entry) => entry.async('blob')));
  const largest = blobs.reduce((a, b) => (b.size > a.size ? b : a));
  const type = /\.png$/i.test(entries[blobs.indexOf(largest)].name) ? 'image/png' : 'image/jpeg';
  return URL.createObjectURL(new Blob([largest], { type }));
}

/** Slicers store a rendered picture inside 3MF files, which is far quicker to read than the model itself. */
export async function extract3mfPreview(buffer: ArrayBuffer): Promise<Blob | null> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  const name =
    names.find((n) => /metadata\/plate_1\.png$/i.test(n)) ??
    names.find((n) => /thumbnail_3mf\.png$/i.test(n)) ??
    names.find((n) => /metadata\/thumbnail\.png$/i.test(n)) ??
    names.find((n) => /thumbnail[^/]*\.(png|jpe?g)$/i.test(n));
  if (!name) return null;
  const blob = await zip.files[name].async('blob');
  return new Blob([blob], { type: /\.png$/i.test(name) ? 'image/png' : 'image/jpeg' });
}

/** Returns a URL for an <img>, and whether it must be revoked afterwards. */
export async function resolveImage(url: string, ext: string): Promise<{ src: string; revoke: boolean }> {
  if (ext === 'tif' || ext === 'tiff') return { src: await decodeTiff(await fetchBuffer(url)), revoke: true };
  if (ext === 'psd') return { src: await decodePsd(await fetchBuffer(url)), revoke: true };
  if (ext === 'cdr') return { src: await extractCdrPreview(await fetchBuffer(url)), revoke: true };
  return { src: url, revoke: false };
}

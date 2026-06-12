// Self-contained xlsx export. Decoupled from the Ad model: the caller maps its rows to
// plain {key: text} records plus an optional image/link per row, so this module only knows
// about columns and cells. ExcelJS is dynamically imported so its weight stays out of the
// main bundle until the user actually exports.

type XlsxColumnKind = 'text' | 'image' | 'link';

export type XlsxColumn = {
  key: string;
  header: string;
  /** Excel column width units (≈ characters). */
  width: number;
  kind?: XlsxColumnKind;
};

export type XlsxRow = {
  /** Display text per column key. For a link column this is the visible label. */
  values: Record<string, string>;
  /** Source URL for the image column (fetched through `resolveImage`). */
  imageUrl?: string | null;
  /** Hyperlink target for the link column. */
  linkUrl?: string | null;
};

export type ExportToXlsxOptions = {
  fileName: string;
  sheetName?: string;
  columns: XlsxColumn[];
  rows: XlsxRow[];
  /** Returns raw image bytes for a URL, or null if it can't be fetched. */
  resolveImage?: (url: string) => Promise<ArrayBuffer | null>;
  /** Reports image-resolution progress (done/total). */
  onProgress?: (done: number, total: number) => void;
  /** Max embedded thumbnail box in px (aspect ratio preserved). */
  imageBox?: { width: number; height: number };
};

type EmbeddableImage = {
  data: ArrayBuffer;
  extension: 'jpeg' | 'png' | 'gif';
  width: number;
  height: number;
};

const headerFillArgb = 'FFEDF2F5';
const headerTextArgb = 'FF172026';
const linkArgb = 'FF1769E0';
const pxPerExcelWidth = 7;
const pxToPoints = 0.75;

// ExcelJS embeds only jpeg/png/gif. Sniff the format from magic bytes; anything else
// (e.g. webp) gets transcoded to png via canvas below.
function sniffExtension(bytes: Uint8Array): EmbeddableImage['extension'] | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  return null;
}

function loadImageElement(url: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function toEmbeddableImage(buffer: ArrayBuffer): Promise<EmbeddableImage | null> {
  const sniffed = sniffExtension(new Uint8Array(buffer));
  // Blob URLs are same-origin, so drawing to canvas never taints it — safe transcoding.
  const objectUrl = URL.createObjectURL(new Blob([buffer]));
  try {
    const image = await loadImageElement(objectUrl);
    if (!image || !image.naturalWidth || !image.naturalHeight) return null;
    const width = image.naturalWidth;
    const height = image.naturalHeight;

    if (sniffed) return { data: buffer, extension: sniffed, width, height };

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0);
    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) return null;
    return { data: await pngBlob.arrayBuffer(), extension: 'png', width, height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function exportToXlsx(options: ExportToXlsxOptions): Promise<void> {
  const { Workbook } = await import('exceljs');
  const imageBox = options.imageBox ?? { width: 120, height: 120 };
  const imageColumn = options.columns.find((column) => column.kind === 'image');
  const linkColumn = options.columns.find((column) => column.kind === 'link');

  const workbook = new Workbook();
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet(options.sheetName ?? 'Объявления', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  worksheet.columns = options.columns.map((column) => ({
    key: column.key,
    header: column.header,
    width: column.width
  }));

  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: headerTextArgb } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerFillArgb } };
  headerRow.alignment = { vertical: 'middle' };
  headerRow.height = 22;

  // Resolve all images up front (bounded concurrency) so each row can be sized to its image.
  const total = options.rows.length;
  let done = 0;
  const images: Array<EmbeddableImage | null> = imageColumn
    ? await mapWithConcurrency(options.rows, 6, async (row) => {
        let embeddable: EmbeddableImage | null = null;
        if (row.imageUrl && options.resolveImage) {
          const buffer = await options.resolveImage(row.imageUrl).catch(() => null);
          if (buffer) embeddable = await toEmbeddableImage(buffer);
        }
        done += 1;
        options.onProgress?.(done, total);
        return embeddable;
      })
    : [];

  const imageColumnIndex = imageColumn ? options.columns.findIndex((column) => column.key === imageColumn.key) : -1;

  options.rows.forEach((row, rowIndex) => {
    const excelRow = worksheet.addRow(row.values);
    excelRow.alignment = { vertical: 'top', wrapText: true };

    if (linkColumn && row.linkUrl) {
      const cell = excelRow.getCell(linkColumn.key);
      cell.value = { text: row.values[linkColumn.key] || row.linkUrl, hyperlink: row.linkUrl };
      cell.font = { color: { argb: linkArgb }, underline: true };
    }

    const image = images[rowIndex];
    if (image && imageColumnIndex >= 0) {
      const scale = Math.min(imageBox.width / image.width, imageBox.height / image.height, 1);
      const drawWidth = Math.max(1, Math.round(image.width * scale));
      const drawHeight = Math.max(1, Math.round(image.height * scale));
      const base64 = `data:image/${image.extension};base64,${arrayBufferToBase64(image.data)}`;
      const imageId = workbook.addImage({ base64, extension: image.extension });
      // tl uses 0-based fractional indices; +1 skips the header row, small offset adds padding.
      worksheet.addImage(imageId, {
        tl: { col: imageColumnIndex + 0.15, row: rowIndex + 1 + 0.1 },
        ext: { width: drawWidth, height: drawHeight }
      });
      excelRow.height = Math.max(drawHeight * pxToPoints + 8, 20);
      // Widen the image column if the thumbnail is wider than the configured column.
      const neededWidth = Math.ceil(drawWidth / pxPerExcelWidth) + 2;
      const column = worksheet.getColumn(imageColumn!.key);
      if ((column.width ?? 0) < neededWidth) column.width = neededWidth;
    } else {
      excelRow.height = 20;
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  triggerDownload(
    new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    options.fileName
  );
}

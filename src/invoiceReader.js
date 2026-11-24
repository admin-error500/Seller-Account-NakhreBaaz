import {parseInvoice} from './invoiceParser.js';
export {parseInvoice};

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 20;

export function invoiceFileType(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const mime = {pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp'}[extension];
  if (!mime || (file.type && file.type !== mime && file.type !== 'application/octet-stream')) {
    throw Error('Choose a PDF, JPG, PNG or WebP invoice.');
  }
  if (!file.size || file.size > MAX_BYTES) throw Error('Invoice files must be between 1 byte and 10 MB.');
  return mime;
}

function pdfText(items) {
  const rows = new Map();
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const [, , , , x, y] = item.transform;
    const row = Math.round(y / 3) * 3;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push([x, item.str]);
  }
  return [...rows].sort(([a], [b]) => b - a)
    .map(([, items]) => items.sort(([a], [b]) => a - b).map(([, content]) => content).join(' ')).join('\n');
}

function sellerColumnText(items) {
  const seller = items.find(item => /^sold[ \t]+by\s*:/i.test(item.str?.trim()));
  if (!seller) return '';
  const [, , , , x, y] = seller.transform;
  const billing = items.find(item => /^billing[ \t]+address\s*:/i.test(item.str?.trim())
    && item.transform[4] > x && Math.abs(item.transform[5]-y) < 6);
  if (!billing) return '';
  const right = (x + billing.transform[4]) / 2;
  return pdfText(items.filter(item => {
    const [, , , , left, baseline] = item.transform;
    return left >= x-3 && left < right && baseline <= y+3 && baseline >= y-130;
  }));
}

export async function readInvoice(file) {
  const type = invoiceFileType(file);
  let workerPromise;
  async function recognize(image) {
    workerPromise ??= import('./invoiceOcr.js').then(module => module.createInvoiceOcr());
    const worker = await workerPromise;
    return (await worker.recognize(image)).data.text;
  }
  try {
    if (type !== 'application/pdf') return parseInvoice(await recognize(file));
    const [{getDocument, GlobalWorkerOptions}, {default: workerUrl}] = await Promise.all([
      import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ]);
    GlobalWorkerOptions.workerSrc = workerUrl;
    const task = getDocument({data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false});
    try {
      const doc = await task.promise;
      if (doc.numPages > MAX_PAGES) throw Error('Automatic reading supports invoices up to 20 pages.');
      const pages = [];
      let sellerColumn = '';
      for (let index = 1; index <= doc.numPages; index++) {
        const page = await doc.getPage(index);
        const {items} = await page.getTextContent();
        sellerColumn ||= sellerColumnText(items);
        const content = pdfText(items);
        if ((content.match(/[A-Za-z0-9]/g)?.length ?? 0) >= 50) {
          pages.push(content);
          continue;
        }
        const base = page.getViewport({scale: 1});
        const viewport = page.getViewport({scale: Math.min(2.5, 2400 / Math.max(base.width, base.height))});
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        try {
          await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
          pages.push(await recognize(canvas));
        } finally {
          canvas.width = canvas.height = 0;
        }
      }
      return parseInvoice(pages.join('\n'), sellerColumn);
    } finally {
      await task.destroy();
    }
  } finally {
    if (workerPromise) await workerPromise.then(worker => worker.terminate(), () => {});
  }
}

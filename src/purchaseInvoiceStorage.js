import {supabase} from './supabase.js';
import {invoiceFileType} from './invoiceReader.js';
import {normalizeInvoiceKey, verifyInvoice} from './purchaseReconciliation.js';

const bucket = () => supabase.storage.from('purchase-invoices');

export async function prepareInvoices(lines, existing = []) {
  const list = existing.slice();
  for (const line of lines) {
    const invoice = verifyInvoice(line);
    if (line.file) {
      const type = invoiceFileType(line.file);
      const digest = await crypto.subtle.digest('SHA-256', await line.file.arrayBuffer());
      invoice.sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (line.path) invoice.path = null;
      invoice.upload = {file: line.file, type};
    }
    if (line.legacyIndex != null) list[line.legacyIndex] = invoice;
    else list.push(invoice);
  }
  const keys = new Set();
  for (const invoice of list) {
    if (!invoice.verified) continue;
    const reference = normalizeInvoiceKey(invoice.reference);
    const identity = [
      JSON.stringify(['supplier', normalizeInvoiceKey(invoice.supplier), reference]),
      invoice.gstin && JSON.stringify(['gstin', normalizeInvoiceKey(invoice.gstin), reference]),
      invoice.sha256 && 'file:' + invoice.sha256
    ].filter(Boolean);
    if (identity.some(key => keys.has(key))) throw Error('This invoice is already listed on the purchase.');
    for (const key of identity) keys.add(key);
  }
  return list;
}

export async function uploadInvoices(invoices, userId, uploaded) {
  const saved = [];
  for (const {upload, ...invoice} of invoices) {
    if (upload) {
      const path = userId + '/' + crypto.randomUUID() + '-' + upload.file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
      const {error} = await bucket().upload(path, upload.file, {contentType: upload.type, upsert: false});
      if (error) throw error;
      uploaded.push(path);
      invoice.path = path;
    }
    saved.push(invoice);
  }
  return saved;
}

export async function discardInvoiceUploads(paths) {
  if (paths.length) await bucket().remove(paths);
}

export function invoiceSaveError(error) {
  return error.code === '23505' && /duplicate invoice|purchase_invoice_keys/i.test(error.message)
    ? 'This invoice number or file is already recorded on a purchase.'
    : error.message;
}

export function isDefinitiveWriteError(error) {
  // SQLSTATE indicates the transaction rejected the write. A transport failure may occur after commit.
  return /^[0-9A-Z]{5}$/.test(error.code ?? '');
}

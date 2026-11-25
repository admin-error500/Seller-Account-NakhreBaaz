import {normalizeInvoiceKey} from './purchaseReconciliation.js';

const requiredFields = [
  ['supplier','supplier name'],['reference','invoice number'],['amount','invoice total'],['gst','GST'],
];
const missing = (invoice,key) => invoice[key]==null || invoice[key]==='';

export function missingInvoiceFields(invoice) {
  return requiredFields.filter(([key])=>missing(invoice,key)).map(([,label])=>label);
}

export function mergeInvoiceReads(primary, fallback) {
  if (primary.documentType==='quotation') return primary;
  const sameReference = missing(primary,'reference') || missing(fallback,'reference') ||
    normalizeInvoiceKey(primary.reference)===normalizeInvoiceKey(fallback.reference);
  const sameAmount = missing(primary,'amount') || missing(fallback,'amount') || primary.amount===fallback.amount;
  if (!sameReference || !sameAmount) return primary;
  if (fallback.documentType==='quotation'||missingInvoiceFields(primary).length===requiredFields.length) return fallback;
  const result={...primary};
  for (const [key,value] of Object.entries(fallback)) {
    if (missing(primary,key)&&!missing(fallback,key)) result[key]=value;
  }
  if (!primary.product&&fallback.product&&fallback.kind==='Fee') result.kind='Fee';
  if (fallback.multipleProducts) result.multipleProducts=true;
  // The OCR tax must belong to the same grand total.
  if (missing(primary,'gst') && fallback.amount==null) result.gst=null;
  return result;
}

import {purchasePages,normalizeInvoiceKey} from './purchaseReconciliation.js';

export function invoiceAttachment(row, invoice) {
  if (invoice.path) return invoice.path;
  if (row.invoice&&normalizeInvoiceKey(row.invoice)===normalizeInvoiceKey(invoice.reference)) return row.invoicePath;
}

export function invoiceLinksForCsv(category, row, baseUrl) {
  const documents = (row.invoiceDetails??[]).flatMap((invoice,index)=>
    invoiceAttachment(row,invoice)?[{index,reference:invoice.reference,path:invoiceAttachment(row,invoice)}]:[]);
  if (row.invoicePath&&!documents.some(document=>document.path===row.invoicePath)) {
    documents.push({index:'legacy',reference:row.invoice,path:row.invoicePath});
  }
  return Object.fromEntries(documents.map(({index,reference},column)=>{
    const url = new URL(baseUrl);
    url.search = new URLSearchParams({
      invoiceType:category, entry:row.id, invoice:String(index), reference:reference??'',
    }).toString();
    url.hash = '';
    return [`invoice_link_${column+1}`,url.href];
  }));
}

export function linkedInvoicePath(data, url) {
  const category = url.searchParams.get('invoiceType');
  const id = url.searchParams.get('entry');
  const index = url.searchParams.get('invoice');
  const reference = url.searchParams.get('reference')??'';
  if (!purchasePages.includes(category)||!id||!(index==='legacy'||/^\d+$/.test(index??''))) return null;
  const row = data[category].find(entry=>String(entry.id)===id);
  if (!row) return null;
  if (index==='legacy') return (row.invoice??'')===reference?row.invoicePath:null;
  const invoice = row.invoiceDetails?.[Number(index)];
  if (!invoice||(invoice.reference??'')!==reference) return null;
  return invoiceAttachment(row,invoice);
}

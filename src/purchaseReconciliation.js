export const purchasePages = ['purchases', 'materialPurchases', 'equipmentPurchases'];
export const number = value => Number(value) || 0;
const paise = amount => Math.round((number(amount) + Number.EPSILON) * 100);
export const money = amount => paise(amount) / 100;

export function taxDetails(qty, unit, rate, inclusive) {
  const amount = money(number(qty) * number(unit));
  const base = money(inclusive ? amount / (1 + number(rate) / 100) : amount);
  const tax = money(inclusive ? amount - base : base * number(rate) / 100);
  return {base, tax, total: money(base + tax)};
}

export function isDocumented(invoice) {
  return invoice.verified === true || (invoice.kind === 'Fee' && number(invoice.amount) > 0);
}

export function purchaseDetails(purchase) {
  const invoices = purchase.invoiceDetails ?? [];
  const fees = invoices.filter(invoice => invoice.kind === 'Fee');
  const product = taxDetails(purchase.qty, purchase.rate, purchase.gstRate,
    purchase.gstInclusive === true || purchase.gstInclusive === 'Yes');
  const legacyPaid = money(product.total + fees.reduce((sum, fee) => sum + number(fee.amount), 0)
    - number(purchase.purchaseDiscount) - number(purchase.rewardsUsed));
  const hasActualPayment = purchase.actualPayment != null && purchase.actualPayment !== '';
  const paid = hasActualPayment ? money(purchase.actualPayment) : legacyPaid;
  const documents = invoices.filter(isDocumented);
  const total = documents.reduce((sum, invoice) => sum + paise(invoice.amount), 0);
  const tax = documents.reduce((sum, invoice) => sum + paise(invoice.gst), 0);
  const balance = paise(paid) - total;
  const advanceApplied = paise(purchase.advanceApplied);
  const due = advanceApplied > 0 ? Math.max(total - paise(paid) - advanceApplied, 0) : 0;
  const status = advanceApplied > 0 ? (due > 0 ? 'Invoice verified' : 'Reconciled')
    : balance < 0 ? 'Mismatch'
    : documents.length === 0 ? 'Pending'
      : balance === 0 ? 'Reconciled' : 'Partially received';
  return {
    paid, hasActualPayment, invoiceTotal: total / 100, tax: tax / 100, status,
    pending: advanceApplied > 0 ? 0 : Math.max(balance, 0) / 100,
    mismatch: advanceApplied > 0 ? 0 : Math.max(-balance, 0) / 100,
    ...(advanceApplied > 0 && {advanceApplied: advanceApplied / 100, due: due / 100}),
    recordedTax: hasActualPayment ? tax / 100
      : money(product.tax + fees.reduce((sum, fee) => sum + number(fee.gst), 0)),
  };
}

export function purchaseTotals(rows) {
  const totals = {paid: 0, invoiceTotal: 0, tax: 0, recordedTax: 0, pending: 0, mismatch: 0};
  for (const row of rows) {
    const details = purchaseDetails(row);
    for (const key of Object.keys(totals)) totals[key] += paise(details[key]);
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / 100]));
}

export function parseMoney(value, label) {
  const text = String(value ?? '').trim();
  const amount = Number(text);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(amount) || amount >= 1e12) {
    throw Error(`Enter a valid ${label} in rupees with up to two decimal places.`);
  }
  return money(amount);
}

export function normalizeInvoiceKey(value) {
  return String(value ?? '').toLowerCase().trim().replace(/\s+/g, '');
}

export function verifyInvoice(line) {
  if (line.quotation) throw Error('Replace the quotation with the final tax invoice or remove this entry.');
  const reference = line.reference?.trim();
  const supplier = line.supplier?.trim();
  if (!supplier || !reference) throw Error('Enter a supplier and invoice number for each document.');
  const amount = parseMoney(line.amount, 'invoice total');
  const gst = parseMoney(line.gst, 'invoice GST');
  if (gst > amount) throw Error('Invoice GST cannot exceed the invoice total.');
  const gstin = line.gstin?.trim().toUpperCase() || '';
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) {
    throw Error('Check the supplier GSTIN or leave it blank.');
  }
  const quantity = line.quantity === '' || line.quantity == null ? null : Number(line.quantity);
  if (quantity != null && (!Number.isFinite(quantity) || quantity <= 0)) throw Error('Invoice quantity must be greater than zero.');
  return {
    kind: line.kind, supplier, reference, amount, gst, gstin, verified: true,
    orderId: line.orderId?.trim() || '', platform: line.platform?.trim() || '',
    product: line.product?.trim() || '', quantity, quantityUnit:line.quantityUnit?.trim() || '',
    unitPrice: line.unitPrice === '' || line.unitPrice == null ? null : parseMoney(line.unitPrice, 'invoice unit price'),
    discount: line.discount === '' || line.discount == null ? null : parseMoney(line.discount, 'invoice discount'),
    path: line.path ?? null, sha256: line.sha256 ?? null,
  };
}

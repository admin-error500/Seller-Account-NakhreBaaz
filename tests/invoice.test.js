import assert from 'node:assert/strict';
import test from 'node:test';
import {parseInvoice} from '../src/invoiceParser.js';
import {purchaseDetails, purchaseTotals, verifyInvoice} from '../src/purchaseReconciliation.js';

test('Flipkart product and fee invoice table totals', () => {
  const product = parseInvoice(`Flipkart
Sold By: Tirupati Textiles, Warehouse
Invoice Number: FA-001
Order ID: OD123456789012
Plain T-Shirt 1 6,406.78 -100.00 6,306.78 1,135.22 7,442.00
Total 1 6,406.78 -100.00 6,306.78 1,135.22 7,442.00
Grand Total ₹7,442.00`);
  const fee = parseInvoice(`Flipkart
Sold By: Flipkart Internet
Invoice No: FE/001
Protect Promise Fee 1 47.46 0.00 47.46 8.54 56.00
Total 1 47.46 0.00 47.46 8.54 56.00
Grand Total ₹56.00`);
  assert.deepEqual([product.platform, product.kind, product.supplier, product.reference, product.orderId,
    product.product, product.quantity, product.unitPrice, product.discount, product.amount, product.gst],
  ['Flipkart', 'Product', 'Tirupati Textiles', 'FA-001', 'OD123456789012', 'Plain T-Shirt', 1, 6406.78, 100, 7442, 1135.22]);
  assert.deepEqual([fee.kind, fee.amount, fee.gst], ['Fee', 56, 8.54]);
});

test('Amazon, Meesho and offline labelled invoice fields', () => {
  const amazon = parseInvoice(`Amazon.in Tax Invoice
Sold By: Shirt Trading Ltd
Invoice Number : BLR1-370
Order Number : 402-1234567-1123456
Description: Black tee
Qty: 2
Unit Price: Rs. 250.00
Subtotal: 500.00
CGST 2.5% 12.50
SGST 2.5% 12.50
Total: ₹525.00`);
  assert.deepEqual([amazon.platform, amazon.supplier, amazon.reference, amazon.orderId, amazon.product,
    amazon.quantity, amazon.unitPrice, amazon.gstRate, amazon.gst, amazon.amount],
  ['Amazon', 'Shirt Trading Ltd', 'BLR1-370', '402-1234567-1123456', 'Black tee', 2, 250, 5, 25, 525]);
  const meesho = parseInvoice(`Meesho / Fashnear
Seller Name: Meera Garments
Invoice No.: M/2026/17
Sub Order ID: 123_4
Product Name: Blue cotton shirt
Quantity: 3
Unit Rate: 120
Discount: INR 10.00
Taxable Value: 350
IGST: 17.50
Total Invoice Value: ₹367.50`);
  assert.deepEqual([meesho.platform, meesho.orderId, meesho.product, meesho.quantity,
    meesho.unitPrice, meesho.discount, meesho.amount, meesho.gst],
  ['Meesho', '123_4', 'Blue cotton shirt', 3, 120, 10, 367.50, 17.50]);
  const offline = parseInvoice(`Supplier Name: Local Tools
Bill No: LT/26/008
Product: Heat Press
GSTIN: 27ABCDE1234F1Z5
Invoice Total: INR 11,800
Taxable Amount: 10000
Total GST: 1800`);
  assert.deepEqual([offline.supplier, offline.reference, offline.product, offline.gstin, offline.amount, offline.gst],
  ['Local Tools', 'LT/26/008', 'Heat Press', '27ABCDE1234F1Z5', 11800, 1800]);
});

test('ambiguous or inconsistent totals are left for review', () => {
  assert.equal(parseInvoice('Grand Total: 100\nGrand Total: 200').amount, null);
  assert.equal(parseInvoice('Invoice Total: 100\nTaxable Amount: 90\nTotal GST: 18').gst, null);
  assert.equal(parseInvoice('Grand Total: 105\nCGST 2.5%\nSGST 2.5%').gst, null);
  assert.equal(parseInvoice('Grand Total: 100\nTotal GST: 0').gst, 0);
});

const product = verifyInvoice({kind:'Product', supplier:'Textiles',reference:'A',amount:7442,gst:1135.22});
const fee = verifyInvoice({kind:'Fee',supplier:'Marketplace',reference:'B',amount:56,gst:8.54});

test('reconciliation uses actual payment and verified documents in paise', () => {
  const purchase = {actualPayment:8721,qty:4,rate:2222,gstRate:18};
  assert.equal(purchaseDetails(purchase).status,'Pending');
  assert.deepEqual(purchaseDetails({...purchase,invoiceDetails:[product,fee]}), {
    paid:8721, hasActualPayment:true, invoiceTotal:7498, tax:1143.76, status:'Partially received',
    pending:1223, mismatch:0, recordedTax:1143.76,
  });
  const final = verifyInvoice({kind:'Product',supplier:'Textiles',reference:'C',amount:1223,gst:0});
  const invoices = [product,fee,final];
  assert.equal(purchaseDetails({...purchase,invoiceDetails:invoices}).status,'Reconciled');
  assert.equal(purchaseDetails({...purchase,actualPayment:8720,invoiceDetails:invoices}).status,'Mismatch');
  const overall = purchaseTotals([{...purchase,invoiceDetails:[product,fee]},
    {...purchase,actualPayment:7497,invoiceDetails:[product,fee]}]);
  assert.equal(overall.pending,1223);
  assert.equal(overall.mismatch,1);
  assert.equal(overall.tax,2287.52);
});

test('legacy stock pricing and fee GST survive, and invalid manual amounts are rejected', () => {
  const legacy = purchaseDetails({qty:2,rate:100,gstRate:18,gstInclusive:false,purchaseDiscount:10,rewardsUsed:2,
    invoiceDetails:[{kind:'Product',amount:0,gst:0},{kind:'Fee',amount:56,gst:8.54}]});
  assert.equal(legacy.paid,280);
  assert.equal(legacy.invoiceTotal,56);
  assert.equal(legacy.tax,8.54);
  assert.equal(legacy.recordedTax,44.54);
  assert.equal(legacy.hasActualPayment,false);
  assert.throws(()=>verifyInvoice({...fee,gst:''}), /invoice GST/);
  assert.throws(()=>verifyInvoice({...fee,gst:57}), /cannot exceed/);
  assert.throws(()=>verifyInvoice({...fee,amount:'.001'}), /invoice total/);
});

test('Amazon extracts a tabular IGST line and avoids applying an aggregate quantity to one SKU', () => {
  const header = 'Amazon.in\nSold By: Sample Seller\nOrder Number: 402-1234567-1123456\nInvoice Number: BLR-42\n';
  const first = '1 Plain T-Shirt ₹250.00 2 ₹500.00 5% IGST ₹25.00 ₹525.00';
  const single = parseInvoice(header + first + '\nTotal: ₹525.00');
  assert.deepEqual([single.product,single.quantity,single.unitPrice,single.gst],['Plain T-Shirt',2,250,25]);
  const second = '2 Blue Shirt ₹100.00 1 ₹100.00 5% IGST ₹5.00 ₹105.00';
  const mixed = parseInvoice(header + first + '\n' + second + '\nTotal: ₹630.00');
  assert.deepEqual([mixed.multipleProducts,mixed.quantity,mixed.unitPrice,mixed.gst], [true,null,null,30]);
});

test('Flipkart fills GST-inclusive coupon discounts and ignores adjacent address headings', () => {
  const lines = [
    'Flipkart', 'Order ID: Bill To', 'Order Date: 24-11-2026',
    'Single Function Printer: 1 ₹8,576.00 ₹−1,134.00 ₹6,306.78 ₹1,135.22 ₹7,442.00',
    'Grand Total ₹7,442.00',
  ];
  for (const total of ['', 'Total 1 ₹8,576.00 ₹−1,134.00 ₹6,306.78 ₹1,135.22 ₹7,442.00']) {
    const invoice = parseInvoice([...lines, total].join('\n'));
    assert.deepEqual([invoice.orderId, invoice.quantity, invoice.unitPrice, invoice.discount, invoice.gst, invoice.amount],
      ['', 1, 8576, 1134, 1135.22, 7442]);
  }
  const inconsistent = parseInvoice(lines.join('\n').replace('1,134.00','1,135.00'));
  assert.equal(inconsistent.discount, null);
});

test('Amazon wrapped items and shipping discounts reconcile against the two-column total', () => {
  const text = [
    'Amazon Tax Invoice', 'Sold By: Example Supplier Ltd', 'GST Registration No: 27ABCDE1234F1Z5',
    'Invoice Number: TEST-1', 'Order Number: 402-1234567-1123456',
    '1 Thermal Label Roll', '4 x 6 inch, pack of two',
    '₹423.73 ₹0.00 1 ₹423.73 18% IGST ₹76.27 ₹500.00',
    'Shipping Charges', '₹100.85 -₹100.85 ₹0.00 18% IGST ₹0.00 ₹0.00',
    'TOTAL: ₹76.27 ₹500.00',
  ].join('\n');
  const invoice = parseInvoice(text);
  assert.deepEqual([invoice.product,invoice.quantity,invoice.unitPrice,invoice.amount,invoice.gst,invoice.discount,
    invoice.productDiscount,invoice.gstRate,invoice.multipleProducts,invoice.gstin],
    ['Thermal Label Roll',1,423.73,500,76.27,100.85,0,18,false,'27ABCDE1234F1Z5']);
  const inconsistent = parseInvoice(text.replace('TOTAL: ₹76.27','TOTAL: ₹70.27'));
  assert.equal(inconsistent.gst, null);
});

test('reads a standalone delivery invoice with decimal quantity and no grand total label', () => {
  const text = [
    'Flipkart Tax Invoice', 'Sold By: Example Seller', 'Invoice Number: TEST-FA-1',
    'Particulars SAC Qty Gross Taxable IGST Total', 'Amount Value',
    'Delivery Charges 996819 1.0 ₹1223.00 ₹1164.76 ₹58.24 ₹1223.00',
    'IGST 5.0 %', 'Total 1.0 ₹1223.00 ₹1164.76 ₹58.24 ₹1223.00',
  ].join('\n');
  const invoice = parseInvoice(text);
  assert.deepEqual([invoice.amount,invoice.gst,invoice.quantity,invoice.unitPrice,invoice.product,invoice.kind,invoice.gstRate],
    [1223,58.24,1,1223,'Delivery Charges','Fee',5]);
  assert.equal(parseInvoice(text.replace(/Total 1.0[^\n]+/, 'Total 1.0 ₹1223.00 ₹1164.76 ₹1.00 ₹1223.00')).amount, null);
});

test('uses the seller column and discards the Amazon billing heading', () => {
  const combined = 'Amazon\nSold By : Billing Address :\nExample Seller Private Buyer Name\nLIMITED Buyer Address';
  assert.equal(parseInvoice(combined).supplier,'');
  assert.equal(parseInvoice(combined,'Sold By :\nExample Seller Private\nLIMITED').supplier,'Example Seller Private LIMITED');
  assert.equal(parseInvoice('Amazon\nSold By: Example Seller Billing Address:').supplier,'Example Seller');
});

test('an allocated supplier advance reduces the due without inflating direct payments', () => {
  const row = {actualPayment:0,advanceApplied:4000,invoiceDetails:[{kind:'Product',verified:true,amount:10000,gst:0}]};
  const details = purchaseDetails(row);
  assert.equal(details.status,'Invoice verified');
  assert.equal(details.advanceApplied,4000);
  assert.equal(details.due,6000);
  assert.equal(details.paid,0);
  assert.equal(details.mismatch,0);
  assert.equal(purchaseDetails({...row,actualPayment:6000}).status,'Reconciled');
});

test('identifies a quotation and reads its quoted total without treating sales tax as invoice GST', () => {
  const text = 'QUOTATION\nExample Supplier\nQuotation No. Quotation Date\nQT/26-27/123\nTOTAL 0.8 ₹ 2,100\nTotal 1,780 160.2 160.2 ₹320.4';
  const quotation = parseInvoice(text);
  assert.deepEqual(quotation,{documentType:'quotation',reference:'QT/26-27/123',amount:2100});
  assert.throws(()=>verifyInvoice({...quotation,quotation:true}),/final tax invoice/);
});

test('reads an offline material invoice with litre units and a negative rounding adjustment', () => {
  const text = [
    'TAX INVOICE ORIGINAL FOR RECIPIENT', 'Example Enterprises', 'GSTIN: 27ABCDE1234F1Z5',
    'Invoice No. Invoice Date', 'VE/26-27/0917 25/11/2026',
    'S.NO. ITEMS HSN QTY. RATE AMOUNT', '1 Printing Ink Dti (4 color) 32151990 0.8 LTR 2,225 1,780',
    'CGST @9% - - - ₹ 160.2', 'SGST @9% - - - ₹ 160.2', 'Round Off - - - - ₹ 0.4',
    'TOTAL 0.8 ₹ 2,100', 'Total 1,780 160.2 160.2 ₹ 320.4',
  ].join('\n');
  assert.deepEqual(parseInvoice(text),{
    reference:'VE/26-27/0917',supplier:'Example Enterprises',gstin:'27ABCDE1234F1Z5',
    product:'Printing Ink Dti (4 color)',quantity:0.8,quantityUnit:'LTR',unitPrice:2225,
    gst:320.4,gstRate:18,amount:2100,roundOff:-0.4,kind:'Product',platform:'Direct',reviewRequired:true,
  });
});

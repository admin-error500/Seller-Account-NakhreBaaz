import {readFile} from 'node:fs/promises';
import {expect, test} from '@playwright/test';

const seller = '10000000-0000-0000-0000-000000000001';
const sku = '10000000-0000-0000-0000-000000000002';
const sample = [
  'Flipkart Tax Invoice', 'Sold By: Example Textiles', 'Invoice Number: FK-0042',
  'Order ID: OD123456789012', 'Product: Plain T-Shirt', 'Quantity: 1',
  'Unit Price: 6306.78', 'Taxable Amount: 6306.78', 'Discount: 0.00', 'Total GST: 1135.22',
  'Grand Total: 7442.00',
];

function makePdf(lines, jpeg) {
  const text = lines.length ? 'BT /F1 16 Tf '+(jpeg?'3 Tr ':'')+'28 340 Td '
    + lines.map(line => `(${line}) Tj`).join(' 0 -26 Td ')+' ET' : '';
  const content = jpeg ? 'q 600 0 0 370 0 0 cm /Im Do Q '+text : text;
  const resources = jpeg ? '/XObject << /Im 5 0 R >>'+(lines.length?' /Font << /F1 6 0 R >>':'') : '/Font << /F1 5 0 R >>';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 370] /Resources << ${resources} >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    jpeg ? Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 740 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg, Buffer.from('\nendstream')]) : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  if (jpeg&&lines.length) objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const objectCount=objects.length+1;
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    chunks.push(entry);
    length += entry.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objectCount}\n0000000000 65535 f \n${offsets.map(offset =>
    String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

async function imageInvoice(page, mime) {
  const data = await page.evaluate(({lines,mime}) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 740;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.font = '36px Arial';
    lines.forEach((line,index) => ctx.fillText(line, 65, 65 + index * 55));
    return canvas.toDataURL(mime).split(',')[1];
  }, {lines:sample,mime});
  return Buffer.from(data,'base64');
}

async function openPurchasePage(page, name) {
  const button = page.getByRole('button',{name,exact:true});
  if (!await button.isVisible()) await page.getByText('Purchases',{exact:true}).click();
  await button.click();
}

async function useSellerApi(page, equipmentPurchases = [], sellerRole = 'admin') {
  const db = {products:[{id:sku,sku:'PLAIN-M',name:'Plain T-Shirt',size:'M',color:'Black',type:'BLANK'}],purchases:[],material_purchases:[],equipment_purchases:equipmentPurchases,supplier_advances:[],supplier_advance_allocations:[]};
  const uploads = [];
  const user = {id:seller,email:'seller@example.test',app_metadata:{seller_role:sellerRole},user_metadata:{}};
  const session = {access_token:'browser-test',refresh_token:'browser-test',
    expires_at:Math.floor(Date.now()/1000)+3600, token_type:'bearer',user};
  await page.addInitScript(session => localStorage.setItem('sb-seller-test-auth-token',JSON.stringify(session)),session);
  await page.route('https://seller-test.supabase.co/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split('/').at(-1);
    const list = db[table] ?? [];
    const result = (json, status=200) => route.fulfill({status,json});
    if (url.pathname.startsWith('/auth/')) return result(user);
    if (url.pathname.startsWith('/storage/')) {
      uploads.push(request.method());
      return result(url.pathname.includes('/object/sign/')?{signedURL:'/object/sign/purchase-invoices/test.pdf?token=test'}:{Key:table});
    }
    if (request.method()==='GET') return result(list);
    const payload = request.postDataJSON();
    if (request.method()==='POST' && ['supplier_advances','supplier_advance_allocations'].includes(table)) {
      list.push(payload);
      return result(payload,201);
    }
    if (request.method()==='POST' && ['purchases','equipment_purchases','record_material_purchase'].includes(table)) {
      const row={...(payload.purchase??payload),invoice_revision:0};
      if (table==='record_material_purchase') {
        row.material_id=sku;
        db.material_purchases.push(row);
      } else list.push(row);
      return result(row,201);
    }
    if (request.method()==='PATCH' && ['purchases','equipment_purchases'].includes(table)) {
      const row=list.find(item=>url.searchParams.get('id')==='eq.'+item.id &&
        url.searchParams.get('invoice_revision')==='eq.'+item.invoice_revision);
      if (!row) return result([]);
      Object.assign(row,payload,{invoice_revision:row.invoice_revision+1});
      return result([row]);
    }
    return result({message:'Unexpected browser test API call'},400);
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Overview'})).toBeVisible();
  return {db,uploads};
}

test('reads PDF and adds later fee without increasing stock or payment', async ({page}) => {
  const {db,uploads} = await useSellerApi(page);
  await openPurchasePage(page, 'T-Shirt Purchases');
  await page.getByRole('button',{name:'+ Add Entry'}).click();
  await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
  await page.getByLabel('Invoice file').setInputFiles({name:'product.pdf',mimeType:'application/pdf',buffer:makePdf(sample)});
  await expect(page.getByRole('status')).toHaveText('Review the extracted fields before saving.');
  await expect(page.getByLabel('Invoice supplier')).toHaveValue('Example Textiles');
  await expect(page.getByLabel('Product description')).toHaveValue('Plain T-Shirt');
  await expect(page.getByRole('combobox',{name:'Product',exact:true})).toHaveValue(sku);
  await expect(page.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue('7442');
  await expect(page.getByLabel('Documented GST (₹)')).toHaveValue('1135.22');
  await page.getByLabel('Actual payment (₹)').fill('8721');
  await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
  await page.getByRole('button',{name:'Save Entry'}).click();
  await expect(page.getByText('Entry saved',{exact:true})).toBeVisible();
  const actions = page.getByRole('row').filter({hasText:'FK-0042'}).locator('.actions-cell');
  const view = actions.getByRole('button',{name:'View invoice FK-0042',exact:true});
  await view.hover();
  await expect(view.locator('.invoice-action-tooltip')).toBeVisible();
  const add = actions.getByRole('button',{name:'Add invoices',exact:true});
  await expect(add).toBeEnabled();
  await view.focus();
  await page.keyboard.press('Tab');
  await expect(add).toBeFocused();
  await expect(add.locator('.invoice-action-tooltip')).toBeVisible();
  await add.click();
  await page.getByLabel('Invoice type').selectOption('Fee');
  await page.getByLabel('Invoice supplier').fill('Marketplace');
  await page.getByLabel('Invoice number',{exact:true}).fill('FEE-0042');
  await page.getByLabel('Invoice total (₹)',{exact:true}).fill('56');
  await page.getByLabel('Documented GST (₹)').fill('8.54');
  await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
  await page.getByRole('button',{name:'Save reconciliation'}).click();
  await expect(page.getByText('Purchase reconciliation updated.')).toBeVisible();
  expect(db.purchases).toHaveLength(1);
  expect(db.purchases[0].qty).toBe(1);
  expect(db.purchases[0].actual_payment).toBe(8721);
  expect(db.purchases[0].invoice_details).toHaveLength(2);
  expect(uploads).toEqual(['POST']);
  const row = page.getByRole('row').filter({hasText:'FEE-0042'});
  for (const amount of ['₹8,721.00','₹7,498.00','₹1,143.76','₹1,223.00']) await expect(row.getByText(amount)).toBeVisible();
  await expect(row.getByText('Partially received')).toBeVisible();
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await expect(page.getByText('Stock Units').locator('..').getByText('1',{exact:true})).toBeVisible();
  await expect(page.getByText('Pending Invoice Reconciliation').locator('..').getByText('₹1,223.00')).toBeVisible();
  await page.getByRole('button',{name:'Monthly Business Report'}).click();
  await expect(page.getByRole('row').filter({hasText:'Documented purchase GST'}).getByText('₹1,143.76')).toBeVisible();
});

for (const format of ['png','jpeg','scanned pdf','hybrid pdf']) {
  test(`uses local OCR for ${format}`, async ({page}) => {
    await useSellerApi(page);
    await openPurchasePage(page, 'Machines & Equipment');
    await page.getByRole('button',{name:'+ Add Entry'}).click();
    await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
    const imageType = format==='png'?'image/png':'image/jpeg';
    const image = await imageInvoice(page,imageType);
    const file = format.endsWith(' pdf')
      ? {name:'scan.pdf',mimeType:'application/pdf',buffer:makePdf(format==='hybrid pdf'?
        ['A long incomplete PDF text layer can contain plenty of irrelevant content and no useful invoice fields.']:[],image)}
      : {name:`invoice.${format}`,mimeType:imageType,buffer:image};
    await page.getByLabel('Invoice file').setInputFiles(file);
    await expect(page.locator('.invoice-spinner')).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Reading invoice…');
    await expect(page.getByRole('status')).toHaveText('Review the extracted fields before saving.',{timeout:30000});
    await expect(page.locator('.invoice-spinner')).toHaveCount(0);
    await expect(page.getByLabel('Invoice supplier')).toHaveValue('Example Textiles');
    await expect(page.getByLabel('Invoice number',{exact:true}).last()).toHaveValue('FK-0042');
    await expect(page.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue('7442');
    await expect(page.getByLabel('Documented GST (₹)')).toHaveValue('1135.22');
    const remove = page.getByRole('button',{name:'Remove invoice'});
    expect((await remove.boundingBox()).width).toBeLessThan(150);
    await remove.click();
    await expect(page.getByLabel('Invoice file')).toHaveCount(0);
  });
}

test('saves material and equipment purchases with multiple manually verified invoices', async ({page}) => {
  const {db} = await useSellerApi(page);
  for (const [category,table,name] of [
    ['Material Purchases','material_purchases','Material Name'],
    ['Machines & Equipment','equipment_purchases','Product Name']
  ]) {
    await openPurchasePage(page, category);
    await page.getByRole('button',{name:'+ Add Entry'}).click();
    await page.getByLabel(name,{exact:true}).fill('Test purchase');
    if (table==='material_purchases') {
      await page.getByRole('combobox',{name:'Category',exact:true}).selectOption('Ink');
      await page.getByRole('combobox',{name:'Unit',exact:true}).selectOption('ml');
    }
    await page.getByLabel('Quantity',{exact:true}).fill('2');
    await page.getByLabel('Item unit price before discount (₹)',{exact:true}).fill('50');
    await page.getByRole('combobox',{name:'GST Rate (%)',exact:true}).selectOption('0');
    await page.getByRole('combobox',{name:'GST included in unit price?',exact:true}).selectOption('No');
    await page.getByLabel('Actual payment (₹)').fill('100');
    for (let index=1;index<=2;index++) {
      await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
      const invoice=page.getByRole('group',{name:`Invoice ${index}`,exact:true});
      await invoice.getByLabel('Invoice supplier').fill('Test Supplier');
      await invoice.getByLabel('Invoice number',{exact:true}).fill(table+'-1');
      await invoice.getByLabel('Invoice total (₹)').fill('50');
      await invoice.getByLabel('Documented GST (₹)').fill('0');
    }
    await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
    await page.getByRole('button',{name:'Save Entry'}).click();
    await expect(page.getByText('This invoice is already listed on the purchase.')).toBeVisible();
    expect(db[table]).toHaveLength(0);
    await page.getByRole('group',{name:'Invoice 2',exact:true})
      .getByLabel('Invoice number',{exact:true}).fill(table+'-2');
    await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
    await page.getByRole('button',{name:'Save Entry'}).click();
    await expect(page.getByText('Entry saved',{exact:true})).toBeVisible();
    await expect(page.getByText('Reconciled',{exact:true})).toBeVisible();
    expect(db[table]).toHaveLength(1);
    expect(db[table][0].invoice_details).toHaveLength(2);
  }
});

test('autofills the discount and GST from a Flipkart printer PDF', async ({page}) => {
  await useSellerApi(page);
  await openPurchasePage(page, 'Machines & Equipment');
  await page.getByRole('button',{name:'+ Add Entry'}).click();
  await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
  const lines = [
    'Flipkart Tax Invoice', 'Sold By: Example Printer Supplier', 'Invoice Number: FK-1099',
    'Order ID: Bill To',
    'Single Function Printer: 1 8576.00 - 1134.00 6306.78 1135.22 7442.00',
    'Total 1 8576.00 - 1134.00 6306.78 1135.22 7442.00', 'Grand Total: 7442.00'
  ];
  await page.getByLabel('Invoice file').setInputFiles({name:'printer.pdf',mimeType:'application/pdf',buffer:makePdf(lines)});
  await expect(page.getByLabel('Invoice discount (₹)',{exact:true})).toHaveValue('1134');
  await expect(page.getByLabel('Purchase discount (₹)',{exact:true})).toHaveValue('1134');
  await expect(page.getByLabel('Documented GST (₹)',{exact:true})).toHaveValue('1135.22');
  await expect(page.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue('7442');
  await expect(page.getByLabel('Invoice order ID',{exact:true})).toHaveValue('');
});

test('reads Amazon wrapped product and shipping rows without applying shipping discount to the product', async ({page}) => {
  const {db} = await useSellerApi(page);
  await openPurchasePage(page, 'Material Purchases');
  await page.getByRole('button',{name:'+ Add Entry'}).click();
  await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
  const lines = [
    'Amazon Tax Invoice', 'Sold By: Example Supplier', 'Invoice Number: AM-42',
    'Order Number: 402-1234567-1123456', '1 Thermal Label Roll', '4 x 6 inch, pack of two',
    '423.73 0.00 1 423.73 18% IGST 76.27 500.00',
    'Shipping Charges', '100.85 -100.85 0.00 18% IGST 0.00 0.00', 'TOTAL: 76.27 500.00',
  ];
  const file = process.env.SELLER_TEST_INVOICE_PDF
    ?? {name:'amazon.pdf',mimeType:'application/pdf',buffer:makePdf(lines)};
  await page.getByLabel('Invoice file').setInputFiles(file);
  await expect(page.getByLabel('Invoice supplier',{exact:true})).toHaveValue(process.env.SELLER_TEST_INVOICE_PDF
    ? 'YUGAN MEDICAL INDUSTRIES PRIVATE LIMITED' : 'Example Supplier');
  await expect(page.getByLabel('Product description')).toHaveValue(/Thermal.*Label/i);
  await expect(page.getByLabel('Invoice quantity',{exact:true})).toHaveValue('1');
  await expect(page.getByLabel('Invoice unit price before discount (₹)',{exact:true})).toHaveValue('423.73');
  await expect(page.getByLabel('Invoice discount (₹)',{exact:true})).toHaveValue('100.85');
  await expect(page.getByLabel('Purchase discount (₹)',{exact:true})).toHaveValue('0');
  await expect(page.getByLabel('Documented GST (₹)',{exact:true})).toHaveValue('76.27');
  await expect(page.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue('500');
  await page.getByRole('combobox',{name:'Category',exact:true}).selectOption('Other');
  await page.getByRole('combobox',{name:'Unit',exact:true}).selectOption('pcs');
  await page.getByLabel('Actual payment (₹)').fill('500');
  await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
  await page.getByRole('button',{name:'Save Entry'}).click();
  await expect(page.getByText('Entry saved',{exact:true})).toBeVisible();
  await expect(page.getByText('Reconciled',{exact:true})).toBeVisible();
  expect(db.material_purchases[0]).toMatchObject({
    qty:1, rate:423.73, purchase_discount:0, invoice_details:[{amount:500,gst:76.27,discount:100.85}]
  });
});

test('shows invoice verification and payment match next to purchase attachments', async ({page}) => {
  const invoice = {kind:'Product', reference:'TEST-1', supplier:'Example Supplier', verified:true, path:'test/invoice.pdf', amount:500, gst:0};
  const records = [
    ['Green', 500, [invoice], 'Verified & matched', 'ok'],
    ['Missing', 500, [{...invoice, path:null}], 'Invoice file missing', 'error'],
    ['No invoice', 500, [], 'Invoice file missing', 'error'],
    ['Partial', 501, [invoice], 'Invoice total below payment', 'error'],
    ['Mismatch', 499, [invoice], 'Amount mismatch', 'error'],
    ['Unverified', 500, [{...invoice, verified:false}], 'Verification pending', 'error'],
  ];
  await useSellerApi(page, records.map(([name, actual_payment, invoice_details], index) =>
    ({id:String(index), name, actual_payment, invoice_details, invoice_revision:0})));
  await openPurchasePage(page, 'Machines & Equipment');
  for (const [name,,, label, mode] of records) {
    const badge = page.getByRole('row').filter({has:page.getByRole('cell',{name,exact:true})})
      .locator('.invoice-status');
    await expect(badge).toHaveText((mode==='ok'?'✓':'✕')+label);
    await expect(badge).toHaveClass(`invoice-status invoice-status-${mode}`);
  }
  await page.getByRole('row').filter({has:page.getByRole('cell',{name:'Missing',exact:true})})
    .getByRole('button',{name:'Upload file TEST-1',exact:true}).click();
  await expect(page.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue('500');
  const lines = ['Sold By: Example Supplier', 'Invoice Number: TEST-1', 'Total GST: 0.00','Grand Total: 500.00'];
  await page.getByLabel('Invoice file').setInputFiles({name:'invoice.pdf',mimeType:'application/pdf',buffer:makePdf(lines)});
  await expect(page.getByText('Review the extracted fields before saving.')).toBeVisible();
  await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
  await page.getByRole('button',{name:'Save reconciliation'}).click();
  await expect(page.getByRole('row').filter({has:page.getByRole('cell',{name:'Missing',exact:true})})
    .locator('.invoice-status')).toHaveClass('invoice-status invoice-status-ok');
});

test('overview shows five cards, a conditional mismatch alert and grouped purchase navigation', async ({page}) => {
  await useSellerApi(page,[{id:'1',name:'Printer',actual_payment:500,
    invoice_details:[{kind:'Product',verified:true,amount:525,gst:0}]}]);
  const stats = page.locator('.overview-stats article');
  await expect(stats).toHaveCount(5);
  await expect(stats.filter({hasText:'Total Purchase Payments'})).toContainText('₹500.00');
  await expect(page.getByRole('status')).toContainText('₹25.00');
  await expect(page.getByRole('button',{name:'T-Shirt Purchases',exact:true})).toBeHidden();
  await openPurchasePage(page,'T-Shirt Purchases');
  await expect(page.getByRole('heading',{name:'T-Shirt Purchases',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Material Purchases',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Machines & Equipment',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Monthly Business Report'}).click();
  await expect(page.getByRole('row').filter({hasText:'Marketplace fees + shipping'})).toBeVisible();
});

test('reconciles all three Flipkart PDFs against one purchase', async ({page}) => {
  const {db,uploads} = await useSellerApi(page);
  await openPurchasePage(page,'Machines & Equipment');
  await page.getByRole('button',{name:'+ Add Entry'}).click();
  const docs = [
    {name:'product',kind:'Product',amount:7442,gst:1135.22,discount:1134,lines:[
      'Product: Single Function Printer', 'Single Function Printer 1 8576.00 -1134.00 6306.78 1135.22 7442.00',
      'Total 1 8576.00 -1134.00 6306.78 1135.22 7442.00', 'Grand Total: 7442.00',
    ]},
    {name:'protection',kind:'Fee',amount:56,gst:8.54,discount:0,lines:[
      'Protect Promise Fee 1 56.00 0.00 47.46 8.54 56.00',
      'Total 1 56.00 0.00 47.46 8.54 56.00', 'Grand Total: 56.00',
    ]},
    {name:'delivery',kind:'Fee',amount:1223,gst:58.24,discount:null,lines:[
      'Particulars SAC Qty Gross Taxable IGST Total',
      'Delivery Charges 996819 1.0 1223.00 1164.76 58.24 1223.00',
      'Total 1.0 1223.00 1164.76 58.24 1223.00',
    ]},
  ];
  const uploadedPaths = process.env.SELLER_TEST_FLIPKART_PDFS
    ? JSON.parse(process.env.SELLER_TEST_FLIPKART_PDFS) : {};
  for (const [index,doc] of docs.entries()) {
    await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
    const invoice = page.getByRole('group',{name:`Invoice ${index+1}`,exact:true});
    const file = uploadedPaths[doc.name] ?? {name:`${doc.name}.pdf`,mimeType:'application/pdf',buffer:makePdf([
      'Flipkart Tax Invoice', 'Sold By: Example Seller', `Invoice Number: TEST-${index+1}`, ...doc.lines,
    ])};
    await invoice.getByLabel('Invoice file').setInputFiles(file);
    await expect(invoice.getByLabel('Invoice type')).toHaveValue(doc.kind);
    await expect(invoice.getByLabel('Invoice quantity',{exact:true})).toHaveValue('1');
    await expect(invoice.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue(String(doc.amount));
    await expect(invoice.getByLabel('Documented GST (₹)',{exact:true})).toHaveValue(String(doc.gst));
    await expect(invoice.getByLabel('Invoice discount (₹)',{exact:true})).toHaveValue(String(doc.discount??''));
  }
  await page.getByLabel('Actual payment (₹)').fill('8721');
  const summary = page.getByLabel('Purchase cost summary');
  await expect(summary.getByText('Item invoices after discounts').locator('..')).toContainText('₹7,442.00');
  await expect(summary.getByText('Fee invoices',{exact:true}).locator('..')).toContainText('₹1,279.00');
  await expect(summary.getByText('Received invoice total',{exact:true}).locator('..')).toContainText('₹8,721.00');
  await expect(summary.getByText('Actual payment',{exact:true}).locator('..')).toContainText('₹8,721.00');
  await expect(page.getByText('Estimated item subtotal before discounts',{exact:true})).toHaveCount(0);
  await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
  await page.getByRole('button',{name:'Save Entry'}).click();
  await expect(page.locator('.invoice-status')).toContainText('Verified & matched');
  expect(db.equipment_purchases).toHaveLength(1);
  expect(db.equipment_purchases[0]).toMatchObject({qty:1,rate:8576,actual_payment:8721,purchase_discount:1134});
  expect(db.equipment_purchases[0].invoice_details).toHaveLength(3);
  expect(uploads).toEqual(['POST','POST','POST']);
  const row = page.getByRole('row').filter({hasText:'Verified & matched'});
  await expect(row.getByRole('cell',{name:'₹8,721.00',exact:true})).toHaveCount(2);
  await expect(row.getByRole('cell',{name:'₹1,202.00',exact:true})).toBeVisible();
  await expect(row.getByRole('cell',{name:'Reconciled',exact:true})).toBeVisible();

  await row.getByRole('button',{name:'Add invoices',exact:true}).click();
  await page.getByRole('button',{name:'Remove invoice',exact:true}).click();
  await page.getByLabel('Actual payment (₹)').fill('8710');
  await page.getByRole('button',{name:'Save reconciliation'}).click();
  await expect(page.locator('.invoice-status')).toContainText('Amount mismatch');
  await expect(page.getByRole('row').filter({hasText:'Amount mismatch'}).getByText('₹11.00',{exact:true})).toBeVisible();
  expect(db.equipment_purchases[0]).toMatchObject({qty:1,actual_payment:8710});
  expect(db.equipment_purchases[0].invoice_details).toHaveLength(3);
});

test('corrects a stored billing heading without changing the purchase amounts or invoice file', async ({page}) => {
  const {db,uploads} = await useSellerApi(page,[{
    id:'1',name:'Label roll',supplier:'Billing Address :',invoice:'AMZ-1',actual_payment:500,qty:1,invoice_revision:0,
    invoice_details:[{reference:'AMZ-1',verified:true,kind:'Product',supplier:'Billing Address :',
      amount:500,gst:76.27,path:'test/original.pdf'}],
  }]);
  await openPurchasePage(page,'Machines & Equipment');
  await page.getByRole('button',{name:'Correct supplier name',exact:true}).click();
  await page.getByLabel('Supplier name',{exact:true}).fill('Example Seller Private Limited');
  await page.getByRole('button',{name:'Save supplier name',exact:true}).click();
  await expect(page.getByText('Supplier name corrected.',{exact:true})).toBeVisible();
  expect(db.equipment_purchases[0]).toMatchObject({supplier:'Example Seller Private Limited',qty:1,actual_payment:500,
    invoice_details:[{supplier:'Example Seller Private Limited',amount:500,gst:76.27,path:'test/original.pdf'}]});
  expect(uploads).toEqual([]);
});

test('records and applies an advance once, separating invoice verification from payment due', async ({page}) => {
  const date = new Date().toISOString().slice(0,10);
  const {db} = await useSellerApi(page,[{
    id:'1',name:'Printer',supplier:'Acme',invoice:'A-1',actual_payment:0,qty:1,purchased_on:date,invoice_revision:0,
    invoice_details:[{reference:'A-1',supplier:'Acme',verified:true,kind:'Product',amount:10000,gst:0,path:'test/printer.pdf'}],
  }]);
  await page.getByRole('button',{name:'Supplier Advances',exact:true}).click();
  await page.getByLabel('Supplier name').fill('Acme');
  await page.getByLabel('Advance paid (₹)',{exact:true}).fill('4000');
  await page.getByLabel('Payment date').fill(date);
  await page.getByRole('button',{name:'Record advance',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Unused supplier advances · ₹4,000.00'})).toBeVisible();
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await expect(page.getByText('Unused advances ₹4,000.00')).toBeVisible();
  await openPurchasePage(page,'Machines & Equipment');
  await page.getByRole('button',{name:'Apply supplier advance',exact:true}).click();
  await expect(page.getByLabel('Amount to apply (₹)')).toHaveValue('4000');
  await page.getByRole('button',{name:'Apply advance',exact:true}).click();
  await expect(page.locator('.invoice-status-ok')).toContainText('Invoice verified');
  await expect(page.getByText('Advance applied ₹4,000.00',{exact:true})).toBeVisible();
  await expect(page.getByText('Balance due ₹6,000.00',{exact:true})).toBeVisible();
  expect(db.equipment_purchases).toHaveLength(1);
  expect(db.equipment_purchases[0]).toMatchObject({qty:1,actual_payment:0});
  expect(db.supplier_advance_allocations).toHaveLength(1);
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await expect(page.getByText('Total Purchase Payments').locator('..')).toContainText('₹4,000.00');
  await expect(page.getByText('Invoice amount mismatch',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Monthly Business Report',exact:true}).click();
  await page.getByLabel('Report Month').fill(date.slice(0,7));
  await expect(page.getByRole('row').filter({hasText:'Supplier advances paid'})).toContainText('₹4,000.00');
  await expect(page.getByRole('row').filter({hasText:'Equipment purchase payments'})).toContainText('₹0.00');
  await page.getByRole('button',{name:'Supplier Advances',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Unused supplier advances · ₹0.00'})).toBeVisible();
  await page.getByRole('button',{name:'Acme',exact:true}).click();
  const detail = page.getByRole('dialog',{name:'Supplier advance entry'});
  await expect(detail.getByText('Advance applied',{exact:true}).locator('..')).toContainText('₹4,000.00');
  await detail.getByRole('button',{name:'Close',exact:true}).click();
  await expect(detail).toBeHidden();
});

test('explains a supplier quotation without applying it to the purchase', async ({page}) => {
  const {db,uploads} = await useSellerApi(page);
  await openPurchasePage(page,'Material Purchases');
  await page.getByRole('button',{name:'+ Add Entry'}).click();
  await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
  const file = process.env.SELLER_TEST_QUOTATION_PDF ??
    {name:'quote.pdf',mimeType:'application/pdf',buffer:makePdf([
      'QUOTATION','Example Supplier','Quotation No. Quotation Date','QT/26-27/123',
      'TOTAL 0.8 2100.00','Total 1780.00 160.20 160.20 320.40',
    ])};
  await page.getByLabel('Invoice file').setInputFiles(file);
  await expect(page.getByRole('status').filter({hasText:'Upload the supplier’s final tax invoice'})).toBeVisible();
  if (process.env.SELLER_TEST_QUOTATION_PDF) {
    await expect(page.getByRole('status')).toContainText('Quoted total ₹2,100.00');
  }
  await expect(page.getByLabel('Invoice number',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Documented GST (₹)',{exact:true})).toHaveValue('');
  expect(db.material_purchases).toHaveLength(0);
  expect(uploads).toEqual([]);
});

test('reads and saves an offline ink invoice in the inventory unit', async ({page}) => {
  const {db} = await useSellerApi(page);
  await openPurchasePage(page,'Material Purchases');
  await page.getByRole('button',{name:'+ Add Entry'}).click();
  await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
  const file = process.env.SELLER_TEST_OFFLINE_PDF ??
    {name:'offline.pdf',mimeType:'application/pdf',buffer:makePdf([
      'TAX INVOICE ORIGINAL FOR RECIPIENT','Example Enterprises','GSTIN: 27ABCDE1234F1Z5',
      'Invoice No. Invoice Date','VE/26-27/0917 25/11/2026',
      'S.NO. ITEMS HSN QTY. RATE AMOUNT','1 Printing Ink 32151990 0.8 LTR 2,225 1,780',
      'CGST @9% - - - Rs. 160.2','SGST @9% - - - Rs. 160.2','Round Off - - - - Rs. 0.4',
      'TOTAL 0.8 Rs. 2,100',
    ])};
  await page.getByLabel('Invoice file').setInputFiles(file);
  await expect(page.getByLabel('Invoice supplier',{exact:true})).toHaveValue(process.env.SELLER_TEST_OFFLINE_PDF
    ? 'VIHAAN ENTERPRISES':'Example Enterprises');
  await expect(page.getByLabel('Invoice number',{exact:true})).toHaveValue('VE/26-27/0917');
  await expect(page.getByLabel('Invoice quantity',{exact:true})).toHaveValue('0.8');
  await expect(page.getByLabel('Invoice quantity unit',{exact:true})).toHaveValue('LTR');
  await expect(page.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue('2100');
  await expect(page.getByLabel('Documented GST (₹)',{exact:true})).toHaveValue('320.4');
  await expect(page.getByLabel('Quantity',{exact:true})).toHaveValue('800');
  await expect(page.getByRole('combobox',{name:'Unit',exact:true})).toHaveValue('ml');
  await expect(page.getByRole('combobox',{name:'Category',exact:true})).toHaveValue('Ink');
  await expect(page.getByLabel('Item unit price before discount (₹)',{exact:true})).toHaveValue('2.225');
  await page.getByLabel('Actual payment (₹)').fill('2100');
  await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
  await page.getByRole('button',{name:'Save Entry'}).click();
  await expect(page.locator('.invoice-status')).toContainText('Verified & matched');
  expect(db.material_purchases[0]).toMatchObject({qty:800,rate:2.225,actual_payment:2100,
    invoice_details:[{quantity:0.8,quantityUnit:'LTR',unitPrice:2225,gst:320.4,amount:2100}]});
});

test('opens one saved purchase with its own amounts and attachment for a non-admin seller', async ({page}) => {
  const invoice = {kind:'Product',reference:'A-1',supplier:'Acme',verified:true,amount:500,gst:76.27,path:'test/entry.pdf'};
  await useSellerApi(page,[
    {id:'1',name:'Printer one',supplier:'Acme',invoice:'A-1',qty:1,rate:500,actual_payment:500,invoice_details:[invoice]},
    {id:'2',name:'Printer two',supplier:'Other Co',qty:2,rate:800,actual_payment:1600,invoice_details:[]},
  ],'seller');
  await openPurchasePage(page,'Machines & Equipment');
  const first = page.getByRole('row').filter({has:page.getByRole('cell',{name:'Printer one',exact:true})});
  await expect(page.getByRole('button',{name:'Open entry',exact:true})).toHaveCount(0);
  const open = first.getByRole('button',{name:'Printer one',exact:true});
  await expect(open).toHaveAttribute('aria-haspopup','dialog');
  await open.click();
  const dialog = page.getByRole('dialog',{name:'Machines & Equipment entry'});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Printer one',{exact:true})).toBeVisible();
  await expect(dialog.getByText('Printer two',{exact:true})).toHaveCount(0);
  await expect(dialog.getByText('Actual payment',{exact:true}).locator('..')).toContainText('₹500.00');
  const signed = page.waitForRequest(request=>request.url().includes('/object/sign/purchase-invoices/test/entry.pdf'));
  await dialog.getByRole('button',{name:'View invoice A-1',exact:true}).click();
  await signed;
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await page.getByRole('row').filter({has:page.getByRole('cell',{name:'Printer two',exact:true})})
    .getByRole('button',{name:'Printer two',exact:true}).click();
  await expect(dialog.getByText('Printer two',{exact:true})).toBeVisible();
  await expect(dialog.getByText('No invoices saved.',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(dialog).toBeHidden();
});

test('exports only checked rows with durable invoice links and keeps the actions aligned', async ({page}) => {
  const invoice = {kind:'Product',reference:'A/1',supplier:'Acme',verified:true,amount:500,gst:0,path:'test/entry.pdf'};
  await useSellerApi(page,[
    {id:'1',name:'Selected printer',supplier:'Acme',qty:1,rate:500,actual_payment:500,
      invoice_details:[invoice,{...invoice,reference:'A-2',path:'test/entry-2.pdf',amount:0}]},
    {id:'2',name:'Skipped printer',supplier:'Other',qty:1,rate:500,actual_payment:500,invoice_details:[]},
    {id:'3',name:'Selected spare',supplier:'Acme',qty:1,rate:500,actual_payment:500,invoice_details:[]},
  ]);
  await openPurchasePage(page,'Machines & Equipment');
  const exportButton=page.getByRole('button',{name:'Export selected CSV (0)',exact:true});
  await expect(exportButton).toBeDisabled();
  await page.getByRole('checkbox',{name:'Select Selected printer',exact:true}).check();
  await page.getByRole('checkbox',{name:'Select Selected spare',exact:true}).check();
  const row=page.getByRole('row').filter({has:page.getByRole('cell',{name:'Selected printer',exact:true})});
  const actions=row.locator('.row-actions button');
  const geometry=await actions.evaluateAll(buttons=>buttons.map(button=>{
    const {y,width,height}=button.getBoundingClientRect();
    return [y,width,height];
  }));
  expect(geometry).toHaveLength(3);
  expect(new Set(geometry.map(values=>values.join(','))).size).toBe(1);

  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export selected CSV (2)',exact:true}).click();
  const download=await downloading;
  expect(download.suggestedFilename()).toBe('equipmentPurchases-selected.csv');
  const csv=await readFile(await download.path(),'utf8');
  expect(csv).toContain('Selected printer');
  expect(csv).toContain('Selected spare');
  expect(csv).not.toContain('Skipped printer');
  expect(csv).toContain('"invoice_link_1","invoice_link_2"');
  const link=csv.match(/https?:\/\/[^"]+invoiceType=equipmentPurchases[^"]+/)?.[0];
  expect(link).toBeTruthy();
  expect(link).not.toContain('token=');
  const request=page.waitForRequest(req=>req.method()==='POST'&&req.url().includes('/object/sign/purchase-invoices/test/entry.pdf'));
  await page.goto(link);
  await request;
  await expect(page).toHaveURL(/\/object\/sign\/purchase-invoices\/test.pdf/);
});

test('aligns invoice view buttons and keeps the details header visible while scrolling', async ({page}) => {
  await useSellerApi(page,[{
    id:'1',name:'Printer',supplier:'Vendor with a long company name',qty:1,rate:8721,actual_payment:8721,
    invoice_details:[
      {kind:'Fee',reference:'A-LONG-DELIVERY-INVOICE-REFERENCE',verified:true,path:'test/delivery.pdf',amount:1223,gst:58.24},
      {kind:'Product',reference:'A-LONG-PRODUCT-INVOICE-REFERENCE',verified:true,path:'test/product.pdf',amount:7442,gst:1135.22},
      {kind:'Fee',reference:'SHORT',verified:true,path:'test/fee.pdf',amount:56,gst:8.54},
    ],
  }]);
  await openPurchasePage(page,'Machines & Equipment');
  await page.getByRole('button',{name:'Printer',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Machines & Equipment entry'});
  const views = dialog.getByRole('button',{name:/^View invoice/});
  await expect(views).toHaveCount(3);
  for (const viewport of [{width:1220,height:500},{width:390,height:600}]) {
    await page.setViewportSize(viewport);
    const coordinates = await views.evaluateAll(buttons=>buttons.map(button=>{
      const {x,width}=button.getBoundingClientRect();
      return [x,width];
    }));
    expect(new Set(coordinates.map(values=>values.join(','))).size).toBe(1);
    const close = dialog.getByRole('button',{name:'Close',exact:true});
    const top = (await close.boundingBox()).y;
    const body = dialog.locator('.entry-details-body');
    await body.evaluate(element=>{element.scrollTop=element.scrollHeight});
    expect(await body.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
    expect((await close.boundingBox()).y).toBe(top);
  }
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(dialog).toBeHidden();
});

test('keeps a partially readable invoice attached while the missing GST is entered manually', async ({page}) => {
  const {db,uploads} = await useSellerApi(page,[{
    id:'1',name:'Equipment',supplier:'Example Supplier',qty:1,rate:500,actual_payment:500,
    invoice_revision:0,invoice_details:[],
  }]);
  await openPurchasePage(page,'Machines & Equipment');
  await page.getByRole('button',{name:'Add invoices',exact:true}).click();
  const lines=['Tax Invoice','Vendor Name: Example Supplier','Invoice Ref: VA-123','Bill Total: 500.00'];
  await page.getByLabel('Invoice file').setInputFiles({
    name:'supplier.pdf',mimeType:'application/pdf',buffer:makePdf(lines),
  });
  await expect(page.getByRole('status')).toContainText('attached document: GST.');
  await expect(page.getByRole('button',{name:'View selected file',exact:true})).toBeVisible();
  await expect(page.getByLabel('Invoice number',{exact:true})).toHaveValue('VA-123');
  await expect(page.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue('500');
  await page.getByLabel('Documented GST (₹)',{exact:true}).fill('0');
  await expect(page.getByText('Enter these details from the attached document:',{exact:false})).toHaveCount(0);
  await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
  await page.getByRole('button',{name:'Save reconciliation'}).click();
  await expect(page.locator('.invoice-status')).toContainText('Verified & matched');
  expect(db.equipment_purchases[0].invoice_details[0]).toMatchObject({amount:500,gst:0,reference:'VA-123'});
  expect(uploads).toEqual(['POST']);
});

test('fills the existing fields for the split-tax equipment invoice', async ({page}) => {
  const {db}=await useSellerApi(page);
  await openPurchasePage(page,'Machines & Equipment');
  await page.getByRole('button',{name:'+ Add Entry'}).click();
  await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
  const file=process.env.SELLER_TEST_SPLIT_TAX_PDF??{
    name:'equipment.pdf',mimeType:'application/pdf',buffer:makePdf([
      'TAX INVOICE','Example Equipment LLP','GSTIN/UIN: 27ABCDE1234F1Z5','Invoice No.: APV/26-27/R6040',
      'Sl Description of Goods HSN/SAC Quantity Rate per Disc. % Amount Taxable CGST SGST/UTGST Total',
      '1 Heat Press Machine 84624900 1 pcs 10000.00 pcs 10000.00 10000.00 9% 900.00 9% 900.00 11800.00',
      'Total 1 pcs INR 11800.00 10000.00 900.00 900.00',
    ]),
  };
  await page.getByLabel('Invoice file').setInputFiles(file);
  await expect(page.getByLabel('Invoice supplier',{exact:true})).toHaveValue(process.env.SELLER_TEST_SPLIT_TAX_PDF
    ?'APPARELTECH VENTURES LLP':'Example Equipment LLP');
  await expect(page.getByLabel('Invoice number',{exact:true})).toHaveValue('APV/26-27/R6040');
  await expect(page.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue('11800');
  await expect(page.getByLabel('Documented GST (₹)',{exact:true})).toHaveValue('1800');
  await expect(page.getByLabel('Invoice quantity',{exact:true})).toHaveValue('1');
  await expect(page.getByLabel('Item unit price before discount (₹)',{exact:true})).toHaveValue('10000');
  await page.getByLabel('Actual payment (₹)').fill('11800');
  await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
  await page.getByRole('button',{name:'Save Entry'}).click();
  await expect(page.locator('.invoice-status')).toContainText('Verified & matched');
  expect(db.equipment_purchases[0]).toMatchObject({qty:1,rate:10000,actual_payment:11800,
    invoice_details:[{amount:11800,gst:1800}]});
});

test('fills and saves Amazon totals from the summary when item tax rows wrap', async ({page}) => {
  const {db}=await useSellerApi(page,[{
    id:'1',name:'Consumable',supplier:'Example Seller',actual_payment:590,invoice_revision:0,invoice_details:[],
  }]);
  await openPurchasePage(page,'Machines & Equipment');
  await page.getByRole('button',{name:'Add invoices',exact:true}).click();
  const lines=[
    'Amazon Tax Invoice','Sold By: Example Seller','Invoice Number: SPLIT-1','Order Number: 402-1234567-1123456',
    'Description Unit Price Quantity Net Amount', 'Tax Rate Tax Type Tax Amount Total Amount',
    '1 Printer Consumable','INR 500.00 1 INR 500.00 9% CGST INR 45.00',
    '9% SGST INR 45.00 INR 590.00','TOTAL: INR 90.00 INR 590.00',
  ];
  await page.getByLabel('Invoice file').setInputFiles({
    name:'split.pdf',mimeType:'application/pdf',buffer:makePdf(lines),
  });
  await expect(page.getByLabel('Invoice total (₹)',{exact:true})).toHaveValue('590');
  await expect(page.getByLabel('Documented GST (₹)',{exact:true})).toHaveValue('90');
  await page.getByRole('checkbox',{name:'I verified the invoice details against the documents'}).check();
  await page.getByRole('button',{name:'Save reconciliation'}).click();
  await expect(page.locator('.invoice-status')).toContainText('Verified & matched');
  expect(db.equipment_purchases[0].invoice_details[0]).toMatchObject({amount:590,gst:90,reference:'SPLIT-1'});
});

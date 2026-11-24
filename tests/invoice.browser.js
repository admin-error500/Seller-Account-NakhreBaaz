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
  const content = jpeg ? 'q 600 0 0 370 0 0 cm /Im Do Q'
    : 'BT /F1 16 Tf 28 340 Td ' + lines.map(line => `(${line}) Tj`).join(' 0 -26 Td ') + ' ET';
  const resources = jpeg ? '/XObject << /Im 5 0 R >>' : '/Font << /F1 5 0 R >>';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 370] /Resources << ${resources} >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    jpeg ? Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 740 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg, Buffer.from('\nendstream')]) : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    chunks.push(entry);
    length += entry.length;
  }
  chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset =>
    String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
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

async function useSellerApi(page, equipmentPurchases = []) {
  const db = {products:[{id:sku,sku:'PLAIN-M',name:'Plain T-Shirt',size:'M',color:'Black',type:'BLANK'}],purchases:[],material_purchases:[],equipment_purchases:equipmentPurchases};
  const uploads = [];
  const user = {id:seller,email:'seller@example.test',app_metadata:{seller_role:'admin'},user_metadata:{}};
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
      return result({Key:table});
    }
    if (request.method()==='GET') return result(list);
    const payload = request.postDataJSON();
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

for (const format of ['png','jpeg','scanned pdf']) {
  test(`uses local OCR for ${format}`, async ({page}) => {
    await useSellerApi(page);
    await openPurchasePage(page, 'Machines & Equipment');
    await page.getByRole('button',{name:'+ Add Entry'}).click();
    await page.getByRole('button',{name:'+ Add Invoice',exact:true}).click();
    const imageType = format==='png'?'image/png':'image/jpeg';
    const image = await imageInvoice(page,imageType);
    const file = format==='scanned pdf'
      ? {name:'scan.pdf',mimeType:'application/pdf',buffer:makePdf([],image)}
      : {name:`invoice.${format}`,mimeType:imageType,buffer:image};
    await page.getByLabel('Invoice file').setInputFiles(file);
    await expect(page.getByRole('status')).toHaveText('Review the extracted fields before saving.',{timeout:30000});
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
    await page.getByLabel('Unit Price (₹)',{exact:true}).fill('50');
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
  await expect(page.getByLabel('Product description')).toHaveValue(/Thermal.*Label/i);
  await expect(page.getByLabel('Invoice quantity',{exact:true})).toHaveValue('1');
  await expect(page.getByLabel('Invoice unit price (₹)',{exact:true})).toHaveValue('423.73');
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

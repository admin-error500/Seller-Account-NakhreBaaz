const currency = String.raw`(?:(?:₹|INR|Rs\.?)\s*)?`;
const numeric = String.raw`(?:-[ \t]*)?\d[\d,]*(?:\.\d{1,4})?`;
const id = String.raw`([A-Z0-9][A-Z0-9./_\-]*)`;
const separator = String.raw`[ \t]*(?:[:#–-][ \t]*)?(?:\n[ \t]*)?`;
const value = text => text == null ? null : Number(text.replace(/[ ,\t]/g, ''));
const cents = amount => Math.round(amount * 100);

function findText(text, label, pattern) {
  return text.match(new RegExp(`\\b(?:${label})${separator}${pattern}`, 'i'))?.[1]?.trim() ?? '';
}

function findAmount(text, label) {
  const matches = [...text.matchAll(new RegExp(
    String.raw`(?:^|\n)[ \t]*(?:${label})${separator}${currency}(${numeric})(?![\d.,]|[ \t]*(?:(?:pcs?|nos?|ltr|ml|kg|g|units?)\b|%|(?:₹|INR|Rs\.?)?[ \t]*[+-]?\d))`, 'gi'
  ))];
  const amounts = [...new Set(matches.map(match => value(match[1])))];
  return amounts.length === 1 ? amounts[0] : null;
}

function amazonItems(text) {
  // Amazon's line-item layout ends with unit price, quantity, net, tax rate, tax type, tax and total.
  const amount = `${currency}(${numeric})`;
  const row = new RegExp(String.raw`^[ \t]*\d+[ \t]+(.+?)[ \t]+${amount}[ \t]+(\d+(?:\.\d+)?)[ \t]+${amount}[ \t]+\d+(?:\.\d+)?[ \t]*%[ \t]+(?:IGST|CGST|SGST|UTGST)[ \t]+${amount}[ \t]+${amount}[ \t]*$`, 'gim');
  return [...text.matchAll(row)].map(([, description, price, quantity, net, gst, total]) =>
    ({description, price:value(price), quantity:value(quantity), net:value(net), gst:value(gst), total:value(total)}))
    .filter(item => cents(item.net + item.gst) === cents(item.total));
}

function amazonTotals(text) {
  const headings=text.split('\n').findIndex(line=>/\bTax\s+Amount\s+Total\s+Amount\b/i.test(line));
  const wrappedHeadings=/^.*\bTax\s+Tax\s+Total\s*\n(?:[^\n]*\n){0,2}[^\n]*\bType\s+Amount\s+Amount\b/im.test(text);
  if (headings<0&&!wrappedHeadings) return null;
  const money = String.raw`(?:₹|INR|Rs\.?)[ \t]*(${numeric})`;
  const row = new RegExp(String.raw`^[ \t]*TOTAL(?:[ \t]*:[ \t]*(?:\n[ \t]*)?|[ \t]+)${money}[ \t]+${money}[ \t]*$`,'gim');
  const pairs = [...new Set([...text.matchAll(row)].map(match=>match.slice(1).map(value).join('/')))];
  if (pairs.length!==1) return null;
  const [tax,total]=pairs[0].split('/').map(Number);
  return tax>=0&&tax<=total?{tax,total}:null;
}

function amazonDiscountTable(text) {
  // Amazon may put the description on a different row from the numeric columns.
  const amount = `${currency}(${numeric})`;
  const gap = String.raw`[ \t]+`;
  const row = new RegExp(String.raw`^[ \t]*(?:(?!(?:INR|Rs)\b)[A-Z][^₹\n]*?[ \t]+(?=(?:₹|INR\b|Rs\.?)[ \t]*\d))?${amount}${gap}${amount}(?:${gap}(\d+(?:\.\d+)?))?${gap}${amount}${gap}\d+(?:\.\d+)?[ \t]*%${gap}(?:IGST|CGST|SGST|UTGST)${gap}${amount}${gap}${amount}[ \t]*$`, 'gim');
  const totals = [...text.matchAll(new RegExp(String.raw`^[ \t]*TOTAL[ \t]*:[ \t]*(?:\n[ \t]*)?${amount}${gap}${amount}[ \t]*$`, 'gim'))];
  if (totals.length !== 1) return null;
  const [tax, total] = totals[0].slice(1).map(value);
  let itemNumber = 0;
  const rows = [...text.matchAll(row)].map(match => {
    const [price, discount, quantity, net, gst, total] = match.slice(1).map(value);
    let description = '';
    if (quantity != null) {
      itemNumber++;
      const lines = text.slice(0, match.index).trimEnd().split('\n').slice(-8);
      const label = new RegExp(`^\\s*${itemNumber}(?:[ \\t]+([A-Za-z].*))?\\s*$`);
      const index = lines.findLastIndex(line => label.test(line));
      if (index >= 0) {
        description = lines[index].match(label)[1] ?? lines[index - 1]?.trim() ?? '';
      }
    }
    return {price, discount:Math.abs(discount), quantity, net, gst, total, description};
  });
  const sum = key => rows.reduce((result, item) => result + cents(item[key]), 0);
  if (!rows.length || rows.some(item => cents(item.net + item.gst) !== cents(item.total)
      || cents(item.price * (item.quantity ?? 1) - item.discount) !== cents(item.net))) return null;
  if (sum('gst')!==cents(tax)||sum('total')!==cents(total)) return {conflict:true};
  return {tax, total, discount:sum('discount') / 100, products:rows.filter(item => item.quantity != null)};
}

function serviceInvoiceTable(text) {
  if (!/^[^\n]*\bSAC[ \t]+Qty[ \t]+Gross[^\n]*\bTaxable[^\n]*\bIGST[ \t]+Total\b/im.test(text)) return null;
  const cell = String.raw`[ \t]+${currency}(${numeric})`;
  const amounts = cell.repeat(4) + String.raw`[ \t]*$`;
  const quantity = String.raw`(\d+(?:\.\d+)?)`;
  const totals = [...text.matchAll(new RegExp(String.raw`^[ \t]*Total[ \t]+${quantity}${amounts}`, 'gim'))];
  if (totals.length !== 1) return null;
  const [qty,gross,taxable,gst,total] = totals[0].slice(1).map(value);
  if (qty <= 0 || gross < 0 || taxable < 0 || gst < 0
    || cents(taxable + gst) !== cents(total) || cents(gross) !== cents(total)) return null;
  const lines = [...text.matchAll(new RegExp(String.raw`^[ \t]*([^\n]+?)[ \t]+\d{4,8}[ \t]+${quantity}${amounts}`, 'gim'))];
  const description = lines.length === 1 ? lines[0][1].trim() : '';
  return {quantity:qty,gross,taxable,gst,total,description,multiple:lines.length>1};
}

export const isAddressHeading = value =>
  /^(?:billing(?: address)?|shipping(?: address)?|bill(?:ed)? to|ship(?:ped)? to)(?:[ \t]*[:#]|[ \t]*$)/i
    .test(String(value??'').trim());

function invoiceSupplier(text, sellerColumn) {
  const source = sellerColumn || text;
  const candidate = findText(source, String.raw`Sold[ \t]*By|Supplier(?:[ \t]*Name)?|Seller[ \t]*Name|Vendor[ \t]*Name|Billed[ \t]*From|Issued[ \t]*By`, '([^\\n]+)');
  const name = candidate.split(/(?:^|\s+)(?:GSTIN|PAN|Billing Address|Ship(?:ping)? Address|Registered Office Address)\b|\s*,/i)[0].trim();
  if (!name || isAddressHeading(name)) return '';
  const lines = source.split('\n');
  const nameLine = lines.findIndex(line => line.trim().endsWith(candidate));
  const suffix = sellerColumn && candidate === name && nameLine >= 0
    ? lines[nameLine+1]?.trim().match(/^(?:limited|ltd\.?|llp|inc\.?)(?=\s*,|$)/i)?.[0]
    : '';
  return suffix ? `${name} ${suffix}` : name;
}

function offlineTaxInvoice(text) {
  const lines = text.split('\n');
  const header = lines.findIndex(line=>/^\s*Tax Invoice(?:[ \t]+Original For Recipient)?\s*$/i.test(line));
  if (header < 0 || header > 7 || !/^.*\bITEMS[ \t]+HSN[ \t]+QTY\.?[ \t]+RATE[ \t]+AMOUNT\s*$/im.test(text)) return null;
  const numberHeader = lines.findIndex(line=>/\bInvoice[ \t]+No\.?[ \t]+Invoice[ \t]+Date\b/i.test(line));
  const reference = numberHeader < 0 ? '' : lines.slice(numberHeader+1,numberHeader+6)
    .map(line=>line.match(/(?:^|[ \t])([A-Z0-9][A-Z0-9./_-]*\d)[ \t]+\d{1,2}[./-]\d{1,2}[./-]\d{4}\b/i)?.[1]).find(Boolean);
  const row = new RegExp(String.raw`^[ \t]*\d+[ \t]+(.+?)[ \t]+\d{4,8}[ \t]+(\d+(?:\.\d+)?)[ \t]+([A-Z]+)[ \t]+${currency}(${numeric})[ \t]+${currency}(${numeric})[ \t]*$`, 'gim');
  const items = [...text.matchAll(row)];
  if (items.length !== 1 || !reference) return null;
  const [, product, qty, unit, rate, base] = items[0];
  const quantity = value(qty), unitPrice = value(rate), taxable = value(base);
  if (quantity <= 0 || unitPrice < 0 || cents(quantity*unitPrice) !== cents(taxable)) return null;

  const amount = value(text.match(new RegExp(String.raw`^Total[ \t]+\d+(?:\.\d+)?[ \t]+(?:₹|INR|Rs\.?)[ \t]*(${numeric})[ \t]*$`, 'im'))?.[1]);
  const rounding = text.match(new RegExp(String.raw`^Round[ \t]+Off[ \t]+(?:(?:-[ \t]+){3})?(-?)[ \t]*(?:₹|INR|Rs\.?)[ \t]*(${numeric})[ \t]*$`, 'im'));
  const roundOff = rounding ? (rounding[1] ? -1 : 1)*value(rounding[2]) : 0;
  const taxRows = [...text.matchAll(new RegExp(String.raw`^([CSI]GST)[ \t]*@?[ \t]*(\d+(?:\.\d+)?)%[ \t]+(?:-[ \t]+)*(?:₹|INR|Rs\.?)[ \t]*(${numeric})[ \t]*$`, 'gim'))];
  const gst = taxRows.reduce((sum,row)=>sum+cents(value(row[3])),0)/100;
  const gstRate = taxRows.reduce((sum,row)=>sum+value(row[2]),0);
  const taxTypes = taxRows.map(row=>row[1].toUpperCase()).sort().join(',');
  if (!['CGST,SGST','IGST'].includes(taxTypes) || amount == null ||
    Math.abs(cents(taxable+gst+roundOff)-cents(amount))>1 ||
    taxRows.some(row=>Math.abs(cents(taxable*value(row[2])/100)-cents(value(row[3])))>1)) return null;
  const supplier = lines.slice(header+1).find(line=>line.trim())?.trim() ?? '';
  const sellerBlock = text.split(/^\s*Bill[ \t]+To\b/im)[0];
  const gstin = findText(sellerBlock, 'GSTIN', '([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9])');
  return {reference,supplier,gstin,product,quantity,quantityUnit:unit.toUpperCase(),unitPrice,gst,gstRate,amount,roundOff,
    kind:'Product',platform:'Direct',reviewRequired:true};
}

function splitTaxGoodsInvoice(text) {
  const lines=text.split('\n');
  const header=lines.findIndex(line=>/^\s*Tax Invoice\s*$/i.test(line));
  const table=lines.findIndex(line=>/\bDescription of Goods[ \t]+HSN\/SAC[ \t]+Quantity[ \t]+Rate\b.*\bTaxable[ \t]+CGST[ \t]+SGST\/UTGST[ \t]+Total\b/i.test(line));
  if (header<0||header>7||table<0) return null;
  const slot=String.raw`[ \t]+(${numeric})`;
  const item=new RegExp(String.raw`^\s*\d+[ \t]+(.+?)[ \t]+\d{4,8}${slot}[ \t]+[A-Z]+${slot}[ \t]+[A-Z]+(?:[ \t]+${numeric}%)?${slot}${slot}${slot}%${slot}${slot}%${slot}${slot}[ \t]*$`,'i');
  const totals=new RegExp(String.raw`^[ \t]*Total${slot}[ \t]+[A-Z]+[ \t]+(?:₹|INR|Rs\.?)[ \t]*(${numeric})${slot}${slot}${slot}[ \t]*$`,'i');
  const ending=lines.findIndex((line,index)=>index>table&&totals.test(line));
  if (ending<0) return null;
  const items=lines.slice(table+1,ending).map(line=>line.match(item)).filter(Boolean);
  if (items.length!==1) return null;
  const [,product,...cells]=items[0];
  const [quantity,unitPrice,net,taxable,cgstRate,cgst,sgstRate,sgst,amount]=cells.map(value);
  const [totalQty,total,totalBase,totalCgst,totalSgst]=lines[ending].match(totals).slice(1).map(value);
  if (quantity<=0||unitPrice<0||net<0||cgst<0||sgst<0||amount<0||quantity!==totalQty||
    [net-taxable,taxable+cgst+sgst-amount,total-amount,totalBase-taxable,totalCgst-cgst,totalSgst-sgst,
      taxable*cgstRate/100-cgst,taxable*sgstRate/100-sgst].some(gap=>Math.abs(cents(gap))>1)) return null;
  const supplier=lines.slice(header+1).find(line=>line.trim())?.trim()??'';
  const sellerBlock=text.split(/^\s*Buyer[ \t]*\(Bill[ \t]+to\)/im)[0];
  const gstin=findText(sellerBlock,String.raw`GSTIN(?:/UIN)?`,'([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9])');
  return {supplier,gstin,product,quantity,unitPrice,amount,gst:(cents(cgst)+cents(sgst))/100,
    gstRate:cgstRate+sgstRate,discount:Math.max(0,(cents(quantity*unitPrice)-cents(net))/100)};
}

export function parseInvoice(raw, sellerColumn = '') {
  let text = raw.normalize('NFKC').replace(/[\r\f]/g, '').replace(/[\u00a0\t]+/g, ' ').replace(/[−–](?=[ \t]*(?:₹|\d))/g, '-');
  if (text.split('\n').slice(0,8).some(line=>/^\s*(?:sales[ \t]+)?quotation\s*:?\s*$/i.test(line))) {
    const reference = text.match(/\bQT[/-][A-Z0-9][A-Z0-9./_-]*/i)?.[0] || '';
    const rows = [...text.matchAll(new RegExp(
      String.raw`^[ \t]*Total[ \t]*:?[ \t]+(?:\d+(?:\.\d+)?[ \t]+)?₹[ \t]*(${numeric})[ \t]*$`, 'gim'
    ))];
    return {documentType:'quotation',reference,amount:rows.length===1?value(rows[0][1]):null};
  }
  const offline = offlineTaxInvoice(text);
  if (offline) return offline;
  text = text.replace(/-[ \t]*(₹|INR\b|Rs\.?)(?=[ \t]*\d)/gi, '$1-');
  const reference = findText(text, String.raw`Invoice[ \t]*(?:Number|No\.?|#|ID|Reference|Ref\.?)|Bill[ \t]*(?:No\.?|Number)|Tax Invoice(?=[ \t]*:)`, id);
  const goods=splitTaxGoodsInvoice(text);
  if (goods&&reference) return {...goods,reference,kind:'Product',platform:'Direct',reviewRequired:true};
  const labeledOrder = findText(text, String.raw`(?:Order|Sub[ -]?Order)[ \t]*(?:ID|Number|No\.?)`, id);
  const supplier = invoiceSupplier(text, sellerColumn);
  const gstin = findText(sellerColumn || text, String.raw`(?:Supplier[ \t]+|Seller[ \t]+)?(?:GSTIN(?:[ \t]*(?:No\.?|Number))?|GST[ \t]+Registration[ \t]+(?:No\.?|Number))`, '([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9])');
  const platform = /\bflipkart\b|\bOD\d{10,}/i.test(text) ? 'Flipkart'
    : /\bamazon\b|\b\d{3}-\d{7}-\d{7}\b/i.test(text) ? 'Amazon'
      : /\bmeesho\b|\bfashnear\b/i.test(text) ? 'Meesho' : '';
  const orderId = platform === 'Flipkart'
    ? text.match(/\bOD\d{10,}\b/i)?.[0] ?? (/\d/.test(labeledOrder) ? labeledOrder : '')
    : labeledOrder;
  const service = serviceInvoiceTable(text);
  const amazonRead = platform === 'Amazon' ? amazonDiscountTable(text) : null;
  const amazonTable = amazonRead?.conflict ? null : amazonRead;
  const amazonSummary = platform === 'Amazon' && !amazonRead?.conflict ? amazonTable ?? amazonTotals(text) : null;
  const amount = findAmount(text, String.raw`Grand[ \t]+Total|Invoice[ \t]+(?:Total|Amount)|Bill[ \t]+Total|Net[ \t]+Payable|Total[ \t]+Invoice[ \t]+(?:Amount|Value)|Total[ \t]+Payable|Amount[ \t]+Payable`)
    ?? amazonSummary?.total
    ?? findAmount(text, String.raw`Total[ \t]+Amount(?:[ \t]+(?:Including|Incl\.?)\s*GST)?|Total`) ?? service?.total ?? null;
  const taxable = findAmount(text, String.raw`(?:Total[ \t]+)?(?:Taxable[ \t]+(?:Amount|Value)|Subtotal(?:[ \t]+before[ \t]+tax)?)`);
  const totalGst = findAmount(text, String.raw`(?:Total[ \t]+(?:GST|Tax)(?:[ \t]+Amount)?|GST[ \t]+Amount)`);
  const parts = ['CGST', '[SU]GST|UTGST', 'IGST'].map(label =>
    findAmount(text, String.raw`(?:Total[ \t]+)?(?:${label})(?:[ \t]+(?:Amount|@?[ \t]*\d+(?:\.\d+)?\s*%))?`)
  );
  // Flipkart can show gross price and discounts either before GST or inclusive of GST.
  const cell = String.raw`[ \t]+${currency}(${numeric})`;
  const tail = cell.repeat(5) + String.raw`[ \t]*$`;
  const totals = [...text.matchAll(new RegExp(String.raw`^[ \t]*Total[ \t]+(\d+)${tail}`, 'gim'))]
    .map(row => row.slice(1).map(value));
  const tableRows = [...text.matchAll(new RegExp(String.raw`^[ \t]*(?!Total\b)([^\n]+?)[ \t]+(\d+)${tail}`, 'gim'))]
    .filter(row => cents(value(row[5]) + value(row[6])) === cents(value(row[7])));
  const candidates = totals.length ? totals : tableRows.length === 1 ? [tableRows[0].slice(2).map(value)] : [];
  const matchingTotals = candidates.filter(([, gross, discount, base, tax, total]) => {
    const net = cents(gross - Math.abs(discount));
    return amount != null && cents(total) === cents(amount) && cents(base + tax) === cents(total)
      && (net === cents(base) || net === cents(total));
  });
  const totalRow = matchingTotals.length === 1 ? matchingTotals[0] : null;
  const componentGst = parts.some(part => part != null) ? parts.reduce((sum, part) => sum + (part ?? 0), 0) : null;
  const amazon = platform === 'Amazon' ? amazonTable?.products ?? amazonItems(text) : [];
  const amazonGst = amazon.length && amount != null && amazon.reduce((sum, item) => sum + cents(item.total), 0) === cents(amount)
    ? amazon.reduce((sum, item) => sum + cents(item.gst), 0) / 100 : null;
  const declaredGst = totalGst ?? (service?.total === amount ? service.gst : null) ?? totalRow?.[4] ?? (amazonSummary?.total === amount ? amazonSummary.tax : null) ?? componentGst ?? amazonGst;
  const gst = declaredGst != null && amount != null && declaredGst >= 0 && declaredGst <= amount
    && (amazonSummary == null || (amazonSummary.total === amount && cents(amazonSummary.tax) === cents(declaredGst)))
    && (taxable == null || Math.abs(cents(taxable + declaredGst) - cents(amount)) <= 1)
    && (totalGst == null || componentGst == null || Math.abs(cents(totalGst) - cents(componentGst)) <= 1)
    ? cents(declaredGst) / 100 : null;
  const discount = findAmount(text, String.raw`(?:Total[ \t]+)?Discounts?(?:[ \t]*/[ \t]*Coupons?)?(?:[ \t]+(?:Amount|Value))?`) ?? totalRow?.[2] ?? amazonTable?.discount ?? null;
  const feeLabel = /(?:protect promise|handling|platform|convenience|shipping) fee/i;
  const tableItem = text.split('\n').find(line => feeLabel.test(line) && /\d[.,]\d{2}/.test(line));
  const rowProduct = tableRows.map(row => row[1].trim()).join(' / ') || amazon.map(item => item.description).join(' / ');
  const multipleProducts = service?.multiple || tableRows.length > 1 || amazon.length > 1;
  const product = findText(text, String.raw`(?:Product|Item)(?:[ \t]+(?:Name|Description))?[ \t]*(?=[:#])|Description[ \t]*(?=[:#])`, '([^\\n]+)') || service?.description || rowProduct || tableItem?.match(feeLabel)?.[0] || '';
  const quantity = multipleProducts ? null : findAmount(text, String.raw`Quantity|Qty\.?`) ?? service?.quantity ?? totalRow?.[0] ?? (tableRows.length === 1 ? value(tableRows[0][2]) : null) ?? amazon[0]?.quantity ?? null;
  const unitPrice = multipleProducts ? null : findAmount(text, String.raw`Unit[ \t]+(?:Price|Rate)|Price[ \t]+per[ \t]+unit|Rate`)
    ?? (service && quantity > 0 ? cents(service.gross / quantity) / 100 : null)
    ?? (tableRows.length === 1 && quantity > 0 ? Math.round(value(tableRows[0][3]) * 100 / quantity) / 100 : null)
    ?? (totalRow?.[0] > 0 ? Math.round(totalRow[1] * 100 / totalRow[0]) / 100 : null) ?? amazon[0]?.price ?? null;
  const base = taxable ?? service?.taxable ?? totalRow?.[3] ?? (amount != null && gst != null ? amount - gst : null);
  const gstRate = base > 0 && gst != null
    ? [0, 3, 5, 12, 18, 28, 40].find(rate => Math.abs(cents(base * rate / 100) - cents(gst)) <= 2) ?? null : null;
  const kind = (!multipleProducts && (feeLabel.test(product) || (service && /^(?:delivery|shipping) charges?$/i.test(product)))) || (!product && feeLabel.test(text) && !/\b(?:HSN|SKU|ASIN|FSN)\s*[:#-]?\s*\w{4,}/i.test(text)) ? 'Fee' : 'Product';
  return {reference, orderId, supplier, gstin, platform, product, quantity, unitPrice, gstRate,
    amount, kind, gst, discount: discount == null ? null : Math.abs(discount),
    productDiscount: amazonTable?.products.length === 1 ? amazonTable.products[0].discount : null,
    multipleProducts, reviewRequired: true};
}

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
    String.raw`(?:^|\n)[ \t]*(?:${label})${separator}${currency}(${numeric})(?![\d.,]|[ \t]*(?:%|(?:₹|INR|Rs\.?)?[ \t]*[+-]?\d))`, 'gi'
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

export function parseInvoice(raw) {
  const text = raw.normalize('NFKC').replace(/[\r\f]/g, '').replace(/[\u00a0\t]+/g, ' ').replace(/[−–](?=[ \t]*\d)/g, '-');
  const reference = findText(text, String.raw`Invoice[ \t]*(?:Number|No\.?|#|ID)|Bill[ \t]*(?:No\.?|Number)|Tax Invoice(?=[ \t]*:)`, id);
  const labeledOrder = findText(text, String.raw`(?:Order|Sub[ -]?Order)[ \t]*(?:ID|Number|No\.?)`, id);
  const supplierLine = findText(text, String.raw`Sold[ \t]*By|Supplier(?:[ \t]*Name)?|Seller[ \t]*Name|Billed[ \t]*From|Issued[ \t]*By`, '([^\\n]+)');
  const supplier = supplierLine.split(/\s+(?:GSTIN|PAN|Ship(?:ping)? Address|Registered Office Address)\b|\s*,/i)[0].trim();
  const gstin = findText(text, String.raw`(?:Supplier[ \t]+|Seller[ \t]+)?GSTIN(?:[ \t]*(?:No\.?|Number))?`, '([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9])');
  const platform = /\bflipkart\b|\bOD\d{10,}/i.test(text) ? 'Flipkart'
    : /\bamazon\b|\b\d{3}-\d{7}-\d{7}\b/i.test(text) ? 'Amazon'
      : /\bmeesho\b|\bfashnear\b/i.test(text) ? 'Meesho' : '';
  const orderId = platform === 'Flipkart'
    ? text.match(/\bOD\d{10,}\b/i)?.[0] ?? (/\d/.test(labeledOrder) ? labeledOrder : '')
    : labeledOrder;
  const amount = findAmount(text, String.raw`Grand[ \t]+Total|Invoice[ \t]+Total|Total[ \t]+Invoice[ \t]+(?:Amount|Value)|Total[ \t]+Payable|Amount[ \t]+Payable`)
    ?? findAmount(text, String.raw`Total[ \t]+Amount(?:[ \t]+(?:Including|Incl\.?)\s*GST)?|Total`);
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
  const amazon = platform === 'Amazon' ? amazonItems(text) : [];
  const amazonGst = amazon.length && amount != null && amazon.reduce((sum, item) => sum + cents(item.total), 0) === cents(amount)
    ? amazon.reduce((sum, item) => sum + cents(item.gst), 0) / 100 : null;
  const declaredGst = totalGst ?? totalRow?.[4] ?? componentGst ?? amazonGst;
  const gst = declaredGst != null && amount != null && declaredGst >= 0 && declaredGst <= amount
    && (taxable == null || Math.abs(cents(taxable + declaredGst) - cents(amount)) <= 1)
    && (totalGst == null || componentGst == null || Math.abs(cents(totalGst) - cents(componentGst)) <= 1)
    ? cents(declaredGst) / 100 : null;
  const discount = findAmount(text, String.raw`(?:Total[ \t]+)?Discounts?(?:[ \t]*/[ \t]*Coupons?)?(?:[ \t]+(?:Amount|Value))?`) ?? totalRow?.[2] ?? null;
  const feeLabel = /(?:protect promise|handling|platform|convenience|shipping) fee/i;
  const tableItem = text.split('\n').find(line => feeLabel.test(line) && /\d[.,]\d{2}/.test(line));
  const rowProduct = tableRows.map(row => row[1].trim()).join(' / ') || amazon.map(item => item.description).join(' / ');
  const multipleProducts = tableRows.length > 1 || amazon.length > 1;
  const product = findText(text, String.raw`(?:Product|Item)(?:[ \t]+(?:Name|Description))?[ \t]*(?=[:#])|Description[ \t]*(?=[:#])`, '([^\\n]+)') || rowProduct || tableItem?.match(feeLabel)?.[0] || '';
  const quantity = multipleProducts ? null : findAmount(text, String.raw`Quantity|Qty\.?`) ?? totalRow?.[0] ?? (tableRows.length === 1 ? value(tableRows[0][2]) : null) ?? amazon[0]?.quantity ?? null;
  const unitPrice = multipleProducts ? null : findAmount(text, String.raw`Unit[ \t]+(?:Price|Rate)|Price[ \t]+per[ \t]+unit|Rate`)
    ?? (tableRows.length === 1 && quantity > 0 ? Math.round(value(tableRows[0][3]) * 100 / quantity) / 100 : null)
    ?? (totalRow?.[0] > 0 ? Math.round(totalRow[1] * 100 / totalRow[0]) / 100 : null) ?? amazon[0]?.price ?? null;
  const base = taxable ?? totalRow?.[3] ?? (amount != null && gst != null ? amount - gst : null);
  const gstRate = base > 0 && gst != null
    ? [0, 3, 5, 12, 18, 28, 40].find(rate => Math.abs(cents(base * rate / 100) - cents(gst)) <= 2) ?? null : null;
  const kind = (!multipleProducts && feeLabel.test(product)) || (!product && feeLabel.test(text) && !/\b(?:HSN|SKU|ASIN|FSN)\s*[:#-]?\s*\w{4,}/i.test(text)) ? 'Fee' : 'Product';
  return {reference, orderId, supplier, gstin, platform, product, quantity, unitPrice, gstRate,
    amount, kind, gst, discount: discount == null ? null : Math.abs(discount),
    multipleProducts, reviewRequired: true};
}

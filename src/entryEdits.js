import {number, parseMoney} from './purchaseReconciliation.js';

export const purchasePaymentFields = {
  actualPayment: 'Actual payment (₹)',
  purchasePlatform: 'Purchase platform',
  purchaseOrderId: 'Order ID',
  purchaseDiscount: 'Purchase discount (₹)',
  rewardsUsed: 'Rewards redeemed (₹)',
};

export const purchaseAmounts = ['actualPayment', 'purchaseDiscount', 'rewardsUsed'];
const optionalAmounts = ['fee', 'shipping', 'refund'];
const requiredText = {name:'Product name', category:'Category', orderId:'Order ID'};

export function entryFormValues(row, fields) {
  return Object.fromEntries(fields.map(key => [key, key === 'gstInclusive' && row[key] != null
    ? (row[key] ? 'Yes' : 'No') : String(row[key] ?? '')]));
}

export function entryChanges(original, form, fields) {
  const changes = {};
  for (const [key, previous] of Object.entries(original)) {
    const value = form[key].trim();
    if (value === previous.trim()) continue;
    if (key === 'gstInclusive') changes[key] = value === 'Yes';
    else if (purchaseAmounts.includes(key)) {
      changes[key] = value === '' ? (key === 'actualPayment' ? null : 0) : parseMoney(value, purchasePaymentFields[key]);
    } else if (fields[key] === 'number' || key === 'gstRate') {
      const amount = Number(value);
      if ((!value && !optionalAmounts.includes(key)) || !Number.isFinite(amount) || amount < 0) {
        throw Error('Enter a valid non-negative number');
      }
      if (key === 'qty' && amount === 0) throw Error('Quantity must be greater than zero');
      changes[key] = amount;
    } else {
      if (!value && requiredText[key]) throw Error(`${requiredText[key]} is required`);
      changes[key] = value || null;
    }
  }
  return changes;
}

function changeStock(stock, id, delta) {
  if (id) stock[id] = number(stock[id]) + delta;
}

export function productStock(data) {
  const stock = Object.fromEntries(data.products.map(product => [product.id, 0]));
  const salesById = new Map(data.sales.map(sale => [sale.id, sale]));
  for (const adjustment of data.stockAdjustments) changeStock(stock, adjustment.productId, number(adjustment.qtyChange));
  for (const purchase of data.purchases) changeStock(stock, purchase.productId, number(purchase.qty));
  for (const sale of data.sales) changeStock(stock, sale.productId, -number(sale.qty));
  for (const entry of data.returns) {
    if (entry.condition === 'SELLABLE') changeStock(stock, salesById.get(entry.saleId)?.productId, number(entry.qty));
  }
  for (const run of data.production) {
    changeStock(stock, run.blankId, -number(run.qty));
    changeStock(stock, run.printedId, number(run.qty));
  }
  return stock;
}

export function availableMaterials(data) {
  const stock = Object.fromEntries(data.materials.map(material => [material.id, number(material.openingQty)]));
  for (const purchase of data.materialPurchases) changeStock(stock, purchase.materialId, number(purchase.qty));
  for (const run of data.production) {
    for (const item of run.consumption ?? []) changeStock(stock, item.materialId, -number(item.qty));
  }
  return stock;
}

const stockFields = {
  purchases: ['productId', 'qty'],
  materialPurchases: ['materialId', 'qty'],
  sales: ['productId', 'qty'],
  returns: ['saleId', 'qty', 'condition'],
};

export function affectsStock(table, changes) {
  return stockFields[table]?.some(key => key in changes) ?? false;
}

export function validateStockEdit(table, data, id, changes) {
  const original = data[table].find(row => row.id === id);
  if (!original) throw Error('This entry was removed.');
  const edited = {...original, ...changes};
  const updated = {...data, [table]: data[table].map(row => row.id === id ? edited : row)};
  if (table === 'sales' || table === 'returns') {
    const sale = table === 'sales' ? edited : updated.sales.find(row => row.id === edited.saleId);
    if (!sale) throw Error('Choose an original sale');
    const returned = updated.returns.reduce((total, row) => row.saleId === sale.id ? total + number(row.qty) : total, 0);
    if (returned - number(sale.qty) > 1e-8) throw Error('Return quantity exceeds the original sale quantity');
  }
  const material = table === 'materialPurchases';
  const calculate = material ? availableMaterials : productStock;
  const before = calculate(data);
  const after = calculate(updated);
  if (Object.keys(after).some(key => after[key] < Math.min(0, number(before[key])) - 1e-8)) {
    throw Error(material ? 'This edit would leave insufficient material stock' : 'This edit would leave insufficient product stock');
  }
}

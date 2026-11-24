import {money, number} from './purchaseReconciliation.js';

export const advancePurchaseFields = {
  purchases: 'purchaseId',
  materialPurchases: 'materialPurchaseId',
  equipmentPurchases: 'equipmentPurchaseId',
};

export function advanceBalances(advances, allocations) {
  const used = new Map();
  for (const allocation of allocations) {
    used.set(allocation.advanceId, money((used.get(allocation.advanceId) ?? 0) + number(allocation.amount)));
  }
  return advances.map(advance => ({
    ...advance, remaining: money(number(advance.amount) - (used.get(advance.id) ?? 0)),
  }));
}

export function purchasesWithAdvances(rows, category, allocations) {
  const field = advancePurchaseFields[category];
  const applied = new Map();
  for (const allocation of allocations) {
    const id = allocation[field];
    if (id) applied.set(id, money((applied.get(id) ?? 0) + number(allocation.amount)));
  }
  return rows.map(row => ({...row, advanceApplied: applied.get(row.id) ?? 0}));
}

export function canApplyAdvance(row) {
  const invoices = row.invoiceDetails ?? [];
  return Boolean(row.supplier?.trim()) && row.actualPayment != null && row.actualPayment !== ''
    && invoices.some(invoice => invoice.kind === 'Product')
    && invoices.every(invoice => invoice.verified === true);
}

import {createClient} from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL;
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const configured=Boolean(url&&key);
export const supabase=configured?createClient(url,key):null;
export const tables=['products','purchases','sales','returns','materials','materialPurchases','production','expenses','settlements','equipmentPurchases','stockAdjustments','supplierAdvances','supplierAdvanceAllocations'];
const tableName={materialPurchases:'material_purchases',equipmentPurchases:'equipment_purchases',stockAdjustments:'stock_adjustments',supplierAdvances:'supplier_advances',supplierAdvanceAllocations:'supplier_advance_allocations'};
const columnName={productId:'product_id',materialId:'material_id',saleId:'sale_id',orderId:'order_id',blankId:'blank_id',printedId:'printed_id',otherCost:'other_cost',qtyChange:'qty_change'};
const dateName={purchases:'purchased_on',sales:'sold_on',returns:'returned_on',materialPurchases:'purchased_on',production:'produced_on',expenses:'spent_on',settlements:'settled_on',equipmentPurchases:'purchased_on',stockAdjustments:'adjusted_on',supplierAdvances:'paid_on'};
const dbName=t=>tableName[t]||t;
const toCamel=k=>k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
const toDb=k=>columnName[k]||k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
export function fromRow(t,row){const x={};for(const [k,v] of Object.entries(row)){if(k==='owner_id'||k==='created_at')continue;x[k===dateName[t]?'date':toCamel(k)]=v;}return x;}
export function toRow(t,x){const y={};for(const [k,v] of Object.entries(x)){if(k==='consumption'||k==='id'||k==='ownerId')continue;if(k==='date'){if(dateName[t])y[dateName[t]]=v;continue;}y[toDb(k)]=v;}return y;}
const PAGE_SIZE = 500;

async function fetchPages(query) {
  const results = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const {data, error} = await query().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    results.push(...data);
    if (data.length < PAGE_SIZE) return results;
  }
}

export async function fetchAll(){const out={};for(const t of tables){
  const rows = await fetchPages(() => supabase.from(dbName(t)).select('*').order('created_at').order('id'));
  out[t]=rows.map(row=>fromRow(t,row));
}
const {data:parts,error}=await supabase.from('production_materials').select('*');if(error)throw error;for(const part of parts){const p=out.production.find(x=>x.id===part.production_id);if(p)(p.consumption??=[]).push({materialId:part.material_id,qty:Number(part.qty)});}return out;}
export async function insertEntry(t,x){const {data,error}=await supabase.from(dbName(t)).insert(toRow(t,x)).select().single();if(error)throw error;if(t==='production'&&x.consumption?.length){const rows=x.consumption.map(c=>({production_id:data.id,material_id:c.materialId,qty:c.qty}));const res=await supabase.from('production_materials').insert(rows);if(res.error)throw res.error;}return data;}

export async function updateProduct(id,values){const {data,error}=await supabase.from('products').update(values).eq('id',id).select().single();if(error)throw error;return data;}

export async function updateSavedEntry(table, original, changes, fields) {
  const previous = toRow(table, Object.fromEntries(fields.map(key => [key, original[key]])));
  let query = supabase.from(dbName(table)).update(toRow(table, changes)).eq('id', original.id);
  for (const [column, value] of Object.entries(previous)) {
    query = value == null ? query.is(column, null) : query.eq(column, value);
  }
  const {data, error} = await query.select().maybeSingle();
  if (error) throw error;
  return data ? fromRow(table, data) : null;
}

export async function deleteEntry(t,id){const table=dbName(t);const {data,error}=await supabase.from(table).delete().eq('id',id).select('id');if(error)throw error;if(!data?.length)throw Error('Delete not permitted or record not found');return data[0];}

export async function updatePurchaseInvoices(table, purchase, invoiceDetails, actualPayment, supplier) {
  const {data, error} = await supabase.from(dbName(table))
    .update({invoice_details: invoiceDetails, actual_payment: actualPayment, ...(supplier!==undefined&&{supplier})})
    .eq('id', purchase.id)
    .eq('invoice_revision', purchase.invoiceRevision)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Error('This purchase changed. Reopen it with the latest details and review your invoices again.');
  return fromRow(table, data);
}

export async function findPurchase(table, id) {
  const {data, error} = await supabase.from(dbName(table)).select().eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertPurchase(table, purchase) {
  const {id, materialName, materialCategory, materialUnit, ...values} = purchase;
  const record = {id, ...toRow(table, values)};
  const result = table === 'materialPurchases'
    ? await supabase.rpc('record_material_purchase', {
      purchase: record, material_name: materialName, material_category: materialCategory, material_unit: materialUnit
    }).single()
    : await supabase.from(dbName(table)).insert(record).select().single();
  if (result.error) throw result.error;
  return result.data;
}

export async function saveAdvanceEntry(table, id, values) {
  const record = {id, ...toRow(table, values)};
  const source = supabase.from(dbName(table));
  const {data, error} = await source.insert(record).select().single();
  if (!error) return fromRow(table, data);
  // A network failure can occur after commit. Retry with the same draft ID.
  const {data: existing} = await source.select().eq('id', id).maybeSingle();
  if (existing && Object.entries(record).every(([key,value]) => String(existing[key]) === String(value))) {
    return fromRow(table, existing);
  }
  throw error;
}

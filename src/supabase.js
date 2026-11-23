import {createClient} from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL;
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const configured=Boolean(url&&key);
export const supabase=configured?createClient(url,key):null;
export const tables=['products','purchases','sales','returns','materials','materialPurchases','production','expenses','settlements'];
const tableName={materialPurchases:'material_purchases'};
const columnName={productId:'product_id',materialId:'material_id',saleId:'sale_id',orderId:'order_id',blankId:'blank_id',printedId:'printed_id',otherCost:'other_cost'};
const dateName={purchases:'purchased_on',sales:'sold_on',returns:'returned_on',materialPurchases:'purchased_on',production:'produced_on',expenses:'spent_on',settlements:'settled_on'};
const dbName=t=>tableName[t]||t;
const toCamel=k=>k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
const toDb=k=>columnName[k]||k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
export function fromRow(t,row){const x={};for(const [k,v] of Object.entries(row)){if(k==='owner_id'||k==='created_at')continue;x[k===dateName[t]?'date':toCamel(k)]=v;}return x;}
export function toRow(t,x){const y={};for(const [k,v] of Object.entries(x)){if(k==='consumption'||k==='id'||k==='ownerId')continue;if(k==='date'){if(dateName[t])y[dateName[t]]=v;continue;}y[toDb(k)]=v;}return y;}
export async function fetchAll(){const out={};for(const t of tables){const {data,error}=await supabase.from(dbName(t)).select('*').order('created_at',{ascending:true});if(error)throw error;out[t]=data.map(row=>fromRow(t,row));}
const {data:parts,error}=await supabase.from('production_materials').select('*');if(error)throw error;for(const part of parts){const p=out.production.find(x=>x.id===part.production_id);if(p)(p.consumption??=[]).push({materialId:part.material_id,qty:Number(part.qty)});}return out;}
export async function insertEntry(t,x){const {data,error}=await supabase.from(dbName(t)).insert(toRow(t,x)).select().single();if(error)throw error;if(t==='production'&&x.consumption?.length){const rows=x.consumption.map(c=>({production_id:data.id,material_id:c.materialId,qty:c.qty}));const res=await supabase.from('production_materials').insert(rows);if(res.error)throw res.error;}return data;}

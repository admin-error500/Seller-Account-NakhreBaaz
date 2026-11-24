import PurchaseInvoices from './PurchaseInvoices.jsx';
import {purchasePages, purchaseDetails, purchaseTotals, parseMoney, taxDetails, number, money, normalizeInvoiceKey} from './purchaseReconciliation.js';
import {prepareInvoices, uploadInvoices, discardInvoiceUploads, invoiceSaveError, isDefinitiveWriteError} from './purchaseInvoiceStorage.js';
import React,{useState,useMemo,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import {supabase,configured,fetchAll,insertEntry,updateProduct,deleteEntry,updatePurchaseInvoices,fromRow,findPurchase,insertPurchase} from './supabase';
const sizes=['14','16','18','20','22','24','26','28','30','32','34','36','38','40','42','44','46','48','S','M','L','XL','XXL','3XL'];
const channels=['Meesho','Flipkart','Amazon','Direct','Other'];

const initial={products:[],purchases:[],sales:[],returns:[],materials:[],materialPurchases:[],production:[],expenses:[],settlements:[],equipmentPurchases:[],stockAdjustments:[]};
const schemas={
products:{label:'Products & Stock',fields:{sku:'text',name:'text',size:sizes,color:'text',type:['BLANK','PRINTED']}},
purchases:{label:'T-Shirt Purchases',fields:{productId:'product',qty:'number',rate:'number',gstRate:[0,3,5,12,18,28,40],gstInclusive:['No','Yes'],supplier:'text',invoice:'text',date:'date'}},
sales:{label:'Sales',fields:{productId:'product',platform:channels,orderId:'text',qty:'number',price:'number',gstRate:[0,5,12,18,28],gstInclusive:['No','Yes'],fee:'number',shipping:'number',date:'date'}},
returns:{label:'Customer Returns',fields:{saleId:'sale',qty:'number',condition:['SELLABLE','DAMAGED'],refund:'number',date:'date'}},
materials:{label:'Raw Materials',fields:{name:'text',category:['Ink','Sublimation Paper','Packaging Bag','Shipping Label','Machine','Other'],unit:['pcs','ml','sheets','kg','meters'],openingQty:'number'}},
materialPurchases:{label:'Material Purchases',fields:{materialName:'text',materialCategory:['Ink','Sublimation Paper','Packaging Bag','Shipping Label','Machine','Other'],materialUnit:['pcs','ml','sheets','kg','meters'],qty:'number',rate:'number',gstRate:[0,3,5,12,18,28,40],gstInclusive:['No','Yes'],supplier:'text',invoice:'text',date:'date'}},
production:{label:'Production',fields:{blankId:'blank',printedId:'printed',qty:'number',electricity:'number',otherCost:'number',date:'date'}},
expenses:{label:'Expenses',fields:{category:'text',description:'text',amount:'number',date:'date'}},
equipmentPurchases:{label:'Machines & Equipment',fields:{name:'text',qty:'number',rate:'number',gstRate:[0,3,5,12,18,28,40],gstInclusive:['No','Yes'],supplier:'text',invoice:'text',date:'date'}},
settlements:{label:'Settlements',fields:{platform:channels,reference:'text',amount:'number',date:'date'}}
};
const fieldLabels={openingQty:'Opening Quantity',gstRate:'GST Rate (%)',gstInclusive:'GST included in unit price?',productId:'Product',qty:'Quantity',rate:'Unit Price (₹)',supplier:'Supplier Name',invoice:'Invoice Number',date:'Date',sku:'SKU',name:'Product Name',size:'Size',color:'Color',type:'Product Type',platform:'Marketplace',orderId:'Order ID',price:'Selling Price (₹)',fee:'Marketplace Fee (₹)',shipping:'Shipping Cost (₹)',materialName:'Material Name',materialCategory:'Category',materialUnit:'Unit',materialId:'Material',saleId:'Original Sale',refund:'Refund (₹)',electricity:'Electricity Cost (₹)',otherCost:'Other Cost (₹)',blankId:'Blank T-Shirt',printedId:'Printed T-Shirt'};
const fieldLabel=k=>fieldLabels[k]||k.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase());
const today=()=>new Date().toISOString().slice(0,10);
const rupees=n=>'₹'+(Number(n)||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
function PurchaseAmounts({row}) {
  const amounts=purchaseDetails(row);
  return <><td>{rupees(amounts.paid)}{!amounts.hasActualPayment&&<small className="legacy-payment">Legacy estimate</small>}</td>
    <td>{rupees(amounts.invoiceTotal)}</td><td>{rupees(amounts.tax)}</td>
    <td><strong>{amounts.status}</strong>{(amounts.pending>0||amounts.mismatch>0)&&
      <small className="legacy-payment">{rupees(amounts.mismatch||amounts.pending)}</small>}</td></>;
}
function App(){
const [invoiceLines,setInvoiceLines]=useState([]);
const [attachment,setAttachment]=useState(null);
const purchaseDraftId=useRef(null);
const attachmentForm=useRef(null);const [editingProduct,setEditingProduct]=useState(null),[adjustingProduct,setAdjustingProduct]=useState(null),[adjustQty,setAdjustQty]=useState(''),[adjustReason,setAdjustReason]=useState('Stock count correction'),[reportMonth,setReportMonth]=useState(today().slice(0,7)),[saving,setSaving]=useState(false),[data,setData]=useState(initial),[session,setSession]=useState(null),[loading,setLoading]=useState(true),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[page,setPage]=useState('overview'),[form,setForm]=useState({}),[adding,setAdding]=useState(false),[message,setMessage]=useState('');
React.useEffect(()=>{if(!configured){setLoading(false);return;}supabase.auth.getSession().then(({data:{session}})=>{setSession(session);setLoading(false)});const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>setSession(session));return()=>subscription.unsubscribe()},[]);
React.useEffect(()=>{if(!session)return;fetchAll().then(setData).catch(e=>setMessage(e.message))},[session]);
const save=next=>setData(next);
const isAdmin=session?.user?.app_metadata?.seller_role==='admin';
async function removeRecord(t,row){if(!isAdmin){setMessage('Only admin can delete entries');return;}const label=t==='products'?productName(row.id):t==='sales'?row.orderId:t==='materials'?row.name:row.name||row.invoice||row.id;const yes=window.confirm('Permanently delete '+label+'? This may change stock and monthly reports. This cannot be undone.');if(!yes)return;setSaving(true);try{await deleteEntry(t,row.id);save(await fetchAll());setMessage('Entry deleted successfully')}catch(err){setMessage('Delete failed: '+err.message+'. Delete dependent records first if applicable.')}finally{setSaving(false)}}
const product=id=>data.products.find(p=>p.id===id);
const productName=id=>{const p=product(id);return p? [p.name,p.size,p.color,p.type].join(' / '):'Unknown product'};
const stock=useMemo(()=>{const s=Object.fromEntries(data.products.map(p=>[p.id,0]));for(const a of data.stockAdjustments)s[a.productId]=(s[a.productId]||0)+number(a.qtyChange);for(const p of data.purchases)s[p.productId]=(s[p.productId]||0)+number(p.qty);for(const p of data.sales)s[p.productId]=(s[p.productId]||0)-number(p.qty);for(const p of data.returns)if(p.condition==='SELLABLE')s[p.productId]=(s[p.productId]||0)+number(p.qty);for(const p of data.production){s[p.blankId]=(s[p.blankId]||0)-number(p.qty);s[p.printedId]=(s[p.printedId]||0)+number(p.qty)}return s},[data]);
async function submitProductEdit(e){e.preventDefault();setSaving(true);try{const sku=editingProduct.sku.trim();if(!sku)throw Error('SKU required');if(data.products.some(p=>p.id!==editingProduct.id&&p.sku===sku))throw Error('SKU already exists');await updateProduct(editingProduct.id,{sku,name:editingProduct.name.trim(),size:editingProduct.size,color:editingProduct.color.trim(),type:editingProduct.type});save(await fetchAll());setEditingProduct(null);setMessage('Product updated')}catch(err){setMessage(err.message)}finally{setSaving(false)}}
async function submitStockAdjustment(e){e.preventDefault();setSaving(true);try{const desired=Number(adjustQty);if(!Number.isFinite(desired)||desired<0||!Number.isInteger(desired))throw Error('Enter a valid non-negative whole quantity');const delta=desired-number(stock[adjustingProduct.id]);if(!delta)throw Error('Stock is already at that quantity');await insertEntry('stockAdjustments',{productId:adjustingProduct.id,qtyChange:delta,reason:adjustReason,date:today()});save(await fetchAll());setAdjustingProduct(null);setAdjustQty('');setMessage('Stock adjustment saved with history')}catch(err){setMessage(err.message)}finally{setSaving(false)}}
const materialStock=useMemo(()=>{const s=Object.fromEntries(data.materials.map(p=>[p.id,number(p.openingQty)]));for(const p of data.materialPurchases)s[p.materialId]=(s[p.materialId]||0)+number(p.qty);for(const p of data.production)for(const c of p.consumption||[])s[c.materialId]=(s[c.materialId]||0)-number(c.qty);return s},[data]);
const gross=data.sales.reduce((a,x)=>a+taxDetails(x.qty,x.price,x.gstRate,x.gstInclusive).total,0),refunds=data.returns.reduce((a,x)=>a+number(x.refund),0),purchases=data.purchases.reduce((a,x)=>a+purchaseDetails(x).paid,0),materials=data.materialPurchases.reduce((a,x)=>a+purchaseDetails(x).paid,0),equipment=data.equipmentPurchases.reduce((a,x)=>a+purchaseDetails(x).paid,0),expenses=data.expenses.reduce((a,x)=>a+number(x.amount),0),fees=data.sales.reduce((a,x)=>a+number(x.fee)+number(x.shipping),0),received=data.settlements.reduce((a,x)=>a+number(x.amount),0);
const options=(kind)=>kind==='product'?data.products:kind==='blank'?data.products.filter(p=>p.type==='BLANK'):kind==='printed'?data.products.filter(p=>p.type==='PRINTED'):kind==='material'?data.materials:data.sales;
const fields=schemas[page]?.fields;
const isTaxPage=['purchases','sales','materialPurchases','equipmentPurchases'].includes(page);
const isPurchase=purchasePages.includes(page);
const purchasePreview=isPurchase?purchaseDetails({...form,invoiceDetails:invoiceLines
  .filter(line=>line.amount!==''&&line.amount!=null&&line.gst!==''&&line.gst!=null)
  .map(line=>({...line,verified:true}))}):null;
const overviewPurchases=purchaseTotals(purchasePages.flatMap(key=>data[key]));
const attachmentOpen=attachment?.page===page&&!adding;
React.useEffect(()=>{
  if (attachmentOpen) attachmentForm.current?.scrollIntoView({block:'nearest'});
},[attachmentOpen,attachment?.row.id]);
const taxPreview=isTaxPage?taxDetails(form.qty,form[page==='sales'?'price':'rate'],form.gstRate,form.gstInclusive==='Yes'):null;
const monthly=(items)=>items.filter(x=>String(x.date||'').slice(0,7)===reportMonth);
const mSales=monthly(data.sales),mPurchases=monthly(data.purchases),mMaterials=monthly(data.materialPurchases),mEquipment=monthly(data.equipmentPurchases),mReturns=monthly(data.returns),mExpenses=monthly(data.expenses),mSettlements=monthly(data.settlements),mProduction=monthly(data.production);
const sum=(items,fn)=>money(items.reduce((a,x)=>a+fn(x),0));
const saleTotal=sum(mSales,x=>taxDetails(x.qty,x.price,x.gstRate,x.gstInclusive).total),saleTax=sum(mSales,x=>taxDetails(x.qty,x.price,x.gstRate,x.gstInclusive).tax),purchaseTotal=sum(mPurchases,x=>purchaseDetails(x).paid),materialTotal=sum(mMaterials,x=>purchaseDetails(x).paid),equipmentTotal=sum(mEquipment,x=>purchaseDetails(x).paid),refundTotal=sum(mReturns,x=>number(x.refund)),feeTotal=sum(mSales,x=>number(x.fee)+number(x.shipping)),expenseTotal=sum(mExpenses,x=>number(x.amount)),productionCost=sum(mProduction,x=>number(x.electricity)+number(x.otherCost)),settledTotal=sum(mSettlements,x=>number(x.amount));
const cashEstimate=money(saleTotal-refundTotal-purchaseTotal-materialTotal-equipmentTotal-feeTotal-expenseTotal-productionCost);
const monthPurchases=purchaseTotals([...mPurchases,...mMaterials,...mEquipment]);
const reconciliationRows=totals=>[
  ['Received invoice total',totals.invoiceTotal],['Documented purchase GST',totals.tax],
  ['Pending purchase reconciliation',totals.pending],['Purchase invoice amount above payment',totals.mismatch],
];
const monthlyReportRows=[['Gross sales (customer billed)',saleTotal],['GST collected on sales (recorded)',saleTax],['T-shirt purchase payments',purchaseTotal],['Material purchase payments',materialTotal],['Equipment purchase payments',equipmentTotal],...reconciliationRows(monthPurchases),['Purchase GST recorded (including legacy estimates)',monthPurchases.recordedTax],['Customer refunds',refundTotal],['Marketplace fees + shipping',feeTotal],['Other expenses',expenseTotal],['Production electricity + other costs',productionCost],['Marketplace settlements received',settledTotal],['Estimated cash movement (not profit)',cashEstimate]];

function applyInvoice(line, automatic=false) {
  if (line.kind!=='Product') return;
  const normalized=normalizeInvoiceKey(line.product);
  const matches=normalized?data.products.filter(item=>
    [item.sku,item.name].some(value=>normalizeInvoiceKey(value)===normalized)): [];
  const productDiscount=line.productDiscount??line.discount;
  const values={supplier:line.supplier,invoice:line.reference,purchasePlatform:line.platform,purchaseOrderId:line.orderId,
    qty:line.quantity,rate:line.unitPrice,gstRate:line.gstRate,purchaseDiscount:line.multipleProducts?null:productDiscount};
  if (page==='purchases'&&matches.length===1) values.productId=matches[0].id;
  if (!line.multipleProducts&&page==='materialPurchases') values.materialName=line.product;
  if (!line.multipleProducts&&page==='equipmentPurchases') values.name=line.product;
  if (line.unitPrice!=null&&line.quantity>0&&line.amount!=null&&line.gst!=null) {
    const base=line.unitPrice*line.quantity-(productDiscount??0);
    if (Math.abs(base+line.gst-line.amount)<=.05) values.gstInclusive='No';
    else if (Math.abs(base-line.amount)<=.05) values.gstInclusive='Yes';
  }
  setForm(current=>({...current,...Object.fromEntries(Object.entries(values).filter(([key,value])=>
    value!==''&&value!=null&&(!automatic||current[key]==null||current[key]==='')))}));
}

function openAttachment(row, legacyIndex) {
  const existing=legacyIndex==null?null:legacyIndex===-1
    ? {kind:'Product',reference:row.invoice,path:row.invoicePath}
    : row.invoiceDetails[legacyIndex];
  setAttachment({page,row,editorId:crypto.randomUUID(),actualPayment:String(purchaseDetails(row).paid)});
  setInvoiceLines([{
    ...existing,id:crypto.randomUUID(),kind:existing?.kind??'Product',
    supplier:existing?.supplier??row.supplier??'',
    ...(existing?.kind==='Product'&&{amount:'',gst:''}),
    legacyIndex:legacyIndex>=0?legacyIndex:null,
  }]);
  setMessage('');
}

async function submitAttachment(event) {
  event.preventDefault();
  if (saving||invoiceLines.some(line=>line.reading)) return;
  setSaving(true);
  const paths=[];
  let committed=false;
  let writeStarted=false;
  try {
    const actualPayment=parseMoney(attachment.actualPayment,'actual payment');
    const invoices=await prepareInvoices(invoiceLines,attachment.row.invoiceDetails??[]);
    const uploaded=await uploadInvoices(invoices,session.user.id,paths);
    writeStarted=true;
    const updated=await updatePurchaseInvoices(page,attachment.row,uploaded,actualPayment);
    committed=true;
    setData(previous=>({...previous,[page]:previous[page].map(row=>row.id===updated.id?updated:row)}));
    setAttachment(null);
    setInvoiceLines([]);
    setMessage('Purchase reconciliation updated.');
  } catch (error) {
    if (!committed&&(!writeStarted||isDefinitiveWriteError(error))) await discardInvoiceUploads(paths);
    if (/This purchase changed/.test(error.message)) {
      await discardInvoiceUploads(paths);
      setAttachment(null);
      setInvoiceLines([]);
      try { save(await fetchAll()); } catch { /* Keep the original conflict message. */ }
    }
    setMessage(invoiceSaveError(error));
  } finally {
    setSaving(false);
  }
}

async function submit(event) {
  event.preventDefault();
  if (saving||invoiceLines.some(line=>line.reading)) return;
  setSaving(true);
  const uploadedPaths=[];
  let committed=false;
  let writeStarted=false;
  try {
    const x={...form};
    if (isTaxPage) {
      x.gstRate=number(x.gstRate);
      x.gstInclusive=x.gstInclusive==='Yes';
    }
    for (const [key,type] of Object.entries(fields)) if (type==='number') x[key]=number(x[key]);
    if (page==='materials'&&(!Number.isFinite(Number(form.openingQty??0))||x.openingQty<0)) {
      throw Error('Opening quantity must be zero or greater');
    }
    if (page==='products'&&data.products.some(p=>p.sku===x.sku)) throw Error('SKU already exists');
    if ('qty' in fields&&!(x.qty>0)) throw Error('Quantity must be greater than zero');
    if (page==='sales'&&number(stock[x.productId])<x.qty) throw Error('Insufficient stock');
    if (page==='returns') {
      const sale=data.sales.find(s=>s.id===x.saleId);
      if (!sale) throw Error('Choose original sale');
      const returned=data.returns.filter(r=>r.saleId===sale.id).reduce((sum,r)=>sum+number(r.qty),0);
      if (returned+x.qty>sale.qty) throw Error('Return quantity exceeds sale quantity');
    }
    if (page==='production') {
      const blank=product(x.blankId), printed=product(x.printedId);
      if (!blank||!printed||blank.size!==printed.size||blank.color.toLowerCase()!==printed.color.toLowerCase()) {
        throw Error('Blank and printed size/color must match');
      }
      if (number(stock[x.blankId])<x.qty) throw Error('Insufficient blank stock');
      x.consumption=data.materials.map(m=>({materialId:m.id,qty:number(x['consume_'+m.id])})).filter(c=>c.qty>0);
      for (const c of x.consumption) if (c.qty>number(materialStock[c.materialId])) throw Error('Insufficient material stock');
      for (const key of Object.keys(x)) if (key.startsWith('consume_')) delete x[key];
    }
    x.date=x.date||today();
    let created;
    if (isPurchase) {
      if (purchaseDraftId.current) created=await findPurchase(page,purchaseDraftId.current);
      if (!created) {
        purchaseDraftId.current??=crypto.randomUUID();
        x.id=purchaseDraftId.current;
        x.purchaseDiscount=form.purchaseDiscount?parseMoney(form.purchaseDiscount,'discount'):0;
        x.rewardsUsed=form.rewardsUsed?parseMoney(form.rewardsUsed,'rewards'):0;
        x.actualPayment=parseMoney(form.actualPayment,'actual payment');
        if (page==='materialPurchases'&&!x.materialName?.trim()) throw Error('Material name required');
        const invoices=await prepareInvoices(invoiceLines);
        x.invoiceDetails=await uploadInvoices(invoices,session.user.id,uploadedPaths);
        writeStarted=true;
        created=await insertPurchase(page,x);
      }
    } else {
      created=await insertEntry(page,x);
    }
    committed=true;
    if (isPurchase) setData(previous=>({...previous,
      [page]:[...previous[page].filter(row=>row.id!==created.id),fromRow(page,created)]}));
    setAdding(false);
    setForm({});
    setInvoiceLines([]);
    setMessage('Entry saved');
    try { save(await fetchAll()); }
    catch (error) { setMessage('Entry saved. Refresh to reload all records. '+error.message); }
  } catch (error) {
    if (!committed&&(!writeStarted||isDefinitiveWriteError(error))) await discardInvoiceUploads(uploadedPaths);
    setMessage(invoiceSaveError(error));
  } finally {
    setSaving(false);
  }
}

function exportFile(name,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function csv(table){const rows=data[table];if(!rows.length){setMessage('No records to export');return}const keys=[...new Set(rows.flatMap(x=>Object.keys(x)))];const q=v=>'"'+String(v==null?'':typeof v==='object'?JSON.stringify(v):v).replaceAll('"','""')+'"';exportFile(table+'.csv',[keys.join(','),...rows.map(r=>keys.map(k=>q(r[k])).join(','))].join('\r\n'),'text/csv')}
function restore(e){setMessage('Cloud backup restore is disabled to protect database integrity.');return;
const file=e.target.files?.[0];if(!file)return;file.text().then(t=>{try{const x=JSON.parse(t);if(!x||!Array.isArray(x.products)||!Array.isArray(x.sales))throw Error('Invalid backup');setMessage('Cloud restore disabled')}catch(err){setMessage(err.message)}})}
async function viewInvoice(path){const {data,error}=await supabase.storage.from('purchase-invoices').createSignedUrl(path,60);if(error){setMessage(error.message);return;}window.open(data.signedUrl,'_blank','noopener,noreferrer')}
function display(row,k){if(k==='productId'||k==='blankId'||k==='printedId')return productName(row[k]);if(k==='materialId')return data.materials.find(m=>m.id===row[k])?.name||'Unknown';if(k==='saleId')return data.sales.find(s=>s.id===row[k])?.orderId||'Unknown';if(['price','rate','fee','shipping','refund','amount','electricity','otherCost'].includes(k))return rupees(row[k]);return typeof row[k]==='object'?JSON.stringify(row[k]):String(row[k]??'—')}
if(loading)return <main><h1>Loading Seller Hub...</h1></main>;
if(!configured)return <main><h1>Supabase configuration required</h1><p>Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in Vercel project environment variables.</p></main>;
if(!session)return <main className="login"><h1>NAKHREBAAZ Seller Hub</h1><p>Secure admin sign in</p><form onSubmit={async e=>{e.preventDefault();const {error}=await supabase.auth.signInWithPassword({email,password});if(error)setMessage(error.message)}}><label>Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Password<input type="password" required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="primary">Sign in</button>{message&&<p>{message}</p>}</form></main>;
return <div className="shell"><aside><h2>NAKHREBAAZ <small>SELLER HUB</small></h2><nav><button className={page==='overview'?'active':''} onClick={()=>{setPage('overview');setAdding(false)}}>Overview</button>{Object.entries(schemas).filter(([key])=>key!=='materials').map(([key,v])=><button key={key} className={page===key?'active':''} onClick={()=>{setPage(key);setAdding(false);setAttachment(null);setMessage('')}}>{v.label}</button>)}<button className={page==='monthly'?'active':''} onClick={()=>{setPage('monthly');setAdding(false)}}>Monthly Business Report</button><button className={page==='reports'?'active':''} onClick={()=>setPage('reports')}>Reports & Backup</button></nav><button onClick={()=>supabase.auth.signOut()}>Sign out</button><p className="aside-note">Supabase cloud workspace</p></aside><main><header><span>NAKHREBAAZ · MULTI-CHANNEL OPERATIONS</span><h1>{schemas[page]?.label|| (page==='overview'?'Overview':page==='monthly'?'Monthly Business Report':'Reports & Backup')}</h1><p>Meesho · Flipkart · Amazon · Direct</p></header>{message&&<div className="notice"><span role="status">{message}</span><button type="button" aria-label="Dismiss message" onClick={()=>setMessage('')}>×</button></div>}
{page==='overview'&&<><div className="stats">{[['Gross Sales',rupees(gross)],['Returns / Refunds',rupees(refunds)],['T-Shirt Purchases',rupees(purchases)],['Material Purchases',rupees(materials)],['Machines & Equipment',rupees(equipment)],['Total Purchase Payments',rupees(overviewPurchases.paid)],...reconciliationRows(overviewPurchases).map(([label,value])=>[label,rupees(value)]),['Other Expenses',rupees(expenses)],['Marketplace Charges',rupees(fees)],['Cash Movement Estimate',rupees(gross-refunds-purchases-materials-equipment-expenses-fees-data.production.reduce((a,x)=>a+number(x.electricity)+number(x.otherCost),0))],['Stock Units',Object.values(stock).reduce((a,v)=>a+v,0)],['Settlements Recorded',rupees(received)]].map(([label,value])=><article key={label}><small>{label}</small><strong>{value}</strong></article>)}</div><section><h2>Platform Sales</h2><div className="stats">{channels.map(c=><article key={c}><small>{c}</small><strong>{rupees(data.sales.filter(x=>x.platform===c).reduce((a,x)=>a+taxDetails(x.qty,x.price,x.gstRate,x.gstInclusive).total,0))}</strong></article>)}</div></section><section><h2>Low Stock Alerts</h2>{data.products.filter(p=>number(stock[p.id])<=10).map(p=><p key={p.id}>{productName(p.id)} — {number(stock[p.id])} pcs</p>)}{!data.products.length&&<p>No products yet.</p>}</section><p className="muted">Cash movement is not net accounting profit. Inventory costs, fees, tax and marketplace payouts need reconciliation.</p></>}
{page==='products'&&editingProduct&&<form className="entry-form" onSubmit={submitProductEdit}><h2>Edit Product</h2><div className="fields">{Object.entries(schemas.products.fields).map(([k,t])=><label key={k}>{fieldLabel(k)}{Array.isArray(t)?<select required value={editingProduct[k]} onChange={e=>setEditingProduct({...editingProduct,[k]:e.target.value})}>{t.map(v=><option key={v} value={v}>{v}</option>)}</select>:<input required value={editingProduct[k]??''} onChange={e=>setEditingProduct({...editingProduct,[k]:e.target.value})}/>}</label>)}</div><div className="form-actions"><button className="primary" disabled={saving}>Save Changes</button><button type="button" onClick={()=>setEditingProduct(null)}>Cancel</button></div></form>}{page==='products'&&adjustingProduct&&<form className="entry-form" onSubmit={submitStockAdjustment}><h2>Adjust Stock — {productName(adjustingProduct.id)}</h2><p>Current stock: <strong>{number(stock[adjustingProduct.id])}</strong> units. Enter the correct total stock. A signed adjustment is recorded; purchases and sales are not overwritten.</p><div className="fields"><label>Correct Stock Quantity<input required type="number" min="0" step="1" value={adjustQty} onChange={e=>setAdjustQty(e.target.value)}/></label><label>Reason<select required value={adjustReason} onChange={e=>setAdjustReason(e.target.value)}>{['Stock count correction','Opening stock','Damaged stock','Lost stock','Other adjustment'].map(x=><option key={x}>{x}</option>)}</select></label></div><div className="form-actions"><button className="primary" disabled={saving}>Save Stock Adjustment</button><button type="button" onClick={()=>setAdjustingProduct(null)}>Cancel</button></div></form>}{fields&&<><div className="toolbar"><p>Manage records for {schemas[page].label}.</p><button className="primary" onClick={()=>{setAdding(!adding);purchaseDraftId.current=null;setAttachment(null);setForm({});setInvoiceLines([])}}>+ Add Entry</button></div>{adding&&<form className="entry-form" onSubmit={submit}><div className="form-heading"><h2>{page==='purchases'?'Add T-Shirt Purchase':page==='materialPurchases'?'Add Material Purchase':'New Entry'}</h2><p>Fill in the details below to save your record.</p></div><div className="fields">{Object.entries(fields).map(([k,t])=><label className={page==='materials'&&k==='unit'?'material-unit-field':page==='materials'&&k==='openingQty'?'material-qty-field':undefined} key={k}>{fieldLabel(k)} {Array.isArray(t)?<select required value={form[k]??''} onChange={e=>setForm({...form,[k]:e.target.value})}><option value="">Select</option>{t.map(v=><option key={v} value={v}>{v}</option>)}</select>:['product','blank','printed','material','sale'].includes(t)?<select required value={form[k]||''} onChange={e=>setForm({...form,[k]:e.target.value})}><option value="">{t==='product'?'Choose a product':'Choose an option'}</option>{options(t).map(x=><option value={x.id} key={x.id}>{t==='material'?x.name:t==='sale'?x.orderId:productName(x.id)+(product(x.id)?.sku?' · '+product(x.id).sku:'')}</option>)}</select>:<input required={!['supplier','invoice','fee','shipping','refund','electricity','otherCost','date','openingQty'].includes(k)} type={t==='number'?'number':t==='date'?'date':'text'} min={t==='number'?'0':undefined} step={t==='number'?'0.01':undefined} value={form[k]??(t==='date'?today():'')} onChange={e=>setForm({...form,[k]:e.target.value})}/>}</label>)}{isPurchase&&<>
  <div className="tax-summary purchase-payment"><strong>Purchase payment</strong>
    <div className="fields">{[['actualPayment','Actual payment (₹)'],['purchasePlatform','Purchase platform'],['purchaseOrderId','Order ID'],['purchaseDiscount','Purchase discount (₹)'],['rewardsUsed','Rewards redeemed (₹)']].map(([key,label])=>{
      const isAmount=['actualPayment','purchaseDiscount','rewardsUsed'].includes(key);
      return <label key={key}>{label}<input required={key==='actualPayment'} type={isAmount?'number':'text'}
        min={isAmount?0:undefined} step={isAmount?'0.01':undefined}
        value={form[key]??''} onChange={event=>setForm({...form,[key]:event.target.value})}/></label>;
    })}</div>
    <small>Enter the amount you paid. Invoice totals and GST update separately as documents arrive.</small>
  </div>
  <PurchaseInvoices lines={invoiceLines} setLines={setInvoiceLines} onApply={applyInvoice}
    onExtract={line=>applyInvoice(line,true)} saving={saving} viewInvoice={viewInvoice}/>
  <div className="tax-summary"><div><span>Received invoice total</span><b>{rupees(purchasePreview.invoiceTotal)}</b></div>
    <div><span>Documented GST</span><b>{rupees(purchasePreview.tax)}</b></div>
    {purchasePreview.hasActualPayment&&<div><span>{purchasePreview.status}</span>
      <b>{rupees(purchasePreview.mismatch||purchasePreview.pending)}</b></div>}
  </div>
</>}{isTaxPage&&<div className="tax-summary"><strong>Automatic GST calculation</strong><div><span>Taxable value</span><b>{rupees(taxPreview.base)}</b></div><div><span>GST ({number(form.gstRate)}%)</span><b>{rupees(taxPreview.tax)}</b></div><div className="tax-total"><span>{page==='sales'?'Customer total':'Purchase total'}</span><b>{rupees(taxPreview.total)}</b></div><small>Check invoice and applicable GST rate. GST reporting and input tax credit eligibility require accountant review.</small></div>}{page==='production'&&data.materials.map(m=><label key={m.id}>Consume {m.name} ({m.unit})<input type="number" min="0" step="0.001" value={form['consume_'+m.id]||''} onChange={e=>setForm({...form,['consume_'+m.id]:e.target.value})}/></label>)}</div><div className="form-actions"><button className="primary" type="submit" disabled={saving||invoiceLines.some(line=>line.reading)}>{saving?'Saving...':'Save Entry'}</button><button type="button" onClick={()=>setAdding(false)}>Cancel</button></div></form>}{attachmentOpen&&<form className="entry-form" ref={attachmentForm} onSubmit={submitAttachment}>
  <div className="form-heading"><h2>Add or verify invoices</h2>
    <p>{attachment.row.name||attachment.row.supplier||display(attachment.row,page==='purchases'?'productId':'materialId')} · {attachment.row.date}</p>
  </div>
  <div className="fields"><label>Actual payment (₹)<input required min="0" step="0.01" type="number"
    value={attachment.actualPayment} onChange={event=>setAttachment({...attachment,actualPayment:event.target.value})}/></label></div>
  <PurchaseInvoices key={attachment.editorId} lines={invoiceLines} setLines={setInvoiceLines} saving={saving} viewInvoice={viewInvoice}/>
  <div className="form-actions"><button type="submit" className="primary"
    disabled={saving||invoiceLines.some(line=>line.reading)}>Save reconciliation</button>
    <button type="button" disabled={saving} onClick={()=>{setAttachment(null);setInvoiceLines([])}}>Cancel</button></div>
</form>}<section><div className="toolbar"><h2>Entries ({data[page].length})</h2><button onClick={()=>csv(page)}>Export CSV</button></div><div className="tablewrap"><table><thead><tr>{Object.keys(fields).filter(k=>page!=='materialPurchases'||!['materialName','materialCategory','materialUnit'].includes(k)).map(k=><th key={k}>{fieldLabel(k)}</th>)}{page==='materialPurchases'&&<th>Material</th>}{['products','materials'].includes(page)&&<th>Available</th>}{isPurchase&&<th>Invoices / Order</th>}{isPurchase&&<><th>Actual payment</th><th>Received invoice total</th><th>Documented GST</th><th>Reconciliation</th></>}
{page==='sales'&&<><th>GST Amount</th><th>Total Incl. GST</th></>}{(page==='products'||isAdmin)&&<th className="actions-head">Actions</th>}</tr></thead><tbody>{[...data[page]].reverse().map(row=><tr key={row.id}>{Object.keys(fields).filter(k=>page!=='materialPurchases'||!['materialName','materialCategory','materialUnit'].includes(k)).map(k=><td key={k}>{display(row,k)}</td>)}{page==='materialPurchases'&&<td>{display(row,'materialId')}</td>}{page==='products'&&<td>{number(stock[row.id])}</td>}{page==='materials'&&<td>{number(materialStock[row.id])}</td>}{isPurchase&&<td className="invoice-cell">
  <div>{row.purchasePlatform} {row.purchaseOrderId}</div>
  {row.invoicePath&&<button className="compact-button" onClick={()=>viewInvoice(row.invoicePath)}>View invoice</button>}
  {row.invoice&&!(row.invoiceDetails??[]).some(line=>normalizeInvoiceKey(line.reference)===normalizeInvoiceKey(row.invoice))&&
    <button className="compact-button" disabled={saving} onClick={()=>openAttachment(row,-1)}>Verify {row.invoice}</button>}
  {(row.invoiceDetails??[]).map((line,index)=><div key={index}>
    {line.kind} · {line.reference}
    {line.path&&<button className="compact-button" onClick={()=>viewInvoice(line.path)}>View</button>}
    {!line.verified&&<button className="compact-button" disabled={saving} onClick={()=>openAttachment(row,index)}>Verify</button>}
  </div>)}
  <button className="compact-button" disabled={saving} onClick={()=>openAttachment(row)}>Add invoices</button>
</td>}
{isPurchase&&<PurchaseAmounts row={row}/>}
{page==='sales'&&<><td>{rupees(taxDetails(row.qty,row.price,row.gstRate,row.gstInclusive).tax)}</td>
<td>{rupees(taxDetails(row.qty,row.price,row.gstRate,row.gstInclusive).total)}</td></>}{(page==='products'||isAdmin)&&<td className="actions-cell"><div className="row-actions">{page==='products'&&<><button type="button" className="action-edit" onClick={()=>setEditingProduct({...row})}>Edit</button><button type="button" className="action-edit" onClick={()=>{setAdjustingProduct(row);setAdjustQty(String(number(stock[row.id])))}}>Adjust Stock</button></>}{isAdmin&&<button type="button" className="action-delete" disabled={saving} title="Delete this entry permanently" onClick={()=>removeRecord(page,row)}>Delete</button>}</div></td>}</tr>)}{!data[page].length&&<tr><td className="empty-state" colSpan={15}>No records yet. Add your first entry to get started.</td></tr>}</tbody></table></div></section></>}
{page==='monthly'&&<><section className="monthly-report"><div className="toolbar"><div><h2>Monthly Business Summary</h2><p>Choose a month to review all recorded business activity.</p></div><label>Report Month<input type="month" value={reportMonth} onChange={e=>setReportMonth(e.target.value)}/></label></div><div className="report-kpis"><article><small>Sales billed</small><strong>{rupees(saleTotal)}</strong></article><article><small>Purchases + equipment</small><strong>{rupees(purchaseTotal+materialTotal+equipmentTotal)}</strong></article><article><small>Returns / refunds</small><strong>{rupees(refundTotal)}</strong></article><article><small>Estimated cash movement</small><strong>{rupees(cashEstimate)}</strong></article></div><h2>Monthly Breakdown</h2><div className="tablewrap"><table><thead><tr><th>Metric</th><th>Amount</th></tr></thead><tbody>{monthlyReportRows.map(([name,amount])=><tr key={name}><td>{name}</td><td>{rupees(amount)}</td></tr>)}</tbody></table></div><h2>Sales by Marketplace</h2><div className="tablewrap"><table><thead><tr><th>Platform</th><th>Orders</th><th>Units</th><th>Billed Sales</th></tr></thead><tbody>{channels.map(ch=>{const rows=mSales.filter(x=>x.platform===ch);return <tr key={ch}><td>{ch}</td><td>{rows.length}</td><td>{sum(rows,x=>number(x.qty))}</td><td>{rupees(sum(rows,x=>taxDetails(x.qty,x.price,x.gstRate,x.gstInclusive).total))}</td></tr>})}</tbody></table></div><button className="primary" onClick={()=>{const lines=[['Metric','Amount (INR)'],...monthlyReportRows].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(','));exportFile('nakhrebaaz-monthly-'+reportMonth+'.csv',lines.join('\r\n'),'text/csv')}}>Download Monthly Report (CSV)</button><p className="report-warning">This is a recorded cash-flow estimate, NOT net profit or a GST return. Unsold inventory, depreciation, ITC eligibility, GST adjustments, payment timing and opening balances are not fully accounted for. Confirm GST figures with your accountant before filing.</p></section></>}
{page==='reports'&&<><section><h2>CSV Exports</h2><div className="buttons">{Object.keys(initial).map(k=><button key={k} onClick={()=>csv(k)}>Export {k} ({data[k].length})</button>)}</div></section><section><h2>Backup & Restore</h2><button className="primary" onClick={()=>exportFile('nakhrebaaz-backup-'+today()+'.json',JSON.stringify(data,null,2),'application/json')}>Download JSON Backup</button><p>Cloud restore requires a validated migration; direct JSON restore disabled.</p></section><section><h2>Limitations</h2><p>Supabase-backed records with email login; no marketplace API import, automatic refund reconciliation or GST accounting. Keep backups. Do not treat cash movement as net profit.</p></section></>}
</main></div>}
createRoot(document.getElementById('root')).render(<App/>);

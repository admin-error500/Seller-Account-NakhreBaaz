import {invoiceAttachment,invoiceLinksForCsv,linkedInvoicePath} from './purchaseInvoiceLinks.js';
import {downloadFile as exportFile,useRowSelection,RowCheckbox,SelectedExport} from './selectedExport.jsx';
import EntryDetails from './EntryDetails.jsx';
import SupplierAdvances,{ApplyAdvance} from './SupplierAdvances.jsx';
import {advanceBalances,advancePurchaseFields,purchasesWithAdvances,canApplyAdvance} from './supplierAdvances.js';
import {isAddressHeading} from './invoiceParser.js';
import PurchaseInvoices from './PurchaseInvoices.jsx';
import {purchasePages, purchaseDetails, purchaseTotals, parseMoney, taxDetails, number, money, normalizeInvoiceKey} from './purchaseReconciliation.js';
import {prepareInvoices, uploadInvoices, discardInvoiceUploads, invoiceSaveError, isDefinitiveWriteError} from './purchaseInvoiceStorage.js';
import {affectsStock, availableMaterials, entryChanges, entryFormValues, productStock, purchaseAmounts, purchasePaymentFields, validateStockEdit} from './entryEdits.js';
import React,{useState,useMemo,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {Eye, FilePlus, FileCheck, Upload, Pencil, Wallet, Trash2, Boxes} from 'lucide-react';
import './style.css';
import {supabase,configured,fetchAll,insertEntry,updateProduct,updateSavedEntry,deleteEntry,updatePurchaseInvoices,fromRow,findPurchase,insertPurchase} from './supabase';
const sizes=['14','16','18','20','22','24','26','28','30','32','34','36','38','40','42','44','46','48','S','M','L','XL','XXL','3XL'];
const channels=['Meesho','Flipkart','Amazon','Direct','Other'];

const initial={products:[],purchases:[],sales:[],returns:[],materials:[],materialPurchases:[],production:[],expenses:[],settlements:[],equipmentPurchases:[],stockAdjustments:[],supplierAdvances:[],supplierAdvanceAllocations:[]};
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
const {materialName,materialCategory,materialUnit,...materialPurchaseFields}=schemas.materialPurchases.fields;
const editMaterialFields={materialId:'material',...materialPurchaseFields};
const optionalFields=['supplier','invoice','fee','shipping','refund','electricity','otherCost','date','openingQty'];
const fieldLabels={openingQty:'Opening Quantity',gstRate:'GST Rate (%)',gstInclusive:'GST included in unit price?',productId:'Product',qty:'Quantity',rate:'Unit Price (₹)',supplier:'Supplier Name',invoice:'Invoice Number',date:'Date',sku:'SKU',name:'Product Name',size:'Size',color:'Color',type:'Product Type',platform:'Marketplace',orderId:'Order ID',price:'Selling Price (₹)',fee:'Marketplace Fee (₹)',shipping:'Shipping Cost (₹)',materialName:'Material Name',materialCategory:'Category',materialUnit:'Unit',materialId:'Material',saleId:'Original Sale',refund:'Refund (₹)',electricity:'Electricity Cost (₹)',otherCost:'Other Cost (₹)',blankId:'Blank T-Shirt',printedId:'Printed T-Shirt'};
const fieldLabel=k=>fieldLabels[k]||k.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase());
const today=()=>new Date().toISOString().slice(0,10);
const rupees=(n,maxFractionDigits=2)=>'₹'+(Number(n)||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:maxFractionDigits});
function InvoiceStatus({row}) {
  const invoices=row.invoiceDetails??[];
  const {status,hasActualPayment}=purchaseDetails(row);
  const hasMissingFile=invoices.some(invoice=>!invoiceAttachment(row,invoice));
  const reason=hasMissingFile||(!invoices.length&&!row.invoicePath)?'Invoice file missing'
    : !invoices.length||invoices.some(invoice=>invoice.verified!==true)?'Verification pending'
      : !hasActualPayment?'Actual payment pending'
        : status==='Partially received'?'Invoice total below payment'
          : status==='Mismatch'?'Amount mismatch':'';
  return <span className={`invoice-status ${reason?'invoice-status-error':'invoice-status-ok'}`}>
    <span aria-hidden="true">{reason?'✕':'✓'}</span>
    {reason||(status==='Invoice verified'?'Invoice verified':'Verified & matched')}
  </span>;
}
function InvoiceAction({icon:Icon,label,onClick,disabled,danger}) {
  return <button type="button" className={`invoice-action ${danger?'action-delete':'action-edit'}`}
    aria-label={label} onClick={onClick} disabled={disabled}>
    <Icon size={16} aria-hidden="true"/>
    <span className="invoice-action-tooltip" aria-hidden="true">{label}</span>
  </button>;
}

function PurchaseInvoiceActions({row,saving,viewInvoice,openAttachment,openAdvance,openEntry}) {
  const invoices=row.invoiceDetails??[];
  const attachments=new Map(invoices.filter(invoice=>invoice.path).map(invoice=>[invoice.path,invoice.reference]));
  if (row.invoicePath&&!attachments.has(row.invoicePath)) attachments.set(row.invoicePath,row.invoice);
  const legacyNeedsVerification=row.invoice&&!invoices.some(invoice=>
    normalizeInvoiceKey(invoice.reference)===normalizeInvoiceKey(row.invoice));
  const [firstAttachment]=attachments;
  return <>
    {attachments.size>1?<InvoiceAction icon={Eye} label="View invoices" onClick={openEntry}/>
      :firstAttachment&&<InvoiceAction icon={Eye}
        label={firstAttachment[1]?`View invoice ${firstAttachment[1]}`:'View invoice'}
        onClick={()=>viewInvoice(firstAttachment[0])}/>}
    {legacyNeedsVerification&&<InvoiceAction icon={FileCheck} label={`Verify ${row.invoice}`}
      disabled={saving} onClick={()=>openAttachment(row,-1)}/>}
    {invoices.map((invoice,index)=>!invoice.verified||!invoiceAttachment(row,invoice)?
      <InvoiceAction key={index} icon={invoice.verified?Upload:FileCheck}
        label={`${invoice.verified?'Upload file':'Verify invoice'} ${invoice.reference}`}
        disabled={saving} onClick={()=>openAttachment(row,index)}/>:null)}
    {isAddressHeading(row.supplier)&&<InvoiceAction icon={Pencil} label="Correct supplier name"
      disabled={saving} onClick={()=>openAttachment(row,null,true)}/>}
    {canApplyAdvance(row)&&advanceDue(row)>0&&
      <InvoiceAction icon={Wallet} label="Apply supplier advance" disabled={saving} onClick={()=>openAdvance(row)}/>}
    <InvoiceAction icon={FilePlus} label="Add invoices" disabled={saving} onClick={()=>openAttachment(row)}/>
  </>;
}

function advanceDue(row) {
  const {invoiceTotal,paid}=purchaseDetails(row);
  return Math.max(0,money(invoiceTotal-paid-number(row.advanceApplied)));
}

function PurchaseAmounts({row}) {
  const amounts=purchaseDetails(row);
  return <><td className="entry-number">{rupees(amounts.paid)}{!amounts.hasActualPayment&&<small className="legacy-payment">Legacy estimate</small>}</td>
    <td className="entry-number">{rupees(amounts.invoiceTotal)}</td><td className="entry-number">{rupees(amounts.tax)}</td>
    <td><strong>{amounts.status}</strong>{(amounts.pending>0||amounts.mismatch>0)&&
      <small className="legacy-payment">{rupees(amounts.mismatch||amounts.pending)}</small>}
    {amounts.advanceApplied>0&&<>
      <small className="legacy-payment">Advance applied {rupees(amounts.advanceApplied)}</small>
      <small className="legacy-payment">Balance due {rupees(amounts.due)}</small>
    </>}</td></>;
}
function App(){
const [invoiceLines,setInvoiceLines]=useState([]);
const [attachment,setAttachment]=useState(null);
const [openEntryId,setOpenEntryId]=useState(null);
const [entryError,setEntryError]=useState('');
const [editingEntry,setEditingEntry]=useState(null);
const [editError,setEditError]=useState('');
const editHeading=useRef(null);
const [advanceTarget,setAdvanceTarget]=useState(null);
const purchaseDraftId=useRef(null);
const attachmentForm=useRef(null);const [editingProduct,setEditingProduct]=useState(null),[adjustingProduct,setAdjustingProduct]=useState(null),[adjustQty,setAdjustQty]=useState(''),[adjustReason,setAdjustReason]=useState('Stock count correction'),[reportMonth,setReportMonth]=useState(today().slice(0,7)),[saving,setSaving]=useState(false),[data,setData]=useState(initial),[session,setSession]=useState(null),[loading,setLoading]=useState(true),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[page,setPage]=useState('overview'),[form,setForm]=useState({}),[adding,setAdding]=useState(false),[message,setMessage]=useState('');
React.useEffect(()=>{if(!configured){setLoading(false);return;}supabase.auth.getSession().then(({data:{session}})=>{setSession(session);setLoading(false)});const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>setSession(session));return()=>subscription.unsubscribe()},[]);
React.useEffect(()=>{
  if (!session) return;
  let active=true;
  async function load() {
    try {
      const records=await fetchAll();
      if (!active) return;
      setData(records);
      const url=new URL(window.location.href);
      if (!url.searchParams.has('invoiceType')) return;
      const path=linkedInvoicePath(records,url);
      if (!path) throw Error('This invoice link is unavailable for the signed-in account.');
      const {data,error}=await supabase.storage.from('purchase-invoices').createSignedUrl(path,60);
      if (!active) return;
      if (error) throw error;
      window.location.replace(data.signedUrl);
    } catch (error) {
      if (active) setMessage(error.message);
    }
  }
  load();
  return ()=>{active=false};
},[session?.user?.id]);
const save=next=>setData(next);
const isAdmin=session?.user?.app_metadata?.seller_role==='admin';
async function removeRecord(t,row){if(!isAdmin){setMessage('Only admin can delete entries');return;}const label=t==='products'?productName(row.id):t==='sales'?row.orderId:t==='materials'?row.name:row.name||row.invoice||row.id;const yes=window.confirm('Permanently delete '+label+'? This may change stock and monthly reports. This cannot be undone.');if(!yes)return;setSaving(true);try{await deleteEntry(t,row.id);save(await fetchAll());setMessage('Entry deleted successfully')}catch(err){setMessage('Delete failed: '+err.message+'. Delete dependent records first if applicable.')}finally{setSaving(false)}}
const product=id=>data.products.find(p=>p.id===id);
const productName=id=>{const p=product(id);return p? [p.name,p.size,p.color,p.type].join(' / '):'Unknown product'};
const stock=useMemo(()=>productStock(data),[data]);
async function submitProductEdit(e){e.preventDefault();setSaving(true);try{const sku=editingProduct.sku.trim();if(!sku)throw Error('SKU required');if(data.products.some(p=>p.id!==editingProduct.id&&p.sku===sku))throw Error('SKU already exists');await updateProduct(editingProduct.id,{sku,name:editingProduct.name.trim(),size:editingProduct.size,color:editingProduct.color.trim(),type:editingProduct.type});save(await fetchAll());setEditingProduct(null);setMessage('Product updated')}catch(err){setMessage(err.message)}finally{setSaving(false)}}
async function submitStockAdjustment(e){e.preventDefault();setSaving(true);try{const desired=Number(adjustQty);if(!Number.isFinite(desired)||desired<0||!Number.isInteger(desired))throw Error('Enter a valid non-negative whole quantity');const delta=desired-number(stock[adjustingProduct.id]);if(!delta)throw Error('Stock is already at that quantity');await insertEntry('stockAdjustments',{productId:adjustingProduct.id,qtyChange:delta,reason:adjustReason,date:today()});save(await fetchAll());setAdjustingProduct(null);setAdjustQty('');setMessage('Stock adjustment saved with history')}catch(err){setMessage(err.message)}finally{setSaving(false)}}
const materialStock=useMemo(()=>availableMaterials(data),[data]);
const platformSales=Object.fromEntries(channels.map(channel=>[channel,0]));
for (const sale of data.sales) {
  const channel=channels.includes(sale.platform)?sale.platform:'Other';
  platformSales[channel]+=taxDetails(sale.qty,sale.price,sale.gstRate,sale.gstInclusive).total;
}
const gross=Object.values(platformSales).reduce((total,amount)=>total+amount,0);
const received=data.settlements.reduce((total,entry)=>total+number(entry.amount),0);
const options=(kind)=>kind==='product'?data.products:kind==='blank'?data.products.filter(p=>p.type==='BLANK'):kind==='printed'?data.products.filter(p=>p.type==='PRINTED'):kind==='material'?data.materials:data.sales;
const fields=schemas[page]?.fields;
const isTaxPage=['purchases','sales','materialPurchases','equipmentPurchases'].includes(page);
const isPurchase=purchasePages.includes(page);
const canEditEntry=isPurchase||['sales','returns','expenses'].includes(page);
const editableFields=page==='materialPurchases'?editMaterialFields:fields;
const formFields=editingEntry?editableFields:fields;
const previewInvoices=invoiceLines.filter(line=>line.amount!==''&&line.amount!=null&&line.gst!==''&&line.gst!=null)
  .map(line=>({...line,verified:true}));
const purchasePreview=isPurchase?purchaseDetails({...form,invoiceDetails:previewInvoices}):null;
const hasProductInvoice=previewInvoices.some(line=>line.kind==='Product');
const feeInvoiceTotal=money(previewInvoices.filter(line=>line.kind==='Fee')
  .reduce((total,line)=>total+number(line.amount),0));
const purchaseFieldLabel=key=>isPurchase&&key==='rate'?'Item unit price before discount (₹)':fieldLabel(key);
const advances=advanceBalances(data.supplierAdvances,data.supplierAdvanceAllocations);
const purchaseRecords=Object.fromEntries(purchasePages.map(key=>
  [key,purchasesWithAdvances(data[key],key,data.supplierAdvanceAllocations)]));
const overviewPurchases=purchaseTotals(Object.values(purchaseRecords).flat());
const advancePaid=money(advances.reduce((sum,row)=>sum+number(row.amount),0));
const unusedAdvances=money(advances.reduce((sum,row)=>sum+row.remaining,0));
const addAdvanceRecord=(key,row)=>setData(previous=>({...previous,
  [key]:[...previous[key].filter(entry=>entry.id!==row.id),row]}));
const openAdvance=row=>{
  setAdding(false);
  setEditingEntry(null);
  setAttachment(null);
  setAdvanceTarget(row);
  setMessage('');
};
const attachmentOpen=attachment?.page===page&&!adding;
React.useEffect(()=>{
  if (attachmentOpen) attachmentForm.current?.scrollIntoView({block:'nearest'});
},[attachmentOpen,attachment?.row.id]);
React.useEffect(()=>{
  if (editingEntry) editHeading.current?.focus();
},[editingEntry]);
const taxPreview=isTaxPage?taxDetails(form.qty,form[page==='sales'?'price':'rate'],form.gstRate,form.gstInclusive==='Yes'):null;
const monthly=(items)=>items.filter(x=>String(x.date||'').slice(0,7)===reportMonth);
const mSales=monthly(data.sales),mPurchases=monthly(purchaseRecords.purchases),mMaterials=monthly(purchaseRecords.materialPurchases),mEquipment=monthly(purchaseRecords.equipmentPurchases),mReturns=monthly(data.returns),mExpenses=monthly(data.expenses),mSettlements=monthly(data.settlements),mProduction=monthly(data.production);
const sum=(items,fn)=>money(items.reduce((a,x)=>a+fn(x),0));
const saleTotal=sum(mSales,x=>taxDetails(x.qty,x.price,x.gstRate,x.gstInclusive).total),saleTax=sum(mSales,x=>taxDetails(x.qty,x.price,x.gstRate,x.gstInclusive).tax),purchaseTotal=sum(mPurchases,x=>purchaseDetails(x).paid),materialTotal=sum(mMaterials,x=>purchaseDetails(x).paid),equipmentTotal=sum(mEquipment,x=>purchaseDetails(x).paid),refundTotal=sum(mReturns,x=>number(x.refund)),feeTotal=sum(mSales,x=>number(x.fee)+number(x.shipping)),expenseTotal=sum(mExpenses,x=>number(x.amount)),productionCost=sum(mProduction,x=>number(x.electricity)+number(x.otherCost)),settledTotal=sum(mSettlements,x=>number(x.amount));
const monthlyAdvancesPaid=sum(monthly(advances),row=>number(row.amount));
const cashEstimate=money(saleTotal-refundTotal-purchaseTotal-materialTotal-equipmentTotal-monthlyAdvancesPaid-feeTotal-expenseTotal-productionCost);
const monthPurchases=purchaseTotals([...mPurchases,...mMaterials,...mEquipment]);
const reconciliationRows=totals=>[
  ['Received invoice total',totals.invoiceTotal],['Documented purchase GST',totals.tax],
  ['Pending purchase reconciliation',totals.pending],['Purchase invoice amount above payment',totals.mismatch],
];
const monthlyReportRows=[['Gross sales (customer billed)',saleTotal],['GST collected on sales (recorded)',saleTax],['T-shirt purchase payments',purchaseTotal],['Material purchase payments',materialTotal],['Equipment purchase payments',equipmentTotal],['Supplier advances paid',monthlyAdvancesPaid],...reconciliationRows(monthPurchases),['Purchase GST recorded (including legacy estimates)',monthPurchases.recordedTax],['Customer refunds',refundTotal],['Marketplace fees + shipping',feeTotal],['Other expenses',expenseTotal],['Production electricity + other costs',productionCost],['Marketplace settlements received',settledTotal],['Estimated cash movement (not profit)',cashEstimate]];

function applyInvoice(line, automatic=false) {
  if (line.kind!=='Product') return;
  const normalized=normalizeInvoiceKey(line.product);
  const matches=normalized?data.products.filter(item=>
    [item.sku,item.name].some(value=>normalizeInvoiceKey(value)===normalized)): [];
  const productDiscount=line.productDiscount??line.discount;
  const values={supplier:line.supplier,invoice:line.reference,purchasePlatform:line.platform,purchaseOrderId:line.orderId,
    qty:line.quantity,rate:line.unitPrice,gstRate:line.gstRate,purchaseDiscount:line.multipleProducts?null:productDiscount};
  if (page==='purchases'&&matches.length===1) values.productId=matches[0].id;
  let convertsLitres=false;
  if (!line.multipleProducts&&page==='materialPurchases') {
    values.materialName=line.product;
    if (/\bink\b/i.test(line.product)) values.materialCategory='Ink';
    if (['L','LTR','LITRE','LITRES'].includes(line.quantityUnit?.toUpperCase())) {
      convertsLitres=true;
      values.materialUnit='ml';
      values.qty=Number((Number(line.quantity)*1000).toFixed(6));
      values.rate=Number((Number(line.unitPrice)/1000).toFixed(6));
    }
  }
  if (!line.multipleProducts&&page==='equipmentPurchases') values.name=line.product;
  if (line.unitPrice!=null&&line.quantity>0&&line.amount!=null&&line.gst!=null) {
    const base=line.unitPrice*line.quantity-(productDiscount??0);
    if (Math.abs(base+line.gst+(line.roundOff??0)-line.amount)<=.05) values.gstInclusive='No';
    else if (Math.abs(base-line.amount)<=.05) values.gstInclusive='Yes';
  }
  setForm(current=>{
    const preserveUnits=automatic&&convertsLitres&&current.materialUnit!=='ml'&&
      (current.materialUnit||current.qty||current.rate);
    return {...current,...Object.fromEntries(Object.entries(values).filter(([key,value])=>
      value!==''&&value!=null&&(!automatic||current[key]==null||current[key]==='')&&
      !(preserveUnits&&['qty','rate','materialUnit'].includes(key))))};
  });
}

function openAttachment(row, legacyIndex, supplierOnly=false) {
  setAdvanceTarget(null);
  setEditingEntry(null);
  const existing=legacyIndex==null?null:legacyIndex===-1
    ? {kind:'Product',reference:row.invoice,path:row.invoicePath}
    : row.invoiceDetails[legacyIndex];
  setAttachment({page,row,supplierOnly,supplier:'',editorId:crypto.randomUUID(),actualPayment:String(purchaseDetails(row).paid)});
  setInvoiceLines(supplierOnly?[]:[{
    ...existing,id:crypto.randomUUID(),kind:existing?.kind??'Product',
    supplier:existing?.supplier??row.supplier??'',
    ...(existing?.kind==='Product'&&!existing.verified&&{amount:'',gst:''}),
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
    const {row,supplierOnly}=attachment;
    const supplier=supplierOnly?attachment.supplier.trim():undefined;
    if (supplierOnly&&(!supplier||isAddressHeading(supplier))) throw Error('Enter the supplier name shown under Sold By.');
    const actualPayment=supplierOnly?row.actualPayment??null:parseMoney(attachment.actualPayment,'actual payment');
    const existing=row.invoiceDetails??[];
    const invoices=supplierOnly?existing.map(invoice=>
      invoice.verified===true&&invoice.kind==='Product'&&isAddressHeading(invoice.supplier)&&
      normalizeInvoiceKey(invoice.reference)===normalizeInvoiceKey(row.invoice)?{...invoice,supplier}:invoice)
      :await prepareInvoices(invoiceLines,existing);
    const uploaded=supplierOnly?invoices:await uploadInvoices(invoices,session.user.id,paths);
    writeStarted=true;
    const updated=await updatePurchaseInvoices(page,row,uploaded,actualPayment,supplier);
    committed=true;
    setData(previous=>({...previous,[page]:previous[page].map(row=>row.id===updated.id?updated:row)}));
    setAttachment(null);
    setInvoiceLines([]);
    setMessage(supplierOnly?'Supplier name corrected.':'Purchase reconciliation updated.');
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

function openEditor(row) {
  const keys=Object.keys(editableFields);
  if (isPurchase) keys.push(...Object.keys(purchasePaymentFields));
  const values=entryFormValues(row,keys);
  setEditingEntry({row,values});
  setForm(values);
  setAdding(false);
  setAttachment(null);
  setAdvanceTarget(null);
  setInvoiceLines([]);
  setEditError('');
  setMessage('');
}

async function submitEdit(event) {
  event.preventDefault();
  if (saving) return;
  setSaving(true);
  setEditError('');
  try {
    const {row,values}=editingEntry;
    const changes=entryChanges(values,form,editableFields);
    if (!Object.keys(changes).length) {
      setEditingEntry(null);
      return;
    }
    const checkStock=affectsStock(page,changes);
    const current=checkStock?await fetchAll():null;
    if (current) {
      save(current);
      validateStockEdit(page,current,row.id,changes);
    }
    const comparedFields=Object.keys(values);
    if (isPurchase) comparedFields.push('invoiceRevision');
    const updated=await updateSavedEntry(page,row,changes,comparedFields);
    if (!updated) {
      if (!current) save(await fetchAll());
      throw Error('This entry changed or was removed. Reopen it before saving.');
    }
    setData(previous=>({...previous,[page]:previous[page].map(entry=>entry.id===updated.id?updated:entry)}));
    setEditingEntry(null);
    setMessage('Entry updated');
  } catch (error) {
    setEditError(invoiceSaveError(error));
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

function restore(e){setMessage('Cloud backup restore is disabled to protect database integrity.');return;
const file=e.target.files?.[0];if(!file)return;file.text().then(t=>{try{const x=JSON.parse(t);if(!x||!Array.isArray(x.products)||!Array.isArray(x.sales))throw Error('Invalid backup');setMessage('Cloud restore disabled')}catch(err){setMessage(err.message)}})}
async function viewInvoice(path,onError=setMessage){const {data,error}=await supabase.storage.from('purchase-invoices').createSignedUrl(path,60);if(error){onError(error.message);return;}window.open(data.signedUrl,'_blank','noopener,noreferrer')}
function display(row,k){if(row[k]==null)return '—';if(k==='gstInclusive')return row[k]===true||row[k]==='Yes'?'Yes':'No';if(k==='productId'||k==='blankId'||k==='printedId')return productName(row[k]);if(k==='materialId')return data.materials.find(m=>m.id===row[k])?.name||'Unknown';if(k==='saleId')return data.sales.find(s=>s.id===row[k])?.orderId||'Unknown';if(['price','rate','fee','shipping','refund','amount','electricity','otherCost'].includes(k))return rupees(row[k],page==='materialPurchases'&&k==='rate'?6:2);return typeof row[k]==='object'?JSON.stringify(row[k]):String(row[k]??'—')}
const visibleFields=fields?Object.keys(fields).filter(key=>page!=='materialPurchases'||
  !['materialName','materialCategory','materialUnit'].includes(key)):[];
const entryRows=isPurchase?purchaseRecords[page]:data[page]??[];
const selection=useRowSelection(entryRows);
const selectedEntry=entryRows.find(row=>row.id===openEntryId);
const entryColumnClass=key=>{
  if (fields[key]==='number'||key==='gstRate') return 'entry-number';
  if (['name','supplier','description','productId','blankId','printedId'].includes(key)) return 'entry-text';
};
const hasEntryActions=canEditEntry||isAdmin||page==='products';
const primaryEntryField=({products:'name',sales:'orderId',expenses:'description',settlements:'reference',
  materialPurchases:'materialId'})[page]??visibleFields[0];
const entryColumnCount=visibleFields.length+1+Number(hasEntryActions)+Number(page==='materialPurchases')+
  Number(['products','materials'].includes(page))+(isPurchase?5:0)+(page==='sales'?2:0);
const openEntry=row=>{setEntryError('');setOpenEntryId(row.id)};
function entryCell(row,key) {
  const value=display(row,key);
  if (key!==primaryEntryField) return value;
  return <button type="button" className="entry-name" aria-haspopup="dialog" onClick={()=>openEntry(row)}>
    {value==='—'||value===''?'Entry details':value}
  </button>;
}
function entryFields(row) {
  const pairs=visibleFields.map(key=>[purchaseFieldLabel(key),key==='gstInclusive'
    ? row[key]==null?'—':row[key]===true||row[key]==='Yes'?'Yes':'No'
    :display(row,key)]);
  if (page==='materialPurchases') pairs.push(['Material',display(row,'materialId')]);
  if (page==='products') pairs.push(['Available stock',number(stock[row.id])]);
  if (page==='production') pairs.push(['Materials used',(row.consumption??[])
    .map(item=>`${display(item,'materialId')} · ${item.qty}`).join(', ')||'—']);
  if (page==='sales') {
    const sale=taxDetails(row.qty,row.price,row.gstRate,row.gstInclusive);
    pairs.push(['GST amount',rupees(sale.tax)],['Total including GST',rupees(sale.total)]);
  }
  if (isPurchase) {
    const amounts=purchaseDetails(row);
    pairs.push(['Purchase platform',row.purchasePlatform||'—'],['Order ID',row.purchaseOrderId||'—'],
      [amounts.hasActualPayment?'Actual payment':'Legacy payment estimate',rupees(amounts.paid)],
      ['Purchase discount',rupees(row.purchaseDiscount)],['Rewards redeemed',rupees(row.rewardsUsed)],
      ['Received invoice total',rupees(amounts.invoiceTotal)],['Documented GST',rupees(amounts.tax)],['Reconciliation',amounts.status]);
    if (amounts.advanceApplied>0) pairs.push(['Advance applied',rupees(amounts.advanceApplied)],['Balance due',rupees(amounts.due)]);
    if (amounts.pending>0) pairs.push(['Pending invoice amount',rupees(amounts.pending)]);
    if (amounts.mismatch>0) pairs.push(['Invoice amount above payment',rupees(amounts.mismatch)]);
  }
  return pairs;
}

if(loading)return <main><h1>Loading Seller Hub...</h1></main>;
if(!configured)return <main><h1>Supabase configuration required</h1><p>Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in Vercel project environment variables.</p></main>;
if(!session)return <main className="login"><h1>NAKHREBAAZ Seller Hub</h1><p>Secure admin sign in</p><form onSubmit={async e=>{e.preventDefault();const {error}=await supabase.auth.signInWithPassword({email,password});if(error)setMessage(error.message)}}><label>Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Password<input type="password" required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="primary">Sign in</button>{message&&<p>{message}</p>}</form></main>;
const entryNav=(key,label)=><button key={key} className={page===key?'active':''}
  aria-current={page===key?'page':undefined}
  onClick={()=>{setPage(key);selection.clear();setOpenEntryId(null);setAdding(false);setEditingEntry(null);setAttachment(null);setAdvanceTarget(null);setMessage('')}}>{label}</button>;
return <div className="shell"><aside><h2>NAKHREBAAZ <small>SELLER HUB</small></h2><nav>
  {entryNav('overview','Overview')}
  {Object.entries(schemas).filter(([key])=>key!=='materials').map(([key,entry])=>
    key==='purchases'?<details key={key} className="purchase-nav">
      <summary className={purchasePages.includes(page)?'active':undefined}>Purchases</summary>
      <div>{purchasePages.map(category=>entryNav(category,schemas[category].label))}</div>
    </details>:purchasePages.includes(key)?null:entryNav(key,entry.label))}
  {entryNav('advances','Supplier Advances')}
  {entryNav('monthly','Monthly Business Report')}
  {entryNav('reports','Reports & Backup')}
</nav><button onClick={()=>supabase.auth.signOut()}>Sign out</button><p className="aside-note">Supabase cloud workspace</p></aside><main><header><span>NAKHREBAAZ · MULTI-CHANNEL OPERATIONS</span><h1>{schemas[page]?.label|| (page==='overview'?'Overview':page==='advances'?'Supplier Advances':page==='monthly'?'Monthly Business Report':'Reports & Backup')}</h1><p>Meesho · Flipkart · Amazon · Direct</p></header>{message&&<div className="notice"><span role="status">{message}</span><button type="button" aria-label="Dismiss message" onClick={()=>setMessage('')}>×</button></div>}
{page==='overview'&&<>
  <div className="stats overview-stats">{[
    ['Gross Sales',rupees(gross)],
    ['Total Purchase Payments',rupees(overviewPurchases.paid+advancePaid)],
    ['Pending Invoice Reconciliation',rupees(overviewPurchases.pending)],
    ['Settlements Received',rupees(received)],
    ['Stock Units',Object.values(stock).reduce((total,units)=>total+units,0)],
  ].map(([label,value])=><article key={label}><small>{label}</small><strong>{value}</strong>
    {label==='Total Purchase Payments'&&unusedAdvances>0&&<small>Unused advances {rupees(unusedAdvances)}</small>}
  </article>)}</div>
  {overviewPurchases.mismatch>0&&<div className="notice" role="status">
    <span><strong>Invoice amount mismatch</strong> · Invoices exceed recorded payments by {rupees(overviewPurchases.mismatch)}.</span>
  </div>}
  <section><h2>Platform Sales</h2><dl className="platform-sales">
    {channels.map(channel=><div key={channel}><dt>{channel}</dt><dd>{rupees(platformSales[channel])}</dd></div>)}
  </dl></section>
  <section><h2>Low Stock Alerts</h2>{data.products.filter(p=>number(stock[p.id])<=10)
    .map(p=><p key={p.id}>{productName(p.id)} — {number(stock[p.id])} pcs</p>)}
    {!data.products.length&&<p>No products yet.</p>}
  </section>
</>}
{page==='products'&&editingProduct&&<form className="entry-form" onSubmit={submitProductEdit}><h2>Edit Product</h2><div className="fields">{Object.entries(schemas.products.fields).map(([k,t])=><label key={k}>{fieldLabel(k)}{Array.isArray(t)?<select required value={editingProduct[k]} onChange={e=>setEditingProduct({...editingProduct,[k]:e.target.value})}>{t.map(v=><option key={v} value={v}>{v}</option>)}</select>:<input required value={editingProduct[k]??''} onChange={e=>setEditingProduct({...editingProduct,[k]:e.target.value})}/>}</label>)}</div><div className="form-actions"><button className="primary" disabled={saving}>Save Changes</button><button type="button" onClick={()=>setEditingProduct(null)}>Cancel</button></div></form>}{page==='products'&&adjustingProduct&&<form className="entry-form" onSubmit={submitStockAdjustment}><h2>Adjust Stock — {productName(adjustingProduct.id)}</h2><p>Current stock: <strong>{number(stock[adjustingProduct.id])}</strong> units. Enter the correct total stock. A signed adjustment is recorded; purchases and sales are not overwritten.</p><div className="fields"><label>Correct Stock Quantity<input required type="number" min="0" step="1" value={adjustQty} onChange={e=>setAdjustQty(e.target.value)}/></label><label>Reason<select required value={adjustReason} onChange={e=>setAdjustReason(e.target.value)}>{['Stock count correction','Opening stock','Damaged stock','Lost stock','Other adjustment'].map(x=><option key={x}>{x}</option>)}</select></label></div><div className="form-actions"><button className="primary" disabled={saving}>Save Stock Adjustment</button><button type="button" onClick={()=>setAdjustingProduct(null)}>Cancel</button></div></form>}{fields&&<>
<div className="toolbar entry-add-toolbar">
  <p>Manage records for {schemas[page].label}.</p>
  <button className="primary" disabled={saving} onClick={()=>{
    setAdding(!adding);
    setEditingEntry(null);
    setAdvanceTarget(null);
    purchaseDraftId.current=null;
    setAttachment(null);
    setForm({});
    setInvoiceLines([]);
  }}>+ Add Entry</button>
</div>
{(adding||editingEntry)&&<form className="entry-form" onSubmit={editingEntry?submitEdit:submit}>
  <div className="form-heading">
    {editingEntry?<h2 ref={editHeading} tabIndex={-1}>Edit Entry</h2>:<>
      <h2>{page==='purchases'?'Add T-Shirt Purchase':page==='materialPurchases'?'Add Material Purchase':'New Entry'}</h2>
      <p>Fill in the details below to save your record.</p>
    </>}
  </div>
  <div className="fields">
    {Object.entries(formFields).map(([key,type])=>{
      const value=form[key]??'';
      const onChange=event=>setForm({...form,[key]:event.target.value});
      const fieldClass=page==='materials'&&({unit:'material-unit-field',openingQty:'material-qty-field'})[key];
      const optional=optionalFields.includes(key)||(editingEntry&&key==='description');
      const requiredDate=editingEntry&&page==='equipmentPurchases'&&key==='date';
      const decimalStep=editingEntry||(page==='materialPurchases'&&key==='rate')?'any':'0.01';
      return <label key={key} className={fieldClass||undefined}>{purchaseFieldLabel(key)}
        {Array.isArray(type)?<select required value={value} onChange={onChange}>
          <option value="">Select</option>
          {editingEntry&&value&&!type.some(option=>String(option)===value)&&<option>{value}</option>}
          {type.map(option=><option key={option} value={option}>{option}</option>)}
        </select>:['product','blank','printed','material','sale'].includes(type)?
          <select required value={value} onChange={onChange}>
            <option value="">{type==='product'?'Choose a product':'Choose an option'}</option>
            {options(type).map(item=><option value={item.id} key={item.id}>
              {type==='material'?`${item.name} (${item.unit})`:type==='sale'?item.orderId:
                productName(item.id)+(item.sku?' · '+item.sku:'')}
            </option>)}
          </select>:
          <input required={!optional||Boolean(requiredDate)} type={type}
            min={type==='number'?0:undefined} step={type==='number'?decimalStep:undefined}
            value={form[key]??(type==='date'&&!editingEntry?today():'')} onChange={onChange}/>}
      </label>;
    })}
    {isPurchase&&<>
      <div className="tax-summary purchase-payment"><strong>Purchase payment</strong>
        <div className="fields">{Object.entries(purchasePaymentFields).map(([key,label])=>{
          const isAmount=purchaseAmounts.includes(key);
          return <label key={key}>{label}<input required={key==='actualPayment'&&!editingEntry} type={isAmount?'number':'text'}
            min={isAmount?0:undefined} step={isAmount?'0.01':undefined}
            value={form[key]??''} onChange={event=>setForm({...form,[key]:event.target.value})}/></label>;
        })}</div>
        <small>Enter the amount paid directly for this purchase after discounts or rewards. Apply any previously recorded advance from Actions after saving.</small>
      </div>
      {!editingEntry&&<>
        <PurchaseInvoices lines={invoiceLines} setLines={setInvoiceLines} onApply={applyInvoice}
          onExtract={line=>applyInvoice(line,true)} saving={saving} viewInvoice={viewInvoice}/>
        <div className="tax-summary" aria-label="Purchase cost summary">
          <strong>Purchase cost summary</strong>
          <div><span>Item invoices after discounts</span><b>{rupees(purchasePreview.invoiceTotal-feeInvoiceTotal)}</b></div>
          <div><span>Fee invoices</span><b>{rupees(feeInvoiceTotal)}</b></div>
          <div className="tax-total"><span>Received invoice total</span><b>{rupees(purchasePreview.invoiceTotal)}</b></div>
          <div><span>Actual payment</span><b>{purchasePreview.hasActualPayment?rupees(purchasePreview.paid):'Not entered'}</b></div>
          <div><span>Documented GST (included in invoice total)</span><b>{rupees(purchasePreview.tax)}</b></div>
          {purchasePreview.hasActualPayment&&<div><span>{purchasePreview.status}</span>
            <b>{rupees(purchasePreview.mismatch||purchasePreview.pending)}</b></div>}
        </div>
      </>}
    </>}
    {isTaxPage&&(!isPurchase||!hasProductInvoice&&!editingEntry)&&<div className="tax-summary">
      <strong>{isPurchase?'Item GST estimate before discounts':'Automatic GST calculation'}</strong>
      <div><span>Taxable value</span><b>{rupees(taxPreview.base)}</b></div>
      <div><span>GST ({number(form.gstRate)}%)</span><b>{rupees(taxPreview.tax)}</b></div>
      <div className="tax-total">
        <span>{isPurchase?'Estimated item subtotal before discounts':'Customer total'}</span><b>{rupees(taxPreview.total)}</b>
      </div>
      <small>Check invoice and applicable GST rate. GST reporting and input tax credit eligibility require accountant review.</small>
    </div>}
    {page==='production'&&data.materials.map(m=><label key={m.id}>Consume {m.name} ({m.unit})
      <input type="number" min="0" step="0.001" value={form['consume_'+m.id]||''}
        onChange={e=>setForm({...form,['consume_'+m.id]:e.target.value})}/>
    </label>)}
  </div>
  {editingEntry&&editError&&<p className="invoice-status-error" role="alert">{editError}</p>}
  <div className="form-actions">
    <button className="primary" type="submit" disabled={saving||invoiceLines.some(line=>line.reading)}>
      {saving?'Saving...':editingEntry?'Save Changes':'Save Entry'}
    </button>
    <button type="button" disabled={saving} onClick={()=>{setAdding(false);setEditingEntry(null)}}>Cancel</button>
  </div>
</form>}
{attachmentOpen&&<form className="entry-form" ref={attachmentForm} onSubmit={submitAttachment}>
  <div className="form-heading"><h2>{attachment.supplierOnly?'Correct supplier name':'Add or verify invoices'}</h2>
    <p>{attachment.row.name||attachment.row.supplier||display(attachment.row,page==='purchases'?'productId':'materialId')} · {attachment.row.date}</p>
  </div>
  {attachment.supplierOnly?<div className="fields"><label>Supplier name<input required maxLength={250}
    value={attachment.supplier} onChange={event=>setAttachment({...attachment,supplier:event.target.value})}/></label></div>:<>
  <div className="fields"><label>Actual payment (₹)<input required min="0" step="0.01" type="number"
    value={attachment.actualPayment} onChange={event=>setAttachment({...attachment,actualPayment:event.target.value})}/></label></div>
  <PurchaseInvoices key={attachment.editorId} lines={invoiceLines} setLines={setInvoiceLines} saving={saving} viewInvoice={viewInvoice}/>
  </>}
  <div className="form-actions"><button type="submit" className="primary"
    disabled={saving||invoiceLines.some(line=>line.reading)}>{attachment.supplierOnly?'Save supplier name':'Save reconciliation'}</button>
    <button type="button" disabled={saving} onClick={()=>{setAttachment(null);setInvoiceLines([])}}>Cancel</button></div>
</form>}{advanceTarget&&isPurchase&&<ApplyAdvance key={advanceTarget.id} purchase={advanceTarget}
  field={advancePurchaseFields[page]} balances={advances} balanceDue={advanceDue(advanceTarget)} rupees={rupees}
  onSaved={row=>{addAdvanceRecord('supplierAdvanceAllocations',row);setAdvanceTarget(null);setMessage('Supplier advance applied.')}}
  onCancel={()=>setAdvanceTarget(null)}/>}
<section className="entry-list">
  <div className="toolbar entry-table-toolbar"><h2>Entries ({entryRows.length})</h2>
    <SelectedExport selection={selection} name={page} extraColumns={isPurchase
      ? row=>invoiceLinksForCsv(page,row,window.location.href) : undefined}/>
  </div>
  <div className="tablewrap"><table className="record-table">
    <thead><tr><th scope="col" className="entry-select">Select</th>
      {visibleFields.map(key=><th key={key} className={entryColumnClass(key)}>{purchaseFieldLabel(key)}</th>)}
      {page==='materialPurchases'&&<th>Material</th>}
      {['products','materials'].includes(page)&&<th className="entry-number">Available</th>}
      {isPurchase&&<><th>Invoices / Order</th><th className="entry-number">Actual payment</th>
        <th className="entry-number">Received invoice total</th><th className="entry-number">Documented GST</th><th>Reconciliation</th></>}
      {page==='sales'&&<><th className="entry-number">GST Amount</th><th className="entry-number">Total Incl. GST</th></>}
      {hasEntryActions&&<th className="actions-head">Actions</th>}
    </tr></thead>
    <tbody>{[...entryRows].reverse().map(row=><tr key={row.id} className={selection.ids.has(row.id)?'entry-selected':undefined}>
      <RowCheckbox row={row} selection={selection} label={row.name||row.sku||row.invoice||row.orderId||row.supplier||row.description||row.id}/>
      {visibleFields.map(key=><td key={key} className={entryColumnClass(key)}>{entryCell(row,key)}</td>)}
      {page==='materialPurchases'&&<td className="entry-text">{entryCell(row,'materialId')}</td>}
      {page==='products'&&<td className="entry-number">{number(stock[row.id])}</td>}
      {page==='materials'&&<td className="entry-number">{number(materialStock[row.id])}</td>}
      {isPurchase&&<>
        <td className="invoice-cell">
          <InvoiceStatus row={row}/>
          <div>{row.purchasePlatform} {row.purchaseOrderId}</div>
          {(row.invoiceDetails??[]).map((line,index)=><div key={index}>{line.kind} · {line.reference}</div>)}
        </td>
        <PurchaseAmounts row={row}/>
      </>}
      {page==='sales'&&<><td className="entry-number">{rupees(taxDetails(row.qty,row.price,row.gstRate,row.gstInclusive).tax)}</td>
        <td className="entry-number">{rupees(taxDetails(row.qty,row.price,row.gstRate,row.gstInclusive).total)}</td></>}
      {hasEntryActions&&<td className="actions-cell"><div className="row-actions">
        {isPurchase&&<PurchaseInvoiceActions row={row} saving={saving} viewInvoice={viewInvoice}
          openAttachment={openAttachment} openAdvance={openAdvance} openEntry={()=>openEntry(row)}/>}
        {canEditEntry&&<InvoiceAction icon={Pencil} label="Edit" disabled={saving} onClick={()=>openEditor(row)}/>}
        {page==='products'&&<>
          <InvoiceAction icon={Pencil} label="Edit" onClick={()=>setEditingProduct({...row})}/>
          <InvoiceAction icon={Boxes} label="Adjust Stock" onClick={()=>{setAdjustingProduct(row);setAdjustQty(String(number(stock[row.id])))}}/>
        </>}
        {isAdmin&&<InvoiceAction icon={Trash2} label="Delete" disabled={saving} danger onClick={()=>removeRecord(page,row)}/>}
      </div></td>}
    </tr>)}
    {!entryRows.length&&<tr><td className="empty-state" colSpan={entryColumnCount}>No records yet. Add your first entry to get started.</td></tr>}
    </tbody>
  </table></div>
</section></>}
{selectedEntry&&fields&&<EntryDetails title={`${schemas[page].label} entry`} fields={entryFields(selectedEntry)}
  onClose={()=>setOpenEntryId(null)}>
  {isPurchase&&<>
    <h3>Invoices</h3>
    <InvoiceStatus row={selectedEntry}/>
    <ul className="entry-invoices">
      {(selectedEntry.invoiceDetails??[]).map((invoice,index)=>{
        const path=invoiceAttachment(selectedEntry,invoice);
        return <li key={index} className="entry-invoice">
          <span className="entry-invoice-reference">{invoice.kind} · {invoice.reference}</span>
          {invoice.verified&&<span className="entry-invoice-amount">
            <b>{rupees(invoice.amount)}</b><small>GST {rupees(invoice.gst)}</small>
          </span>}
          {path&&<button type="button" className="compact-button entry-invoice-view" aria-label={`View invoice ${invoice.reference}`}
            onClick={()=>{setEntryError('');viewInvoice(path,setEntryError)}}>View</button>}
        </li>;
      })}
      {selectedEntry.invoicePath&&!(selectedEntry.invoiceDetails??[]).some(invoice=>
        invoiceAttachment(selectedEntry,invoice)===selectedEntry.invoicePath)&&
        <li className="entry-invoice"><span className="entry-invoice-reference">{selectedEntry.invoice||'Attached invoice'}</span>
          <button type="button" className="compact-button entry-invoice-view" aria-label={`View invoice ${selectedEntry.invoice??''}`.trim()}
            onClick={()=>{setEntryError('');viewInvoice(selectedEntry.invoicePath,setEntryError)}}>View</button></li>}
      {!(selectedEntry.invoiceDetails??[]).length&&!selectedEntry.invoicePath&&<li>No invoices saved.</li>}
    </ul>
    {entryError&&<p role="alert">{entryError}</p>}
  </>}
</EntryDetails>}
{page==='advances'&&<SupplierAdvances key={session.user.id} balances={advances} today={today()} rupees={rupees}
  onSaved={row=>addAdvanceRecord('supplierAdvances',row)}/>}
{page==='monthly'&&<><section className="monthly-report"><div className="toolbar"><div><h2>Monthly Business Summary</h2><p>Choose a month to review all recorded business activity.</p></div><label>Report Month<input type="month" value={reportMonth} onChange={e=>setReportMonth(e.target.value)}/></label></div><div className="report-kpis"><article><small>Sales billed</small><strong>{rupees(saleTotal)}</strong></article><article><small>Purchases + equipment</small><strong>{rupees(purchaseTotal+materialTotal+equipmentTotal+monthlyAdvancesPaid)}</strong></article><article><small>Returns / refunds</small><strong>{rupees(refundTotal)}</strong></article><article><small>Estimated cash movement</small><strong>{rupees(cashEstimate)}</strong></article></div><h2>Monthly Breakdown</h2><div className="tablewrap"><table><thead><tr><th>Metric</th><th>Amount</th></tr></thead><tbody>{monthlyReportRows.map(([name,amount])=><tr key={name}><td>{name}</td><td>{rupees(amount)}</td></tr>)}</tbody></table></div><h2>Sales by Marketplace</h2><div className="tablewrap"><table><thead><tr><th>Platform</th><th>Orders</th><th>Units</th><th>Billed Sales</th></tr></thead><tbody>{channels.map(ch=>{const rows=mSales.filter(x=>x.platform===ch);return <tr key={ch}><td>{ch}</td><td>{rows.length}</td><td>{sum(rows,x=>number(x.qty))}</td><td>{rupees(sum(rows,x=>taxDetails(x.qty,x.price,x.gstRate,x.gstInclusive).total))}</td></tr>})}</tbody></table></div><button className="primary" onClick={()=>{const lines=[['Metric','Amount (INR)'],...monthlyReportRows].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(','));exportFile('nakhrebaaz-monthly-'+reportMonth+'.csv',lines.join('\r\n'),'text/csv')}}>Download Monthly Report (CSV)</button><p className="report-warning">This is a recorded cash-flow estimate, NOT net profit or a GST return. Unsold inventory, depreciation, ITC eligibility, GST adjustments, payment timing and opening balances are not fully accounted for. Confirm GST figures with your accountant before filing.</p></section></>}
{page==='reports'&&<><section><h2>Backup & Restore</h2><button className="primary" onClick={()=>exportFile('nakhrebaaz-backup-'+today()+'.json',JSON.stringify(data,null,2),'application/json')}>Download JSON Backup</button><p>Cloud restore requires a validated migration; direct JSON restore disabled.</p></section><section><h2>Limitations</h2><p>Supabase-backed records with email login; no marketplace API import, automatic refund reconciliation or GST accounting. Keep backups. Do not treat cash movement as net profit.</p></section></>}
</main></div>}
createRoot(document.getElementById('root')).render(<App/>);

import {missingInvoiceFields} from './invoiceExtraction.js';
import React from 'react';
import {invoiceFileType, readInvoice} from './invoiceReader.js';

const textFields = [
  ['supplier', 'Invoice supplier'], ['reference', 'Invoice number'], ['gstin', 'Supplier GSTIN'],
  ['quantityUnit', 'Invoice quantity unit'], ['orderId', 'Invoice order ID'], ['platform', 'Marketplace'], ['product', 'Product description'],
];
const amountFields = [
  ['quantity', 'Invoice quantity'], ['unitPrice', 'Invoice unit price before discount (₹)'],
  ['discount', 'Invoice discount (₹)'], ['amount', 'Invoice total (₹)'], ['gst', 'Documented GST (₹)'],
];

export default function PurchaseInvoices({lines, setLines, onApply, onExtract, saving, viewInvoice}) {
  const active = React.useRef(false);
  const [reviewed, setReviewed] = React.useState(false);
  React.useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const change = (id, values) => {
    setReviewed(false);
    setLines(previous => previous.map(line => line.id === id ? {...line, ...values} : line));
  };
  async function selectFile(line, event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      invoiceFileType(file);
    } catch (error) {
      input.value = '';
      change(line.id, {notice: error.message});
      return;
    }
    const replacement = line.file ? {
      ...Object.fromEntries([...textFields,...amountFields].map(([key])=>[key,''])),
      kind:'Product',gstRate:null,productDiscount:null,roundOff:null,multipleProducts:false,
    } : {};
    change(line.id, {...replacement, reading: true, file, quotation:false, needsReview:false, notice: 'Reading invoice…'});
    try {
      const parsed = await readInvoice(file);
      if (!active.current) return;
      if (parsed.documentType === 'quotation') {
        input.value = '';
        const reference = parsed.reference ? ` ${parsed.reference}` : '';
        const total = parsed.amount == null ? '' : ` · Quoted total ${new Intl.NumberFormat('en-IN',{
          style:'currency',currency:'INR',
        }).format(parsed.amount)}`;
        change(line.id, {...line,file:null,quotation:true,
          notice:`Quotation${reference}${total}. Upload the supplier’s final tax invoice to save it here.`});
        return;
      }
      const extracted = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value != null && value !== ''));
      const missing=missingInvoiceFields(parsed);
      change(line.id, {...extracted,gstRate:parsed.gstRate,needsReview:missing.length>0,
        notice:missing.length?'':'Review the extracted fields before saving.'});
      onExtract?.({...line, ...replacement, ...extracted, gstRate: parsed.gstRate});
    } catch (error) {
      if (active.current) change(line.id, {needsReview:true,
        notice:`Automatic reading couldn’t finish. ${error.message}`});
    } finally {
      if (active.current) change(line.id, {reading: false});
    }
  }

  return <div className="tax-summary invoice-editor">
    <strong>Purchase invoices</strong>
    <small>Verify the totals and GST on each document. Enter 0 for GST only when the invoice shows no tax.</small>
    {lines.map((line, index) => <fieldset className="invoice-fields" key={line.id} disabled={saving || line.reading}>
      <legend>Invoice {index + 1}</legend>
      <label>Invoice file<input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp"
        onChange={event => selectFile(line, event)}/></label>
      {line.file&&!line.reading&&<button type="button" className="compact-button" onClick={()=>{
        const url=URL.createObjectURL(line.file);
        window.open(url,'_blank','noopener,noreferrer');
        setTimeout(()=>URL.revokeObjectURL(url),60000);
      }}>View selected file</button>}
      {line.path && <button type="button" className="compact-button" onClick={() => viewInvoice(line.path)}>View existing file</button>}
      <label>Invoice type<select value={line.kind} onChange={event => change(line.id, {kind: event.target.value})}>
        <option>Product</option><option>Fee</option>
      </select></label>
      {textFields.map(([key, label]) => <label key={key}>{label}
        <input required={key === 'reference' || key === 'supplier'} value={line[key] ?? ''}
          onChange={event => change(line.id, {[key]: event.target.value})}/></label>)}
      {amountFields.map(([key, label]) => <label key={key}>{label}
        <input required={key === 'amount' || key === 'gst'} type="number" min="0"
          step={key === 'quantity' ? 'any' : '0.01'} value={line[key] ?? ''}
          onChange={event => change(line.id, {[key]: event.target.value})}/></label>)}
      {(line.notice||(line.needsReview&&missingInvoiceFields(line).length>0))&&
        <small className="invoice-notice" role="status">
          {line.notice}{line.notice&&line.needsReview?' ':''}
          {line.needsReview&&missingInvoiceFields(line).length>0&&
            `Enter these details from the attached document: ${missingInvoiceFields(line).join(', ')}.`}
        </small>}
      <div className="invoice-actions">
        {onApply && !line.quotation && line.kind === 'Product' && <button type="button" className="compact-button" onClick={() => onApply(line)}>Apply to purchase</button>}
        <button type="button" className="compact-button" onClick={() => {
          setReviewed(false);
          setLines(previous => previous.filter(item => item.id !== line.id));
        }}>Remove invoice</button>
      </div>
    </fieldset>)}
    <button type="button" className="compact-button" disabled={saving} onClick={() => {
      setReviewed(false);
      setLines(previous => [...previous, {id: crypto.randomUUID(), kind: 'Product'}]);
    }}>+ Add Invoice</button>
    {lines.length > 0 && <label className="invoice-verification">
      <input type="checkbox" required checked={reviewed} disabled={saving || lines.some(line => line.reading)}
        onChange={event => setReviewed(event.target.checked)}/>
      I verified the invoice details against the documents
    </label>}
  </div>;
}

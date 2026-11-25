import {useRowSelection,RowCheckbox,SelectedExport} from './selectedExport.jsx';
import EntryDetails from './EntryDetails.jsx';
import React,{useRef,useState} from 'react';
import {parseMoney, normalizeInvoiceKey} from './purchaseReconciliation.js';
import {saveAdvanceEntry} from './supabase.js';

export default function SupplierAdvances({balances, today, rupees, onSaved}) {
  const [form,setForm] = useState({supplier:'',amount:'',date:today,reference:''});
  const [saving,setSaving] = useState(false);
  const [message,setMessage] = useState('');
  const draft = useRef();
  const [selectedEntryId,setSelectedEntryId]=useState(null);
  const selection=useRowSelection(balances);
  const selectedEntry=balances.find(row=>row.id===selectedEntryId);
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage('');
    try {
      const supplier = form.supplier.trim();
      const amount = parseMoney(form.amount,'advance amount');
      if (!supplier || !amount) throw Error('Enter a supplier and an advance greater than zero.');
      draft.current ??= crypto.randomUUID();
      const row = await saveAdvanceEntry('supplierAdvances',draft.current,
        {...form,supplier,amount,reference:form.reference.trim()});
      onSaved(row);
      draft.current = undefined;
      setForm({supplier:'',amount:'',date:today,reference:''});
      setMessage('Supplier advance recorded.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }
  return <>
    <form className="entry-form" onSubmit={submit}>
      <h2>Record supplier advance</h2>
      <div className="fields">
        {[['supplier','Supplier name'],['amount','Advance paid (₹)'],['date','Payment date'],['reference','Payment reference']].map(([key,label])=>
          <label key={key}>{label}<input required={key!=='reference'} maxLength={250}
            type={key==='date'?'date':key==='amount'?'number':'text'}
            min={key==='amount'?'0.01':undefined} step={key==='amount'?'0.01':undefined}
            value={form[key]} onChange={event=>setForm({...form,[key]:event.target.value})}/></label>)}
      </div>
      <button className="primary" disabled={saving}>Record advance</button>
      {message&&<p role="status">{message}</p>}
    </form>
    <section>
      <div className="toolbar entry-table-toolbar">
        <h2>Unused supplier advances · {rupees(balances.reduce((sum,row)=>sum+row.remaining,0))}</h2>
        <SelectedExport selection={selection} name="supplier-advances"/>
      </div>
      <div className="tablewrap"><table className="record-table"><thead><tr><th className="entry-select">Select</th>
        {['Supplier','Payment date','Reference','Advance paid','Available','Actions'].map(label=><th key={label} className={['Advance paid','Available'].includes(label)?'entry-number':undefined}>{label}</th>)}
      </tr></thead><tbody>
        {[...balances].reverse().map(row=><tr key={row.id} className={selection.ids.has(row.id)?'entry-selected':undefined}>
          <RowCheckbox row={row} selection={selection} label={`${row.supplier} advance ${row.date}`}/>
          <td>{row.supplier}</td><td>{row.date}</td><td>{row.reference||'—'}</td>
          <td className="entry-number">{rupees(row.amount)}</td><td className="entry-number">{rupees(row.remaining)}</td>
          <td><button type="button" className="compact-button" onClick={()=>setSelectedEntryId(row.id)}>Open entry</button></td>
        </tr>)}
        {!balances.length&&<tr><td colSpan={7}>No advances recorded.</td></tr>}
      </tbody></table></div>
    </section>
    {selectedEntry&&<EntryDetails title="Supplier advance entry" onClose={()=>setSelectedEntryId(null)} fields={[
      ['Supplier',selectedEntry.supplier],['Payment date',selectedEntry.date],['Reference',selectedEntry.reference||'—'],
      ['Advance paid',rupees(selectedEntry.amount)],['Advance applied',rupees(Number(selectedEntry.amount)-selectedEntry.remaining)],
      ['Available',rupees(selectedEntry.remaining)],
    ]}/>}
  </>;
}

export function ApplyAdvance({purchase, field, balances, balanceDue, rupees, onSaved, onCancel}) {
  const eligible = balances.filter(row => row.remaining > 0 &&
    normalizeInvoiceKey(row.supplier) === normalizeInvoiceKey(purchase.supplier));
  const [selected,setSelected] = useState(eligible[0]?.id??'');
  const [amount,setAmount] = useState(eligible[0] ? String(Math.min(eligible[0].remaining,balanceDue)) : '');
  const [saving,setSaving] = useState(false);
  const [message,setMessage] = useState('');
  const draft = useRef();
  const available = eligible.find(advance=>advance.id===selected)?.remaining??0;
  const limit = Math.min(available,balanceDue);

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage('');
    try {
      const value = parseMoney(amount,'amount to apply');
      if (!selected || value <= 0 || value > limit) throw Error('Enter an amount within the available advance and purchase balance.');
      draft.current ??= crypto.randomUUID();
      const allocation = await saveAdvanceEntry('supplierAdvanceAllocations',draft.current,
        {advanceId:selected,[field]:purchase.id,amount:value});
      onSaved(allocation);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  return <form className="entry-form" onSubmit={submit}>
    <h2>Apply supplier advance</h2>
    <p>{purchase.supplier} · Invoice {purchase.invoice || purchase.invoiceDetails.find(line=>line.kind==='Product')?.reference} · Balance due {rupees(balanceDue)}</p>
    <div className="fields">
      <label>Available advance<select required value={selected} onChange={event=>{
        const id=event.target.value;
        setSelected(id);
        setAmount(id?String(Math.min(eligible.find(row=>row.id===id).remaining,balanceDue)):'');
      }}>
        <option value="">Select an advance</option>
        {eligible.map(row=><option value={row.id} key={row.id}>
          {row.date} · {rupees(row.remaining)} available{row.reference?` · ${row.reference}`:''}
        </option>)}
      </select></label>
      <label>Amount to apply (₹)<input required type="number" min="0.01" max={limit} step="0.01"
        value={amount} onChange={event=>setAmount(event.target.value)}/></label>
    </div>
    <div className="form-actions">
      <button className="primary" disabled={saving||!eligible.length}>Apply advance</button>
      <button type="button" disabled={saving} onClick={onCancel}>Cancel</button>
    </div>
    {!eligible.length&&<p>Record an advance using this supplier’s name first.</p>}
    {message&&<p role="status">{message}</p>}
  </form>;
}

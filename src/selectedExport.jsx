import React,{useState} from 'react';

export function downloadFile(name, content, type) {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const link=document.createElement('a');
  link.href=url;
  link.download=name;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function csvCell(value) {
  let text=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
  if (typeof value==='string'&&/^\s*[=+@-]/.test(text)&&!/^\s*-?\d+(?:\.\d+)?\s*$/.test(text)) text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}

export function useRowSelection(rows) {
  const [ids,setIds]=useState(()=>new Set());
  const selected=rows.filter(row=>ids.has(row.id));
  function toggle(id) {
    setIds(previous=>{
      const next=new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return {ids,selected,toggle,clear:()=>setIds(new Set())};
}

export function RowCheckbox({row, selection, label}) {
  return <td className="entry-select">
    <input type="checkbox" aria-label={`Select ${label}`}
      checked={selection.ids.has(row.id)} onChange={()=>selection.toggle(row.id)}/>
  </td>;
}

export function SelectedExport({selection, name, extraColumns}) {
  const rows=extraColumns?selection.selected.map(row=>({...row,...extraColumns(row)})):selection.selected;
  function exportRows() {
    if (!rows.length) return;
    const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))];
    const csv=[columns.map(csvCell).join(','),...rows.map(row=>columns.map(column=>csvCell(row[column])).join(','))];
    downloadFile(`${name}-selected.csv`,csv.join('\r\n'),'text/csv;charset=utf-8');
  }
  return <div className="entry-export">
    {rows.length>0&&<button type="button" onClick={selection.clear}>Clear selection</button>}
    <button type="button" disabled={!rows.length} onClick={exportRows}>Export selected CSV ({rows.length})</button>
  </div>;
}

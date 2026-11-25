import React,{useEffect,useId,useRef} from 'react';

export default function EntryDetails({title, fields, children, onClose}) {
  const dialog=useRef(null);
  const heading=useId();

  useEffect(()=>{
    const panel=dialog.current;
    panel.showModal();
    return ()=>{if (panel.open) panel.close();};
  },[]);

  return <dialog ref={dialog} className="entry-details" aria-labelledby={heading} onClose={onClose}>
    <div className="entry-details-heading">
      <h2 id={heading}>{title}</h2>
      <button type="button" onClick={()=>dialog.current.close()} autoFocus>Close</button>
    </div>
    <div className="entry-details-body">
      <dl className="entry-details-grid">
        {fields.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}
      </dl>
      {children}
    </div>
  </dialog>;
}

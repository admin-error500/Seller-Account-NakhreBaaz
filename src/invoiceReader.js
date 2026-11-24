import {getDocument, GlobalWorkerOptions} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc=workerUrl;

export function parseInvoice(text) {
  const reference=text.match(/Invoice\s*(?:Number|No\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9/-]+)/i)?.[1]||'';
  const orderId=text.match(/Order\s*ID\s*[:#]?\s*([A-Z0-9-]+)/i)?.[1]||'';
  const supplier=text.match(/Sold\s*By\s*:\s*([^\n,]+)/i)?.[1]?.trim()||'';
  const amountText=text.match(/Grand\s*Total\s*[:₹\s]*([\d,]+\.\d{2})/i)?.[1];
  const amount=amountText?Number(amountText.replace(/,/g,'')):null;
  const kind=/Protect Promise Fee|Handling Fee|Platform Fee/i.test(text)?'Fee':'Product';
  const totalRow=text.match(/(?:^|\n)\s*Total\s+(\d+)\s+([\d,.]+)\s+(-?[\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)/i);
  const num=v=>Number(v.replace(/,/g,''));
  const gst=totalRow&&amount!==null&&Math.abs(num(totalRow[6])-amount)<0.01&&Math.abs(num(totalRow[4])+num(totalRow[5])-amount)<0.011?num(totalRow[5]):null;
  return {reference,orderId,supplier,amount,kind,gst,reviewRequired:true};
}
export async function readInvoice(file){
  if(file.size>10485760)throw Error('Invoice exceeds 10 MB');
  if(file.type!=='application/pdf')throw Error('Image invoices require manual entry in this version');
  const doc=await getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false}).promise;
  try {
    const pages=[];
    for(let i=1;i<=doc.numPages;i++){
      const page=await doc.getPage(i);
      const content=await page.getTextContent();
      pages.push(content.items.map(x=>x.str+(x.hasEOL?'\n':' ')).join(''));
    }
    return parseInvoice(pages.join('\n'));
  } finally {await doc.destroy();}
}

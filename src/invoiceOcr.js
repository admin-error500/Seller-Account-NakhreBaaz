import {createWorker, OEM} from 'tesseract.js';
import workerPath from 'tesseract.js/dist/worker.min.js?url';
import corePath from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url';
import englishData from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';

export function createInvoiceOcr() {
  // The worker expects the language's original file name within its versioned directory.
  const langPath = new URL('.', new URL(englishData, window.location.href)).href;
  return new Promise((resolve, reject) => {
    const fail = message => reject(message instanceof Error ? message : Error(String(message)));
    createWorker('eng', OEM.LSTM_ONLY, {
      workerPath, corePath, langPath, workerBlobURL: false, cacheMethod: 'none', errorHandler: fail
    }).then(resolve, fail);
  });
}

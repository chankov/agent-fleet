import {parentPort,workerData} from 'node:worker_threads';
import {safeSourceRead} from '../lib/safe-source-read.js';
try { parentPort.postMessage({ok:true,bodies:workerData.paths.map(path=>safeSourceRead(workerData.root,path,workerData.maxBytes))}); }
catch(error) {parentPort.postMessage({ok:false,reason:['source_denied','source_changed','state_too_large'].includes(error.message)?error.message:'evidence_unavailable'});}

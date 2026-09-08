import { parentPort, workerData } from 'node:worker_threads';
import { Storage, type Saved, type SavedPatch } from './storage';

if (!parentPort) throw new Error('Studio storage worker requires a parent.');
let storage: Storage | undefined;
let fullSaveReady = false;
parentPort.on('message', (message: { id: number; type: 'save' | 'patch' | 'close'; state?: Saved | SavedPatch }) => {
  try {
    if (message.type === 'close') {
      storage?.close(); storage = undefined;
      parentPort!.postMessage({ id: message.id, ok: true }); parentPort!.close(); return;
    }
    if (!['save', 'patch'].includes(message.type) || !message.state) throw new Error('Invalid studio storage request.');
    if (!storage) storage = new Storage(workerData.directory);
    // Synchronous transactions + the worker's ordered message queue preserve commit order.
    if (message.type === 'patch') storage.patch(message.state as SavedPatch);
    else {
      if (!fullSaveReady) { storage.load(); fullSaveReady = true; }
      storage.save(message.state as Saved);
    }
    parentPort!.postMessage({ id: message.id, ok: true });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, ok: false, error: (error as Error).message || String(error) });
  }
});

const NAME = 'project-inbox-local-v1';
export const sharedStorage = false;
export const hasUnsavedChanges = () => false;
export const storageActions = () => {};
let database;
export function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Local storage could not be opened. Your browser may be blocking it.'));
  });
  return database;
}
export async function loadState() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('state').objectStore('state').get('mailbox');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Saved local mail could not be read.'));
  });
}
export async function persistState(state) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('state', 'readwrite');
    transaction.objectStore('state').put(state, 'mailbox');
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(new Error('Your changes could not be saved locally. Check browser storage space before closing this tab.'));
  });
}

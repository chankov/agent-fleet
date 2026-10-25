/** Pi loads every `-e` extension through its own jiti instance with moduleCache:false,
 * so a module-local singleton exists once per extension, not once per process.
 * State that several extensions must observe lives on the process realm under a
 * versioned Symbol.for key; bump the version whenever the stored shape changes. */
export function processShared<T>(key: string, init: () => T): T {
 const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
 const symbol = Symbol.for(key);
 return (realm[symbol] ??= init()) as T;
}

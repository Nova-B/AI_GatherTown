/**
 * Safe dictionary helpers for records keyed by untrusted identifiers.
 *
 * Provider payloads choose the keys (agent ids, tool ids, session ids). A key
 * such as "__proto__", "constructor" or "prototype" must become an own
 * property and must never resolve through Object.prototype. All reads and
 * writes of state dictionaries go through these helpers; dictionaries are
 * created with a null prototype, but the helpers are also correct on plain
 * objects (e.g. after JSON.parse / structuredClone on the client).
 */

export type Dict<T> = Record<string, T>;

export function createDict<T>(): Dict<T> {
  return Object.create(null) as Dict<T>;
}

export function hasOwn(dict: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(dict, key);
}

export function getOwn<T>(dict: Dict<T> | undefined | null, key: string): T | undefined {
  if (!dict || !hasOwn(dict, key)) return undefined;
  return dict[key];
}

export function setOwn<T>(dict: Dict<T>, key: string, value: T): T {
  Object.defineProperty(dict, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}

export function deleteOwn<T>(dict: Dict<T>, key: string): boolean {
  if (!hasOwn(dict, key)) return false;
  return delete dict[key];
}

export function ownKeys(dict: object): string[] {
  return Object.keys(dict).filter((k) => hasOwn(dict, k));
}

export function ownValues<T>(dict: Dict<T>): T[] {
  return ownKeys(dict).map((k) => dict[k] as T);
}

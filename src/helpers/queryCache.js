const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_ENTRIES = 500;

class QueryCache {
  #store = new Map();

  get(key) {
    const entry = this.#store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.#store.delete(key);
      return null;
    }

    this.#store.delete(key);
    this.#store.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.#store.has(key)) this.#store.delete(key);
    if (this.#store.size >= MAX_ENTRIES) {
      this.#store.delete(this.#store.keys().next().value);
    }
    this.#store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

export const queryCache = new QueryCache();

export function buildCacheKey(prefix, params) {
  const parts = Object.keys(params)
    .filter(
      (k) => params[k] !== undefined && params[k] !== null && params[k] !== "",
    )
    .sort()
    .map((k) => `${k}=${String(params[k]).toLowerCase()}`);
  return parts.length > 0 ? `${prefix}:${parts.join(":")}` : prefix;
}

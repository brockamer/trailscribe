/**
 * Typed KV helpers. All persistence in Phase 0/1 lives in Cloudflare KV.
 */

export async function getJSON<T>(ns: KVNamespace, key: string): Promise<T | null> {
  return ns.get<T>(key, "json");
}

export async function putJSON(
  ns: KVNamespace,
  key: string,
  value: unknown,
  opts?: KVNamespacePutOptions,
): Promise<void> {
  await ns.put(key, JSON.stringify(value), opts);
}

export async function exists(ns: KVNamespace, key: string): Promise<boolean> {
  const hit = await ns.get(key);
  return hit !== null;
}

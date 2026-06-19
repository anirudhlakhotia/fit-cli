/**
 * Resolve cb-alias version aliases (e.g. "8.1-stable", "8.0-release") to
 * concrete Couchbase Server version strings by fetching the cb-alias
 * products.yml from GitHub.
 *
 * See https://github.com/couchbaselabs/cb-alias/blob/master/products.yml
 */
import { parse as parseYaml } from "yaml";

const CB_ALIAS_URL = "https://raw.githubusercontent.com/couchbaselabs/cb-alias/master/products.yml";

/** Matches the "X.Y-qualifier" alias format, e.g. "8.1-stable" or "8.0-release". */
export const CB_ALIAS_RE = /^(\d+\.\d+)-(stable|release)$/;

export function isAlias(version: string): boolean {
  return CB_ALIAS_RE.test(version);
}

type Products = Record<string, Record<string, Record<string, string>>>;
let cachedProducts: Products | undefined;

async function fetchProducts(): Promise<Products> {
  if (cachedProducts) return cachedProducts;
  const res = await fetch(CB_ALIAS_URL);
  if (!res.ok) throw new Error(`Failed to fetch cb-alias products.yml: HTTP ${res.status}`);
  cachedProducts = parseYaml(await res.text()) as Products;
  return cachedProducts;
}

/**
 * Resolve a version alias to a concrete version string, e.g.
 * "8.1-stable" → "8.1.0-2188". Throws with a clear message if the alias
 * isn't found. Non-alias strings are returned unchanged.
 */
export async function resolveAlias(alias: string): Promise<string> {
  const match = CB_ALIAS_RE.exec(alias);
  if (!match) return alias;
  const [, majorMinor, qualifier] = match;
  const products = await fetchProducts();
  const entry = products["couchbase-server"]?.[majorMinor];
  if (!entry) {
    throw new Error(`cb-alias: no couchbase-server entry for '${majorMinor}'`);
  }
  const resolved = entry[qualifier]?.trim();
  if (!resolved) {
    const available = Object.keys(entry).join(", ");
    throw new Error(`cb-alias: no '${qualifier}' for ${majorMinor} — available: ${available}`);
  }
  console.log(`  → Resolved version alias ${alias} → ${resolved} (via ${CB_ALIAS_URL})`);
  return resolved;
}

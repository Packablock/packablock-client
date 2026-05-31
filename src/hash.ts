import { createHash } from 'node:crypto';

/**
 * Computes the SHA-256 hash of a string.
 * @param text The input string
 * @returns Hex-encoded hash
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Deterministically computes the signature/hash of a metadata block.
 * Sorts keys recursively to ensure standard serialization.
 * @param meta - Metadata object
 * @returns Hex-encoded hash
 */
export function deterministicMetaHash(meta: Record<string, any>): string {
  // Extract all properties except 'meta_hash' to avoid self-reference
  const { meta_hash, ...rest } = meta;
  
  // Deterministically sort keys
  const sortedKeys = Object.keys(rest).sort();
  const sortedObj: Record<string, any> = {};
  for (const key of sortedKeys) {
    const val = rest[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      sortedObj[key] = sortKeysObject(val);
    } else {
      sortedObj[key] = val;
    }
  }
  
  return sha256(JSON.stringify(sortedObj));
}

function sortKeysObject(obj: Record<string, any>): Record<string, any> {
  const sorted: Record<string, any> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      sorted[key] = sortKeysObject(val);
    } else {
      sorted[key] = val;
    }
  }
  return sorted;
}

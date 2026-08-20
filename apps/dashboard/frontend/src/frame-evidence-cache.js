export const FRAME_EVIDENCE_CACHE_MAX_ENTRIES = 3;
export const FRAME_EVIDENCE_CACHE_MAX_BYTES = 1024 * 1024;
export const FRAME_EVIDENCE_CACHE_MAX_ENTRY_BYTES = 512 * 1024;

const encoder = new TextEncoder();

function serializedBytes(value) {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function frameEvidenceCacheKey(snapshot, personId, startMs) {
  return JSON.stringify([snapshot, personId, startMs]);
}

export function createFrameEvidenceCache({
  maxEntries = FRAME_EVIDENCE_CACHE_MAX_ENTRIES,
  maxBytes = FRAME_EVIDENCE_CACHE_MAX_BYTES,
  maxEntryBytes = FRAME_EVIDENCE_CACHE_MAX_ENTRY_BYTES,
  measure = serializedBytes,
} = {}) {
  const entries = new Map();
  let bytes = 0;

  const remove = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.bytes;
  };

  return {
    get size() {
      return entries.size;
    },

    get bytes() {
      return bytes;
    },

    clear() {
      entries.clear();
      bytes = 0;
    },

    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    set(key, value) {
      remove(key);
      const entryBytes = measure(value);
      if (!Number.isSafeInteger(entryBytes) || entryBytes < 0 ||
          entryBytes > maxEntryBytes || entryBytes > maxBytes || maxEntries < 1) {
        return false;
      }
      while (entries.size >= maxEntries || bytes + entryBytes > maxBytes) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) return false;
        remove(oldestKey);
      }
      entries.set(key, { bytes: entryBytes, value });
      bytes += entryBytes;
      return true;
    },
  };
}

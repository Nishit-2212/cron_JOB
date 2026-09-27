import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeText } from "./matching.js";

// Two keys per job: the link, and title+company (the same post often has different links per source).
export function jobKeys(job) {
  const keys = [`t:${normalizeText(job.title)}|${normalizeText(job.company)}`];
  if (job.url) {
    keys.push(`u:${job.url.trim().toLowerCase()}`);
  }
  return keys.map((key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 20));
}

/**
 * Remembers jobs that were already emailed so each digest only contains new posts.
 * Stored as { hash: firstSeenISODate } and pruned after `retentionDays`.
 * In GitHub Actions the file is carried between runs with actions/cache.
 */
export async function loadSeenStore(file, retentionDays) {
  let entries = {};
  try {
    entries = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read ${file}, starting fresh: ${error.message}`);
    }
  }

  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const [key, seenAt] of Object.entries(entries)) {
    if (Date.parse(seenAt) < cutoff) {
      delete entries[key];
    }
  }

  return {
    size: () => Object.keys(entries).length,
    has: (job) => jobKeys(job).some((key) => key in entries),
    add(job) {
      const now = new Date().toISOString();
      for (const key of jobKeys(job)) {
        entries[key] ??= now;
      }
    },
    async save() {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(entries));
    }
  };
}

import { documentDirectory, getInfoAsync, makeDirectoryAsync, readAsStringAsync, writeAsStringAsync, moveAsync, deleteAsync, EncodingType } from "expo-file-system/legacy";
import { TranscriptCacheCorruptionError, type SessionTranscriptBackend } from "./session-transcript-backend-contract";
import { transcriptUtf8Size, TRANSCRIPT_CACHE_LIMITS } from "./session-transcript-projection";

/** Fixed 32 data slots, two manifests, two temps and one reset marker; no orphan growth. */
export const NATIVE_TRANSCRIPT_PHYSICAL_BYTES = 33 * (TRANSCRIPT_CACHE_LIMITS.entryBytes + 32) + 3 * TRANSCRIPT_CACHE_LIMITS.manifestBytes + 32;
function directory(): string {
  if (!documentDirectory) throw new Error("Native transcript directory unavailable");
  return `${documentDirectory}kcoder-confirmed-transcripts-v1/`;
}
function slotPath(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= 32) throw new Error("Invalid transcript slot");
  return `${directory()}data-${slot}`;
}
async function readBounded(path: string, maximum: number): Promise<string | null> {
  const info = await getInfoAsync(path);
  if (!info.exists) return null;
  if (info.isDirectory || !Number.isSafeInteger(info.size) || info.size > maximum) throw new TranscriptCacheCorruptionError("Invalid native transcript size");
  const raw = await readAsStringAsync(path, { encoding: EncodingType.UTF8 });
  if (raw.length > maximum || transcriptUtf8Size(raw) > maximum) throw new TranscriptCacheCorruptionError("Native transcript exceeded budget");
  return raw;
}
async function manifests() {
  if ((await getInfoAsync(`${directory()}reset.pending`)).exists) throw new TranscriptCacheCorruptionError("Interrupted transcript reset");
  const values = await Promise.all([0, 1].map(async slot => {
    const raw = await readBounded(`${directory()}manifest-${slot}`, TRANSCRIPT_CACHE_LIMITS.manifestBytes);
    if (raw === null) return null;
    let value: { revision?: number };
    try { value = JSON.parse(raw); } catch { throw new TranscriptCacheCorruptionError("Invalid native transcript manifest"); }
    if (!Number.isSafeInteger(value?.revision) || value.revision! < 0) throw new TranscriptCacheCorruptionError("Invalid native transcript manifest");
    return { slot, revision: value.revision!, raw };
  }));
  const present = values.filter(value => value !== null).sort((a, b) => b.revision - a.revision);
  if (present.length === 2 && present[0].revision === present[1].revision && present[0].raw !== present[1].raw) throw new TranscriptCacheCorruptionError("Ambiguous native transcript manifests");
  return present[0] ?? null;
}
async function reset(manifest: string, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) throw new Error("Transcript owner changed");
  await makeDirectoryAsync(directory(), { intermediates: true });
  // Durable-to-process marker prevents falling back to an old checkpoint if reset is interrupted.
  await writeAsStringAsync(`${directory()}reset.pending`, "reset", { encoding: EncodingType.UTF8 });
  for (const name of ["manifest-0", "manifest-1", "data.tmp", "manifest.tmp"]) await deleteAsync(`${directory()}${name}`, { idempotent: true });
  for (let slot = 0; slot < 32; slot++) await deleteAsync(slotPath(slot), { idempotent: true });
  if (!isCurrent()) throw new Error("Transcript owner changed");
  await writeAsStringAsync(`${directory()}manifest.tmp`, manifest, { encoding: EncodingType.UTF8 });
  await moveAsync({ from: `${directory()}manifest.tmp`, to: `${directory()}manifest-0` });
  await deleteAsync(`${directory()}reset.pending`, { idempotent: true });
}
export function createSessionTranscriptBackend(): SessionTranscriptBackend {
  return {
    reset,
    async readManifest() { return (await manifests())?.raw ?? null; },
    async readEntry(slot, revision) {
      const raw = await readBounded(slotPath(slot), TRANSCRIPT_CACHE_LIMITS.entryBytes + 32);
      if (raw === null) return null;
      const split = raw.indexOf("\n");
      if (split < 1 || split > 20 || raw.slice(0, split) !== String(revision)) throw new Error("Native transcript data revision mismatch");
      const data = raw.slice(split + 1);
      if (transcriptUtf8Size(data) > TRANSCRIPT_CACHE_LIMITS.entryBytes) throw new Error("Native transcript entry exceeds budget");
      return data;
    },
    async commit(change, isCurrent) {
      const check = () => { if (!isCurrent()) throw new Error("Transcript owner changed"); };
      check();
      const current = await manifests(); check();
      const next = JSON.parse(change.manifest) as { revision: number };
      if (next.revision !== (current?.revision ?? 0) + 1 || transcriptUtf8Size(change.manifest) > TRANSCRIPT_CACHE_LIMITS.manifestBytes) throw new TranscriptCacheCorruptionError("Invalid native transcript commit");
      await makeDirectoryAsync(directory(), { intermediates: true }); check();
      const temporary = `${directory()}data.tmp`; const manifestTemporary = `${directory()}manifest.tmp`;
      try {
        if (change.put) {
          if (transcriptUtf8Size(change.put.raw) > TRANSCRIPT_CACHE_LIMITS.entryBytes) throw new Error("Native transcript entry exceeds budget");
          await writeAsStringAsync(temporary, `${change.put.revision}\n${change.put.raw}`, { encoding: EncodingType.UTF8 }); check();
          await deleteAsync(slotPath(change.put.slot), { idempotent: true }); check();
          await moveAsync({ from: temporary, to: slotPath(change.put.slot) }); check();
        }
        const nextSlot = current?.slot === 0 ? 1 : 0;
        const destination = `${directory()}manifest-${nextSlot}`;
        await writeAsStringAsync(manifestTemporary, change.manifest, { encoding: EncodingType.UTF8 }); check();
        // Destination is inactive. The current manifest stays intact until this same-directory rename.
        await deleteAsync(destination, { idempotent: true }); check();
        await moveAsync({ from: manifestTemporary, to: destination });
        check();
        // Cache-only old checkpoints are removed after committing the new checkpoint.
        if (current) await deleteAsync(`${directory()}manifest-${current.slot}`, { idempotent: true });
        for (const slot of change.removeSlots) await deleteAsync(slotPath(slot), { idempotent: true });
        check();
      } finally {
        await deleteAsync(temporary, { idempotent: true });
        await deleteAsync(manifestTemporary, { idempotent: true });
      }
      // Expo exposes no fsync. This is a process-interruption checkpoint, not a power-loss guarantee.
    },
  };
}

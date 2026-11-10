import type { MetadataAuthority } from "./metadata-authority";
export interface TranscriptCacheChange {
  manifest: string;
  put?: { slot: number; revision: number; raw: string };
  removeSlots: number[];
}
export class TranscriptCacheCorruptionError extends Error {}
/** The caller owns the short shared profile gate; no network work belongs here. */
export interface SessionTranscriptBackend {
  readManifest(): Promise<string | null>;
  readEntry(slot: number, revision: number): Promise<string | null>;
  /** Cache-only atomic reset; does not touch profiles, credentials or pending intents. */
  reset(manifest: string, isCurrent: () => boolean, authority?: MetadataAuthority): Promise<void>;
  /** May publish before completion; caller compensates late owner cancellation under the gate. */
  commit(change: TranscriptCacheChange, isCurrent: () => boolean, authority?: MetadataAuthority): Promise<void>;
}

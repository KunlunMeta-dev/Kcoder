import type { BoundedByteReader } from "@/protocol/sha256-stream";
import { createAttachmentBytesBackend as createWebBackend } from "./staged-attachment-bytes.web";

export interface DurableByteSource extends BoundedByteReader { readonly blob?: Blob }
/** Callback is synchronous: the backend commits manifest, quota view and bytes atomically. */
export interface AttachmentStoreChange<T> {
  value: T;
  putRow?: { id: string; value: unknown };
  deleteRow?: string;
  putBytes?: { id: string; blob: Blob };
  deleteBytes?: string;
}
export interface AttachmentBytesBackend {
  readonly kind: "web" | "native";
  transaction<T>(change: (rows: readonly unknown[]) => AttachmentStoreChange<T>): Promise<T>;
  source(id: string, expectedSize: number): Promise<BoundedByteReader>;
  /** Native only, after the durable quota/copy-intent reservation. */
  copySource?(id: string, source: DurableByteSource, isCurrent: () => boolean, signal: AbortSignal | undefined, withOwnership: (write: () => void) => Promise<void>): Promise<string>;
  /** Native only, exact manifest-owned locator; never scans arbitrary files. */
  removeSource?(id: string): Promise<void>;
}
export const createAttachmentBytesBackend = createWebBackend;

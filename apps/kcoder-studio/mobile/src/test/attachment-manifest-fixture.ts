import type { StagedAttachmentRecord } from "@/storage/staged-attachment-store";
import type { AttachmentBytesBackend, AttachmentStoreChange } from "@/storage/staged-attachment-bytes";

/** Serial, bounded byte storage; tests use the real store and receipt codecs. */
export class AttachmentManifestFixture implements AttachmentBytesBackend {
  readonly kind = "web" as const;
  readonly rows = new Map<string, StagedAttachmentRecord>();
  readonly bytes = new Map<string, Blob>();
  private tail = Promise.resolve();
  async transaction<T>(change: (rows: readonly unknown[]) => AttachmentStoreChange<T>): Promise<T> {
    const before = this.tail; let release!: () => void;
    this.tail = new Promise<void>(done => { release = done; }); await before;
    try {
      const result = change([...this.rows.values()].map(row => structuredClone(row)));
      for (const row of [...result.putRows ?? [], ...result.putRow ? [result.putRow] : []]) this.rows.set(row.id, structuredClone(row.value) as StagedAttachmentRecord);
      if (result.deleteRow) this.rows.delete(result.deleteRow);
      if (result.putBytes) this.bytes.set(result.putBytes.id, result.putBytes.blob);
      if (result.deleteBytes) this.bytes.delete(result.deleteBytes);
      return result.value;
    } finally { release(); }
  }
  async source(id: string, expectedSize: number) {
    const blob = this.bytes.get(id); if (!blob || blob.size !== expectedSize) throw new Error("Missing owned source");
    return { size: blob.size, async read(offset: number, length: number) { return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); } };
  }
}

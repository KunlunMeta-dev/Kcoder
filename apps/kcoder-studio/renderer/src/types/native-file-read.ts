/** Native selected-file IPC v1. Rust contract: commands/selected_file_contract.rs. */
export interface NativeSelectedFile {
  name: string
  relativePath: string
  size: number
}
export interface NativeSelectedFileRead {
  readId: string
  chunkBytes: number
  files: NativeSelectedFile[]
}

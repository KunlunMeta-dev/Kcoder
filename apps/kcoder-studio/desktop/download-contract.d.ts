export interface DesktopDownloadRequest {
  url: string;
  filename: string;
}
export interface DesktopDownloadResult {
  status: "completed" | "cancelled" | "interrupted";
  filename: string;
}

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
export const LOCAL_RENDER_MAX_BYTES = 500 * 1024 * 1024; // safer ceiling for browser FFmpeg

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
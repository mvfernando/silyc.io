// Lightweight content fingerprint for cache keys.
// crypto.subtle.digest requires the full buffer in memory, which is unsafe
// for the 1 GB videos this app supports. We sample size + name + first/last
// 4 MiB instead — collisions on real user footage are astronomically unlikely
// while keeping the read O(8 MiB) regardless of file size.
const SAMPLE = 4 * 1024 * 1024;

export async function fingerprintFile(file: File): Promise<string> {
  const size = file.size;
  const head = await file.slice(0, Math.min(SAMPLE, size)).arrayBuffer();
  const tail =
    size > SAMPLE
      ? await file.slice(Math.max(0, size - SAMPLE), size).arrayBuffer()
      : new ArrayBuffer(0);
  const meta = new TextEncoder().encode(`${file.name}|${size}|${file.lastModified}`);
  const buf = new Uint8Array(meta.byteLength + head.byteLength + tail.byteLength);
  buf.set(meta, 0);
  buf.set(new Uint8Array(head), meta.byteLength);
  buf.set(new Uint8Array(tail), meta.byteLength + head.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
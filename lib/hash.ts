// SHA-256 content hash of a file, hex-encoded. Used to detect a re-upload of a
// byte-identical workbook. Web Crypto has no streaming digest, so the whole file
// is read into memory — fine for the KB–low-MB .xlsx workbooks handled here.
// (MD5 is intentionally not used: crypto.subtle does not support it, and a
// content fingerprint does not need to be MD5.)
export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

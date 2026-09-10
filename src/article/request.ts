export type CaptureRequest = { kind: "chat" } | { kind: "capture"; url: string }
  | { kind: "reject"; code: "capture_invalid_request" | "capture_invalid_url" | "capture_input_too_large" };

export function classifyCaptureRequest(content: string): CaptureRequest {
  const text = content.trim();
  const command = /^总结(?:\s|$)/u.test(text);
  const candidate = command ? text.slice(2).trim() : text;
  if (!command && (!/^[a-z][a-z\d+.-]*:/i.test(candidate) || /\s/u.test(candidate))) return { kind: "chat" };
  if (content.length > 4_000) return { kind: "reject", code: "capture_input_too_large" };
  if (!candidate || /\s/u.test(candidate)) return { kind: "reject", code: "capture_invalid_request" };
  if (!isPublicUrl(candidate)) return { kind: "reject", code: "capture_invalid_url" };
  return { kind: "capture", url: new URL(candidate).href };
}

export function isPublicUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!/^https?:\/\//i.test(value) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.includes(":")) {
    if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab][0-9a-f]:/i.test(host)) return false;
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      return isPublicUrl(`http://${high >> 8}.${high & 255}.${low >> 8}.${low & 255}/`);
    }
  }
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = parts;
  return !(first === 0 || first === 10 || first === 127 || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168));
}

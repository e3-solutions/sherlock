import path from "node:path";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

export function mimeTypeForPath(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function parseQuality(value) {
  const normalized = value.trim();
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(normalized)) return 0;
  return Number.parseFloat(normalized);
}

function acceptedCodings(header) {
  const accepted = new Map();
  if (typeof header !== "string" || header.trim() === "") return accepted;
  for (const item of header.split(",")) {
    const [rawCoding, ...parameters] = item.split(";");
    const coding = rawCoding.trim().toLowerCase();
    if (!coding) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [rawName, rawValue = ""] = parameter.split("=", 2);
      if (rawName.trim().toLowerCase() === "q") quality = parseQuality(rawValue);
    }
    accepted.set(coding, Math.max(accepted.get(coding) ?? 0, quality));
  }
  return accepted;
}

export function selectJsonRepresentation({ identity, gzip }, acceptEncoding) {
  const accepted = acceptedCodings(acceptEncoding);
  const wildcardQuality = accepted.get("*");
  const gzipQuality = accepted.has("gzip")
    ? accepted.get("gzip")
    : wildcardQuality ?? 0;
  const identityQuality = accepted.get("identity");
  const identityAccepted = identityQuality !== undefined
    ? identityQuality > 0
    : wildcardQuality !== 0;
  if (gzipQuality > 0 && (
    identityQuality === undefined || gzipQuality >= identityQuality
  )) {
    return { bytes: gzip, encoding: "gzip" };
  }
  return identityAccepted ? { bytes: identity, encoding: null } : null;
}

export function flameRepresentationHeaders(representation, state) {
  return {
    "Content-Length": representation.bytes.byteLength,
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Accept-Encoding",
    "X-Sherlock-Timeline-Cache": state,
    ...(representation.encoding ? { "Content-Encoding": representation.encoding } : {}),
  };
}

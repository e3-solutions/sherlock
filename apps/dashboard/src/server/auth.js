import { timingSafeEqual } from "node:crypto";

function equal(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function hasDashboardCredentials(config) {
  return Boolean(config.username && config.password);
}

export function authorizeBasic(header, config) {
  if (!hasDashboardCredentials(config) || typeof header !== "string") return false;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (!match) return false;

  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return equal(decoded.slice(0, separator), config.username) &&
    equal(decoded.slice(separator + 1), config.password);
}

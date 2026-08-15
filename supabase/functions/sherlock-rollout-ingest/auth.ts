import { type CollectorIdentity, IngestError, sha256Hex } from "./contract.ts";

export interface CollectorGrant {
  workspace_id: string;
  collector_key_prefix: string;
}

interface CollectorConfiguration extends CollectorGrant {
  token_sha256: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const COLLECTOR_KEY_PREFIX = /^[A-Za-z0-9._~-]{1,160}$/;

function configurationError(message: string): never {
  throw new IngestError("invalid_configuration", message, 500);
}

function unauthorized(message: string): never {
  throw new IngestError("unauthorized", message, 401);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function parseCollectorConfigurations(
  raw: string,
): CollectorConfiguration[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    configurationError("collector allowlist is invalid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    configurationError("collector allowlist is empty");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      configurationError("collector entry is invalid");
    }
    const entry = item as Record<string, unknown>;
    for (
      const field of [
        "token_sha256",
        "workspace_id",
        "collector_key",
      ]
    ) {
      if (
        typeof entry[field] !== "string" ||
        (entry[field] as string).length === 0
      ) {
        configurationError(`${field} is invalid`);
      }
    }
    if (
      !SHA256.test(entry.token_sha256 as string) ||
      !UUID.test(entry.workspace_id as string) ||
      !COLLECTOR_KEY_PREFIX.test(entry.collector_key as string)
    ) {
      configurationError(
        "collector workspace, key prefix, or token hash is invalid",
      );
    }
    return {
      token_sha256: entry.token_sha256 as string,
      workspace_id: entry.workspace_id as string,
      collector_key_prefix: entry.collector_key as string,
    };
  });
}

export async function authenticate(
  authorization: string | null,
  configurations: CollectorConfiguration[],
): Promise<CollectorGrant> {
  if (!authorization?.startsWith("Bearer ")) {
    unauthorized("collector bearer credential is required");
  }
  const token = authorization.slice("Bearer ".length);
  const tokenHash = await sha256Hex(new TextEncoder().encode(token));
  let match: CollectorConfiguration | null = null;
  for (const configuration of configurations) {
    if (constantTimeEqual(tokenHash, configuration.token_sha256)) {
      match = configuration;
    }
  }
  if (!match) {
    unauthorized("collector credential is invalid");
  }
  return {
    workspace_id: match.workspace_id,
    collector_key_prefix: match.collector_key_prefix,
  };
}

export async function collectorKeyForIdentity(
  grant: CollectorGrant,
  identity: CollectorIdentity,
): Promise<string> {
  const digest = await sha256Hex(
    new TextEncoder().encode(`${identity.email}\0${identity.installation_id}`),
  );
  return `${grant.collector_key_prefix}-${digest.slice(0, 32)}`;
}

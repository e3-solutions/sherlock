import { type Attribution, IngestError, sha256Hex } from "./contract.ts";

interface CollectorConfiguration extends Attribution {
  token_sha256: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

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
    throw new IngestError(
      "invalid_configuration",
      "collector allowlist is invalid JSON",
      500,
    );
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new IngestError(
      "invalid_configuration",
      "collector allowlist is empty",
      500,
    );
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new IngestError(
        "invalid_configuration",
        "collector entry is invalid",
        500,
      );
    }
    const entry = item as Record<string, unknown>;
    for (
      const field of [
        "token_sha256",
        "workspace_id",
        "person_id",
        "collector_key",
      ]
    ) {
      if (
        typeof entry[field] !== "string" ||
        (entry[field] as string).length === 0
      ) {
        throw new IngestError(
          "invalid_configuration",
          `${field} is invalid`,
          500,
        );
      }
    }
    if (
      !SHA256.test(entry.token_sha256 as string) ||
      !UUID.test(entry.workspace_id as string) ||
      !UUID.test(entry.person_id as string)
    ) {
      throw new IngestError(
        "invalid_configuration",
        "collector IDs or token hash are invalid",
        500,
      );
    }
    return entry as unknown as CollectorConfiguration;
  });
}

export async function authenticate(
  authorization: string | null,
  configurations: CollectorConfiguration[],
): Promise<Attribution> {
  if (!authorization?.startsWith("Bearer ")) {
    throw new IngestError(
      "unauthorized",
      "collector bearer credential is required",
      401,
    );
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
    throw new IngestError(
      "unauthorized",
      "collector credential is invalid",
      401,
    );
  }
  return {
    workspace_id: match.workspace_id,
    person_id: match.person_id,
    collector_key: match.collector_key,
  };
}

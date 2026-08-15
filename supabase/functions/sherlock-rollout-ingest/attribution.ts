import { type CollectorIdentity, IngestError, sha256Hex } from "./contract.ts";

export interface CollectorGrant {
  workspace_id: string;
  collector_key_prefix: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function publicCollectorGrant(workspaceId: string): CollectorGrant {
  if (!UUID.test(workspaceId)) {
    throw new IngestError(
      "invalid_configuration",
      "SHERLOCK_WORKSPACE_ID must be a UUID",
      500,
    );
  }
  return {
    workspace_id: workspaceId,
    collector_key_prefix: "team",
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

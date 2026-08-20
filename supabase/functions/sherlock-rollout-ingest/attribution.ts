import { type CollectorIdentity, IngestError, sha256Hex } from "./contract.ts";

export interface CollectorGrant {
  workspace_id: string;
  collector_key_prefix: string;
}

export interface WorkspaceRoutingConfig {
  e3_workspace_id: string;
  sixtyfour_workspace_id: string;
}

export const E3_EMAIL_DOMAIN = "e3group.ai";
export const SIXTYFOUR_EMAIL_DOMAIN = "sixtyfour.ai";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function workspaceRoutingConfig(
  e3WorkspaceId: string,
  sixtyfourWorkspaceId: string,
): WorkspaceRoutingConfig {
  if (!UUID.test(e3WorkspaceId) || !UUID.test(sixtyfourWorkspaceId)) {
    throw new IngestError(
      "invalid_configuration",
      "Sherlock workspace routing IDs must be UUIDs",
      500,
    );
  }
  const normalizedE3WorkspaceId = e3WorkspaceId.toLowerCase();
  const normalizedSixtyfourWorkspaceId = sixtyfourWorkspaceId.toLowerCase();
  if (normalizedE3WorkspaceId === normalizedSixtyfourWorkspaceId) {
    throw new IngestError(
      "invalid_configuration",
      "Sherlock workspace routing IDs must be distinct",
      500,
    );
  }
  return {
    e3_workspace_id: normalizedE3WorkspaceId,
    sixtyfour_workspace_id: normalizedSixtyfourWorkspaceId,
  };
}

export function publicCollectorGrant(
  config: WorkspaceRoutingConfig,
  identity: CollectorIdentity,
): CollectorGrant {
  const domain = identity.email.split("@")[1];
  const workspaceId = domain === E3_EMAIL_DOMAIN
    ? config.e3_workspace_id
    : domain === SIXTYFOUR_EMAIL_DOMAIN
    ? config.sixtyfour_workspace_id
    : null;
  if (workspaceId === null) {
    throw new IngestError(
      "collector_domain_forbidden",
      "collector email domain is not approved",
      403,
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

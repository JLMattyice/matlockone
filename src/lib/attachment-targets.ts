import "server-only";

import { ATTACHMENT_ENTITIES, type AttachmentEntityType } from "./attachment-entities";
import { prisma } from "./db";

/**
 * The Prisma model behind each attachment target.
 *
 * A lookup rather than a chain of ternaries: the old chain ended in an `else`
 * that reached for invoices, so adding a sixth entity type silently checked the
 * wrong table and every upload against it was rejected as missing. Keying the
 * type to the model means a new entry has to name its own table.
 */
const ATTACHMENT_TARGET_MODELS: Record<
  AttachmentEntityType,
  { findFirst(args: { where: object; select: object }): Promise<unknown> }
> = {
  client: prisma.client,
  job: prisma.job,
  lead: prisma.lead,
  estimate: prisma.estimate,
  invoice: prisma.invoice,
  expense: prisma.expense,
};

/**
 * Confirms the record a file is being attached to lives in the caller's
 * organization. Without this an id from another tenant would hang a file off a
 * record the uploader cannot see.
 *
 * Shared by the upload action and the direct-upload ticket endpoint, because a
 * check that exists on only one of the two ways in is not a check.
 */
export async function attachmentTargetExists(
  entityType: AttachmentEntityType,
  entityId: string,
  organizationId: string,
) {
  const found = await ATTACHMENT_TARGET_MODELS[entityType].findFirst({
    where: { id: entityId, organizationId },
    select: { id: true },
  });

  return Boolean(found);
}

export { ATTACHMENT_ENTITIES };

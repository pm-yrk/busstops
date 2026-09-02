import { z } from "zod";
import { IsoInstantSchema, UuidSchema } from "./common.js";

/**
 * Account domain — deliberately separate and access-controlled.
 * Never holds raw national telemetry. See docs/06_DATA_MODEL.md "Identity and privacy".
 */

export const OrganisationSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1),
  createdAt: IsoInstantSchema,
  /** Area/operator/route IDs this organisation may scope Pro data to. */
  permittedScopeIds: z.array(z.string()).default([]),
  timezone: z.string().default("Europe/London"),
  metricDefinitionProfile: z.string().default("default"),
});
export type Organisation = z.infer<typeof OrganisationSchema>;

export const UserRoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserSchema = z.object({
  id: UuidSchema,
  email: z.string().email(),
  emailVerifiedAt: IsoInstantSchema.nullable(),
  organisationId: UuidSchema.nullable(),
  role: UserRoleSchema.default("viewer"),
  createdAt: IsoInstantSchema,
  lastSeenAt: IsoInstantSchema.nullable(),
});
export type User = z.infer<typeof UserSchema>;

export const PreferenceSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  key: z.string().min(1),
  value: z.unknown(),
  updatedAt: IsoInstantSchema,
});
export type Preference = z.infer<typeof PreferenceSchema>;

export const RecipientSchema = z.object({
  id: UuidSchema,
  organisationId: UuidSchema.nullable(),
  email: z.string().email(),
  verifiedAt: IsoInstantSchema.nullable(),
  /** Explicit opt-in is required before any Daily Brief send. */
  optedInAt: IsoInstantSchema.nullable(),
  unsubscribedAt: IsoInstantSchema.nullable(),
  timezone: z.string().default("Europe/London"),
  deliveryLocalTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("07:00"),
  scopeAreaIds: z.array(z.string()).default([]),
  /** One-click unsubscribe token; rotated on use. */
  unsubscribeTokenHash: z.string().nullable(),
});
export type Recipient = z.infer<typeof RecipientSchema>;

export const ConsentEventSchema = z.object({
  id: UuidSchema,
  subjectType: z.enum(["user", "recipient"]),
  subjectId: UuidSchema,
  action: z.enum(["opt_in", "opt_out", "verify", "delete_request", "scope_change"]),
  occurredAt: IsoInstantSchema,
  /** Non-identifying audit context only — never raw IP or precise location. */
  context: z.string().optional(),
});
export type ConsentEvent = z.infer<typeof ConsentEventSchema>;

export const DailyBriefSendRecordSchema = z.object({
  id: UuidSchema,
  recipientId: UuidSchema,
  snapshotId: UuidSchema,
  /** Idempotency key = snapshot + recipient; a duplicate key must never send twice. */
  idempotencyKey: z.string(),
  attemptedAt: IsoInstantSchema,
  outcome: z.enum([
    "sent",
    "suppressed_quota",
    "suppressed_unsubscribed",
    "failed",
    "skipped_no_data",
  ]),
  detail: z.string().optional(),
});
export type DailyBriefSendRecord = z.infer<typeof DailyBriefSendRecordSchema>;

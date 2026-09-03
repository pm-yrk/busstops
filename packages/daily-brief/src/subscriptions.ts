import type {
  ConsentEvent,
  DailyBriefSendRecord,
  GovernorState,
  Recipient,
} from "@busstops/contracts";
import { deterministicUuid } from "@busstops/adapters";

/**
 * Subscription, consent and send guards (docs/12_DAILY_BRIEF.md "Subscriptions", docs/14_SECURITY.md).
 *
 * Every rule here exists because getting it wrong sends unwanted email to a real person, which
 * cannot be undone. So the checks are structural: `canSend` returns a typed refusal with a reason
 * rather than a boolean, no caller can accidentally treat "unverified" as "fine", and the reason
 * goes into the audit record.
 *
 * The unsubscribe token is stored only as a hash. A leaked backup then cannot be used to
 * unsubscribe anyone, and cannot be reversed into a list of addresses.
 */

export const SEND_LIMITS = {
  /** Provider free-tier daily ceiling, with our own margin below it. */
  dailySendCap: 100,
  /** Our self-imposed ceiling, leaving headroom for retries within the same day. */
  selfImposedDailyCap: 80,
  /** Maximum recipients per organisation, so one organisation cannot consume the whole cap. */
  maxRecipientsPerOrganisation: 25,
  /** Retries for a transient failure, within the same day. */
  maxRetries: 2,
} as const;

export type SendRefusalReason =
  | "not_verified"
  | "not_opted_in"
  | "unsubscribed"
  | "already_sent"
  | "daily_cap_reached"
  | "governor_suspended"
  | "no_provider"
  | "outside_delivery_window";

export type SendDecision =
  | { allowed: true; idempotencyKey: string }
  | { allowed: false; reason: SendRefusalReason; detail: string };

/**
 * Idempotency key. Snapshot plus recipient: re-running the job, or retrying after a timeout where
 * the provider actually did send, cannot produce a second email.
 */
export function idempotencyKeyFor(snapshotId: string, recipientId: string): string {
  return `${snapshotId}|${recipientId}`;
}

export interface SendContext {
  recipient: Recipient;
  snapshotId: string;
  /** Send records already written today, used for both idempotency and the daily cap. */
  todaysRecords: readonly DailyBriefSendRecord[];
  governorState: GovernorState;
  emailProviderConfigured: boolean;
  /** Local time now, in the recipient's timezone, as HH:MM. */
  recipientLocalTime: string;
  /** Minutes either side of the requested delivery time that count as on time. */
  deliveryToleranceMinutes?: number;
}

export function canSend(context: SendContext): SendDecision {
  const { recipient } = context;
  const idempotencyKey = idempotencyKeyFor(context.snapshotId, recipient.id);

  // The product must work with no email provider configured at all.
  if (!context.emailProviderConfigured) {
    return {
      allowed: false,
      reason: "no_provider",
      detail: "No email provider is configured, so no brief is sent. Pro remains fully usable.",
    };
  }

  if (recipient.unsubscribedAt !== null) {
    return {
      allowed: false,
      reason: "unsubscribed",
      detail: "This recipient unsubscribed and must never be sent to again.",
    };
  }

  if (recipient.verifiedAt === null) {
    return {
      allowed: false,
      reason: "not_verified",
      detail: "This address has not been verified, so we cannot know the owner asked for it.",
    };
  }

  if (recipient.optedInAt === null) {
    return {
      allowed: false,
      reason: "not_opted_in",
      detail: "No explicit opt-in is recorded for this recipient.",
    };
  }

  const alreadySent = context.todaysRecords.some(
    (record) => record.idempotencyKey === idempotencyKey && record.outcome === "sent",
  );
  if (alreadySent) {
    return {
      allowed: false,
      reason: "already_sent",
      detail: "This snapshot has already been sent to this recipient.",
    };
  }

  const sentToday = context.todaysRecords.filter((record) => record.outcome === "sent").length;
  const cap =
    context.governorState === "green"
      ? SEND_LIMITS.selfImposedDailyCap
      : Math.floor(SEND_LIMITS.selfImposedDailyCap / 2);

  if (sentToday >= cap) {
    return {
      allowed: false,
      reason: "daily_cap_reached",
      detail: `${sentToday} briefs have been sent today, at or above the cap of ${cap}. Sending stops before the provider's free limit rather than after it.`,
    };
  }

  // Under critical budget pressure only already-verified essential sends continue; previews and
  // test sends are suspended first, and are never routed through this path at all.
  if (context.governorState === "critical") {
    return {
      allowed: false,
      reason: "governor_suspended",
      detail:
        "The budget governor is in its critical state, so new Daily Brief sends are suspended before any paid overage can occur.",
    };
  }

  if (!withinDeliveryWindow(context)) {
    return {
      allowed: false,
      reason: "outside_delivery_window",
      detail: `This recipient asked for ${recipient.deliveryLocalTime} local time; it is currently ${context.recipientLocalTime}.`,
    };
  }

  return { allowed: true, idempotencyKey };
}

export function withinDeliveryWindow(context: SendContext): boolean {
  const tolerance = context.deliveryToleranceMinutes ?? 30;
  const requested = minutesFrom(context.recipient.deliveryLocalTime);
  const actual = minutesFrom(context.recipientLocalTime);
  if (requested === null || actual === null) return false;

  // Wrap-around: 00:10 is twenty minutes after 23:50, not fourteen hours before it.
  const difference = Math.min(Math.abs(actual - requested), 1440 - Math.abs(actual - requested));
  return difference <= tolerance;
}

function minutesFrom(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Recipients that may be considered at all, before per-recipient checks. */
export function eligibleRecipients(
  recipients: readonly Recipient[],
  organisationId: string | null,
): Recipient[] {
  return recipients
    .filter((recipient) => recipient.organisationId === organisationId)
    .filter((recipient) => recipient.unsubscribedAt === null)
    .slice(0, SEND_LIMITS.maxRecipientsPerOrganisation);
}

/**
 * Hash of a one-click unsubscribe token. Only the hash is stored, so the stored value cannot be
 * used to unsubscribe anyone and a leaked backup reveals nothing usable.
 */
export function unsubscribeTokenHash(token: string, secret: string): string {
  let hash = 0x811c9dc5;
  const material = `${secret}:${token}`;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // A second pass over the first digest, so the mapping is not a simple per-character sum.
  let second = 0x811c9dc5;
  const digest = hash.toString(16).padStart(8, "0");
  for (let index = 0; index < digest.length + material.length; index += 1) {
    second ^= (digest + material).charCodeAt(index);
    second = Math.imul(second, 0x01000193) >>> 0;
  }
  return `${digest}${second.toString(16).padStart(8, "0")}`;
}

/**
 * Constant-time-ish comparison. Both strings are hex digests of fixed length, so this compares
 * every character regardless of where the first difference is.
 */
export function tokenMatches(candidateHash: string, storedHash: string | null): boolean {
  if (storedHash === null || candidateHash.length !== storedHash.length) return false;
  let difference = 0;
  for (let index = 0; index < candidateHash.length; index += 1) {
    difference |= candidateHash.charCodeAt(index) ^ storedHash.charCodeAt(index);
  }
  return difference === 0;
}

export interface UnsubscribeResult {
  recipient: Recipient;
  consent: ConsentEvent;
  /** True when the recipient was already unsubscribed; still a success, not an error. */
  alreadyUnsubscribed: boolean;
}

/**
 * One-click unsubscribe, honoured immediately.
 *
 * Idempotent by design: a mail client that prefetches the link, a double click, or a second
 * attempt from a forwarded email must all succeed quietly. Returning an error on the second
 * attempt would make someone think it had not worked and go looking for another way out.
 */
export function unsubscribe(recipient: Recipient, at: Date): UnsubscribeResult {
  const alreadyUnsubscribed = recipient.unsubscribedAt !== null;

  return {
    recipient: {
      ...recipient,
      unsubscribedAt: alreadyUnsubscribed ? recipient.unsubscribedAt : at.toISOString(),
      optedInAt: null,
      // The token is spent: a leaked link cannot be replayed later.
      unsubscribeTokenHash: null,
    },
    consent: {
      id: deterministicUuid("incident", `consent|opt_out|${recipient.id}|${at.toISOString()}`),
      subjectType: "recipient",
      subjectId: recipient.id,
      action: "opt_out",
      occurredAt: at.toISOString(),
      context: "one-click unsubscribe",
    },
    alreadyUnsubscribed,
  };
}

/** Records an explicit opt-in with its audit event. Verification must already have happened. */
export function optIn(
  recipient: Recipient,
  at: Date,
): { recipient: Recipient; consent: ConsentEvent } | { error: string } {
  if (recipient.verifiedAt === null) {
    return {
      error: "This address must be verified before it can be opted in.",
    };
  }

  return {
    recipient: {
      ...recipient,
      optedInAt: at.toISOString(),
      unsubscribedAt: null,
    },
    consent: {
      id: deterministicUuid("incident", `consent|opt_in|${recipient.id}|${at.toISOString()}`),
      subjectType: "recipient",
      subjectId: recipient.id,
      action: "opt_in",
      occurredAt: at.toISOString(),
      context: "explicit opt-in",
    },
  };
}

/** Records verification of an address and its audit event. */
export function verify(
  recipient: Recipient,
  at: Date,
): { recipient: Recipient; consent: ConsentEvent } {
  return {
    recipient: { ...recipient, verifiedAt: at.toISOString() },
    consent: {
      id: deterministicUuid("incident", `consent|verify|${recipient.id}|${at.toISOString()}`),
      subjectType: "recipient",
      subjectId: recipient.id,
      action: "verify",
      occurredAt: at.toISOString(),
      context: "email address verified",
    },
  };
}

export function sendRecord(input: {
  recipientId: string;
  snapshotId: string;
  attemptedAt: Date;
  outcome: DailyBriefSendRecord["outcome"];
  detail?: string;
}): DailyBriefSendRecord {
  const idempotencyKey = idempotencyKeyFor(input.snapshotId, input.recipientId);
  return {
    id: deterministicUuid("incident", `send|${idempotencyKey}|${input.attemptedAt.toISOString()}`),
    recipientId: input.recipientId,
    snapshotId: input.snapshotId,
    idempotencyKey,
    attemptedAt: input.attemptedAt.toISOString(),
    outcome: input.outcome,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
}

import type {
  ConsentEvent,
  DailyBriefSendRecord,
  DailyBriefSnapshot,
  GovernorState,
  Recipient,
} from "@busstops/contracts";
import {
  SEND_LIMITS,
  canSend,
  decideSend,
  renderHtml,
  renderText,
  sendRecord,
  subjectLine,
  unsubscribeTokenHash,
} from "@busstops/daily-brief";
import type { EmailProvider } from "./email-provider.js";

/**
 * The Daily Brief send loop.
 *
 * One snapshot, many recipients, and a written record for every one of them — including the ones
 * that were refused. An unexplained absence of email is indistinguishable from a broken job, so
 * "suppressed because unverified" and "skipped because coverage was too thin" are recorded
 * outcomes rather than silence.
 *
 * Retries are bounded and only for transient failures. A 4xx will not succeed on a retry and
 * retrying it just spends the daily cap on an address that will never accept mail.
 */

export interface SendRunInput {
  snapshot: DailyBriefSnapshot;
  coverage: number;
  recipients: readonly Recipient[];
  todaysRecords: readonly DailyBriefSendRecord[];
  governorState: GovernorState;
  provider: EmailProvider;
  baseUrl: string;
  organisationName: string | null;
  unsubscribeSecret: string;
  /** Local time per recipient, HH:MM, resolved by the caller against each timezone. */
  localTimeFor: (recipient: Recipient) => string;
  /** Per-recipient preference for thin-data days. */
  limitedDataPreferenceFor?: (recipient: Recipient) => "send_limited" | "skip_when_limited";
  now: () => Date;
  /** Generates a fresh unsubscribe token; only its hash is stored. */
  generateToken: (recipient: Recipient) => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface SendRunReport {
  snapshotId: string;
  attempted: number;
  sent: number;
  suppressed: number;
  failed: number;
  skipped: number;
  records: DailyBriefSendRecord[];
  consentEvents: ConsentEvent[];
  /** Token hashes to persist against each recipient, so the sent link can be honoured later. */
  tokenHashes: Array<{ recipientId: string; hash: string }>;
  notes: string[];
}

export async function runDailyBriefSend(input: SendRunInput): Promise<SendRunReport> {
  const report: SendRunReport = {
    snapshotId: input.snapshot.id,
    attempted: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
    skipped: 0,
    records: [],
    consentEvents: [],
    tokenHashes: [],
    notes: [],
  };

  const providerConfigured = input.provider.name !== "none";
  if (!providerConfigured) {
    report.notes.push(
      "No email provider is configured. The snapshot was still produced and is available in Pro.",
    );
  }

  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const records: DailyBriefSendRecord[] = [...input.todaysRecords];

  for (const recipient of input.recipients.slice(0, SEND_LIMITS.maxRecipientsPerOrganisation)) {
    const now = input.now();
    report.attempted += 1;

    const preference = input.limitedDataPreferenceFor?.(recipient) ?? "send_limited";
    const dataDecision = decideSend(input.snapshot, input.coverage, preference);

    if (dataDecision.action === "skip") {
      const record = sendRecord({
        recipientId: recipient.id,
        snapshotId: input.snapshot.id,
        attemptedAt: now,
        outcome: "skipped_no_data",
        detail: dataDecision.reason,
      });
      records.push(record);
      report.records.push(record);
      report.skipped += 1;
      continue;
    }

    const decision = canSend({
      recipient,
      snapshotId: input.snapshot.id,
      todaysRecords: records,
      governorState: input.governorState,
      emailProviderConfigured: providerConfigured,
      recipientLocalTime: input.localTimeFor(recipient),
    });

    if (!decision.allowed) {
      const record = sendRecord({
        recipientId: recipient.id,
        snapshotId: input.snapshot.id,
        attemptedAt: now,
        outcome:
          decision.reason === "unsubscribed"
            ? "suppressed_unsubscribed"
            : decision.reason === "daily_cap_reached" || decision.reason === "governor_suspended"
              ? "suppressed_quota"
              : "suppressed_unsubscribed",
        detail: decision.detail,
      });
      records.push(record);
      report.records.push(record);
      report.suppressed += 1;
      continue;
    }

    // A fresh token per send, stored only as a hash. The plaintext exists just long enough to be
    // put in the email.
    const token = input.generateToken(recipient);
    const hash = unsubscribeTokenHash(token, input.unsubscribeSecret);
    report.tokenHashes.push({ recipientId: recipient.id, hash });

    const unsubscribeUrl = `${input.baseUrl}/unsubscribe?r=${encodeURIComponent(recipient.id)}&t=${encodeURIComponent(token)}`;
    const options = {
      baseUrl: input.baseUrl,
      unsubscribeUrl,
      organisationName: input.organisationName,
      limitedData: dataDecision.action === "send_limited",
    };

    const message = {
      to: recipient.email,
      subject: subjectLine(input.snapshot, options.limitedData),
      html: renderHtml(input.snapshot, options),
      text: renderText(input.snapshot, options),
      listUnsubscribeUrl: unsubscribeUrl,
    };

    let outcome = await input.provider.send(message);
    let attempts = 1;
    while (!outcome.ok && outcome.retryable && attempts <= SEND_LIMITS.maxRetries) {
      // Bounded backoff. A burst of immediate retries is how a quota is exhausted in one minute.
      await sleep(Math.min(30_000, 1000 * 2 ** attempts));
      outcome = await input.provider.send(message);
      attempts += 1;
    }

    const record = sendRecord({
      recipientId: recipient.id,
      snapshotId: input.snapshot.id,
      attemptedAt: input.now(),
      outcome: outcome.ok ? "sent" : "failed",
      detail: outcome.ok
        ? `Delivered after ${attempts} attempt${attempts === 1 ? "" : "s"}`
        : outcome.detail,
    });
    records.push(record);
    report.records.push(record);
    if (outcome.ok) report.sent += 1;
    else report.failed += 1;
  }

  if (report.suppressed > 0) {
    report.notes.push(
      `${report.suppressed} recipients were suppressed; each has a recorded reason rather than silence.`,
    );
  }

  return report;
}

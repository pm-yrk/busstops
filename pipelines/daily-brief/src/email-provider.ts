/**
 * Email delivery.
 *
 * A deliberately small interface with one honest implementation and one no-op. The product must
 * work with no provider configured at all — Pro, the browser Daily Brief view and every other
 * surface stay fully usable — so "not configured" is a normal state that returns a typed result,
 * not an error that fails the job.
 *
 * No provider is hard-coded, because binding the free tier to one vendor's terms is exactly the
 * dependency the free-tier rules exist to avoid.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** RFC 8058 one-click unsubscribe, so mail clients can offer it natively. */
  listUnsubscribeUrl: string;
}

export type SendOutcome =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; retryable: boolean; detail: string };

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SendOutcome>;
}

/** Used when no provider is configured. Records the intent without pretending to deliver. */
export class NoopEmailProvider implements EmailProvider {
  readonly name = "none";
  async send(): Promise<SendOutcome> {
    return {
      ok: false,
      retryable: false,
      detail: "No email provider is configured, so nothing was sent.",
    };
  }
}

export interface HttpProviderConfig {
  name: string;
  endpoint: string;
  apiKey: string;
  fromAddress: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A generic JSON-over-HTTPS provider. The credential travels in the Authorization header and is
 * never logged, never included in a failure detail, and never written to a send record.
 */
export class HttpEmailProvider implements EmailProvider {
  readonly name: string;

  constructor(private readonly config: HttpProviderConfig) {
    this.name = config.name;
  }

  async send(message: EmailMessage): Promise<SendOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    const fetchImpl = this.config.fetchImpl ?? fetch;

    try {
      const response = await fetchImpl(this.config.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          from: this.config.fromAddress,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: {
            "List-Unsubscribe": `<${message.listUnsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }),
      });

      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { id?: string };
        return { ok: true, providerMessageId: body.id ?? null };
      }

      // The status is reported; the body is not, because a provider error body can echo the
      // request including headers.
      return {
        ok: false,
        retryable: response.status === 429 || response.status >= 500,
        detail: `Provider returned ${response.status}`,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        retryable: true,
        detail: aborted ? "Provider request timed out" : "Provider request failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function providerFromEnv(env: Record<string, string | undefined>): EmailProvider {
  const endpoint = env.EMAIL_PROVIDER_ENDPOINT;
  const apiKey = env.EMAIL_API_KEY;
  const from = env.EMAIL_FROM_ADDRESS;

  if (!endpoint || !apiKey || !from) return new NoopEmailProvider();

  return new HttpEmailProvider({
    name: env.EMAIL_PROVIDER ?? "http",
    endpoint,
    apiKey,
    fromAddress: from,
  });
}

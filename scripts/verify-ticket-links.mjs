/**
 * Check the candidate ticket-seller pages in `data/ticket-sellers.json`, from somewhere with
 * egress to operator websites.
 *
 * This exists because of a split between where the decision is made and where it can be checked.
 * The agent that writes the registry has no outbound route to operator sites — the gateway
 * refuses them — so a ticket URL written from memory would be exactly the unverified link
 * `lib/tickets.ts` refuses to carry. A CI runner can reach them. So the proposals live in the
 * data file, the checking happens here, and the result comes back as an annotation to be written
 * into the file deliberately. Nothing in this script activates anything by itself.
 *
 * A candidate passes only if all four hold:
 *  - the URL is https;
 *  - the response, after redirects, is 200;
 *  - the FINAL hostname is still the seller's own domain (a redirect to a parked domain, a
 *    marketing host or an unrelated group site is a failure, not a pass);
 *  - the page carries a <title>, which is reported so a human can see what was actually served.
 */

import { readFile } from "node:fs/promises";
import { annotate } from "./annotate.mjs";

const SELLERS_PATH = new URL("../data/ticket-sellers.json", import.meta.url);
const TIMEOUT_MS = 20_000;

/** Exact domain or a subdomain of it — never a suffix match, which `notfirstbus.co.uk` passes. */
function isOnDomain(hostname, domain) {
  const host = hostname.toLowerCase();
  const base = domain.toLowerCase();
  return host === base || host.endsWith(`.${base}`);
}

function titleOf(html) {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!match) return null;
  return match[1].replace(/\s+/g, " ").trim().slice(0, 120) || null;
}

async function tryCandidate(url, domain) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    if (!url.startsWith("https://")) return { ok: false, detail: "not https" };
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Several operator sites answer a bare client with a challenge page rather than content.
        "user-agent":
          "Mozilla/5.0 (compatible; BusStopsTicketLinkCheck/1.0; +https://github.com/pm-yrk/busstops)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    const finalUrl = new URL(response.url || url);
    if (response.status !== 200) {
      return { ok: false, detail: `HTTP ${response.status} (landed on ${finalUrl.href})` };
    }
    if (!isOnDomain(finalUrl.hostname, domain)) {
      return { ok: false, detail: `redirected off ${domain} to ${finalUrl.hostname}` };
    }
    const html = (await response.text()).slice(0, 200_000);
    const pageTitle = titleOf(html);
    if (!pageTitle) return { ok: false, detail: `200 but no <title> at ${finalUrl.href}` };
    return { ok: true, url: finalUrl.href, pageTitle };
  } catch (error) {
    return {
      ok: false,
      detail: error?.name === "AbortError" ? "timed out" : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(deadline);
  }
}

async function main() {
  const data = JSON.parse(await readFile(SELLERS_PATH, "utf8"));
  const verifiedAt = new Date().toISOString();
  const verified = [];
  const rejected = [];

  for (const seller of data.sellers) {
    const attempts = [];
    let accepted = null;
    for (const path of seller.candidatePaths) {
      const url = `https://www.${seller.domain}${path}`;
      const result = await tryCandidate(url, seller.domain);
      attempts.push(`${path} → ${result.ok ? `OK ${result.pageTitle}` : result.detail}`);
      if (result.ok) {
        accepted = result;
        break;
      }
      // Some of these sites do not serve the www host at all.
      const bare = `https://${seller.domain}${path}`;
      const bareResult = await tryCandidate(bare, seller.domain);
      attempts.push(
        `${path} (no www) → ${bareResult.ok ? `OK ${bareResult.pageTitle}` : bareResult.detail}`,
      );
      if (bareResult.ok) {
        accepted = bareResult;
        break;
      }
    }
    if (accepted) {
      verified.push({
        domain: seller.domain,
        sellerName: seller.sellerName,
        url: accepted.url,
        pageTitle: accepted.pageTitle,
        verifiedAt,
        evidence: `fetched from a CI runner: 200 on ${seller.domain}, titled "${accepted.pageTitle}"`,
      });
    } else {
      rejected.push({ domain: seller.domain, attempts });
    }
  }

  console.log(`ticket links: ${verified.length} verified, ${rejected.length} rejected`);
  for (const entry of verified)
    console.log(`  ✓ ${entry.sellerName} ${entry.url} — ${entry.pageTitle}`);
  for (const entry of rejected) console.log(`  × ${entry.domain}: ${entry.attempts.join("; ")}`);

  // The whole point: the result has to be readable from outside the runner.
  annotate(
    "notice",
    "ticket links (verified)",
    `${verified.length} of ${data.sellers.length} seller pages answered.\n${JSON.stringify(verified, null, 1)}`,
  );
  annotate(
    "notice",
    "ticket links (rejected)",
    `${rejected.length} did not.\n${rejected.map((r) => `${r.domain}\n  ${r.attempts.join("\n  ")}`).join("\n")}`,
  );
}

await main();

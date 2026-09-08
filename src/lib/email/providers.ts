import "server-only";

import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";

import nodemailer from "nodemailer";

import type { EmailConfig, EmailProviderId } from "./catalog";

/**
 * Email delivery adapters.
 *
 * Both take credentials the *customer* owns — their own mailbox, or their own
 * API key. Nothing shared ships inside the app: a key embedded in a downloaded
 * installer can be extracted by anyone who has the download, and would let them
 * send mail as us.
 *
 * A send returns a result rather than throwing, so the outbox can record what
 * went wrong instead of a queued message disappearing.
 */

/** A file to travel with the message — the invoice itself, in practice. */
export type EmailAttachment = {
  filename: string;
  content: Uint8Array;
  contentType: string;
};

export type OutboundEmail = {
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  replyTo?: string | null;
  attachments?: EmailAttachment[];
};

export type DeliveryResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string };

// ------------------------------------------------------- choosing a route ---

/**
 * Whether this machine can reach the IPv6 internet.
 *
 * Having an IPv6 address is not the same as having a route to one. A great many
 * home routers hand out addresses from the private `fc00::/7` range, or only
 * link-local `fe80::` ones, while carrying no IPv6 traffic at all. A machine
 * like that looks IPv6-capable to anything that merely counts interfaces, and
 * then every connection to a global IPv6 address fails instantly with
 * ENETUNREACH — no route.
 */
export function hasGlobalIpv6(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
) {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv6" && (entry.family as unknown) !== 6) continue;
      if (entry.internal) continue;

      const address = entry.address.toLowerCase();
      if (address.startsWith("fe80")) continue; // link-local
      if (/^f[cd]/.test(address)) continue; // unique local, never routed

      return true;
    }
  }

  return false;
}

/**
 * Which of a mail server's addresses to actually dial.
 *
 * IPv4 unless there is none, because it is the family that works everywhere.
 * IPv6 is used only when this machine genuinely has a route for it.
 */
export function preferredAddress(
  addresses: { address: string; family: number }[],
  globalIpv6: boolean,
) {
  const v4 = addresses.find((entry) => entry.family === 4);
  if (v4) return v4.address;

  const v6 = addresses.find((entry) => entry.family === 6);
  if (v6 && globalIpv6) return v6.address;

  // Nothing usable. Returning null hands the hostname back to the mail library,
  // whose own answer is no worse than a guess made here.
  return null;
}

/**
 * Resolves the mail server ourselves and picks an address we can reach.
 *
 * Nodemailer resolves the hostname and then picks one of the results **at
 * random**, so a server published on both families is a coin flip every send.
 * On a machine with no IPv6 route that is an intermittent, unexplainable
 * failure — and its own retry is skipped entirely when the IPv4 lookup happens
 * to come back empty, which a transient DNS hiccup is enough to cause.
 *
 * `dns.lookup` goes through the operating system's resolver, so it also honours
 * the hosts file and the DNS cache — unlike the direct queries the library
 * makes, which are the part that flakes.
 */
async function reachableHost(host: string) {
  if (net.isIP(host)) return { host, servername: undefined };

  try {
    const found = await dns.lookup(host, { all: true, verbatim: false });
    const address = preferredAddress(found, hasGlobalIpv6());

    // The certificate is issued for the name, not the address, so the name has
    // to travel separately or TLS verification fails.
    if (address) return { host: address, servername: host };
  } catch {
    // Let the mail library do its own resolution and report its own error.
  }

  return { host, servername: undefined };
}

/**
 * A handshake that failed because the two ends disagreed about encryption.
 *
 * One side opened with TLS and the other answered in plaintext, or the reverse.
 * OpenSSL reports it as a malformed record, because from its point of view a
 * plaintext "220 mail.example.com ESMTP" *is* a malformed TLS record.
 *
 * Worth recognising precisely: it happens during the handshake, before any mail
 * is offered to the server, so retrying the other way round cannot deliver
 * anything twice.
 */
function isHandshakeMismatch(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return /wrong version number|packet length too long|record layer/i.test(raw);
}

async function attemptSmtp(
  config: EmailConfig,
  secret: string,
  message: OutboundEmail,
  target: { host: string; servername?: string },
  secure: boolean,
) {
  const transport = nodemailer.createTransport({
    host: target.host,
    // Set only when dialling a literal address, so SNI and certificate
    // checking still see the name the customer typed.
    ...(target.servername ? { servername: target.servername } : {}),
    port: config.port ?? 587,
    secure,
    auth: { user: config.username, pass: secret },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  try {
    const info = await transport.sendMail({
      from: { name: config.fromName, address: config.fromEmail },
      to: message.toName
        ? { name: message.toName, address: message.to }
        : message.to,
      replyTo: message.replyTo ?? undefined,
      subject: message.subject,
      text: message.text,
      attachments: message.attachments?.map((file) => ({
        filename: file.filename,
        content: Buffer.from(file.content),
        contentType: file.contentType,
      })),
    });

    return { ok: true as const, providerMessageId: info.messageId };
  } finally {
    transport.close();
  }
}

async function sendViaSmtp(
  config: EmailConfig,
  secret: string,
  message: OutboundEmail,
): Promise<DeliveryResult> {
  if (!config.host || !config.username) {
    return { ok: false, error: "SMTP host and username are required." };
  }

  const target = await reachableHost(config.host);

  // Port 465 is implicit TLS; 587 and 25 upgrade with STARTTLS.
  const secure = config.secure ?? config.port === 465;

  try {
    return await attemptSmtp(config, secret, message, target, secure);
  } catch (error) {
    // The saved port and encryption setting contradict each other. Rather than
    // handing back an OpenSSL diagnostic and asking a business owner to reason
    // about TLS, try it the only other way it could have meant. Nothing has
    // been sent at this point, so this cannot deliver the same mail twice.
    if (!isHandshakeMismatch(error)) {
      return { ok: false, error: describe(error) };
    }

    try {
      return await attemptSmtp(config, secret, message, target, !secure);
    } catch (retryError) {
      // Still wrong the other way round: report the original, which describes
      // the configuration the customer actually saved.
      return {
        ok: false,
        error: isHandshakeMismatch(retryError)
          ? describe(error)
          : describe(retryError),
      };
    }
  }
}

async function sendViaResend(
  config: EmailConfig,
  secret: string,
  message: OutboundEmail,
): Promise<DeliveryResult> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${config.fromName} <${config.fromEmail}>`,
        to: [message.to],
        reply_to: message.replyTo ?? undefined,
        subject: message.subject,
        text: message.text,
        // Resend takes attachments base64-encoded rather than as raw bytes.
        attachments: message.attachments?.map((file) => ({
          filename: file.filename,
          content: Buffer.from(file.content).toString("base64"),
        })),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const body = (await response.json().catch(() => null)) as
      | { id?: string; message?: string; name?: string }
      | null;

    if (!response.ok) {
      return {
        ok: false,
        error: body?.message ?? `Resend returned ${response.status}.`,
      };
    }

    return { ok: true, providerMessageId: body?.id };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

export function deliverEmail(
  provider: EmailProviderId,
  config: EmailConfig,
  secret: string,
  message: OutboundEmail,
): Promise<DeliveryResult> {
  return provider === "RESEND"
    ? sendViaResend(config, secret, message)
    : sendViaSmtp(config, secret, message);
}

/**
 * Turns provider errors into something a business owner can act on. The raw
 * text from a mail server is written for postmasters, not customers.
 */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (/invalid login|535|authentication failed|auth/i.test(raw)) {
    return "The email server rejected that username and password. Gmail and Outlook need an app password, not your normal one.";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return "Could not find that mail server. Check the host name.";
  }
  if (/ENETUNREACH|EHOSTUNREACH/i.test(raw)) {
    // Almost always an IPv6 address on a network that carries no IPv6. The
    // sender now picks the address itself to avoid this, so reaching here means
    // the server really is unreachable — say so, rather than showing somebody a
    // raw address and a socket error code.
    return "This computer has no route to that mail server. If it is on a company or guest network, outgoing mail is often blocked — try another connection.";
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(raw)) {
    return "Could not reach the mail server. Check the port, or whether a firewall is blocking it.";
  }
  if (/wrong version number|packet length too long|record layer/i.test(raw)) {
    // The client opened with a TLS handshake and got a plaintext SMTP greeting
    // back, or the reverse. Always the port and the encryption box disagreeing.
    return "The port and the encryption setting do not match. Port 465 needs “Use SSL/TLS from the start” ticked; ports 587 and 25 need it unticked.";
  }
  if (/self.signed|certificate/i.test(raw)) {
    return "The mail server's security certificate could not be verified.";
  }
  if (/domain is not verified|not verified/i.test(raw)) {
    return "That sending domain is not verified with Resend yet.";
  }

  return raw.slice(0, 300);
}

export * from "./catalog";

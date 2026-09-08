/**
 * Email provider choices, shared by the settings screen and the server-side
 * senders.
 *
 * Deliberately free of `server-only` and of nodemailer: the connect form is a
 * client component and needs these labels, while the delivery code in
 * ./providers stays on the server. Same split as storage-limits vs storage.
 */

export const EMAIL_PROVIDERS = ["SMTP", "RESEND"] as const;
export type EmailProviderId = (typeof EMAIL_PROVIDERS)[number];

export function isEmailProvider(value: unknown): value is EmailProviderId {
  return (
    typeof value === "string" &&
    (EMAIL_PROVIDERS as readonly string[]).includes(value)
  );
}

export const EMAIL_PROVIDER_META: Record<
  EmailProviderId,
  { label: string; description: string; secretLabel: string; secretHint: string }
> = {
  SMTP: {
    label: "Your email account",
    description:
      "Send through the mailbox you already use, so replies land in your normal inbox. Works with Gmail, Outlook, or your web host.",
    secretLabel: "Password",
    // Deliberately not naming a provider: the note under this field is chosen
    // from the preset above and says exactly what that one needs. Two pieces of
    // advice on one field, one of them about somebody else's mail service, is
    // how people end up pasting the wrong thing.
    secretHint: "Almost no provider still accepts the password you sign in with.",
  },
  RESEND: {
    label: "Resend",
    description:
      "A dedicated sending service. Better deliverability for larger volumes, and needs a domain you have verified with Resend.",
    secretLabel: "API key",
    secretHint: "Starts with re_. Create one in the Resend dashboard.",
  },
};

/**
 * Presets so a user picks their provider instead of hunting for a host name.
 *
 * `credential` matters as much as the host. Every one of these refused a plain
 * account password years ago, and each calls its replacement something
 * different — an app password, an app-specific password, a secure mail key.
 * Someone typing the password they sign in with, and being told only
 * "authentication failed", is the single commonest way this screen goes wrong.
 */
export const SMTP_PRESETS = [
  {
    id: "gmail",
    label: "Gmail / Google Workspace",
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    credential:
      "Not your Gmail password — Google refuses those. Turn on 2-Step Verification, then create an App password at myaccount.google.com/apppasswords and paste the 16 characters here.",
  },
  {
    id: "outlook",
    label: "Outlook / Microsoft 365",
    host: "smtp-mail.outlook.com",
    port: 587,
    secure: false,
    credential:
      "Needs an app password from your Microsoft account security page, and a work or school account may have SMTP switched off by an administrator.",
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    host: "smtp.mail.yahoo.com",
    port: 465,
    secure: true,
    credential:
      "Generate an app password under Yahoo Account Security. Your normal password will be refused.",
  },
  {
    id: "hostinger",
    label: "Hostinger",
    host: "smtp.hostinger.com",
    port: 465,
    secure: true,
    credential:
      "The password for the mailbox itself, set in hPanel under Emails — not the password you sign in to Hostinger with. Reset it there if you no longer have it. Unlike the big providers, this is a real password rather than a generated key.",
  },
  {
    id: "att",
    label: "AT&T / Bellsouth / SBCGlobal",
    host: "outbound.att.net",
    port: 465,
    secure: true,
    credential:
      "AT&T calls it a secure mail key, not a password. Create one under Profile → Sign-in info → Manage secure mail key at att.com, and use it here.",
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    host: "smtp.mail.me.com",
    port: 587,
    secure: false,
    credential:
      "Needs an app-specific password from account.apple.com, and the username is usually your @icloud.com address even if you send from a custom domain.",
  },
  {
    id: "custom",
    label: "Other / my web host",
    host: "",
    port: 587,
    secure: false,
    credential:
      "Your host's control panel lists the outgoing server, port and username under email or SMTP settings.",
  },
] as const;

/**
 * Whether a port expects TLS from the first byte.
 *
 * 465 is implicit TLS: the handshake starts immediately. 587 and 25 are
 * plaintext that upgrade with STARTTLS once connected. Getting the pair the
 * wrong way round does not fail politely — the client sends a TLS hello, the
 * server answers with a plaintext greeting, and OpenSSL reports "wrong version
 * number", which tells an ordinary person nothing at all.
 */
export function impliedSecure(port: number) {
  return port === 465;
}

/**
 * The encryption setting to show for a saved port.
 *
 * Only the three ports whose behaviour is not in question are corrected. An
 * unusual port is left exactly as the customer set it, because a server on
 * 2525 really might want implicit TLS and this has no business overruling it.
 */
export function reconcileSecure(port: number, secure: boolean) {
  if (port === 465 || port === 587 || port === 25) return impliedSecure(port);
  return secure;
}

export type SmtpPresetId = (typeof SMTP_PRESETS)[number]["id"];

/** The preset a saved host came from, so the form reopens on the right one. */
export function presetForHost(host: string): SmtpPresetId {
  const match = SMTP_PRESETS.find(
    (preset) => preset.host && preset.host === host.trim().toLowerCase(),
  );
  return match?.id ?? "custom";
}

export type EmailConfig = {
  fromName: string;
  fromEmail: string;
  /** SMTP only. */
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
};

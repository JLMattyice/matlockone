import Link from "next/link";

import { LEGAL_EMAIL, LEGAL_NAME, LEGAL_PAGES, LEGAL_UPDATED } from "@/lib/legal";

/**
 * The frame the Terms, Privacy Policy and Refund Policy share: a title, the
 * date it last changed, a plain-English summary up top, then the full text.
 *
 * The summary is there because almost nobody reads the rest. It is held to
 * the same standard as the full text — nothing in it may promise more or less
 * than the sections below.
 */
export function LegalPage({
  title,
  path,
  summary,
  children,
}: {
  title: string;
  path: (typeof LEGAL_PAGES)[number]["href"];
  summary: React.ReactNode[];
  children: React.ReactNode;
}) {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-14 lg:px-8 lg:py-20">
      <p className="text-[11px] font-medium tracking-[0.18em] text-gold uppercase">Legal</p>
      <h1 className="display mt-3 text-4xl text-ink sm:text-5xl">{title}</h1>
      <p className="mt-4 text-sm text-ink-subtle">
        Last updated {LEGAL_UPDATED} · {LEGAL_NAME}
      </p>

      <nav aria-label="Legal documents" className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {LEGAL_PAGES.map((page) =>
          page.href === path ? (
            <span key={page.href} aria-current="page" className="font-medium text-ink">
              {page.label}
            </span>
          ) : (
            <Link key={page.href} href={page.href} className="text-ink-muted hover:text-ink">
              {page.label}
            </Link>
          ),
        )}
      </nav>

      <section
        aria-label="The short version"
        className="mt-10 rounded-card border border-line bg-surface-2 px-5 py-5 sm:px-6"
      >
        <h2 className="text-sm font-medium text-ink">The short version</h2>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">
          {summary.map((line, index) => (
            <li key={index} className="flex gap-2.5">
              <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-gold" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-12 space-y-10">{children}</div>

      <p className="mt-14 border-t border-line pt-6 text-sm text-ink-muted">
        Questions about this page? Write to{" "}
        <a href={`mailto:${LEGAL_EMAIL}`} className="text-ink underline-offset-4 hover:underline">
          {LEGAL_EMAIL}
        </a>
        .
      </p>
    </article>
  );
}

/** One numbered part of a legal page, linkable by its id. */
export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="display text-2xl text-ink">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink-muted [&_a]:text-ink [&_a]:underline-offset-4 [&_a:hover]:underline [&_strong]:font-medium [&_strong]:text-ink">
        {children}
      </div>
    </section>
  );
}

/** A bulleted list inside a section. */
export function LegalList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2 pl-1">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2.5">
          <span aria-hidden className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

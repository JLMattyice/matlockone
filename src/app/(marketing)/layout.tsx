import Link from "next/link";
import { Inter, Playfair_Display } from "next/font/google";
import { ArrowRight } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import { getContext } from "@/lib/auth";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  weight: ["500", "600"],
  display: "swap",
});

/**
 * The direction contract, emitted into the built markup so it can be audited
 * after a production build rather than only read in source.
 */
const DIRECTION_CONTRACT = `
IMPECCABLE DIRECTION CONTRACT — Matlock One

THESIS: An operating system for a business, presented like one. The product
itself is the hero image, lit on near-black, and the page's job is to make a
$59/month tool feel like infrastructure. It refuses the bright, friendly,
illustration-led small-business SaaS page.

OWN-WORLD: Matlock Software's own colors, re-cast for a product. Green-black
grounds (#080A09, #101512), the studio's forest green (#0F3D2E) as glow and
tinted panel, its gold (#C9A55B) as the page's rarest ink, cream (#F5F1E8) as
type. Playfair Display carries the display voice; Inter carries the interface.
Hairline rules, no illustration, no gradient text.

STORY: An owner running six disconnected apps sees one workspace where the
customer, the job and the money are the same record. Believes it is real
software, because they are looking at it. Starts free.

FIRST VIEWPORT: Headline left and large in Playfair; sub and two actions
beneath; the real dashboard entering from below the fold on a forest glow,
cropped by the viewport so it reads as continuing rather than ending.

FORM: User-pinned direction — dark product-site brief with named references,
supplied over the surface roll; palette sampled live from matlocksoftware.com.

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance.
`;

const NAV = [
  { href: "#platform", label: "Platform" },
  { href: "#product", label: "Product" },
  { href: "#industries", label: "Solutions" },
  { href: "#pricing", label: "Pricing" },
  { href: "#download", label: "Download" },
];

export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getContext();

  return (
    <div
      className={`matlock-one min-h-screen ${inter.variable} ${playfair.variable}`}
    >
      <div hidden dangerouslySetInnerHTML={{ __html: `<!--${DIRECTION_CONTRACT}-->` }} />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-ink"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-4 py-4 lg:px-8">
          <Link href="/" className="flex shrink-0 items-baseline gap-2">
            <span className="display text-lg text-ink">Matlock</span>
            <span className="text-[11px] font-medium tracking-[0.18em] text-gold uppercase">
              One
            </span>
          </Link>

          <nav
            aria-label="Sections"
            className="ml-4 hidden items-center gap-7 md:flex"
          >
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-sm text-ink-muted transition-colors hover:text-ink"
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <Link
              href={ctx ? "/dashboard" : "/login"}
              className="hidden text-sm text-ink-muted transition-colors hover:text-ink sm:block"
            >
              {ctx ? "Dashboard" : "Log in"}
            </Link>
            <a href="#download" className={buttonClasses("primary", "sm")}>
              Download
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </a>
          </div>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="border-t border-line">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 lg:px-8">
          <div className="flex flex-col gap-8 sm:flex-row sm:justify-between">
            <div className="max-w-xs">
              <div className="flex items-baseline gap-2">
                <span className="display text-lg text-ink">Matlock</span>
                <span className="text-[11px] font-medium tracking-[0.18em] text-gold uppercase">
                  One
                </span>
              </div>
              <p className="mt-3 text-sm text-ink-muted">
                Customers, projects, scheduling, money and the day-to-day, in
                one workspace.
              </p>
            </div>

            <nav aria-label="Footer" className="flex gap-12 text-sm">
              <div>
                <p className="font-medium text-ink">Product</p>
                <ul className="mt-3 space-y-2 text-ink-muted">
                  {NAV.map((item) => (
                    <li key={item.href}>
                      <a href={item.href} className="hover:text-ink">
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-medium text-ink">Get started</p>
                <ul className="mt-3 space-y-2 text-ink-muted">
                  <li>
                    <a href="#download" className="hover:text-ink">
                      Download
                    </a>
                  </li>
                  <li>
                    <Link href="/login" className="hover:text-ink">
                      Try the demo
                    </Link>
                  </li>
                </ul>
              </div>
            </nav>
          </div>

          <p className="mt-10 border-t border-line pt-6 text-xs text-ink-subtle">
            © {new Date().getFullYear()} Matlock One. Built by Matlock Software
            Development, Lenoir City, TN.
          </p>
        </div>
      </footer>
    </div>
  );
}

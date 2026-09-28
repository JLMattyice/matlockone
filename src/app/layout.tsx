import type { Metadata, Viewport } from "next";

import { ServiceWorker } from "@/components/app-shell/service-worker";
import { ThemeScript } from "@/components/app-shell/theme-script";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Matlock One",
    template: "%s · Matlock One",
  },
  description:
    "Customers, jobs, scheduling, quoting, invoicing and payments in one workspace.",
  applicationName: "Matlock One",
  // Added to an iPhone's home screen, it opens full screen under this name.
  // The manifest (app/manifest.ts) says the same to Android. The icons are
  // app/icon.png and app/apple-icon.png, which Next links by themselves —
  // naming one here as well would drop the others.
  appleWebApp: { capable: true, title: "Matlock One", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1120" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen antialiased">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}

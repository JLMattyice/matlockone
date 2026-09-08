import type { Metadata, Viewport } from "next";

import { ThemeScript } from "@/components/app-shell/theme-script";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Matlock One",
    template: "%s · Matlock One",
  },
  description:
    "Field service management: clients, leads, scheduling, estimates, invoicing and payments.",
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
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

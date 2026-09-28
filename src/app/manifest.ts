import type { MetadataRoute } from "next";

/**
 * What a phone reads when somebody adds Matlock One to its home screen: the
 * name under the icon, the icons, and that it opens on its own, full screen,
 * rather than as a browser tab.
 *
 * It opens on the dashboard. Signed out, that is the sign-in screen, which
 * then sends them back to the dashboard — the same as typing the address.
 *
 * The icons come from scripts/make-icon.mjs (`npm run icons`): rounded for
 * Android's ordinary icon, full bleed for the "maskable" one, which the phone
 * crops to its own shape.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/dashboard",
    name: "Matlock One",
    short_name: "Matlock One",
    description: "Customers, jobs, scheduling, quoting, invoicing and payments in one workspace.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

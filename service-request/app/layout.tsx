import type { Metadata } from "next";
import "./globals.css";

// System fonts keep builds and page rendering independent of Google Fonts.
export const metadata: Metadata = {
  title: "TanMar Receiver Control — Service Request",
  description: "Submit a receiver activation or refresh request with your contact and GPS information.",
  // Historical label queries may contain private snapshots; never send them as
  // referrers. Location is a client claim, so avoid promising GPS verification.
  referrer: "no-referrer",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/tanmar-emblem-tight.png",
    shortcut: "/tanmar-emblem-tight.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

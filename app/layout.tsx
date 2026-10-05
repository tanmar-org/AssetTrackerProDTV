import type { Metadata } from "next";
import "./globals.css";

// System fonts keep builds and page rendering independent of Google Fonts.
export const metadata: Metadata = {
  title: "TanMar Receiver Control",
  description: "TanMar DirecTV receiver and account management.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/asset-tracker/tanmar-emblem-tight.png?v=33",
    shortcut: "/asset-tracker/tanmar-emblem-tight.png?v=33",
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

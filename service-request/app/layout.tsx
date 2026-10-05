import type { Metadata } from "next";
import "./globals.css";

// System fonts keep builds and page rendering independent of Google Fonts.
export const metadata: Metadata = {
  title: "TanMar Receiver Control — Service Request",
  description: "Submit a GPS-verified receiver activation or refresh request.",
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

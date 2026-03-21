import "./globals.css";
import type { Metadata } from "next";
import { ReactNode } from "react";
import { Sora } from "next/font/google";

const sora = Sora({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mitra AI",
  description: "Multi-agent Intent Translator & Retail Assistant"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={sora.className}>{children}</body>
    </html>
  );
}

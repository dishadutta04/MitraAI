import "./globals.css";
import type { Metadata } from "next";
import { ReactNode } from "react";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import Splash from "../components/Splash";

// Mac's San Francisco is used where installed (macOS / iOS); Inter is the closest match elsewhere.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Mitra AI",
  description: "Multi-agent Intent Translator & Retail Assistant"
};

// Apply the saved theme before first paint, so nothing (splash included) flashes light in dark mode.
const themeScript = `try{if(localStorage.getItem("mitra-theme")==="dark")document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">
      <html lang="en" suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        </head>
        <body className={`${inter.variable} font-sans`}>
          <Splash />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}

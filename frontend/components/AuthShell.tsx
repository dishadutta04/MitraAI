"use client";

import { SignIn, SignUp } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { LogoMark, Wordmark } from "./Logo";

const MAC_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", var(--font-sans), system-ui, sans-serif';

/** Clerk's sign-in / sign-up form inside the same frosted Mac window as the app. */
export default function AuthShell({ mode }: { mode: "sign-in" | "sign-up" }) {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);

  const appearance = {
    variables: {
      colorPrimary: dark ? "#f5f5f7" : "#1d1d1f",
      colorTextOnPrimaryBackground: dark ? "#1d1d1f" : "#ffffff",
      colorBackground: dark ? "#2e2d2b" : "#ffffff",
      colorText: dark ? "#f5f5f7" : "#1d1d1f",
      colorTextSecondary: dark ? "#a1a1a6" : "#6e6e73",
      colorInputBackground: dark ? "#383734" : "#f5f4f1",
      colorInputText: dark ? "#f5f5f7" : "#1d1d1f",
      colorDanger: "#e5484d",
      fontFamily: MAC_FONT,
      fontSize: "15px",
      borderRadius: "10px",
    },
    elements: {
      rootBox: "w-full",
      cardBox: "w-full !shadow-none",
      card: "!shadow-none !border-0",
      formButtonPrimary: "!text-[15px] !font-semibold !py-2.5",
      formFieldInput: "!text-[16px] !py-2.5",
    },
  };

  return (
    <main className="desk flex min-h-screen items-center justify-center p-4 text-[var(--fg)]">
      <div className="mac-window w-full max-w-[920px] overflow-hidden rounded-[14px]">
        <header className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          <span className="flex flex-1 items-center justify-center gap-1.5 text-[13px] font-medium text-[var(--fg-2)]">
            <LogoMark size={16} />
            Mitra AI
          </span>
          <span className="w-[52px]" />
        </header>
        <div className="grid md:grid-cols-[1fr_1.1fr]">
          <section className="mac-sidebar hidden flex-col justify-between p-8 md:flex">
            <div>
              <Wordmark size={36} tagline />
              <h1 className="mt-6 font-display text-[30px] font-semibold leading-tight tracking-tight">
                {mode === "sign-in" ? "Welcome back" : "Namaste! Let's get you set up"}
              </h1>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-2)]">
                Order groceries by speaking in Hindi, English or Hinglish. Mitra checks every order against your health profile and
                asks before buying anything.
              </p>
            </div>
            <ul className="mt-8 space-y-3 text-[14px]">
              {[
                ["mic", "Speak your order, no typing needed"],
                ["shield", "Health checks for diabetes, BP and more"],
                ["check", "Nothing is bought until you confirm"],
              ].map(([icon, text]) => (
                <li key={text} className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--card)] shadow-[var(--shadow-card)]">
                    <Icon name={icon as "mic"} size={15} />
                  </span>
                  {text}
                </li>
              ))}
            </ul>
          </section>
          <section className="flex items-center justify-center p-4 sm:p-8">
            {mode === "sign-in" ? (
              <SignIn appearance={appearance} signUpUrl="/sign-up" fallbackRedirectUrl="/" />
            ) : (
              <SignUp appearance={appearance} signInUrl="/sign-in" fallbackRedirectUrl="/" />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import { LogoMark } from "./Logo";

const SHOW_MS = 2400;
const FADE_MS = 450;
const COLS = 30;
const ROWS = 20;

/**
 * Opening screen on every page load (refresh included), after the brand reference (logo.jpg):
 * soft tiles sweep in from white to pink, the pixel M builds square by square, then the name and
 * side note appear. Click or press a key to skip. Moving between pages inside the app doesn't
 * replay it, since the root layout stays mounted.
 */
export default function Splash() {
  const [phase, setPhase] = useState<"show" | "leaving" | "gone">("show");

  useEffect(() => {
    const leave = () => setPhase((p) => (p === "show" ? "leaving" : p));
    const timer = setTimeout(leave, SHOW_MS);
    window.addEventListener("keydown", leave);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", leave);
    };
  }, []);

  useEffect(() => {
    if (phase !== "leaving") return;
    const timer = setTimeout(() => setPhase("gone"), FADE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "gone") return null;

  return (
    <div
      className={`mitra-splash splash-bg fixed inset-0 z-[100] flex cursor-default items-center justify-center overflow-hidden ${
        phase === "leaving" ? "splash-out" : ""
      }`}
      onClick={() => setPhase("leaving")}
      aria-hidden="true"
    >
      <div className="splash-tiles absolute left-0 top-0" style={{ gridTemplateColumns: `repeat(${COLS}, 64px)` }}>
        {Array.from({ length: COLS * ROWS }, (_, i) => (
          <span key={i} className="splash-tile" style={{ animationDelay: `${((i % COLS) + Math.floor(i / COLS)) * 28}ms` }} />
        ))}
      </div>

      <div className="relative flex items-center gap-5 text-[var(--splash-ink)] sm:gap-7">
        <LogoMark size={88} animated />
        <span className="splash-rise font-display text-[64px] font-medium leading-none tracking-tight sm:text-[96px]" style={{ animationDelay: "0.55s" }}>
          Mitra
        </span>
        <span className="splash-rise hidden self-start pt-2 text-[15px] leading-tight sm:block" style={{ animationDelay: "0.8s" }}>
          ©
          <br />
          AI grocery
          <br />
          assistant
        </span>
      </div>
      <p className="splash-rise absolute bottom-10 text-[14px] text-[var(--splash-ink)] opacity-70" style={{ animationDelay: "1s" }}>
        बोलिए, मित्र सुन रहा है · Speak, Mitra is listening
      </p>
    </div>
  );
}

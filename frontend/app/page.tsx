"use client";

import { RedirectToSignIn, useAuth, useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import MitraDemo from "../components/MitraDemo";
import Onboarding from "../components/Onboarding";
import { LogoMark } from "../components/Logo";
import { EMPTY_PROFILE, apiFetch, type Profile } from "../lib/profile";

type Gate =
  | { kind: "loading" }
  | { kind: "onboarding"; profile: Profile }
  | { kind: "ready"; profile: Profile }
  | { kind: "error"; message: string };

/** Signed in (middleware guarantees it) → finish onboarding once → the assistant. */
export default function HomePage() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [gate, setGate] = useState<Gate>({ kind: "loading" });
  // Read through refs so Clerk refreshing these objects doesn't reload the page mid-onboarding.
  const userRef = useRef(user);
  userRef.current = user;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const started = useRef(false);

  const load = useCallback(async () => {
    setGate({ kind: "loading" });
    try {
      const res = await apiFetch(() => getTokenRef.current(), "/api/v1/profile/me");
      const user = userRef.current;
      if (res.status === 404) {
        // First visit: start from what Clerk already knows.
        setGate({
          kind: "onboarding",
          profile: {
            ...EMPTY_PROFILE,
            name: user?.fullName ?? "",
            phone: user?.primaryPhoneNumber?.phoneNumber ?? "",
            email: user?.primaryEmailAddress?.emailAddress ?? "",
          },
        });
        return;
      }
      if (!res.ok) {
        const detail = ((await res.json().catch(() => ({}))) as { detail?: string }).detail;
        setGate({ kind: "error", message: detail ?? `Server error (${res.status})` });
        return;
      }
      const profile = (await res.json()) as Profile;
      setGate(profile.onboarding_completed ? { kind: "ready", profile } : { kind: "onboarding", profile });
    } catch {
      setGate({ kind: "error", message: "Couldn't reach Mitra's server. Is the backend running?" });
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || started.current) return;
    started.current = true;
    void load();
  }, [isLoaded, isSignedIn, load]);

  // The middleware already redirects signed-out visitors; this covers a session ending in the tab.
  if (isLoaded && !isSignedIn) return <RedirectToSignIn />;

  if (gate.kind === "onboarding") {
    return <Onboarding mode="setup" initial={gate.profile} onSaved={(p) => p.onboarding_completed && setGate({ kind: "ready", profile: p })} />;
  }
  if (gate.kind === "ready") {
    return <MitraDemo profile={gate.profile} onProfileSaved={(p) => setGate({ kind: "ready", profile: p })} />;
  }
  return (
    <main className="desk flex min-h-screen items-center justify-center p-4 text-[var(--fg)]">
      <div className="mac-card max-w-sm p-6 text-center">
        <LogoMark size={48} animated={gate.kind === "loading"} className="mx-auto" />
        {gate.kind === "loading" ? (
          <p className="mt-4 text-[15px] text-[var(--fg-2)]">Loading your profile…</p>
        ) : (
          <>
            <p className="mt-4 text-[15px] font-semibold">Something went wrong</p>
            <p className="mt-1 text-[13px] text-[var(--fg-2)]">{gate.message}</p>
            <button className="mac-btn-primary mt-4 w-full py-2.5 text-[14px]" onClick={() => void load()}>
              Try again
            </button>
          </>
        )}
      </div>
    </main>
  );
}

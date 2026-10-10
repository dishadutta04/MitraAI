"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Wordmark } from "./Logo";
import { useVoiceInput } from "../lib/use-voice-input";
import { toRoman } from "../lib/transliterate";
import {
  ALLERGY_SUGGESTIONS,
  API_BASE,
  CONDITIONS,
  MEDICATION_SUGGESTIONS,
  PAYMENT_HINT,
  PAYMENT_LABEL,
  apiFetch,
  fetchOnlinePaymentEnabled,
  paymentMethods,
  speak,
  type PaymentMethod,
  type Profile,
  type Store,
} from "../lib/profile";

type StepId = "language" | "profile" | "health" | "family" | "voice";
const STEPS: { id: StepId; title: string; subtitle: string; icon: IconName }[] = [
  { id: "language", title: "Language", subtitle: "How Mitra talks to you", icon: "globe" },
  { id: "profile", title: "Your details", subtitle: "Name, address, payment", icon: "user" },
  { id: "health", title: "Health", subtitle: "Conditions and medicines", icon: "shield" },
  { id: "family", title: "Family & alerts", subtitle: "Who hears about each order", icon: "users" },
  { id: "voice", title: "Voice", subtitle: "Mic and read-aloud", icon: "mic" },
];

const LANGUAGES: { value: Profile["language"]; label: string; sample: string }[] = [
  { value: "hinglish", label: "Hinglish", sample: "Jaldi 2 packet oats mangao" },
  { value: "hindi", label: "हिंदी", sample: "जल्दी दो पैकेट ओट्स मंगाओ" },
  { value: "english", label: "English", sample: "Order 2 packets of oats quickly" },
];

const READ_ALOUD_SAMPLE: Record<Profile["voice"]["voice_language"], string> = {
  "en-IN": "Hello! I'm Mitra. Your order is ready for you to check.",
  "hi-IN": "नमस्ते! मैं मित्रा हूँ। आपका ऑर्डर तैयार है।",
};

type Props = {
  initial: Profile;
  /** "setup": first run, steps unlock in order. "edit": the Profile page, any step, save anytime. */
  mode: "setup" | "edit";
  onSaved: (profile: Profile) => void;
};

export default function Onboarding({ initial, mode, onSaved }: Props) {
  const { getToken } = useAuth();
  const [draft, setDraft] = useState<Profile>(initial);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(mode === "edit" ? STEPS.length - 1 : 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [onlineEnabled, setOnlineEnabled] = useState(false);

  useEffect(() => {
    void fetchOnlinePaymentEnabled(getToken).then(setOnlineEnabled);
    // Once is enough: the server's payment setup doesn't change while this page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSavedNote("");
  };

  const looksLikeEmail = (e: string) => !e.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const detailsProblem = !draft.name.trim()
    ? "Please enter your name."
    : !(draft.age >= 1 && draft.age <= 120)
      ? "Please enter an age between 1 and 120."
      : !isMobileNumber(draft.phone)
        ? "Please enter your 10-digit mobile number."
        : !looksLikeEmail(draft.email)
        ? "Please check your email address."
        : "";
  const familyProblem = draft.family_contacts.some((c) => !c.name.trim())
    ? "Each family member needs a name (or remove the row)."
    : draft.family_contacts.some((c) => !looksLikeEmail(c.email))
      ? "Please check the family members' email addresses."
      : "";
  const stepProblem = STEPS[step]!.id === "profile" ? detailsProblem : STEPS[step]!.id === "family" ? familyProblem : "";

  function goTo(index: number) {
    if (index > reached && mode === "setup") return;
    setError("");
    setStep(index);
  }

  async function save(complete: boolean) {
    const problem = detailsProblem || familyProblem;
    if (problem) {
      setError(problem);
      setStep(detailsProblem ? 1 : 3);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body: Profile = { ...draft, onboarding_completed: complete || draft.onboarding_completed };
      const res = await apiFetch(getToken, "/api/v1/profile/me", { method: "PUT", body: JSON.stringify(body) });
      if (!res.ok) {
        setError(res.status === 401 ? "Your session has expired. Please sign in again." : "Couldn't save your profile. Please try again.");
        return;
      }
      const saved = (await res.json()) as Profile;
      setDraft(saved);
      setSavedNote("Saved");
      onSaved(saved);
    } catch {
      setError("Couldn't reach Mitra's server. Please check it's running and try again.");
    } finally {
      setSaving(false);
    }
  }

  function next() {
    if (stepProblem) {
      setError(stepProblem);
      return;
    }
    setError("");
    if (step === STEPS.length - 1) {
      void save(true);
      return;
    }
    const n = step + 1;
    setStep(n);
    setReached((r) => Math.max(r, n));
  }

  const current = STEPS[step]!;
  const body = (
    <>
      {current.id === "language" && <LanguageStep draft={draft} setDraft={setDraft} />}
      {current.id === "profile" && <DetailsStep draft={draft} set={set} onlineEnabled={onlineEnabled} />}
      {current.id === "health" && <HealthStep draft={draft} set={set} />}
      {current.id === "family" && <FamilyStep draft={draft} set={set} />}
      {current.id === "voice" && <VoiceStep draft={draft} set={set} getToken={getToken} />}
    </>
  );

  const footer = (
    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] px-5 py-3">
      {error && <p className="mr-auto text-[13px] text-[var(--bad)]">{error}</p>}
      {!error && savedNote && <p className="mr-auto flex items-center gap-1 text-[13px] text-[var(--ok)]"><Icon name="check" size={14} />{savedNote}</p>}
      <span className="ml-auto" />
      {step > 0 && (
        <button className="mac-btn-outline px-4 py-2.5 text-[14px]" onClick={() => goTo(step - 1)} disabled={saving}>
          Back
        </button>
      )}
      {mode === "edit" ? (
        <button className="mac-btn-primary px-5 py-2.5 text-[14px]" onClick={() => void save(false)} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      ) : (
        <button className="mac-btn-primary px-5 py-2.5 text-[14px]" onClick={next} disabled={saving}>
          {step === STEPS.length - 1 ? (saving ? "Saving…" : "Finish & start ordering") : "Continue"}
        </button>
      )}
    </div>
  );

  const stepList = (
    <ol className="space-y-1">
      {STEPS.map((s, i) => {
        const locked = mode === "setup" && i > reached;
        const done = mode === "setup" && i < reached && i !== step;
        return (
          <li key={s.id}>
            <button
              className="mac-nav !items-start !py-2"
              aria-current={i === step ? "page" : undefined}
              onClick={() => goTo(i)}
              disabled={locked}
              style={locked ? { opacity: 0.45, cursor: "default" } : undefined}
            >
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  done ? "bg-[var(--ok)] text-white" : i === step ? "bg-[var(--primary)] text-[var(--primary-fg)]" : "bg-[var(--card)] text-[var(--fg-2)]"
                }`}
              >
                {done ? <Icon name="check" size={12} /> : <Icon name={s.icon} size={12} />}
              </span>
              <span className="min-w-0">
                <span className="block text-[14px]">{s.title}</span>
                <span className="block text-[12px] font-normal text-[var(--fg-2)]">{s.subtitle}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );

  if (mode === "edit") {
    return (
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <nav className="mac-card h-fit p-2">{stepList}</nav>
        <section className="mac-card overflow-hidden">
          <div className="p-5">
            <StepHeading index={step} />
            {body}
          </div>
          {footer}
        </section>
      </div>
    );
  }

  return (
    <main className="desk min-h-screen text-[var(--fg)] md:p-6">
      <div className="mac-window mx-auto flex min-h-screen max-w-[1100px] overflow-hidden md:min-h-[calc(100vh-48px)] md:rounded-[14px]">
        <aside className="mac-sidebar hidden w-[260px] shrink-0 flex-col p-3 md:flex">
          <div className="mb-4 flex gap-2 px-1 pt-1" aria-hidden="true">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          </div>
          <Wordmark size={24} className="mb-5 px-2" />
          <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-3)]">Set up Mitra</p>
          {stepList}
          <p className="mt-auto px-2 text-[12px] leading-snug text-[var(--fg-3)]">You can change any of this later from Profile.</p>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-3">
            <span className="text-[13px] text-[var(--fg-2)]">
              Step {step + 1} of {STEPS.length}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--card-soft)]">
              <div className="h-full rounded-full bg-[var(--fg)] transition-all duration-500" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
            </div>
          </header>
          <div className="scroll-quiet flex-1 overflow-y-auto p-5 md:p-8">
            <div className="mx-auto max-w-[620px]">
              <StepHeading index={step} />
              {body}
            </div>
          </div>
          {footer}
        </section>
      </div>
    </main>
  );
}

function StepHeading({ index }: { index: number }) {
  const s = STEPS[index]!;
  return (
    <div className="mb-5">
      <h1 className="font-display text-[26px] font-semibold leading-tight tracking-tight">{s.title}</h1>
      <p className="mt-1 text-[14px] text-[var(--fg-2)]">{s.subtitle}</p>
    </div>
  );
}

/** Indian mobile (10 digits starting 6-9, optionally with 0 / 91 / +91 in front) or a +country number. */
function isMobileNumber(raw: string): boolean {
  const v = raw.replace(/[\s()-]/g, "");
  return /^(\+91|91|0)?[6-9]\d{9}$/.test(v) || /^\+(?!91)\d{8,15}$/.test(v);
}

// ---------- Building blocks ----------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mac-label">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-[12px] text-[var(--fg-3)]">{hint}</span>}
    </label>
  );
}

function ChoiceCard({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`w-full rounded-xl border p-3.5 text-left transition ${
        selected ? "border-[var(--fg)] bg-[var(--card)] shadow-[var(--shadow-card)]" : "border-[var(--line-strong)] bg-[var(--card-soft)] hover:bg-[var(--hover)]"
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? "bg-[var(--ok)]" : "bg-[var(--line-strong)]"}`}
    >
      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

/** Free-text list (medicines, allergies): type and press Enter, or tap a suggestion. */
function TagInput({ values, onChange, suggestions, placeholder }: { values: string[]; onChange: (v: string[]) => void; suggestions: string[]; placeholder: string }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (v && !values.includes(v)) onChange([...values, v]);
    setText("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span key={v} className="flex items-center gap-1 rounded-full bg-[var(--primary)] py-1 pl-3 pr-1.5 text-[13px] capitalize text-[var(--primary-fg)]">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="rounded-full p-0.5 hover:opacity-70">
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
      </div>
      <input
        className="mac-input mt-2 px-3 py-2.5 text-[16px]"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(text);
          }
        }}
        onBlur={() => text.trim() && add(text)}
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {suggestions
          .filter((s) => !values.includes(s))
          .map((s) => (
            <button key={s} type="button" className="mac-chip capitalize" onClick={() => add(s)}>
              + {s}
            </button>
          ))}
      </div>
    </div>
  );
}

type SetField = <K extends keyof Profile>(key: K, value: Profile[K]) => void;

// ---------- Steps ----------

function LanguageStep({ draft, setDraft }: { draft: Profile; setDraft: (fn: (d: Profile) => Profile) => void }) {
  return (
    <div className="space-y-3" role="radiogroup" aria-label="Language">
      <p className="text-[15px] text-[var(--fg-2)]">Choose the language you&apos;re most comfortable speaking. Mitra understands mixed Hindi and English either way.</p>
      {LANGUAGES.map((l) => (
        <ChoiceCard
          key={l.value}
          selected={draft.language === l.value}
          onClick={() =>
            setDraft((d) => ({
              ...d,
              language: l.value,
              // Hindi speakers get Hindi recognition and Devanagari text; others Roman letters.
              voice: { ...d.voice, voice_language: l.value === "hindi" ? "hi-IN" : "en-IN", script: l.value === "hindi" ? "devanagari" : "roman" },
            }))
          }
        >
          <span className="block text-[20px] font-semibold">{l.label}</span>
          <span className="mt-0.5 block text-[14px] text-[var(--fg-2)]">“{l.sample}”</span>
        </ChoiceCard>
      ))}
    </div>
  );
}

function DetailsStep({ draft, set, onlineEnabled }: { draft: Profile; set: SetField; onlineEnabled: boolean }) {
  const toggleStore = (s: Store) =>
    set("preferred_stores", draft.preferred_stores.includes(s) ? draft.preferred_stores.filter((x) => x !== s) : [...draft.preferred_stores, s]);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
        <Field label="Full name">
          <input className="mac-input px-3 py-2.5 text-[16px]" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Kamla Devi" />
        </Field>
        <Field label="Age">
          <input
            className="mac-input px-3 py-2.5 text-[16px]"
            type="number"
            min={1}
            max={120}
            value={Number.isFinite(draft.age) ? draft.age : ""}
            onChange={(e) => set("age", e.target.value === "" ? Number.NaN : Number(e.target.value))}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mobile number" hint="Needed for delivery and order SMS.">
          <div className="flex">
            <span className="flex items-center rounded-l-xl border border-r-0 border-[var(--line-strong)] bg-[var(--card)] px-3 text-[16px] text-[var(--fg-2)]">
              +91
            </span>
            <input
              className="mac-input !rounded-l-none px-3 py-2.5 text-[16px] tracking-wide"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              required
              value={draft.phone.replace(/^\+91/, "")}
              onChange={(e) => set("phone", e.target.value)}
              placeholder="98765 43210"
            />
          </div>
        </Field>
        <Field label="Email" hint="For order receipts.">
          <input className="mac-input px-3 py-2.5 text-[16px]" type="email" value={draft.email} onChange={(e) => set("email", e.target.value)} placeholder="you@example.com" />
        </Field>
      </div>
      <Field label="Delivery address">
        <textarea
          className="mac-input h-20 resize-none px-3 py-2.5 text-[16px]"
          value={draft.address}
          onChange={(e) => set("address", e.target.value)}
          placeholder="House no., street, area, city, PIN"
        />
      </Field>
      <div>
        <p className="mac-label">Shop from</p>
        <div className="mt-1.5 flex gap-2">
          {(["zepto", "amazon"] as Store[]).map((s) => (
            <button key={s} type="button" className="mac-chip !px-4 !py-2 !text-[14px] capitalize" aria-pressed={draft.preferred_stores.includes(s)} onClick={() => toggleStore(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mac-label">How you&apos;d like to pay</p>
        <div className={`mt-1.5 grid gap-2 ${onlineEnabled ? "sm:grid-cols-3" : "sm:grid-cols-2"}`} role="radiogroup" aria-label="Payment">
          {paymentMethods(onlineEnabled || draft.payment_method === "online").map((p: PaymentMethod) => (
            <ChoiceCard key={p} selected={draft.payment_method === p} onClick={() => set("payment_method", p)}>
              <span className="block text-[15px] font-semibold">{PAYMENT_LABEL[p]}</span>
              <span className="block text-[12px] text-[var(--fg-2)]">{PAYMENT_HINT[p]}</span>
            </ChoiceCard>
          ))}
        </div>
      </div>
    </div>
  );
}

function HealthStep({ draft, set }: { draft: Profile; set: SetField }) {
  const toggle = (c: string) => set("conditions", draft.conditions.includes(c) ? draft.conditions.filter((x) => x !== c) : [...draft.conditions, c]);
  return (
    <div className="space-y-5">
      <div className="rounded-xl bg-[var(--card-soft)] p-3 text-[13px] leading-snug text-[var(--fg-2)]">
        Mitra checks every order against this and warns you about items that may not suit you. It&apos;s a helpful reminder, not medical
        advice.
      </div>
      <div>
        <p className="mac-label">Conditions</p>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
          {CONDITIONS.map((c) => (
            <ChoiceCard key={c.value} selected={draft.conditions.includes(c.value)} onClick={() => toggle(c.value)}>
              <span className="flex items-center justify-between text-[15px] font-semibold">
                {c.label}
                {draft.conditions.includes(c.value) && <Icon name="check" size={16} />}
              </span>
              <span className="block text-[12px] text-[var(--fg-2)]">{c.hint}</span>
            </ChoiceCard>
          ))}
        </div>
      </div>
      <Field label="Medicines you take">
        <TagInput values={draft.medications} onChange={(v) => set("medications", v)} suggestions={MEDICATION_SUGGESTIONS} placeholder="Type a medicine and press Enter" />
      </Field>
      <Field label="Food allergies">
        <TagInput values={draft.allergies} onChange={(v) => set("allergies", v)} suggestions={ALLERGY_SUGGESTIONS} placeholder="Type an allergy and press Enter" />
      </Field>
      <Field label="Diet notes from your doctor" hint="Optional">
        <textarea
          className="mac-input h-20 resize-none px-3 py-2.5 text-[16px]"
          value={draft.diet_notes}
          onChange={(e) => set("diet_notes", e.target.value)}
          placeholder="e.g. Low salt, no fried food"
        />
      </Field>
    </div>
  );
}

function FamilyStep({ draft, set }: { draft: Profile; set: SetField }) {
  const contacts = draft.family_contacts;
  const update = (i: number, key: "name" | "relation" | "phone" | "email", value: string) =>
    set("family_contacts", contacts.map((c, idx) => (idx === i ? { ...c, [key]: value } : c)));
  return (
    <div className="space-y-3">
      <p className="text-[15px] text-[var(--fg-2)]">
        When an order is placed, Mitra sends the details by SMS and email to you, and to the family members or caregiver you add here.
      </p>
      <div className="space-y-2 rounded-xl bg-[var(--card-soft)] p-3">
        {(
          [
            ["sms", "Send SMS alerts", "To your phone and your family's phones"],
            ["email", "Send email alerts", "Order receipt with items, total and delivery time"],
            ["notify_family", "Tell my family too", "Otherwise only you get the alerts"],
          ] as const
        ).map(([key, label, hint]) => (
          <div key={key} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold">{label}</p>
              <p className="text-[12px] text-[var(--fg-2)]">{hint}</p>
            </div>
            <Toggle on={draft.alerts[key]} onChange={(v) => set("alerts", { ...draft.alerts, [key]: v })} label={label} />
          </div>
        ))}
      </div>
      {contacts.map((c, i) => (
        <div key={i} className="grid items-end gap-2 rounded-xl bg-[var(--card-soft)] p-3 sm:grid-cols-[1fr_110px_1fr_1.2fr_auto]">
          <Field label="Name">
            <input className="mac-input bg-[var(--card)] px-3 py-2 text-[15px]" value={c.name} onChange={(e) => update(i, "name", e.target.value)} placeholder="Ravi" />
          </Field>
          <Field label="Relation">
            <input className="mac-input bg-[var(--card)] px-3 py-2 text-[15px]" value={c.relation} onChange={(e) => update(i, "relation", e.target.value)} placeholder="Son" />
          </Field>
          <Field label="Phone">
            <input className="mac-input bg-[var(--card)] px-3 py-2 text-[15px]" type="tel" value={c.phone} onChange={(e) => update(i, "phone", e.target.value)} placeholder="+91 …" />
          </Field>
          <Field label="Email">
            <input className="mac-input bg-[var(--card)] px-3 py-2 text-[15px]" type="email" value={c.email} onChange={(e) => update(i, "email", e.target.value)} placeholder="ravi@example.com" />
          </Field>
          <button type="button" className="mac-btn mb-1 text-[var(--fg-2)]" onClick={() => set("family_contacts", contacts.filter((_, idx) => idx !== i))} aria-label="Remove contact">
            <Icon name="trash" size={15} />
          </button>
        </div>
      ))}
      {contacts.length < 5 && (
        <button type="button" className="mac-btn-outline w-full py-2.5 text-[14px]" onClick={() => set("family_contacts", [...contacts, { name: "", relation: "", phone: "", email: "" }])}>
          <Icon name="plus" size={14} />
          Add family member
        </button>
      )}
    </div>
  );
}

function VoiceStep({ draft, set, getToken }: { draft: Profile; set: SetField; getToken: () => Promise<string | null> }) {
  const voice = useVoiceInput(draft.voice.voice_language, API_BASE, getToken);
  const [heard, setHeard] = useState("");
  const listening = voice.status === "listening";
  const setVoice = (patch: Partial<Profile["voice"]>) => set("voice", { ...draft.voice, ...patch });
  const shown = (t: string) => (draft.voice.script === "roman" ? toRoman(t) : t);

  return (
    <div className="space-y-5">
      <div>
        <p className="mac-label">I&apos;ll mostly speak in</p>
        <div className="mt-1.5 flex gap-2">
          {(
            [
              ["en-IN", "English / Hinglish"],
              ["hi-IN", "Hindi"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" className="mac-chip !px-4 !py-2 !text-[14px]" aria-pressed={draft.voice.voice_language === v} onClick={() => setVoice({ voice_language: v })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mac-label">Show my words in</p>
        <div className="mt-1.5 flex gap-2">
          <button type="button" className="mac-chip !px-4 !py-2 !text-[14px]" aria-pressed={draft.voice.script === "roman"} onClick={() => setVoice({ script: "roman" })}>
            Roman · jaldi oats
          </button>
          <button type="button" className="mac-chip !px-4 !py-2 !text-[14px]" aria-pressed={draft.voice.script === "devanagari"} onClick={() => setVoice({ script: "devanagari" })}>
            देवनागरी · जल्दी ओट्स
          </button>
        </div>
      </div>

      <section className="rounded-xl bg-[var(--card-soft)] p-4">
        <p className="mac-label">Test your microphone</p>
        <div className="mt-3 flex items-center gap-4">
          <button
            type="button"
            onClick={() => (listening ? voice.stop() : voice.start((t) => setHeard((prev) => `${prev} ${t}`.trim())))}
            disabled={voice.status === "unsupported" || voice.status === "transcribing"}
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40 ${
              listening ? "animate-ring bg-[var(--accent)] text-white" : "bg-[var(--primary)] text-[var(--primary-fg)]"
            }`}
            aria-label={listening ? "Stop" : "Start mic test"}
          >
            <Icon name={listening ? "stop" : "mic"} size={22} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">
              {listening ? "Listening… say “2 packet doodh”" : voice.status === "transcribing" ? "Converting…" : "Tap and say something"}
            </p>
            <p className="mt-0.5 min-h-[22px] text-[16px] text-[var(--fg-2)]">
              {shown(`${heard} ${listening ? voice.interimTranscript : ""}`.trim()) || "Your words will appear here."}
            </p>
          </div>
        </div>
        {voice.status === "denied" && <p className="mt-2 text-[12px] text-[var(--bad)]">Mic access was blocked. Allow it in your browser&apos;s site settings.</p>}
        {voice.status === "unsupported" && <p className="mt-2 text-[12px] text-[var(--fg-2)]">Voice isn&apos;t available in this browser; typing works the same.</p>}
        {voice.status === "error" && voice.errorMessage && <p className="mt-2 text-[12px] text-[var(--bad)]">{voice.errorMessage}</p>}
        {heard && !listening && <p className="mt-2 flex items-center gap-1 text-[13px] text-[var(--ok)]"><Icon name="check" size={14} />Your mic works.</p>}
      </section>

      <div className="flex items-center gap-3 rounded-xl bg-[var(--card-soft)] p-4">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">Read Mitra&apos;s replies aloud</p>
          <p className="text-[12px] text-[var(--fg-2)]">Mitra speaks each update so you don&apos;t have to read the screen.</p>
        </div>
        <button type="button" className="mac-btn text-[var(--fg-2)]" onClick={() => speak(READ_ALOUD_SAMPLE[draft.voice.voice_language], draft.voice.voice_language)}>
          <Icon name="speaker" size={15} />
          Try
        </button>
        <Toggle on={draft.voice.read_aloud} onChange={(v) => setVoice({ read_aloud: v })} label="Read replies aloud" />
      </div>
    </div>
  );
}

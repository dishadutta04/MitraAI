"use client";

import { useAuth, UserButton } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hasDevanagari, toRoman } from "../lib/transliterate";
import { Icon, type IconName } from "./Icon";
import Onboarding from "./Onboarding";
import { LogoMark } from "./Logo";
import { useVoiceInput, VOICE_LANGUAGES, type VoiceLanguage } from "../lib/use-voice-input";
import {
  API_BASE,
  CONDITIONS,
  PAYMENT_LABEL,
  apiFetch,
  fetchOnlinePaymentEnabled,
  paymentMethods,
  speak,
  type PaymentMethod,
  type Profile,
} from "../lib/profile";
import { payWithRazorpay, type PaymentStart, type PaymentSuccess } from "../lib/razorpay";

type TimelineEvent = {
  event: string;
  agent_name: string;
  data: Record<string, unknown>;
  thread_id: string;
};

type StartResponse = {
  thread_id: string;
  status: string;
  confirmation_required: boolean;
  confirmation_payload?: Record<string, unknown> | null;
  message: string;
  state: Record<string, unknown>;
};

type ThemeMode = "light" | "dark";
/** One order alert from the Notification agent (state.notification.alerts). */
type AlertSent = { channel: "sms" | "email"; to: string; who: string; status: "sent" | "failed" | "not_configured" };
/** What Mitra understood from the text box (POST /api/v1/orders/parse). */
/** One item as Mitra read it; the buyer can change `quantity` with + / - before sending. */
type ReviewItem = {
  item: string;
  quantity: number;
  preferences: string[];
  /** "said": a number was spoken; "base": none, so 1 base pack; "people": sized for "for 4 people". */
  basis?: "said" | "base" | "people";
  note?: string | null;
};

type ParsePreview = {
  items: ReviewItem[];
  urgency: "low" | "medium" | "high";
  words?: WordInfo[];
  /** The text this preview was computed for (set on the client). */
  source?: string;
};

/** One spoken word in both scripts, and what Mitra understood it as. */
type WordInfo = {
  hindi: string;
  roman: string;
  kind: "number" | "unit" | "item" | "separator" | "urgency" | "filler" | "unknown";
  meaning: string | null;
  /** Position of the spoken word in the text it came from. */
  index: number;
  /** Shown straight away while the backend is still reading this word. */
  pending?: boolean;
};

/** How each kind of word looks in the "Aapne kaha" panel, plus its legend label. */
const WORD_STYLE: Record<WordInfo["kind"], { chip: string; legend?: string; dot?: string }> = {
  item: { chip: "border-[var(--ok)] bg-[color-mix(in_srgb,var(--ok)_10%,transparent)]", legend: "Item", dot: "bg-[var(--ok)]" },
  number: { chip: "border-[var(--fg)] font-bold", legend: "Number", dot: "bg-[var(--fg)]" },
  unit: { chip: "border-[#3b82f6] bg-[color-mix(in_srgb,#3b82f6_10%,transparent)]", legend: "Unit", dot: "bg-[#3b82f6]" },
  urgency: { chip: "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]", legend: "Urgent", dot: "bg-[var(--accent)]" },
  separator: { chip: "border-transparent opacity-60" },
  filler: { chip: "border-transparent opacity-60" },
  unknown: { chip: "border-dashed border-[var(--bad)]", legend: "Not understood", dot: "bg-[var(--bad)]" },
};

type ProductOption = { vendor: string; item_name: string; pack?: string | null; unit_price: number; eta_minutes: number };

/** One item of an order as the Decision agent picked it (state.decision.lines), with the options to choose from. */
type DecisionLine = {
  item: string;
  quantity: number;
  option: ProductOption | null;
  options?: ProductOption[];
};

const MAX_QTY = 99;

function decisionLines(state: Record<string, unknown> | undefined): DecisionLine[] {
  const lines = (state?.decision as { lines?: DecisionLine[] } | undefined)?.lines;
  return Array.isArray(lines) ? lines.filter((l) => l.option) : [];
}

type View = "assistant" | "history" | "profile" | "console" | "about" | "uses";
/** A placed order from GET /api/v1/orders/history (stored in Supabase). */
type HistoryEntry = {
  thread_id: string;
  request_text: string | null;
  created_at: string;
  status: string;
  payment_method: PaymentMethod | null;
  total: number;
  lines: { item: string; vendor: string; quantity: number; price_total: number }[];
};
type OrderSummary = {
  status: "idle" | "awaiting_confirmation" | "completed" | "failed" | "cancelled";
  item: string;
  vendor: string;
  eta: string;
  total: string;
  note: string;
};
type GuardrailView = {
  riskLevel: string;
  warnings: string[];
  clinicalNotes: string[];
  alternatives: string[];
};

const QUICK_PROMPTS = [
  "Jaldi 2 packet oats mangao",
  "Sugar-free biscuit chahiye",
  "2 packet doodh aur 1 kilo cheeni",
  "1 kg apple aur banana order karo",
];

const URGENCY_LABEL: Record<ParsePreview["urgency"], string> = {
  high: "Urgent",
  medium: "Normal",
  low: "No hurry",
};

const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: "assistant", label: "Assistant", icon: "message" },
  { id: "history", label: "Order History", icon: "inbox" },
  { id: "profile", label: "Profile", icon: "user" },
  { id: "console", label: "Agent Console", icon: "terminal" },
  { id: "about", label: "About Mitra", icon: "info" },
  { id: "uses", label: "Use Cases", icon: "sparkle" },
];

const ORDER_STATUS_LABEL: Record<string, string> = {
  idle: "No order",
  awaiting_confirmation: "Awaiting approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function historyStatusLabel(status: string): string {
  return status === "confirmed" ? "Placed" : (ORDER_STATUS_LABEL[status] ?? status.replaceAll("_", " "));
}

const CONDITION_LABEL = Object.fromEntries(CONDITIONS.map((c) => [c.value, c.label]));

const STATUS_DOT: Record<string, string> = {
  done: "bg-[var(--ok)]",
  running: "bg-[var(--warn)] animate-pulse",
  error: "bg-[var(--bad)]",
  idle: "bg-[var(--fg-3)] opacity-50",
};

function wsUrl(threadId: string, token: string): string {
  const base = API_BASE.replace("http://", "ws://").replace("https://", "wss://");
  return `${base}/ws/events/${threadId}?token=${encodeURIComponent(token)}`;
}

function confidenceFromEvents(events: TimelineEvent[]): number {
  if (events.length === 0) return 0;
  const completed = events.filter((e) => e.event.includes("completed")).length;
  const failed = events.filter((e) => e.event.includes("failed") || e.event.includes("error")).length;
  const score = Math.round(((completed + 1) / (events.length + failed + 1)) * 100);
  return Math.max(25, Math.min(99, score));
}

function buildOrderSummary(data: StartResponse): OrderSummary {
  const state = data.state ?? {};
  const recommendation = (state.decision as Record<string, unknown> | undefined)?.recommendation as
    | Record<string, unknown>
    | undefined;
  const purchase = state.purchase as Record<string, unknown> | undefined;

  const lines = decisionLines(state);
  let item = String(recommendation?.item_name ?? "Not selected");
  let vendor = String(recommendation?.vendor ?? "Pending");
  let eta = recommendation?.eta_minutes ? `${recommendation.eta_minutes} min` : "--";
  const qty = Number((state.intent as Record<string, unknown> | undefined)?.quantity ?? 0);
  const unitPrice = Number(recommendation?.unit_price ?? 0);
  let total = qty > 0 && unitPrice > 0 ? `₹${qty * unitPrice}` : "--";
  if (lines.length > 0) {
    item = lines.map((l) => `${l.quantity} × ${l.option!.item_name}`).join(", ");
    vendor = [...new Set(lines.map((l) => l.option!.vendor))].join(", ");
    eta = `${Math.max(...lines.map((l) => l.option!.eta_minutes))} min`;
    total = `₹${lines.reduce((sum, l) => sum + l.quantity * l.option!.unit_price, 0)}`;
  }

  if (data.status === "awaiting_confirmation") {
    return {
      status: "awaiting_confirmation",
      item,
      vendor,
      eta,
      total,
      note: "Awaiting your approval to place the order.",
    };
  }
  if (purchase?.status === "confirmed") {
    return { status: "completed", item, vendor, eta, total, note: "Order successfully completed." };
  }
  if (purchase?.status === "failed") {
    return { status: "failed", item, vendor, eta, total, note: "Order failed after retries." };
  }
  if (purchase?.status === "skipped") {
    return { status: "cancelled", item, vendor, eta, total, note: "Order was cancelled." };
  }
  return { status: "idle", item, vendor, eta, total, note: "No active order yet." };
}

function getAgentStatus(events: TimelineEvent[], agentName: string): "idle" | "running" | "done" | "error" {
  const hasError = events.some((e) => e.agent_name === agentName && (e.event.includes("failed") || e.event.includes("error")));
  if (hasError) return "error";
  const done = events.some((e) => e.agent_name === agentName && e.event.includes("completed"));
  if (done) return "done";
  const running = events.some(
    (e) =>
      e.agent_name === agentName &&
      (e.event.includes("started") || e.event.includes("retrying") || e.event.includes("confirmation_requested"))
  );
  if (running) return "running";
  return "idle";
}

export default function MitraDemo({ profile, onProfileSaved }: { profile: Profile; onProfileSaved: (p: Profile) => void }) {
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const api = useCallback((path: string, init?: RequestInit) => apiFetch(() => getTokenRef.current(), path, init), []);
  const [view, setView] = useState<View>("assistant");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [input, setInput] = useState("Jaldi se 2 packet oats order kar do");
  const [assistantText, setAssistantText] = useState(
    `Hello ${profile.name.split(" ")[0]}! I'm Mitra. Speak or type your order and I'll take care of it.`,
  );
  const [threadId, setThreadId] = useState<string | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [confirmPayload, setConfirmPayload] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("light");
  /** Don't save the theme until the saved one has been read, or the default would overwrite it. */
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [guardrailView, setGuardrailView] = useState<GuardrailView>({
    riskLevel: "low",
    warnings: [],
    clinicalNotes: [],
    alternatives: [],
  });
  const [orderSummary, setOrderSummary] = useState<OrderSummary>({
    status: "idle",
    item: "Not selected",
    vendor: "Pending",
    eta: "--",
    total: "--",
    note: "No active order yet.",
  });
  const wsRef = useRef<WebSocket | null>(null);
  const lastRequestRef = useRef<string>(input);
  const confirmationRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [language, setLanguage] = useState<VoiceLanguage>(profile.voice.voice_language);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(profile.payment_method);
  const [onlineEnabled, setOnlineEnabled] = useState(false);
  const [alertsSent, setAlertsSent] = useState<AlertSent[]>([]);
  const voice = useVoiceInput(language, API_BASE, getToken);
  const listening = voice.status === "listening";
  const transcribing = voice.status === "transcribing";
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  /** The items in the review card; starts as Mitra read them, then follows the + / - buttons. */
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  /** The buyer's pick per order line at approval: {line index: option index}; unset = best-ranked (0). */
  const [selections, setSelections] = useState<Record<number, number>>({});
  /** Roman letters for English / Hinglish, or when the profile asks for them, even if a recogniser returned Hindi script. */
  const forLanguage = (text: string) => (language === "en-IN" || profile.voice.script === "roman" ? toRoman(text) : text);
  /** Mitra's reply on screen, and read aloud when the profile asks for it. */
  const reply = (text: string) => {
    setAssistantText(text);
    if (profile.voice.read_aloud) speak(text, profile.voice.voice_language);
  };

  const AGENTS = [
    "Intent Agent",
    "Health Guardrail Agent",
    "Planning Agent",
    "Search Agent",
    "Comparison Agent",
    "Decision & HITL Agent",
    "Purchase Agent",
    "Notification Agent",
  ];

  const confidence = useMemo(() => confidenceFromEvents(events), [events]);
  const topPicks = useMemo(() => {
    const lines = (confirmPayload?.lines as DecisionLine[] | undefined) ?? [];
    return lines.filter((l) => l.option);
  }, [confirmPayload]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("mitra-theme") as ThemeMode | null;
    setTheme(stored === "dark" ? "dark" : "light");
    setThemeLoaded(true);
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api("/api/v1/orders/history");
      if (res.ok) setHistory((await res.json()) as HistoryEntry[]);
    } catch {
      // History is shown when the server is reachable; ordering doesn't depend on it.
    }
  }, [api]);

  useEffect(() => {
    void loadHistory();
    void fetchOnlinePaymentEnabled(() => getTokenRef.current()).then(setOnlineEnabled);
  }, [loadHistory]);

  useEffect(() => {
    if (typeof window === "undefined" || !themeLoaded) return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("mitra-theme", theme);
  }, [theme, themeLoaded]);

  function clearWorkspace() {
    wsRef.current?.close();
    setThreadId(null);
    setEvents([]);
    setAwaitingConfirmation(false);
    setConfirmPayload(null);
    voice.stop(true);
    setSubmitting(false);
    setOrderSummary({
      status: "idle",
      item: "Not selected",
      vendor: "Pending",
      eta: "--",
      total: "--",
      note: "No active order yet.",
    });
    setGuardrailView({ riskLevel: "low", warnings: [], clinicalNotes: [], alternatives: [] });
    setAlertsSent([]);
    setAssistantText("Workspace cleared. You can start a new order.");
  }

  function orderAgain(entry: HistoryEntry) {
    newOrder();
    setInput(entry.request_text || entry.lines.map((l) => `${l.quantity} ${l.item}`).join(" aur "));
  }

  function newOrder() {
    clearWorkspace();
    setInput("");
    setPreview(null);
    setView("assistant");
    setAssistantText("Hello! What would you like to order?");
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function openView(next: View) {
    setView(next);
  }

  useEffect(() => {
    if (!threadId) return;
    wsRef.current?.close();

    // Browsers can't send headers on a WebSocket, so the session token goes in the URL.
    let ws: WebSocket | null = null;
    let cancelled = false;
    void getTokenRef.current().then((token) => {
      if (cancelled) return;
      ws = new WebSocket(wsUrl(threadId, token ?? ""));
      wsRef.current = ws;

      ws.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as TimelineEvent;
          setEvents((prev) => [...prev, parsed]);
        } catch {
          // Ignore malformed frames.
        }
      };

      ws.onerror = () => {
        setEvents((prev) => [
          ...prev,
          {
            event: "ws_error",
            agent_name: "System",
            data: { message: "WebSocket disconnected or unavailable" },
            thread_id: threadId,
          },
        ]);
      };
    });

    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [threadId]);

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [events]);

  useEffect(() => {
    if (awaitingConfirmation && confirmationRef.current) {
      confirmationRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [awaitingConfirmation]);

  async function startOrder(message: string, items?: ReviewItem[]) {
    if (!message.trim()) return;
    lastRequestRef.current = message;
    setEvents([]);
    setSubmitting(true);
    setAssistantText("Processing your request. The agents are working…");

    try {
      const res = await api("/api/v1/orders/start", {
        method: "POST",
        body: JSON.stringify({ message, ...(items?.length ? { items } : {}) }),
      });

      if (!res.ok) {
        reply(res.status === 401 ? "Your session has expired. Please sign in again." : "Couldn't reach the server. Please try again.");
        return;
      }

      const data = (await res.json()) as StartResponse;
      setThreadId(data.thread_id);
      reply(data.message);
      setAwaitingConfirmation(data.confirmation_required);
      setConfirmPayload(data.confirmation_payload ?? null);
      setSelections({});
      setAlertsSent([]);
      setPaymentMethod(profile.payment_method === "online" && !onlineEnabled ? "cod" : profile.payment_method);
      setOrderSummary(buildOrderSummary(data));
      const guardrail = (data.state?.guardrail ?? {}) as Record<string, unknown>;
      setGuardrailView({
        riskLevel: String(guardrail.risk_level ?? "low"),
        warnings: (guardrail.warnings as string[]) ?? [],
        clinicalNotes: (guardrail.clinical_notes as string[]) ?? [],
        alternatives: (guardrail.healthier_alternatives as string[]) ?? [],
      });
    } catch {
      reply("Couldn't reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function resumeOrder(approved: boolean) {
    if (!threadId) return;
    setSubmitting(true);

    try {
      // "Pay now": take the payment first (the server sets the amount), then place the order with Razorpay's signed receipt.
      let paid: PaymentSuccess | null = null;
      if (approved && paymentMethod === "online") {
        setAssistantText("Opening secure payment…");
        const start = await api(`/api/v1/orders/${threadId}/payment`, { method: "POST", body: JSON.stringify({ selections }) });
        if (!start.ok) {
          const detail = ((await start.json().catch(() => ({}))) as { detail?: string }).detail;
          reply(detail ?? "Couldn't start the payment. Please try again or pay on delivery.");
          return;
        }
        try {
          paid = await payWithRazorpay((await start.json()) as PaymentStart);
        } catch (err) {
          reply(err instanceof Error ? err.message : "Payment failed. No money was taken.");
          return;
        }
        if (!paid) {
          reply("Payment cancelled. Your order is still waiting; nothing was charged.");
          return;
        }
      }

      setAssistantText(approved ? "Confirming your order…" : "Cancelling your order…");
      const res = await api(`/api/v1/orders/${threadId}/resume`, {
        method: "POST",
        body: JSON.stringify({ approved, selections, payment_method: paymentMethod, ...(paid ?? {}) }),
      });

      if (!res.ok) {
        const detail = ((await res.json().catch(() => ({}))) as { detail?: string }).detail;
        reply(detail ?? "Something went wrong. Please try again.");
        return;
      }

      const data = (await res.json()) as StartResponse;
      reply(data.message);
      setAwaitingConfirmation(data.confirmation_required);
      setConfirmPayload(data.confirmation_payload ?? null);
      setOrderSummary(buildOrderSummary(data));
      setAlertsSent(((data.state?.notification as { alerts?: AlertSent[] } | undefined)?.alerts ?? []) as AlertSent[]);
      const guardrail = (data.state?.guardrail ?? {}) as Record<string, unknown>;
      setGuardrailView({
        riskLevel: String(guardrail.risk_level ?? "low"),
        warnings: (guardrail.warnings as string[]) ?? [],
        clinicalNotes: (guardrail.clinical_notes as string[]) ?? [],
        alternatives: (guardrail.healthier_alternatives as string[]) ?? [],
      });
      if (approved) void loadHistory();
    } catch {
      reply("Couldn't reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  /** Same as CloseBy's mic: tap to start, tap again to stop; what's heard is added to the text box. */
  function handleMic() {
    if (listening) {
      voice.stop();
      return;
    }
    if (transcribing) return;
    voice.start((finalText) => {
      const text = forLanguage(finalText);
      setInput((prev) => (prev ? `${prev} ${text}` : text));
    });
  }

  /** Text box plus the words still being recognised, so the word panel follows the voice live. */
  const liveText =
    (listening || transcribing) && voice.interimTranscript ? `${input} ${voice.interimTranscript}`.trim() : input.trim();

  // Live "Mitra understood" preview of the text box (and of each word), so mistakes are caught before any agent runs.
  useEffect(() => {
    const text = liveText;
    if (!text) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await api("/api/v1/orders/parse", {
          method: "POST",
          body: JSON.stringify({ message: text }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as ParsePreview;
        setPreview({ ...data, source: text });
      } catch {
        // Preview is a convenience; the order flow works without it.
      }
    }, listening ? 150 : 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [liveText, listening, api]);

  // Each new reading of the text resets the review card to what Mitra understood.
  useEffect(() => {
    setReviewItems(preview?.items ?? []);
  }, [preview]);

  function changeQuantity(index: number, delta: number) {
    setReviewItems((items) =>
      items.map((it, i) => (i === index ? { ...it, quantity: Math.min(MAX_QTY, Math.max(1, it.quantity + delta)) } : it)),
    );
  }

  function removeItem(index: number) {
    setReviewItems((items) => items.filter((_, i) => i !== index));
  }

  function sendReviewed() {
    if (listening) voice.stop(true);
    // The review card can lag the text box by one debounce; if it does, let the backend read the text itself.
    const reviewed = preview?.source === input.trim() ? reviewItems : undefined;
    void startOrder(input, reviewed);
  }

  const latestEvent = events.length > 0 ? events[events.length - 1] : null;
  const doneAgents = AGENTS.filter((a) => getAgentStatus(events, a) === "done").length;
  const riskTone =
    guardrailView.riskLevel === "high"
      ? "text-[var(--bad)]"
      : guardrailView.riskLevel === "medium"
        ? "text-[var(--warn)]"
        : "text-[var(--ok)]";

  // ---------- Assistant cards ----------

  // One box per word as soon as it is heard: words the backend has already read come
  // from the last preview; newer ones show at once and fill in when the next preview lands.
  const spokenWords: WordInfo[] = (() => {
    if (!liveText) return [];
    const live = liveText.split(/\s+/);
    const known = preview?.source ? preview.source.split(/\s+/) : [];
    let same = 0;
    // Compare script-blind: the final text may be in Roman letters while the live text was in Hindi.
    const sameWord = (x: string, y: string) => toRoman(x).toLowerCase() === toRoman(y).toLowerCase();
    while (same < live.length && same < known.length && sameWord(live[same]!, known[same]!)) same++;
    const fromBackend = (preview?.words ?? []).filter((w) => w.index < same);
    const fresh = live.slice(same).map<WordInfo>((word, i) => ({
      hindi: word,
      roman: hasDevanagari(word) ? toRoman(word) : word,
      kind: "filler",
      meaning: null,
      index: same + i,
      pending: true,
    }));
    return [...fromBackend, ...fresh];
  })();
  const kindsShown = new Set(spokenWords.map((w) => w.kind));
  const wordPanel = spokenWords.length > 0 && (
    <div className="mt-3 rounded-xl bg-[var(--card-soft)] p-3" aria-live="polite">
      <div className="flex items-center justify-between">
        <p className="mac-label">You said (Hindi + Hinglish)</p>
        {listening && <span className="text-[11px] text-[var(--accent)]">live</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {spokenWords.map((w, idx) => (
          <div
            key={`${w.roman}-${idx}`}
            className={`min-w-[44px] rounded-lg border bg-[var(--card)] px-2 py-1 text-center animate-fade-in ${
              w.pending ? "border-[var(--line-strong)]" : WORD_STYLE[w.kind].chip
            }`}
            title={w.kind === "unknown" ? "Mitra didn't understand this word — fix it in the text box" : undefined}
          >
            <p className="text-[17px] leading-tight">{w.hindi}</p>
            <p className="text-[11px] leading-tight text-[var(--fg-2)]">{w.roman}</p>
            {w.meaning && w.meaning !== w.roman && w.kind !== "number" && (
              <p className="text-[10px] font-semibold leading-tight text-[var(--fg-2)]">= {w.meaning}</p>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {(Object.keys(WORD_STYLE) as WordInfo["kind"][])
          .filter((k) => WORD_STYLE[k].legend && kindsShown.has(k))
          .map((k) => (
            <span key={k} className="flex items-center gap-1 text-[11px] text-[var(--fg-2)]">
              <span className={`h-2 w-2 rounded-full ${WORD_STYLE[k].dot}`} />
              {WORD_STYLE[k].legend}
            </span>
          ))}
      </div>
      {kindsShown.has("unknown") && !listening && (
        <p className="mt-2 text-[12px] text-[var(--bad)]">
          Mitra didn&apos;t understand the words in red — fix them in the text box or say them again.
        </p>
      )}
    </div>
  );

  const voiceCard = (
    <section className="mac-card p-4" key="voice">
      <div className="flex items-center justify-between">
        <p className="mac-label">Speak or type your order</p>
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--fg-2)]">
          <span className={`h-1.5 w-1.5 rounded-full ${listening ? "bg-[var(--accent)] animate-pulse" : "bg-[var(--fg-3)]"}`} />
          {listening ? "Listening" : transcribing ? "Converting…" : "Ready"}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-4">
        <button
          onClick={handleMic}
          disabled={voice.status === "unsupported" || transcribing}
          title={
            voice.status === "unsupported"
              ? "Voice input isn't supported in this browser — try typing instead"
              : voice.status === "denied"
                ? "Mic access was denied — allow it in your browser's site settings, then try again"
                : listening
                  ? "Stop recording"
                  : "Record a voice note"
          }
          className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40 ${
            listening ? "animate-ring bg-[var(--accent)] text-white" : "bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90"
          }`}
        >
          <Icon name={listening ? "stop" : "mic"} size={24} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">{listening ? "Listening… tap to stop" : transcribing ? "Converting voice to text…" : "Tap the mic and speak"}</p>
          <p className="text-[12px] leading-snug text-[var(--fg-2)]">Speak in Hindi, English or Hinglish. Pauses are fine — check the text, then send.</p>
          <div className="mt-2 flex h-5 items-end gap-1 overflow-hidden" aria-hidden="true">
            {[8, 14, 20, 12, 18, 9, 16, 11, 15, 7].map((h, idx) => (
              <span
                key={idx}
                className={`w-1 rounded-full bg-[var(--fg)] transition-[height] duration-100 ${
                  listening && voice.engine === "browser" ? "animate-wave" : listening ? "" : "opacity-20"
                }`}
                style={{
                  // Server mode can measure the mic, so the bars follow the real voice.
                  height: listening && voice.engine === "server" ? `${Math.min(20, Math.max(3, h * (0.35 + voice.level * 2)))}px` : `${h * 0.9}px`,
                  animationDelay: `${idx * 70}ms`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <textarea
        id="order-input"
        ref={inputRef}
        value={(listening || transcribing) && voice.interimTranscript ? `${input} ${forLanguage(voice.interimTranscript)}`.trim() : input}
        onChange={(e) => setInput(e.target.value)}
        readOnly={transcribing}
        placeholder={transcribing ? "Converting voice to text…" : "e.g. 2 packet doodh aur 1 kilo cheeni…"}
        className="mac-input mt-4 h-24 resize-none p-3 text-[16px] leading-relaxed"
      />
      {wordPanel}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {VOICE_LANGUAGES.map((l) => (
          <button key={l.value} type="button" className="mac-chip" aria-pressed={language === l.value} onClick={() => setLanguage(l.value)}>
            {l.label}
          </button>
        ))}
      </div>

      {voice.status === "denied" && (
        <p className="mt-2 text-[12px] text-[var(--bad)]">
          Mic access was denied. Allow microphone access for this site in your browser settings, then tap the mic again — or just type
          your request above.
        </p>
      )}
      {voice.status === "error" && voice.errorMessage && <p className="mt-2 text-[12px] text-[var(--bad)]">{voice.errorMessage}</p>}
      {voice.status === "unsupported" && (
        <p className="mt-2 text-[12px] text-[var(--fg-2)]">Voice input isn&apos;t available in this browser — typing works the same.</p>
      )}

      <div className="mt-4 border-t border-[var(--line)] pt-3">
        <p className="mac-label">Try saying</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK_PROMPTS.map((prompt) => (
            <button key={prompt} className="mac-chip" onClick={() => setInput(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={sendReviewed}
        disabled={submitting || listening || transcribing || !input.trim()}
        className="mac-btn-primary mt-4 w-full py-2.5 text-[14px]"
      >
        <Icon name="bolt" size={15} />
        {submitting ? "Agents running…" : "Launch Agents"}
      </button>
    </section>
  );

  const previewCard = preview && input.trim() && !listening && !transcribing && (
    <section className="mac-card animate-fade-in p-4" key="preview">
      <p className="mac-label">Mitra understood</p>
      {reviewItems.length > 0 ? (
        <>
          <ul className="mt-2 divide-y divide-[var(--line)]">
            {reviewItems.map((line, idx) => {
              const original = preview.items[idx];
              const changed = original && original.item === line.item && original.quantity !== line.quantity;
              return (
                <li key={`${line.item}-${idx}`} className="flex items-center gap-3 py-2">
                  <div className="flex shrink-0 items-center rounded-full border border-[var(--line-strong)]">
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[18px] hover:bg-[var(--hover)] disabled:opacity-30"
                      onClick={() => changeQuantity(idx, -1)}
                      disabled={line.quantity <= 1}
                      aria-label={`Decrease ${line.item}`}
                    >
                      −
                    </button>
                    <span className="w-8 text-center text-[20px] font-bold tabular-nums">{line.quantity}</span>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[18px] hover:bg-[var(--hover)] disabled:opacity-30"
                      onClick={() => changeQuantity(idx, 1)}
                      disabled={line.quantity >= MAX_QTY}
                      aria-label={`Increase ${line.item}`}
                    >
                      +
                    </button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[17px] font-semibold capitalize leading-tight">
                      {line.item}
                      {line.preferences.length > 0 && (
                        <span className="ml-2 text-[12px] font-normal normal-case text-[var(--fg-2)]">{line.preferences.join(", ")}</span>
                      )}
                    </p>
                    {(line.note || changed) && (
                      <p className={`text-[11px] ${changed ? "text-[var(--accent)]" : "text-[var(--fg-3)]"}`}>
                        {changed ? `changed from ${original!.quantity}` : line.note}
                      </p>
                    )}
                  </div>
                  <button
                    className="mac-btn !p-1 text-[var(--fg-3)]"
                    onClick={() => removeItem(idx)}
                    aria-label={`Remove ${line.item}`}
                    title="Remove item"
                  >
                    <Icon name="x" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--fg-2)]">
            <span className={`h-2 w-2 rounded-full ${preview.urgency === "high" ? "bg-[var(--accent)]" : "bg-[var(--fg-3)]"}`} />
            {reviewItems.length} item{reviewItems.length === 1 ? "" : "s"} · {URGENCY_LABEL[preview.urgency]} · use − / + to change
            quantities
          </p>
        </>
      ) : (
        <p className="mt-2 text-[15px] font-medium text-[var(--bad)]">Couldn&apos;t find an item — please type the item name or say it again.</p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button onClick={sendReviewed} disabled={submitting || reviewItems.length === 0} className="mac-btn-primary py-2.5 text-[14px]">
          ✓ Looks right, send
        </button>
        <button onClick={() => setInput("")} className="mac-btn-outline py-2.5 text-[14px]">
          ✕ Clear text
        </button>
      </div>
    </section>
  );

  const approvalLines = (confirmPayload?.lines as DecisionLine[] | undefined) ?? [];
  const pickFor = (line: DecisionLine, index: number): ProductOption | null =>
    line.options?.[selections[index] ?? 0] ?? line.option;
  const approvalTotal = approvalLines.reduce((sum, l, i) => sum + (pickFor(l, i)?.unit_price ?? 0) * l.quantity, 0);
  const approvalCard = awaitingConfirmation && (
    <section
      ref={confirmationRef}
      className="mac-card animate-fade-in p-4"
      style={{ boxShadow: "0 0 0 2px var(--accent), var(--shadow-card)" }}
      key="approval"
    >
      <div className="flex items-center gap-2">
        <Icon name="bag" className="text-[var(--accent)]" />
        <p className="text-[15px] font-semibold">Purchase Approval Required</p>
      </div>
      <p className="mt-1 text-[12px] text-[var(--fg-2)]">Choose an option for each item. The best match is selected. Nothing is bought until you confirm.</p>
      <div className="mt-3 space-y-3">
        {approvalLines.map((l, lineIdx) => {
          const options = l.options?.length ? l.options : l.option ? [l.option] : [];
          const chosen = selections[lineIdx] ?? 0;
          return (
            <fieldset key={`${l.item}-${lineIdx}`} className="rounded-xl bg-[var(--card-soft)] p-2">
              <legend className="px-1 text-[13px] font-semibold capitalize">
                {l.item} <span className="font-normal text-[var(--fg-2)]">× {l.quantity}</span>
              </legend>
              <div className="mt-1 space-y-1" role="radiogroup" aria-label={`Options for ${l.item}`}>
                {options.map((o, optIdx) => (
                  <button
                    key={`${o.item_name}-${optIdx}`}
                    role="radio"
                    aria-checked={chosen === optIdx}
                    onClick={() => setSelections((prev) => ({ ...prev, [lineIdx]: optIdx }))}
                    className={`flex w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left text-[13px] transition ${
                      chosen === optIdx
                        ? "border-[var(--fg)] bg-[var(--card)]"
                        : "border-transparent hover:bg-[var(--hover)]"
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        chosen === optIdx ? "border-[var(--fg)]" : "border-[var(--fg-3)]"
                      }`}
                    >
                      {chosen === optIdx && <span className="h-2 w-2 rounded-full bg-[var(--fg)]" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-tight">
                        {o.item_name}
                        {o.pack && <span className="ml-1.5 font-normal text-[var(--fg-2)]">{o.pack}</span>}
                      </span>
                      <span className="block text-[11px] text-[var(--fg-2)]">
                        <span className="capitalize">{o.vendor}</span> · {o.eta_minutes} min{optIdx === 0 ? " · best match" : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right tabular-nums">
                      <span className="block font-medium">₹{o.unit_price * l.quantity}</span>
                      {l.quantity > 1 && <span className="block text-[10px] text-[var(--fg-3)]">₹{o.unit_price} each</span>}
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
      <p className="mt-3 flex justify-between px-1 text-[14px] font-semibold">
        <span>Total</span>
        <span className="tabular-nums">₹{approvalTotal}</span>
      </p>
      <div className="mt-3 px-1">
        <p className="mac-label">Payment</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Payment method">
          {paymentMethods(onlineEnabled).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={paymentMethod === p} aria-pressed={paymentMethod === p} className="mac-chip" onClick={() => setPaymentMethod(p)}>
              {PAYMENT_LABEL[p]}
            </button>
          ))}
        </div>
        {profile.address && <p className="mt-2 text-[12px] text-[var(--fg-2)]">Deliver to: {profile.address}</p>}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button onClick={() => resumeOrder(true)} disabled={submitting} className="mac-btn-primary py-2.5 text-[14px]">
          {paymentMethod === "online" ? `Pay ₹${approvalTotal} & order` : "Confirm Order"}
        </button>
        <button onClick={() => resumeOrder(false)} disabled={submitting} className="mac-btn-outline py-2.5 text-[14px]">
          Cancel Order
        </button>
      </div>
    </section>
  );

  const replyCard = (
    <section className="mac-card p-5" key="reply">
      <p className="font-display text-[22px] font-medium tracking-tight leading-snug">{assistantText}</p>
      <p className="mt-4 flex items-center gap-2 text-[12px] font-medium text-[var(--fg-2)]">
        <LogoMark size={18} animated={submitting} />
        Mitra AI · Assistant
      </p>
    </section>
  );

  const orderCard = (
    <section className="mac-card p-4" key="order">
      <div className="flex items-center justify-between">
        <p className="mac-label">Order</p>
        <span className="rounded-full bg-[var(--card-soft)] px-2 py-0.5 text-[11px] font-medium capitalize text-[var(--fg-2)]">
          {ORDER_STATUS_LABEL[orderSummary.status]}
        </span>
      </div>
      <p className="mt-2 text-[15px] font-semibold leading-snug">{orderSummary.item}</p>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
        <div>
          <dt className="text-[var(--fg-3)]">Vendor</dt>
          <dd className="font-medium capitalize">{orderSummary.vendor}</dd>
        </div>
        <div>
          <dt className="text-[var(--fg-3)]">ETA</dt>
          <dd className="font-medium">{orderSummary.eta}</dd>
        </div>
        <div>
          <dt className="text-[var(--fg-3)]">Total</dt>
          <dd className="font-medium">{orderSummary.total}</dd>
        </div>
      </dl>
      <p className="mt-3 text-[12px] text-[var(--fg-2)]">{orderSummary.note}</p>
      {alertsSent.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-[var(--line)] pt-3 text-[12px]">
          {alertsSent.map((a, idx) => (
            <li key={idx} className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  a.status === "sent" ? "bg-[var(--ok)]" : a.status === "failed" ? "bg-[var(--bad)]" : "bg-[var(--fg-3)]"
                }`}
              />
              <span className="min-w-0 flex-1 truncate">
                {a.channel === "sms" ? "SMS" : "Email"} to {a.who === "you" ? "you" : a.who}
                <span className="text-[var(--fg-3)]"> · {a.to}</span>
              </span>
              <span className="shrink-0 text-[var(--fg-2)]">
                {a.status === "sent" ? "sent" : a.status === "failed" ? "failed" : "not set up"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const healthCard = (
    <section className="mac-card p-4" key="health">
      <div className="flex items-center justify-between">
        <p className="mac-label">Health guardrail</p>
        <span className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase ${riskTone}`}>
          <span className="h-2 w-2 rounded-full bg-current" />
          Risk {guardrailView.riskLevel}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-[var(--fg-3)]">
        {profile.name}, {profile.age}
        {profile.conditions.length > 0 && ` · ${profile.conditions.map((c) => CONDITION_LABEL[c] ?? c).join(", ")}`}
        {profile.medications.length > 0 && ` · takes ${profile.medications.join(", ")}`}
        {profile.allergies.length > 0 && ` · allergic to ${profile.allergies.join(", ")}`}
      </p>
      {guardrailView.warnings.length === 0 ? (
        <p className="mt-2 text-[13px] text-[var(--fg-2)]">No clinical flags detected for this request.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {guardrailView.warnings.map((w, idx) => (
            <li key={`warn-${idx}`} className="flex gap-2 text-[13px]">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--bad)]" />
              {w}
            </li>
          ))}
        </ul>
      )}
      {guardrailView.clinicalNotes.length > 0 && (
        <div className="mt-3 space-y-1 rounded-xl bg-[var(--card-soft)] p-3 text-[12px] text-[var(--fg-2)]">
          {guardrailView.clinicalNotes.map((n, idx) => (
            <p key={`note-${idx}`}>{n}</p>
          ))}
        </div>
      )}
      {guardrailView.alternatives.length > 0 && (
        <p className="mt-3 text-[12px]">
          <span className="text-[var(--fg-3)]">Healthier options: </span>
          {guardrailView.alternatives.join(", ")}
        </p>
      )}
    </section>
  );

  const agentsCard = (
    <section className="mac-card p-4" key="agents">
      <div className="flex items-center justify-between">
        <p className="mac-label">Agents at work</p>
        <span className="text-[11px] text-[var(--fg-2)] tabular-nums">
          {doneAgents}/{AGENTS.length} done
        </span>
      </div>
      <ul className="mt-2">
        {AGENTS.map((agent) => {
          const status = getAgentStatus(events, agent);
          return (
            <li key={agent} className="flex items-center justify-between py-1.5 text-[13px]">
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
                {agent}
              </span>
              <span className="shrink-0 text-[11px] capitalize text-[var(--fg-3)]">{status}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );

  const insightCard = (
    <section className="mac-card p-4" key="insight">
      <div className="flex items-center justify-between">
        <p className="mac-label">AI insight</p>
        <span className="text-[11px] text-[var(--fg-2)] tabular-nums">Confidence {confidence}%</span>
      </div>
      <p className="mt-2 text-[13px] text-[var(--fg-2)]">
        {latestEvent ? `${latestEvent.agent_name} just emitted ${latestEvent.event}.` : "Start a request to see live agent insights."}
      </p>
      {topPicks.map((line) => (
        <div key={line.item} className="mt-2 rounded-xl bg-[var(--card-soft)] px-3 py-2">
          <p className="text-[13px] font-semibold">
            Top pick: {line.quantity} × {line.option!.item_name}
          </p>
          <p className="text-[11px] text-[var(--fg-2)]">
            {line.option!.vendor} · ETA {line.option!.eta_minutes} min · ₹{line.option!.unit_price} each
          </p>
        </div>
      ))}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--card-soft)]">
        <div className="h-full rounded-full bg-[var(--fg)] transition-all duration-700" style={{ width: `${confidence}%` }} />
      </div>
    </section>
  );

  const consoleCard = (wide: boolean) => (
    <section className="mac-card overflow-hidden" key="console">
      <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-2.5">
        <p className="mac-label">Live agent timeline</p>
        <span className="truncate pl-3 font-mono text-[11px] text-[var(--fg-3)]">{threadId ?? "no thread"}</span>
      </div>
      <div className="grid grid-cols-3 divide-x divide-[var(--line)] border-b border-[var(--line)] text-center">
        {[
          ["Events", String(events.length)],
          ["Awaiting", awaitingConfirmation ? "Yes" : "No"],
          ["Live", threadId ? "On" : "Idle"],
        ].map(([k, v]) => (
          <div key={k} className="py-2">
            <p className="text-[10px] uppercase tracking-wide text-[var(--fg-3)]">{k}</p>
            <p className="text-[15px] font-semibold">{v}</p>
          </div>
        ))}
      </div>
      <div ref={timelineRef} className={`scroll-quiet overflow-y-auto bg-[#1d1d1f] p-3 font-mono text-[12px] text-[#e5e5e7] ${wide ? "h-[60vh]" : "h-72"}`}>
        {events.length === 0 && <p className="text-[#8e8e93]">No events yet. Launch agents to start streaming the timeline.</p>}
        {events.map((evt, idx) => (
          <div key={`${evt.event}-${idx}`} className="animate-fade-in border-b border-white/5 py-2">
            <p className="flex flex-wrap gap-2">
              <span className="font-semibold text-[#ffb86b]">{evt.agent_name}</span>
              <span className="text-[#8be9fd]">{evt.event}</span>
            </p>
            <pre className="mt-1 overflow-x-auto text-[11px] leading-relaxed text-[#a1a1a6]">{JSON.stringify(evt.data, null, 2)}</pre>
          </div>
        ))}
      </div>
    </section>
  );

  // ---------- Other views ----------

  const historyView = (
    <div className="masonry columns-1 md:columns-2 2xl:columns-3">
      {history.length === 0 && (
        <section className="mac-card p-5">
          <p className="font-display text-[20px] font-semibold tracking-tight">No orders yet</p>
          <p className="mt-1 text-[13px] text-[var(--fg-2)]">Orders you confirm will appear here, on any device you sign in from.</p>
        </section>
      )}
      {history.map((entry) => (
        <section key={entry.thread_id} className="mac-card p-4">
          <p className="flex items-center justify-between text-[11px] text-[var(--fg-3)]">
            <span>{new Date(entry.created_at).toLocaleString()}</span>
            <span className="rounded-full bg-[var(--card-soft)] px-2 py-0.5 capitalize text-[var(--fg-2)]">{historyStatusLabel(entry.status)}</span>
          </p>
          {entry.request_text && (
            <p className="mt-2 font-display text-[18px] font-semibold leading-snug tracking-tight">“{entry.request_text}”</p>
          )}
          <ul className="mt-2 divide-y divide-[var(--line)] text-[13px]">
            {entry.lines.map((l, idx) => (
              <li key={idx} className="flex justify-between gap-3 py-1.5">
                <span>
                  {l.quantity} × {l.item} <span className="capitalize text-[var(--fg-3)]">· {l.vendor}</span>
                </span>
                <span className="tabular-nums">₹{l.price_total}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex justify-between text-[13px] font-semibold">
            <span>
              Total
              {entry.payment_method && (
                <span className="ml-2 font-normal text-[var(--fg-2)]">
                  {entry.payment_method === "online" ? "Paid online" : PAYMENT_LABEL[entry.payment_method]}
                </span>
              )}
            </span>
            <span className="tabular-nums">₹{entry.total}</span>
          </p>
          <button className="mac-btn-outline mt-3 w-full py-2 text-[13px]" onClick={() => orderAgain(entry)}>
            <Icon name="refresh" size={14} />
            Order again
          </button>
        </section>
      ))}
    </div>
  );

  const article = (title: string, body: string, footer: string, icon: IconName) => (
    <section className="mac-card p-5" key={title}>
      <h3 className="font-display text-[22px] font-semibold tracking-tight leading-tight">{title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-[var(--fg-2)]">{body}</p>
      <p className="mt-4 flex items-center gap-2 text-[12px] font-medium text-[var(--fg-2)]">
        <Icon name={icon} size={14} />
        {footer}
      </p>
    </section>
  );

  const aboutView = (
    <div className="masonry columns-1 md:columns-2 2xl:columns-3">
      {article(
        "About Mitra AI",
        "Mitra AI is a voice-first multi-agent grocery assistant built for elderly users in India. It translates messy voice or text into structured orders, checks them against each user's own health profile, compares simulated Zepto/Amazon options, pauses for human approval, and executes purchases with reliability controls.",
        "Mitra AI · Overview",
        "info",
      )}
      {article("Backend", "FastAPI + LangGraph orchestrating eight agents, with Clerk session checks, Supabase Postgres for profiles, orders and audit logs, Redis events, and offline Vosk speech-to-text.", "Architecture", "cpu")}
      {article("Frontend", "Next.js + Tailwind with Clerk sign-in, a five-step onboarding, browser speech recognition with a live server fallback, and a WebSocket agent timeline.", "Architecture", "terminal")}
      {article(
        "Terms & conditions",
        "Mitra AI recommendations are assistive and for demonstration purposes. Please review all order details before confirming purchase. Health suggestions are general guardrails and do not replace professional medical advice.",
        "Contact: Disha Dutta · dishadutta61@gmail.com",
        "doc",
      )}
    </div>
  );

  const usesView = (
    <div className="masonry columns-1 md:columns-2 2xl:columns-3">
      {article("Elderly daily grocery ordering", "A simple voice request completes safe daily purchases — no menus, no typing required.", "Use case 1", "bag")}
      {article("Family monitored ordering", "Every purchase pauses for confirmation, and the family is kept in the loop.", "Use case 2", "heart")}
      {article("Health-aware shopping", "Detects high-sugar and high-sodium risks for the user's conditions and suggests safer alternatives.", "Use case 3", "shield")}
      {article("Academic / viva demonstration", "The live multi-agent timeline makes the orchestration transparent step by step.", "Use case 4", "sparkle")}
    </div>
  );

  return (
    <main className="desk min-h-screen text-[var(--fg)] md:p-6">
      <div className="mac-window relative mx-auto flex h-screen max-w-[1500px] overflow-hidden md:h-[calc(100vh-48px)] md:rounded-[14px]">
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-2.5">
            <div className="hidden gap-2 sm:flex" aria-hidden="true">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
            </div>
            <LogoMark size={26} className="shrink-0" />
            <nav className="scroll-quiet -mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => openView(v.id)}
                  aria-current={view === v.id ? "page" : undefined}
                  className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1 text-[13px] transition ${
                    view === v.id
                      ? "bg-[var(--card)] font-medium shadow-[var(--shadow-card)]"
                      : "text-[var(--fg-2)] hover:bg-[var(--hover)]"
                  }`}
                >
                  <Icon name={v.icon} size={14} className={view === v.id ? "" : "text-[var(--fg-3)]"} />
                  {v.label}
                  {v.id === "history" && history.length > 0 && <span className="text-[11px] text-[var(--fg-3)]">{history.length}</span>}
                </button>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-1">
              <span className="mr-1 hidden items-center gap-1.5 text-[12px] text-[var(--fg-2)] lg:flex">
                <span className={`h-1.5 w-1.5 rounded-full ${threadId ? "bg-[var(--ok)]" : "bg-[var(--fg-3)]"}`} />
                {threadId ? (awaitingConfirmation ? "Awaiting approval" : "Live") : "Idle"}
              </span>
              <button
                className="mac-btn !p-1.5 text-[var(--fg-2)]"
                onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
                title={theme === "light" ? "Dark mode" : "Light mode"}
              >
                <Icon name={theme === "light" ? "moon" : "sun"} />
              </button>
              <button className="mac-btn-primary px-3 py-1.5 text-[13px]" onClick={newOrder} title="New order">
                <Icon name="plus" size={14} />
                <span className="hidden sm:inline">New Order</span>
              </button>
              <span className="ml-1 flex items-center">
                <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
              </span>
            </div>
          </header>

          <div className="scroll-quiet flex-1 overflow-y-auto p-4">
            {view === "assistant" && (
              <div className="masonry columns-1 lg:columns-2 2xl:columns-3">
                {voiceCard}
                {previewCard}
                {approvalCard}
                {replyCard}
                {orderCard}
                {healthCard}
                {agentsCard}
                {insightCard}
              </div>
            )}
            {view === "history" && historyView}
            {view === "profile" && (
              <Onboarding
                key={profile.id}
                mode="edit"
                initial={profile}
                onSaved={(p) => {
                  onProfileSaved(p);
                  setLanguage(p.voice.voice_language);
                }}
              />
            )}
            {view === "console" && (
              <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
                {consoleCard(true)}
                <div className="space-y-4">
                  {agentsCard}
                  {insightCard}
                </div>
              </div>
            )}
            {view === "about" && aboutView}
            {view === "uses" && usesView}
          </div>
        </section>
      </div>
    </main>
  );
}

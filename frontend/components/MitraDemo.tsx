"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
type LeftTab = "assistant" | "about" | "uses";
type HistoryEntry = {
  id: string;
  time: string;
  threadId: string;
  request: string;
  status: string;
  message: string;
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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const QUICK_PROMPTS = [
  "Jaldi 2 packet oats mangao",
  "Diabetic-friendly biscuits chahiye",
  "Aaj raat ke liye low salt soup",
  "1 kg apple aur banana order karo",
];

function wsUrl(threadId: string): string {
  const base = API_BASE.replace("http://", "ws://").replace("https://", "wss://");
  return `${base}/ws/events/${threadId}`;
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

  const item = String(recommendation?.item_name ?? "Not selected");
  const vendor = String(recommendation?.vendor ?? "Pending");
  const eta = recommendation?.eta_minutes ? `${recommendation.eta_minutes} min` : "--";
  const qty = Number((state.intent as Record<string, unknown> | undefined)?.quantity ?? 0);
  const unitPrice = Number(recommendation?.unit_price ?? 0);
  const total = qty > 0 && unitPrice > 0 ? `INR ${qty * unitPrice}` : "--";

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
    return { status: "cancelled", item, vendor, eta, total, note: "Order was cancelled/skipped." };
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

export default function MitraDemo() {
  const [activeTab, setActiveTab] = useState<LeftTab>("assistant");
  const [input, setInput] = useState("Jaldi se 2 packet oats order kar do");
  const [assistantText, setAssistantText] = useState("Namaste, Mitra AI ready hai. Aap boliye, main sambhal loonga.");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [confirmPayload, setConfirmPayload] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [listening, setListening] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
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
  const topRecommendation = useMemo(() => {
    if (!confirmPayload) return null;
    const rec = confirmPayload.recommendation as Record<string, unknown> | undefined;
    if (!rec) return null;
    return {
      item: String(rec.item_name ?? "Unknown"),
      vendor: String(rec.vendor ?? "Unknown"),
      eta: String(rec.eta_minutes ?? "--"),
      price: String(rec.unit_price ?? "--"),
    };
  }, [confirmPayload]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("mitra-theme") as ThemeMode | null;
    setTheme(stored === "dark" ? "dark" : "light");
    const hasSpeech = Boolean(
      (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition ||
        (window as Window & { SpeechRecognition?: unknown }).SpeechRecognition
    );
    setSpeechSupported(hasSpeech);
    const storedHistory = window.localStorage.getItem("mitra-history");
    if (storedHistory) {
      try {
        setHistory(JSON.parse(storedHistory) as HistoryEntry[]);
      } catch {
        setHistory([]);
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("mitra-theme", theme);
  }, [theme]);

  function persistHistory(next: HistoryEntry[]) {
    setHistory(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("mitra-history", JSON.stringify(next));
    }
  }

  function pushHistory(entry: Omit<HistoryEntry, "id" | "time">) {
    const nextEntry: HistoryEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      time: new Date().toLocaleString(),
    };
    setHistory((prev) => {
      const next = [nextEntry, ...prev].slice(0, 20);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("mitra-history", JSON.stringify(next));
      }
      return next;
    });
  }

  function clearWorkspace() {
    wsRef.current?.close();
    setThreadId(null);
    setEvents([]);
    setAwaitingConfirmation(false);
    setConfirmPayload(null);
    setListening(false);
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
    setAssistantText("Workspace cleared. Aap naya request bol sakte hain.");
  }

  function clearHistory() {
    persistHistory([]);
  }

  useEffect(() => {
    if (!threadId) return;
    wsRef.current?.close();

    const ws = new WebSocket(wsUrl(threadId));
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
          thread_id,
        },
      ]);
    };

    return () => ws.close();
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

  async function startOrder(message: string) {
    if (!message.trim()) return;
    lastRequestRef.current = message;
    setEvents([]);
    setSubmitting(true);
    setAssistantText("Request process ho raha hai. Agents kaam kar rahe hain...");

    try {
      const res = await fetch(`${API_BASE}/api/v1/orders/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, user_id: "dadaji-001" }),
      });

      if (!res.ok) {
        setAssistantText("Server se connect nahi hua. Please retry.");
        return;
      }

      const data = (await res.json()) as StartResponse;
      setThreadId(data.thread_id);
      setAssistantText(data.message);
      setAwaitingConfirmation(data.confirmation_required);
      setConfirmPayload(data.confirmation_payload ?? null);
      setOrderSummary(buildOrderSummary(data));
      const guardrail = (data.state?.guardrail ?? {}) as Record<string, unknown>;
      setGuardrailView({
        riskLevel: String(guardrail.risk_level ?? "low"),
        warnings: (guardrail.warnings as string[]) ?? [],
        clinicalNotes: (guardrail.clinical_notes as string[]) ?? [],
        alternatives: (guardrail.healthier_alternatives as string[]) ?? [],
      });
      pushHistory({
        threadId: data.thread_id,
        request: message,
        status: data.status,
        message: data.message,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function resumeOrder(approved: boolean) {
    if (!threadId) return;
    setSubmitting(true);
    setAssistantText(approved ? "Order confirm kar raha hoon..." : "Order cancel kar diya jaa raha hai...");

    try {
      const res = await fetch(`${API_BASE}/api/v1/orders/${threadId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, user_id: "dadaji-001" }),
      });

      if (!res.ok) {
        setAssistantText("Resume failed. Please retry.");
        return;
      }

      const data = (await res.json()) as StartResponse;
      setAssistantText(data.message);
      setAwaitingConfirmation(data.confirmation_required);
      setConfirmPayload(data.confirmation_payload ?? null);
      setOrderSummary(buildOrderSummary(data));
      const guardrail = (data.state?.guardrail ?? {}) as Record<string, unknown>;
      setGuardrailView({
        riskLevel: String(guardrail.risk_level ?? "low"),
        warnings: (guardrail.warnings as string[]) ?? [],
        clinicalNotes: (guardrail.clinical_notes as string[]) ?? [],
        alternatives: (guardrail.healthier_alternatives as string[]) ?? [],
      });
      pushHistory({
        threadId,
        request: lastRequestRef.current,
        status: data.status,
        message: data.message,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handleMic() {
    const SpeechRecognition =
      (window as Window & { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }).SpeechRecognition ||
      (window as Window & { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setAssistantText("Speech API supported nahi hai. Text input use kijiye.");
      return;
    }

    const recognition: any = new SpeechRecognition();
    recognition.lang = "hi-IN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setListening(true);
      setAssistantText("Sun raha hoon... aap bolte rahiye.");
    };

    recognition.onresult = async (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInput(transcript);
      await startOrder(transcript);
    };

    recognition.onerror = () => {
      setAssistantText("Voice capture error. Please dubara boliye.");
      setListening(false);
    };

    recognition.onend = () => setListening(false);
    recognition.start();
  }

  const latestEvent = events.length > 0 ? events[events.length - 1] : null;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--fg-primary)] transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(255,121,198,0.18),transparent_33%),radial-gradient(circle_at_80%_18%,rgba(236,72,153,0.18),transparent_30%),radial-gradient(circle_at_70%_85%,rgba(255,183,197,0.24),transparent_35%)]" />

      <div className="relative mx-auto flex w-full max-w-[1700px] flex-col gap-4 p-4 md:p-6">
        <header className="glass-card animate-fade-in flex items-center justify-between rounded-2xl p-4 md:p-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-pink-500">Mitra AI Platform</p>
            <h1 className="mt-1 text-2xl font-bold md:text-3xl">Voice-First Multi-Agent Retail Assistant</h1>
          </div>
          <button
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            className="rounded-xl border border-pink-300/70 bg-white/70 px-4 py-2 text-sm font-semibold text-pink-700 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg dark:border-pink-900/80 dark:bg-slate-900/80 dark:text-pink-200"
          >
            {theme === "light" ? "Dark Mode" : "Light Mode"}
          </button>
        </header>

        <div className="grid min-h-[82vh] grid-cols-1 gap-4 xl:grid-cols-[1.2fr_1fr]">
          <section className="glass-card animate-slide-up rounded-3xl p-5 md:p-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold uppercase tracking-[0.22em] text-pink-500">Mitra Workspace</p>
                <h2 className="mt-1 text-4xl font-black leading-tight md:text-6xl">Mitra AI</h2>
              </div>
              <div className="rounded-2xl border border-pink-200 bg-pink-100/80 px-4 py-2 text-sm font-semibold text-pink-700 dark:border-pink-900 dark:bg-pink-950/30 dark:text-pink-200">
                Confidence {confidence}%
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                onClick={() => setActiveTab("assistant")}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                  activeTab === "assistant"
                    ? "bg-pink-500 text-white shadow-md"
                    : "border border-pink-200 bg-white text-pink-700 dark:border-pink-900 dark:bg-slate-900 dark:text-pink-200"
                }`}
              >
                Assistant
              </button>
              <button
                onClick={() => setActiveTab("about")}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                  activeTab === "about"
                    ? "bg-pink-500 text-white shadow-md"
                    : "border border-pink-200 bg-white text-pink-700 dark:border-pink-900 dark:bg-slate-900 dark:text-pink-200"
                }`}
              >
                About Project
              </button>
              <button
                onClick={() => setActiveTab("uses")}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                  activeTab === "uses"
                    ? "bg-pink-500 text-white shadow-md"
                    : "border border-pink-200 bg-white text-pink-700 dark:border-pink-900 dark:bg-slate-900 dark:text-pink-200"
                }`}
              >
                Uses
              </button>
            </div>

            {activeTab === "assistant" && (
              <>
                <div className="mt-6 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
                  <div className="relative overflow-hidden rounded-2xl border border-pink-200/80 bg-gradient-to-br from-white to-pink-50 p-5 shadow-sm transition-all duration-500 dark:border-pink-900/80 dark:from-slate-900 dark:to-slate-800">
                    <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-pink-200/60 blur-2xl dark:bg-pink-700/30" />
                    <p className="text-sm uppercase tracking-[0.18em] text-pink-500">Mitra Response</p>
                    <p className="mt-3 text-2xl font-bold leading-snug md:text-3xl">{assistantText}</p>
                  </div>

                  <div className="rounded-2xl border border-pink-200/80 bg-white/85 p-4 dark:border-pink-900/70 dark:bg-slate-900/85">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-pink-500">AI Insight</p>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                      {latestEvent
                        ? `${latestEvent.agent_name} just emitted ${latestEvent.event}.`
                        : "Start a request to activate live inference insights."}
                    </p>
                    {topRecommendation && (
                      <div className="mt-3 rounded-xl bg-pink-100/70 p-3 text-sm dark:bg-pink-900/25">
                        <p className="font-semibold">Top pick: {topRecommendation.item}</p>
                        <p className="text-xs opacity-80">{topRecommendation.vendor} | ETA {topRecommendation.eta} min | INR {topRecommendation.price}</p>
                      </div>
                    )}
                    <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-pink-100 dark:bg-slate-700">
                      <div className="h-full rounded-full bg-gradient-to-r from-pink-500 to-fuchsia-400 transition-all duration-700" style={{ width: `${confidence}%` }} />
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-pink-200 bg-white/90 p-4 dark:border-pink-900 dark:bg-slate-900/85">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold uppercase tracking-[0.18em] text-pink-500">AI Agents At Work</p>
                    <p className="text-xs text-slate-500">Live orchestration</p>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {AGENTS.map((agent) => {
                      const status = getAgentStatus(events, agent);
                      const statusClass =
                        status === "done"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"
                          : status === "running"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
                          : status === "error"
                          ? "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
                      return (
                        <div key={agent} className={`flex items-center justify-between rounded-xl px-3 py-2 text-sm ${statusClass}`}>
                          <span className="font-medium">{agent}</span>
                          <span className="text-xs font-semibold uppercase">{status}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-pink-200 bg-white/90 p-4 dark:border-pink-900 dark:bg-slate-900/85">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold uppercase tracking-[0.18em] text-pink-500">Clinical Guardrail</p>
                    <span className="rounded-full bg-pink-100 px-3 py-1 text-xs font-semibold uppercase text-pink-700 dark:bg-pink-900/30 dark:text-pink-200">
                      Risk {guardrailView.riskLevel}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2">
                    {guardrailView.warnings.length === 0 && (
                      <p className="text-sm text-slate-600 dark:text-slate-300">No clinical flags detected for this request.</p>
                    )}
                    {guardrailView.warnings.map((w, idx) => (
                      <div key={`warn-${idx}`} className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
                        {w}
                      </div>
                    ))}
                    {guardrailView.clinicalNotes.map((n, idx) => (
                      <div key={`note-${idx}`} className="rounded-xl bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
                        {n}
                      </div>
                    ))}
                    {guardrailView.alternatives.length > 0 && (
                      <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-200">
                        Suggested alternatives: {guardrailView.alternatives.join(", ")}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-6 rounded-2xl border border-pink-200 bg-white/90 p-5 dark:border-pink-900 dark:bg-slate-900/85">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-pink-500">Voice Control</p>
                  <div className="mt-4 grid items-center gap-4 md:grid-cols-[170px_1fr]">
                    <button
                      onClick={handleMic}
                      className={`relative mx-auto flex h-36 w-36 items-center justify-center rounded-full text-sm font-extrabold text-white transition ${
                        listening
                          ? "bg-gradient-to-br from-fuchsia-600 to-pink-500 animate-pulse-glow"
                          : "bg-gradient-to-br from-rose-500 to-pink-500 hover:scale-[1.02]"
                      }`}
                    >
                      <span className="z-10 text-center leading-tight">{listening ? "Listening" : "Tap Mic"}</span>
                      <span className="absolute inset-3 rounded-full border border-white/25" />
                    </button>

                    <div>
                      <p className="text-lg font-semibold">{listening ? "Voice input active" : "Ready for voice input"}</p>
                      <p className="text-sm text-slate-600 dark:text-slate-300">Speak naturally in Hindi, Hinglish, or English. Mitra AI will parse intent and run guardrails.</p>
                      <div className="mt-3 flex h-8 items-end gap-1.5">
                        {[8, 14, 20, 12, 18, 9, 16, 11].map((h, idx) => (
                          <span
                            key={idx}
                            className={`w-2 rounded-full bg-pink-400 ${listening ? "animate-wave" : "opacity-40"}`}
                            style={{ height: `${h}px`, animationDelay: `${idx * 80}ms` }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-6">
                  <label className="text-lg font-semibold" htmlFor="order-input">
                    Voice/Text Input
                  </label>
                  <textarea
                    id="order-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    className="mt-2 h-28 w-full rounded-2xl border border-pink-200 bg-white/90 p-4 text-lg font-medium shadow-sm outline-none transition focus:border-pink-400 focus:ring-2 focus:ring-pink-200 dark:border-pink-900 dark:bg-slate-900/90 dark:focus:border-pink-500 dark:focus:ring-pink-900"
                  />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {QUICK_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => setInput(prompt)}
                      className="rounded-full border border-pink-200 bg-white px-3 py-1.5 text-xs font-semibold text-pink-700 transition hover:-translate-y-0.5 hover:shadow-md dark:border-pink-900 dark:bg-slate-900 dark:text-pink-200"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={clearWorkspace}
                    className="rounded-full border border-pink-300 bg-white px-4 py-2 text-sm font-semibold text-pink-700 transition hover:-translate-y-0.5 hover:shadow-md dark:border-pink-900 dark:bg-slate-900 dark:text-pink-200"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setShowHistory((v) => !v)}
                    className="rounded-full border border-pink-300 bg-white px-4 py-2 text-sm font-semibold text-pink-700 transition hover:-translate-y-0.5 hover:shadow-md dark:border-pink-900 dark:bg-slate-900 dark:text-pink-200"
                  >
                    {showHistory ? "Hide History" : "See History"}
                  </button>
                  <button
                    onClick={clearHistory}
                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:-translate-y-0.5 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    Clear History
                  </button>
                </div>

                {showHistory && (
                  <div className="mt-4 rounded-2xl border border-pink-200 bg-white/90 p-4 dark:border-pink-900 dark:bg-slate-900/85">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-pink-500">Recent History</p>
                      <p className="text-xs text-slate-500">{history.length} entries</p>
                    </div>
                    <div className="mt-3 max-h-44 space-y-2 overflow-y-auto">
                      {history.length === 0 && <p className="text-sm text-slate-500">No history yet.</p>}
                      {history.map((entry) => (
                        <div key={entry.id} className="rounded-xl border border-pink-100 bg-pink-50/70 p-3 text-sm dark:border-pink-900 dark:bg-pink-950/20">
                          <p className="font-semibold">{entry.request}</p>
                          <p className="text-xs opacity-80">{entry.time} | {entry.status} | {entry.threadId}</p>
                          <p className="mt-1 text-xs">{entry.message}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <button
                    onClick={handleMic}
                    className={`relative overflow-hidden rounded-2xl px-6 py-5 text-2xl font-black text-white shadow-lg transition ${
                      listening
                        ? "bg-gradient-to-r from-pink-600 to-fuchsia-500 animate-pulse-glow"
                        : "bg-gradient-to-r from-rose-500 to-pink-500 hover:-translate-y-0.5"
                    }`}
                  >
                    <span className="relative z-10">{listening ? "Listening..." : "Tap to Speak"}</span>
                    <span className="absolute inset-0 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent)] animate-shimmer" />
                  </button>

                  <button
                    onClick={() => startOrder(input)}
                    disabled={submitting}
                    className="rounded-2xl bg-gradient-to-r from-fuchsia-600 to-pink-500 px-6 py-5 text-2xl font-black text-white shadow-lg transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? "Running..." : "Launch Agents"}
                  </button>
                </div>

                {awaitingConfirmation && (
                  <div ref={confirmationRef} className="mt-6 animate-fade-in rounded-2xl border border-pink-300 bg-pink-50/95 p-5 shadow-md dark:border-pink-800 dark:bg-pink-950/20">
                    <p className="text-lg font-bold">Purchase Approval Required</p>
                    <pre className="mt-3 max-h-52 overflow-x-auto rounded-xl bg-white p-3 text-xs dark:bg-slate-900">{JSON.stringify(confirmPayload, null, 2)}</pre>
                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                      <button
                        onClick={() => resumeOrder(true)}
                        disabled={submitting}
                        className="rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 px-5 py-4 text-xl font-extrabold text-white transition hover:-translate-y-0.5 disabled:opacity-60"
                      >
                        Confirm Order
                      </button>
                      <button
                        onClick={() => resumeOrder(false)}
                        disabled={submitting}
                        className="rounded-xl bg-gradient-to-r from-slate-600 to-slate-500 px-5 py-4 text-xl font-extrabold text-white transition hover:-translate-y-0.5 disabled:opacity-60"
                      >
                        Cancel Order
                      </button>
                    </div>
                  </div>
                )}

                {!speechSupported && <p className="mt-3 text-sm font-medium text-rose-600 dark:text-rose-300">Speech API unavailable in this browser. Text mode active.</p>}

                <div className="mt-6 rounded-2xl border border-pink-200 bg-gradient-to-br from-white to-pink-50 p-5 dark:border-pink-900 dark:from-slate-900 dark:to-slate-800">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-pink-500">Order Completion</p>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div className="rounded-xl bg-pink-100/70 p-3 dark:bg-pink-900/25">
                      <p className="text-xs opacity-80">Status</p>
                      <p className="text-lg font-bold capitalize">{orderSummary.status.replaceAll("_", " ")}</p>
                    </div>
                    <div className="rounded-xl bg-pink-100/70 p-3 dark:bg-pink-900/25">
                      <p className="text-xs opacity-80">Vendor</p>
                      <p className="text-lg font-bold">{orderSummary.vendor}</p>
                    </div>
                    <div className="rounded-xl bg-pink-100/70 p-3 dark:bg-pink-900/25">
                      <p className="text-xs opacity-80">Item</p>
                      <p className="text-lg font-bold">{orderSummary.item}</p>
                    </div>
                    <div className="rounded-xl bg-pink-100/70 p-3 dark:bg-pink-900/25">
                      <p className="text-xs opacity-80">ETA / Total</p>
                      <p className="text-lg font-bold">{orderSummary.eta} | {orderSummary.total}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">{orderSummary.note}</p>
                </div>
              </>
            )}

            {activeTab === "about" && (
              <div className="mt-6 rounded-2xl border border-pink-200 bg-white/90 p-6 leading-relaxed dark:border-pink-900 dark:bg-slate-900/85">
                <h3 className="text-2xl font-bold">About This Project</h3>
                <p className="mt-3 text-slate-700 dark:text-slate-300">
                  Mitra AI is a voice-first multi-agent grocery assistant built for elderly users in India. It translates messy voice/text into structured orders,
                  applies health guardrails, compares simulated Zepto/Amazon options, pauses for human approval, and executes purchases with reliability controls.
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-xl bg-pink-100/70 p-4 dark:bg-pink-900/25">
                    <p className="font-semibold">Backend</p>
                    <p className="text-sm">FastAPI + LangGraph + Redis + PostgreSQL</p>
                  </div>
                  <div className="rounded-xl bg-pink-100/70 p-4 dark:bg-pink-900/25">
                    <p className="font-semibold">Frontend</p>
                    <p className="text-sm">Next.js + Tailwind + Web Speech API + Live WebSocket timeline</p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "uses" && (
              <div className="mt-6 rounded-2xl border border-pink-200 bg-white/90 p-6 dark:border-pink-900 dark:bg-slate-900/85">
                <h3 className="text-2xl font-bold">Use Cases</h3>
                <div className="mt-4 grid gap-3">
                  <div className="rounded-xl bg-pink-100/70 p-4 dark:bg-pink-900/25">
                    <p className="font-semibold">1. Elderly daily grocery ordering</p>
                    <p className="text-sm text-slate-700 dark:text-slate-300">Simple voice request to complete safe daily purchases.</p>
                  </div>
                  <div className="rounded-xl bg-pink-100/70 p-4 dark:bg-pink-900/25">
                    <p className="font-semibold">2. Family monitored ordering</p>
                    <p className="text-sm text-slate-700 dark:text-slate-300">HITL confirmation plus family webhook notifications.</p>
                  </div>
                  <div className="rounded-xl bg-pink-100/70 p-4 dark:bg-pink-900/25">
                    <p className="font-semibold">3. Health-aware shopping</p>
                    <p className="text-sm text-slate-700 dark:text-slate-300">Detects high-sugar/high-sodium risks and suggests safer alternatives.</p>
                  </div>
                  <div className="rounded-xl bg-pink-100/70 p-4 dark:bg-pink-900/25">
                    <p className="font-semibold">4. Academic / Viva demonstration</p>
                    <p className="text-sm text-slate-700 dark:text-slate-300">Live multi-agent event timeline makes orchestration transparent.</p>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="glass-card animate-slide-up rounded-3xl p-5 md:p-6" style={{ animationDelay: "120ms" }}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl font-bold">Developer Console</h3>
              <div className="rounded-xl border border-pink-200 bg-white/80 px-3 py-1 text-xs font-semibold text-pink-700 dark:border-pink-900 dark:bg-slate-900 dark:text-pink-200">
                Thread: {threadId ?? "-"}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-pink-100/80 p-3 text-center dark:bg-pink-950/30">
                <p className="text-xs uppercase">Events</p>
                <p className="text-xl font-black">{events.length}</p>
              </div>
              <div className="rounded-xl bg-blue-100/80 p-3 text-center dark:bg-blue-950/30">
                <p className="text-xs uppercase">Awaiting</p>
                <p className="text-xl font-black">{awaitingConfirmation ? "Yes" : "No"}</p>
              </div>
              <div className="rounded-xl bg-emerald-100/80 p-3 text-center dark:bg-emerald-950/30">
                <p className="text-xs uppercase">Live</p>
                <p className="text-xl font-black">{threadId ? "On" : "Idle"}</p>
              </div>
            </div>

            <div ref={timelineRef} className="mt-4 h-[67vh] overflow-y-auto rounded-2xl border border-pink-200/70 bg-slate-950 p-4 font-mono text-sm text-slate-100 dark:border-pink-900">
              {events.length === 0 && <p className="text-slate-400">No events yet. Launch agents to start streaming timeline.</p>}
              {events.map((evt, idx) => (
                <div key={`${evt.event}-${idx}`} className="mb-3 animate-fade-in rounded-xl border border-slate-700 bg-slate-900/80 p-3">
                  <p className="flex flex-wrap gap-2">
                    <span className="font-bold text-fuchsia-300">[{evt.agent_name}]</span>
                    <span className="font-semibold text-cyan-300">{evt.event}</span>
                  </p>
                  <pre className="mt-1 overflow-x-auto text-xs leading-relaxed text-slate-300">{JSON.stringify(evt.data, null, 2)}</pre>
                </div>
              ))}
            </div>
          </section>
        </div>

        <footer className="glass-card animate-fade-in rounded-2xl p-4 md:p-5">
          <h4 className="text-sm font-bold uppercase tracking-[0.22em] text-pink-500">Terms & Conditions</h4>
          <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
            Mitra AI recommendations are assistive and for demonstration purposes. Please review all order details before
            confirming purchase. Health suggestions are general guardrails and do not replace professional medical advice.
            By using this platform, you agree to verify product selection, quantity, and pricing at confirmation stage.
          </p>
          <p className="mt-3 text-sm font-semibold text-pink-700 dark:text-pink-200">
            For queries, contact founding team: Disha Dutta | dishadutta61@gmail.com
          </p>
        </footer>
      </div>
    </main>
  );
}

/** The user's Mitra profile, stored in Supabase through the backend (GET / PUT /api/v1/profile/me). */
export type FamilyContact = { name: string; relation: string; phone: string; email: string };
export type PaymentMethod = "cod" | "upi_on_delivery" | "online";
export type AlertSettings = { sms: boolean; email: boolean; notify_family: boolean };
export type Store = "zepto" | "amazon";

export type Profile = {
  id?: string;
  name: string;
  age: number;
  phone: string;
  email: string;
  address: string;
  language: "hinglish" | "hindi" | "english";
  preferred_stores: Store[];
  payment_method: PaymentMethod;
  conditions: string[];
  allergies: string[];
  medications: string[];
  diet_notes: string;
  family_contacts: FamilyContact[];
  voice: { voice_language: "en-IN" | "hi-IN"; script: "roman" | "devanagari"; read_aloud: boolean };
  alerts: AlertSettings;
  onboarding_completed: boolean;
};

export const EMPTY_PROFILE: Profile = {
  name: "",
  age: 65,
  phone: "",
  email: "",
  address: "",
  language: "hinglish",
  preferred_stores: ["zepto", "amazon"],
  payment_method: "cod",
  conditions: [],
  allergies: [],
  medications: [],
  diet_notes: "",
  family_contacts: [],
  voice: { voice_language: "en-IN", script: "roman", read_aloud: true },
  alerts: { sms: true, email: true, notify_family: true },
  onboarding_completed: false,
};

/** Conditions the Health Guardrail agent has rules for (keys match backend health_rules). */
export const CONDITIONS: { value: string; label: string; hint: string }[] = [
  { value: "diabetes", label: "Diabetes", hint: "Flags sugary items" },
  { value: "hypertension", label: "High blood pressure", hint: "Flags salty items" },
  { value: "ckd", label: "Kidney disease", hint: "Flags potassium-heavy items" },
];

export const MEDICATION_SUGGESTIONS = ["metformin", "amlodipine", "warfarin"];
export const ALLERGY_SUGGESTIONS = ["peanut", "milk", "wheat", "soy"];

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  online: "Pay now (UPI / card)",
  cod: "Cash on delivery",
  upi_on_delivery: "UPI on delivery",
};

export const PAYMENT_HINT: Record<PaymentMethod, string> = {
  online: "Secure payment by Razorpay before the order is placed",
  cod: "Pay cash when it arrives",
  upi_on_delivery: "Scan a UPI QR when it arrives",
};

/** Payment methods to offer: "Pay now" only when the server has Razorpay keys. */
export function paymentMethods(onlineEnabled: boolean): PaymentMethod[] {
  return onlineEnabled ? ["online", "cod", "upi_on_delivery"] : ["cod", "upi_on_delivery"];
}

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

/** fetch() against the backend with the Clerk session token attached. */
export async function apiFetch(getToken: () => Promise<string | null>, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

/** Reads text aloud in the user's voice language (no-op where speech synthesis is missing). */
export function speak(text: string, lang: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 0.92;
  window.speechSynthesis.speak(utterance);
}

/** Whether online payment (Razorpay) is switched on in the backend. */
export async function fetchOnlinePaymentEnabled(getToken: () => Promise<string | null>): Promise<boolean> {
  try {
    const res = await apiFetch(getToken, "/api/v1/orders/payment-config");
    return res.ok && ((await res.json()) as { online_enabled: boolean }).online_enabled;
  } catch {
    return false;
  }
}

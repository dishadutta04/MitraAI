/** Razorpay Checkout (https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/). */

export type PaymentStart = {
  key_id: string;
  razorpay_order_id: string;
  amount_paise: number;
  currency: string;
  name: string;
  description: string;
  prefill: Record<string, string>;
};

export type PaymentSuccess = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

type RazorpayInstance = { open: () => void; on: (event: string, cb: (r: { error?: { description?: string } }) => void) => void };
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const CHECKOUT_JS = "https://checkout.razorpay.com/v1/checkout.js";
let loading: Promise<void> | null = null;

function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_JS;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error("Couldn't load the payment window. Check your internet connection."));
    };
    document.body.appendChild(script);
  });
  return loading;
}

/** Opens Checkout; resolves with Razorpay's signed response, null if closed, or rejects if every attempt failed. */
export async function payWithRazorpay(start: PaymentStart, accent = "#e8326b"): Promise<PaymentSuccess | null> {
  await loadCheckout();
  return new Promise((resolve, reject) => {
    // A failed attempt stays in the window so the user can retry; only report it if they give up.
    let lastFailure = "";
    const checkout = new window.Razorpay!({
      key: start.key_id,
      order_id: start.razorpay_order_id,
      amount: start.amount_paise,
      currency: start.currency,
      name: start.name,
      description: start.description,
      prefill: start.prefill,
      theme: { color: accent },
      handler: (response: PaymentSuccess) => resolve(response),
      modal: {
        ondismiss: () => (lastFailure ? reject(new Error(lastFailure)) : resolve(null)),
        confirm_close: true,
      },
    });
    checkout.on("payment.failed", (r) => {
      lastFailure = `${r.error?.description || "Payment failed"}. No money was taken.`;
    });
    checkout.open();
  });
}

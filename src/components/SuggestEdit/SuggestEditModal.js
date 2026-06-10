/**
 * Public "Suggest an edit" modal. Posts to /api/suggest; suggestions land in
 * the admin review queue — nothing changes on the map until approved.
 * Context (route/train/operator) is pre-filled by the opener.
 */
import { useState } from "react";

const TYPES = [
  { value: "correction", label: "Something is wrong" },
  { value: "missing-train", label: "A train is missing" },
  { value: "price", label: "Price info" },
  { value: "booking", label: "Booking link" },
];

export default function SuggestEditModal({ context = {}, onClose }) {
  const [type, setType] = useState("correction");
  const [message, setMessage] = useState("");
  const [fromPrice, setFromPrice] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [bookingUrl, setBookingUrl] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — humans never see it
  const [state, setState] = useState({ phase: "idle", error: null });

  async function submit(e) {
    e.preventDefault();
    setState({ phase: "sending", error: null });
    try {
      const fields = {};
      if (type === "price" && fromPrice !== "") {
        fields.fromPrice = Number(fromPrice);
        fields.currency = currency;
      }
      if (type === "booking" && bookingUrl) fields.bookingUrl = bookingUrl;

      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          context,
          message,
          fields,
          email: email || undefined,
          website,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ phase: "idle", error: json.error || `Failed (${res.status})` });
        return;
      }
      setState({ phase: "done", error: null });
    } catch (err) {
      setState({ phase: "idle", error: err.message });
    }
  }

  return (
    <div
      className="fixed inset-0 z-[1300] flex items-end min-[480px]:items-center justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Suggest an edit"
    >
      <div
        className="bg-white w-full min-[480px]:max-w-md min-[480px]:rounded-xl rounded-t-xl shadow-xl p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">
            Suggest an edit
            {context.trainName ? ` — ${context.trainName}` : ""}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-700 text-lg leading-none"
          >
            ×
          </button>
        </div>

        {state.phase === "done" ? (
          <div className="space-y-3">
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
              Thanks! Your suggestion was received and will be reviewed before it
              appears on the map.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full px-3 py-2 text-sm font-medium rounded-md bg-black text-white"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setType(t.value)}
                  className={`px-2 py-1.5 text-xs rounded-md border text-left ${
                    type === t.value
                      ? "border-black bg-gray-900 text-white"
                      : "border-gray-200 text-gray-600 hover:border-gray-400"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {type === "price" && (
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={fromPrice}
                  onChange={(e) => setFromPrice(e.target.value)}
                  placeholder="From price, e.g. 49.90"
                  className="flex-1 text-sm border border-gray-200 rounded-md px-2 py-1.5"
                />
                <input
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  maxLength={3}
                  className="w-16 text-sm border border-gray-200 rounded-md px-2 py-1.5"
                  aria-label="Currency"
                />
              </div>
            )}
            {type === "booking" && (
              <input
                type="url"
                value={bookingUrl}
                onChange={(e) => setBookingUrl(e.target.value)}
                placeholder="https://… booking page"
                className="w-full text-sm border border-gray-200 rounded-md px-2 py-1.5"
              />
            )}

            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              minLength={10}
              maxLength={1000}
              rows={4}
              placeholder="What should change? Sources/links welcome. (min 10 characters)"
              className="w-full text-sm border border-gray-200 rounded-md px-2 py-1.5"
            />

            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email (optional, for follow-up)"
              className="w-full text-sm border border-gray-200 rounded-md px-2 py-1.5"
            />

            {/* Honeypot: hidden from humans, tempting for bots */}
            <input
              type="text"
              name="website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="absolute -left-[9999px] h-0 w-0 opacity-0"
            />

            {state.error && <p className="text-xs text-red-600">{state.error}</p>}

            <button
              type="submit"
              disabled={state.phase === "sending"}
              className="w-full px-3 py-2 text-sm font-medium rounded-md bg-black text-white disabled:opacity-50"
            >
              {state.phase === "sending" ? "Sending…" : "Send suggestion"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// Server-side proxy to the Google Apps Script backend.
//
// Why this exists: customer phones were failing/timing out when JavaScript in the browser
// tried to reach script.google.com directly, even though the backend itself responds in
// 2-3 seconds when tested directly. Routing through this same-origin endpoint means the
// customer's browser only ever talks to dessiemart.vercel.app (fast, reliable, same place
// the page itself loaded from) — Vercel's servers do the actual talking to Google, which is
// a fast, reliable connection since it's server-to-server, not phone-to-Google over mobile data.
//
// The frontend's apiGet/apiPost are unchanged apart from API_URL now pointing here instead
// of directly at script.google.com.

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbynxNksVH5dgUUcwfyAD-LzAKC41GUtfYUZM61Ml-RUilBX7Prpks8BiJpTiidpH_Yu/exec";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") {
      const params = new URLSearchParams(req.query);
      const url = APPS_SCRIPT_URL + "?" + params.toString();
      const upstream = await fetch(url, { method: "GET" });
      const text = await upstream.text();
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(text);
    }

    if (req.method === "POST") {
      // The frontend sends a JSON string with a text/plain content-type (deliberately, to
      // avoid a CORS preflight on the Apps Script side) — req.body already comes through as
      // that raw string for a text/plain request, so we forward it unchanged.
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
      const upstream = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: rawBody
      });
      const text = await upstream.text();
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(text);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(502).json({ error: "Proxy request to backend failed: " + (e && e.message || String(e)) });
  }
}

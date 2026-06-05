// functions/api/pix-cashin.js
import { GATEWAYS } from "../../lib/gateways.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export async function onRequest({ request }) {
  if (request.method === "OPTIONS") return new Response(null, { status: 200, headers: CORS });
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: CORS });
  }

  let body = {};
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: "JSON inválido" }), { status: 400, headers: CORS });
  }

  const { amount, site_url, gateway: gatewayName = "syncpay", ...cfg } = body;

  if (!amount) {
    return new Response(JSON.stringify({ error: "amount obrigatório" }), { status: 422, headers: CORS });
  }

  const gateway = GATEWAYS[gatewayName];
  if (!gateway) {
    return new Response(
      JSON.stringify({ error: `Gateway desconhecido: "${gatewayName}". Use: ${Object.keys(GATEWAYS).join(", ")}` }),
      { status: 422, headers: CORS }
    );
  }

  const missing = gateway.requiredFields.filter(f => !cfg[f]);
  if (missing.length) {
    return new Response(
      JSON.stringify({ error: `Campos obrigatórios para ${gateway.label}: ${missing.join(", ")}` }),
      { status: 422, headers: CORS }
    );
  }

  try {
    const webhookUrl = site_url ? `${site_url}/api/pix-webhook` : null;
    const result = await gateway.cashin(cfg, amount, webhookUrl);
    return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: CORS });
  } catch (err) {
    console.error(`[pix-cashin:${gatewayName}]`, err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

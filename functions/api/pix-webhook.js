// functions/api/pix-webhook.js
import { createClient } from "../../lib/supabase.js";
import { PARSERS, detectGateway } from "../../lib/gateways.js";

export async function onRequest({ request, env }) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const gateway = detectGateway(body, request.headers);
  const parser  = PARSERS[gateway] || PARSERS.generic;
  const parsed  = parser(body);

  if (!parsed || parsed.status !== "approved") {
    return new Response(JSON.stringify({ skipped: true, gateway }), { status: 200 });
  }

  // Evita duplicata
  const { data: existing } = await supabase
    .from("access_tokens").select("id, token")
    .eq("payment_id", parsed.paymentId).maybeSingle();

  if (existing) {
    return new Response(JSON.stringify({ ok: true, token: existing.token, duplicate: true }), { status: 200 });
  }

  // Se o lead pagou já logado, existe um pending_payments com o user_id dele
  let userId = null;
  let pendingId = null;
  const { data: pending } = await supabase
    .from("pending_payments").select("user_id, identifier")
    .eq("identifier", parsed.paymentId).maybeSingle();
  if (pending) {
    userId = pending.user_id;
    pendingId = pending.identifier;
  }

  // Gera token seguro via Web Crypto API
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const token = Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("");

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 365);

  const { error } = await supabase.from("access_tokens").insert({
    token,
    payment_id:  parsed.paymentId,
    payer_email: parsed.payerEmail || null,
    payer_name:  parsed.payerName  || null,
    amount:      parsed.amount     || null,
    expires_at:  expiresAt.toISOString(),
    user_id:     userId,
  });

  if (error) {
    console.error("Supabase insert error:", error);
    return new Response("DB error", { status: 500 });
  }

  // Limpa o pending_payments, já foi consumido
  if (pendingId) {
    await supabase.from("pending_payments").delete().eq("identifier", pendingId);
  }

  const siteUrl  = env.SITE_URL || "";
  const accessUrl = `${siteUrl}?token=${token}`;
  console.log(`✅ Acesso liberado | gateway: ${gateway} | payment: ${parsed.paymentId} | user_id: ${userId || "—"} | url: ${accessUrl}`);

  return new Response(JSON.stringify({ ok: true, token, accessUrl }), { status: 200 });
}

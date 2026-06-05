// functions/api/admin-profile.js
import { createClient } from "../../lib/supabase.js";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// Campos que vão para gateway_config, o resto vai para profile
const GW_FIELDS = new Set([
  "site_url","gateway",
  "syncpay_client_id","syncpay_client_secret",
  "nexuspag_api_key","nexuspag_webhook_secret","nexuspag_sandbox",
  "asaas_api_key","asaas_sandbox",
  "efibank_client_id","efibank_client_secret","efibank_pix_key","efibank_sandbox",
  "primepag_client_id","primepag_client_secret",
]);

export async function onRequest({ request, env }) {
  // MODEL_ID vem exclusivamente do env var do deploy (Cloudflare/Netlify)
  const modelId    = (env.MODEL_ID || "default").trim();
  const profileKey = `profile_${modelId}`;
  const gwKey      = `gateway_config_${modelId}`;

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: HEADERS });
  }

  // ── GET: leitura pública — devolve perfil + gateway fundidos ────────────────
  if (request.method === "GET") {
    const [profileRow, gwRow] = await Promise.all([
      supabase.from("site_config").select("value").eq("key", profileKey).maybeSingle(),
      supabase.from("site_config").select("value").eq("key", gwKey).maybeSingle(),
    ]);

    const profile = profileRow.data?.value || {};
    const gw      = gwRow.data?.value     || {};

    return new Response(
      JSON.stringify({ ...profile, ...gw, _model_id: modelId }),
      { status: 200, headers: HEADERS }
    );
  }

  // ── POST: salva — requer JWT de sessão Supabase válida ─────────────────────
  if (request.method === "POST") {
    const authHeader = request.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "").trim();

    if (!jwt) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), { status: 401, headers: HEADERS });
    }

    // Valida o JWT consultando o usuário no Supabase
    const userClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_KEY);
    // Usa o service key para verificar — mais simples e seguro
    const { data: userData, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Sessão inválida" }), { status: 401, headers: HEADERS });
    }

    let body;
    try { body = await request.json(); } catch {
      return new Response('{"error":"JSON inválido"}', { status: 400, headers: HEADERS });
    }

    // Separa campos de gateway dos campos de perfil
    const gwPayload      = {};
    const profilePayload = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === "_model_id") continue; // campo interno, não persiste
      if (GW_FIELDS.has(k)) gwPayload[k] = v;
      else profilePayload[k] = v;
    }
    profilePayload.model_id = modelId; // garante model_id no registro de perfil

    const [gwRes, profileRes] = await Promise.all([
      supabase.from("site_config").upsert({ key: gwKey,      value: gwPayload      }, { onConflict: "key" }),
      supabase.from("site_config").upsert({ key: profileKey, value: profilePayload }, { onConflict: "key" }),
    ]);

    const err = gwRes.error || profileRes.error;
    if (err) {
      console.error("Supabase write error:", JSON.stringify(err));
      return new Response(JSON.stringify({ error: err }), { status: 500, headers: HEADERS });
    }

    return new Response(JSON.stringify({ ok: true, model_id: modelId }), { status: 200, headers: HEADERS });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

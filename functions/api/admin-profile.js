// functions/api/admin-profile.js
import { createClient } from "../../lib/supabase.js";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

export async function onRequest({ request, env }) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: HEADERS });
  }

  // GET → leitura pública (sem auth)
  if (request.method === "GET") {
    const { data, error } = await supabase
      .from("site_config")
      .select("value")
      .eq("key", "profile")
      .single();

    if (error && error.code !== "PGRST116") {
      return new Response(JSON.stringify({ error }), { status: 500, headers: HEADERS });
    }

    const config = data?.value || {};
    return new Response(JSON.stringify(config), { status: 200, headers: HEADERS });
  }

  // POST → requer autenticação
  if (request.method === "POST") {
    const url = new URL(request.url);
    const secret =
      request.headers.get("x-admin-secret") ||
      url.searchParams.get("secret");

    if (secret !== env.ADMIN_SECRET) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), { status: 401, headers: HEADERS });
    }

    let body;
    try { body = await request.json(); } catch {
      return new Response('{"error":"JSON inválido"}', { status: 400, headers: HEADERS });
    }

    const { data: existing } = await supabase
      .from("site_config")
      .select("key")
      .eq("key", "profile")
      .maybeSingle();

    let dbError;
    if (existing) {
      const { error } = await supabase
        .from("site_config")
        .update({ value: body })
        .eq("key", "profile");
      dbError = error;
    } else {
      const { error } = await supabase
        .from("site_config")
        .insert({ key: "profile", value: body });
      dbError = error;
    }

    if (dbError) {
      console.error("Supabase write error:", JSON.stringify(dbError));
      return new Response(JSON.stringify({ error: dbError }), { status: 500, headers: HEADERS });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: HEADERS });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

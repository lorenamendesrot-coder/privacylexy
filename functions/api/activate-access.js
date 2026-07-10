// functions/api/activate-access.js
// Vincula o token de pagamento (recebido por URL) ao usuário recém-cadastrado.
// Usado no fluxo antigo: pagou como anônimo → recebeu link com ?token=xxx →
// criou conta depois → aqui a gente casa o token com o user_id.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") return new Response(null, { status: 200, headers: CORS });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: CORS });

  let body = {};
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: "JSON inválido" }), { status: 400, headers: CORS });
  }

  const { token, user_id, email } = body;
  if (!token || !user_id) {
    return new Response(JSON.stringify({ error: "token e user_id são obrigatórios" }), { status: 422, headers: CORS });
  }

  const SUPABASE_URL   = env.SUPABASE_URL;
  const SERVICE_KEY    = env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return new Response(JSON.stringify({ error: "Variáveis de ambiente não configuradas" }), { status: 500, headers: CORS });
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/access_tokens?token=eq.${encodeURIComponent(token)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Prefer": "return=representation",
      },
      body: JSON.stringify({ user_id, ...(email ? { payer_email: email } : {}) }),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.message) || "Erro ao vincular acesso");
    if (!Array.isArray(data) || !data.length) throw new Error("Token de acesso não encontrado");

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
  } catch (err) {
    console.error("[activate-access]", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}


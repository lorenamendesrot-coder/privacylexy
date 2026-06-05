// functions/api/activate-access.js
// Vincula o token de pagamento ao usuário recém-cadastrado

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

  const SUPABASE_URL          = env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return new Response(JSON.stringify({ error: "Variáveis de ambiente não configuradas" }), { status: 500, headers: CORS });
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/activate_member_access`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({ p_user_id: user_id, p_token: token, p_email: email || null }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Erro ao ativar acesso");

    return new Response(JSON.stringify(data), { status: 200, headers: CORS });
  } catch (err) {
    console.error("[activate-access]", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

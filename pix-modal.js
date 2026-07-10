// pix-modal.js — SyncPayments, sem formulário
// Inclua após content-unlock.js no index.html

(function () {
  var SUPABASE_URL  = window.SUPABASE_URL  || '';
  var SUPABASE_ANON = window.SUPABASE_ANON || '';

  var _gwConfig = null;
  var _selectedPrice = 0;
  var _timerInterval = null;
  var _pixLoading = false; // guard contra chamadas duplicadas
  var _pollInterval = null;
  var _pollIdentifier = null;
  var _pendingPlan = null; // { planCode, priceStr } enquanto o lead faz login/cadastro

  var SESSION_KEY = 'mbr_session'; // mesma chave usada em members.html

  // ── Sessão (compartilhada com members.html) ─────────────
  function getSession() {
    var raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      var token = s.access_token || (s.session && s.session.access_token);
      if (!token) return null;
      var userId = (s.user && s.user.id) || (s.session && s.session.user && s.session.user.id);
      var email  = (s.user && s.user.email) || s.email || '';
      return { access_token: token, user_id: userId, email: email };
    } catch (e) { return null; }
  }

  function saveSession(data) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }

  // ── Carrega gateway_config uma vez ──────────────────────
  function loadGwConfig() {
    if (_gwConfig) return Promise.resolve(_gwConfig);
    // Usa /api/admin-profile — o worker já sabe o MODEL_ID pelo env var do deploy
    return fetch('/api/admin-profile')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (cfg) {
        window.MODEL_ID = cfg._model_id || window.MODEL_ID || 'default';
        _gwConfig = cfg;
        return _gwConfig;
      })
      .catch(function () { return {}; });
  }

  // ── Abre modal e já dispara geração do PIX (se logado) ──
  window.openPayModal = function (planCode, priceStr) {
    // Bloqueia double-click / double-tap / eventos duplicados
    if (_pixLoading) return;

    var raw = (priceStr || '0').replace(/[^\d,\.]/g, '').replace(',', '.');
    _selectedPrice = parseFloat(raw) || 0;

    var modal = document.getElementById('payModal');
    if (!modal) return;

    setElText('payPriceSummary', priceStr || '—');
    resetModal();
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    var session = getSession();
    if (!session) {
      // Sem login: mostra a etapa de cadastro/login e só gera o PIX depois
      _pendingPlan = { planCode: planCode, priceStr: priceStr };
      showAuthGate();
      return;
    }

    showPaymentStep();
    gerarPix();
  };

  function showAuthGate() {
    var authStep = document.getElementById('authGateStep');
    var payStep  = document.getElementById('paymentStep');
    if (authStep) authStep.style.display = '';
    if (payStep)  payStep.style.display  = 'none';
  }

  function showPaymentStep() {
    var authStep = document.getElementById('authGateStep');
    var payStep  = document.getElementById('paymentStep');
    if (authStep) authStep.style.display = 'none';
    if (payStep)  payStep.style.display  = '';
  }

  // ── Alterna entre "Criar conta" e "Já tenho conta" ───────
  window.pixAuthSwitchTab = function (which) {
    var tabReg = document.getElementById('authTabRegister');
    var tabLog = document.getElementById('authTabLogin');
    var formReg = document.getElementById('authFormRegister');
    var formLog = document.getElementById('authFormLogin');
    var submitBtn = document.getElementById('pixAuthSubmitBtn');
    var msg = document.getElementById('pixAuthMsg');
    if (msg) msg.textContent = '';

    var isRegister = which === 'register';
    if (tabReg) { tabReg.style.background = isRegister ? '#fff' : 'transparent'; tabReg.style.color = isRegister ? '#111' : 'var(--text-dim,#999)'; }
    if (tabLog) { tabLog.style.background = !isRegister ? '#fff' : 'transparent'; tabLog.style.color = !isRegister ? '#111' : 'var(--text-dim,#999)'; }
    if (formReg) formReg.style.display = isRegister ? '' : 'none';
    if (formLog) formLog.style.display = !isRegister ? '' : 'none';
    if (submitBtn) submitBtn.textContent = isRegister ? 'Criar conta e continuar' : 'Entrar e continuar';
    submitBtn && (submitBtn.dataset.mode = isRegister ? 'register' : 'login');
  };

  // ── Envia o cadastro/login e, se ok, segue pro pagamento ─
  window.pixAuthSubmit = function () {
    var btn = document.getElementById('pixAuthSubmitBtn');
    var msg = document.getElementById('pixAuthMsg');
    var mode = (btn && btn.dataset.mode) || 'register';

    var SUPABASE_URL  = window.SUPABASE_URL  || '';
    var SUPABASE_ANON = window.SUPABASE_ANON || '';

    function setAuthMsg(text, isError) {
      if (!msg) return;
      msg.textContent = text;
      msg.style.color = isError ? '#e05252' : 'var(--accent,#e91e8c)';
    }

    if (mode === 'register') {
      var email = (document.getElementById('pixAuthRegEmail') || {}).value || '';
      var pass  = (document.getElementById('pixAuthRegPass')  || {}).value || '';
      email = email.trim();
      if (!email || !pass) { setAuthMsg('Preencha e-mail e senha.', true); return; }
      if (pass.length < 6) { setAuthMsg('A senha precisa ter pelo menos 6 caracteres.', true); return; }

      btn.disabled = true; btn.textContent = 'Criando conta...';
      fetch(SUPABASE_URL + '/auth/v1/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
        body: JSON.stringify({ email: email, password: pass }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.data.error_description || res.data.msg || 'Erro ao criar conta.');
          if (!res.data.access_token) {
            // Confirmação de e-mail ativada no projeto — não dá pra prosseguir sem sessão
            setAuthMsg('Conta criada! Verifique seu e-mail para confirmar, depois volte e clique em "Já tenho conta".', false);
            btn.disabled = false; btn.textContent = 'Criar conta e continuar';
            return;
          }
          saveSession(res.data);
          afterAuthSuccess();
        })
        .catch(function (e) {
          setAuthMsg(e.message, true);
          btn.disabled = false; btn.textContent = 'Criar conta e continuar';
        });
      return;
    }

    // mode === 'login'
    var lEmail = (document.getElementById('pixAuthLoginEmail') || {}).value || '';
    var lPass  = (document.getElementById('pixAuthLoginPass')  || {}).value || '';
    lEmail = lEmail.trim();
    if (!lEmail || !lPass) { setAuthMsg('Preencha e-mail e senha.', true); return; }

    btn.disabled = true; btn.textContent = 'Entrando...';
    fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body: JSON.stringify({ email: lEmail, password: lPass }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error_description || res.data.msg || 'Credenciais inválidas.');
        saveSession(res.data);
        afterAuthSuccess();
      })
      .catch(function (e) {
        setAuthMsg(e.message, true);
        btn.disabled = false; btn.textContent = 'Entrar e continuar';
      });
  };

  function afterAuthSuccess() {
    showPaymentStep();
    if (_pendingPlan) {
      setElText('payPriceSummary', _pendingPlan.priceStr || '—');
      var raw = (_pendingPlan.priceStr || '0').replace(/[^\d,\.]/g, '').replace(',', '.');
      _selectedPrice = parseFloat(raw) || _selectedPrice;
      _pendingPlan = null;
    }
    gerarPix();
  }

  // ── Fecha modal ─────────────────────────────────────────
  function fecharModal() {
    var modal = document.getElementById('payModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (_pollInterval)  { clearInterval(_pollInterval);  _pollInterval  = null; }
    _pixLoading = false;
    _pollIdentifier = null;
    _gwConfig = null; // limpa cache para sempre buscar config atualizada
  }

  // ── Reset visual (NÃO toca em _pixLoading) ──────────────
  function resetModal() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (_pollInterval)  { clearInterval(_pollInterval);  _pollInterval  = null; }
    _pollIdentifier = null;
    var result = document.getElementById('pixResult');
    if (result) result.innerHTML = '';
    setElText('pixStatus', '⏳ Gerando PIX...');
    setElDisplay('pixStatus', '');
    setElDisplay('generatePixBtn', 'none');
  }

  // ── Gera PIX via Netlify Function ───────────────────────
  function gerarPix() {
    if (_pixLoading) return;
    if (!_selectedPrice) { setElText('pixStatus', '❌ Valor inválido.'); return; }

    _pixLoading = true;

    loadGwConfig().then(function (cfg) {
      var gw = cfg.gateway || 'syncpay';

      // Valida campos obrigatórios por gateway
      var missing = false;
      if (gw === 'syncpay'  && (!cfg.syncpay_client_id || !cfg.syncpay_client_secret)) missing = true;
      if (gw === 'nexuspag' && !cfg.nexuspag_api_key)                                   missing = true;
      if (gw === 'asaas'    && !cfg.asaas_api_key)                                      missing = true;
      if (gw === 'efibank'  && (!cfg.efibank_client_id || !cfg.efibank_client_secret))  missing = true;
      if (gw === 'primepag' && (!cfg.primepag_client_id || !cfg.primepag_client_secret)) missing = true;

      if (missing) {
        setElText('pixStatus', '❌ Credenciais do gateway não configuradas no painel admin.');
        _pixLoading = false;
        return;
      }

      fetch('/api/pix-cashin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign(
          { amount: _selectedPrice, gateway: cfg.gateway || 'syncpay', site_url: cfg.site_url || '', model_id: window.MODEL_ID || 'default' },
          (function () { var s = getSession(); return s ? { user_id: s.user_id, email: s.email } : {}; })(),
          cfg // passa todas as credenciais da config (client_id, api_key, etc.)
        )),
      })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          _pixLoading = false;
          if (!res.ok || !res.data.ok) {
            setElText('pixStatus', '❌ ' + (res.data.error || 'Erro ao gerar PIX.'));
            setElDisplay('generatePixBtn', '');
            return;
          }
          setElDisplay('pixStatus', 'none');
          renderResult(res.data);
          startPaymentPolling(res.data.identifier);
        })
        .catch(function() {
          _pixLoading = false;
          setElText('pixStatus', '❌ Falha de conexão. Tente novamente.');
          setElDisplay('generatePixBtn', '');
        });
    });
  }

  // ── Renderiza QR + copia e cola ─────────────────────────
  function renderResult(data) {
    var result = document.getElementById('pixResult');
    if (!result) return;

    var html = '';

    if (data.pix_code) {
      var qrSrc = data.qr_code_base64
        ? data.qr_code_base64
        : 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(data.pix_code);
      html += '<img id="pixQrImg" src="' + qrSrc + '" alt="QR Code PIX" style="display:block;margin:8px auto;width:160px;height:160px;border-radius:12px;">';
      html += '<p style="font-size:11px;color:var(--text-dim,#888);text-align:center;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em">Pix Copia e Cola</p>';
      html += '<textarea id="pixCodigo" readonly style="width:100%;box-sizing:border-box;background:#ffffff;border:1px solid #ddd;border-radius:8px;padding:10px;color:#111111;font-size:11px;font-family:monospace;resize:none;min-height:56px;word-break:break-all;outline:none">' + escHtml(data.pix_code) + '</textarea>';
      html += '<button onclick="pixCopiar()" style="display:block;width:100%;margin-top:10px;padding:13px;background:var(--accent,#e91e8c);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;">📋 Copiar código PIX</button>';
    }

    html += '<p id="pixTimer" style="text-align:center;font-size:12px;color:var(--text-dim,#888);margin-top:14px">⏱ Expira em <strong>30:00</strong></p>';

    if (data.identifier) {
      html += '<button id="confirmPixBtn" onclick="pixConfirmarManual()" style="display:block;width:100%;margin-top:10px;padding:13px;background:transparent;color:var(--accent,#e91e8c);border:2px solid var(--accent,#e91e8c);border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;">✅ Já paguei, verificar agora</button>';
      html += '<p id="confirmPixMsg" style="text-align:center;font-size:12px;margin-top:8px;min-height:16px"></p>';
    }

    result.innerHTML = html;
    window._pixCode = data.pix_code || '';
    startTimer('pixTimer', 30 * 60);
  }

  // ── Copiar código ───────────────────────────────────────
  window.pixCopiar = function () {
    var code = window._pixCode || '';
    if (!code) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(function () { toast('✅ Código copiado!'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta); toast('✅ Código copiado!');
    }
  };

  // ── Polling de status do pagamento ──────────────────────
  function startPaymentPolling(identifier) {
    if (!identifier) return; // gateway não retornou identifier, não há o que consultar
    if (_pollInterval) clearInterval(_pollInterval);
    _pollIdentifier = identifier;

    _pollInterval = setInterval(function () {
      checkPaymentOnce(identifier).then(function (data) {
        if (data && data.paid && data.token) {
          clearInterval(_pollInterval);
          _pollInterval = null;
          onPaymentConfirmed(data.token);
        }
      }).catch(function () { /* falha pontual de rede — tenta de novo no próximo tick */ });
    }, 5000);
  }

  function checkPaymentOnce(identifier) {
    return fetch('/api/check-payment?identifier=' + encodeURIComponent(identifier))
      .then(function (r) { return r.json(); });
  }

  // ── Botão "Já paguei, verificar agora" ───────────────────
  window.pixConfirmarManual = function () {
    var identifier = _pollIdentifier;
    var btn = document.getElementById('confirmPixBtn');
    var msg = document.getElementById('confirmPixMsg');
    if (!identifier) return;

    if (btn) { btn.disabled = true; btn.textContent = '🔄 Verificando...'; }
    if (msg) msg.textContent = '';

    checkPaymentOnce(identifier)
      .then(function (data) {
        if (data && data.paid && data.token) {
          if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
          onPaymentConfirmed(data.token);
          return;
        }
        if (btn) { btn.disabled = false; btn.textContent = '✅ Já paguei, verificar agora'; }
        if (msg) { msg.textContent = '⏳ Pagamento ainda não identificado. Se você já pagou, aguarde alguns segundos e tente de novo.'; msg.style.color = 'var(--text-dim,#aaa)'; }
      })
      .catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = '✅ Já paguei, verificar agora'; }
        if (msg) { msg.textContent = '❌ Falha ao verificar. Tente novamente.'; msg.style.color = '#e05252'; }
      });
  };

  function onPaymentConfirmed(token) {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    setElText('pixStatus', '');
    var result = document.getElementById('pixResult');
    if (result) result.innerHTML = '<p style="text-align:center;font-weight:700;color:var(--accent,#e91e8c)">✅ Pagamento confirmado! Redirecionando...</p>';
    setElDisplay('pixStatus', 'none');
    setTimeout(function () {
      window.location.href = 'members.html?token=' + encodeURIComponent(token);
    }, 1200);
  }

  // ── Timer countdown ─────────────────────────────────────
  function startTimer(elId, seconds) {
    var rem = seconds;
    _timerInterval = setInterval(function () {
      rem--;
      var el = document.getElementById(elId);
      if (rem <= 0) {
        clearInterval(_timerInterval);
        if (el) el.innerHTML = '⚠️ Código expirado. Feche e clique no plano novamente.';
        return;
      }
      var m = String(Math.floor(rem / 60)).padStart(2, '0');
      var s = String(rem % 60).padStart(2, '0');
      if (el) el.innerHTML = '⏱ Expira em <strong>' + m + ':' + s + '</strong>';
    }, 1000);
  }

  // ── Bind eventos ────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    var closeBtn = document.getElementById('payClose');
    var backdrop = document.getElementById('payBackdrop');
    if (closeBtn) closeBtn.addEventListener('click', fecharModal);
    if (backdrop) backdrop.addEventListener('click', fecharModal);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fecharModal(); });

    // Botão "Tentar novamente"
    var genBtn = document.getElementById('generatePixBtn');
    if (genBtn) {
      genBtn.textContent = '🔄 Tentar novamente';
      genBtn.addEventListener('click', function () {
        _pixLoading = false; // permite nova tentativa explícita
        setElDisplay('generatePixBtn', 'none');
        resetModal();
        gerarPix();
      });
    }

    // Injeta #pixResult e #pixStatus no modal se não existirem
    injectModalStructure();

    // Bind botões de plano removido — onclick já definido inline no HTML
  });

  // ── Injeta estrutura no .pm-body ────────────────────────
  function injectModalStructure() {
    var body = document.querySelector('.pm-body');
    if (!body || document.getElementById('pixResult')) return;

    ['pixKey','copyPix','qrcode','awaitingPrice'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    var genBtn = document.getElementById('generatePixBtn');

    var status = document.createElement('p');
    status.id = 'pixStatus';
    status.style.cssText = 'text-align:center;font-size:13px;color:var(--text-dim,#aaa);margin:16px 0 4px';
    status.textContent = '';

    var result = document.createElement('div');
    result.id = 'pixResult';
    result.style.marginTop = '8px';

    if (genBtn) {
      body.insertBefore(status, genBtn);
      body.insertBefore(result, genBtn);
      genBtn.style.display = 'none';
    } else {
      body.appendChild(status);
      body.appendChild(result);
    }
  }

  // ── Helpers ─────────────────────────────────────────────
  function setElText(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
  function setElDisplay(id, v) { var e = document.getElementById(id); if (e) e.style.display = v; }
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function toast(msg) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:12px 22px;border-radius:12px;font-size:14px;z-index:99999;box-shadow:0 4px 24px rgba(0,0,0,.4);pointer-events:none;white-space:nowrap';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2500);
  }
})();

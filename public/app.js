// App dos entregadores - vanilla JS, sem build, pra rodar direto do
// servidor sem passo de compilação. Faz polling simples na API a cada
// alguns segundos (suficiente pra uma equipe pequena; sem web sockets).

const root = document.getElementById("root");
const POLL_MS = 6000;

const state = {
  screen: localStorage.getItem("pce_nome") ? "app" : "login",
  pin: localStorage.getItem("pce_pin") || "",
  nome: localStorage.getItem("pce_nome") || "",
  loginErr: "",
  aba: "pendentes", // pendentes | andamento
  entregas: [],
  resumo: { pendentes: 0, andamento: 0, concluidasHoje: 0, ranking: [] },
  toast: "",
  loading: true,
};

let pollTimer = null;

function api(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (state.pin) headers["x-pin"] = state.pin;
  return fetch(path, { ...opts, headers }).then(async (r) => {
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((body && body.erro) || `erro ${r.status}`);
    return body;
  });
}

function showToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => { state.toast = ""; render(); }, 2600);
}

function fmtMoney(v) { return "R$ " + (parseFloat(v) || 0).toFixed(2); }

// ── carregamento de dados ────────────────────────────────────────────────
async function loadData() {
  try {
    const [entregas, resumo] = await Promise.all([
      api("/api/entregas?status=pendente,aceito,em_andamento"),
      api("/api/resumo"),
    ]);
    state.entregas = entregas;
    state.resumo = resumo;
    state.loading = false;
    render();
  } catch (e) {
    state.loading = false;
    render();
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  loadData();
  pollTimer = setInterval(loadData, POLL_MS);
}

// ── ações ────────────────────────────────────────────────────────────────
async function doLogin() {
  const pinInput = document.getElementById("pin").value.trim();
  const nomeInput = document.getElementById("nome").value.trim();
  if (!nomeInput) { state.loginErr = "Digite seu nome."; render(); return; }
  try {
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: pinInput }) });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.erro || "PIN incorreto");
    state.pin = pinInput;
    state.nome = nomeInput;
    localStorage.setItem("pce_pin", pinInput);
    localStorage.setItem("pce_nome", nomeInput);
    state.screen = "app";
    state.loginErr = "";
    render();
    startPolling();
  } catch (e) {
    state.loginErr = e.message || "Não foi possível entrar.";
    render();
  }
}

function sair() {
  localStorage.removeItem("pce_pin");
  localStorage.removeItem("pce_nome");
  state.pin = ""; state.nome = ""; state.screen = "login";
  if (pollTimer) clearInterval(pollTimer);
  render();
}

async function aceitar(id) {
  try { await api(`/api/entregas/${id}/aceitar`, { method: "POST", body: JSON.stringify({ entregador: state.nome }) }); loadData(); }
  catch (e) { showToast(e.message); loadData(); }
}
async function andamento(id) {
  try { await api(`/api/entregas/${id}/andamento`, { method: "POST", body: "{}" }); loadData(); }
  catch (e) { showToast(e.message); loadData(); }
}
async function concluir(id) {
  try { await api(`/api/entregas/${id}/concluir`, { method: "POST", body: "{}" }); loadData(); }
  catch (e) { showToast(e.message); loadData(); }
}
async function desfazer(id) {
  try { await api(`/api/entregas/${id}/desfazer`, { method: "POST", body: "{}" }); loadData(); }
  catch (e) { showToast(e.message); loadData(); }
}

// ── render ───────────────────────────────────────────────────────────────
function cardHtml(d) {
  const status = d.status;
  let actions = "";
  if (status === "pendente") {
    actions = `<div class="actions"><button class="btn btn-blue" data-action="aceitar" data-id="${d.id}">✅ Aceitar entrega</button></div>`;
  } else if (status === "aceito") {
    actions = `
      <div class="who">🛵 Com: <b>${d.entregador || ""}</b></div>
      <div class="actions-row">
        <button class="btn btn-ghost" data-action="desfazer" data-id="${d.id}" style="width:auto;padding:10px 14px;">↩ Desfazer</button>
        <button class="btn btn-purple" data-action="andamento" data-id="${d.id}" style="width:auto;padding:10px 16px;flex:1;">🚀 Em Andamento</button>
      </div>`;
  } else if (status === "em_andamento") {
    actions = `
      <div class="who">🛵 Com: <b>${d.entregador || ""}</b> · a caminho</div>
      <div class="actions-row">
        <button class="btn btn-ghost" data-action="desfazer" data-id="${d.id}" style="width:auto;padding:10px 14px;">↩ Desfazer</button>
        <button class="btn btn-green" data-action="concluir" data-id="${d.id}" style="width:auto;padding:10px 16px;flex:1;">🏁 Concluir</button>
      </div>`;
  }
  return `
    <div class="card ${status}">
      <div class="row-top">
        <div>
          <h3>${escapeHtml(d.cliente || "")}</h3>
          <div class="addr">${escapeHtml(d.endereco || "")}${d.bairro ? " · " + escapeHtml(d.bairro) : ""}</div>
          ${d.obs ? `<div class="obs">Obs: ${escapeHtml(d.obs)}</div>` : ""}
        </div>
        <div>
          <div class="valor">${fmtMoney(d.valor)}</div>
          <div class="hora">${d.hora || ""}</div>
        </div>
      </div>
      ${actions}
    </div>`;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function render() {
  if (state.screen === "login") {
    root.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <h1>🛵 Entregadores</h1>
          <p>Pontocom Gás e Água</p>
          <div class="field"><label>Seu nome</label><input id="nome" placeholder="Ex: Carlos" value="${escapeHtml(state.nome)}" /></div>
          <div class="field"><label>PIN da equipe</label><input id="pin" type="tel" inputmode="numeric" placeholder="Se houver" value="${escapeHtml(state.pin)}" /></div>
          <button class="btn btn-accent" id="btnLogin">Entrar</button>
          <div class="err">${state.loginErr}</div>
        </div>
      </div>`;
    document.getElementById("btnLogin").onclick = doLogin;
    return;
  }

  const pendentes = state.entregas.filter((d) => d.status === "pendente");
  const andamentoLista = state.entregas.filter((d) => d.status === "aceito" || d.status === "em_andamento");

  root.innerHTML = `
    <div class="topbar">
      <div>
        <h1>Entregadores</h1>
        <div class="sub">${escapeHtml(state.nome)}</div>
      </div>
      <button class="btn-ghost" id="btnSair" style="color:#fff;border-color:rgba(255,255,255,.4);padding:8px 12px;border-radius:8px;font-size:12px;">Sair</button>
    </div>
    <div class="wrap">
      <div class="stats">
        <div class="stat"><div class="n" style="color:var(--yellow)">${state.resumo.pendentes}</div><div class="l">Pendentes</div></div>
        <div class="stat"><div class="n" style="color:var(--purple)">${state.resumo.andamento}</div><div class="l">Andamento</div></div>
        <div class="stat"><div class="n" style="color:var(--green)">${state.resumo.concluidasHoje}</div><div class="l">Hoje</div></div>
      </div>
      ${state.resumo.ranking.length ? `
        <div class="ranking">
          ${state.resumo.ranking.map((r) => `<div class="chip">${escapeHtml(r.entregador)} <span class="qtd">${r.qtd}</span></div>`).join("")}
        </div>` : ""}

      <div class="section-title">⏳ Pendentes (${pendentes.length})</div>
      ${pendentes.length ? pendentes.map(cardHtml).join("") : `<div class="empty">Nenhuma entrega pendente agora.</div>`}

      <div class="section-title">🛵 Em andamento (${andamentoLista.length})</div>
      ${andamentoLista.length ? andamentoLista.map(cardHtml).join("") : `<div class="empty">Nenhuma entrega em andamento.</div>`}

      <div class="refresh-note">${state.loading ? "Atualizando..." : "Atualiza sozinho a cada poucos segundos"}</div>
    </div>
    ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
  `;

  document.getElementById("btnSair").onclick = sair;
  root.querySelectorAll("[data-action]").forEach((btn) => {
    const id = btn.getAttribute("data-id");
    const action = btn.getAttribute("data-action");
    btn.onclick = () => ({ aceitar, andamento, concluir, desfazer }[action](id));
  });
}

// ── boot ─────────────────────────────────────────────────────────────────
render();
if (state.screen === "app") startPolling();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js").catch(() => {}));
}

// Servidor do app "Entregadores" (Pontocom Gás e Água).
//
// Duas portas de entrada:
//  1) O app desktop empurra pra cá cada entrega nova (rota protegida por
//     API key), assim que o atendente salva o pedido.
//  2) O celular do entregador (PWA) fala com essas mesmas rotas pra listar,
//     aceitar, marcar em andamento e concluir - protegido só por um PIN
//     simples (é uso interno da equipe, não precisa de login completo).
//
// Mesma linha do pontcom-frota: Node/Express + Postgres (Neon), tudo num
// serviço só (API + arquivos estáticos do PWA).

const path = require("path");
const express = require("express");
const cors = require("cors");
const { pool, initDb } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DESKTOP_API_KEY = process.env.DESKTOP_API_KEY || ""; // usada pelo app desktop pra criar entregas
const ENTREGADOR_PIN = process.env.ENTREGADOR_PIN || "";   // PIN simples pro celular dos entregadores

// ── auth ─────────────────────────────────────────────────────────────────
function checkDesktopKey(req, res, next) {
  if (!DESKTOP_API_KEY) return next(); // se não configurou, não exige (facilita testar)
  if (req.get("x-api-key") !== DESKTOP_API_KEY) {
    return res.status(401).json({ erro: "chave inválida" });
  }
  next();
}

function checkPin(req, res, next) {
  if (!ENTREGADOR_PIN) return next();
  const pin = req.get("x-pin") || req.query.pin || (req.body && req.body.pin);
  if (pin !== ENTREGADOR_PIN) {
    return res.status(401).json({ erro: "pin inválido" });
  }
  next();
}

// ── login (só valida o PIN e devolve ok) ────────────────────────────────
app.post("/api/login", (req, res) => {
  const { pin } = req.body || {};
  if (!ENTREGADOR_PIN || pin === ENTREGADOR_PIN) return res.json({ ok: true });
  res.status(401).json({ ok: false, erro: "PIN incorreto" });
});

// ── desktop → cria/atualiza entrega ─────────────────────────────────────
app.post("/api/entregas", checkDesktopKey, async (req, res) => {
  try {
    const d = req.body || {};
    const r = await pool.query(
      `INSERT INTO entregas
         (origem_id, cliente, endereco, bairro, telefone, valor, pagamento, obs, data, hora, status, entregador)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, CURRENT_DATE), $10, 'pendente', $11)
       ON CONFLICT (origem_id) DO UPDATE SET
         cliente=EXCLUDED.cliente, endereco=EXCLUDED.endereco, bairro=EXCLUDED.bairro,
         telefone=EXCLUDED.telefone, valor=EXCLUDED.valor, pagamento=EXCLUDED.pagamento, obs=EXCLUDED.obs
       RETURNING *`,
      [
        d.origemId || null, d.cliente || "", d.endereco || "", d.bairro || "",
        d.telefone || "", d.valor || 0, d.pagamento || "", d.obs || "",
        d.data || null, d.hora || "", d.entregador || null,
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "falha ao salvar entrega" });
  }
});

// ── lista entregas (pra desktop sincronizar e pro celular exibir) ──────
app.get("/api/entregas", checkPin, async (req, res) => {
  try {
    const { status, data } = req.query;
    const cond = [];
    const vals = [];
    if (status) { vals.push(status.split(",")); cond.push(`status = ANY($${vals.length})`); }
    if (data)   { vals.push(data); cond.push(`data = $${vals.length}`); }
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const r = await pool.query(`SELECT * FROM entregas ${where} ORDER BY id DESC LIMIT 300`, vals);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "falha ao listar entregas" });
  }
});

// ── ações do fluxo ───────────────────────────────────────────────────────
app.post("/api/entregas/:id/aceitar", checkPin, async (req, res) => {
  const { entregador } = req.body || {};
  if (!entregador || !entregador.trim()) return res.status(400).json({ erro: "informe o nome do entregador" });
  const r = await pool.query(
    `UPDATE entregas SET status='aceito', entregador=$1, aceito_em=now()
     WHERE (id::text=$2 OR origem_id=$2) AND status='pendente' RETURNING *`,
    [entregador.trim(), req.params.id]
  );
  if (!r.rows[0]) return res.status(409).json({ erro: "essa entrega já foi pega por outra pessoa" });
  res.json(r.rows[0]);
});

app.post("/api/entregas/:id/andamento", checkPin, async (req, res) => {
  const r = await pool.query(
    `UPDATE entregas SET status='em_andamento', andamento_em=now()
     WHERE (id::text=$1 OR origem_id=$1) AND status='aceito' RETURNING *`,
    [req.params.id]
  );
  if (!r.rows[0]) return res.status(409).json({ erro: "estado inválido" });
  res.json(r.rows[0]);
});

app.post("/api/entregas/:id/concluir", checkPin, async (req, res) => {
  const r = await pool.query(
    `UPDATE entregas SET status='concluido', concluido_em=now()
     WHERE (id::text=$1 OR origem_id=$1) AND status='em_andamento' RETURNING *`,
    [req.params.id]
  );
  if (!r.rows[0]) return res.status(409).json({ erro: "estado inválido" });
  res.json(r.rows[0]);
});

app.post("/api/entregas/:id/desfazer", checkPin, async (req, res) => {
  const cur = await pool.query(`SELECT status FROM entregas WHERE id::text=$1 OR origem_id=$1`, [req.params.id]);
  if (!cur.rows[0]) return res.status(404).json({ erro: "não encontrada" });
  const status = cur.rows[0].status;
  let sql;
  if (status === "em_andamento") { sql = `UPDATE entregas SET status='aceito', andamento_em=NULL WHERE id::text=$1 OR origem_id=$1 RETURNING *`; }
  else if (status === "aceito")  { sql = `UPDATE entregas SET status='pendente', aceito_em=NULL, entregador=NULL WHERE id::text=$1 OR origem_id=$1 RETURNING *`; }
  else return res.status(409).json({ erro: "nada pra desfazer" });
  const r = await pool.query(sql, [req.params.id]);
  res.json(r.rows[0]);
});

// ── resumo do dia: contadores + ranking por entregador ──────────────────
app.get("/api/resumo", checkPin, async (req, res) => {
  const data = req.query.data || new Date().toISOString().slice(0, 10);
  const [pendentes, andamento, concluidas, ranking] = await Promise.all([
    pool.query(`SELECT count(*) FROM entregas WHERE status='pendente'`),
    pool.query(`SELECT count(*) FROM entregas WHERE status IN ('aceito','em_andamento')`),
    pool.query(`SELECT count(*) FROM entregas WHERE status='concluido' AND data=$1`, [data]),
    pool.query(
      `SELECT entregador, count(*) qtd FROM entregas WHERE status='concluido' AND data=$1 AND entregador IS NOT NULL
       GROUP BY entregador ORDER BY qtd DESC`,
      [data]
    ),
  ]);
  res.json({
    pendentes: Number(pendentes.rows[0].count),
    andamento: Number(andamento.rows[0].count),
    concluidasHoje: Number(concluidas.rows[0].count),
    ranking: ranking.rows,
  });
});

app.use(express.static(path.join(__dirname, "..", "public")));

initDb()
  .then(() => app.listen(PORT, () => console.log(`🛵 Pontocom Entregadores rodando na porta ${PORT}`)))
  .catch((e) => { console.error("Falha ao iniciar banco:", e); process.exit(1); });

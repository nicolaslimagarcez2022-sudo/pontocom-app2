// Conexão com o Postgres (Neon) e criação da tabela na primeira vez que
// o servidor sobe. Segue o mesmo padrão do pontcom-frota: Node/Express +
// Postgres, sem ORM, queries diretas com o driver "pg".
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("❌ Faltou configurar a variável DATABASE_URL (string de conexão do Neon).");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon exige SSL
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entregas (
      id             SERIAL PRIMARY KEY,
      origem_id      TEXT,               -- id da entrega no app desktop (pra evitar duplicar)
      cliente        TEXT NOT NULL,
      endereco       TEXT,
      bairro         TEXT,
      telefone       TEXT,
      valor          NUMERIC(10,2) DEFAULT 0,
      pagamento      TEXT,
      obs            TEXT,
      data           DATE NOT NULL DEFAULT CURRENT_DATE,
      hora           TEXT,
      status         TEXT NOT NULL DEFAULT 'pendente', -- pendente | aceito | em_andamento | concluido
      entregador     TEXT,
      aceito_em      TIMESTAMPTZ,
      andamento_em   TIMESTAMPTZ,
      concluido_em   TIMESTAMPTZ,
      criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS entregas_origem_id_idx ON entregas (origem_id) WHERE origem_id IS NOT NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS entregas_status_idx ON entregas (status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS entregas_data_idx ON entregas (data);`);
  console.log("✅ Banco pronto (tabela entregas ok).");
}

module.exports = { pool, initDb };

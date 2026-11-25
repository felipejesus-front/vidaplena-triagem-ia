// Gera os segredos internos do ambiente, uma única vez, no volume /segredos.
// Executado pelo serviço secrets-init (imagem do n8n, que já tem Node e bcryptjs).
// Regras: valor definido no .env tem prioridade; senão, mantém o existente; senão, gera.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("/usr/local/lib/node_modules/n8n/node_modules/bcryptjs");

const DIR = "/segredos";

function gerarAleatorio(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function garantirSegredo(nomeArquivo, valorDoEnv) {
  const arquivo = path.join(DIR, nomeArquivo);
  const existente = fs.existsSync(arquivo) ? fs.readFileSync(arquivo, "utf8").trim() : "";

  if (valorDoEnv) {
    fs.writeFileSync(arquivo, valorDoEnv, { mode: 0o644 });
    return { valor: valorDoEnv, origem: ".env" };
  }
  if (existente) {
    return { valor: existente, origem: "existente" };
  }
  const novo = gerarAleatorio();
  fs.writeFileSync(arquivo, novo, { mode: 0o644 });
  return { valor: novo, origem: "gerado" };
}

fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });

const resultados = {
  postgres_password: garantirSegredo("postgres_password", process.env.POSTGRES_PASSWORD),
  internal_api_key: garantirSegredo("internal_api_key", process.env.INTERNAL_API_KEY),
  n8n_encryption_key: garantirSegredo("n8n_encryption_key", process.env.N8N_ENCRYPTION_KEY),
  n8n_owner_password: garantirSegredo("n8n_owner_password", process.env.N8N_OWNER_PASSWORD),
};

// O n8n recebe apenas o hash bcrypt da senha do admin.
const hash = bcrypt.hashSync(resultados.n8n_owner_password.valor, 10);
fs.writeFileSync(path.join(DIR, "n8n_owner_password_hash"), hash, { mode: 0o644 });

for (const [nome, { origem }] of Object.entries(resultados)) {
  console.log(`[secrets-init] ${nome}: ${origem}`);
}

if (resultados.n8n_owner_password.origem === "gerado") {
  console.log("[secrets-init] Login do n8n: admin@vidaplena.example");
  console.log("[secrets-init] Para ver a senha: docker compose exec n8n cat /segredos/n8n_owner_password");
}

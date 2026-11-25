import { app } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";

const servidor = app.listen(config.porta, () => {
  console.log(`[api] VidaPlena ouvindo na porta ${config.porta} (modelo: ${config.gemini.modelo})`);
});

// Encerramento limpo no "docker compose stop".
for (const sinal of ["SIGTERM", "SIGINT"]) {
  process.once(sinal, () => {
    console.log(`[api] ${sinal} recebido, encerrando...`);
    servidor.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

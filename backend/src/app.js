import express from "express";
import { query } from "./db.js";
import { rotaNaoEncontrada, tratarErros } from "./middlewares.js";
import { rotasClassify } from "./rotas/classify.js";
import { rotasSetores } from "./rotas/setores.js";
import { rotasTickets } from "./rotas/tickets.js";

export const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.get("/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ok", banco: "ok" });
  } catch {
    res.status(503).json({ status: "erro", banco: "indisponível" });
  }
});

app.use("/tickets", rotasTickets); // público (formulário e listagem)
app.use("/classify", rotasClassify); // interno (n8n, X-Api-Key)
app.use("/setores", rotasSetores); // interno (n8n, X-Api-Key)

app.use(rotaNaoEncontrada);
app.use(tratarErros);

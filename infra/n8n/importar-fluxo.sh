#!/bin/sh
# Importa o fluxo versionado e o publica (ativa).
# Idempotente: o ID é fixo, então reimportar sobrescreve o mesmo workflow.
#
# Só importa quando o arquivo mudou desde a última importação (hash guardado no volume do n8n).
# Motivo: o import despublica o fluxo por alguns segundos; se rodasse em todo "docker compose up"
# com o n8n já no ar, o webhook ficaria fora nesse intervalo e um ticket poderia cair em "erro".
set -eu

ARQUIVO=/workflows/triagem.json
ID=vpTriagem0000001
HASH_GUARDADO=/home/node/.n8n/triagem.sha256

if [ ! -f "$ARQUIVO" ]; then
  echo "[n8n-import] $ARQUIVO ainda não existe (fluxo não exportado). Nada a importar."
  exit 0
fi

HASH_ATUAL=$(sha256sum "$ARQUIVO" | cut -d' ' -f1)
if [ -f "$HASH_GUARDADO" ] && [ "$(cat "$HASH_GUARDADO")" = "$HASH_ATUAL" ]; then
  echo "[n8n-import] Fluxo $ID sem alterações desde a última importação. Nada a fazer."
  exit 0
fi

n8n import:workflow --input="$ARQUIVO"
n8n publish:workflow --id="$ID"
echo "$HASH_ATUAL" > "$HASH_GUARDADO"
echo "[n8n-import] Fluxo $ID importado e publicado."

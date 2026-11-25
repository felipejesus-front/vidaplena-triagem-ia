#!/bin/sh
# Disponibiliza INTERNAL_API_KEY como variável de ambiente para os nodes ($env.INTERNAL_API_KEY)
# e inicia o n8n pelo entrypoint original da imagem.
set -eu

INTERNAL_API_KEY="$(cat /segredos/internal_api_key)"
export INTERNAL_API_KEY

exec tini -- /docker-entrypoint.sh "$@"

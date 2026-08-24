#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
secret_dir="$repo_root/.secrets"

load_secret() {
  local variable_name="$1"
  local secret_file="$2"
  local value=''
  if [[ -f "$secret_file" ]]; then
    if [[ -L "$secret_file" ]]; then
      echo "Refusing to load symlinked secret file: $secret_file" >&2
      exit 1
    fi
    IFS= read -r value < "$secret_file"
    if [[ -z "$value" ]]; then
      echo "Secret file is empty: $secret_file" >&2
      exit 1
    fi
    printf -v "$variable_name" '%s' "$value"
    export "$variable_name"
    unset value
  fi
}

load_secret OPENAI_API_KEY "$secret_dir/openai_api_key"
load_secret DEEPSEEK_API_KEY "$secret_dir/deepseek_api_key"

if [[ "${1:-}" == '--check' ]]; then
  [[ -n "${OPENAI_API_KEY:-}" ]] && echo 'OPENAI_API_KEY=set' || echo 'OPENAI_API_KEY=unset'
  [[ -n "${DEEPSEEK_API_KEY:-}" ]] && echo 'DEEPSEEK_API_KEY=set' || echo 'DEEPSEEK_API_KEY=unset'
  exit 0
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 --check | <command> [args...]" >&2
  exit 2
fi

exec "$@"

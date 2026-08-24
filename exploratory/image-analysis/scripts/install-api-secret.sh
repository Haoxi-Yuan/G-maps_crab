#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <openai|deepseek>" >&2
  exit 2
}

provider="${1:-}"
case "$provider" in
  openai)
    target_name='openai_api_key'
    display_name='OpenAI'
    ;;
  deepseek)
    target_name='deepseek_api_key'
    display_name='DeepSeek'
    ;;
  *)
    usage
    ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
secret_dir="$repo_root/.secrets"
target="$secret_dir/$target_name"

umask 077
if [[ -L "$secret_dir" ]]; then
  echo "Refusing to use symlinked secret directory: $secret_dir" >&2
  exit 1
fi
mkdir -p -- "$secret_dir"
chmod 700 -- "$secret_dir"

secret=''
if [[ -t 0 ]]; then
  IFS= read -r -s -p "Enter $display_name API key: " secret
  printf '\n' >&2
else
  IFS= read -r secret
fi

if [[ ${#secret} -lt 20 || "$secret" == *[[:space:]]* ]]; then
  unset secret
  echo "Rejected empty, unusually short, or whitespace-containing API key." >&2
  exit 1
fi

temp_file="$(mktemp "$secret_dir/.${target_name}.XXXXXX")"
cleanup() {
  rm -f -- "$temp_file"
}
trap cleanup EXIT HUP INT TERM

printf '%s\n' "$secret" > "$temp_file"
chmod 600 -- "$temp_file"
mv -f -- "$temp_file" "$target"
trap - EXIT HUP INT TERM
unset secret

echo "$display_name API key installed at $target (mode 600; value not displayed)."

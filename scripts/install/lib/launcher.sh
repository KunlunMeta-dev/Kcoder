#!/usr/bin/env bash

# Source launchers reuse only these side-effect-free helpers. Full installers live under ../installers and are never run by launchers.
launcher_lib_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$launcher_lib_dir/profile.sh"
source "$launcher_lib_dir/binary.sh"
source "$launcher_lib_dir/config-sync.sh"

kcoder_add_no_proxy() {
  local value="${NO_PROXY:-${no_proxy:-}}"
  local entry

  for entry in "$@"; do
    case ",$value," in
      *",$entry,"*) ;;
      ,,) value="$entry" ;;
      *) value="$value,$entry" ;;
    esac
  done
  export NO_PROXY="$value"
  export no_proxy="$value"
}

kcoder_set_http_proxy() {
  local proxy_url="$1"
  export http_proxy="$proxy_url"
  export https_proxy="$proxy_url"
  export HTTP_PROXY="$proxy_url"
  export HTTPS_PROXY="$proxy_url"
  export GIT_HTTP_PROXY="$proxy_url"
  export GIT_HTTPS_PROXY="$proxy_url"
}

kcoder_args_have_option() {
  local long_name="$1"
  local short_name="$2"
  shift 2
  local arg

  for arg in "$@"; do
    if [[ "$arg" == "--$long_name" || "$arg" == --"$long_name"=* ]]; then
      return 0
    fi
    if [[ -n "$short_name" && ("$arg" == "-$short_name" || "$arg" == -"$short_name"?*) ]]; then
      return 0
    fi
  done
  return 1
}

kcoder_append_env_option() {
  local -n output="$1"
  local value="$2"
  local option="$3"
  local short_name="$4"
  shift 4

  if [[ -n "$value" ]] && ! kcoder_args_have_option "$option" "$short_name" "$@"; then
    output+=("--$option" "$value")
  fi
}

kcoder_launch_provider_with_sync() {
  local provider="$1"
  local policy="$2"
  shift 2
  local extra_args=()

  while (($#)); do
    if [[ "$1" == "--" ]]; then
      shift
      break
    fi
    extra_args+=("$1")
    shift
  done

  kcoder_prepare_binary "$policy"
  kcoder_sync_development_config
  cd "$KCODER_LAUNCH_CWD" || return
  exec "$KCODER_REAL_BIN" \
    --provider "$provider" \
    "${extra_args[@]}" \
    "$@"
}

kcoder_launch_provider() {
  kcoder_launch_provider_with_sync "$@"
}

kcoder_launch_provider_without_sync() {
  local provider="$1"
  local policy="$2"
  shift 2
  local extra_args=()

  while (($#)); do
    if [[ "$1" == "--" ]]; then
      shift
      break
    fi
    extra_args+=("$1")
    shift
  done

  kcoder_prepare_binary "$policy"
  cd "$KCODER_LAUNCH_CWD" || return
  exec "$KCODER_REAL_BIN" \
    --provider "$provider" \
    "${extra_args[@]}" \
    "$@"
}

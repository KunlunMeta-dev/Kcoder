#!/usr/bin/env bash

# Debug/release binary selection shared by installers and source launchers.

kcoder_binary_is_usable() {
  local candidate="$1"
  local help_output auth_help_output

  [[ -f "$candidate" && -x "$candidate" ]] || return 1
  help_output="$("$candidate" --help 2>/dev/null)" || return 1
  auth_help_output="$("$candidate" auth --help 2>/dev/null)" || return 1
  [[ "$help_output" == *"--provider"* && "$auth_help_output" == *"login"* ]]
}

kcoder_select_latest_binary() {
  local defaults="$KCODER_REPO_DIR/target/release:$KCODER_REPO_DIR/.kcoder/releases"
  local roots=()
  local entry candidate root

  IFS=':' read -r -a roots <<< "${KCODER_RELEASE_BIN_DIRS:-$defaults}"
  while IFS= read -r -d '' entry; do
    candidate="${entry#* }"
    if kcoder_binary_is_usable "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(
    for root in "${roots[@]}"; do
      [[ -d "$root" ]] || continue
      find "$root" -maxdepth 1 -type f \
        \( -name 'kcoder' -o -name 'kcoder-*' \) \
        -printf '%T@ %p\0' 2>/dev/null
    done | sort -z -nr
  )

  echo "No usable KCoder release binary found in: ${roots[*]}" >&2
  echo "Build once with: cargo build --release --all-features" >&2
  return 1
}

kcoder_prepare_binary() {
  local policy="${1:-build}"
  local newer_source
  local build_args=(build --all-features --locked)

  if [[ -n "${KCODER_REAL_BIN:-}" ]]; then
    if ! kcoder_binary_is_usable "$KCODER_REAL_BIN"; then
      echo "KCODER_REAL_BIN is not a usable KCoder binary: $KCODER_REAL_BIN" >&2
      return 1
    fi
    KCODER_REAL_BIN="$KCODER_REAL_BIN"
    return
  fi

  if [[ "$policy" == "latest" ]]; then
    KCODER_REAL_BIN="$(kcoder_select_latest_binary)"
    echo "Using KCoder release binary: $KCODER_REAL_BIN" >&2
    return
  fi
  case "$policy" in
    debug)
      KCODER_REAL_BIN="$KCODER_REPO_DIR/target/debug/kcoder"
      ;;
    build)
      KCODER_REAL_BIN="$KCODER_REPO_DIR/target/release/kcoder"
      build_args+=(--release)
      ;;
    *)
      echo "Unknown KCoder binary policy: $policy (expected debug, build, or latest)" >&2
      return 1
      ;;
  esac

  if [[ ! -x "$KCODER_REAL_BIN" ]]; then
    echo "kcoder binary not found at $KCODER_REAL_BIN; building..." >&2
  else
    newer_source="$(find "$KCODER_REPO_DIR/Cargo.toml" "$KCODER_REPO_DIR/Cargo.lock" \
      "$KCODER_REPO_DIR/crates" -type f -newer "$KCODER_REAL_BIN" -print -quit 2>/dev/null || true)"
    [[ -z "$newer_source" ]] && return
    echo "kcoder sources are newer than $KCODER_REAL_BIN; rebuilding..." >&2
  fi
  (cd "$KCODER_REPO_DIR" && cargo "${build_args[@]}")
}

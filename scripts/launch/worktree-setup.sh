#!/usr/bin/env bash
# Prepare selected build inputs for one linked checkout.
set -euo pipefail

die() { printf 'worktree setup: %s\n' "$*" >&2; exit 1; }
[[ $# -le 1 ]] || die 'Usage: worktree-setup.sh [worktree]'
checkout="$(cd -P -- "${1:-.}" && pwd)"
common="$(git -C "$checkout" rev-parse --path-format=absolute --git-common-dir)"
[[ "$(git -C "$checkout" rev-parse --show-toplevel)" == "$checkout" &&
   "$(git -C "$checkout" rev-parse --absolute-git-dir)" == "$common"/worktrees/* ]] ||
  die 'Expected a linked worktree root'
IFS= read -r -d '' primary < <(git -C "$checkout" worktree list --porcelain -z)
root="${primary#worktree }"
[[ "$checkout" != "$root/target/worktree/dev" && "$checkout" != "$root/target/worktree/stable" ]] ||
  die 'Use the fixed Debug or Release launcher for this checkout'

if [[ -n "${KCODER_WORKTREE_CACHE_SOURCE:-}" ]]; then
  printf 'worktree setup: Cargo snapshot skipped; use the compiler cache with a checkout-local target\n' >&2
fi
IFS=, read -r -a packages <<< "${KCODER_WORKTREE_PACKAGES-studio}"
for package in "${packages[@]}"; do
  case "$package" in
    studio) command -v pnpm >/dev/null || die 'Studio setup requires pnpm' ;;
    mobile|channel|relay) command -v npm >/dev/null || die 'Node package setup requires npm' ;;
    *) die "Unknown package scope: $package" ;;
  esac
done
[[ ${#packages[@]} -gt 0 ]] || exit 0

target="$checkout/target"
[[ ! -L "$target" ]] || die 'Target directory is a symlink'
mkdir -p -- "$target"
[[ ! -L "$target/.worktree-setup.lock" ]] || die 'Setup lock is a symlink'
exec 9>>"$target/.worktree-setup.lock"
flock 9

cd -- "$checkout"
for package in "${packages[@]}"; do
  case "$package" in
    studio)
      # pnpm links registry packages from its shared virtual store and links
      # workspace packages to the sources checked out in this worktree.
      pnpm --dir apps/kcoder-studio install --frozen-lockfile --prefer-offline --config.enable-global-virtual-store=true
      pnpm --dir apps/kcoder-studio/renderer install --frozen-lockfile --prefer-offline --config.enable-global-virtual-store=true
      ;;
    mobile) npm --prefix apps/kcoder-studio/mobile ci --prefer-offline --no-audit --no-fund ;;
    channel) npm --prefix apps/kcoder-channel-host ci --prefer-offline --no-audit --no-fund ;;
    relay) npm --prefix apps/kcoder-relay ci --prefer-offline --no-audit --no-fund ;;
  esac
done

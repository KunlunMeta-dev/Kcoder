#!/usr/bin/env bash
# Allocate worktrees and transfer explicitly selected changes from the shared checkout.
set -euo pipefail

launcher_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
common="$(git -C "$launcher_root" rev-parse --path-format=absolute --git-common-dir)"
IFS= read -r -d '' primary < <(git -C "$launcher_root" worktree list --porcelain -z)
root="${primary#worktree }"
pool="$root/target/worktree"

usage() {
  cat <<'HELP'
Usage:
  bash scripts/launch/worktree.sh create dev|stable <base-ref>
  bash scripts/launch/worktree.sh create experiment <base-ref> <name>
  bash scripts/launch/worktree.sh import dev|<registered-worktree-path> <repo-relative-file>...
  bash scripts/launch/worktree.sh artifact <category> <name> [--checkout <path>]
  bash scripts/launch/worktree.sh inventory [--details]
HELP
}

die() { printf '%s\n' "$*" >&2; exit 1; }
today() { TZ=Asia/Shanghai date +%Y/%m/%d; }
name_ok() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; }
repo_git() { git --literal-pathspecs -C "$root" "$@"; }
owned_path() {
  local path="$1"
  [[ "$(realpath -m -- "$path")" == "$path" ]] || die "Path traverses a symlink: $path"
}
lock_pool() {
  owned_path "$pool"
  mkdir -p -- "$pool"
  [[ ! -L "$pool/.lock" ]] || die "Worktree lock is a symlink"
  exec 9>>"$pool/.lock"
  flock 9
}

case "${1:-}" in
  create)
    [[ $# == 3 || $# == 4 ]] || die "Specify a role and base ref"
    base_checkout="$launcher_root"
    if [[ "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" == "$common" ]]; then
      base_checkout="$(git rev-parse --show-toplevel)"
    fi
    commit="$(git -C "$base_checkout" rev-parse --verify --end-of-options "$3^{commit}")"
    case "$2" in
      dev|stable)
        [[ $# == 3 ]] || die "Fixed worktrees do not take a name"
        path="$pool/$2"
        branch="codex/workspace-$2"
        ;;
      experiment)
        if [[ $# != 4 ]] || ! name_ok "$4"; then die "Specify a valid experiment name"; fi
        day="$(today)"
        path="$pool/$day/$4"
        branch="codex/experiment/$day/$4"
        ;;
      *) die "Unknown worktree role: $2" ;;
    esac
    lock_pool
    owned_path "$path"
    created=false
    if [[ -e "$path" ]]; then
      [[ "$(git -C "$path" rev-parse --show-toplevel 2>/dev/null)" == "$path" ]] ||
        die "Existing path is not a worktree: $path"
      [[ "$(git -C "$path" rev-parse --absolute-git-dir)" == "$(repo_git rev-parse --absolute-git-dir)/worktrees/"* ]] ||
        die "Worktree belongs to another repository: $path"
      [[ "$(git -C "$path" rev-parse HEAD)" == "$commit" ]] ||
        die "Worktree already exists at another revision: $path"
    else
      mkdir -p -- "$(dirname "$path")"
      if [[ "$2" == stable ]]; then
        repo_git worktree add --detach "$path" "$commit" >&2
      elif repo_git show-ref --verify --quiet "refs/heads/$branch"; then
        [[ "$(repo_git rev-parse "$branch^{commit}")" == "$commit" ]] ||
          die "Existing branch $branch is at another revision; left unchanged"
        repo_git worktree add "$path" "$branch" >&2
      else
        repo_git worktree add -b "$branch" "$path" "$commit" >&2
      fi
      created=true
    fi
    flock -u 9
    exec 9>&-
    if [[ "$2" == experiment && "$created" == true ]]; then
      bash "$launcher_root/scripts/launch/worktree-setup.sh" "$path" >&2 ||
        die "Worktree created at $path; retry setup with scripts/launch/worktree-setup.sh"
    fi
    printf '%s\n' "$path"
    ;;
  import)
    [[ $# -ge 3 ]] || die "Specify a destination and explicit file paths"
    if [[ "$2" == dev ]]; then
      dest="$pool/dev"
    else
      dest="$(realpath -e -- "$2")"
    fi
    shift 2
    lock_pool
    [[ "$dest" != "$root" && "$(git -C "$dest" rev-parse --show-toplevel)" == "$dest" ]] ||
      die "Destination must be a linked worktree"
    [[ "$(git -C "$dest" rev-parse --absolute-git-dir)" == "$(repo_git rev-parse --absolute-git-dir)/worktrees/"* ]] ||
      die "Destination belongs to another repository"
    [[ "$dest" != "$pool/stable" ]] || die "Stable only accepts a selected committed revision"
    for file in "$@"; do
      [[ -n "$file" && "$file" != /* && "$file" != *'//'* && "/$file/" != *'/../'* && "/$file/" != *'/./'* &&
        "/$file/" != *'/.git/'* && "$file" != *$'\n'* && "$file" != */ ]] || die "Invalid repository-relative file: $file"
      if [[ "$file" == */* ]]; then
        owned_path "$root/${file%/*}"
        owned_path "$dest/${file%/*}"
      fi
      [[ ! -d "$root/$file" || -L "$root/$file" ]] || die "Select files, not a directory: $file"
      [[ -z "$(git --literal-pathspecs -C "$dest" status --porcelain -- "$file")" ]] ||
        die "Destination already has changes for: $file"
    done
    receipt="$(bash "$launcher_root/scripts/launch/worktree.sh" artifact checkpoints worktree-import)"
    patch="$receipt/changes.patch"
    repo_git diff --binary --no-ext-diff --no-textconv --no-renames HEAD -- "$@" >"$patch"
    for file in "$@"; do
      if repo_git ls-files --error-unmatch -- "$file" >/dev/null 2>&1 ||
         repo_git cat-file -e "HEAD:$file" 2>/dev/null; then
        continue
      fi
      [[ -f "$root/$file" || -L "$root/$file" ]] || die "File not found: $file"
      result=0
      git -C "$root" check-ignore -q -- "./$file" || result=$?
      [[ "$result" == 1 ]] || die "File is ignored or could not be checked: $file"
      result=0
      repo_git diff --no-index --binary --no-ext-diff --no-textconv -- /dev/null "$file" >>"$patch" || result=$?
      [[ "$result" == 1 ]] || die "Could not capture untracked file: $file"
    done
    [[ -s "$patch" ]] || die "The selected paths contain no changes"
    printf 'source=%s\nsource_head=%s\ndestination=%s\ndestination_head=%s\n' \
      "$root" "$(repo_git rev-parse HEAD)" "$dest" "$(git -C "$dest" rev-parse HEAD)" >"$receipt/source.txt"
    git -C "$dest" apply --check -- "$patch"
    git -C "$dest" apply -- "$patch"
    printf '%s\n' "$receipt"
    ;;
  artifact)
    if [[ $# != 3 && $# != 5 ]] || ! name_ok "$2" || ! name_ok "$3"; then die "Specify a valid category and run name"; fi
    [[ "$2" != worktree && "$2" != worktrees ]] || die "Use create for worktrees"
    artifact_checkout="$launcher_root"
    if [[ $# == 5 ]]; then
      [[ "$4" == --checkout ]] || die "Expected --checkout <path>"
      artifact_checkout="$(realpath -e -- "$5")"
    elif [[ "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" == "$common" ]]; then
      artifact_checkout="$(git rev-parse --show-toplevel)"
    fi
    [[ "$(git -C "$artifact_checkout" rev-parse --show-toplevel)" == "$artifact_checkout" &&
       "$(git -C "$artifact_checkout" rev-parse --path-format=absolute --git-common-dir)" == "$common" ]] ||
      die "Artifact checkout must belong to this repository"
    parent="$artifact_checkout/target/$2/$(today)"
    owned_path "$parent"
    umask 077
    mkdir -p -- "$parent"
    mktemp -d "$parent/$3.XXXXXXXX"
    ;;
  inventory)
    [[ $# == 1 || ( $# == 2 && "$2" == --details ) ]] || die "Unknown inventory option"
    repo_git worktree list --porcelain
    if [[ "${2:-}" == --details ]]; then
      while IFS= read -r -d '' record; do
        [[ "$record" == 'worktree '* ]] || continue
        path="${record#worktree }"
        if dirty="$(timeout 10s git --no-optional-locks -C "$path" status --porcelain --untracked-files=normal 2>/dev/null)"; then
          if [[ -n "$dirty" ]]; then condition=dirty; else condition=clean; fi
        else
          condition=unavailable
        fi
        printf '%s %s\n' "$condition" "$path"
      done < <(repo_git worktree list --porcelain -z)
    fi
    if [[ -d "$root/target" ]]; then
      find "$root/target" -mindepth 1 -maxdepth 1 -printf '%y %P\n' | sort
    fi
    ;;
  -h|--help|'') usage ;;
  *) usage >&2; exit 2 ;;
esac

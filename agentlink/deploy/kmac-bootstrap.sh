#!/bin/bash
# Idempotent, user-space KMac bootstrap for the fixed stage-one prerequisites.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)"
REPO_ROOT="${1:-$(CDPATH= cd -P -- "$SCRIPT_DIR/../.." && pwd -P)}"
BACKUP_TAG="${ARGUS_BACKUP_TAG:-argus-infra-stage1-20260830}"
BACKUP_ROOT="${ARGUS_BACKUP_ROOT:-$HOME/.argus-backups/$BACKUP_TAG}"
AGENTLINK_BASE="${AGENTLINK_INSTALL_ROOT:-$HOME/Library/Application Support/AgentLink}"
PREPARED_ROOT="$AGENTLINK_BASE/prepared/$BACKUP_TAG"
LAUNCHER_SOURCE="$SCRIPT_DIR/codex-launcher.sh"
LAUNCHER_TARGET="$HOME/.local/bin/codex"
ZSHENV="$HOME/.zshenv"
SSH_CONFIG="$HOME/.ssh/config"
REVERSE_PLIST_SOURCE="$SCRIPT_DIR/com.kairong.agentlink-seoul-reverse-tunnel.plist"
REVERSE_PLIST_TARGET="$PREPARED_ROOT/com.kairong.agentlink-seoul-reverse-tunnel.plist"
EXPECTED_REMOTE="git@github-argus-clash:LKRCharon/argus.git"
EXPECTED_FETCH='+refs/heads/*:refs/remotes/origin/*'

sha256_file() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

backup_once() {
  local source=$1
  local name=$2
  local backup="$BACKUP_ROOT/$name"
  if [[ -e "$source" || -L "$source" ]]; then
    if [[ -e "$backup.absent" ]]; then
      printf 'BACKUP source=%s original_state=absent current_sha256=%s marker=%s\n' \
        "$source" "$(sha256_file "$source")" "$backup.absent"
      return
    fi
    if [[ ! -e "$backup" && ! -L "$backup" ]]; then
      /bin/cp -p "$source" "$backup"
    fi
    printf 'BACKUP source=%s source_sha256=%s backup=%s backup_sha256=%s\n' \
      "$source" "$(sha256_file "$source")" "$backup" "$(sha256_file "$backup")"
  else
    if [[ ! -e "$backup.absent" ]]; then
      : > "$backup.absent"
    fi
    printf 'BACKUP source=%s state=absent marker=%s\n' "$source" "$backup.absent"
  fi
}

append_zsh_path_block() {
  local begin='# >>> Argus non-interactive PATH >>>'
  local end='# <<< Argus non-interactive PATH <<<'
  local temporary
  if /usr/bin/grep -Fq "$begin" "$ZSHENV" 2>/dev/null; then
    /usr/bin/grep -Fq "$end" "$ZSHENV" || {
      echo "partial Argus PATH block in $ZSHENV" >&2
      exit 65
    }
    return
  fi
  temporary="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/argus-zshenv.XXXXXX")"
  if [[ -e "$ZSHENV" ]]; then
    /bin/cat "$ZSHENV" > "$temporary"
    printf '\n' >> "$temporary"
  fi
  printf '%s\n' \
    "$begin" \
    'case ":${PATH-}:" in' \
    '  *":/opt/homebrew/bin:"*) ;;' \
    '  *) PATH="/opt/homebrew/bin:${PATH-}" ;;' \
    'esac' \
    'case ":$PATH:" in' \
    '  *":$HOME/.local/bin:"*) ;;' \
    '  *) PATH="$HOME/.local/bin:$PATH" ;;' \
    'esac' \
    'export PATH' \
    "$end" >> "$temporary"
  /bin/chmod 0644 "$temporary"
  /bin/mv -f "$temporary" "$ZSHENV"
}

append_github_ssh_block() {
  local begin='# >>> Argus GitHub through Clash >>>'
  local end='# <<< Argus GitHub through Clash <<<'
  local temporary
  if /usr/bin/grep -Fq "$begin" "$SSH_CONFIG" 2>/dev/null; then
    /usr/bin/grep -Fq "$end" "$SSH_CONFIG" || {
      echo "partial Argus GitHub SSH block in $SSH_CONFIG" >&2
      exit 65
    }
    return
  fi
  if /usr/bin/grep -Eq '^[[:space:]]*Host[[:space:]]+([^#]*[[:space:]])?github-argus-clash([[:space:]]|$)' "$SSH_CONFIG" 2>/dev/null; then
    echo "unmanaged github-argus-clash host already exists in $SSH_CONFIG" >&2
    exit 65
  fi
  temporary="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/argus-ssh-config.XXXXXX")"
  if [[ -e "$SSH_CONFIG" ]]; then
    /bin/cat "$SSH_CONFIG" > "$temporary"
    printf '\n' >> "$temporary"
  fi
  printf '%s\n' \
    "$begin" \
    'Host github-argus-clash' \
    '    HostName ssh.github.com' \
    '    User git' \
    '    Port 443' \
    '    HostKeyAlias github.com' \
    '    ProxyCommand /usr/bin/nc -X connect -x 127.0.0.1:46640 %h %p' \
    '    BatchMode yes' \
    '    ConnectTimeout 10' \
    "$end" >> "$temporary"
  /bin/chmod 0600 "$temporary"
  /bin/mv -f "$temporary" "$SSH_CONFIG"
}

if [[ ! -d "$REPO_ROOT" ]] || ! /usr/bin/git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "not an Argus Git checkout: $REPO_ROOT" >&2
  exit 64
fi
if [[ ! -x "$LAUNCHER_SOURCE" ]]; then
  echo "launcher source is not executable: $LAUNCHER_SOURCE" >&2
  exit 66
fi
/usr/bin/plutil -lint "$REVERSE_PLIST_SOURCE" >/dev/null

/bin/mkdir -p "$BACKUP_ROOT" "$HOME/.local/bin" "$HOME/.ssh" "$PREPARED_ROOT"
/bin/chmod 0700 "$BACKUP_ROOT" "$PREPARED_ROOT"

git_common_dir="$(/usr/bin/git -C "$REPO_ROOT" rev-parse --git-common-dir)"
if [[ "$git_common_dir" != /* ]]; then
  git_common_dir="$REPO_ROOT/$git_common_dir"
fi
git_config="$git_common_dir/config"

backup_once "$ZSHENV" zshenv.before
backup_once "$SSH_CONFIG" ssh-config.before
backup_once "$LAUNCHER_TARGET" codex-launcher.before
backup_once "$git_config" git-config.before
backup_once "$REVERSE_PLIST_TARGET" reverse-tunnel-plist.before

/usr/bin/install -m 0755 "$LAUNCHER_SOURCE" "$LAUNCHER_TARGET"
append_zsh_path_block
append_github_ssh_block
/usr/bin/install -m 0600 "$REVERSE_PLIST_SOURCE" "$REVERSE_PLIST_TARGET"

/usr/bin/git -C "$REPO_ROOT" remote get-url origin >/dev/null
/usr/bin/git -C "$REPO_ROOT" remote set-url origin "$EXPECTED_REMOTE"
/usr/bin/git -C "$REPO_ROOT" config --local --unset-all remote.origin.fetch >/dev/null 2>&1 || true
/usr/bin/git -C "$REPO_ROOT" config --local --add remote.origin.fetch "$EXPECTED_FETCH"
GIT_TERMINAL_PROMPT=0 /usr/bin/git -C "$REPO_ROOT" fetch --prune origin

printf 'INSTALLED codex_launcher=%s sha256=%s\n' "$LAUNCHER_TARGET" "$(sha256_file "$LAUNCHER_TARGET")"
printf 'UPDATED zshenv=%s sha256=%s\n' "$ZSHENV" "$(sha256_file "$ZSHENV")"
printf 'UPDATED ssh_config=%s sha256=%s\n' "$SSH_CONFIG" "$(sha256_file "$SSH_CONFIG")"
printf 'UPDATED git_config=%s sha256=%s\n' "$git_config" "$(sha256_file "$git_config")"
printf 'STAGED reverse_tunnel_plist=%s sha256=%s loaded=no\n' \
  "$REVERSE_PLIST_TARGET" "$(sha256_file "$REVERSE_PLIST_TARGET")"
printf 'REMOTE url=%s fetch=%s\n' \
  "$(/usr/bin/git -C "$REPO_ROOT" remote get-url origin)" \
  "$(/usr/bin/git -C "$REPO_ROOT" config --local --get-all remote.origin.fetch)"

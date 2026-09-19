#!/usr/bin/env bash
#
# J.A.R.V.I.S. — one command to get running on a Mac.
#
# This is the "I just want it to work" script. It checks everything JARVIS
# needs, installs what is missing (asking first, every time), and then starts
# both halves of the app and opens it in Chrome for you.
#
#   bash scripts/mac-setup.sh
#
# It is safe to run more than once. Anything already in place is left alone,
# and nothing is installed without your say-so.
#
# Options:
#   --writes      Let JARVIS take real actions (phone, browser, sending).
#                 Off by default: he can look at anything and change nothing.
#   --no-start    Do the checks and the install, but do not start the app.
#   --yes         Say yes to every install prompt (for unattended runs).
#   --help        Show this and exit.
#
# Why a shell script and not another Node script: half of what it checks is
# whether Node exists at all.

set -euo pipefail

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

WRITES=0
START=1
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --writes) WRITES=1 ;;
    --no-start) START=0 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --help | -h)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 1
      ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Talking to a human
#
# Every message is written for someone who does not write code. A failure says
# what is wrong, why it matters, and the exact thing to do about it.
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; RESET=''
fi

STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d]%s %s%s%s\n' "$CYAN" "$STEP" "$TOTAL_STEPS" "$RESET" "$BOLD" "$1" "$RESET"; }
ok()   { printf '      %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
note() { printf '      %s·%s %s\n' "$DIM" "$RESET" "$1"; }
warn() { printf '      %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }

# A failure is a full stop with instructions, never a bare error code.
die() {
  printf '\n%s%s  Setup stopped.%s\n\n' "$RED$BOLD" "✗" "$RESET"
  printf '  %s\n\n' "$1"
  shift
  if [ $# -gt 0 ]; then
    printf '  %sWhat to do:%s\n' "$BOLD" "$RESET"
    for fix in "$@"; do printf '    %s\n' "$fix"; done
    printf '\n'
  fi
  printf '  %sThen run this again:%s  bash scripts/mac-setup.sh\n\n' "$DIM" "$RESET"
  exit 1
}

# Yes/no, defaulting to yes. Without a terminal we answer "no" rather than
# install things behind someone's back — unless --yes was passed.
ask() {
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  local reply=''
  printf '      %s?%s %s [Y/n] ' "$YELLOW" "$RESET" "$1"
  read -r reply || reply=''
  case "$reply" in
    [nN] | [nN][oO]) return 1 ;;
    *) return 0 ;;
  esac
}

TOTAL_STEPS=9
[ "$START" = "1" ] || TOTAL_STEPS=8

printf '\n%s  J.A.R.V.I.S. — Mac setup%s\n' "$BOLD" "$RESET"
printf '  %sChecking what you have, installing what you need, then starting it up.%s\n' "$DIM" "$RESET"

# ---------------------------------------------------------------------------
# 1. A Mac, and the project
# ---------------------------------------------------------------------------

step 'Checking you are on a Mac'

if [ "$(uname -s)" != "Darwin" ]; then
  die "This script is for macOS, and this computer is running $(uname -s)." \
    "On Linux or Windows, follow the Quick start in README.md instead:" \
    "  npm install  &&  npm start"
fi
ok "macOS on $(uname -m) hardware."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f package.json ] || ! grep -q '"jarvis"' package.json; then
  die "This script cannot find the JARVIS project files." \
    "Make sure you downloaded the project and are inside its folder:" \
    "  git clone https://github.com/Mamoun506-coder/jarvis.git" \
    "  cd jarvis" \
    "  bash scripts/mac-setup.sh"
fi
ok "Project found at $REPO_ROOT"

# ---------------------------------------------------------------------------
# 2. Node.js 20 or newer
#
# The one unavoidable tool: this is a Node web app. If it is missing or too
# old we offer Homebrew, which is how a Mac installs developer tools.
# ---------------------------------------------------------------------------

step 'Checking Node.js (version 20 or newer)'

# Homebrew puts itself in different places on Apple Silicon and Intel, and a
# fresh install is not on PATH until a new terminal opens — so we look in both
# places and pull it onto PATH ourselves.
load_homebrew() {
  if command -v brew >/dev/null 2>&1; then return 0; fi
  local candidate
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      eval "$("$candidate" shellenv)"
      return 0
    fi
  done
  return 1
}

install_homebrew() {
  if ! xcode-select -p >/dev/null 2>&1; then
    warn 'Apple’s command line tools are needed first. Opening the installer…'
    xcode-select --install >/dev/null 2>&1 || true
    die "Apple’s command line tools are installing in a separate window." \
      "Click through that installer and wait for it to finish (it takes a few minutes)."
  fi
  note 'Installing Homebrew — it will ask for your Mac password. That is normal.'
  note 'Your password is typed blind: no dots appear as you type. Press Return when done.'
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_homebrew || die "Homebrew finished installing but cannot be found on this terminal." \
    "Quit Terminal completely (Cmd-Q), open it again, and re-run this script."
}

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

NODE_MAJOR="$(node_major || true)"

if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
  ok "Node.js $(node -v) is installed."
else
  if [ -z "$NODE_MAJOR" ]; then
    warn 'Node.js is not installed. JARVIS cannot run without it.'
  else
    warn "Node.js $(node -v) is too old — JARVIS needs version 20 or newer."
  fi

  if ! ask 'Install Node.js now (using Homebrew)?'; then
    die "Node.js 20 or newer is required and was not installed." \
      "Install it yourself from https://nodejs.org (click the big LTS button)," \
      "then run this script again."
  fi

  load_homebrew || install_homebrew
  note 'Installing Node.js — this can take a few minutes.'
  brew install node || die "Homebrew could not install Node.js." \
    "Install it by hand instead: download the LTS installer from https://nodejs.org," \
    "run it, then quit and reopen Terminal."

  hash -r
  NODE_MAJOR="$(node_major || true)"
  if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
    die "Node.js was installed but this terminal still cannot see version 20 or newer." \
      "Quit Terminal completely (Cmd-Q), open it again, and re-run this script."
  fi
  ok "Node.js $(node -v) installed."
fi

command -v npm >/dev/null 2>&1 || die \
  "npm is missing. It normally arrives with Node.js, so the Node install is incomplete." \
  "Reinstall Node.js from https://nodejs.org, then run this script again."
ok "npm $(npm -v) is ready."

# ---------------------------------------------------------------------------
# 3. Claude Code — the brain
#
# The only account JARVIS needs. The bridge runs Claude Code headless and
# borrows its login, so there is no API key anywhere in this setup.
# ---------------------------------------------------------------------------

step 'Checking Claude Code (this is the brain — and the only account you need)'

if command -v claude >/dev/null 2>&1; then
  ok "Claude Code found: $(claude --version 2>/dev/null | head -1)"
else
  warn 'Claude Code is not installed. It is what JARVIS actually thinks with.'
  if ! ask 'Install Claude Code now?'; then
    die "Claude Code is required and was not installed." \
      "Install it yourself with:  npm install -g @anthropic-ai/claude-code" \
      "or use the installer at https://docs.claude.com/en/docs/claude-code"
  fi
  if ! npm install -g @anthropic-ai/claude-code; then
    die "Installing Claude Code failed (this is usually a permissions problem)." \
      "Try the official installer instead:" \
      "  curl -fsSL https://claude.ai/install.sh | bash" \
      "then quit and reopen Terminal."
  fi
  hash -r
  command -v claude >/dev/null 2>&1 || die \
    "Claude Code installed but this terminal cannot find it yet." \
    "Quit Terminal completely (Cmd-Q), open it again, and re-run this script."
  ok "Claude Code installed: $(claude --version 2>/dev/null | head -1)"
fi

# ---------------------------------------------------------------------------
# 4. Claude Code login
#
# Four places a completed login can leave its mark. Any one of them means the
# bridge will be able to authenticate.
# ---------------------------------------------------------------------------

step 'Checking you are signed in to Claude Code'

claude_is_authenticated() {
  # A subscription login on a Mac stores its token in the Keychain.
  if security find-generic-password -s 'Claude Code-credentials' >/dev/null 2>&1; then return 0; fi
  # Some installs keep it in a file instead.
  if [ -s "$HOME/.claude/.credentials.json" ]; then return 0; fi
  # An API key in the environment also authenticates (not required, but valid).
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then return 0; fi
  # And a completed login always leaves an account record here.
  if [ -f "$HOME/.claude.json" ]; then
    node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude.json","utf8"));process.exit(j&&j.oauthAccount?0:1)}catch(e){process.exit(1)}' && return 0
  fi
  return 1
}

if claude_is_authenticated; then
  ok 'Signed in. The bridge will use this login — no API key needed.'
else
  warn 'You are not signed in to Claude Code yet.'
  note 'JARVIS thinks with your Claude subscription, so this is the one login required.'
  if ask 'Open the Claude sign-in now?'; then
    printf '\n      %sClaude is opening. Sign in, then type %s/exit%s and press Return to come back.%s\n\n' \
      "$DIM" "$BOLD" "$RESET$DIM" "$RESET"
    claude || true
    hash -r
  fi
  if ! claude_is_authenticated; then
    die "Claude Code is installed but not signed in, so JARVIS would have nothing to think with." \
      "Type this and press Return:   claude" \
      "Sign in when it asks (a browser window opens)." \
      "Type  /exit  to leave Claude."
  fi
  ok 'Signed in.'
fi

# ---------------------------------------------------------------------------
# 5. Settings
#
# There is nothing you must configure. We create .env.local from the example
# so the file is there when you want it, and leave every value commented out.
# ---------------------------------------------------------------------------

step 'Setting up your settings file'

if [ -f .env.local ]; then
  ok '.env.local already exists — leaving your settings untouched.'
elif [ -f .env.example ]; then
  cp .env.example .env.local
  ok 'Created .env.local from the example (everything in it is optional).'
else
  note 'No .env.example to copy — that is fine, JARVIS runs on its defaults.'
fi

# The bridge reads ELEVENLABS_API_KEY and the JARVIS_* settings from the shell
# environment, not from .env.local — so a key written into that file would
# otherwise sit there doing nothing. Load those lines and pass them through.
load_env_local() {
  [ -f .env.local ] || return 0
  local raw line key value
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      '' | '#'*) continue ;;
      JARVIS_*=* | ELEVENLABS_API_KEY=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    [ -n "$value" ] || continue
    export "$key=$value"
  done < .env.local
}
load_env_local

# ElevenLabs is a genuinely optional upgrade: a nicer voice and sharper
# hearing. Without it the browser's own speech does the job, free.
eleven_key_source() {
  if [ -n "${ELEVENLABS_API_KEY:-}" ]; then echo 'your settings'; return 0; fi
  if [ -f "$HOME/.claude.json" ]; then
    node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude.json","utf8"));process.exit(j?.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY?0:1)}catch(e){process.exit(1)}' \
      && { echo 'your elevenlabs MCP server'; return 0; }
  fi
  return 1
}

if KEY_SOURCE="$(eleven_key_source)"; then
  ok "Premium voice on — ElevenLabs key found in $KEY_SOURCE."
else
  note 'No ElevenLabs key — JARVIS will speak with the built-in browser voice.'
  note 'That is completely fine and costs nothing. Nothing else is needed.'
  note 'Optional upgrade: put ELEVENLABS_API_KEY=your-key in .env.local for a better voice.'
fi

# ---------------------------------------------------------------------------
# 6. Project dependencies
# ---------------------------------------------------------------------------

step 'Installing the project’s building blocks'

note 'First run downloads a few hundred packages — give it a minute or two.'
if ! npm install; then
  die "Installing the project’s dependencies failed." \
    "Check you are connected to the internet, then try:" \
    "  rm -rf node_modules package-lock.json && npm install" \
    "If that fails too, copy the red error text above when asking for help."
fi
ok 'All dependencies installed.'

# ---------------------------------------------------------------------------
# 7. A real browser
#
# JARVIS needs a microphone and WebGL, which means Chrome or Edge in a real
# window. Safari is not enough, and neither is a preview pane inside an editor.
# ---------------------------------------------------------------------------

step 'Checking for Chrome (JARVIS needs Chrome or Edge to hear you)'

find_browser() {
  local name
  for name in 'Google Chrome' 'Microsoft Edge'; do
    if [ -d "/Applications/$name.app" ] || [ -d "$HOME/Applications/$name.app" ]; then
      echo "$name"
      return 0
    fi
  done
  return 1
}

BROWSER=''
if BROWSER="$(find_browser)"; then
  ok "$BROWSER is installed."
else
  warn 'Neither Chrome nor Edge was found. Safari cannot run JARVIS’s microphone.'
  if ask 'Install Google Chrome now (using Homebrew)?'; then
    if load_homebrew || install_homebrew; then
      brew install --cask google-chrome || warn 'Chrome could not be installed automatically.'
      BROWSER="$(find_browser || true)"
    fi
  fi
  if [ -z "$BROWSER" ]; then
    warn 'Carrying on without Chrome — but JARVIS will not be able to hear you.'
    note 'Download it free from https://www.google.com/chrome and open the app there.'
  fi
fi

# ---------------------------------------------------------------------------
# 8. Free ports
#
# 8787 is the bridge, 5173 is the interface. Something already sitting on
# either one produces a confusing half-working app, so we catch it here.
# ---------------------------------------------------------------------------

step 'Checking nothing else is using JARVIS’s two doors (ports 8787 and 5173)'

port_user() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

for PORT_NUM in 8787 5173; do
  PID_ON_PORT="$(port_user "$PORT_NUM" || true)"
  if [ -n "$PID_ON_PORT" ]; then
    PORT_NAME='the interface'
    [ "$PORT_NUM" = '8787' ] && PORT_NAME='the brain'
    warn "Port $PORT_NUM ($PORT_NAME) is already in use by process $PID_ON_PORT."
    if ask "Stop that process so JARVIS can use port $PORT_NUM?"; then
      kill "$PID_ON_PORT" 2>/dev/null || true
      sleep 2
      if [ -n "$(port_user "$PORT_NUM" || true)" ]; then
        die "Port $PORT_NUM is still busy." \
          "It is probably an older copy of JARVIS still running in another Terminal window." \
          "Close that window, or run:  kill $(port_user "$PORT_NUM")"
      fi
      ok "Port $PORT_NUM is free now."
    else
      die "Port $PORT_NUM is in use, and JARVIS needs it." \
        "Close whatever is using it — usually an older copy of JARVIS in another Terminal window —" \
        "or run:  kill $PID_ON_PORT"
    fi
  else
    ok "Port $PORT_NUM is free."
  fi
done

# ---------------------------------------------------------------------------
# 9. Launch
# ---------------------------------------------------------------------------

if [ "$START" = "0" ]; then
  printf '\n%s  Everything is ready.%s\n\n' "$GREEN$BOLD" "$RESET"
  printf '  Start JARVIS whenever you like with:\n'
  printf '    %scd %s && npm start%s\n\n' "$BOLD" "$REPO_ROOT" "$RESET"
  exit 0
fi

step 'Starting JARVIS'

if [ "$WRITES" = "1" ]; then
  warn 'Starting with actions ENABLED — JARVIS can drive your phone, browser and send things.'
else
  note 'Starting read-only: JARVIS can look at anything and change nothing.'
  note 'To let him act, run this script again with --writes on the end.'
fi

APP_PID=''
cleanup() {
  trap - INT TERM EXIT
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

if [ "$WRITES" = "1" ]; then
  npm start -- --writes &
else
  npm start &
fi
APP_PID=$!

# Wait for each half to actually answer before declaring victory — "it printed
# a URL" and "it is ready" are not the same thing.
wait_for_url() {
  local url="$1" tries="${2:-90}" i=0
  while [ "$i" -lt "$tries" ]; do
    kill -0 "$APP_PID" 2>/dev/null || return 1
    curl -fsS --max-time 2 -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

printf '\n      %sWaiting for both halves to come up…%s\n' "$DIM" "$RESET"

if ! wait_for_url 'http://127.0.0.1:8787/health'; then
  die "The brain (the bridge) did not start." \
    "Look at the red text above for the reason." \
    "The usual cause is not being signed in — type  claude  and sign in, then try again."
fi
ok 'The brain is awake (bridge on port 8787).'

if ! wait_for_url 'http://127.0.0.1:5173/'; then
  die "The interface did not start." \
    "Look at the red text above for the reason, then run this script again."
fi
ok 'The interface is up (http://localhost:5173).'

if [ -n "$BROWSER" ]; then
  open -a "$BROWSER" 'http://localhost:5173' 2>/dev/null \
    && ok "Opened JARVIS in $BROWSER." \
    || note 'Could not open the browser automatically — open http://localhost:5173 yourself.'
else
  note 'Open http://localhost:5173 in Chrome or Edge to see JARVIS.'
fi

printf '\n%s  JARVIS is running.%s\n\n' "$GREEN$BOLD" "$RESET"
printf '    1. In the Chrome window, click %sINITIALISE%s\n' "$BOLD" "$RESET"
printf '    2. Click %sAllow%s when it asks for your microphone\n' "$BOLD" "$RESET"
printf '    3. Say %s“Hey Jarvis”%s\n\n' "$BOLD" "$RESET"
printf '  %sIt must be a real Chrome window — a preview pane inside an editor blocks the%s\n' "$DIM" "$RESET"
printf '  %smicrophone, so JARVIS looks perfectly alive and simply never answers.%s\n\n' "$DIM" "$RESET"
printf '  %sPress Ctrl-C in this window to stop JARVIS.%s\n\n' "$DIM" "$RESET"

wait "$APP_PID" || true

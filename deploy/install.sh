#!/bin/sh
# Installs Hearth with Docker Compose on one machine.
#
#   curl -fsSL https://qureshi-dh.github.io/hearth/install.sh | sh
#
# It asks for a domain, your email and a password, generates every other
# secret, writes docker-compose.yml and .env into ./hearth and starts the
# stack. Given a domain, Caddy gets the TLS certificate for it. Without one,
# Hearth listens on port 4000 for phones on the same network.
#
# For an unattended install, set the answers up front:
#
#   curl -fsSL https://qureshi-dh.github.io/hearth/install.sh | \
#     HEARTH_DOMAIN=hearth.example.com HEARTH_ADMIN_EMAIL=you@example.com sh
#
#   HEARTH_DOMAIN          the domain phones will use, or "none" for no TLS
#   HEARTH_ADMIN_EMAIL     your account
#   HEARTH_ADMIN_PASSWORD  at least 10 characters. Generated when not given
#   HEARTH_DIR             where the files go (default ./hearth)
#   HEARTH_REF             the git ref the compose files come from (default main)
#   HEARTH_RAW             a fork's raw file URL, to install from it instead
#   HEARTH_NO_START=1      write the files and stop before starting anything
#
# Everything sits inside main(), which runs on the last line, so a download
# cut off halfway runs nothing at all.

set -eu

say() {
  printf '%s\n' "$*"
}

fail() {
  printf '\nhearth: %s\n' "$*" >&2
  exit 1
}

has() {
  command -v "$1" >/dev/null 2>&1
}

# Piped into sh, stdin is the script itself, so answers come from the terminal.
can_ask() {
  [ -t 0 ] && return 0
  (: </dev/tty) 2>/dev/null
}

ask() {
  printf '%s' "$1" >/dev/tty
  read -r answer </dev/tty || answer=""
  printf '%s' "$answer"
}

ask_secret() {
  printf '%s' "$1" >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  read -r answer </dev/tty || answer=""
  stty echo </dev/tty 2>/dev/null || true
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}

random_hex() {
  if has openssl; then
    openssl rand -hex "$1"
  else
    od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

fetch() {
  if has curl; then
    curl -fsSL "$1" -o "$2"
  elif has wget; then
    wget -qO "$2" "$1"
  else
    fail "curl or wget is needed to download the compose files."
  fi
}

lan_address() {
  address=$(hostname -I 2>/dev/null | awk '{ print $1 }') || address=""
  [ -n "$address" ] || address=$(ipconfig getifaddr en0 2>/dev/null) || address=""
  [ -n "$address" ] || address=$(ip route get 1.1.1.1 2>/dev/null |
    awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }') || address=""
  printf '%s' "${address:-localhost}"
}

check_docker() {
  has docker || fail "Docker isn't installed. https://docs.docker.com/engine/install/ has the steps for your system, then run this again."
  docker compose version >/dev/null 2>&1 ||
    fail "Docker Compose v2 isn't available. 'docker compose version' should print a version."
  docker info >/dev/null 2>&1 ||
    fail "Docker is installed but this user can't reach it. Start Docker, or run this again with sudo, or add yourself to the docker group."
}

main() {
  dir=${HEARTH_DIR:-hearth}
  raw=${HEARTH_RAW:-https://raw.githubusercontent.com/Qureshi-DH/hearth/${HEARTH_REF:-main}}
  domain=${HEARTH_DOMAIN:-}
  email=${HEARTH_ADMIN_EMAIL:-}
  password=${HEARTH_ADMIN_PASSWORD:-}

  [ -n "${HEARTH_NO_START:-}" ] || check_docker

  if [ -e "$dir/.env" ]; then
    fail "$dir/.env already exists, so Hearth is set up there already. To start it, or to upgrade it: cd $dir && docker compose pull && docker compose up -d"
  fi

  say "Hearth installer"
  say ""

  if [ -z "$domain" ]; then
    can_ask || fail "Set HEARTH_DOMAIN (or HEARTH_DOMAIN=none) to install without a terminal."
    say "The domain phones will reach Hearth at, such as hearth.example.com. Its DNS"
    say "should already point at this machine, with ports 80 and 443 open."
    say "Leave it empty to try Hearth on this network without HTTPS."
    domain=$(ask "Domain: ")
  fi
  domain=$(printf '%s' "$domain" | sed -e 's#^[a-zA-Z]*://##' -e 's#/*$##' | tr 'A-Z' 'a-z')
  if [ "$domain" = "none" ]; then
    domain=""
  fi
  if [ -n "$domain" ]; then
    case $domain in
      *[!a-zA-Z0-9.-]* | .* | *. | *..*) bad=1 ;;
      *.*) bad="" ;;
      *) bad=1 ;;
    esac
    [ -z "$bad" ] || fail "\"$domain\" doesn't look like a domain. Use just the name, like hearth.example.com."
  fi

  if [ -z "$email" ]; then
    can_ask || fail "Set HEARTH_ADMIN_EMAIL to install without a terminal."
    email=$(ask "Your email, for the admin account: ")
  fi
  case $email in
    *@*.*) ;;
    *) fail "\"$email\" doesn't look like an email address." ;;
  esac
  case $email in
    *[\ \'\"]*) fail "The email can't contain spaces or quotes." ;;
  esac

  generated=""
  if [ -z "$password" ] && can_ask; then
    password=$(ask_secret "Admin password, at least 10 characters (empty to generate one): ")
  fi
  if [ -z "$password" ]; then
    password=$(random_hex 12)
    generated=1
  fi
  [ ${#password} -ge 10 ] || fail "The password needs at least 10 characters."
  case $password in
    *\'*) fail "The password can't contain a single quote, because it's written to .env inside them." ;;
  esac

  mkdir -p "$dir"
  cd "$dir"
  here=$(pwd)

  fetch "$raw/deploy/compose/docker-compose.yml" docker-compose.yml
  if [ -n "$domain" ]; then
    fetch "$raw/deploy/compose/caddy.yml" caddy.yml
    public_url="https://$domain"
  else
    public_url="http://$(lan_address):4000"
  fi

  umask 077
  {
    say "# Written by the Hearth installer. Every variable is described in"
    say "# https://github.com/Qureshi-DH/hearth/blob/main/.env.example"
    say ""
    if [ -n "$domain" ]; then
      say "COMPOSE_FILE=docker-compose.yml:caddy.yml"
      say "HEARTH_DOMAIN=$domain"
      say "TRUST_PROXY=true"
    else
      say "# No TLS, so the API listens on every interface for phones on this"
      say "# network. Never leave it like this on a machine the internet can reach."
      say "HEARTH_BIND=0.0.0.0"
    fi
    say "PUBLIC_URL=$public_url"
    say ""
    say "ADMIN_EMAIL=$email"
    say "# Only read on the very first start. Change it from the app afterwards."
    say "ADMIN_PASSWORD='$password'"
    say ""
    say "JWT_SECRET=$(random_hex 48)"
    say "POSTGRES_PASSWORD=$(random_hex 24)"
    say "S3_ACCESS_KEY_ID=hearth"
    say "S3_SECRET_ACCESS_KEY=$(random_hex 24)"
    say ""
    say "REGISTRATION_MODE=invite"
    say "PUSH_PROVIDER=none"
  } >.env

  if [ -n "${HEARTH_NO_START:-}" ]; then
    say ""
    say "Wrote $here/docker-compose.yml and $here/.env. Start it with:"
    say "  cd $here && docker compose up -d"
    return 0
  fi

  say ""
  say "Pulling the images and starting Hearth. The first start takes a minute."
  docker compose up -d

  tries=0
  until docker compose exec -T api curl -fsS http://localhost:4000/readyz >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      say ""
      say "Hearth hasn't said it's ready after two minutes. See what it says with:"
      say "  cd $here && docker compose logs api"
      exit 1
    fi
    sleep 2
  done

  say ""
  say "Hearth is running."
  say ""
  say "  Server address  $public_url"
  say "  Admin email     $email"
  if [ -n "$generated" ]; then
    say "  Admin password  $password"
    say "                  Write it down. It's also in $here/.env until you change it in the app."
  fi
  say ""
  if [ -n "$domain" ]; then
    say "Caddy asks for the certificate on the first visit, so the first request to"
    say "$public_url can take a few seconds."
  else
    say "There's no HTTPS yet, so this is for trying it out on this network. Before you"
    say "invite anyone outside it, put a domain and TLS in front:"
    say "  https://qureshi-dh.github.io/hearth/docs/install/self-hosting/#3-put-tls-in-front"
  fi
  say ""
  say "Next, install the app, type the server address on its first screen and sign in."
  say "Everyone else joins with an invite you send from the app."
  say ""
  say "  Admin portal  $public_url"
  say "  Upgrade       cd $here && docker compose pull && docker compose up -d"
  say "  Backups       https://qureshi-dh.github.io/hearth/docs/install/self-hosting/#backups"
}

main "$@"

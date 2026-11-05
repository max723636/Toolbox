#!/bin/sh
# =====================================================================
#  Toolbox Handy-Panel – Installation mit einem einzigen Befehl
#  für Android (Termux), Linux und macOS
#
#    curl -fsSL https://max723636.github.io/Toolbox/install.sh | sh
#
#  Optionen (vor „sh“ schreiben, z. B.  … | FERN=1 JAVA=1 sh ):
#    FERN=1   Fernzugriff gleich einschalten (sichere https-Adresse für unterwegs)
#    JAVA=1   Java 21 mitinstallieren (für Minecraft-Server)
#    PORT=…   anderer Port (Standard 8090)
#    APP=…    Adresse deiner Toolbox-App (Standard: https://max723636.github.io/Toolbox/)
#
#  Was passiert: Node.js wird installiert (falls nötig), das Panel nach
#  ~/handy-panel geladen, der Befehl „hp“ und der Autostart eingerichtet
#  und das Panel im Hintergrund gestartet. Danach zeigt es den Link bzw.
#  QR-Code zum Verbinden mit der App. Erneut ausführen = aktualisieren.
# =====================================================================
set -e

main() {
  APP="${APP:-https://max723636.github.io/Toolbox/}"
  case "$APP" in */) ;; *) APP="$APP/" ;; esac
  DIR="$HOME/handy-panel"
  mkdir -p "$DIR"
  TERMUX=; case "${PREFIX:-}" in *com.termux*) TERMUX=1 ;; esac
  OS=$(uname -s); M=$(uname -m)
  SUDO=; [ "$(id -u)" != 0 ] && have sudo && SUDO=sudo

  printf '\n\033[1mToolbox Handy-Panel – Installation\033[0m\n'

  # ---------- Node.js ----------
  if [ -x "$DIR/node/bin/node" ]; then PATH="$DIR/node/bin:$PATH"; export PATH; fi
  if nodeok; then
    ok "Node.js $(node -v) ist schon da"
  elif [ -n "$TERMUX" ]; then
    step "Installiere Node.js (Termux)"
    DEBIAN_FRONTEND=noninteractive pkg upgrade -y -o Dpkg::Options::=--force-confnew || true
    pkg install -y nodejs-lts || pkg install -y nodejs
  elif [ -f /etc/alpine-release ]; then
    step "Installiere Node.js (Alpine)"
    $SUDO apk add --no-cache nodejs
  else
    step "Lade Node.js (nur für dich, ohne Admin-Rechte)"
    case "$OS-$M" in
      Linux-x86_64|Linux-amd64) P=linux-x64; V=24 ;;
      Linux-aarch64|Linux-arm64) P=linux-arm64; V=24 ;;
      Linux-armv7l|Linux-armv8l) P=linux-armv7l; V=22 ;;
      Darwin-arm64) P=darwin-arm64; V=24 ;;
      Darwin-x86_64) P=darwin-x64; V=24 ;;
      *) die "Für $OS/$M gibt es kein fertiges Node.js. Bitte Node.js 18+ selbst installieren und den Befehl erneut ausführen." ;;
    esac
    B="https://nodejs.org/dist/latest-v$V.x/"
    L=$(gets "${B}SHASUMS256.txt" | grep " node-v[0-9.]*-$P.tar.gz\$" | head -n 1)
    [ -n "$L" ] || die "Konnte die Node.js-Version nicht ermitteln (Internet?)."
    SUM=${L%% *}; NAME=${L##* }
    get "$B$NAME" "$DIR/node.tar.gz"
    checksum "$DIR/node.tar.gz" "$SUM" || die "Prüfsumme von Node.js stimmt nicht – bitte erneut versuchen."
    rm -rf "$DIR/node"; mkdir -p "$DIR/node"
    tar -xzf "$DIR/node.tar.gz" -C "$DIR/node" --strip-components=1
    rm -f "$DIR/node.tar.gz"
    PATH="$DIR/node/bin:$PATH"; export PATH
  fi
  nodeok || die "Node.js 18 oder neuer ließ sich nicht starten. Bitte selbst installieren (https://nodejs.org) und den Befehl erneut ausführen."
  ok "Node.js $(node -v)"

  # ---------- Java (nur mit JAVA=1) ----------
  if [ -n "${JAVA:-}" ]; then
    if [ -n "$TERMUX" ]; then
      step "Installiere Java 21 (Termux)"; pkg install -y openjdk-21 || warn "Java ließ sich nicht installieren – später: pkg install openjdk-21"
    elif [ "$(javamajor)" -ge 21 ]; then
      ok "Java $(javamajor) ist schon da"
    else
      step "Lade Java 21 (Eclipse Temurin, nur für dich)"
      case "$OS" in Darwin) JO=mac ;; *) JO=linux ;; esac
      [ -f /etc/alpine-release ] && JO=alpine-linux
      case "$M" in x86_64|amd64) JA=x64 ;; aarch64|arm64) JA=aarch64 ;; armv7l|armv8l) JA=arm ;; *) JA= ;; esac
      if [ -n "$JA" ] && get "https://api.adoptium.net/v3/binary/latest/21/ga/$JO/$JA/jre/hotspot/normal/eclipse" "$DIR/java.tar.gz"; then
        rm -rf "$DIR/java"; mkdir -p "$DIR/java"; tar -xzf "$DIR/java.tar.gz" -C "$DIR/java"; rm -f "$DIR/java.tar.gz"; ok "Java 21 liegt in $DIR/java"
      else warn "Java ließ sich nicht laden – Minecraft-Server brauchen Java 21 (z. B. sudo apt install openjdk-21-jre-headless)."; fi
    fi
  fi

  # ---------- QR-Code im Terminal (klein, optional) ----------
  if ! have qrencode; then
    if [ -n "$TERMUX" ]; then pkg install -y libqrencode >/dev/null 2>&1 || true
    elif [ "$OS" = Darwin ] && have brew; then brew install qrencode >/dev/null 2>&1 || true; fi
  fi

  # ---------- Panel laden ----------
  step "Lade das Handy-Panel von $APP"
  get "${APP}handy-panel.js" "$DIR/handy-panel.js.neu"
  grep -q "Toolbox Handy-Panel" "$DIR/handy-panel.js.neu" || { rm -f "$DIR/handy-panel.js.neu"; die "Unter ${APP}handy-panel.js liegt kein Handy-Panel."; }
  cp "$DIR/handy-panel.js.neu" "$DIR/hp-check.js"
  node --check "$DIR/hp-check.js" || { rm -f "$DIR/hp-check.js" "$DIR/handy-panel.js.neu"; die "Die geladene Datei ist fehlerhaft."; }
  rm -f "$DIR/hp-check.js"
  OPTS="--app $APP"; [ -n "${PORT:-}" ] && OPTS="$OPTS --port $PORT"
  # Läuft schon ein älteres Panel? Dann beenden, damit die neue Version startet (Server laufen weiter).
  if [ -f "$DIR/handy-panel.js" ]; then node "$DIR/handy-panel.js" $OPTS beenden >/dev/null 2>&1 || true; fi
  mv -f "$DIR/handy-panel.js.neu" "$DIR/handy-panel.js"
  ok "Gespeichert in $DIR/handy-panel.js"

  # ---------- Einrichten: Befehl „hp“, Autostart, starten, koppeln ----------
  step "Richte ein (Befehl „hp“, Autostart) und starte das Panel"
  [ -n "${FERN:-}" ] && OPTS="$OPTS --fernzugriff"
  node "$DIR/handy-panel.js" $OPTS einrichten

  # „hp“ auch in neuen Terminals finden (nur falls es in ~/.local/bin liegt und das nicht im PATH ist)
  if [ -z "$TERMUX" ] && [ -x "$HOME/.local/bin/hp" ]; then
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
      RC="$HOME/.profile"; [ "$OS" = Darwin ] && RC="$HOME/.zprofile"
      if ! grep -qs '.local/bin' "$RC"; then printf '\n# Toolbox Handy-Panel: Befehl „hp“\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC"; fi
      warn "Der Befehl „hp“ ist ab dem nächsten Terminal-Fenster da (jetzt: ~/.local/bin/hp)." ;;
    esac
  fi
  printf '\n\033[1;32m✓ Fertig!\033[0m Öffne den Link oben oder scanne den QR-Code mit der Toolbox-App.\n  Hilfe: hp hilfe  ·  Status: hp status  ·  Fernzugriff: hp fernzugriff an\n\n'
}

have() { command -v "$1" >/dev/null 2>&1; }
step() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m•\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
get() { if have curl; then curl -fL --retry 3 --progress-bar -o "$2" "$1"; elif have wget; then wget -q -O "$2" "$1"; else die "Weder curl noch wget gefunden."; fi; }
gets() { if have curl; then curl -fsSL --retry 3 "$1"; elif have wget; then wget -qO- "$1"; else die "Weder curl noch wget gefunden."; fi; }
nodeok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ] 2>/dev/null; }
javamajor() { if have java; then java -version 2>&1 | sed -n 's/.*version "\([0-9]*\)[.".].*/\1/p' | head -n 1 | grep . || echo 0; else echo 0; fi; }
checksum() {
  if have sha256sum; then S=$(sha256sum "$1"); elif have shasum; then S=$(shasum -a 256 "$1"); else return 0; fi
  [ "${S%% *}" = "$2" ]
}

# Ganze Datei erst einlesen, dann ausführen (sicher bei „curl … | sh“)
main "$@" </dev/null

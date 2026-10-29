#!/bin/zsh
# «Гайд в директ» — установщик для macOS. Запуск: двойной клик.
# Ничего не ставит в систему: Node.js (если его нет) скачивается с nodejs.org
# в папку .runtime рядом с этим файлом, зависимости — в node_modules.
set -u
cd "${0:A:h}" || exit 1
ROOT="$PWD"
RUNTIME="$ROOT/.runtime"
NODE_MAJOR=24

say() { print -- "\n▶ $1"; }
fail() {
  print -- "\n✗ $1"
  print -- "\nНажмите любую клавишу, чтобы закрыть окно."
  read -k1 -s
  exit 1
}

# Node 20+ уже есть — используем его; иначе берём свой из .runtime или скачиваем.
node_ok() { "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; }

if [[ -x "$RUNTIME/node/bin/node" ]]; then
  NODE_BIN="$RUNTIME/node/bin"
elif command -v node >/dev/null 2>&1 && node_ok node; then
  NODE_BIN="$(dirname "$(command -v node)")"
else
  say "Скачиваю Node.js с nodejs.org (только в папку программы, без пароля)…"
  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) fail "Неизвестный процессор: $(uname -m)" ;;
  esac
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  DL="$RUNTIME/dl"
  rm -rf "$DL" && mkdir -p "$DL"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$DL/SHASUMS256.txt" || fail "Не получилось связаться с nodejs.org. Проверьте интернет и запустите ещё раз."
  LINE="$(grep -E "node-v[0-9.]+-darwin-${ARCH}\.tar\.gz$" "$DL/SHASUMS256.txt" | head -1)"
  [[ -n "$LINE" ]] || fail "На nodejs.org не нашлась сборка для этого Mac."
  SUM="${LINE%% *}"
  FILE="${LINE##* }"
  curl -fSL --progress-bar "$BASE/$FILE" -o "$DL/$FILE" || fail "Не получилось скачать Node.js. Запустите ещё раз."
  GOT="$(shasum -a 256 "$DL/$FILE" | awk '{print $1}')"
  [[ "$GOT" == "$SUM" ]] || fail "Скачанный Node.js не прошёл проверку контрольной суммы. Запустите ещё раз."
  rm -rf "$RUNTIME/node" && mkdir -p "$RUNTIME/node"
  tar -xzf "$DL/$FILE" -C "$RUNTIME/node" --strip-components 1 || fail "Не получилось распаковать Node.js."
  rm -rf "$DL"
  NODE_BIN="$RUNTIME/node/bin"
fi
export PATH="$NODE_BIN:$PATH"
export WRANGLER_SEND_METRICS=false

# Зависимости ставим без чужих install-скриптов. Повторно — только если поменялся lock-файл.
STAMP="$RUNTIME/deps.stamp"
WANT="$(cat package-lock.json admin/package-lock.json | shasum -a 256 | awk '{print $1}')"
if [[ ! -d node_modules || ! -d admin/node_modules || "$(cat "$STAMP" 2>/dev/null)" != "$WANT" ]]; then
  say "Устанавливаю компоненты (первый раз — пара минут)…"
  npm ci --ignore-scripts --no-audit --no-fund --loglevel=error || fail "Не получилось установить компоненты."
  npm ci --ignore-scripts --no-audit --no-fund --loglevel=error --prefix admin || fail "Не получилось установить компоненты админки."
  mkdir -p "$RUNTIME" && print -- "$WANT" > "$STAMP"
fi

# Свободный порт и одноразовый ключ сессии для страницы мастера.
PORT=4546
while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
SESSION="$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"
URL="http://127.0.0.1:$PORT/?t=$SESSION"

say "Запускаю мастер установки…"
WIZARD_PORT=$PORT WIZARD_SESSION_TOKEN=$SESSION node installer/server.mjs &
SERVER=$!
for _ in {1..50}; do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/?t=$SESSION" && break
  sleep 0.2
done
[[ -n "${GVD_NO_OPEN:-}" ]] || open "$URL"   # GVD_NO_OPEN — только для автопроверки установщика
print -- "\nМастер открыт в браузере: $URL"
print -- "Не закрывайте это окно, пока не закончите установку. Закрыть — Ctrl+C или крестик."
wait $SERVER

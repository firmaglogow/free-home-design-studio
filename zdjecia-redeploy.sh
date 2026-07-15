#!/bin/bash
# ── Redeploy narzędzia zdjecia.freehome.pl — STRONA SERWERA (cPanel) ───────────
# Pobiera branch deploy-photo-crm, podmienia kod, npm install, restart, test.
# Env (APP_PASS / OPENAI_API_KEY) ustawione w panelu Node.js ZOSTAJĄ nietknięte.
set -eo pipefail   # bez -u: skrypt `activate` CloudLinuxa używa niezdefiniowanego CL_VIRTUAL_ENV
APP="/home/dm82980/zdjecia.freehome.pl"
REPO="https://github.com/firmaglogow/free-home-design-studio.git"
BRANCH="deploy-photo-crm"

# shellcheck disable=SC1091
source /home/dm82980/nodevenv/zdjecia.freehome.pl/22/bin/activate

cd "$APP"
rm -rf _u
git clone -q --depth 1 --branch "$BRANCH" "$REPO" _u
cp -af _u/server.mjs _u/crm-auth.mjs _u/package.json _u/package-lock.json "$APP"/
rm -rf "$APP/lib"; cp -af _u/lib "$APP/lib"
[ -f _u/.env.example ] && cp -af _u/.env.example "$APP"/
rm -rf "$APP/dist"; cp -af _u/dist "$APP/dist"
cp -af _u/zdjecia-redeploy.sh "$HOME/zdjecia-redeploy.sh" 2>/dev/null || true
rm -rf _u

npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true
node --check "$APP/server.mjs"
: > "$APP/stderr.log"
mkdir -p "$APP/tmp"; touch "$APP/tmp/restart.txt"
sleep 5
echo "STATUS=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 25 https://zdjecia.freehome.pl/) STDERR-linii=$(wc -l < "$APP/stderr.log")"
echo "✅ redeploy zrobiony"

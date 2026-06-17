#!/bin/zsh
cd "$(dirname "$0")"
PORT=4174
URL="http://127.0.0.1:${PORT}/index.html"
(sleep 1 && open "$URL") &
python3 -m http.server "$PORT" --bind 127.0.0.1

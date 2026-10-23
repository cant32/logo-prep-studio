#!/bin/sh
# Serves Logo Prep Studio to this computer only, at http://localhost:8790
cd "$(dirname "$0")"
(sleep 1; open "http://localhost:8790/") &
echo "Logo Prep Studio is running at http://localhost:8790/  (close this window to stop)"
exec python3 -m http.server 8790 --bind 127.0.0.1

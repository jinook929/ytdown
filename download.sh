#!/usr/bin/env bash
# The only file you customize. Called by server.js as:
#   ./download.sh "<URL>" "<mp3|mp4>" "<OUTDIR>"
# Must download into $OUTDIR, print progress to stdout, exit 0 on success.
set -euo pipefail

URL="$1"
FORMAT="$2"
OUTDIR="$3"
TEMPLATE="$OUTDIR/%(title)s.%(ext)s"

if [ "$FORMAT" = "mp3" ]; then
  yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality 64K \
         --no-mtime -o "$TEMPLATE" "$URL"
else
  yt-dlp -f "bestvideo[height<=1440][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1440]+bestaudio" \
         --merge-output-format mp4 --no-mtime -o "$TEMPLATE" "$URL"
fi

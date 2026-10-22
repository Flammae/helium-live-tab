#!/usr/bin/env bash
# Render the wallpaper loop(s), streaming raw yuv420p frames straight into VP9
# encoders (no temporary frame files). Geometry is traced once per sample and
# shaded for every requested variant.
#
# All settings are environment variables (defaults = the final light render):
#   SIZE=2560x1440 FPS=30 LOOP=20 DURATION=<LOOP> START=0 AA=4 DOF=1 CRF=16
#   CPU_USED=2 OUT=out VARIANTS=light        (VARIANTS="dark light" for both)
# DURATION < LOOP renders an excerpt; START shifts it (wraps modulo LOOP, so
# START=17.5 DURATION=5 crosses the loop seam at the 2.5 s mark).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SIZE="${SIZE:-2560x1440}"
FPS="${FPS:-30}"
LOOP="${LOOP:-20}"
DURATION="${DURATION:-$LOOP}"
START="${START:-0}"
AA="${AA:-4}"
DOF="${DOF:-1}"
CRF="${CRF:-16}"
CPU_USED="${CPU_USED:-2}"
OUT="${OUT:-out}"
VARIANTS="${VARIANTS:-light}"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (macOS: brew install ffmpeg)"; exit 1; }
ENCODERS="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
[[ "$ENCODERS" == *libvpx-vp9* ]] || { echo "ffmpeg lacks libvpx-vp9 (macOS: brew install ffmpeg)"; exit 1; }

FRAMES=$(awk "BEGIN { printf \"%d\", $DURATION * $FPS + 0.5 }")
"$HERE/build.sh"
BIN="$HERE/build/metamorphic"
mkdir -p "$OUT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ARGS=(--size "$SIZE" --fps "$FPS" --loop "$LOOP" --frames "$FRAMES" --time-offset "$START" --aa "$AA" --dof "$DOF" --yuv)
[[ " $VARIANTS " == *" dark "* ]] || ARGS+=(--only-light)
[[ " $VARIANTS " == *" light "* ]] || ARGS+=(--only-dark)

pids=()
for v in $VARIANTS; do
  mkfifo "$TMP/$v.yuv"
  ARGS+=(--out-$v "$TMP/$v.yuv")
  ffmpeg -hide_banner -loglevel error -y \
    -f rawvideo -pix_fmt yuv420p -s "$SIZE" -r "$FPS" -i "$TMP/$v.yuv" \
    -c:v libvpx-vp9 -crf "$CRF" -b:v 0 -deadline good -cpu-used "$CPU_USED" \
    -row-mt 1 -tile-columns 2 -frame-parallel 0 -auto-alt-ref 1 -lag-in-frames 25 \
    -g "$FRAMES" -pix_fmt yuv420p \
    -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
    -an "$OUT/$v.webm" &
  pids+=($!)
done

echo "rendering $FRAMES frames at $SIZE, ${FPS} fps, loop ${LOOP}s, start ${START}s, variants: $VARIANTS -> $OUT/"
"$BIN" "${ARGS[@]}"
for p in "${pids[@]}"; do wait "$p"; done
ls -l "$OUT"/*.webm

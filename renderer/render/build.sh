#!/usr/bin/env bash
# Build the renderer. Works with Apple clang on macOS (arm64 or x86_64) and with
# g++/clang++ on Linux. No OpenMP needed: parallelism uses std::thread.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CXX="${CXX:-c++}"

# Tune for this CPU when the compiler supports it (arm64 spells it -mcpu).
case "$(uname -m)" in
  arm64 | aarch64) WANT=-mcpu=native ;;
  *) WANT=-march=native ;;
esac
ARCH=""
if echo 'int main(){}' | "$CXX" $WANT -x c++ -o /dev/null - >/dev/null 2>&1; then
  ARCH=$WANT
fi

mkdir -p "$HERE/build"
"$CXX" -O3 $ARCH -ffast-math -std=c++17 -pthread -o "$HERE/build/metamorphic" "$HERE/metamorphic.cpp"
echo "built $HERE/build/metamorphic ($CXX $ARCH)"

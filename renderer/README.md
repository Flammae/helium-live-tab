# Metamorphic, procedurally

An offline, deterministic recreation of Opera's "Metamorphic" live wallpaper
(iridescent glass blobs). It renders `light.webm` (and `dark.webm`) as a
seamless loop, for use as a full-screen `<video loop muted>` new-tab background.

## Render on macOS (Apple Silicon)

You need Xcode Command Line Tools (Apple clang) and ffmpeg with libvpx-vp9.
Homebrew's ffmpeg includes libvpx-vp9.

```bash
xcode-select --install          # once, if clang is missing
brew install ffmpeg             # once

cd metamorphic                  # the unpacked source folder
./render/render.sh              # builds, then renders out/light.webm
```

The defaults produce the final light render: 2560x1440, 30 fps, one 20 s loop
(600 frames), VP9 crf 16, yuv420p, no audio. The renderer prints per-frame
time and an ETA.

Build only, or with another compiler:

```bash
./render/build.sh               # -> render/build/metamorphic (uses std::thread, no OpenMP)
CXX=clang++ ./render/build.sh
```

Linux works the same way. If `c++` isn't a working compiler, set `CXX=g++`.

## Settings

All settings are environment variables for `render/render.sh`:

| var        | default     | meaning                                           |
|------------|-------------|---------------------------------------------------|
| `SIZE`     | `2560x1440` | output resolution (even numbers)                  |
| `FPS`      | `30`        | frame rate                                        |
| `LOOP`     | `20`        | loop length in seconds (motion period)            |
| `DURATION` | `LOOP`      | seconds to render (`LOOP` = exactly one loop)     |
| `START`    | `0`         | start time; wraps modulo `LOOP`                   |
| `AA`       | `4`         | extra samples on edge/contrast pixels (`0` = off) |
| `DOF`      | `1`         | depth-of-field strength (`0` = off)               |
| `CRF`      | `16`        | libvpx-vp9 quality (lower = better/larger)        |
| `CPU_USED` | `2`         | libvpx speed (higher = faster encode)             |
| `VARIANTS` | `light`     | `light`, `dark`, or `"dark light"`                |
| `OUT`      | `out`       | output directory                                  |
| `CXX`      | `c++`       | compiler used by `build.sh`                       |

Examples:

```bash
# quick check: 960x540, 5 s crossing the loop seam at the 2.5 s mark
SIZE=960x540 DURATION=5 START=17.5 CRF=26 AA=3 OUT=preview ./render/render.sh

# 4K instead of 2K
SIZE=3840x2160 ./render/render.sh

# a single still (raw rgb24), e.g. t = 5 s
render/build/metamorphic --size 1920x1080 --time-offset 5 --only-light --out-light l.rgb
ffmpeg -f rawvideo -pix_fmt rgb24 -s 1920x1080 -i l.rgb l.png
```

`LOOP` can be any length. The motion uses whole cycles of it (2 and 4 cycles
for the morphing, 1 for drift), so 20 s matches the original's 10 s pace.
Changing `LOOP` changes the speed.

## How it works

`render/metamorphic.cpp` is a single-file CPU ray marcher (C++17, `std::thread`).

- **Geometry**: 14 glass blobs float in front of a backdrop plane. They follow
  the original's composition, spread in depth: near ones are large and overlap
  far ones, which are small and defocused. Each blob is a sphere with radial
  lumps and two sharp travelling creases, pushed through three layers of sine
  domain-warp. Two pairs of blobs merge with a smooth union.
- **Motion**: the original is a 10 s cycle. In the 20 s loop, the morph, fold
  and ripple terms run 2 or 4 cycles. One-cycle terms add wandering drift
  (about 0.4 blob radii), rocking and tumbling, and a swaying environment, so
  the loop doesn't look like a 10 s repeat. The motion metrics in
  `render/analyze_motion.py` match the original's.
- **Seamless loop**: every time-dependent term is `sin/cos(2π·n·t/LOOP)` with
  integer `n`, so `frame(t) == frame(t + LOOP)` exactly.
- **Shading**:
  - Fresnel reflection tinted by thin-film interference, plus warm key-light
    specular.
  - Refraction through the volume, a march to the back surface, then
    8-wavelength dispersion on exit. The exit rays see the backdrop and other
    blobs, which appear distorted through the glass.
  - One internal reflection, for bright streaks.
  - Beer-Lambert absorption that tints thick cores golden.
  - Ambient occlusion where blobs touch or fold.
  - Very soft key-light shadows on the backdrop and on blobs.
  - The light comes from analytic HDR studio environments: warm golden strips
    and glow, lavender shade bands, pastel patches.
- **Image quality**:
  - Adaptive supersampling on silhouettes and high-contrast pixels.
  - Depth of field.
  - TPDF dither applied after conversion to bt709 YUV, so it survives as real
    8-bit dither.
- **Speed**:
  - A polynomial sine in the distance field.
  - A grid cache for backdrop shadows.
  - Supersamples reuse the pixel's ambient occlusion and shadow, and skip the
    internal-reflection march.
  - Capped step counts inside the glass and in shadow rays.
  - Geometry is traced once and shaded per variant.

## Tools

- `render/analyze_motion.py clip.webm` prints motion-energy metrics:
  optical-flow speed, frame decorrelation and blob drift. It needs `numpy` and
  `opencv-python-headless`.

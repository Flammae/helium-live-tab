# Helium Live Tab

A local new tab page for Helium (Chromium) that plays Opera's Metamorphic live wallpaper (dark/light follows the system theme) behind glass panels with your bookmarks and recently closed tabs.

Install: chrome://extensions → Developer mode → Load unpacked → pick this folder.

## Wallpaper video

The video files are not stored in this repo. Put `light.webm` (and optionally `dark.webm`) in the extension folder before loading it. For now the page plays `light.webm` in both light and dark mode.

## Renderer

`renderer/` has the C++ renderer that made the recreated wallpaper. On a Mac, run `brew install ffmpeg` once, then `cd renderer && ./render/render.sh`. That writes `out/light.webm` at 2560x1440, 30 fps, as a 20-second loop. See `renderer/README.md` for the options.

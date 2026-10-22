#!/usr/bin/env python3
"""Motion-energy metrics for a clip, used to match the original's motion.

usage: analyze_motion.py clip.webm [seconds]

Prints (all distances as a fraction of frame width, so resolutions compare):
  flow    median/p90 optical-flow speed on blob pixels, per second
  decor   mean |frame(t) - frame(t+dt)| on blob pixels for several dt
  drift   centroid travel of the largest blobs over the clip
"""
import subprocess
import sys

import cv2
import numpy as np

W, H, FPS = 480, 270, 10


def frames(path, seconds):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-t", str(seconds), "-vf",
           f"fps={FPS},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W)


def blob_mask(f):
    # blobs differ from the smooth background; a large blur approximates the bg
    bg = cv2.GaussianBlur(f, (0, 0), 25)
    d = cv2.absdiff(f, bg)
    m = (cv2.GaussianBlur(d, (0, 0), 3) > 6).astype(np.uint8)
    return cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))


def main():
    path = sys.argv[1]
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 10
    fr = frames(path, seconds)
    speeds = []
    for a, b in zip(fr[:-1], fr[1:]):
        flow = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 4, 21, 5, 7, 1.5, 0)
        mag = np.linalg.norm(flow, axis=2) * FPS / W
        m = blob_mask(a) > 0
        if m.sum() > 100:
            speeds.append(mag[m])
    s = np.concatenate(speeds)
    print(f"flow   median {np.median(s):.4f}  p90 {np.percentile(s, 90):.4f}  (frame widths / s)")
    out = []
    for dt in (0.5, 1, 2, 4):
        k = int(dt * FPS)
        vals = []
        for i in range(0, len(fr) - k, 3):
            m = (blob_mask(fr[i]) | blob_mask(fr[i + k])) > 0
            vals.append(np.abs(fr[i].astype(float) - fr[i + k])[m].mean())
        out.append(f"{dt}s:{np.mean(vals):.1f}")
    print("decor  " + "  ".join(out))
    # centroid drift of the largest connected components (first vs last frame)
    def comps(f):
        n, lab, st, cen = cv2.connectedComponentsWithStats(blob_mask(f))
        idx = np.argsort(-st[1:, cv2.CC_STAT_AREA])[:5] + 1
        return cen[idx]
    c0, c1 = comps(fr[0]), comps(fr[-1])
    d = [np.min(np.linalg.norm(c1 - c, axis=1)) / W for c in c0]
    print("drift  " + " ".join(f"{x:.3f}" for x in d) + f"  over {len(fr) / FPS:.0f}s")


if __name__ == "__main__":
    main()

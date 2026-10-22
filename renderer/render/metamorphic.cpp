// Procedural recreation of the "Metamorphic" live wallpaper.
//
// A scene of thick glass blobs floating in front of a backdrop plane. Each blob
// is a sphere with radial lumps and sharp travelling creases, pushed through a
// sine domain warp; some blobs merge with a smooth union. Every time-dependent
// term is a sine/cosine of 2*pi*n*t/T with integer n, so frame(t) equals
// frame(t + T) exactly and the loop is seamless.
//
// Per sample: primary march -> Fresnel reflection (thin-film tinted) + key-light
// specular -> refraction into the volume -> back surface -> spectral exit rays
// that see the (shadowed) backdrop or other blobs -> one internal reflection.
// Beer-Lambert absorption, ambient occlusion, soft shadows from a key light
// onto blobs and backdrop, depth of field, dithered 8-bit output.
//
// Geometry is traced once per sample and shaded for both variants (dark/light).

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <atomic>
#include <chrono>
#include <vector>

// Dynamic parallel-for over [0, n) on all hardware threads (portable: no
// OpenMP, so it builds with stock Apple clang).
template <class F>
static void parallelFor(int n, F &&f) {
  static const int nt = std::max(1u, std::thread::hardware_concurrency());
  std::atomic<int> next{0};
  auto work = [&]() {
    for (int i; (i = next.fetch_add(1, std::memory_order_relaxed)) < n;) f(i);
  };
  std::vector<std::thread> pool;
  for (int t = 1; t < nt; t++) pool.emplace_back(work);
  work();
  for (auto &th : pool) th.join();
}

static constexpr float PI = 3.14159265358979f;
static constexpr float TAU = 6.28318530717959f;

struct v3 {
  float x, y, z;
  v3() : x(0), y(0), z(0) {}
  v3(float a) : x(a), y(a), z(a) {}
  v3(float a, float b, float c) : x(a), y(b), z(c) {}
};
static inline v3 operator+(v3 a, v3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
static inline v3 operator-(v3 a, v3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
static inline v3 operator-(v3 a) { return {-a.x, -a.y, -a.z}; }
static inline v3 operator*(v3 a, v3 b) { return {a.x * b.x, a.y * b.y, a.z * b.z}; }
static inline v3 operator*(v3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
static inline v3 operator/(v3 a, float s) { return a * (1.0f / s); }
static inline v3 &operator+=(v3 &a, v3 b) { a = a + b; return a; }
static inline float dot(v3 a, v3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static inline v3 cross(v3 a, v3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
static inline float length(v3 a) { return std::sqrt(dot(a, a)); }
static inline v3 normalize(v3 a) { return a / length(a); }
// Polynomial sine (abs error < 4e-6), used in the distance field hot path.
static inline float fsin(float x) {
  x -= TAU * std::floor(x * (1.0f / TAU) + 0.5f);
  float ax = std::fabs(x);
  if (ax > 1.5707963f) x = std::copysign(3.14159265f - ax, x);
  float x2 = x * x;
  return x * (1 + x2 * (-1.0f / 6 + x2 * (1.0f / 120 + x2 * (-1.0f / 5040 + x2 * (1.0f / 362880)))));
}
static inline v3 vsin(v3 a) { return {fsin(a.x), fsin(a.y), fsin(a.z)}; }
static inline v3 vexp(v3 a) { return {std::exp(a.x), std::exp(a.y), std::exp(a.z)}; }
static inline v3 vmax(v3 a, float m) { return {std::max(a.x, m), std::max(a.y, m), std::max(a.z, m)}; }
static inline v3 mix(v3 a, v3 b, float t) { return a + (b - a) * t; }
static inline float mixf(float a, float b, float t) { return a + (b - a) * t; }
static inline float clamp01(float x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
static inline float smoothstep(float a, float b, float x) {
  float t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
static inline v3 reflect(v3 i, v3 n) { return i - n * (2 * dot(n, i)); }
// eta = n_from / n_to. Returns false on total internal reflection.
static inline bool refract(v3 i, v3 n, float eta, v3 &out) {
  float c = dot(n, i);
  float k = 1 - eta * eta * (1 - c * c);
  if (k < 0) return false;
  out = i * eta - n * (eta * c + std::sqrt(k));
  return true;
}
static inline float schlick(float cosx, float f0) {
  float m = clamp01(1 - cosx);
  float m2 = m * m;
  return f0 + (1 - f0) * m2 * m2 * m;
}
static inline float smin(float a, float b, float k) {
  float h = std::max(k - std::fabs(a - b), 0.0f) / k;
  return std::min(a, b) - h * h * k * 0.25f;
}
static inline float sabs(float x) { return std::sqrt(x * x + 0.015f); }

struct m3 {
  v3 r0, r1, r2;
  v3 mul(v3 v) const { return {dot(r0, v), dot(r1, v), dot(r2, v)}; }
};
static m3 rotAxis(v3 a, float ang) {
  a = normalize(a);
  float c = std::cos(ang), s = std::sin(ang), t = 1 - c;
  return {{t * a.x * a.x + c, t * a.x * a.y - s * a.z, t * a.x * a.z + s * a.y},
          {t * a.x * a.y + s * a.z, t * a.y * a.y + c, t * a.y * a.z - s * a.x},
          {t * a.x * a.z - s * a.y, t * a.y * a.z + s * a.x, t * a.z * a.z + c}};
}
static m3 mmul(const m3 &A, const m3 &B) {
  v3 c0{B.r0.x, B.r1.x, B.r2.x}, c1{B.r0.y, B.r1.y, B.r2.y}, c2{B.r0.z, B.r1.z, B.r2.z};
  return {{dot(A.r0, c0), dot(A.r0, c1), dot(A.r0, c2)},
          {dot(A.r1, c0), dot(A.r1, c1), dot(A.r1, c2)},
          {dot(A.r2, c0), dot(A.r2, c1), dot(A.r2, c2)}};
}

static float hash1(int n) {
  uint32_t x = (uint32_t)n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return (x & 0xffffff) / float(0x1000000);
}
static v3 hashDir(int n) {
  float u = hash1(n * 3 + 1) * 2 - 1, a = hash1(n * 3 + 2) * TAU;
  float s = std::sqrt(1 - u * u);
  return {s * std::cos(a), s * std::sin(a), u};
}

// ---------------------------------------------------------------- settings

struct Settings {
  int W = 960, H = 540;
  float fps = 30;
  float loop = 20;        // seconds; all motion is periodic in this
  int frameStart = 0, frameCount = 1;
  float timeOffset = 0;   // seconds added to t (wraps modulo loop)
  int aa = 4;             // extra samples for edge/contrast pixels (0 = off)
  float dof = 1;          // depth-of-field strength (0 = off)
  bool yuv = false;       // write yuv420p instead of rgb24
  bool dark = true, light = true;
  std::string outDark = "dark.rgb", outLight = "light.rgb";
  bool perFrame = false;  // write one file per frame (outX is a printf pattern)
};

// ---------------------------------------------------------------- scene

static constexpr float FOV_Y = 40.0f * PI / 180.0f;
static constexpr float ZB = 14.0f;  // backdrop plane at z = -ZB
static constexpr int NLAYER = 4;    // layer 0 = radial lumps, 1.. = domain warp
static constexpr int NGROUP = 2;
static constexpr float MERGE_K = 0.45f;
static const v3 KEY_L = normalize(v3(-0.16f, 0.24f, 1.0f));  // toward the key light

struct BlobDef {
  float sx, sy;   // screen position in a 960x540 reference frame
  float rpx;      // screen radius in px (540 tall)
  float depth;    // distance along the view ray
  v3 aniso;       // per-axis scale
  float crumple;  // frequency multiplier (small blobs crumple more)
  float warp;     // deformation amplitude multiplier
  float fold;     // crease strength
  int group;      // smooth-union group (-1 = none)
  int seed;
};

// Composition follows the original's frame 0 (same blobs, same places, same
// scale) with a clear spread in depth: near ones overlap far ones, two pairs
// merge, and a few small far blobs are defocused.
static const BlobDef kBlobs[] = {
    {105, 172, 122, 5.4f, {1.00f, 1.05f, 0.95f}, 1.00f, 1.00f, 1.0f, -1, 1},   // large left
    {255, 396, 95, 6.6f, {1.00f, 0.97f, 1.00f}, 0.95f, 0.95f, 0.8f, -1, 6},    // bottom-left medium
    {57, 385, 32, 9.5f, {1.00f, 1.00f, 1.00f}, 1.80f, 1.20f, 0.3f, -1, 10},    // left small crumpled
    {372, 140, 52, 6.6f, {1.10f, 0.90f, 1.00f}, 1.15f, 1.00f, 0.6f, 0, 2},     // top-centre small (merges)
    {510, 212, 104, 7.4f, {1.45f, 0.82f, 1.05f}, 0.95f, 1.00f, 0.9f, 0, 3},    // centre flattened (merges)
    {495, 360, 41, 6.2f, {0.85f, 1.12f, 0.95f}, 1.30f, 1.00f, 0.5f, -1, 7},    // centre small oval
    {822, 116, 158, 4.6f, {1.00f, 0.98f, 1.00f}, 1.00f, 1.05f, 1.2f, -1, 15},   // huge top-right, nearest
    {598, 98, 21, 10.5f, {1.00f, 1.00f, 1.00f}, 1.80f, 1.25f, 0.3f, -1, 5},    // tiny crumpled, behind
    {718, 420, 68, 7.0f, {1.05f, 0.95f, 1.00f}, 1.50f, 1.20f, 0.5f, -1, 8},    // bottom-right crumpled
    {880, 345, 34, 9.0f, {1.10f, 0.85f, 1.00f}, 1.75f, 1.25f, 0.3f, 1, 9},     // right small (merges)
    {922, 425, 22, 9.6f, {1.00f, 1.00f, 1.00f}, 1.75f, 1.25f, 0.3f, 1, 13},    // right small twin
    {388, 478, 30, 11.5f, {1.00f, 1.00f, 1.00f}, 1.40f, 1.10f, 0.4f, -1, 14},  // far, defocused
    {300, 70, 10, 12.0f, {1.00f, 1.00f, 1.00f}, 1.20f, 0.70f, 0.0f, -1, 11},   // droplets
    {680, 285, 8, 12.0f, {1.00f, 1.00f, 1.00f}, 1.20f, 0.70f, 0.0f, -1, 12},
};
static constexpr int NBLOB = sizeof(kBlobs) / sizeof(kBlobs[0]);

struct Blob {
  v3 c;
  m3 toLocal;     // rotation * inverse scale
  float scaleMin; // world units per local unit
  float boundR;
  float stepK;    // lipschitz correction
  m3 lm[NLAYER];
  v3 lph[NLAYER];
  float lamp[NLAYER];
  v3 kf[2];       // crease directions * frequency
  float fph[2], fold;
  int group;
  float filmPh;
};

struct Scene {
  Blob b[NBLOB];
  float tanHalf, aspect;
  m3 envRot;

  void build(float t, float loop, int W, int H) {
    tanHalf = std::tan(FOV_Y * 0.5f);
    aspect = float(W) / H;
    const float w = TAU * t / loop;  // one cycle per loop
    // The original is a 10 s cycle; n = 2 per 20 s loop reproduces its pace,
    // the slower n = 1 terms keep the 20 s loop from looking like a 10 s one.
    static const float layerFreq[NLAYER] = {1.4f, 2.6f, 4.3f, 7.0f};
    static const float layerAmp[NLAYER] = {0.26f, 0.13f, 0.08f, 0.035f};
    static const int layerSpeed[NLAYER] = {2, 2, 4, 4};
    envRot = rotAxis(v3(0.25f, 1.0f, 0.15f), 0.8f * std::sin(w) + 0.3f * std::sin(2 * w));
    for (int i = 0; i < NBLOB; i++) {
      const BlobDef &d = kBlobs[i];
      int s = d.seed * 97;
      float u = d.sx / 960.0f, v = d.sy / 540.0f;
      v3 dir{(2 * u - 1) * tanHalf * (16.0f / 9.0f), (1 - 2 * v) * tanHalf, -1};
      v3 c0 = dir * d.depth;
      float r = 0.95f * d.rpx / 270.0f * tanHalf * d.depth;
      Blob &B = b[i];
      float ph1 = hash1(s + 1) * TAU, ph2 = hash1(s + 2) * TAU, ph3 = hash1(s + 3) * TAU;
      // wandering: a 20 s orbit plus a 10 s figure-eight, about 0.4 radii
      v3 drift{std::sin(w + ph1) + 0.45f * std::sin(2 * w + ph3), 0.8f * std::sin(w + ph2) + 0.4f * std::sin(2 * w + ph1),
               0.7f * std::sin(w + ph3)};
      B.c = c0 + drift * (0.36f * r + 0.10f);
      // small blobs tumble a full turn per loop; big ones rock back and forth
      int turns = d.rpx < 45 ? (hash1(s + 4) < 0.5f ? 1 : -1) : 0;
      float a1 = 0.8f * std::sin(w + hash1(s + 5) * TAU) + TAU * turns * t / loop;
      float a2 = 0.35f * std::sin(2 * w + hash1(s + 6) * TAU);
      m3 R = mmul(rotAxis(hashDir(s + 7), a2), rotAxis(hashDir(s + 8), a1));
      v3 sc = d.aniso * r;
      B.toLocal = {R.r0 / sc.x, R.r1 / sc.y, R.r2 / sc.z};
      B.scaleMin = std::min(sc.x, std::min(sc.y, sc.z));
      B.group = d.group;
      float lipWarp = 1, warpSum = 0, lipRad = 0, radSum = 0;
      for (int k = 0; k < NLAYER; k++) {
        float f = layerFreq[k] * d.crumple;
        float a = layerAmp[k] * d.warp / d.crumple;
        // independent (non-orthogonal) directions: orthogonal sine axes give
        // the blob a cube-like symmetry
        B.lm[k] = {hashDir(s + 200 + 3 * k) * f, hashDir(s + 201 + 3 * k) * f, hashDir(s + 202 + 3 * k) * f};
        int n = layerSpeed[k];
        v3 sgn{hash1(s + 40 + k) < 0.5f ? -1.f : 1.f, hash1(s + 50 + k) < 0.5f ? -1.f : 1.f,
               hash1(s + 60 + k) < 0.5f ? -1.f : 1.f};
        v3 base{hash1(s + 70 + k) * TAU, hash1(s + 80 + k) * TAU, hash1(s + 90 + k) * TAU};
        B.lph[k] = base + sgn * (w * n);
        B.lamp[k] = a;
        if (k == 0) {
          lipRad += a * f * 0.9f;
          radSum += a * 1.5f;
        } else {
          lipWarp *= 1 + a * f * 1.2f;
          warpSum += a;
        }
      }
      // travelling creases: sharp V-grooves sliding across the surface
      float ff = 2.3f * d.crumple;
      B.fold = 0.065f * d.fold / d.crumple;
      for (int k = 0; k < 2; k++) {
        B.kf[k] = hashDir(s + 300 + k) * (ff * (k ? 1.3f : 1.0f));
        B.fph[k] = hash1(s + 310 + k) * TAU + (k ? -2 : 2) * w;
      }
      lipRad += B.fold * ff * 2.5f;
      radSum += B.fold * 1.6f;
      B.stepK = 0.9f / (lipWarp + lipRad);
      B.boundR = std::max(sc.x, std::max(sc.y, sc.z)) * (1 + radSum + warpSum * 1.75f) + 0.02f;
      B.filmPh = 2 * w;
    }
  }

  inline float sdfBlob(int i, v3 p) const {
    const Blob &B = b[i];
    v3 q = B.toLocal.mul(p - B.c);
    float rad = B.lamp[0] * dot(vsin(B.lm[0].mul(q) + B.lph[0]), v3(0.6f, 0.5f, 0.4f));
    rad -= B.fold * (sabs(fsin(dot(B.kf[0], q) + B.fph[0])) + 0.6f * sabs(fsin(dot(B.kf[1], q) + B.fph[1])) - 1.0f);
    for (int k = 1; k < NLAYER; k++) q += vsin(B.lm[k].mul(q) + B.lph[k]) * B.lamp[k];
    return (length(q) - 1.0f - rad) * B.scaleMin * B.stepK;
  }

  // Scene distance (lipschitz-scaled). Blobs whose bounding sphere is farther
  // than the current best are represented by the sphere distance.
  inline float map(v3 p, int &id) const {
    float best = 1e9f;
    id = -1;
    float gd[NGROUP] = {1e9f, 1e9f}, graw[NGROUP] = {1e9f, 1e9f};
    int gid[NGROUP] = {-1, -1};
    for (int i = 0; i < NBLOB; i++) {
      const Blob &B = b[i];
      float dc = length(p - B.c) - B.boundR;
      float d = (dc > std::min(best, gd[0] < gd[1] ? gd[0] : gd[1]) + MERGE_K) ? dc : sdfBlob(i, p);
      if (B.group < 0) {
        if (d < best) { best = d; id = i; }
      } else {
        int g = B.group;
        gd[g] = gd[g] > 1e8f ? d : smin(gd[g], d, MERGE_K * B.stepK);
        if (d < graw[g]) { graw[g] = d; gid[g] = i; }
      }
    }
    for (int g = 0; g < NGROUP; g++)
      if (gd[g] < best) { best = gd[g]; id = gid[g]; }
    return best;
  }
  inline float map(v3 p) const { int id; return map(p, id); }

  inline v3 normal(v3 p, float e) const {
    const v3 k0{1, -1, -1}, k1{-1, -1, 1}, k2{-1, 1, -1}, k3{1, 1, 1};
    v3 n = k0 * map(p + k0 * e) + k1 * map(p + k1 * e) + k2 * map(p + k2 * e) + k3 * map(p + k3 * e);
    return normalize(n);
  }
  inline float film(int i, v3 p) const {
    const Blob &B = b[i];
    v3 q = B.toLocal.mul(p - B.c);
    return 0.5f + 0.25f * std::sin(2.1f * q.x + 1.3f * q.y + B.filmPh) +
           0.25f * std::sin(1.7f * q.z - 2.3f * q.y - B.filmPh + i);
  }
  bool anyBound(v3 ro, v3 rd, float tmax) const {
    for (int i = 0; i < NBLOB; i++) {
      v3 oc = ro - b[i].c;
      float bq = dot(oc, rd), cq = dot(oc, oc) - b[i].boundR * b[i].boundR;
      float disc = bq * bq - cq;
      if (disc > 0 && -bq + std::sqrt(disc) > 0 && -bq - std::sqrt(disc) < tmax) return true;
    }
    return false;
  }
  float firstBound(v3 ro, v3 rd) const {
    float t = 1e30f;
    for (int i = 0; i < NBLOB; i++) {
      v3 oc = ro - b[i].c;
      float bq = dot(oc, rd), cq = dot(oc, oc) - b[i].boundR * b[i].boundR;
      float disc = bq * bq - cq;
      if (disc <= 0) continue;
      float sq = std::sqrt(disc);
      if (-bq + sq > 0) t = std::min(t, std::max(0.0f, -bq - sq));
    }
    return t;
  }
  // Glass casts soft, partial shadows (penumbra factor k).
  float softShadow(v3 ro, v3 rd, float tmin, float tmax, float k) const {
    if (!anyBound(ro, rd, tmax)) return 1;
    float res = 1, t = tmin;
    for (int it = 0; it < 48 && t < tmax; it++) {
      int id;
      float h = map(ro + rd * t, id);
      if (id >= 0) h /= b[id].stepK;
      res = std::min(res, k * h / t);
      if (res < 0.002f) break;
      t += std::clamp(h, 0.04f, 0.8f);
    }
    return clamp01(res);
  }
  float ao(v3 p, v3 n, float s) const {
    float occ = 0, sca = 1;
    for (int i = 1; i <= 5; i++) {
      float h = s * (0.06f + 0.12f * i);
      int id;
      float d = map(p + n * h, id);
      if (id >= 0) d /= b[id].stepK;
      occ += (h - d) / s * sca;
      sca *= 0.75f;
    }
    return clamp01(1 - 0.9f * occ);
  }
};

// Soft shadow of the blobs on the backdrop, cached per frame on a grid (the
// penumbrae are wide, so a coarse grid with bilinear lookup is exact enough).
struct ShadowMap {
  static constexpr int SW = 384, SH = 216;
  static constexpr float U0 = -0.3f, U1 = 1.3f;
  std::vector<float> v;
  float hx, hy;  // plane half extents at u,v in [0,1]
  void build(const Scene &S) {
    v.assign(SW * SH, 1);
    hx = ZB * S.tanHalf * S.aspect;
    hy = ZB * S.tanHalf;
    parallelFor(SH, [&](int y) {
      for (int x = 0; x < SW; x++) {
        float u = U0 + (U1 - U0) * (x + 0.5f) / SW, vv = U0 + (U1 - U0) * (y + 0.5f) / SH;
        v3 X{(2 * u - 1) * hx, (1 - 2 * vv) * hy, -ZB};
        v[y * SW + x] = S.softShadow(X, KEY_L, 0.05f, 30.0f, 1.1f);
      }
    });
  }
  float at(float u, float vv) const {
    float fx = (u - U0) / (U1 - U0) * SW - 0.5f, fy = (vv - U0) / (U1 - U0) * SH - 0.5f;
    fx = std::clamp(fx, 0.0f, SW - 1.001f);
    fy = std::clamp(fy, 0.0f, SH - 1.001f);
    int x0 = int(fx), y0 = int(fy);
    float tx = fx - x0, ty = fy - y0;
    const float *r0 = &v[y0 * SW + x0], *r1 = r0 + SW;
    return mixf(mixf(r0[0], r0[1], tx), mixf(r1[0], r1[1], tx), ty);
  }
};

// ---------------------------------------------------------------- environments

static inline float strip(v3 d, v3 c, v3 axis, float width, float len, float soft) {
  float cz = dot(d, c);
  if (cz <= 0.05f) return 0;
  v3 w = cross(axis, c);
  float a = dot(d, axis) / cz, b = dot(d, w) / cz;
  float across = std::exp(-(b * b) / (width * width));
  float along = 1 - smoothstep(len - soft, len + soft, std::fabs(a));
  return across * along;
}
static inline float lobe(v3 d, v3 c, float power) {
  float x = std::max(0.0f, dot(d, c));
  return std::pow(x, power);
}

static const v3 E_S1 = normalize(v3(0.15f, 0.75f, 0.65f)), E_S1a = normalize(v3(1, 0, -0.2f));
static const v3 E_S2 = normalize(v3(0.95f, 0.15f, -0.25f)), E_S2a = normalize(v3(0.2f, 1, 0.3f));
static const v3 E_S3 = normalize(v3(-0.25f, 0.35f, -1.0f)), E_S3a = normalize(v3(1, 0.35f, 0));
static const v3 E_S4 = normalize(v3(0.3f, -0.55f, -0.8f)), E_S4a = normalize(v3(1, 0, 0.3f));
static const v3 E_S5 = normalize(v3(-1.0f, 0.1f, 0.25f)), E_S5a = normalize(v3(0.1f, 1, 0));
static const v3 E_S6 = normalize(v3(0.45f, 0.5f, -0.75f)), E_S6a = normalize(v3(-0.6f, 1, 0.1f));
static const v3 E_P1 = normalize(v3(-0.3f, 0.6f, -0.7f)), E_P2 = normalize(v3(0.7f, -0.3f, -0.6f));
static const v3 E_P3 = normalize(v3(0.0f, -0.2f, 1.0f));

// Large soft swirl bands in direction space.
static inline float bands(v3 d) {
  float a = std::sin(3.1f * d.x + 2.3f * d.y - 1.7f * d.z + 1.4f * std::sin(2.2f * d.y + 1.1f * d.z));
  float b = std::sin(2.6f * d.y - 3.4f * d.z + 1.9f * d.x + 1.2f * std::sin(2.7f * d.x - 0.6f));
  return clamp01(0.5f + 0.35f * a + 0.35f * b);
}
// Thin wavy lines in direction space; through rippled glass they become the
// curvy streaks of the original.
static inline float ridges(v3 d, float sharp) {
  float a = std::sin(5.0f * d.y + 2.0f * d.x + 1.6f * std::sin(3.0f * d.x - 2.0f * d.z));
  float b = std::sin(4.2f * d.x - 3.1f * d.z + 1.3f * std::sin(3.6f * d.y + 0.7f));
  return std::exp(-sharp * a * a) + 0.7f * std::exp(-sharp * b * b);
}

static v3 envDark(v3 d) {
  float bd = bands(d);
  float bd2 = bd * bd;
  float rg = ridges(d, 26.0f);
  v3 c = v3(0.004f, 0.002f, 0.012f);
  c += v3(0.55f, 0.22f, 1.00f) * (2.0f * rg * bd2 * bd);
  c = c * (0.35f + 0.65f * smoothstep(-0.2f, 0.6f, -d.z * 0.7f + d.y * 0.5f + 0.3f));
  c += v3(0.26f, 0.04f, 0.95f) * (0.70f * lobe(d, E_P1, 2.0f) * bd2 * bd);
  c += v3(0.80f, 0.05f, 0.62f) * (0.50f * lobe(d, E_P2, 2.5f) * bd2);
  c += v3(0.20f, 0.08f, 0.70f) * (0.18f * lobe(d, E_P3, 1.5f) * bd2);
  c += v3(1.00f, 0.97f, 1.00f) * (10.0f * strip(d, E_S1, E_S1a, 0.035f, 1.6f, 0.5f));
  c += v3(0.85f, 0.90f, 1.00f) * (7.0f * strip(d, E_S2, E_S2a, 0.05f, 1.2f, 0.4f));
  c += v3(1.00f, 1.00f, 1.00f) * (9.0f * strip(d, E_S3, E_S3a, 0.03f, 1.4f, 0.5f));
  c += v3(1.00f, 0.30f, 0.85f) * (3.0f * strip(d, E_S4, E_S4a, 0.07f, 1.0f, 0.4f));
  c += v3(0.55f, 0.95f, 1.00f) * (6.0f * strip(d, E_S5, E_S5a, 0.04f, 1.3f, 0.4f));
  c += v3(1.00f, 0.40f, 0.10f) * (2.5f * strip(d, E_S6, E_S6a, 0.05f, 0.6f, 0.3f));
  return c;
}

// Warm studio: cream-white key area with golden strip lights, lavender
// shade bands, and pastel tint patches (teal / pink / butter) that the glass
// picks up.
static v3 envLight(v3 d) {
  float up = 0.5f + 0.5f * d.y;
  float bd = bands(d);
  v3 c = mix(v3(0.56f, 0.50f, 0.58f), v3(1.14f, 1.07f, 1.00f), up);
  c = c * (0.58f + 0.58f * bd);
  float rg = ridges(d, 12.0f);
  c = c * (1.0f - 0.30f * std::min(rg, 1.2f));
  c += v3(0.62f, 0.52f, 0.36f) * ridges(-d, 28.0f);
  float hue = bands(v3(d.z, d.x, -d.y));
  float patch = smoothstep(0.45f, 0.85f, bands(v3(-d.y, d.z, d.x)));
  v3 pastel{0.5f + 0.5f * std::cos(TAU * hue), 0.5f + 0.5f * std::cos(TAU * (hue - 0.33f)),
            0.5f + 0.5f * std::cos(TAU * (hue - 0.67f))};
  c = c * mix(v3(1), v3(0.74f, 0.72f, 0.68f) + pastel * 0.42f, 0.55f * patch);
  c += v3(0.75f, 0.52f, 0.18f) * (lobe(d, E_P1, 2.0f) * (0.4f + 0.6f * bd));  // golden glow
  c += v3(0.40f, 0.30f, 0.12f) * lobe(d, E_P3, 3.0f);                        // warm front fill
  c = c * (v3(1) - v3(0.20f, 0.22f, 0.14f) * lobe(d, E_P2, 2.0f));          // lavender shade
  c += v3(1.0f, 0.86f, 0.58f) * (2.2f * strip(d, E_S1, E_S1a, 0.05f, 1.6f, 0.6f));
  c += v3(1.0f, 0.95f, 0.85f) * (1.5f * strip(d, E_S2, E_S2a, 0.07f, 1.2f, 0.5f));
  c += v3(1.0f, 0.90f, 0.70f) * (1.8f * strip(d, E_S3, E_S3a, 0.04f, 1.4f, 0.6f));
  c += v3(0.95f, 0.88f, 1.0f) * (0.9f * strip(d, E_S5, E_S5a, 0.05f, 1.3f, 0.5f));
  c = c * (v3(1) - v3(0.22f, 0.23f, 0.17f) * strip(d, E_S4, E_S4a, 0.18f, 1.2f, 0.6f));
  return vmax(c, 0.0f);
}

static inline float srgbToLin(float c) {
  return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}
static inline float linToSrgb(float c) {
  c = clamp01(c);
  return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1 / 2.4f) - 0.055f;
}

// Backdrop colours (display-linear) by screen position; u,v in [0,1], v down.
static v3 bgDark(float u, float v) {
  float vig = std::exp(-((u - 0.55f) * (u - 0.55f) * 2.2f + (v - 0.4f) * (v - 0.4f) * 3.0f));
  return v3(srgbToLin(3.0f / 255), srgbToLin(2.0f / 255), srgbToLin(9.0f / 255)) * (0.5f + 0.6f * vig);
}
static v3 bgLight(float u, float v) {
  auto g = [&](float cx, float cy, float rx, float ry) {
    float dx = (u - cx) / rx, dy = (v - cy) / ry;
    return std::exp(-(dx * dx + dy * dy));
  };
  v3 base = mix(v3(234, 233, 242), v3(229, 222, 236), clamp01(v));  // sRGB 0..255
  base = mix(base, v3(244, 240, 246), 0.9f * g(0.40f, 0.48f, 0.35f, 0.40f));
  base = mix(base, v3(243, 222, 228), 0.85f * g(0.0f, 1.0f, 0.35f, 0.45f));
  base = mix(base, v3(224, 220, 238), 0.6f * g(1.0f, 0.95f, 0.35f, 0.4f));
  base = mix(base, v3(226, 222, 228), 0.5f * g(1.0f, 0.0f, 0.3f, 0.3f));
  base = mix(base, v3(236, 232, 244), 0.5f * g(0.75f, 0.6f, 0.2f, 0.25f));
  return {srgbToLin(base.x / 255), srgbToLin(base.y / 255), srgbToLin(base.z / 255)};
}

// ---------------------------------------------------------------- spectral

static constexpr int NSPEC = 8;
struct Spectral {
  v3 w[NSPEC];
  float ior[NSPEC];
  Spectral() {
    v3 sum{0};
    for (int j = 0; j < NSPEC; j++) {
      float h = (j + 0.5f) / NSPEC;  // 0 = red ... 1 = violet
      auto g = [](float x, float c, float s) { return std::exp(-((x - c) / s) * ((x - c) / s)); };
      w[j] = v3(g(h, 0.08f, 0.22f) + 0.35f * g(h, 1.0f, 0.12f), g(h, 0.48f, 0.20f), g(h, 0.86f, 0.20f));
      sum += w[j];
      ior[j] = 1.37f + 0.24f * h;
    }
    for (int j = 0; j < NSPEC; j++) w[j] = v3(w[j].x / sum.x, w[j].y / sum.y, w[j].z / sum.z);
  }
};
static const Spectral SPEC;
static constexpr float IOR = 1.47f;

static inline v3 thinFilm(float cosT, float thick) {
  float dnm = 250 + 500 * thick;
  float opd = 2 * 1.33f * dnm * cosT;
  v3 c;
  c.x = 0.5f + 0.5f * std::cos(TAU * opd / 640.0f);
  c.y = 0.5f + 0.5f * std::cos(TAU * opd / 540.0f);
  c.z = 0.5f + 0.5f * std::cos(TAU * opd / 450.0f);
  return c * 2.0f;
}

// ---------------------------------------------------------------- variants

static inline float tonemap(float x, float expo) { return 1 - std::exp(-x * expo); }
static inline float untonemap(float y, float expo) { return -std::log(1 - std::min(y, 0.995f)) / expo; }

struct Variant {
  v3 (*env)(v3);
  v3 (*bg)(float, float);
  float expo;        // radiance -> display tonemap exposure
  v3 sigma;          // Beer-Lambert absorption per unit (relative) thickness
  float envMix;      // refracted light: environment vs backdrop share
  float filmMix;     // thin-film strength on reflections
  float reflK;       // reflection gain
  float specK;       // key-light specular gain
  float internalK;   // internal-reflection gain
  v3 shadowTint;     // backdrop colour multiplier in full shadow
  float shadowK;     // how much glass blocks the key light
  v3 specTint;       // key-light colour
};

static const Variant V_DARK{envDark, bgDark, 1.15f, {0.55f, 1.10f, 0.18f}, 0.85f, 0.85f, 0.9f, 2.0f, 1.0f,
                            {0.35f, 0.33f, 0.45f}, 0.6f, {1, 1, 1}};
static const Variant V_LIGHT{envLight, bgLight, 1.75f, {0.05f, 0.10f, 0.22f}, 0.45f, 0.85f, 1.1f, 0.9f, 1.1f,
                             {0.90f, 0.87f, 0.90f}, 0.16f, {1.0f, 0.90f, 0.70f}};

// ---------------------------------------------------------------- tracing

struct Tracer {
  const Scene &S;
  const ShadowMap &SM;
  float pixAngle;

  inline void planeUV(v3 X, float &u, float &v) const {
    u = 0.5f + 0.5f * X.x / SM.hx;
    v = 0.5f - 0.5f * X.y / SM.hy;
  }
  // Radiance of the backdrop seen along (ro, rd); false if it is not hit.
  inline bool backdrop(const Variant &V, v3 ro, v3 rd, v3 &rad) const {
    if (rd.z >= -1e-3f) return false;
    float t = (ro.z + ZB) / -rd.z;
    v3 X = ro + rd * t;
    float u, v;
    planeUV(X, u, v);
    v3 c = V.bg(u, v);
    float sh = SM.at(u, v);
    c = c * mix(V.shadowTint, v3(1), 1 - V.shadowK * (1 - sh));
    rad = v3(untonemap(c.x, V.expo), untonemap(c.y, V.expo), untonemap(c.z, V.expo));
    return true;
  }
  inline v3 behind(const Variant &V, v3 ro, v3 rd) const {
    v3 e = V.env(S.envRot.mul(rd)), bd;
    if (!backdrop(V, ro, rd, bd)) return e;
    return mix(bd, e, V.envMix);
  }

  bool march(v3 ro, v3 rd, float t0, float t1, float epsK, float &tHit, int &id) const {
    float t = t0;
    for (int it = 0; it < 220 && t < t1; it++) {
      float d = S.map(ro + rd * t, id);
      if (d < std::max(epsK * t, 1e-4f)) { tHit = t; return true; }
      t += d;
    }
    return false;
  }
  // March inside the volume until the surface; returns path length.
  float marchInside(v3 p0, v3 rd, float minStep, float e, v3 &pOut) const {
    float t = 0;
    pOut = p0;
    for (int it = 0; it < 80; it++) {
      pOut = p0 + rd * t;
      float d = S.map(pOut);
      if (d > -e) break;
      t += std::max(-d, minStep);
    }
    return t;
  }

  struct Out {
    v3 col[2];  // display-linear for dark / light
    float z;
    int id;
    float ao, shadow;  // reused by the cheaper supersamples of this pixel
  };

  // full = false is the supersampling path: ambient occlusion and the shadow
  // term come from the pixel's primary sample (hint), and the internal bounce
  // is approximated without a second march. Both vary slowly across a pixel.
  Out trace(v3 ro, v3 rd, bool wantDark, bool wantLight, const Out *hint = nullptr) const {
    Out o;
    o.id = -1;
    o.ao = o.shadow = 1;
    const Variant *VS[2] = {&V_DARK, &V_LIGHT};
    bool want[2] = {wantDark, wantLight};
    float tb = ZB / -rd.z;
    float t0 = S.firstBound(ro, rd);
    float th = 0;
    int id = -1;
    bool hit = t0 < tb && march(ro, rd, t0, tb, 0.25f * pixAngle, th, id);
    if (!hit) {
      o.z = ZB;
      for (int k = 0; k < 2; k++) {
        if (!want[k]) continue;
        v3 r;
        backdrop(*VS[k], ro, rd, r);
        o.col[k] = v3(tonemap(r.x, VS[k]->expo), tonemap(r.y, VS[k]->expo), tonemap(r.z, VS[k]->expo));
      }
      return o;
    }
    o.id = id;
    const bool full = !hint || hint->id < 0;
    v3 P = ro + rd * th;
    o.z = -P.z;
    const Blob &B = S.b[id];
    float rs = B.scaleMin;
    float e = std::max(0.5f * pixAngle * th, 2e-4f);
    v3 N = S.normal(P, e);
    float cosI = std::max(0.0f, -dot(rd, N));
    float F = schlick(cosI, 0.035f);
    v3 R = reflect(rd, N);
    float ao = full ? S.ao(P, N, rs) : hint->ao;
    float shP = full ? S.softShadow(P + N * (0.04f * rs), KEY_L, 0.02f * rs, 20.0f, 4.0f) : hint->shadow;
    o.ao = ao;
    o.shadow = shP;
    float cosT = std::sqrt(std::max(0.0f, 1 - (1 - cosI * cosI) / (1.33f * 1.33f)));
    v3 film = thinFilm(cosT, S.film(id, P));
    float RL = std::max(0.0f, dot(R, KEY_L));
    float RL2 = RL * RL, RL4 = RL2 * RL2, RL8 = RL4 * RL4, RL16 = RL8 * RL8;
    float spec = (RL16 * RL16 * RL16 * 1.5f + RL8 * 0.18f) * (0.25f + 0.75f * shP);
    float wrapNL = clamp01(0.5f + 0.5f * dot(N, KEY_L));

    // through the volume
    v3 T;
    refract(rd, N, 1.0f / IOR, T);
    float minStep = 0.02f * rs;
    v3 P2;
    float thick = marchInside(P - N * (2 * e), T, minStep, e, P2) / rs;
    v3 N2 = S.normal(P2, e);
    v3 Oc;
    bool tir = !refract(T, -N2, IOR, Oc);
    float F2 = tir ? 1.0f : schlick(std::max(0.0f, dot(Oc, N2)), 0.035f);

    // what the exit ray sees: another blob, or the backdrop / environment
    int idQ = -1;
    v3 Q, NQ;
    if (!tir) {
      v3 s0 = P2 + N2 * (3 * e);
      float tq;
      float tmax = Oc.z < 0 ? (s0.z + ZB) / -Oc.z : 40.0f;
      if (S.anyBound(s0, Oc, tmax) && march(s0, Oc, 0.0f, tmax, 0.35f * pixAngle, tq, idQ)) {
        Q = s0 + Oc * tq;
        NQ = S.normal(Q, std::max(e, 0.5f * pixAngle * (th + tq)));
        if (dot(NQ, Oc) > 0) idQ = -1;  // grazing self-hit
      } else {
        idQ = -1;
      }
    }
    // one internal reflection: bright TIR streaks along the inner surface
    v3 Rin = reflect(T, N2), P3 = P2, O3 = Rin;
    float thick2 = 0.6f * thick;
    if (full) {
      thick2 = marchInside(P2 - N2 * (2 * e), Rin, minStep, e, P3) / rs;
      v3 N3 = S.normal(P3, e);
      if (!refract(Rin, -N3, IOR, O3)) O3 = reflect(Rin, -N3);
    }

    for (int k = 0; k < 2; k++) {
      if (!want[k]) continue;
      const Variant &V = *VS[k];
      v3 refl = V.env(S.envRot.mul(R)) * mix(v3(1), film, V.filmMix) * (0.3f + 0.7f * ao);
      v3 through{0};
      if (idQ >= 0) {
        float cq = std::max(0.0f, -dot(Oc, NQ));
        float FQ = schlick(cq, 0.035f);
        v3 TQ;
        if (!refract(Oc, NQ, 1.0f / IOR, TQ)) TQ = Oc;
        v3 bq = V.env(S.envRot.mul(reflect(Oc, NQ))) * (FQ * V.reflK) +
                behind(V, Q, normalize(Oc * 0.6f + TQ * 0.4f)) * (1 - FQ);
        through = bq * vexp(V.sigma * -0.9f);
      } else {
        for (int j = 0; j < NSPEC; j++) {
          v3 oj;
          v3 c = refract(T, -N2, SPEC.ior[j], oj) ? behind(V, P2, oj) : behind(V, P3, O3);
          through += c * SPEC.w[j];
        }
      }
      v3 internal = behind(V, P3, O3) * vexp(V.sigma * -(thick + thick2));
      v3 trans = (through * (1 - F2) * vexp(V.sigma * -thick) + internal * (F2 * V.internalK));
      float body = (0.70f + 0.30f * wrapNL) * mixf(1.0f, shP, 0.3f) * (0.55f + 0.45f * ao);
      v3 rad = refl * (F * V.reflK) + trans * ((1 - F) * body) + V.specTint * (spec * V.specK);
      o.col[k] = v3(tonemap(rad.x, V.expo), tonemap(rad.y, V.expo), tonemap(rad.z, V.expo));
    }
    return o;
  }
};

// ---------------------------------------------------------------- frame

struct Frame {
  int W, H;
  std::vector<v3> col[2];
  std::vector<float> z, ao, shadow;
  std::vector<int> id;
};

static void renderFrame(const Settings &st, float t, Frame &fr) {
  const int W = st.W, H = st.H;
  Scene S;
  S.build(t, st.loop, W, H);
  ShadowMap SM;
  SM.build(S);
  Tracer tr{S, SM, 2 * S.tanHalf / H};
  fr.W = W;
  fr.H = H;
  for (auto &c : fr.col) c.assign(W * H, v3(0));
  fr.z.assign(W * H, ZB);
  fr.id.assign(W * H, -1);
  fr.ao.assign(W * H, 1);
  fr.shadow.assign(W * H, 1);
  auto rayDir = [&](float px, float py) {
    float x = (2 * px / W - 1) * S.aspect * S.tanHalf;
    float y = (1 - 2 * py / H) * S.tanHalf;
    return normalize(v3(x, y, -1));
  };
  parallelFor(H, [&](int y) {
    for (int x = 0; x < W; x++) {
      float px = x + 0.5f, py = y + 0.5f;
      Tracer::Out s = tr.trace(v3(0), rayDir(px, py), st.dark, st.light);
      int k = y * W + x;
      fr.col[0][k] = s.col[0];
      fr.col[1][k] = s.col[1];
      fr.z[k] = s.z;
      fr.id[k] = s.id;
      if (s.id >= 0) {
        fr.ao[k] = s.ao;
        fr.shadow[k] = s.shadow;
      }
    }
  });
  if (st.aa <= 0) return;
  // adaptive supersampling on silhouettes and high-contrast pixels
  std::vector<uint8_t> need(W * H, 0);
  auto lum = [](v3 c) { return c.x * 0.3f + c.y * 0.59f + c.z * 0.11f; };
  parallelFor(H, [&](int y) {
    for (int x = 0; x < W; x++) {
      int k = y * W + x;
      float l0 = lum(fr.col[0][k]), l1 = lum(fr.col[1][k]);
      for (int dy = -1; dy <= 1 && !need[k]; dy++)
        for (int dx = -1; dx <= 1; dx++) {
          int kk = std::clamp(y + dy, 0, H - 1) * W + std::clamp(x + dx, 0, W - 1);
          if (fr.id[kk] != fr.id[k] || std::fabs(lum(fr.col[0][kk]) - l0) > 0.08f ||
              std::fabs(lum(fr.col[1][kk]) - l1) > 0.07f) {
            need[k] = 1;
            break;
          }
        }
    }
  });
  const int n = st.aa;
  parallelFor(H, [&](int y) {
    for (int x = 0; x < W; x++) {
      int k = y * W + x;
      if (!need[k]) continue;
      v3 s0 = fr.col[0][k], s1 = fr.col[1][k];
      Tracer::Out hint;
      hint.id = fr.id[k];
      hint.ao = fr.ao[k];
      hint.shadow = fr.shadow[k];
      for (int s = 0; s < n; s++) {
        float ox = std::fmod(0.5f + (s + 1) * 0.7548777f, 1.0f), oy = std::fmod(0.5f + (s + 1) * 0.5698403f, 1.0f);
        Tracer::Out smp = tr.trace(v3(0), rayDir(x + ox, y + oy), st.dark, st.light, &hint);
        s0 += smp.col[0];
        s1 += smp.col[1];
      }
      fr.col[0][k] = s0 / float(n + 1);
      fr.col[1][k] = s1 / float(n + 1);
    }
  });
}

// Gather depth of field: each neighbour contributes only if its own circle of
// confusion reaches this pixel, so sharp foreground edges don't smear.
static void depthOfField(std::vector<v3> &img, const std::vector<float> &z, int W, int H, float strength) {
  if (strength <= 0) return;
  const float scale = H / 540.0f;
  const float zf = 6.2f, A = 4.5f * strength * scale, maxR = 7.0f * strength * scale;
  std::vector<float> coc(W * H);
  // the large near blobs stay crisper than the small far ones, as in the original
  for (int k = 0; k < W * H; k++) coc[k] = std::min(maxR, A * std::fabs(1 - zf / z[k]) * (z[k] < zf ? 0.5f : 1.0f));
  constexpr int NT = 40;
  float tx[NT], ty[NT];
  for (int i = 0; i < NT; i++) {
    float r = std::sqrt((i + 0.5f) / NT), a = i * 2.39996323f;
    tx[i] = r * std::cos(a);
    ty[i] = r * std::sin(a);
  }
  std::vector<v3> out(W * H);
  parallelFor(H, [&](int y) {
    for (int x = 0; x < W; x++) {
      int k = y * W + x;
      float r = coc[k];
      if (r < 0.5f) { out[k] = img[k]; continue; }
      v3 sum = img[k];
      float wsum = 1;
      for (int i = 0; i < NT; i++) {
        float dx = tx[i] * r, dy = ty[i] * r;
        int xx = std::clamp(int(std::lround(x + dx)), 0, W - 1), yy = std::clamp(int(std::lround(y + dy)), 0, H - 1);
        int kk = yy * W + xx;
        float dist = std::sqrt(dx * dx + dy * dy);
        float w = clamp01(coc[kk] - dist + 1);
        sum += img[kk] * w;
        wsum += w;
      }
      out[k] = sum / wsum;
    }
  });
  img.swap(out);
}

// Soft glow from highlights (dark variant), on display-linear values.
static void bloom(std::vector<v3> &img, int W, int H, float threshold, float radiusFrac, float strength) {
  int w = std::max(1, W / 4), h = std::max(1, H / 4);
  std::vector<v3> a(w * h), b(w * h);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      v3 s{0};
      for (int j = 0; j < 4; j++)
        for (int i = 0; i < 4; i++)
          s += vmax(img[std::min(H - 1, y * 4 + j) * W + std::min(W - 1, x * 4 + i)] - v3(threshold), 0.0f);
      a[y * w + x] = s / 16.0f;
    }
  float sigma = radiusFrac * w;
  int R = int(std::ceil(sigma * 3));
  std::vector<float> k(2 * R + 1);
  float ks = 0;
  for (int i = -R; i <= R; i++) ks += k[i + R] = std::exp(-0.5f * i * i / (sigma * sigma));
  for (auto &x : k) x /= ks;
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      v3 s{0};
      for (int i = -R; i <= R; i++) s += a[y * w + std::clamp(x + i, 0, w - 1)] * k[i + R];
      b[y * w + x] = s;
    }
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      v3 s{0};
      for (int i = -R; i <= R; i++) s += b[std::clamp(y + i, 0, h - 1) * w + x] * k[i + R];
      a[y * w + x] = s;
    }
  parallelFor(H, [&](int y) {
    for (int x = 0; x < W; x++) {
      float fx = (x + 0.5f) / 4 - 0.5f, fy = (y + 0.5f) / 4 - 0.5f;
      int x0 = std::clamp(int(std::floor(fx)), 0, w - 1), y0 = std::clamp(int(std::floor(fy)), 0, h - 1);
      int x1 = std::min(x0 + 1, w - 1), y1 = std::min(y0 + 1, h - 1);
      float tx = clamp01(fx - x0), ty = clamp01(fy - y0);
      v3 c = mix(mix(a[y0 * w + x0], a[y0 * w + x1], tx), mix(a[y1 * w + x0], a[y1 * w + x1], tx), ty);
      img[y * W + x] += c * strength;
    }
  });
}

static inline float tpdf(uint32_t h) {
  float a = (h & 0xffff) / 65535.0f, b = (h >> 16) / 65535.0f;
  return a + b - 1.0f;
}
static inline uint32_t phash(uint32_t x, uint32_t y, uint32_t f, uint32_t c) {
  uint32_t h = x * 1973u + y * 9277u + f * 26699u + c * 6151u;
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return h;
}

// Display-linear -> dithered 8-bit, rgb24 or yuv420p (bt709, limited range).
// Dither is added after the YUV conversion so it survives as real 8-bit noise.
static void encode(const std::vector<v3> &lin, int W, int H, int frameIdx, bool yuv, std::vector<uint8_t> &out) {
  if (!yuv) {
    out.resize(W * H * 3);
    parallelFor(H, [&](int y) {
      for (int x = 0; x < W; x++) {
        v3 c = lin[y * W + x];
        float ch[3] = {linToSrgb(c.x), linToSrgb(c.y), linToSrgb(c.z)};
        for (int i = 0; i < 3; i++) {
          float v = ch[i] * 255 + tpdf(phash(x, y, frameIdx, i));
          out[(y * W + x) * 3 + i] = (uint8_t)std::clamp(int(std::lround(v)), 0, 255);
        }
      }
    });
    return;
  }
  out.resize(W * H * 3 / 2);
  std::vector<v3> e(W * H);
  parallelFor(W * H, [&](int k) { e[k] = v3(linToSrgb(lin[k].x), linToSrgb(lin[k].y), linToSrgb(lin[k].z)); });
  uint8_t *Y = out.data(), *U = Y + W * H, *V = U + (W / 2) * (H / 2);
  parallelFor(H, [&](int y) {
    for (int x = 0; x < W; x++) {
      v3 c = e[y * W + x];
      float yy = 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
      Y[y * W + x] = (uint8_t)std::clamp(int(std::lround(16 + 219 * yy + tpdf(phash(x, y, frameIdx, 0)))), 0, 255);
    }
  });
  parallelFor(H / 2, [&](int y) {
    for (int x = 0; x < W / 2; x++) {
      v3 c = (e[(2 * y) * W + 2 * x] + e[(2 * y) * W + 2 * x + 1] + e[(2 * y + 1) * W + 2 * x] +
              e[(2 * y + 1) * W + 2 * x + 1]) * 0.25f;
      float yy = 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
      float cb = (c.z - yy) / 1.8556f, cr = (c.x - yy) / 1.5748f;
      U[y * (W / 2) + x] = (uint8_t)std::clamp(int(std::lround(128 + 224 * cb + tpdf(phash(x, y, frameIdx, 1)))), 0, 255);
      V[y * (W / 2) + x] = (uint8_t)std::clamp(int(std::lround(128 + 224 * cr + tpdf(phash(x, y, frameIdx, 2)))), 0, 255);
    }
  });
}

static bool writeAll(const std::string &path, const std::vector<uint8_t> &buf) {
  FILE *f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  std::fwrite(buf.data(), 1, buf.size(), f);
  std::fclose(f);
  return true;
}

int main(int argc, char **argv) {
  Settings st;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto next = [&]() { return std::string(argv[++i]); };
    if (a == "--size") { std::string s = next(); std::sscanf(s.c_str(), "%dx%d", &st.W, &st.H); }
    else if (a == "--fps") st.fps = std::stof(next());
    else if (a == "--loop") st.loop = std::stof(next());
    else if (a == "--start") st.frameStart = std::stoi(next());
    else if (a == "--frames") st.frameCount = std::stoi(next());
    else if (a == "--time-offset") st.timeOffset = std::stof(next());
    else if (a == "--aa") st.aa = std::stoi(next());
    else if (a == "--dof") st.dof = std::stof(next());
    else if (a == "--yuv") st.yuv = true;
    else if (a == "--only-dark") st.light = false;
    else if (a == "--only-light") st.dark = false;
    else if (a == "--out-dark") st.outDark = next();
    else if (a == "--out-light") st.outLight = next();
    else if (a == "--per-frame") st.perFrame = true;
    else { std::fprintf(stderr, "unknown arg %s\n", a.c_str()); return 1; }
  }
  if (st.W % 2 || st.H % 2) { std::fprintf(stderr, "size must be even\n"); return 1; }
  Frame fr;
  std::vector<uint8_t> buf;
  char name[1024];
  // streams stay open for the whole run so FIFOs see a single EOF
  FILE *streams[2] = {nullptr, nullptr};
  if (!st.perFrame) {
    if (st.dark && !(streams[0] = std::fopen(st.outDark.c_str(), "wb"))) { std::perror(st.outDark.c_str()); return 1; }
    if (st.light && !(streams[1] = std::fopen(st.outLight.c_str(), "wb"))) { std::perror(st.outLight.c_str()); return 1; }
  }
  auto t0 = std::chrono::steady_clock::now();
  for (int f = st.frameStart; f < st.frameStart + st.frameCount; f++) {
    float t = std::fmod(f / st.fps + st.timeOffset, st.loop);
    auto tf = std::chrono::steady_clock::now();
    renderFrame(st, t, fr);
    for (int variant = 0; variant < 2; variant++) {
      bool isDark = variant == 0;
      if ((isDark && !st.dark) || (!isDark && !st.light)) continue;
      std::vector<v3> &img = fr.col[variant];
      depthOfField(img, fr.z, st.W, st.H, st.dof);
      if (isDark) bloom(img, st.W, st.H, 0.7f, 0.02f, 0.25f);
      encode(img, st.W, st.H, f, st.yuv, buf);
      const std::string &pat = isDark ? st.outDark : st.outLight;
      if (st.perFrame) {
        std::snprintf(name, sizeof name, pat.c_str(), f);
        writeAll(name, buf);
      } else {
        std::fwrite(buf.data(), 1, buf.size(), streams[variant]);
        std::fflush(streams[variant]);
      }
    }
    auto now = std::chrono::steady_clock::now();
    double sec = std::chrono::duration<double>(now - tf).count();
    double avg = std::chrono::duration<double>(now - t0).count() / (f - st.frameStart + 1);
    int left = st.frameStart + st.frameCount - 1 - f;
    std::fprintf(stderr, "frame %d/%d (t=%.3f) %.2fs, eta %.1f min\n", f - st.frameStart + 1, st.frameCount, t, sec,
                 left * avg / 60);
  }
  for (FILE *s : streams)
    if (s) std::fclose(s);
  return 0;
}

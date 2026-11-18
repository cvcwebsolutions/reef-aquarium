// The 3D living reef: environment, camera, light, water, the render loop.
// The reef itself is our own photo (ComfyUI, Flux.3 Image Klein) made 2.5D with MoGe-2 depth (bake.py), so fish
// pass behind the coral and settle into the sand; everything alive is real 3D (life.js).
import * as THREE from 'three';
import { Life } from './life.js';

const Q = new URLSearchParams(location.search);
const BASE = './';
const PX = Math.min(window.devicePixelRatio || 1, +(Q.get('px') || 1.5));

// ---------- time of day: follows the computer's clock (or ?hour=) ----------
function hourNow() {
  if (Q.has('hour')) return +Q.get('hour');
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// 0 = night, 1 = full day. Berlin in November: light from ~07:30 to ~16:30; dusk and dawn take their time.
function daylight(h) { return smooth(6.6, 8.6, h) * (1 - smooth(15.8, 18.2, h)); }
// warm low sun at dawn and dusk
function golden(h) { return Math.max(0, 1 - Math.abs(h - 16.7) / 1.3) + Math.max(0, 1 - Math.abs(h - 7.6) / 1.0); }

// ---------- shared water shading (GLSL), used by the backdrop and every creature ----------
export const WATER = {
  uniforms: {
    uTime: { value: 0 }, uDay: { value: 1 }, uGold: { value: 0 },
    uWater: { value: null }, uFogDensity: { value: 0.045 },
    uAbsorb: { value: new THREE.Vector3(0.045, 0.016, 0.008) },
    uNight: { value: new THREE.Vector3(0.22, 0.36, 0.62) },
    uSun: { value: new THREE.Vector3(0.18, 1.0, 0.25).normalize() },
    uCaustic: { value: null },
  },
  glsl: /* glsl */`
    #define CAUSTIC_TILE 0.375
    uniform float uTime, uDay, uGold, uFogDensity;
    uniform sampler2D uWater;
    uniform vec3 uAbsorb, uNight, uSun;
    vec3 waterColor(vec3 dir) {
      float el = degrees(asin(clamp(dir.y, -1.0, 1.0)));
      return texture2D(uWater, vec2(clamp((el + 40.0) / 100.0, 0.0, 1.0), 0.5)).rgb;
    }
    // night: moonlit deep blue, not black; dusk/dawn: a little warmth up high
    vec3 grade(vec3 c) {
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      vec3 night = mix(vec3(l), c, 0.5) * uNight;
      vec3 day = c * (1.0 + uGold * vec3(0.10, 0.03, -0.06));
      return mix(night, day, uDay);
    }
    vec3 underwater(vec3 c, vec3 world) {
      vec3 v = world - cameraPosition;
      float d = length(v);
      c *= exp(-d * uAbsorb);
      float f = 1.0 - exp(-d * uFogDensity);
      return mix(c, waterColor(v / d), f);
    }
    // Our own caustic: drawn once a frame into a small
    // tiling texture by makeCaustics() below and looked up here, two time-shifted copies at two scales
    uniform sampler2D uCaustic;
    float causticsAt(vec3 world, float t) {
      vec2 q = world.xz - uSun.xz / uSun.y * world.y;  // projected down the sun's direction
      float a = 2.0 * texture2D(uCaustic, q * (0.22 * CAUSTIC_TILE)).r;   // stored halved (see makeCaustics)
      float b = 2.0 * texture2D(uCaustic, (q * 0.31 + 3.7) * CAUSTIC_TILE).g;
      return clamp(a * 0.6 + b * 0.5, 0.0, 2.0);
    }
  `,
};

// Patch a three.js material so it gets caustics from above, water absorption + haze and the day/night grade.
export function waterify(mat, opts = {}) {
  const caust = opts.caustics ?? 0.55;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, WATER.uniforms);
    if (opts.uniforms) Object.assign(sh.uniforms, opts.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\n' + (opts.vertexHead || ''))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (opts.vertexBody || ''))
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + (opts.normalBody || ''))
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wpos = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpos = instanceMatrix * wpos;
        #endif
        vWorld = (modelMatrix * wpos).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\n' + WATER.glsl + (opts.fragmentHead || ''))
      .replace('#include <opaque_fragment>', `
        {
          vec3 nW = normalize(inverseTransformDirection(normal, viewMatrix));
          float up = clamp(nW.y * 0.8 + 0.2, 0.0, 1.0);
          outgoingLight *= 1.0 + ${caust.toFixed(3)} * uDay * up * (causticsAt(vWorld, uTime) - 0.25);
          // light scattered round the edges by the water (keeps silhouettes soft against the blue)
          vec3 vv = normalize(cameraPosition - vWorld);
          float rim = pow(1.0 - clamp(abs(dot(nW, vv)), 0.0, 1.0), 3.0);
          outgoingLight += rim * waterColor(-vv) * ${(opts.rim ?? 0.35).toFixed(3)} * (0.4 + 0.6 * uDay);
          // the underside sits in its own shade; a photo's fine grain so the 3D creatures sit in the photo
          outgoingLight *= mix(${(opts.belly ?? 0.62).toFixed(3)}, 1.0, smoothstep(-0.75, 0.35, nW.y));
          outgoingLight *= 1.0 + (fract(sin(dot(gl_FragCoord.xy + fract(uTime * 7.0) * 91.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.07;
          ${opts.fragmentBody || ''}
          ${opts.silhouette ? `
          // far off, a big animal is a darker shape in the blue: its markings go first and its body
          // settles towards a shade darker than the water, so the haze fades a solid silhouette. Without this a shark
          // lit from above was as bright as the photo's water behind it, and only its markings were left: the viewer saw
          // a see-through shark in the distance.
          {
            vec3 vd = vWorld - cameraPosition;
            float w = smoothstep(${(opts.silNear ?? 5).toFixed(1)}, ${(opts.silFar ?? 16).toFixed(1)}, length(vd)) * 0.85 * ${opts.silhouette.toFixed(3)};
            vec3 veil = waterColor(normalize(vd));
            float l = dot(outgoingLight, vec3(0.299, 0.587, 0.114)), lv = max(dot(veil, vec3(0.299, 0.587, 0.114)), 1e-3);
            outgoingLight = mix(outgoingLight, veil * (0.5 + 0.2 * clamp(l / lv, 0.0, 1.5)), w);
          }` : ''}
          outgoingLight = underwater(grade(outgoingLight), vWorld);
        }
        #include <opaque_fragment>`);
    mat.userData.shader = sh;
  };
  mat.customProgramCacheKey = () => 'water:' + (opts.key || '') + caust + ':' + (opts.silhouette || 0) + ':' + (opts.silNear ?? 5);
  return mat;
}

// ---------- renderer, camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: Q.has('shot') });
renderer.setPixelRatio(PX);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 400);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

// ---------- our own caustic ----------
// Sunlight focused by the waves overhead gathers into a web of bright lines round darker cells. Here the cells are a
// moving Voronoi pattern: each cell has a point that wanders on its own small loop, and the light sits where the two
// nearest points are about equally far (the cell borders), each border as bright as its two cells' own sparkle. A
// slow sideways warp bends the borders into the soft curves real caustics have; a finer second net and slow patches
// break it up. Matched side by side to the pattern it replaced and tuned to the same spread of values (through
// causticsAt: mean ~0.13, half under ~0.1, 99 % under ~0.5), so everything lit by it keeps its brightness.
// It is drawn once a frame into a 512 x 512 tile of 8 x 8 cells that repeats seamlessly (the hash and every wave
// repeat every 8 cells), red and green two time-shifted copies; everything else looks it up (WATER.causticsAt). Worked
// out per pixel everywhere it cost about four times the old pattern's GPU time.
const CAUSTIC_GLSL = /* glsl */`
  #define N 8.0
  vec2 cellHash(vec2 c, float n) {
    c = mod(c, n);
    return fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))) * 43758.5453);
  }
  float causticLayer(vec2 p, float t, float n) {
    vec2 ip = floor(p), fp = p - ip;
    float d1 = 8.0, d2 = 8.0, b1 = 0.0, b2 = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y)), h = cellHash(ip + g, n);
      vec2 o = 0.5 + 0.42 * sin(vec2(t * 0.9, t * 0.75) + 6.28318 * h);
      float d = length(g + o - fp);
      if (d < d1) { d2 = d1; b2 = b1; d1 = d; b1 = h.x; } else if (d < d2) { d2 = d; b2 = h.x; }
    }
    float l = max(0.0, 1.0 - (d2 - d1) / 0.62);
    return (pow(l, 4.0) + 1.1 * pow(l, 14.0)) * (0.35 + 0.65 * (b1 + b2) * 0.5);
  }
  // p in cells (0..8 across the tile); every wave here repeats over 8 cells
  float caustic(vec2 p, float t) {
    const float K = 6.28318 / N;
    p += 0.32 * vec2(sin(p.y * 2.0 * K + t * 0.7), cos(p.x * 2.0 * K - t * 0.6));
    p += 0.12 * vec2(sin(p.y * 5.0 * K - t * 1.2), cos(p.x * 5.0 * K + t * 1.0));
    float c = causticLayer(p, t, N) + 0.3 * causticLayer(p * 2.0 + 5.0, t * 1.15, 2.0 * N);
    c *= 0.55 + 0.45 * sin(p.x * K + t * 0.31) * sin(p.y * K - t * 0.27);
    return 0.65 * c;
  }
`;
function makeCaustics(size = 512) {
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: false });
  const tex = rt.texture;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 } }, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: 'varying vec2 vT; void main(){ vT = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: CAUSTIC_GLSL + /* glsl */`
      uniform float uT; varying vec2 vT;
      // the values go into an 8-bit texture: stored halved, so up to 2 fits
      void main() { vec2 p = vT * N; gl_FragColor = vec4(caustic(p, uT * 0.55) * 0.5, caustic(p, uT * 0.43 + 11.0) * 0.5, 0.0, 1.0); }`,
  });
  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  q.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(q);
  const cam = new THREE.Camera();
  WATER.uniforms.uCaustic.value = tex;
  return (t) => {
    mat.uniforms.uT.value = t;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.render(sc, cam); renderer.setRenderTarget(prev);
  };
}

// ---------- the backdrop: photo + depth -> a mesh seen from where the photo was taken ----------
async function loadBackdrop() {
  const [info, depthBuf, map, nmap] = await Promise.all([
    fetch(BASE + 'scene/scene.json').then(r => r.json()),
    fetch(BASE + 'scene/bg_depth.bin').then(r => r.arrayBuffer()),
    new THREE.TextureLoader().loadAsync(BASE + 'scene/bg.webp'),
    new THREE.TextureLoader().loadAsync(BASE + 'scene/bg_normal.webp'),
  ]);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.generateMipmaps = true;
  const [GW, GH] = info.grid;
  const half = new Uint16Array(depthBuf);
  const depth = new Float32Array(GW * GH);
  for (let k = 0; k < depth.length; k++) depth[k] = THREE.DataUtils.fromHalfFloat(half[k]);
  const { fx, fy, cx, cy } = info;
  const pos = new Float32Array(GW * GH * 3), uv = new Float32Array(GW * GH * 2);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = j * GW + i, u = i / (GW - 1), v = j / (GH - 1), z = depth[k];
    pos[k * 3] = (u - cx) / fx * z; pos[k * 3 + 1] = -(v - cy) / fy * z; pos[k * 3 + 2] = -z;
    uv[k * 2] = u; uv[k * 2 + 1] = 1 - v;
  }
  const idx = [];
  for (let j = 0; j < GH - 1; j++) for (let i = 0; i < GW - 1; i++) {
    const a = j * GW + i, b = a + 1, c = a + GW, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...WATER.uniforms, map: { value: map }, nmap: { value: nmap } },
    toneMapped: false,
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vWorld;
      void main() {
        vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map, nmap;
      varying vec2 vUv; varying vec3 vWorld;
      ${WATER.glsl}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        float dist = length(vWorld);
        // a faint refraction shimmer that grows with distance
        float far = smoothstep(6.0, 30.0, dist);
        vec2 uv = vUv + far * 0.0007 * vec2(sin(vUv.y * 80.0 + uTime * 0.8), cos(vUv.x * 60.0 + uTime * 0.6));
        // the sea surface seen from below is never still. The photo's surface is a plane overhead: S are coordinates on it, the
        // ripples growing towards the top of the picture (overhead, close) and crowding towards the horizon. A swell of
        // a few long waves crossing at angles bends what is seen through it (the photo's sky and sun wobble), and the
        // wave facets throw a moving net of bright lines and flickering sun glints, brightest where the photo is bright
        // (the window of sky straight up).
        float ceiling = smoothstep(0.55, 0.95, vUv.y);
        float kz = max(vUv.y - 0.43, 0.035);
        vec2 S = vec2((vUv.x - 0.5) / kz, 1.0 / kz);
        if (ceiling > 0.0) {
          vec2 g = vec2(0.8, 0.6) * cos(dot(S, vec2(0.8, 0.6)) * 1.8 - uTime * 0.85)
                 + vec2(-0.45, 0.89) * cos(dot(S, vec2(-0.45, 0.89)) * 3.1 - uTime * 1.15) * 0.6
                 + vec2(0.96, -0.28) * cos(dot(S, vec2(0.96, -0.28)) * 5.3 - uTime * 1.6) * 0.4
                 + vec2(0.2, 0.98) * cos(dot(S, vec2(0.2, 0.98)) * 8.7 - uTime * 2.2) * 0.25;
          uv += g * ceiling * 0.0055 * min(kz * 4.0, 1.0);
        }
        vec3 col = texture2D(map, uv).rgb;
        vec3 n = texture2D(nmap, vUv).rgb * 2.0 - 1.0;
        float up = smoothstep(0.25, 0.95, n.y);
        float c = causticsAt(vWorld, uTime);
        col *= 1.0 + uDay * up * exp(-dist * 0.07) * 0.75 * (c - 0.3);
        // big slow light patches from the waves overhead
        col *= 0.93 + 0.07 * vnoise(vWorld.xz * 0.18 + vec2(uTime * 0.035, uTime * 0.02));
        // the surface far above: the moving net of light on its underside and the sun's glints (see above)
        if (ceiling > 0.0) {
          float lum = dot(col, vec3(0.299, 0.587, 0.114));
          float net = 2.0 * texture2D(uCaustic, (S * 0.12 + vec2(uTime * 0.02, 0.0)) * CAUSTIC_TILE).r;
          float glint = pow(max(0.0, sin(S.x * 2.3 + uTime * 1.7 + sin(S.y * 1.1)) * sin(S.y * 1.9 - uTime * 1.3 + sin(S.x * 0.7))), 24.0);
          // the photo's own bright sparkles come and go as the facets tilt, instead of sitting frozen
          float twinkle = 2.0 * texture2D(uCaustic, (S * 0.3 - vec2(0.0, uTime * 0.05)) * CAUSTIC_TILE).g;
          col += ceiling * smoothstep(0.45, 0.9, lum) * col * (twinkle * 2.2 - 0.35);
          col += ceiling * (0.02 + 0.45 * net * (0.4 + lum) + 0.35 * glint * lum) * vec3(0.78, 0.92, 1.0) * (0.25 + 0.75 * uDay);
          // and the light through it breathes as the swell passes
          col *= 1.0 + ceiling * 0.06 * sin(dot(S, vec2(0.8, 0.6)) * 0.9 - uTime * 0.85 + 1.2);
        }
        gl_FragColor = vec4(grade(col), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // water colour by elevation for haze, from the photo's own open water
  const n = info.water.rgb.length, data = new Uint8Array(n * 4), c = new THREE.Color();
  info.water.rgb.forEach((rgb, k) => {
    c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    data.set([c.r * 255, c.g * 255, c.b * 255, 255].map(Math.round), k * 4);
  });
  const wt = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  wt.magFilter = wt.minFilter = THREE.LinearFilter; wt.needsUpdate = true;
  WATER.uniforms.uWater.value = wt;

  // terrain heights from the depth grid (see height() below)
  const terrain = (() => {
    const zb = 0.1, zmax = 26, zn = Math.ceil(zmax / zb), SLOPE = 1.3;
    const raw = new Float32Array(GW * zn).fill(-1e9);
    const fl = info.floor;
    const at = (i, j) => depth[j * GW + i];
    for (let i = 0; i < GW; i++) {
      const u = i / (GW - 1), kx = (u - cx) / fx;
      const floorAt = (z) => fl[0] * kx * z + fl[1] * -z + fl[2];
      const col = i * zn;
      let zp = -1, yp = 0;
      for (let j = GH - 1; j >= 0; j--) {
        const z = at(i, j);
        if (!(z < zmax)) { continue; }
        // a sample smeared across a depth edge (between the coral in front and what lies behind) is not a surface
        let lo = z, hi = z;
        for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const ii = i + di, jj = j + dj; if (ii < 0 || ii >= GW || jj < 0 || jj >= GH) continue;
          const zz = at(ii, jj); lo = Math.min(lo, zz); hi = Math.max(hi, zz);
        }
        if (z > lo * 1.12 && z < hi / 1.12) continue;
        const y = -(j / (GH - 1) - cy) / fy * z;
        if (y > 3) continue;   // MoGe reads a patch of the sea surface as a roof: not reef
        const b = Math.floor(z / zb);
        if (y > raw[col + b]) raw[col + b] = y;
        if (zp > 0 && z > zp + zb) {
          // between two samples one above the other in the photo: a continuous slope, or the hidden ground behind a
          // crest. Never above the line between them (that is the line of sight); a hidden back slopes down.
          for (let bb = Math.floor(zp / zb) + 1; bb < b; bb++) {
            const zc = (bb + 0.5) * zb, t = (zc - zp) / (z - zp), seg = yp + (y - yp) * t;
            const jump = z > zp * 1.12;
            const val = jump ? Math.min(seg, Math.max(yp - SLOPE * (zc - zp), y - SLOPE * (z - zc), floorAt(zc))) : seg;
            if (val > raw[col + bb]) raw[col + bb] = val;
          }
        }
        zp = z; yp = y;
      }
      // unknown ground: sand, or the back of the last crest sloping down to the sand
      let prev = -1e9;
      for (let b = 0; b < zn; b++) {
        const zc = (b + 0.5) * zb;
        if (raw[col + b] < -1e8) raw[col + b] = Math.max(floorAt(zc), prev - SLOPE * zb);
        prev = raw[col + b];
      }
    }
    // a little wider and longer than the coral itself (about 8 cm), so a body's flank clears it too
    const h = new Float32Array(GW * zn);
    for (let b = 0; b < zn; b++) {
      const zc = (b + 0.5) * zb, w = Math.min(10, Math.ceil(0.08 / (zc / (fx * (GW - 1)))));
      for (let i = 0; i < GW; i++) {
        let m = -1e9;
        for (let ii = Math.max(0, i - w); ii <= Math.min(GW - 1, i + w); ii++)
          for (let bb = Math.max(0, b - 1); bb <= Math.min(zn - 1, b + 1); bb++) m = Math.max(m, raw[ii * zn + bb]);
        h[i * zn + b] = m;
      }
    }
    return { raw, h, zb, zmax, zn };
  })();

  // what the photo's camera saw: depth lookups for "is this point inside the reef or the sand?"
  const fovY = 2 * Math.atan(0.5 / fy) * 180 / Math.PI;
  return { info, depth, GW, GH, fovY, mesh, terrain,
    project(p) {   // three.js point -> photo uv and the photo camera's depth there
      const z = -p.z; if (z <= 0.05) return null;
      return { u: cx + fx * p.x / z, v: cy - fy * p.y / z, z };
    },
    surfaceDepth(u, v) {
      const i = Math.min(GW - 1, Math.max(0, Math.round(u * (GW - 1))));
      const j = Math.min(GH - 1, Math.max(0, Math.round(v * (GH - 1))));
      return depth[j * GW + i];
    },
    floorY(x, z) { const f = info.floor; return f[0] * x + f[1] * z + f[2]; },
    // ---- the reef as a volume ----
    // The photo only knows the side of the coral that faces the camera. `terrain` turns that into the height of the
    // top of reef or sand for every place on the ground (photo column x depth bin), so "inside the coral" is simply
    // "below that height": nothing can enter a coral head through its face. What the camera can't see (behind a
    // crest) is assumed to slope down from the crest to the sand, never higher than the line of sight over the
    // crest, so an animal behind a coral head is hidden by it and comes back out at its edge.
    height(p, raw = false) {
      const z = -p.z, T = this.terrain;
      if (z < 0.3 || z >= T.zmax) return this.floorY(p.x, p.z);
      const u = Math.min(1, Math.max(0, cx + fx * p.x / z));   // past the photo's sides the edge column carries on
      const i = Math.round(u * (GW - 1)), b = Math.min(T.zn - 1, Math.floor(z / T.zb));
      return Math.max((raw ? T.raw : T.h)[i * T.zn + b], this.floorY(p.x, p.z));
    },
    // something solid standing on the ground that the photo doesn't show (the anemone): a bump of radius r up to `top`
    raise(c, r, top) {
      const T = this.terrain;
      for (let b = Math.max(0, Math.floor((-c.z - r) / T.zb)); b <= Math.min(T.zn - 1, Math.floor((-c.z + r) / T.zb)); b++) {
        const z = (b + 0.5) * T.zb;
        for (let i = 0; i < GW; i++) {
          const x = (i / (GW - 1) - cx) / fx * z;
          if ((x - c.x) ** 2 + (-z - c.z) ** 2 < r * r) for (const a of [T.raw, T.h]) a[i * T.zn + b] = Math.max(a[i * T.zn + b], top);
        }
      }
    },
    // inside reef or sand; `margin` = how far above the terrain the point must stay
    solid(p, margin = 0) { return p.y < this.height(p) + margin; },
    // the 3D point on the backdrop at photo uv (u, v from the top-left)
    pointAt(u, v) {
      const z = this.surfaceDepth(u, v);
      return new THREE.Vector3((u - cx) / fx * z, -(v - cy) / fy * z, -z);
    },
  };
}

// ---------- light shafts from the surface (screen space, over everything) ----------
function makeRays() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...WATER.uniforms, uAspect: { value: 1.6 } },
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`
      uniform float uTime, uDay, uGold, uAspect; varying vec2 vP;
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      float n1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(i), hash(i + 1.0), f); }
      void main() {
        vec2 src = vec2(-0.25, 2.6);
        vec2 d = vec2((vP.x - src.x) * uAspect, vP.y - src.y);
        float ang = atan(d.x, -d.y);
        float r = length(d);
        float s = 0.0;
        s += pow(n1(ang * 38.0 + uTime * 0.05), 3.0) * 0.55;
        s += pow(n1(ang * 71.0 - uTime * 0.035 + 7.0), 4.0) * 0.45;
        s += pow(n1(ang * 19.0 + uTime * 0.02 + 3.0), 2.0) * 0.25;
        float fade = smoothstep(4.6, 1.6, r) * smoothstep(-0.85, 0.6, vP.y);
        float strength = mix(0.035, 0.16, uDay);
        vec3 col = mix(vec3(0.55, 0.75, 1.0), vec3(1.0, 0.92, 0.75), uGold * 0.6);
        gl_FragColor = vec4(col * s * fade * strength, 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  m.frustumCulled = false; m.renderOrder = 1000;
  return m;
}

// ---------- marine snow (and at night a few plankton sparks) ----------
function makeSnow(count = 1400) {
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    pos[k * 3] = (Math.random() - 0.5) * 14; pos[k * 3 + 1] = Math.random() * 8 - 2.5; pos[k * 3 + 2] = -0.6 - Math.random() * 16;
    seed[k] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...WATER.uniforms, uPx: { value: PX } },
    transparent: true, depthWrite: false, toneMapped: false,
    vertexShader: /* glsl */`
      uniform float uTime, uPx, uDay; attribute float seed; varying float vA; varying float vSpark;
      void main() {
        vec3 p = position;
        p.y = mod(p.y - uTime * (0.012 + 0.02 * seed) + 2.5, 8.0) - 2.5;
        p.x += sin(uTime * 0.13 + seed * 40.0) * 0.25 + uTime * 0.01;
        p.x = mod(p.x + 7.0, 14.0) - 7.0;
        p.z += cos(uTime * 0.11 + seed * 23.0) * 0.2;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        // a few plankton sparks at night
        float spark = step(0.985, seed) * (1.0 - uDay) * pow(max(0.0, sin(uTime * (0.6 + seed) + seed * 90.0)), 12.0);
        vSpark = spark;
        gl_PointSize = uPx * (1.4 + 2.2 * fract(seed * 7.3)) * (6.0 / max(d, 0.6)) * (1.0 + spark * 1.5);
        vA = (0.18 + 0.25 * fract(seed * 3.1)) * exp(-d * 0.09) * mix(0.45, 1.0, uDay) + spark;
      }`,
    fragmentShader: /* glsl */`
      varying float vA; varying float vSpark;
      void main() {
        vec2 c = gl_PointCoord - 0.5; float r = dot(c, c);
        if (r > 0.25) discard;
        vec3 col = mix(vec3(0.85, 0.93, 1.0), vec3(0.35, 0.85, 1.0), clamp(vSpark * 2.0, 0.0, 1.0));
        gl_FragColor = vec4(col, vA * (1.0 - r * 4.0));
        #include <colorspace_fragment>
      }`,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false; p.renderOrder = 10;
  return p;
}

// ---------- lights ----------
// light comes from above: a strong sun, blue water all round, the white sand throwing light back up at bellies
const hemi = new THREE.HemisphereLight(0x7fb8e8, 0x8d9c98, 0.6);
const sun = new THREE.DirectionalLight(0xeef8ff, 3.6);
sun.position.copy(WATER.uniforms.uSun.value).multiplyScalar(30);
scene.add(hemi, sun, sun.target);
// environment for the sheen on scales: bright surface above, blue all round, pale sand below
function makeEnv() {
  const s = new THREE.Scene();
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */`
      varying vec3 vD;
      void main() {
        float y = vD.y;
        vec3 deep = vec3(0.02, 0.12, 0.28), mid = vec3(0.07, 0.32, 0.55), top = vec3(0.65, 0.88, 1.0), sand = vec3(0.45, 0.55, 0.58);
        vec3 c = y > 0.0 ? mix(mid, top, pow(y, 2.5)) : mix(mid, mix(deep, sand, 0.7), pow(-y, 0.7));
        c += vec3(1.0, 0.97, 0.9) * pow(max(dot(vD, normalize(vec3(0.18, 1.0, 0.25))), 0.0), 64.0) * 3.0;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), m));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0.02);
  pm.dispose();
  return rt.texture;
}
scene.environment = makeEnv();
scene.environmentIntensity = 0.9;

// ---------- go ----------
const fpsEl = document.getElementById('fps');
if (Q.has('fps')) fpsEl.style.display = 'block';

async function main() {
  const reef = await loadBackdrop();
  const baseFov = reef.fovY;
  camera.fov = 2 * Math.atan(Math.tan(baseFov * Math.PI / 360) * 0.93) * 180 / Math.PI;
  camera.updateProjectionMatrix();
  const drawCaustics = makeCaustics();
  const rays = makeRays();
  scene.add(rays, makeSnow());
  const life = new Life(scene, reef, { camera, waterify, WATER });
  await life.load(BASE);
  window.__life = life;   // for tests over the DevTools protocol

  const t0 = performance.now() / 1000, startAt = +(Q.get('t') || 0);
  let simT = startAt, last = t0, frames = 0, fpsT = t0;
  // pre-run the simulation for stills (?t=)
  for (let k = 0; k < startAt * 20; k++) life.update(0.05, k * 0.05);

  // ?manual=1 (tests, clips): no frame loop; window.__step(dt) moves the scene on by dt and draws one frame, so a clip
  // recorded headless at any capture rate plays back at true speed
  const manual = Q.has('manual');
  function frame(stepDt) {
    const now = performance.now() / 1000;
    const dt = manual ? stepDt : Math.min(0.1, now - last); last = now;
    simT += dt;
    const h = hourNow(), day = daylight(h);
    WATER.uniforms.uTime.value = simT;
    WATER.uniforms.uDay.value = day;
    WATER.uniforms.uGold.value = golden(h);
    // the grade darkens the night for everything; the lights only ease off a little so the creatures stay as bright
    // as the photo behind them (dimming both made them flat dark cut-outs)
    hemi.intensity = 0.45 + 0.15 * day; sun.intensity = 1.7 + 1.9 * day;
    scene.environmentIntensity = 0.5 + 0.15 * day;
    sun.color.setRGB(0.91 + 0.09 * golden(h), 0.96, 1.0 - 0.15 * golden(h));
    rays.material.uniforms.uAspect.value = camera.aspect;
    // a slow float: mostly a gentle look-around (no parallax gaps), with a touch of drift
    const s = simT;
    camera.position.set(0.05 * Math.sin(s * 0.027) + 0.02 * Math.sin(s * 0.071),
                        0.035 * Math.sin(s * 0.019 + 1.0), 0.04 * Math.sin(s * 0.013 + 2.0));
    camera.rotation.set(THREE.MathUtils.degToRad(0.75 * Math.sin(s * 0.023 + 2.0) + 0.3 * Math.sin(s * 0.061)),
                        THREE.MathUtils.degToRad(1.15 * Math.sin(s * 0.017) + 0.4 * Math.sin(s * 0.043 + 1.0)),
                        THREE.MathUtils.degToRad(0.25 * Math.sin(s * 0.029 + 0.5)), 'YXZ');
    life.update(dt, simT, { day, hour: h });
    drawCaustics(simT);
    renderer.render(scene, camera);
    frames++;
    if (now - fpsT > 1) { fpsEl.textContent = (frames / (now - fpsT)).toFixed(0) + ' fps'; frames = 0; fpsT = now; }
    if (!manual) requestAnimationFrame(() => frame());
  }
  if (manual) window.__step = (dt) => frame(dt); else requestAnimationFrame(() => frame());
  document.title = 'reef ready';
}
main().catch(e => { document.title = 'reef error'; console.error(e); fpsEl.style.display = 'block'; fpsEl.textContent = String(e); });

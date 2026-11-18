// The reef's life: fish, schools, sharks, rays, jellyfish, the anemone and its clownfish, the
// bottom dwellers. Every creature is a real 3D mesh (Tripo, from our own reference photos; see SOURCES.md) or
// procedural geometry; bodies bend with a travelling wave in the vertex shader, each animal at its own beat.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Jellies, Anemone, SandPuffs, contactShadow } from './extras.js';
import { Bottom } from './bottom.js';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const wrapAng = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (k, dt) => 1 - Math.exp(-k * dt);

// ---- the models' coordinates ----
// prep.mjs' meshopt step stores positions as normalised int16 in -1..1 with a 0.5 scale on the model's node, and
// instanced() takes the bare geometry, so that scale is lost: in the shader a body runs from x = +1 (snout) to -1
// (tail), not +-0.5, and every animal is DRAWN 2 x `len` long. The scene was tuned at those drawn sizes, so they
// stay; everything that needs the real size (clearance over the reef, giving way) uses BODY x len.
//   - `legacy` styles keep the first version's wave, which read the body as +-0.5: the wave is squeezed into the
//     middle half and the tail quarter swings as one piece. On the sharks that looks right, so it is kept for them; on short stiff fish it was the "janky" look.
const BODY = 2;
// ---- true size ----
// Drawn at 2 x len, every animal came out about twice its real length (a blacktip 3.4 m; real ones are 1.0-1.8 m).
// REAL is each animal's real adult length in metres as it is drawn (nose to tail tip; the eagle ray across its
// wings, the bottom critters across their legs or spines). ?size=true draws everything at REAL, ?size=today keeps the
// old sizes, and ?size=half (the default) draws every animal
// halfway between the two, so they keep their real sizes relative to each other. Avoidance always uses the size that
// is drawn.
const Q = new URLSearchParams(location.search);
export const SIZE = Q.get('size') || 'half';
export const REAL = {
  bluetang: 0.30, yellowtang: 0.20, angelfish: 0.38, butterflyfish: 0.22, parrotfish: 0.65, grouper: 0.40,
  clownfish: 0.10, puffer: 0.30, blacktip: 1.6, whitetip: 1.6, hammerhead: 2.6, eagleray: 2.0, turtle: 0.9,
  whaleshark: 9.0, chromis: 0.08, anthias: 0.12, haze: 0.12, trevally: 0.75, moray: 1.8, bluespotray: 0.6,
  redcrab: 0.18, hermitcrab: 0.12, starfish: 0.3, urchin: 0.35, shrimp: 0.08,
};
// the length an animal is drawn at, for a species `len` given at today's scale
export const sizeOf = (name, len) => (!REAL[name] || SIZE === 'today' ? len
  : SIZE === 'true' ? REAL[name] / BODY : (len + REAL[name] / BODY) / 2);
// ---- swimming styles: how the travelling wave runs down the body (s = 0 at the snout, 1 at the tail tip) ----
//   start: where the wave begins, head: share of the motion the head keeps, lambda: wave length in body lengths
const STYLE = {
  fish:  { start: 0.30, head: 0.05, lambda: 0.95, pow: 1.7 },   // tangs, angels, wrasse-like: stiff front, tail does it
  // tangs, angelfish, butterflyfish, clownfish, parrotfish: a stiff disc of a body, only the tail stalk and tail fin
  // beat; they row with their pectoral fins (FIN below). A whole-body wave on them looked like rubber.
  //: the wave now starts at the middle of the body, so the
  // back half flexes into each beat and the front stays steady, instead of a rigid body with a wagging tail
  stiff: { start: 0.36, head: 0.03, lambda: 0.95, pow: 1.6 },
  small: { start: 0.25, head: 0.07, lambda: 0.90, pow: 1.5 },   // chromis, anthias: quick, small
  shark: { start: 0.00, head: 0.10, lambda: 1.10, pow: 1.35, legacy: true },  // long slow wave along the whole body
  eel:   { start: 0.00, head: 0.08, lambda: 0.45, pow: 1.0, legacy: true },   // several waves along the body
  ray:   { start: 0.00, head: 0.00, lambda: 1.00, pow: 1.0, ray: true },   // wing beats (flapY)
  // flippers only, the shell stays rigid (the shell's edge is at |z| = 0.5 of the model's -1..1; until 16 Nov the
  // flap started inside the shell and moved the flippers up and down as stiff boards)
  turtle: { start: 0.00, head: 0.00, lambda: 1.00, pow: 1.0, ray: true, inner: 0.5 },
  // scalloped hammerhead: the shark's long wave, with the head sweeping from side to side on every beat
  // (its hammer scanning the water) instead of holding still
  hammer: { start: 0.00, head: 0.24, lambda: 1.15, pow: 1.2, legacy: true },
  // pufferfish: a stiff box of a body that hardly bends at all; it sculls with its fins (FIN, and the
  // dorsal and anal fins in the shader) and keeps its tail folded, using it only for a short burst
  puffer: { start: 0.70, head: 0.00, lambda: 1.00, pow: 2.0, puffer: true },
};

// ---- the cast. len = half the length the animal is drawn at (see BODY; today's sizes, ?size=true: REAL) ----
const SPECIES = {
  bluetang:      { len: 0.38, n: 6, style: 'stiff', speed: [0.16, 0.42], beat: [1.0, 1.7], amp: 0.075, zone: 'reef', act: [0.15, 1] },
  yellowtang:    { len: 0.28, n: 7, style: 'stiff', speed: [0.14, 0.38], beat: [1.2, 2.0], amp: 0.075, zone: 'reef', act: [0.1, 1] },
  angelfish:     { len: 0.46, n: 3, style: 'stiff', speed: [0.10, 0.28], beat: [0.7, 1.2], amp: 0.06, zone: 'reef', act: [0.1, 1] },
  butterflyfish: { len: 0.25, n: 5, style: 'stiff', speed: [0.12, 0.32], beat: [1.2, 1.9], amp: 0.07, zone: 'reef', act: [0.05, 1], picks: true },
  parrotfish:    { len: 0.70, n: 2, style: 'stiff', speed: [0.18, 0.45], beat: [0.7, 1.2], amp: 0.07, zone: 'reef', act: [0.0, 1], picks: true },
  grouper:       { len: 0.58, n: 1, style: 'fish', speed: [0.08, 0.30], beat: [0.6, 1.0], amp: 0.06, zone: 'low', act: [1, 0.7], cleaner: true },
  clownfish:     { len: 0.14, n: 2, style: 'stiff', speed: [0.04, 0.12], beat: [1.3, 1.8], amp: 0.05, zone: 'anemone', act: [1, 1], resident: true },
  blacktip:      { len: 1.70, n: 2, style: 'shark', speed: [0.55, 0.95], beat: [0.45, 0.65], amp: 0.085, zone: 'shark', act: [0.7, 1], shark: true },
  whitetip:      { len: 1.75, n: 1, style: 'shark', speed: [0.40, 0.80], beat: [0.40, 0.55], amp: 0.09, zone: 'shark', act: [1, 0.6], shark: true },
  // a spotted eagle ray now and then: slow wing beats, long glides through the blue
  eagleray:      { len: 1.10, n: 1, style: 'ray', speed: [0.45, 0.7], beat: [0.22, 0.32], amp: 0.11, zone: 'open', act: [0.3, 0.6], big: true, rare: 420 },
  // rare visitors: a hawksbill turtle drifting through about once an hour; far out in the blue, very rarely, a whale shark
  turtle:        { len: 0.95, n: 1, style: 'turtle', speed: [0.22, 0.35], beat: [0.25, 0.35], amp: 0.13, zone: 'open', act: [1, 1], big: true, rare: 3000 },
  whaleshark:    { len: 9.0, n: 1, style: 'shark', speed: [0.7, 0.9], beat: [0.12, 0.16], amp: 0.06, zone: 'far', act: [1, 0.5], big: true, rare: 6000, far: true },
  // a blackspotted puffer: slow, hovering round the
  // coral, sculling with its fins; now and then, above all when a shark comes close, it blows itself up into a ball
  // and slowly lets the water out again
  puffer:        { len: 0.30, n: 1, style: 'puffer', speed: [0.05, 0.16], beat: [0.5, 0.8], amp: 0.03, zone: 'reef', act: [0.5, 1], picks: true, puffer: true },
  // a scalloped hammerhead: a rare visitor along the reef's edge and over the
  // sand, turning and banking tighter than the reef sharks
  hammerhead:    { len: 1.95, n: 1, style: 'hammer', speed: [0.55, 0.85], beat: [0.5, 0.7], amp: 0.075, zone: 'edge', act: [1, 0.8], shark: true, hammer: true, rare: 2400 },
};
for (const [name, sp] of Object.entries(SPECIES)) sp.len = sizeOf(name, sp.len);
const SCHOOLS = {
  chromis: { len: 0.10, n: 46, style: 'small', speed: [0.25, 0.55], beat: [3.0, 4.2], amp: 0.06, near: true },
  anthias: { len: 0.13, n: 30, style: 'small', speed: [0.22, 0.5], beat: [2.6, 3.6], amp: 0.06, near: true },
  haze:    { model: 'chromis', len: 0.16, n: 90, style: 'small', speed: [0.35, 0.6], beat: [2.0, 3.0], amp: 0.05, far: true },
  // a big silver school of trevally that sweeps past through the blue every few minutes, turning together
  trevally: { len: 0.6, n: 34, style: 'fish', speed: [0.55, 0.9], beat: [1.3, 1.9], amp: 0.05, visitor: true, rare: 420 },
};
for (const [name, sp] of Object.entries(SCHOOLS)) sp.len = sizeOf(name, sp.len);

// colour corrections on a model's base colour texture (multipliers, linear)
// tall, stiff-bodied fish (tangs, angels, butterflyfish) hardly bend in a turn; long bodies do
// (they bend clearly into a turn now)
const STIFF = { yellowtang: 0.6, bluetang: 0.65, angelfish: 0.55, butterflyfish: 0.6, clownfish: 0.65, parrotfish: 0.75, grouper: 0.8 };
const P = new THREE.Vector3(), P2 = new THREE.Vector3();
// pectoral fins: the models have them as geometry sticking out from the flanks, so the vertex shader
// can row them: [sweep in rad, beats a second, phase between left and right (0 = together, 3.1 = alternating),
// rest angle folded back along the body (rad)]. The clownfish's are folded back: Tripo's model holds them
// straight out sideways, and seen from above, as it hovers over its anemone below the camera, the wide fins behind its
// head made it read as a "little hammerhead".
const FIN = {
  clownfish: [0.45, 2.4, 2.6, 0.75], yellowtang: [0.50, 1.9, 0.4], bluetang: [0.50, 1.7, 0.4], angelfish: [0.40, 1.2, 0.4],
  butterflyfish: [0.50, 2.1, 0.6], parrotfish: [0.60, 1.4, 0.2], grouper: [0.30, 0.7, 0.9], chromis: [0.45, 2.8, 1.0], anthias: [0.45, 2.8, 1.0],
  // a puffer sculls fast with its little pectorals, left and right in turn
  puffer: [0.55, 3.0, 3.1, 0.2],
};
// the moray: Tripo's
// texture is a pale blue-grey; a real green or spotted moray is a rich dark olive, so it is tinted that way, its
// markings get more contrast in the shader (EEL_COLOUR) and it keeps less of the pale water sheen (rim, environment)
const TINT = { yellowtang: [1.0, 0.82, 0.32], moray: [0.62, 0.70, 0.30] };
const EEL_COLOUR = `{
  float l = dot(outgoingLight, vec3(0.299, 0.587, 0.114));
  vec3 c = max(vec3(0.0), vec3(l) + (outgoingLight - vec3(l)) * 1.5);   // richer colour
  outgoingLight = c * (0.55 + 0.9 * smoothstep(0.0, 0.35, l));          // darker darks, the spots stand out
}`;

// ---------------------------------------------------------------------------------------------------------------
const WAVE_HEAD = /* glsl */`
  attribute vec4 aSwim;            // phase (rad), amplitude (body lengths), bend (tail offset), pectoral fin phase
  uniform vec4 uStyle;             // start, head share, wave length, power
  uniform float uRay;              // 1 = rays: the wings flap (y), the body barely bends
  uniform float uInner;            // flapping starts this far out from the midline (turtle: past the shell)
  uniform vec4 uFin;               // pectoral fins: flank half-width, fin tip, sweep (rad), left/right phase
  uniform float uFinRest;          // pectoral fins folded back this far at rest (rad)
  uniform float uLegacy;           // 1 = the first version's reading of the body (see BODY above)
  uniform float uSpan;             // rays: where the wing tip is
  uniform float uHide;             // moray: past this share of its length (from the snout) the body is drawn away
  // the pufferfish: its body outline along its length (centre height, half height, half width per
  // twelfth), how blown up it is (0..1) and the ball it becomes (centre x, centre y, radius)
  uniform float uPufferOn, uPuff, uDA;
  uniform vec3 uBall;
  uniform vec4 uProf[12];
  varying float vHole;             // moray: how far past the mouth of its hole this point is (shade of the crevice)
  float bodyS(float x) { return uLegacy > 0.5 ? clamp(0.5 - x, 0.0, 1.0) : clamp((1.0 - x) * 0.5, 0.0, 1.0); }
  float swimEnv(float s) { return uStyle.y + (1.0 - uStyle.y) * pow(smoothstep(uStyle.x, 1.0, s), uStyle.w); }
  float swimZ(float s) {
    return aSwim.y * swimEnv(s) * sin(aSwim.x - s * 6.28318 / uStyle.z) + aSwim.z * s * s;
  }
  // wing beat: the tips move most, the wave runs from the front edge back and out to the tips
  float flapY(vec3 p) {
    float w = clamp((abs(p.z) - uInner) / (uSpan - uInner), 0.0, 1.0);
    return aSwim.y * pow(w, 1.7) * sin(aSwim.x - w * 1.6 - (0.5 - p.x) * 1.2);
  }
  // the puffer's outline where this point is: (centre y, half height, half width)
  vec3 profAt(float s) {
    float f = clamp(s * 11.0, 0.0, 11.0);
    int i = int(floor(f));
    return mix(uProf[i].xyz, uProf[min(i + 1, 11)].xyz, fract(f));
  }
  // where a point of the puffer's body is outline-wise: (y, z) scaled so its outline is the unit circle
  vec2 profQ(vec3 p, vec3 pr) { return vec2((p.y - pr.x) / max(pr.y, 1e-3), p.z / max(pr.z, 1e-3)); }
  // blown up: the body (snout to tail stalk) becomes a ball; the fins stand out from it as they did from the body
  // and the tail is carried along behind it
  vec3 puffPos(vec3 p) {
    float s = clamp((1.0 - p.x) * 0.5, 0.0, 1.0);
    vec3 pr = profAt(s);
    float body = 1.0 - smoothstep(0.62, 0.80, s);
    float x2 = p.x, dx = x2 - uBall.x;
    // round in every direction, but never thinner than the fish itself (the snout and the tail stalk keep their shape)
    float rt = max(sqrt(max(uBall.z * uBall.z - dx * dx, 0.0)), max(pr.y, pr.z));
    vec2 q = profQ(p, pr);
    float e = length(q);
    vec2 dir = e > 1e-4 ? q / e : vec2(1.0, 0.0);
    vec2 yz = e <= 1.05 ? q * rt : dir * rt + vec2(p.y - pr.x, p.z) - dir * pr.yz;
    vec3 ball = vec3(x2, uBall.y + yz.x, yz.y);
    vec3 tail = vec3(x2, p.y, p.z);
    return mix(p, mix(tail, ball, body), uPuff);
  }
`;
const WAVE_BODY = /* glsl */`
  if (uRay > 0.5) {
    transformed.y += flapY(position);
    transformed.z += aSwim.z * pow(clamp(0.5 - position.x, 0.0, 1.0), 2.0);
  } else {
    float s = bodyS(position.x);
    float r = 0.0;
    if (uPufferOn > 0.5) {
      float st = clamp((1.0 - position.x) * 0.5, 0.0, 1.0);
      vec2 q = profQ(position, profAt(st));
      // the pectorals: whatever stands out sideways behind the gill; the dorsal and anal fins: whatever stands out
      // up or down over the back half. They scull from side to side; the body itself barely bends.
      r = clamp((abs(q.y) - 1.12) * 2.5, 0.0, 1.0) * smoothstep(0.14, 0.22, st) * (1.0 - smoothstep(0.5, 0.6, st));
      float da = clamp((abs(q.x) - 1.1) * 2.5, 0.0, 1.0) * smoothstep(0.42, 0.5, st) * (1.0 - smoothstep(0.78, 0.86, st));
      vec3 pr = profAt(st);
      transformed = puffPos(position);
      transformed.z += da * (abs(position.y - pr.x) - pr.y) * uDA * sin(aSwim.w * 0.9 + st * 4.0);
    }
    transformed.z += swimZ(s);
    if (uFin.z > 0.0) {
      // whatever sticks out sideways past the flank, behind the gill, is pectoral fin: hinge it at its root
      float l = 0.0, sd = sign(position.z);
      if (uPufferOn < 0.5) {
        r = clamp((abs(position.z) - uFin.x) / (uFin.y - uFin.x), 0.0, 1.0) * smoothstep(0.16, 0.24, s) * (1.0 - smoothstep(0.64, 0.74, s));
        l = r * (uFin.y - uFin.x);
      } else l = r * 0.25;
      if (r > 0.0) {
        float th = uFin.z * sin(aSwim.w + sd * uFin.w);
        if (uFinRest > 0.0) {
          // folded back along the body, rowing round that: a real rotation about the fin's root
          float a = uFinRest + th;
          transformed.x -= l * sin(a);
          transformed.z -= sd * l * (1.0 - cos(a));
        } else {
          transformed.x -= l * th;
          transformed.z -= sd * l * (1.0 - cos(th)) * 1.5;
        }
        transformed.y += l * r * 0.4 * uFin.z * sin(aSwim.w + sd * uFin.w - 1.3);
      }
    }
    vHole = 0.0;
    if (uHide < 1.5) {
      // the moray's body behind its neck stays in its hole: drawn away to nothing just past what is out
      float st = clamp((1.0 - position.x) * 0.5, 0.0, 1.0);
      vHole = st - (uHide - 0.04);
      float k = 1.0 - smoothstep(uHide, uHide + 0.05, st);
      transformed.yz *= k;
      transformed.x -= (1.0 - k) * 0.05;
    }
  }
`;
const WAVE_NORMAL = /* glsl */`
  if (uRay > 0.5) {
    float e = 0.01;
    float dydz = (flapY(position + vec3(0.0, 0.0, e)) - flapY(position - vec3(0.0, 0.0, e))) / (2.0 * e);
    objectNormal.z -= dydz * objectNormal.y;
  } else {
    float s = bodyS(position.x);
    float dzds = (swimZ(min(s + 0.01, 1.0)) - swimZ(max(s - 0.01, 0.0))) / 0.02;
    objectNormal.x += dzds * objectNormal.z * (uLegacy > 0.5 ? 1.0 : 0.5);   // dz/dx = -dz/ds
    if (uPufferOn > 0.5 && uPuff > 0.001) {
      // a blown-up puffer is lit as the ball it has become
      float st = clamp((1.0 - position.x) * 0.5, 0.0, 1.0);
      float onBody = (1.0 - smoothstep(0.62, 0.80, st)) * step(length(profQ(position, profAt(st))), 1.05);
      vec3 bp = puffPos(position);
      objectNormal = normalize(mix(objectNormal, normalize(bp - vec3(uBall.x, uBall.y, 0.0)), uPuff * onBody));
    }
  }
`;

class Swimmer {
  constructor(life, sp, name, k) {
    this.life = life; this.sp = sp; this.name = name; this.k = k;
    this.pos = new THREE.Vector3(); this.yaw = 0; this.pitch = 0; this.roll = 0; this.yawRate = 0;
    this.speed = rand(...sp.speed); this.cruise = this.speed;
    this.phase = rand(0, TAU);
    this.beat = rand(...sp.beat);              // its own tail rhythm
    this.amp = sp.amp * rand(0.85, 1.15);
    this.bend = 0; this.glide = 0; this.glideT = rand(4, 14);
    this.fin = rand(0, TAU); this.finBeat = (FIN[name.replace('-lead', '')]?.[1] || 0) * rand(0.85, 1.15);
    this.visible = false; this.wait = sp.rare ? rand(0.15, 1.0) * sp.rare : rand(0, 25);
    if (life.visit.has(name.replace('-lead', ''))) this.wait = life.visitAt + k * 3;
    this.state = 'away'; this.target = new THREE.Vector3(); this.legs = 0; this.hold = 0;
    this.push = new THREE.Vector3(); this.pushS = new THREE.Vector3(); this.blocked = 0; this.side = 0; this.sideT = 0; this.avoid = 0;
    // how far its belly, fins or wing tips reach below its midline
    const body = sp.len * BODY;
    this.need = sp.shark ? body * 0.14 + 0.06 : sp.style === 'ray' || sp.style === 'turtle' ? body * 0.12 + 0.06 : body * 0.27 + 0.03;
    this.need0 = this.need;
    if (sp.puffer) { this.puffK = 0; this.puffHold = 0; this.puffCool = rand(240, 720); }
  }
  spawn() {
    const L = this.life;
    if (this.sp.resident) {
      this.pos.copy(L.anemoneSpot());
      this.yaw = rand(0, TAU); this.pitch = 0; this.roll = 0; this.yawRate = 0;
      this.target.copy(L.anemoneSpot()); this.legs = Infinity; this.state = 'swim'; this.visible = true;
      return;
    }
    const from = L.exitPoint(this.sp);
    this.pos.copy(from); this.blocked = 0; this.side = 0; this.avoid = 0; this.pushS.set(0, 0, 0);
    const first = L.wayPoint(this.sp, this);
    const d = first.clone().sub(from);
    this.yaw = Math.atan2(-d.z, d.x); this.pitch = 0; this.roll = 0; this.yawRate = 0;
    this.target.copy(first); this.legs = Math.floor(rand(3, 8)); this.state = 'swim'; this.visible = true;
  }
  update(dt, t, env) {
    const L = this.life, sp = this.sp;
    if (!this.visible) {
      this.wait -= dt;
      const want = THREE.MathUtils.lerp(sp.act[0], sp.act[1], env.day);   // how active it is at this time of day
      if (this.wait <= 0) {
        if (Math.random() < want) this.spawn(); else this.wait = rand(20, 60);
      }
      return;
    }
    // the hunt: a quick lunge at a lone small fish out in the open; it eats it whole or gives up
    if (this.state === 'hunt') {
      const prey = this.prey;
      this.huntT += dt;
      // it stalks for a few seconds, then one burst; if that misses it gives up (no long chases)
      if (prey && this.lunge === undefined) {
        // strike only when lined up on it: close, nose on, about level, nothing of the reef in the way
        const f = this.forward(), half = sp.len * this.lenK();
        P.copy(prey.pos).sub(this.pos);
        const ahead = P.dot(f), off = P.addScaledVector(f, -ahead).length();   // how far its line passes from the fish
        // and side-on to us, near enough to read on the small screen (head-on or tail-on it is just a grey blob)
        const side = Math.abs(P2.copy(this.pos).normalize().dot(f)) < 0.8 && this.pos.length() < 9.5;
        // and in front of the coral in the picture, not hidden behind it
        const seen = (x) => { const q = L.reef.project(x); return q && q.u > 0.05 && q.u < 0.95 && q.v > 0.05 && q.v < 0.95 && q.z < L.reef.surfaceDepth(q.u, q.v) - 0.3; };
        if (ahead > half * 0.6 && ahead < half + 2.2 && off < 0.5 && side && this.avoid <= 0 && seen(prey.pos) && seen(this.pos)) this.lunge = 0;
      }
      if (this.lunge !== undefined) this.lunge += dt;
      const lost = !prey || !prey.visible || this.huntT > 14 || this.lunge > 2.2 || prey.pos.y < L.reef.height(prey.pos) + 0.3;
      if (lost) this.endHunt(false);
      else {
        // aim a little ahead of where it is going
        this.target.copy(prey.pos).addScaledVector(prey.forward(), prey.speed * 0.35);
        // the jaws: the front quarter of the body as drawn (drawn half-length = len)
        const half = sp.len * this.lenK(), f = this.forward();
        const k = THREE.MathUtils.clamp(P.copy(prey.pos).sub(this.pos).dot(f), half * 0.5, half);
        P.copy(this.pos).addScaledVector(f, k);
        if (this.lunge !== undefined && P.distanceTo(prey.pos) < 0.25 + prey.sp.len * 0.6) {
          prey.visible = false; prey.wait = rand(40, 120); prey.state = 'away'; prey.hunted = null;
          L.scare(prey.pos); L.stats.hunts.caught++;
          this.endHunt(true);
        }
      }
    }
    const to = this.target.clone().sub(this.pos);
    const dist = to.length();
    // a small fish heading off into the blue is gone once it is only a speck in the haze
    if (this.state === 'exit' && !sp.far && this.pos.length() > 17 && sp.len / this.pos.length() * 470 < 9) {
      this.visible = false; this.wait = sp.rare ? rand(0.6, 1.4) * sp.rare : rand(3, 16); return;
    }
    if (this.state === 'hold') {
      this.hold -= dt;
      if (this.hold <= 0) { this.state = 'swim'; this.nextTarget(); }
    } else if (this.state === 'hide') {
      // nestled in the tentacles until the shark has gone
    } else if (this.state !== 'hunt' && dist < (sp.resident ? 0.05 : Math.max(0.25, sp.len * 1.2))) {
      if (this.state === 'exit') { this.visible = false; this.wait = sp.rare ? rand(0.6, 1.4) * sp.rare : rand(3, 16); return; }
      if (this.pickHere && Math.random() < 0.8) { this.state = 'hold'; this.hold = rand(3, 9); this.pickHere = false; }
      else this.nextTarget();
    }
    let dYaw = Math.atan2(-to.z, to.x), dPitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
    if (this.state === 'hold') { dYaw = this.holdYaw; dPitch = -0.15; }
    const hunting = this.state === 'hunt';
    const pitchMax = sp.shark ? (hunting ? 0.5 : 0.25) : 0.45;
    dPitch = THREE.MathUtils.clamp(dPitch, -pitchMax, pitchMax);
    // other animals close by: give way sideways and a little up or down (the smaller one gives way more)
    this.pushS.lerp(this.push, damp(4, dt));
    // (a hunting shark holds its line: the others give way to it)
    if (this.pushS.lengthSq() > 1e-5 && this.state !== 'hide' && this.state !== 'hold' && this.state !== 'hunt') {
      const m = Math.min(1, this.pushS.length() * 3);
      const lat = -this.pushS.x * Math.sin(this.yaw) - this.pushS.z * Math.cos(this.yaw);   // + = room on its left
      const turn = THREE.MathUtils.clamp(lat * 5 + (this.k % 2 ? 0.25 : -0.25) * m, -1, 1);
      dYaw = this.yaw + wrapAng(dYaw - this.yaw) * (1 - 0.7 * m) + turn * 0.8 * m;
      dPitch = THREE.MathUtils.clamp(dPitch + THREE.MathUtils.clamp(this.pushS.y * 3 + (this.k % 2 ? 0.12 : -0.12) * m, -0.35, 0.35), -pitchMax, pitchMax);
    }
    // the reef ahead: look as far as this animal needs to turn or climb, start early and gently.
    // Low coral: rise over it. Too tall to climb comfortably: bank towards the lower side and climb as well.
    const fwd = this.forward();
    let slow = 1;
    if (!sp.resident && this.state !== 'hold') {
      // (a hunting shark looks only as far as its strike: it drops to the fish's level over open sand)
      const reach = sp.len * BODY * 0.8 + this.speed * (this.state === 'hunt' ? 2.5 : sp.shark || sp.big ? 7 : 2.4);
      const ahead = this.climbNeed(this.yaw, reach);
      const thr = pitchMax * (sp.shark ? 0.85 : 0.7);
      // once it has begun to go round something it keeps that line for a moment after the way looks clear, so it
      // doesn't weave between its target and the detour
      if (ahead > thr) {
        if (this.avoid <= 0 || !this.side || (!this.sideOpen && (this.sideT -= dt) <= 0)) {
          const l = this.climbNeed(this.yaw + 0.7, reach), r = this.climbNeed(this.yaw - 0.7, reach);
          // keep to the side the target lies on unless the other is clearly lower
          const pref = wrapAng(dYaw - this.yaw) >= 0 ? 1 : -1;
          this.side = Math.abs(l - r) < 0.08 ? pref : l < r ? 1 : -1; this.sideT = 1.5;
          this.sideOpen = Math.min(l, r) < ahead - 0.03;
        }
        this.avoid = sp.shark || sp.big ? 2.5 : 1.0;
        this.blocked += dt;
        // the way to this target is walled off: choose another
        if (this.blocked > (sp.shark ? 9 : 5) && this.state === 'swim') { this.blocked = 0; this.target.copy(L.wayPoint(sp, this)); }
      } else {
        this.avoid -= dt;
        this.blocked = Math.max(0, this.blocked - dt * 0.5);
      }
      if (this.avoid > 0) {
        // the harder the reef rises ahead, the firmer the turn; never a swerve
        const k = THREE.MathUtils.clamp((ahead - thr * 0.5) / thr, 0, 1);
        if (this.sideOpen) dYaw = this.yaw + this.side * k * (sp.shark ? 1.0 : 0.9);
        if (ahead > pitchMax) slow = THREE.MathUtils.clamp(1 - (ahead - pitchMax) * 1.2, 0.45, 1);
      }
      dPitch = Math.max(dPitch, Math.min(pitchMax, ahead + 0.04));
    }
    const floorY = L.reef.floorY(this.pos.x, this.pos.z);
    // never into the lens: big animals keep a few metres off, small fish may come up close
    const keep = this.state === 'hunt' ? 2.6 : sp.shark || sp.big ? 3.6 : sp.visitor ? 3.2 : 1.1;
    const camD = this.pos.length();
    if (camD < keep + sp.len) {
      const away = Math.atan2(-this.pos.z, this.pos.x);
      const w = THREE.MathUtils.clamp((keep + sp.len - camD) / sp.len, 0, 1);
      dYaw = this.yaw + wrapAng(away - this.yaw) * w + wrapAng(dYaw - this.yaw) * (1 - w);
    }
    // sharks nearby: small fish dart off; clownfish dive into their anemone and stay there a while
    // (the fish a shark is stalking notices it only at the last moment, when the shark lunges)
    const near = this.hunted ? this.hunted.pos.distanceToSquared(this.pos) < 1.0 : L.nearShark(this.pos, sp.resident || sp.puffer ? 3.5 : 2.4);
    // a pufferfish doesn't dart off: it blows itself up
    if (sp.puffer) this.puffUpdate(dt, L.nearShark(this.pos, 2.2) || !!L.scared(this.pos));
    else if (!sp.shark && (near || L.scared(this.pos))) {
      if (sp.resident) {
        if (this.state !== 'hide') { this.state = 'hide'; this.target.copy(L.anemoneSpot(true)); this.speed = sp.speed[1] * 2.5; }
      } else {
        this.speed = Math.min(this.speed + dt * 1.2, sp.speed[1] * 2.2);
        if (this.state === 'hold') { this.state = 'swim'; this.nextTarget(); }
        // the one being chased, and everyone near a catch, darts off away from it
        const from = this.hunted ? this.hunted.pos : L.scared(this.pos);
        if (from && this.state === 'swim' && (this.fleeT = (this.fleeT || 0) - dt) <= 0) {
          P2.copy(this.pos).sub(from); P2.y = Math.max(P2.y, 0) * 0.5; P2.normalize();
          P.copy(this.pos).addScaledVector(P2, rand(1.8, 3));
          if (!L.reef.solid(P, this.need) && P.length() > 1.5) this.target.copy(P);
          this.fleeT = 0.8;
        }
      }
    } else if (this.state === 'hide') { this.state = 'swim'; this.nextTarget(); }
    // rays and turtles wheel round slowly, like the sharks
    // a hunting shark turns hard and fast for those few seconds
    // (in the strike it whips its head round onto the fish)
    // (the hammerhead turns tighter and quicker than the reef sharks; its hammer works like a wing)
    const maxTurn = hunting ? (this.lunge !== undefined ? 2.6 : 1.1) : sp.hammer ? 0.65 : sp.shark ? 0.35 : sp.big ? 0.5 : 1.6, turnK = hunting ? (this.lunge !== undefined ? 3.5 : 1.8) : sp.hammer ? 1.0 : sp.shark ? 0.6 : sp.big ? 0.8 : sp.resident ? 2.0 : 2.2;
    const err = wrapAng(dYaw - this.yaw);
    const want = THREE.MathUtils.clamp(err * turnK, -maxTurn, maxTurn);
    this.yawRate += (want - this.yawRate) * damp(hunting ? (this.lunge !== undefined ? 5 : 2.5) : sp.hammer ? 1.4 : sp.shark ? 0.8 : sp.big ? 1.2 : 3.0, dt);
    this.yaw += this.yawRate * dt;
    this.pitch += (dPitch - this.pitch) * damp(hunting ? (this.lunge !== undefined ? 3.5 : 2.5) : sp.shark ? 0.6 : 1.8, dt);
    this.roll += (-this.yawRate * (sp.hammer ? 0.65 : sp.shark ? 0.45 : 0.18) - this.roll) * damp(2, dt);
    // speed: cruise, slow down in turns and when arriving to hold, coast now and then
    let target = this.cruise * (1 - Math.min(0.5, Math.abs(this.yawRate) * 0.25)) * slow;
    // closing in, then the burst: a few powerful beats
    if (hunting) target = (this.lunge !== undefined ? 2.8 : dist < 3.5 ? 1.0 : 1.4) * slow;   // eases in while it lines up
    if (this.state === 'hold') target = 0.03;
    if (sp.resident) target *= THREE.MathUtils.clamp(dist / 0.25, 0.15, 1);
    if (sp.puffer) target *= 1 - 0.9 * this.puffK;
    this.speed += (target - this.speed) * damp(hunting ? 2.2 : 0.8, dt);
    this.glideT -= dt;
    if (this.glideT < 0) { this.glide = this.glide > 0 ? 0 : 1; this.glideT = this.glide ? rand(1.2, 2.8) : rand(5, 16); }
    const pos = this.pos.addScaledVector(fwd, this.speed * dt);
    pos.y = Math.max(pos.y, floorY + sp.len * 0.25);
    // last resort, counted in tests (should stay near zero): no part of the body sinks into the reef. It eases in and
    // out as a gentle rise, starting a moment early from where the body is heading
    if (!sp.resident) {
      let lift = 0;
      const half = sp.len * this.lenK() * BODY * 0.5;
      for (const k of [1, 0, -1]) for (const ahead of [0, this.speed * 0.5]) {
        P.copy(pos).addScaledVector(fwd, k * half + ahead);
        lift = Math.max(lift, L.reef.height(P) + this.need * 0.6 - P.y);
      }
      const rate = 0.12 + sp.len * 0.25, want = lift > 0 ? Math.min(lift * 2.5, rate) : 0;
      this.liftV = (this.liftV || 0) + (want - (this.liftV || 0)) * damp(want > (this.liftV || 0) ? 5 : 2.5, dt);
      if (this.liftV > 1e-3) pos.y += this.liftV * dt;
      if (lift > 0) { L.stats.lift++; L.stats.by[this.name] = (L.stats.by[this.name] || 0) + 1; }
    }
    // tail: faster with speed, its own rhythm; gliding = the beat fades and the body straightens
    const rel = THREE.MathUtils.clamp(this.speed / sp.speed[1], 0.15, 2.2);
    this.phase += dt * TAU * this.beat * (0.45 + 0.55 * rel) * (this.glide ? 0.35 : 1);
    const ampNow = this.amp * (0.55 + 0.45 * Math.min(rel, 1.6)) * (this.glide ? 0.35 : 1) * (this.state === 'hold' ? 0.4 : 1) * (sp.puffer ? 1 - this.puffK : 1);
    this.ampS = (this.ampS ?? ampNow) + (ampNow - (this.ampS ?? ampNow)) * damp(2, dt);
    // pectoral fins: they row all the time, harder when hovering in place
    this.fin += dt * TAU * this.finBeat * (this.state === 'hold' || this.speed < sp.speed[0] ? 1.2 : 0.85) * (sp.puffer ? 1 + 0.4 * this.puffK : 1);
    this.bend += (THREE.MathUtils.clamp(-this.yawRate * 0.10, -0.12, 0.12) * (STIFF[this.name] ?? 1) - this.bend) * damp(3, dt);
  }
  // the pufferfish: a shark close by (or a catch next to it) makes it gulp water and blow up into a ball
  // in about two seconds; it hangs there, fins sculling, until the danger has passed, then slowly lets the water out
  // (about ten seconds). Now and then it does it with no shark about. ?puff=S: every S seconds (tests).
  puffUpdate(dt, threat) {
    const L = this.life;
    this.puffCool -= dt; this.scareCool = (this.scareCool || 0) - dt;
    if (this.puffHold > 0) {
      this.puffHold -= dt;
      if (threat) this.puffHold = Math.max(this.puffHold, 4);
    } else if ((threat && this.puffK < 0.4 && this.scareCool <= 0) || this.puffCool <= 0) {
      this.puffHold = threat ? rand(8, 14) : rand(7, 12);
      this.puffCool = L.puffEvery || rand(900, 2400);
      this.scareCool = L.puffEvery || rand(480, 900);   // it doesn't blow up at every shark that passes
      if (this.state === 'hold') { this.state = 'swim'; this.nextTarget(); }
      L.stats.puffs++;
    }
    if (this.puffHold > 0) this.puffK += (1 - this.puffK) * damp(1.6, dt);
    else this.puffK = Math.max(0, this.puffK - dt / 10);
    this.need = this.need0 * (1 + 1.2 * this.puffK);
  }
  nextTarget() {
    const L = this.life;
    if (this.sp.resident) {
      this.target.copy(L.anemoneSpot());
      if (Math.random() < 0.6) { this.state = 'hold'; this.hold = rand(1.5, 5); this.holdYaw = this.yaw + rand(-1.0, 1.0); }
      return;
    }
    if (--this.legs <= 0) { this.state = 'exit'; this.target.copy(L.exitPoint(this.sp)); return; }
    // the grouper calls at the cleaner shrimp's station now and then and hangs there to be cleaned
    if (this.sp.cleaner && L.cleaner && Math.random() < 0.35) {
      this.target.copy(L.cleaner); this.pickHere = true;
      const to = L.cleaner.clone().sub(this.pos); this.holdYaw = Math.atan2(-to.z, to.x);
      return;
    }
    // now and then a fish goes to pick at the coral just in front of the moray's hole (where it may get taken)
    const mo = L.moray;
    if (this.sp.picks && !this.sp.puffer && mo && this.sp.len * BODY <= mo.len * BODY * 0.3 && Math.random() < 0.06) {
      P.set(Math.cos(mo.yaw0), 0, -Math.sin(mo.yaw0)).multiplyScalar(rand(0.35, 0.6)).add(mo.at);
      P.y += rand(-0.05, 0.2);
      if (!L.reef.solid(P, this.need * 0.6)) { this.target.copy(P); this.holdYaw = mo.yaw0 + Math.PI + rand(-0.6, 0.6); this.pickHere = true; return; }
    }
    if (this.sp.picks && Math.random() < 0.45) {
      const p = L.reefSpot(0.06 + this.sp.len * BODY * 0.5);
      if (p) { this.target.copy(p.pos); this.holdYaw = p.yaw; this.pickHere = true; return; }
    }
    this.target.copy(L.wayPoint(this.sp, this));
  }
  // the steepest climb (rad) needed to clear the reef within `reach` metres along a heading
  climbNeed(yaw, reach) {
    const R = this.life.reef, c = Math.cos(yaw), s = -Math.sin(yaw);
    const n = Math.min(12, Math.max(4, Math.ceil(reach / 0.3)));
    let worst = -1.5;
    for (let k = 1; k <= n; k++) {
      const d = reach * k / n;
      P.set(this.pos.x + c * d, 0, this.pos.z + s * d);
      const a = Math.atan2(R.height(P) + this.need - this.pos.y, d);
      if (a > worst) worst = a;
    }
    return worst;
  }
  endHunt(caught) {
    const L = this.life;
    if (this.prey) this.prey.hunted = null;
    if (!caught) { L.stats.hunts.missed++; L.huntT = Math.min(L.huntT, L.huntEvery || rand(40, 90)); }   // it tries again before long
    this.prey = null; this.lunge = undefined; this.state = 'swim'; this.blocked = 0;
    this.target.copy(L.wayPoint(this.sp, this));
  }
  forward() {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(Math.cos(this.yaw) * cp, Math.sin(this.pitch), -Math.sin(this.yaw) * cp);
  }
}

// ---------------------------------------------------------------------------------------------------------------
class School {
  constructor(life, sp, name) {
    this.life = life; this.sp = sp; this.name = name;
    this.lead = new Swimmer(life, { ...sp, act: [0.4, 1], zone: sp.far ? 'far' : sp.visitor ? 'open' : 'school' }, name + '-lead', 0);
    if (!sp.visitor) this.lead.legs = 99;
    this.hidden = !!sp.visitor;
    this.m = [];
    for (let k = 0; k < sp.n; k++) this.m.push({
      p: new THREE.Vector3(), v: new THREE.Vector3(), phase: rand(0, TAU), beat: rand(...sp.beat),
      amp: sp.amp * rand(0.8, 1.2), fin: rand(0, TAU), finBeat: (FIN[sp.model || name]?.[1] || 0) * rand(0.85, 1.15), yaw: 0, pitch: 0, roll: 0, bend: 0, off: new THREE.Vector3(rand(-1, 1), rand(-0.5, 0.5), rand(-1, 1)),
    });
    this.placed = false;
  }
  update(dt, t, env) {
    const L = this.life, sp = this.sp, lead = this.lead;
    if (sp.visitor) {
      // a school that sweeps through now and then: it exists only while its leader is on its way across
      lead.update(dt, t, env);
      if (!lead.visible) { this.hidden = true; return; }
      if (this.hidden) {
        for (const f of this.m) { f.p.copy(lead.pos).addScaledVector(f.off, sp.len * 5); f.v.copy(lead.forward()).multiplyScalar(lead.speed); }
        this.hidden = false;
      }
    } else {
      if (!this.placed) {
        lead.spawn(); lead.legs = 99;
        if (!sp.far) { lead.pos.copy(L.wayPoint({ ...sp, zone: 'school' }, lead)); }
        for (const f of this.m) { f.p.copy(lead.pos).addScaledVector(f.off, sp.len * 6); f.v.set(rand(-0.1, 0.1), 0, rand(-0.1, 0.1)); }
        this.placed = true;
      }
      lead.state = lead.state === 'exit' ? 'swim' : lead.state;
      lead.legs = 99;   // a resident school never leaves the reef
      lead.update(dt, t, env);
      if (!lead.visible) lead.spawn();
    }
    const night = 1 - env.day;
    const danger = !sp.far && (L.nearShark(lead.pos, 3.5) || !!L.scared(lead.pos));
    const spread = sp.len * (danger ? 2.2 : 4.5 + night * -1.5);
    const sepR = sp.len * (danger ? 1.1 : 1.6);
    const maxV = sp.speed[1] * (danger ? 2.4 : 1.0);
    const acc = new THREE.Vector3(), tmp = new THREE.Vector3();
    const n = this.m.length;
    for (let i = 0; i < n; i++) {
      const f = this.m[i];
      acc.set(0, 0, 0);
      // follow the leader to a spot in the school (cohesion), match its heading (alignment)
      tmp.copy(lead.pos).addScaledVector(f.off, spread).sub(f.p);
      acc.addScaledVector(tmp, 0.6);
      acc.addScaledVector(lead.forward(), lead.speed * 0.8);
      // separation (the far haze school is only specks: it skips the pairwise work)
      if (!sp.far) for (let j = 0; j < n; j++) {
        if (i === j) continue;
        tmp.copy(f.p).sub(this.m[j].p);
        const d2 = tmp.lengthSq();
        if (d2 < sepR * sepR && d2 > 1e-8) acc.addScaledVector(tmp, (sepR * sepR - d2) / (sepR * sepR) * 2.5 / Math.sqrt(d2) * sp.len);
      }
      // sharks: flee
      for (const s of L.sharks) {
        if (!s.visible) continue;
        tmp.copy(f.p).sub(s.pos); const d = tmp.length();
        if (d < 2.0) acc.addScaledVector(tmp, (2.0 - d) * 2.0 / Math.max(d, 0.1));
      }
      // a catch close by: the school bursts away from it
      if (!sp.far) for (const sc of L.scares) {
        tmp.copy(f.p).sub(sc.p); const d = tmp.length();
        if (d < 3.5) acc.addScaledVector(tmp, (3.5 - d) * 1.5 / Math.max(d, 0.1));
      }
      // other, bigger animals: make room (a school parts round a parrotfish or a ray)
      for (const w of L.swimmers) {
        if (!w.visible || w.sp.shark || w.sp.len < sp.len * 1.5) continue;
        tmp.copy(f.p).sub(w.pos); const d = tmp.length(), r = w.sp.len * BODY * 0.45 + sp.len * BODY;
        if (d < r) acc.addScaledVector(tmp, (r - d) / r * 3.0 / Math.max(d, 0.05));
      }
      // the reef: rise over what is just ahead, lean towards the lower side
      const need = sp.len * BODY * 0.3 + 0.03;
      tmp.copy(f.p).addScaledVector(f.v, 0.7);
      const hNow = L.reef.height(f.p), hAhead = L.reef.height(tmp);
      let short = Math.max(hAhead + need - tmp.y, hNow + need - f.p.y);
      if (sp.len > 0.3) { P.copy(f.p).addScaledVector(f.v, 1.8); short = Math.max(short, L.reef.height(P) + need - P.y); }   // big fast fish look further
      if (short > -need) {
        acc.y += 2.0 + Math.max(0, short) * 8;
        const vl = Math.hypot(f.v.x, f.v.z) || 1, lx = -f.v.z / vl, lz = f.v.x / vl, w = 0.25 + sp.len;
        P.set(tmp.x + lx * w, 0, tmp.z + lz * w); P2.set(tmp.x - lx * w, 0, tmp.z - lz * w);
        const g = L.reef.height(P2) - L.reef.height(P);   // + = lower on the side of (lx, lz)
        acc.x += lx * THREE.MathUtils.clamp(g * 3, -1.5, 1.5); acc.z += lz * THREE.MathUtils.clamp(g * 3, -1.5, 1.5);
      }
      f.v.addScaledVector(acc, dt);
      const sp2 = f.v.length();
      if (sp2 > maxV) f.v.multiplyScalar(maxV / sp2);
      if (sp2 < sp.speed[0] * 0.5) f.v.multiplyScalar((sp.speed[0] * 0.5) / Math.max(sp2, 1e-4));
      f.p.addScaledVector(f.v, dt);
      const fy = L.reef.floorY(f.p.x, f.p.z) + sp.len;
      if (f.p.y < fy) f.p.y = fy;
      const lift = L.reef.height(f.p) + need * 0.6 - f.p.y;
      if (lift > 0) { f.p.y += Math.min(lift, 0.5 * dt); if (f.v.y < 0) f.v.y *= 0.5; L.stats.lift++; L.stats.by[this.name] = (L.stats.by[this.name] || 0) + 1; }
      const yaw = Math.atan2(-f.v.z, f.v.x), pitch = Math.atan2(f.v.y, Math.hypot(f.v.x, f.v.z));
      const dy = wrapAng(yaw - f.yaw);
      const rate = dy / Math.max(dt, 1e-3);
      f.yaw += dy * damp(5, dt); f.pitch += (THREE.MathUtils.clamp(pitch, -0.5, 0.5) - f.pitch) * damp(4, dt);
      f.roll += (-rate * 0.03 - f.roll) * damp(3, dt);
      f.bend += (THREE.MathUtils.clamp(-rate * 0.02, -0.1, 0.1) - f.bend) * damp(3, dt);
      const rel = THREE.MathUtils.clamp(f.v.length() / sp.speed[1], 0.2, 2.4);
      f.phase += dt * TAU * f.beat * (0.4 + 0.6 * rel);
      f.ampS = f.amp * (0.6 + 0.4 * Math.min(rel, 1.8));
      f.fin += dt * TAU * f.finBeat;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A moray in a hole low on the bommie: now and then it puts its head and neck out, watches, and goes back.
//, it turns about the hole itself, the body
// past the neck is drawn away inside the hole (uHide), and the hole is a dark crevice in the coral.)
// It also takes the odd small fish that strays in front of its hole: a quick lunge out of the hole, rarer than the sharks' hunts; the fish round it scatter.
class Moray {
  constructor(life, at, out, len) {
    this.life = life; this.at = at.clone(); this.len = len; this.ext = 0; this.goal = 0; this.t = rand(4, 20);
    this.yaw0 = Math.atan2(-out.z, out.x); this.phase = 0; this.visible = true;
    this.pos = new THREE.Vector3(); this.yaw = this.yaw0; this.pitch = 0; this.roll = 0;
    this.strike = null; this.cool = life.morayEvery || rand(240, 600);
  }
  // a small fish in front of the hole, within a lunge (it reaches about 45 % of its length out)
  findPrey(Ld) {
    const L = this.life;
    let best = null, bd = 1e9;
    for (const w of L.swimmers) {
      // (a fish it can swallow: no longer than about a third of the eel)
      if (!w.visible || w.sp.shark || w.sp.big || w.sp.resident || w.sp.puffer || w.sp.len * BODY > Ld * 0.3 || w.hunted || (w.state !== 'swim' && w.state !== 'hold')) continue;
      P.copy(w.pos).sub(this.at);
      const d = P.length();
      if (d > Ld * 0.42 || d < 0.12) continue;
      const yaw = Math.atan2(-P.z, P.x), pitch = Math.asin(THREE.MathUtils.clamp(P.y / d, -1, 1));
      if (Math.abs(wrapAng(yaw - this.yaw0)) > 0.75 || pitch < -0.35 || pitch > 0.95) continue;
      if (d < bd) { bd = d; best = w; }
    }
    return best;
  }
  update(dt, t, env) {
    const L = this.life, Ld = this.len * BODY, night = 1 - env.day;
    this.t -= dt; this.cool -= dt;
    if (!this.strike && this.t <= 0) {
      if (this.goal > 0) { this.goal = 0; this.t = rand(25, 80) * (1 - 0.5 * night); }   // in again (out more at night)
      else { this.goal = rand(0.15, 0.21) + 0.04 * night; this.t = rand(20, 45); }
    }
    const out = Math.min(1, this.ext * 6);
    if (!this.strike && this.ext > 0.1 && this.cool <= 0) {
      const prey = this.findPrey(Ld);
      if (prey) { this.strike = { prey, t: 0 }; prey.hunted = this; L.stats.moray.strikes++; }
    }
    let yawGoal = this.yaw0 + Math.sin(t * 0.27) * 0.3 * out, pitchGoal = Math.sin(t * 0.19 + 1) * 0.1 * out, k = 2;
    if (this.strike) {
      const sk = this.strike, prey = sk.prey;
      sk.t += dt;
      P.copy(prey.pos).sub(this.at);
      const d = P.length();
      yawGoal = Math.atan2(-P.z, P.x); pitchGoal = Math.asin(THREE.MathUtils.clamp(P.y / d, -1, 1)); k = 14;
      // out of the hole in a flash, jaws first
      this.ext += (Math.min(0.45, d / Ld + 0.03) - this.ext) * damp(9, dt);
      P2.set(Math.cos(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.sin(this.yaw) * Math.cos(this.pitch));
      P2.multiplyScalar(this.ext * Ld).add(this.at);
      const caught = prey.visible && P2.distanceTo(prey.pos) < 0.06 + prey.sp.len * BODY * 0.3;
      if (caught) { prey.visible = false; prey.wait = rand(40, 120); prey.state = 'away'; L.stats.moray.caught++; }
      if (caught || sk.t > 0.7 || !prey.visible) {
        L.scare(prey.pos);   // everyone round it scatters
        prey.hunted = null; this.strike = null;
        this.goal = 0.14; this.t = rand(6, 14); this.cool = L.morayEvery || rand(600, 1500);
      }
    } else this.ext += (this.goal - this.ext) * damp(0.45, dt);
    this.yaw += wrapAng(yawGoal - this.yaw) * damp(k, dt);
    this.pitch += (pitchGoal - this.pitch) * damp(k, dt);
    const fwd = P.set(Math.cos(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.sin(this.yaw) * Math.cos(this.pitch));
    // the eel's axis runs through the hole: its snout is ext x its length out, the rest is inside
    this.pos.copy(this.at).addScaledVector(fwd, (this.ext - 0.5) * Ld);
    this.pos.y += Math.sin(t * 1.3) * 0.003;           // breathing
    this.phase += dt * TAU * 0.25;
    this.amp = 0.004 + 0.004 * out; this.bend = 0;
    if (L.uni?.moray) L.uni.moray.uHide.value = this.ext + 0.04;
    this.visible = this.ext > 0.015;   // all the way in: nothing of it shows
  }
  // its snout, for tests
  nose() { return new THREE.Vector3(Math.cos(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.sin(this.yaw) * Math.cos(this.pitch)).multiplyScalar(this.ext * this.len * BODY).add(this.at); }
}

// A blue-spotted ribbontail ray: rests half-buried on the sand, now and then lifts off, glides low over the sand with
// its wing margins rippling, and settles again (lowered into the sand, so the sand hides its lower edge).
class SandRay {
  constructor(life, len) {
    this.life = life; this.len = len; this.visible = true; this.state = 'rest'; this.t = rand(8, 25);
    this.pos = this.spot(); this.target = this.pos.clone(); this.yaw = rand(0, TAU); this.pitch = 0; this.roll = 0;
    this.phase = 0; this.amp = 0.01; this.bend = 0; this.h = -0.012;
    this.shadow = contactShadow(life.scene, this.pos, len * 1.1, 0.3);
  }
  spot() {
    const R = this.life.reef, A = this.life.anemone;
    for (let k = 0; k < 30; k++) {
      const p = R.pointAt(rand(0.55, 0.98), rand(0.84, 0.97));
      p.y = R.floorY(p.x, p.z);
      if (!A || p.distanceTo(A.pos) > A.size * 1.3) return p;
    }
    return R.pointAt(0.9, 0.93);
  }
  update(dt, t) {
    const R = this.life.reef;
    this.t -= dt;
    if (this.state === 'rest' && this.t <= 0) { this.state = 'glide'; this.target = this.spot(); this.life.puffs?.burst(this.pos, this.len * 0.5, 30); }
    let hGoal = -0.012, ampGoal = 0.012, beat = 0.6;
    if (this.state === 'glide') {
      const to = this.target.clone().sub(this.pos); to.y = 0;
      const d = to.length();
      const want = Math.atan2(-to.z, to.x);
      this.yaw += Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw)) * damp(1.2, dt);
      const sp = Math.min(0.16, d * 0.4 + 0.03);
      this.pos.x += Math.cos(this.yaw) * sp * dt; this.pos.z -= Math.sin(this.yaw) * sp * dt;
      hGoal = 0.07; ampGoal = 0.05; beat = 1.0;
      // glide over the anemone, not through it
      const A = this.life.anemone;
      if (A && Math.hypot(this.pos.x - A.pos.x, this.pos.z - A.pos.z) < A.size * 0.9) hGoal = A.size * 0.4;
      if (d < 0.05) { this.state = 'rest'; this.t = rand(20, 70); this.puffT = 1.2; }
    }
    // settling: a moment after touching down it flaps sand over its back
    if (this.puffT !== undefined && (this.puffT -= dt) <= 0) { this.life.puffs?.burst(this.pos, this.len * 0.45, 45); this.puffT = undefined; }
    this.h += (hGoal - this.h) * damp(this.state === 'glide' ? 1.5 : 0.4, dt);
    this.amp += (ampGoal - this.amp) * damp(1.5, dt);
    this.phase += dt * TAU * beat;
    const fy = R.floorY(this.pos.x, this.pos.z);
    this.pos.y = fy + this.h + this.len * 0.03;
    this.shadow.position.set(this.pos.x, fy + 0.008, this.pos.z);
    this.shadow.material.uniforms.uS.value = 0.32 - Math.max(0, this.h) * 1.5;
    this.roll = Math.sin(t * 0.4) * 0.02;
  }
}

// ---------------------------------------------------------------------------------------------------------------
export class Life {
  constructor(scene, reef, ctx) {
    this.scene = scene; this.reef = reef; this.ctx = ctx;
    this.swimmers = []; this.schools = []; this.sharks = []; this.meshes = {}; this.others = [];
    this.stats = { lift: 0, by: {}, hunts: { tried: 0, caught: 0, missed: 0 }, puffs: 0, moray: { strikes: 0, caught: 0 } };
    // ?puff=S / ?moray=S: the puffer blows up / the moray strikes every S seconds when it can (tests, staged clips)
    this.puffEvery = +(new URLSearchParams(location.search).get('puff') || 0);
    this.morayEvery = +(new URLSearchParams(location.search).get('moray') || 0);
    // now and then a shark takes a fish: once every
    // few minutes at most, and only when a shark in view finds a lone small fish out in the open (?hunt=S: every S s)
    this.huntEvery = +(new URLSearchParams(location.search).get('hunt') || 0);
    this.huntT = this.huntEvery || rand(150, 300);
    this.scares = [];
    // ?visit=turtle,whaleshark brings rare visitors in at once (stills and clips)
    this.visit = new Set((new URLSearchParams(location.search).get('visit') || '').split(',').filter(Boolean));
    this.visitAt = +(new URLSearchParams(location.search).get('visitAt') || 0.5);   // sim seconds
    this.loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    // the bommie the sharks circle: centre of the reef's near blob, from bake.py
    const b = reef.info.blobs[0];
    this.bommie = new THREE.Vector3(...b.centre);
    this.box = { min: new THREE.Vector3(...b.min), max: new THREE.Vector3(...b.max) };
  }

  async model(name) {
    const g = await this.loader.loadAsync('./models/' + name + '.glb');
    let mesh = null;
    g.scene.traverse(o => { if (o.isMesh && !mesh) mesh = o; });
    return mesh;
  }

  // one InstancedMesh per species, swimming wave in its vertex shader
  async instanced(modelName, styleName, count, key) {
    const src = await this.model(modelName);
    const geo = src.geometry.clone();
    geo.setAttribute('aSwim', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const mat = src.material.clone();
    mat.side = THREE.DoubleSide;
    // fish are not metal: drop Tripo's metalness, keep its roughness detail, a wet sheen from the environment
    mat.metalness = 0.04; mat.metalnessMap = null;
    if (!mat.roughnessMap) mat.roughness = 0.45;
    mat.envMapIntensity = 1.0;
    // Tripo's yellow tang came out pale cream: bring back the real fish's bright lemon yellow
    if (TINT[modelName]) mat.color.setRGB(...TINT[modelName]);
    if (styleName === 'eel') mat.envMapIntensity = 0.35;
    const st = STYLE[styleName];
    // where the flank ends and the pectoral fin begins: the head (in front of the fins) gives the body's width, the
    // flank is a little wider; whatever reaches further out between gill and mid-body is fin, out to its tip
    const fin = new THREE.Vector4(0, 1, 0, 0), F = FIN[modelName];
    if (F) {
      const pa = geo.attributes.position; let head = 0, tip = 0;
      for (let i = 0; i < pa.count; i++) {
        const sx = (1 - pa.getX(i)) * 0.5, az = Math.abs(pa.getZ(i));
        if (sx > 0.05 && sx < 0.13) head = Math.max(head, az);
        if (sx > 0.2 && sx < 0.7) tip = Math.max(tip, az);
      }
      const flank = head * 1.3;
      if (tip > flank * 1.4 || st.puffer) fin.set(flank, Math.max(tip, flank * 1.4), F[0], F[2] * 0.5);
      (this.finInfo = this.finInfo || {})[modelName] = [+flank.toFixed(3), +tip.toFixed(3)];
    }
    // rays and turtles: the wing or flipper tip is the widest point of the model
    let span = 0.5;
    if (st.ray) { const pa = geo.attributes.position; span = 0; for (let i = 0; i < pa.count; i++) span = Math.max(span, Math.abs(pa.getZ(i))); }
    // the pufferfish: its outline along the body, from the model itself, and the ball it blows up into
    const prof = Array.from({ length: 12 }, () => new THREE.Vector4(0, 0.1, 0.1, 0)), ball = new THREE.Vector3(0.3, 0, 0.4);
    if (st.puffer) {
      const pa = geo.attributes.position, bins = Array.from({ length: 12 }, () => ({ y: [], z: [] }));
      for (let i = 0; i < pa.count; i++) {
        const k = Math.min(11, Math.round(THREE.MathUtils.clamp((1 - pa.getX(i)) * 0.5, 0, 1) * 11));
        bins[k].y.push(pa.getY(i)); bins[k].z.push(Math.abs(pa.getZ(i)));
      }
      // the body's outline, not its fins: most of a bin's points are body, so take percentiles, not the extremes
      const pct = (a, q) => { if (!a.length) return 0; a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
      bins.forEach((b, k) => { const hi = pct(b.y, 0.9), lo = pct(b.y, 0.1); prof[k].set((hi + lo) / 2, Math.max(0.02, (hi - lo) / 2), Math.max(0.02, pct(b.z, 0.85)), 0); });
      let g = 0; for (let k = 2; k <= 7; k++) g = Math.max(g, prof[k].y, prof[k].z);
      ball.set(0.25, prof[4].x, Math.min(0.68, g * 1.45));
      (this.finInfo = this.finInfo || {})[modelName + '-ball'] = [+g.toFixed(3), +ball.z.toFixed(3)];
    }
    const u = { uStyle: { value: new THREE.Vector4(st.start, st.head, st.lambda, st.pow) }, uRay: { value: st.ray ? 1 : 0 }, uInner: { value: st.inner || 0 }, uFin: { value: fin },
      uFinRest: { value: F?.[3] || 0 }, uLegacy: { value: st.legacy ? 1 : 0 }, uSpan: { value: span }, uHide: { value: 2 },
      uPufferOn: { value: st.puffer ? 1 : 0 }, uPuff: { value: 0 }, uDA: { value: 0.5 }, uBall: { value: ball }, uProf: { value: prof } };
    (this.uni = this.uni || {})[key] = u;
    this.ctx.waterify(mat, {
      key: 'swim-' + styleName, caustics: 0.45,
      // far out in the blue every animal is a solid darker shape, not a ghost: sharks, rays and turtles from ~5 m, the colourful reef fish only from ~7 m, gently
      ...(styleName === 'shark' || styleName === 'hammer' || styleName === 'ray' || styleName === 'turtle' ? { silhouette: 1 } : { silhouette: 0.6, silNear: 7, silFar: 18 }),
      uniforms: u,
      vertexHead: WAVE_HEAD, vertexBody: WAVE_BODY, normalBody: WAVE_NORMAL,
      // the moray's neck goes dark as it goes into its hole
      fragmentHead: 'varying float vHole;\n',
      fragmentBody: styleName === 'eel' ? EEL_COLOUR + 'outgoingLight *= mix(1.0, 0.18, smoothstep(-0.06, 0.03, vHole));' : '',
      ...(styleName === 'eel' ? { rim: 0.12 } : {}),
    });
    const im = new THREE.InstancedMesh(geo, mat, count);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.count = 0;
    this.scene.add(im);
    this.meshes[key] = im;
    return im;
  }

  async load() {
    const jobs = [];
    for (const [name, sp] of Object.entries(SPECIES)) {
      jobs.push(this.instanced(name, sp.style, sp.n, name).then(() => {
        for (let k = 0; k < sp.n; k++) {
          const s = new Swimmer(this, sp, name, k);
          this.swimmers.push(s);
          if (sp.shark) this.sharks.push(s);
        }
      }).catch(e => console.warn('species skipped', name, String(e).slice(0, 120))));
    }
    for (const [name, sp] of Object.entries(SCHOOLS)) {
      jobs.push(this.instanced(sp.model || name, sp.style, sp.n, 'school-' + name).then(() => this.schools.push(new School(this, sp, name)))
        .catch(e => console.warn('school skipped', name, String(e).slice(0, 120))));
    }
    await Promise.all(jobs);
    // the anemone on the sand in front, right of the bommie; jellyfish up in the blue
    const at = this.reef.pointAt(0.74, 0.86);
    at.y = this.reef.floorY(at.x, at.z);
    this.anemone = new Anemone(this.scene, this.reef, this.ctx.waterify, at, 0.95);
    this.reef.raise(at, 0.95 * 0.55, at.y + 0.95 * 0.3);   // swimmers pass over the anemone, not through it
    this.jellies = new Jellies(this.scene, this.reef, this.ctx.WATER, 6);
    this.puffs = new SandPuffs(this.scene, this.ctx.WATER);
    // the moray's hole low on the front of the bommie; the ray resting on the sand
    try {
      await this.instanced('moray', 'eel', 1, 'moray');
      const hole = this.reef.pointAt(0.3, 0.73);
      const toCam = new THREE.Vector3(-hole.x, 0, -hole.z).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.55);
      const mo = Object.assign(new Moray(this, hole, toCam, sizeOf('moray', 1.05)), { key: 'moray' });
      this.others.push(mo); this.moray = mo;
      // its hole: a dark crevice in the coral face, so the eel comes out of somewhere
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const gx = cv.getContext('2d'), gr = gx.createRadialGradient(32, 32, 2, 32, 32, 31);
      gr.addColorStop(0, 'rgba(8,12,14,0.92)'); gr.addColorStop(0.55, 'rgba(10,16,18,0.7)'); gr.addColorStop(1, 'rgba(14,22,24,0)');
      gx.fillStyle = gr; gx.fillRect(0, 0, 64, 64);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const crev = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, toneMapped: false }));
      const Ld = mo.len * BODY;
      crev.scale.set(Ld * 0.2, Ld * 0.14, 1);
      // a little in front of the coral face, so the photo's own bumps don't cover it
      crev.position.copy(hole).addScaledVector(hole.clone().normalize(), -0.15);
      crev.renderOrder = 5;
      this.scene.add(crev); this.crevice = crev;
    } catch (e) { console.warn('moray skipped', String(e).slice(0, 120)); }
    await this.instanced('bluespotray', 'ray', 1, 'bluespotray');
    this.others.push(Object.assign(new SandRay(this, sizeOf('bluespotray', 0.5)), { key: 'bluespotray' }));
    this.bottom = new Bottom(this);
    await this.bottom.load();
    // a few fish already in view at the start
    for (const s of this.swimmers) if ((Math.random() < 0.6 && !s.sp.shark && !s.sp.rare) || s.sp.resident) { s.spawn(); if (!s.sp.resident) { s.visible = false; s.pos.copy(this.wayPoint(s.sp, s)); s.visible = true; s.target.copy(this.wayPoint(s.sp, s)); } }
  }
  anemoneSpot(hide = false) {   // where the clownfish hover: over the tentacles, or down among them
    const A = this.anemone, r = A.size * (hide ? 0.25 : 0.42) * Math.sqrt(Math.random()), a = rand(0, TAU);
    return A.pos.clone().add(new THREE.Vector3(Math.cos(a) * r, hide ? A.size * 0.07 : A.size * rand(0.14, 0.38), Math.sin(a) * r));
  }

  // ---- places ----
  ray(u, v, d) {   // a point d metres out along the photo camera's ray through photo uv (u, v from top-left)
    const { fx, fy, cx, cy } = this.reef.info;
    const dir = new THREE.Vector3((u - cx) / fx, -(v - cy) / fy, -1);
    return dir.multiplyScalar(d);   // z = -d (depth along the axis)
  }
  // is the straight line from a to b clear of the reef by `need`?
  pathClear(a, b, need) {
    const n = Math.max(1, Math.ceil(a.distanceTo(b) / 0.3));
    for (let k = 1; k <= n; k++) { P.lerpVectors(a, b, k / n); if (this.reef.solid(P, need)) return false; }
    return true;
  }
  wayPoint(sp, who) {
    const R = this.reef, need = who?.need ?? sp.len * BODY * 0.27 + 0.03;
    for (let tries = 0; tries < 60; tries++) {
      let p;
      if (sp.zone === 'shark') {
        // loose orbits round the bommie and passes through the blue, never close to the camera
        const a = rand(0, TAU), r = rand(3.5, 7.5);
        p = this.bommie.clone().add(new THREE.Vector3(Math.cos(a) * r, rand(0.4, 2.1), Math.sin(a) * r * 0.8));
        if (p.length() < 5.5) continue;
      } else if (sp.zone === 'edge') {
        // the hammerhead: along the edge of the reef out in the blue, or now and then a slow pass low over the sand
        if (Math.random() < 0.35) { p = this.ray(rand(0.1, 0.9), rand(0.62, 0.8), rand(5.5, 9)); p.y = R.floorY(p.x, p.z) + rand(0.7, 1.2); }
        else p = this.ray(rand(-0.1, 1.1), rand(0.3, 0.52), rand(7.5, 14));
        if (p.length() < 5.2) continue;
      } else if (sp.zone === 'far') {
        p = this.ray(rand(0.0, 1.0), rand(0.4, 0.52), sp.len > 3 ? rand(19, 24) : rand(16, 26));
      } else if (sp.zone === 'open') {
        // the big rare visitors (eagle ray, turtle) pass close enough to be recognised: far off in the haze the turtle
        // read as "might be a penguin"
        p = this.ray(rand(-0.1, 1.1), rand(0.22, 0.55), sp.big ? rand(5.5, 9) : rand(sp.visitor ? 6 : 4.5, 13));
      } else if (sp.zone === 'school') {
        p = this.ray(rand(0.05, 0.75), rand(0.25, 0.55), rand(3.5, 8.5));
      } else {
        // reef fish: often close in front of us (they come up to the camera), otherwise near the coral
        if (sp.zone === 'reef' && Math.random() < 0.38) {
          p = this.ray(rand(0.05, 0.95), rand(0.3, 0.72), rand(1.35, 2.6));
        } else {
          const u = rand(-0.05, 1.05), v = rand(sp.zone === 'low' ? 0.5 : 0.3, sp.zone === 'low' ? 0.8 : 0.72);
          const s = R.surfaceDepth(THREE.MathUtils.clamp(u, 0, 1), v);
          const d = s < 20 ? rand(Math.max(1.6, s - 2.2), s - 0.35) : rand(2.5, 11);
          p = this.ray(u, v, d);
        }
      }
      const fy = R.floorY(p.x, p.z);
      if (p.y < fy + 0.3) p.y = fy + rand(0.3, 1.0);
      if (R.solid(p, need * 1.5) || !(sp.zone === 'far' || p.y < 4.5) || -p.z <= 1.4) continue;
      // the first tries also want a straight run to it that doesn't cross the reef
      if (who && who.visible && tries < 45 && !this.pathClear(who.pos, p, need)) continue;
      return p;
    }
    return this.ray(0.5, 0.4, 6);
  }
  exitPoint(sp) {   // off screen: past the sides at the fish's depth, or for small fish out into the haze
    if (sp.far) return this.ray(Math.random() < 0.5 ? -0.5 : 1.5, rand(0.3, 0.5), rand(20, 26));
    if (!(sp.shark || sp.big || sp.visitor) && Math.random() < 0.35) {
      const p = this.ray(rand(0.1, 0.9), rand(0.3, 0.6), rand(20, 24));
      p.y = Math.max(p.y, this.reef.height(p) + 0.6);   // over the far reef, not out of it
      return p;
    }
    const side = Math.random() < 0.5 ? -0.35 : 1.35;
    const d = sp.shark || sp.big || sp.visitor ? rand(6, 12) : rand(2.5, 9);
    const p = this.ray(side, rand(0.3, 0.7), d);
    p.y = Math.max(p.y, this.reef.height(p) + sp.len * BODY * 0.4 + 0.3);   // the reef runs on past the picture's sides
    return p;
  }
  reefSpot(off) {   // a point just in front of the reef surface, and the heading that faces it
    const R = this.reef;
    for (let k = 0; k < 30; k++) {
      const u = rand(0.12, 0.98), v = rand(0.38, 0.8);
      const s = R.surfaceDepth(u, v);
      if (s > 12) continue;
      const p = this.ray(u, v, s - off);
      if (p.y < R.floorY(p.x, p.z) + 0.15) continue;
      const inward = this.ray(u, v, s).sub(p);
      // room for the whole fish, nose to tail, in front of the coral it picks at
      const half = off - 0.06, need = half * 0.4;
      P2.copy(inward).normalize();
      if (R.solid(P.copy(p).addScaledVector(P2, half * 0.9), need * 0.5) || R.solid(p, need) || R.solid(P.copy(p).addScaledVector(P2, -half), need)) continue;
      // and clear by the same margin the swimmers keep (their `need`), so a fish holding here is never lifted off it
      // again and again (it bounced)
      const fishNeed = off * 0.27 * 2 + 0.03, hs = off - 0.06;
      let ok = true;
      for (const k of [1, 0, -1]) { P.copy(p).addScaledVector(P2, k * hs); if (R.height(P) + fishNeed * 0.6 + 0.03 > P.y) { ok = false; break; } }
      if (!ok) continue;
      return { pos: p, yaw: Math.atan2(-inward.z, inward.x) };
    }
    return null;
  }
  // the hunt: a shark in view, a lone small fish in the open water in front of it, nothing in between
  tryHunt() {
    const R = this.reef;
    let best = null;
    for (const s of this.sharks) {
      if (!s.visible || s.state !== 'swim' || s.sp.far) continue;
      const q = R.project(s.pos), dc = s.pos.length();
      // close enough to be seen on the 10-inch screen, not in our face
      if (!q || q.u < 0.1 || q.u > 0.9 || q.v < 0.12 || q.v > 0.8 || dc < 4.5 || dc > 11) continue;
      const f = s.forward();
      for (const w of this.swimmers) {
        if (!w.visible || w.sp.shark || w.sp.big || w.sp.resident || w.sp.puffer || w.sp.len > 0.4 || w.state !== 'swim' || w.hunted) continue;
        const wq = R.project(w.pos), wd = w.pos.length();
        if (wd < 4 || wd > 9.5 || !wq || wq.u < 0.12 || wq.u > 0.88 || w.pos.y < R.height(w.pos) + s.need + 0.5) continue;   // out in the open, in view
        P.copy(w.pos).sub(s.pos); const d = P.length();
        if (d < 2.2 || d > 7 || P.dot(f) / d < Math.cos(1.3) || Math.abs(P.y) > d * 0.35) continue;   // ahead, about level
        // a lone fish: nobody else close by, no school round it
        let lone = true;
        for (const o of this.swimmers) if (o !== w && o.visible && !o.sp.shark && o.pos.distanceToSquared(w.pos) < 1.4 * 1.4) { lone = false; break; }
        for (const sc of this.schools) if (lone && !sc.hidden && !sc.sp.far) for (const m of sc.m) if (m.p.distanceToSquared(w.pos) < 1.6 * 1.6) { lone = false; break; }
        if (!lone || !this.pathClear(s.pos, w.pos, s.need)) continue;
        if (!best || d < best.d) best = { s, w, d };
      }
    }
    this.stats.hunts.tried++;
    if (!best) return false;
    const { s, w } = best;
    s.state = 'hunt'; s.prey = w; s.huntT = 0; w.hunted = s;
    return true;
  }
  // a catch startles every fish round it for a few seconds
  scare(p) { this.scares.push({ p: p.clone(), t: 4 }); }
  scared(p) { for (const sc of this.scares) if (sc.p.distanceToSquared(p) < 16) return sc.p; return null; }
  nearShark(p, r) {
    for (const s of this.sharks) if (s.visible && s.pos.distanceToSquared(p) < r * r) return true;
    return false;
  }

  // ---- per frame ----
  update(dt, t, env = { day: 1 }) {
    // who is in whose way: each pair closer than their sizes allow pushes apart, the smaller one more
    const vis = this.vis || (this.vis = []); vis.length = 0;
    for (const s of this.swimmers) { s.push.set(0, 0, 0); if (s.visible) vis.push(s); }
    for (const s of vis) { s.f = s.forward(); s.L = s.sp.len * s.lenK() * BODY; }
    // closest point of b's spine to a's middle: a keeps its own half-size plus b's girth away from it
    const off = (a, b) => {
      const t = THREE.MathUtils.clamp(P.copy(a.pos).sub(b.pos).dot(b.f), -b.L * 0.5, b.L * 0.5);
      P.copy(a.pos).sub(b.pos).addScaledVector(b.f, -t);
      const d = P.length(), r = 0.42 * a.L + 0.25 * b.L + 0.08 + (b.sp.shark ? (a.sp.shark ? 1.4 : 0.5) : 0);   // a wide berth round a shark
      if (d >= r) return;
      if (d < 1e-3) P.set(0, 1, 0); else P.multiplyScalar(1 / d);
      a.push.addScaledVector(P, (r - d) / r * 2 * b.L / (a.L + b.L));
    };
    for (let i = 0; i < vis.length; i++) {
      const a = vis[i], la = a.L;
      for (let j = i + 1; j < vis.length; j++) {
        const b = vis[j], reach = 0.95 * (la + b.L) + 1.6;
        if (a.pos.distanceToSquared(b.pos) >= reach * reach || a.prey === b || b.prey === a) continue;   // the hunter and its prey close in
        off(a, b); off(b, a);
      }
      // jellyfish are in the way too (bell and arms)
      for (const jl of this.jellies?.list || []) {
        if (!jl.alive) continue;
        P.copy(a.pos).sub(jl.g.position); P.y += jl.R * 0.6;
        const r = jl.R * 1.8 + la * 0.5, d = P.length();
        if (d < r && d > 1e-3) a.push.addScaledVector(P, (r - d) / r / d);
      }
    }
    for (const sc of this.scares) sc.t -= dt;
    if (this.scares.length && this.scares[0].t <= 0) this.scares.shift();
    if ((this.huntT -= dt) <= 0) {
      const busy = this.sharks.some(s => s.state === 'hunt');
      this.huntT = !busy && this.tryHunt() ? (this.huntEvery || rand(180, 420)) : (this.huntEvery ? 2 : 8);
    }
    for (const s of this.swimmers) s.update(dt, t, env);
    for (const sc of this.schools) sc.update(dt, t, env);
    for (const o of this.others) o.update(dt, t, env);
    for (const s of this.swimmers) if (s.sp.puffer && this.uni?.[s.name]) this.uni[s.name].uPuff.value = s.visible ? s.puffK : 0;
    this.bottom?.update(dt, t, env);
    this.jellies?.update(dt, t, env);
    this.puffs?.update(dt);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YZX'), sc = new THREE.Vector3();
    const counts = {};
    const put = (key, pos, yaw, pitch, roll, len, phase, amp, bend, fin = 0) => {
      const im = this.meshes[key]; const i = counts[key] = (counts[key] ?? -1) + 1;
      e.set(roll, yaw, pitch); q.setFromEuler(e); sc.setScalar(len);
      M.compose(pos, q, sc); im.setMatrixAt(i, M);
      im.geometry.attributes.aSwim.setXYZW(i, phase, amp, bend, fin);
    };
    for (const s of this.swimmers) if (s.visible) put(s.name, s.pos, s.yaw, s.pitch, s.roll, s.sp.len * s.lenK(), s.phase, s.ampS ?? s.amp, s.bend, s.fin);
    for (const o of this.others) if (o.visible) put(o.key, o.pos, o.yaw, o.pitch, o.roll, o.len, o.phase, o.amp, o.bend);
    for (const sc2 of this.schools) if (!sc2.hidden) for (const f of sc2.m) put('school-' + sc2.name, f.p, f.yaw, f.pitch, f.roll, sc2.sp.len, f.phase, f.ampS ?? f.amp, f.bend, f.fin);
    for (const [key, im] of Object.entries(this.meshes)) {
      im.count = counts[key] !== undefined ? counts[key] + 1 : 0;
      im.instanceMatrix.needsUpdate = true;
      im.geometry.attributes.aSwim.needsUpdate = true;
    }
  }
}
Swimmer.prototype.lenK = function () { return this._lk ?? (this._lk = rand(0.85, 1.15)); };

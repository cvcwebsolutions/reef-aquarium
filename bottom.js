// Bottom life: crabs on the sand, a cleaner shrimp on the coral, a sea star, an urchin, a
// blue-spotted ray that settles into the sand, and a moray that looks out of its hole now and then.
// Models are Tripo meshes made from our own reference photos (prep.mjs puts the head at +x, length 1).
import * as THREE from 'three';
import { contactShadow } from './extras.js';
import { sizeOf } from './life.js';   // ?size=true: real sizes

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const damp = (k, dt) => 1 - Math.exp(-k * dt);

// legs: lift and reach of the outer parts of the body, a wave running along the leg row
const LEGS_HEAD = /* glsl */`
  uniform float uPhase, uAmp, uTime;
  uniform vec4 uLegA;   // x: legs reach along x (1) or z (0); y, z: inner/outer reach; w: wave number along the row
  uniform vec4 uLegB;   // x: only where p.x > this (hermit crab: the crab end, not the shell); y: antenna wave (shrimp)
  uniform vec4 uSway;   // x: spines/arms sway amount beyond radius y; z: arm curl
`;
const LEGS_BODY = /* glsl */`
  {
    vec3 p = position;
    float reach = mix(abs(p.z), abs(p.x), uLegA.x);
    float along = mix(p.x, p.z, uLegA.x);
    float side = mix(sign(p.z), sign(p.x), uLegA.x);
    float m = smoothstep(uLegA.y, uLegA.z, reach) * step(uLegB.x, p.x) * smoothstep(0.15, -0.05, p.y);
    float lift = max(0.0, sin(uPhase + along * uLegA.w + (side > 0.0 ? 0.0 : 3.14159)));
    transformed.y += uAmp * 0.07 * m * lift;
    if (uLegA.x > 0.5) transformed.x += side * uAmp * 0.025 * m * cos(uPhase + along * uLegA.w); else transformed.z += side * uAmp * 0.025 * m * cos(uPhase + along * uLegA.w);
    transformed.y += uAmp * 0.006 * sin(uPhase * 2.0);
    // antennae (shrimp): the long thin parts in front wave slowly
    if (uLegB.y > 0.0) {
      float a = smoothstep(0.22, 0.5, p.x);
      transformed.y += a * a * uLegB.y * sin(uTime * 2.3 + p.x * 9.0 + p.z * 20.0);
      transformed.z += a * a * uLegB.y * 0.7 * cos(uTime * 1.7 + p.x * 7.0);
    }
    // spines (urchin) and arms (sea star) moving a little
    if (uSway.x > 0.0) {
      float d = length(p);
      float s = max(0.0, d - uSway.y);
      transformed.x += s * uSway.x * sin(uTime * 0.7 + p.y * 6.0 + p.z * 4.0);
      transformed.z += s * uSway.x * cos(uTime * 0.6 + p.x * 5.0);
      transformed.y += uSway.z * s * s * sin(uTime * 0.25 + atan(p.z, p.x) * 2.0);
    }
  }
`;

async function critter(life, model, opts = {}) {
  const src = await life.model(model);
  const mat = src.material.clone();
  mat.side = THREE.DoubleSide; mat.metalness = 0.03; mat.metalnessMap = null;
  const u = {
    uPhase: { value: 0 }, uAmp: { value: 0 },
    uLegA: { value: new THREE.Vector4(...(opts.legA || [0, 9, 9, 0])) },
    uLegB: { value: new THREE.Vector4(...(opts.legB || [-9, 0, 0, 0])) },
    uSway: { value: new THREE.Vector4(...(opts.sway || [0, 0, 0, 0])) },
  };
  life.ctx.waterify(mat, { key: 'critter', caustics: 0.5, uniforms: u, vertexHead: LEGS_HEAD, vertexBody: LEGS_BODY, belly: 0.75 });
  const m = new THREE.Mesh(src.geometry, mat);
  m.frustumCulled = false;
  m.userData.u = u;
  life.scene.add(m);
  return m;
}

// the photo camera's ray through photo (u, v) meeting the sand
function sandAt(reef, u, v) {
  const p = reef.pointAt(u, v);
  p.y = reef.floorY(p.x, p.z);
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
class Crab {
  // sideways: true = walks along its x (a true crab), false = forwards (+x, the hermit crab)
  constructor(life, mesh, size, home, sideways) {
    this.life = life; this.m = mesh; this.size = size; this.home = home.clone(); this.sideways = sideways;
    this.pos = home.clone(); this.yaw = rand(-0.6, 0.6) + (sideways ? Math.PI / 2 : 0);
    this.dir = 1; this.speed = 0; this.state = 'pause'; this.t = rand(1, 5); this.phase = 0;
    mesh.scale.setScalar(size);
    this.shadow = contactShadow(life.scene, this.pos, size * 1.3, 0.35);
  }
  update(dt, t, env) {
    const R = this.life.reef, busy = 0.5 + 0.5 * (1 - env.day);   // busier at night
    this.t -= dt;
    if (this.t <= 0) {
      if (this.state === 'walk') { this.state = 'pause'; this.t = rand(2, 9) / busy; }
      else {
        this.state = 'walk'; this.t = rand(1.2, 4.5) * busy;
        this.dir = this.sideways && Math.random() < 0.5 ? -1 : 1;   // crabs go either way; the hermit only forwards
        if (Math.random() < 0.35) this.yaw += rand(-0.9, 0.9);
        // stay round home: head back if wandered off (a sideways walker moves along yaw - 90 degrees)
        if (this.pos.distanceTo(this.home) > 0.9) {
          const to = this.home.clone().sub(this.pos);
          const want = Math.atan2(-to.z, to.x);
          this.yaw = this.sideways ? want + Math.PI / 2 : want; this.dir = 1;
        }
      }
    }
    const target = this.state === 'walk' ? this.size * (this.sideways ? 0.55 : 0.35) : 0;
    this.speed += (target - this.speed) * damp(6, dt);
    const ang = this.yaw + (this.sideways ? -Math.PI / 2 : 0);
    const mv = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang)).multiplyScalar(this.speed * this.dir * dt);
    this.pos.add(mv);
    this.pos.y = R.floorY(this.pos.x, this.pos.z);
    this.phase += dt * TAU * 3.2 * (this.speed / (this.size * 0.5)) * this.dir;
    const u = this.m.userData.u;
    u.uPhase.value = this.phase; u.uAmp.value = Math.min(1, this.speed / (this.size * 0.3));
    this.m.position.copy(this.pos).add(new THREE.Vector3(0, this.size * 0.2, 0));
    this.m.rotation.set(0, this.yaw, 0);
    this.shadow.position.set(this.pos.x, this.pos.y + 0.008, this.pos.z);
  }
}

// ---------------------------------------------------------------------------------------------------------------
export class Bottom {
  constructor(life) { this.life = life; this.items = []; }
  async load() {
    const L = this.life, R = L.reef;
    const jobs = [];
    // red reef crab: walks sideways; its legs reach along x
    jobs.push(critter(L, 'redcrab', { legA: [1, 0.18, 0.42, 9] }).then(m => this.items.push(new Crab(L, m, sizeOf('redcrab', 0.2), sandAt(R, 0.42, 0.9), true))));
    // hermit crab: the crab end is +x, legs reach sideways (z)
    jobs.push(critter(L, 'hermitcrab', { legA: [0, 0.08, 0.3, 14], legB: [0.02, 0, 0, 0] }).then(m => this.items.push(new Crab(L, m, sizeOf('hermitcrab', 0.17), sandAt(R, 0.5, 0.95), false))));
    // a blue sea star lying on the sand, arms curling a little
    jobs.push(critter(L, 'starfish', { sway: [0.0, 0.0, 0.25, 0] }).then(m => {
      const p = sandAt(R, 0.27, 0.93);
      m.scale.setScalar(sizeOf('starfish', 0.24)); m.rotation.set(-Math.PI / 2, rand(0, TAU), 0, 'YXZ');
      m.position.copy(p).add(new THREE.Vector3(0, 0.012, 0));
      contactShadow(L.scene, p, 0.3, 0.3);
      this.items.push({ update: (dt, t) => { m.position.x += Math.sin(t * 0.01) * 0.00005; } });
    }));
    // long-spined urchin by the foot of the bommie
    jobs.push(critter(L, 'urchin', { sway: [0.05, 0.22, 0, 0] }).then(m => {
      const p = sandAt(R, 0.57, 0.8);
      m.scale.setScalar(sizeOf('urchin', 0.3)); m.position.copy(p).add(new THREE.Vector3(0, sizeOf('urchin', 0.3) * 0.2, 0));
      contactShadow(L.scene, p, 0.35, 0.4);
    }));
    // cleaner shrimp on the coral, antennae waving, swaying to advertise its station
    jobs.push(critter(L, 'shrimp', { legA: [0, 0.05, 0.2, 10], legB: [-9, 0.05, 0, 0] }).then(m => {
      const s = R.pointAt(0.47, 0.66);
      const toCam = new THREE.Vector3(-s.x, 0, -s.z).normalize();
      const p = s.clone().addScaledVector(toCam, 0.06);
      m.scale.setScalar(sizeOf('shrimp', 0.13));
      const yaw0 = Math.atan2(-toCam.z, toCam.x) + rand(-0.6, 0.6);
      L.cleaner = p.clone().addScaledVector(toCam, 0.35);
      this.items.push({ update: (dt, t) => {
        const u = m.userData.u; u.uPhase.value = t * 3; u.uAmp.value = 0.25 + 0.25 * Math.sin(t * 0.5);
        m.position.copy(p).add(new THREE.Vector3(0, Math.abs(Math.sin(t * 0.9)) * 0.01, 0));
        m.rotation.set(0, yaw0 + Math.sin(t * 1.3) * 0.25, 0);
      } });
    }));
    await Promise.all(jobs);
  }
  update(dt, t, env) { for (const it of this.items) it.update(dt, t, env); }
}


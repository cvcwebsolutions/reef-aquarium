// Jellyfish and the clownfish anemone: procedural geometry, so they pulse and sway freely.
import * as THREE from 'three';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------------------------------------------
// Moon jellies (Aurelia): a translucent bell with four lavender gonad rings, a fringe of fine tentacles and four
// frilly oral arms. Each one pulses at its own rhythm, rises a little with each beat and drifts with the current;
// by day they catch the light from above, at night they glow faintly.
export class Jellies {
  constructor(scene, reef, WATER, n = 5) {
    this.reef = reef; this.list = [];
    const pulse = /* glsl */`
      uniform float uPhase, uR, uTime;
      // fast contraction, slow relaxation
      float contraction(float ph) { float p = fract(ph); return p < 0.28 ? smoothstep(0.0, 0.28, p) : 1.0 - smoothstep(0.28, 1.0, p); }
    `;
    // bell: lathe profile, a flattened dome whose rim curls down a little
    const prof = [];
    for (let k = 0; k <= 24; k++) {
      const t = k / 24, a = t * Math.PI * 0.5;
      prof.push(new THREE.Vector2(Math.sin(a) * (1 + 0.04 * t), Math.cos(a) * 0.48 - (t > 0.85 ? (t - 0.85) * 0.9 : 0)));
    }
    const bellGeo = new THREE.LatheGeometry(prof, 48);
    const bellMat = new THREE.ShaderMaterial({
      uniforms: { ...WATER.uniforms, uPhase: { value: 0 }, uR: { value: 0.15 }, uGlow: { value: 0 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      vertexShader: pulse + /* glsl */`
        varying vec3 vN, vWorld, vLocal;
        void main() {
          float c = contraction(uPhase);
          vec3 p = position;
          float rim = clamp(length(p.xz), 0.0, 1.0);
          p.xz *= 1.0 - 0.20 * c * (0.3 + 0.7 * rim);
          p.y *= 1.0 + 0.22 * c;
          vLocal = position;
          vec4 w = modelMatrix * vec4(p * uR, 1.0);
          vWorld = w.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uGlow;
        varying vec3 vN, vWorld, vLocal;
        ${WATER.glsl}
        void main() {
          vec3 v = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - abs(dot(normalize(vN), v)), 2.2);
          float r = length(vLocal.xz);
          float ang = atan(vLocal.z, vLocal.x);
          // four horseshoe gonads around the centre
          float lobe = pow(abs(cos(ang * 2.0)), 0.6);
          float ring = smoothstep(0.08, 0.0, abs(r - (0.32 + 0.06 * lobe))) * smoothstep(0.55, 0.15, abs(cos(ang * 2.0 + 1.57)));
          float canals = smoothstep(0.02, 0.0, abs(fract(ang / 6.28318 * 16.0) - 0.5) * r) * smoothstep(0.35, 0.9, r) * 0.35;
          float light = 0.55 + 0.45 * clamp(vN.y, 0.0, 1.0);
          vec3 col = vec3(0.80, 0.88, 0.98) * (0.35 + 0.65 * light) * mix(0.35, 1.0, uDay);
          col = mix(col, vec3(0.82, 0.62, 0.92), ring * 0.8);
          col += vec3(0.6, 0.85, 1.0) * uGlow * (0.4 * fres + 0.6 * ring);
          float a = 0.13 + 0.62 * fres + 0.38 * ring + canals * 0.5 + uGlow * 0.15;   // a touch more body: by day they vanished into the bright water
          // fade into the blue with distance
          float d = length(vWorld - cameraPosition);
          float f = 1.0 - exp(-d * uFogDensity * 1.1);
          col = mix(grade(col), waterColor(normalize(vWorld - cameraPosition)), f);
          gl_FragColor = vec4(col, clamp(a, 0.0, 0.85) * (1.0 - f * 0.85));
          #include <colorspace_fragment>
        }`,
    });
    // fringe tentacles: line strips hanging from the rim
    const NT = 72, NS = 10;
    const tPos = [], tAttr = [];
    for (let i = 0; i < NT; i++) for (let s = 0; s < NS; s++) {
      for (const ss of [s, s + 1]) { tPos.push(0, 0, 0); tAttr.push(i / NT, ss / NS, rand(0.6, 1.3), rand(0, TAU)); }
    }
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.Float32BufferAttribute(tPos, 3));
    tGeo.setAttribute('aT', new THREE.Float32BufferAttribute(tAttr, 4));
    const lineMat = (len, alpha, arms) => new THREE.ShaderMaterial({
      uniforms: { ...WATER.uniforms, uPhase: { value: 0 }, uR: { value: 0.15 }, uGlow: { value: 0 }, uVel: { value: new THREE.Vector3() } },
      transparent: true, depthWrite: false, toneMapped: false,
      vertexShader: pulse + /* glsl */`
        attribute vec4 aT; uniform vec3 uVel; varying float vS; varying vec3 vWorld;
        void main() {
          float ang = aT.x * 6.28318, s = aT.y;
          float c = contraction(uPhase - s * 0.18);   // the beat runs down the tentacles a moment later
          float rr = ${arms ? '0.12' : '1.0 - 0.20 * c'};
          vec3 p = vec3(cos(ang) * rr, ${arms ? '-0.05' : '-0.02'}, sin(ang) * rr);
          float L = ${len.toFixed(2)} * aT.z;
          p.y -= s * L * (1.0 + clamp(uVel.y, -0.3, 0.6) * 0.5);   // stretched out behind a push, bunched when sinking
          // sway and trail: lower parts lag behind the bell's motion and drift in the water
          float sway = sin(uTime * 0.9 + aT.w + s * 3.0) * 0.12 * s + sin(uTime * 0.37 + aT.w * 2.0) * 0.08 * s * s;
          p.x += cos(ang) * (sway + 0.15 * s * c) - uVel.x * s * s * 2.5;
          p.z += sin(ang) * (sway + 0.15 * s * c) - uVel.z * s * s * 2.5;
          ${arms ? 'p.x += sin(s * 9.0 + uTime + aT.w) * 0.05 * s; p.z += cos(s * 7.0 + uTime * 0.8 + aT.w) * 0.05 * s;' : ''}
          vS = s;
          vec4 w = modelMatrix * vec4(p * uR, 1.0); vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uGlow; varying float vS; varying vec3 vWorld;
        ${WATER.glsl}
        void main() {
          vec3 col = ${arms ? 'vec3(0.85, 0.75, 0.95)' : 'vec3(0.85, 0.92, 1.0)'} * mix(0.4, 1.0, uDay) + vec3(0.5, 0.8, 1.0) * uGlow * 0.5;
          float d = length(vWorld - cameraPosition);
          float f = 1.0 - exp(-d * uFogDensity * 1.1);
          col = mix(grade(col), waterColor(normalize(vWorld - cameraPosition)), f);
          gl_FragColor = vec4(col, ${alpha.toFixed(2)} * (1.0 - vS * 0.8) * (1.0 - f));
          #include <colorspace_fragment>
        }`,
    });
    // oral arms: 4 long frilly strands, drawn as several lines each
    const NA = 4 * 7, NAS = 16;
    const aPos = [], aAttr = [];
    for (let i = 0; i < NA; i++) {
      const arm = Math.floor(i / 7), off = (i % 7 - 3) * 0.035;
      for (let s = 0; s < NAS; s++) for (const ss of [s, s + 1]) { aPos.push(0, 0, 0); aAttr.push(arm / 4 + 0.125 + off, ss / NAS, rand(0.9, 1.1), arm * 1.7 + i * 0.3); }
    }
    const aGeo = new THREE.BufferGeometry();
    aGeo.setAttribute('position', new THREE.Float32BufferAttribute(aPos, 3));
    aGeo.setAttribute('aT', new THREE.Float32BufferAttribute(aAttr, 4));

    for (let k = 0; k < n; k++) {
      const g = new THREE.Group();
      const bm = bellMat.clone(), tm = lineMat(0.55, 0.22, false), am = lineMat(1.1, 0.30, true);
      for (const m of [bm, tm, am]) Object.assign(m.uniforms, WATER.uniforms, { uPhase: { value: 0 }, uR: { value: 0.15 }, uGlow: { value: 0 }, uVel: m.uniforms.uVel || { value: new THREE.Vector3() } });
      const bell = new THREE.Mesh(bellGeo, bm), fringe = new THREE.LineSegments(tGeo, tm), arms = new THREE.LineSegments(aGeo, am);
      bell.renderOrder = 22; fringe.renderOrder = 21; arms.renderOrder = 20;
      for (const o of [bell, fringe, arms]) { o.frustumCulled = false; g.add(o); }
      scene.add(g);
      const j = { g, mats: [bm, tm, am], R: rand(0.20, 0.32), rate: rand(0.55, 0.85), ph: rand(0, 1),
        vel: new THREE.Vector3(), axis: new THREE.Vector3(0, 1, 0), aim: new THREE.Vector3(0, 1, 0), spin: rand(0, TAU),
        target: new THREE.Vector3(), mode: 'swim', modeT: rand(5, 30), stay: rand(600, 1500), leaving: false,
        alive: false, wait: 0 };
      this.list.push(j);
    }
    // all six in view from the start, each somewhere in the middle of the water
    this.list.forEach(j => this.spawn(j, true));
  }
  // a place in the middle of the water column, in the picture, clear of the reef and below the bright top band
  spot(j, d = rand(3.4, 7.5)) {
    const { fx, fy, cx, cy } = this.reef.info;
    for (let k = 0; k < 30; k++) {
      const u = rand(0.12, 0.88), v = rand(0.22, 0.55);
      const p = new THREE.Vector3((u - cx) / fx * d, -(v - cy) / fy * d, -d);
      if (p.y < this.reef.height(p) + j.R * 5 + 0.5) continue;
      return p;
    }
    return new THREE.Vector3((0.5 - cx) / fx * d, -(0.3 - cy) / fy * d, -d);
  }
  // the band of height it may use at this distance and place: over the reef with its arms clear, under the top band
  band(j, pos) {
    const { fy, cy } = this.reef.info, d = Math.max(1, -pos.z);
    return [this.reef.height(pos) + j.R * 4.5 + 0.35, -(0.16 - cy) / fy * d];
  }
  spawn(j, inView = false) {
    const d = rand(3.4, 7.5);
    const { fx, fy, cx, cy } = this.reef.info;
    if (inView) j.g.position.copy(this.spot(j, d));
    else {
      // a newcomer drifts in from just outside a side of the picture (its own width off screen)
      const off = (j.R * 2.5) / (d / fx), u = Math.random() < 0.5 ? -off : 1 + off, v = rand(0.2, 0.45);
      j.g.position.set((u - cx) / fx * d, -(v - cy) / fy * d, -d);
      const [lo] = this.band(j, j.g.position); j.g.position.y = Math.max(j.g.position.y, lo);
    }
    j.target.copy(this.spot(j));
    j.vel.set(0, 0, 0); j.axis.set(0, 1, 0); j.aim.set(0, 1, 0);
    j.mode = 'swim'; j.modeT = rand(10, 35); j.stay = rand(600, 1500); j.leaving = false;
    j.alive = true; j.g.visible = true;
  }
  // Moon jellies swim. Each beat of the bell pushes it a hand's
  // breadth along its axis, then it coasts and sinks a little until the next one; it tilts its bell towards where it
  // is going, so it wanders up, across and back down through the middle of the water, in bouts of steady pulsing with
  // rests between, when it drifts and slowly sinks. Now and then one drifts off past a side and another comes in.
  update(dt, t, env) {
    const night = 1 - env.day;
    const { fx } = this.reef.info;
    const up = new THREE.Vector3(0, 1, 0), to = new THREE.Vector3(), q = new THREE.Quaternion(), qs = new THREE.Quaternion(), lv = new THREE.Vector3();
    const leaving = this.list.some(j => j.alive && j.leaving);
    for (const j of this.list) {
      // (the order matters: until 16 Nov the line hid every jellyfish in the same breath as it brought it back)
      if (!j.alive) { j.g.visible = false; j.wait -= dt; if (j.wait < 0) this.spawn(j); continue; }
      const pos = j.g.position, d = -pos.z;
      // bouts: swimming steadily, then resting (weak, slower beats) for a while
      if ((j.modeT -= dt) <= 0) { j.mode = j.mode === 'swim' ? 'rest' : 'swim'; j.modeT = j.mode === 'swim' ? rand(14, 40) : rand(5, 16); }
      // after a good while one at a time drifts off past the side nearer to it
      if (!j.leaving && (j.stay -= dt) <= 0 && !leaving) {
        j.leaving = true; j.mode = 'swim';
        const q0 = this.reef.project(pos), side = q0 && q0.u < 0.5 ? -0.5 : 1.5;
        j.target.set((side - this.reef.info.cx) / fx * d, pos.y + rand(-0.3, 0.6), -d);
      }
      to.copy(j.target).sub(pos);
      if (!j.leaving && to.length() < j.R * 2.5) j.target.copy(this.spot(j, THREE.MathUtils.clamp(d + rand(-1.5, 1.5), 3.4, 7.5)));
      const [lo, hi] = this.band(j, pos);
      let strength = j.mode === 'swim' ? 1 : 0.3;
      // it can't swim down: for a target below it eases off and sinks towards it, tilting a little that way
      if (to.y < -0.25 && pos.y > lo + 0.2) strength *= 0.35;
      if (pos.y > hi) strength = 0.15;                    // up in the bright band: let it sink back
      if (pos.y < lo) { strength = 1.5; to.y = Math.max(to.y, 1); }   // over the coral: up and away from it
      // the bell leans towards where it is going (at most ~35 degrees), and turns slowly
      const hd = Math.hypot(to.x, to.z), lean = THREE.MathUtils.clamp(hd * 0.5, 0, 0.7) * (strength > 0.5 ? 1 : 0.5);
      j.aim.set(hd > 1e-4 ? to.x / hd * lean : 0, 1, hd > 1e-4 ? to.z / hd * lean : 0).normalize();
      j.axis.lerp(j.aim, 1 - Math.exp(-dt * 0.35)).normalize();
      // the beat: a quick contraction (thrust), a slow relaxation (it coasts); slower beats when resting
      j.ph += dt * j.rate * (j.mode === 'swim' ? 1 : 0.7);
      const p = j.ph % 1, thrust = p < 0.28 ? Math.sin(p / 0.28 * Math.PI) : 0;
      const k = 1.0 * (j.R / 0.25) * strength;
      j.vel.addScaledVector(j.axis, thrust * k * dt);
      j.vel.y -= 0.085 * dt;                              // heavier than the water: it sinks between bouts
      j.vel.multiplyScalar(Math.exp(-dt * 1.6));          // the water stops it between beats
      // a slow current, and room for each other
      j.vel.x += Math.sin(t * 0.021 + j.R * 40) * 0.004 * dt;
      for (const o of this.list) {
        if (o === j || !o.alive) continue;
        lv.copy(pos).sub(o.g.position); const r = (j.R + o.R) * 3, dd = lv.length();
        if (dd < r && dd > 1e-3) j.vel.addScaledVector(lv, (r - dd) / r / dd * 0.05 * dt);
      }
      // keep a distance where it can be seen
      if (d < 3.2) j.vel.z -= 0.02 * dt; else if (d > 8) j.vel.z += 0.02 * dt;
      pos.addScaledVector(j.vel, dt);
      // the bell's axis, a slow turn about it, a little wobble
      j.spin += dt * 0.05;
      q.setFromUnitVectors(up, j.axis); qs.setFromAxisAngle(up, j.spin);
      j.g.quaternion.copy(q).multiply(qs);
      j.g.rotateX(Math.sin(t * 0.2 + j.R * 50) * 0.04); j.g.rotateZ(Math.cos(t * 0.17 + j.R * 30) * 0.04);
      // the arms and tentacles trail: the water's motion past the bell, in the bell's own frame
      lv.copy(j.vel).applyQuaternion(qs.copy(j.g.quaternion).invert()).multiplyScalar(1 / j.R);
      for (const m of j.mats) {
        m.uniforms.uPhase.value = j.ph; m.uniforms.uR.value = j.R; m.uniforms.uGlow.value = night * 1.3;
        if (m.uniforms.uVel) m.uniforms.uVel.value.copy(lv);
      }
      // gone past a side: another comes in from a side soon after
      const pq = this.reef.project(pos);
      const off = (j.R * 3) / (d / fx);
      if (!pq || pq.u < -off - 0.02 || pq.u > 1 + off + 0.02) { j.alive = false; j.wait = j.leaving ? rand(1, 4) : 0.5; }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A big carpet/bubble-tip anemone on the sand: a few hundred tentacles swaying in the surge, rose-pink with pale
// tips, faintly fluorescent green at the centre and at night. Home of the clownfish pair.
export class Anemone {
  constructor(scene, reef, waterify, at, size = 0.9) {
    this.pos = at.clone(); this.size = size;
    const N = 300;
    const tent = new THREE.CylinderGeometry(0.5, 0.5, 1, 7, 10, false);
    tent.translate(0, 0.5, 0);
    // finger-like tentacles, slightly thicker at the base, rounded at the tip (a magnificent anemone)
    const p = tent.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const r = (1.0 - 0.35 * y) * (y > 0.9 ? Math.sqrt(Math.max(0.02, 1 - Math.pow((y - 0.9) / 0.1, 2))) : 1);
      p.setX(i, p.getX(i) * r); p.setZ(i, p.getZ(i) * r);
    }
    tent.computeVertexNormals();
    const attr = new Float32Array(N * 4);
    const mats = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), e = new THREE.Euler();
    const R = size / 2;
    for (let i = 0; i < N; i++) {
      const rr = Math.sqrt((i + 0.5) / N) * R * 0.92, a = i * ga;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const out = rr / R;
      const len = size * rand(0.2, 0.3) * (1.0 - 0.3 * out);
      const tilt = out * 1.15 + rand(-0.25, 0.25);
      e.set(0, -a, 0); q.setFromEuler(e);
      const qt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), tilt);
      q.multiply(qt);
      s.set(size * 0.03, len, size * 0.03);
      M.compose(new THREE.Vector3(x, 0.03 * size * (1 - out), z), q, s);
      mats.push(M.clone());
      attr.set([out, rand(0, TAU), rand(0.7, 1.3), rand(0, 1)], i * 4);
    }
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.0 });
    const im = new THREE.InstancedMesh(tent, mat, N);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    tent.setAttribute('aTent', new THREE.InstancedBufferAttribute(attr, 4));
    waterify(mat, {
      key: 'anemone', caustics: 0.5,
      uniforms: { uSurge: { value: new THREE.Vector2(1, 0.3) } },
      vertexHead: /* glsl */`
        attribute vec4 aTent; uniform vec2 uSurge; uniform float uTime; varying float vH; varying vec4 vT;`,
      vertexBody: /* glsl */`
        {
          float h = position.y;
          vH = h; vT = aTent;
          // bend in tentacle space; the instance matrix carries it out: surge back and forth + each its own wiggle
          float surge = sin(uTime * 0.55 + aTent.x * 1.5) * 0.55 + sin(uTime * 0.23 + 1.0) * 0.3;
          float wig = sin(uTime * (0.9 + aTent.z * 0.6) + aTent.y) * 0.25;
          float b = (surge + wig) * h * h;
          transformed.x += b * 1.2;
          transformed.z += sin(uTime * 0.7 + aTent.y * 2.0) * 0.18 * h * h;
          transformed.y -= abs(b) * 0.15 * h;
        }`,
      fragmentHead: /* glsl */`varying float vH; varying vec4 vT;`,
      fragmentBody: /* glsl */`
        {
          // magnificent anemone: olive-green tentacles going lime-yellow at the tips, a magenta column
          vec3 base = mix(vec3(0.36, 0.42, 0.16), vec3(0.48, 0.50, 0.20), vT.w);
          vec3 tip = mix(vec3(0.75, 0.86, 0.30), vec3(0.95, 0.95, 0.55), smoothstep(0.9, 0.99, vH));
          vec3 c = mix(base, tip, smoothstep(0.45, 0.95, vH));
          c = mix(c, vec3(0.62, 0.12, 0.42), smoothstep(0.18, 0.0, vH) * 0.8);
          float fl = smoothstep(0.7, 0.98, vH) * 0.18;
          outgoingLight = outgoingLight * c * 1.6 + c * fl * (0.35 + 0.65 * (1.0 - uDay));
        }`,
    });
    im.position.copy(at);
    im.frustumCulled = false;
    scene.add(im);
    this.mesh = im;
    // the column / oral disc under the tentacles, and a soft shadow on the sand
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.85, R * 0.95, size * 0.06, 32),
      waterify(new THREE.MeshStandardMaterial({ color: 0xa0205e, roughness: 0.6 }), { key: 'adisc', caustics: 0.4 }));
    disc.position.copy(at).add(new THREE.Vector3(0, size * 0.01, 0));
    scene.add(disc);
    this.shadow = contactShadow(scene, at, size * 1.5, 0.45);
  }
}

// a little cloud of sand kicked up where something lifts off or settles on the sand
export class SandPuffs {
  constructor(scene, WATER, max = 160) {
    this.n = max; this.k = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3); this.age = new Float32Array(max).fill(99);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('age', new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    const m = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { ...WATER.uniforms }, transparent: true, depthWrite: false, toneMapped: false,
      vertexShader: /* glsl */`
        attribute float age; varying float vA;
        void main() {
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (14.0 + age * 18.0) * (3.0 / max(-mv.z, 0.5));
          vA = age < 3.0 ? 0.32 * (1.0 - age / 3.0) * smoothstep(0.0, 0.15, age) : 0.0;
        }`,
      fragmentShader: /* glsl */`
        uniform float uDay; varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5; float r = dot(c, c);
          if (r > 0.25 || vA <= 0.0) discard;
          gl_FragColor = vec4(vec3(0.86, 0.88, 0.84) * mix(0.35, 1.0, uDay), vA * (1.0 - r * 4.0));
          #include <colorspace_fragment>
        }`,
    }));
    m.frustumCulled = false; m.renderOrder = 15;
    scene.add(m);
  }
  burst(at, r, count = 40) {
    for (let i = 0; i < count; i++) {
      const k = this.k = (this.k + 1) % this.n, a = Math.random() * Math.PI * 2, d = Math.random() * r;
      this.pos.set([at.x + Math.cos(a) * d, at.y + 0.01, at.z + Math.sin(a) * d], k * 3);
      this.vel.set([Math.cos(a) * (0.05 + Math.random() * 0.1), 0.04 + Math.random() * 0.08, Math.sin(a) * (0.05 + Math.random() * 0.1)], k * 3);
      this.age[k] = 0;
    }
  }
  update(dt) {
    for (let k = 0; k < this.n; k++) {
      if (this.age[k] > 3) continue;
      this.age[k] += dt;
      const damp = Math.exp(-dt * 1.5);
      for (let c = 0; c < 3; c++) { this.vel[k * 3 + c] *= damp; this.pos[k * 3 + c] += this.vel[k * 3 + c] * dt; }
      this.vel[k * 3 + 1] -= dt * 0.02;
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.age.needsUpdate = true;
  }
}

// a soft dark patch on the sand under something resting on it (the photo has no shadows of our creatures)
export function contactShadow(scene, at, size, strength = 0.4) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: { uS: { value: strength } }, transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.MultiplyBlending, premultipliedAlpha: true,
    vertexShader: 'varying vec2 vU; void main(){ vU = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uS; varying vec2 vU; void main(){ float r = length(vU) * 2.0; float a = uS * (1.0 - smoothstep(0.2, 1.0, r)); gl_FragColor = vec4(vec3(1.0 - a), 1.0); }',
  }));
  m.rotation.x = -Math.PI / 2;
  m.scale.set(size, size, 1);
  m.position.copy(at).add(new THREE.Vector3(0, 0.01, 0));
  m.renderOrder = 5;
  scene.add(m);
  return m;
}

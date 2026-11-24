// The trueline-lint v1 animated fable, built deterministically in Three.js.
// window.renderAt(t) is a pure function of time t (no clock, no Math.random, no cross-frame state).
import * as THREE from 'three';

const TIMING = window.__TIMING__;
const { fps: FPS, palette: PAL, springs: SPR, squash: SQ, events: EV } = TIMING;
const W = TIMING.size[0];
const H = TIMING.size[1];
const SUB = TIMING.motionBlur.subframes;
const SHUTTER = TIMING.motionBlur.shutter;
const col = (hex) => new THREE.Color(hex);
const SANS = '"Segoe UI Variable Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MONO = '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", monospace';

// ---------- maths: closed-form springs & easing ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a, b, s) => a + (b - a) * s;
const smooth = (a, b, x) => {
  const u = clamp((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
function step(kind, t) {
  if (t <= 0) return 0;
  const { zeta, omega } = SPR[kind];
  if (zeta >= 1) return 1 - (1 + omega * t) * Math.exp(-omega * t);
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}
const ev = (name) => EV[name];
const since = (f, name) => (f - EV[name]) / FPS;
const sp = (kind, f, name) => step(kind, since(f, name));

// ---------- renderer & ACES warm filmic grade ----------
const canvas = document.createElement('canvas');
canvas.width = W;
canvas.height = H;
document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const sceneRT = new THREE.WebGLRenderTarget(W, H, {
  type: THREE.HalfFloatType,
  depthBuffer: true,
  samples: 4,
  colorSpace: THREE.LinearSRGBColorSpace,
});
const accumRT = new THREE.WebGLRenderTarget(W, H, {
  type: THREE.HalfFloatType,
  depthBuffer: false,
});
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quadGeo = new THREE.PlaneGeometry(2, 2);
const addMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: sceneRT.texture }, weight: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader:
    'uniform sampler2D map; uniform float weight; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(map, vUv).rgb * weight, 1.); }',
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
});
const grade = TIMING.grade;
const finalMat = new THREE.ShaderMaterial({
  uniforms: {
    map: { value: accumRT.texture },
    frame: { value: 0 },
    vignette: { value: grade.vignette },
    grain: { value: grade.grain },
    exposure: { value: grade.exposure },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    uniform sampler2D map; uniform float frame, vignette, grain, exposure; varying vec2 vUv;
    vec3 aces(vec3 x){ x *= 0.62; return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0., 1.); }
    float hash(vec2 p){ p = fract(p*vec2(443.897, 441.423)); p += dot(p, p.yx+19.19); return fract((p.x+p.y)*p.x); }
    void main(){
      vec3 c = texture2D(map, vUv).rgb * exposure;
      c = aces(c);
      c = mix(c, c * vec3(1.03, 1.0, 0.95), 0.5);
      vec2 d = vUv - 0.5; c *= 1.0 - vignette * dot(d, d) * 2.5;
      c = pow(c, vec3(1.0/2.2));
      c += (hash(gl_FragCoord.xy + frame * 1.37) - 0.5) * grain / 255.0;
      gl_FragColor = vec4(c, 1.);
    }`,
  depthTest: false,
  depthWrite: false,
});
const quad = new THREE.Mesh(quadGeo, addMat);
const quadScene = new THREE.Scene();
quadScene.add(quad);

// ---------- scene & warm daylight rig ----------
const scene = new THREE.Scene();
scene.background = col(PAL.sky);
scene.fog = new THREE.FogExp2(col(PAL.sky), grade.fog);

const key = new THREE.DirectionalLight(col(PAL.key), 3.1);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -4.0;
key.shadow.camera.right = 4.0;
key.shadow.camera.top = 3.5;
key.shadow.camera.bottom = -3.0;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 16;
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);

const rim = new THREE.DirectionalLight(col(PAL.rim), 1.05);
scene.add(rim, rim.target);
scene.add(new THREE.HemisphereLight(col(PAL.fill), col(PAL.desk), 1.45));

const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 90);

// ---------- material & geometry helpers ----------
const std = (color, rough = 0.55, extra = {}) =>
  new THREE.MeshStandardMaterial({ color: col(color), roughness: rough, metalness: 0, ...extra });

function mesh(geo, mat, parent, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}
const box = (w, h, d, mat, parent, x = 0, y = 0, z = 0) =>
  mesh(new THREE.BoxGeometry(w, h, d), mat, parent, x, y, z);
const cyl = (r, h, mat, parent, x = 0, y = 0, z = 0, seg = 28) =>
  mesh(new THREE.CylinderGeometry(r, r, h, seg), mat, parent, x, y, z);
const ball = (r, mat, parent, x = 0, y = 0, z = 0) =>
  mesh(new THREE.SphereGeometry(r, 32, 20), mat, parent, x, y, z);

const brassMat = std(PAL.brass, 0.36, { metalness: 0.25 });
const brassDarkMat = std(PAL.brassDark, 0.42, { metalness: 0.25 });
const inkMat = std(PAL.ink, 0.48);
const paperMat = std(PAL.paper, 0.72);
const woodMat = std(PAL.wood, 0.58);
const steelMat = std(PAL.steel, 0.42, { metalness: 0.18 });
const steelDarkMat = std(PAL.steelDark, 0.45, { metalness: 0.2 });
const redMat = std(PAL.red, 0.38, { emissive: col(PAL.red), emissiveIntensity: 0.15 });
const greenMat = std(PAL.green, 0.38, { emissive: col(PAL.green), emissiveIntensity: 0.12 });
const glassMat = new THREE.MeshStandardMaterial({
  color: col(PAL.glass),
  transparent: true,
  opacity: 0.5,
  roughness: 0.12,
  metalness: 0.08,
});

// ---------- Floor: sunlit architectural map grid + brass-studded ink rail ----------
function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = PAL.desk;
  g.fillRect(0, 0, 1024, 1024);
  g.strokeStyle = PAL.deskLine;
  g.lineWidth = 3;
  for (let i = 0; i <= 8; i += 1) {
    g.beginPath();
    g.moveTo(i * 128, 0);
    g.lineTo(i * 128, 1024);
    g.moveTo(0, i * 128);
    g.lineTo(1024, i * 128);
    g.stroke();
  }
  g.lineWidth = 7;
  g.strokeStyle = '#C7B694';
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(1024, 0);
  g.moveTo(0, 0);
  g.lineTo(0, 1024);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const floorTex = gridTexture();
floorTex.repeat.set(160, 60);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(160, 60),
  new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// The ink rail along the desk with a brass stop at every station
const rail = box(60, 0.012, 0.05, inkMat, scene, 12, 0.006, 1.15);
rail.castShadow = false;
const STATIONS = [0.0, 4.2, 8.4, 12.6, 16.8, 21.0];
for (const sx of STATIONS) {
  const stop = cyl(0.2, 0.014, brassMat, scene, sx, 0.007, 1.15, 40);
  stop.castShadow = false;
  const ring = cyl(0.12, 0.016, paperMat, scene, sx, 0.008, 1.15, 40);
  ring.castShadow = false;
}

// Warm tactile architect desk props (T-square & wooden set-square)
const tSquare = new THREE.Group();
box(0.12, 0.02, 1.1, woodMat, tSquare, 0, 0.01, 0);
box(0.55, 0.025, 0.12, brassDarkMat, tSquare, 0, 0.013, -0.55);
tSquare.position.set(-1.55, 0, -0.8);
tSquare.rotation.y = 0.22;
scene.add(tSquare);

// ---------- Rounded bevelled cards, syntax-highlighted typing & physical falling stamps ----------
function canvasTex(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 16;
  tex.colorSpace = THREE.SRGBColorSpace;
  return { c, g: c.getContext('2d'), tex };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function roundedShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function makeBevelCard(w, h, ct, stand = true) {
  const geo = new THREE.ExtrudeGeometry(roundedShape(w, h, 0.05), {
    depth: 0.032,
    bevelEnabled: true,
    bevelSize: 0.008,
    bevelThickness: 0.008,
    bevelSegments: 2,
    curveSegments: 6,
  });
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i += 1) {
    uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5);
  }
  const grp = new THREE.Group();
  const face = new THREE.MeshStandardMaterial({ map: ct.tex, roughness: 0.52 });
  const body = new THREE.Mesh(geo, [face, paperMat]);
  body.position.set(0, h / 2 + (stand ? 0.06 : 0), -0.016);
  body.castShadow = true;
  body.receiveShadow = true;
  grp.add(body);
  if (stand) {
    box(w * 0.68, 0.03, 0.2, inkMat, grp, 0, 0.015, 0);
  }
  return grp;
}

const KEYWORDS = new Set(['import', 'from', 'export', 'function', 'class', 'try', 'catch', 'return', 'const', 'any']);
function drawCode(g, lines, x0, y0, size, lineH, chars, caret) {
  g.font = `500 ${size}px ${MONO}`;
  g.textBaseline = 'alphabetic';
  const cw = g.measureText('M').width;
  let left = chars;
  lines.forEach((line, li) => {
    let x = x0;
    const y = y0 + li * lineH;
    const toks = line.match(/\/\/.*$|\s+|'[^']*'|"[^"]*"|[A-Za-z_][\w]*|\d+|[^\sA-Za-z_\d]/g) ?? [];
    for (const tok of toks) {
      if (left <= 0) break;
      const part = tok.slice(0, left);
      left -= part.length;
      let color = PAL.ink;
      if (tok.startsWith('//')) color = '#8E806A';
      else if (tok === 'any' || tok === 'push') color = PAL.red;
      else if (KEYWORDS.has(tok)) color = PAL.burnt;
      else if (tok.startsWith("'") || tok.startsWith('"')) color = PAL.green;
      else if (/^[A-Za-z_]\w*$/.test(tok) && line.includes(`${tok}(`)) color = PAL.steel;
      g.fillStyle = color;
      g.fillText(part, x, y);
      x += cw * part.length;
    }
    if (left <= 0 && caret && left > -2) {
      g.fillStyle = PAL.ink;
      g.fillRect(x + 2, y - size * 0.82, size * 0.12, size * 0.98);
    }
    left -= 1;
  });
}

function makeStamp(label, color, w = 0.72, h = 0.22) {
  const ct = canvasTex(560, Math.round(560 * (h / w)));
  const g = ct.g;
  g.clearRect(0, 0, ct.c.width, ct.c.height);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 14;
  roundRect(g, 10, 10, ct.c.width - 20, ct.c.height - 20, 26);
  g.stroke();
  g.fillStyle = 'rgba(251,246,234,0.85)';
  g.fill();
  g.stroke();
  g.fillStyle = color;
  let fontSize = Math.round(ct.c.height * 0.44);
  g.font = `800 ${fontSize}px ${SANS}`;
  const maxW = ct.c.width - 84;
  const measured = g.measureText(label).width;
  if (measured > maxW) {
    fontSize = Math.floor(fontSize * (maxW / measured));
    g.font = `800 ${fontSize}px ${SANS}`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, ct.c.width / 2, ct.c.height / 2 + 2);
  ct.tex.needsUpdate = true;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: ct.tex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  m.renderOrder = 6;
  const grp = new THREE.Group();
  grp.add(m);
  return grp;
}

function applyStamp(stamp, f, eventName, basePos, rotZ) {
  const dt = f - ev(eventName);
  if (dt < -6) {
    stamp.visible = false;
    return 0;
  }
  stamp.visible = true;
  if (dt < 0) {
    const u = (dt + 6) / 6;
    const lift = 0.55 * (1 - u * u);
    const sc = 1.55 - 0.55 * u * u;
    stamp.position.set(basePos[0], basePos[1] + lift, basePos[2] + lift * 0.4);
    stamp.scale.setScalar(sc);
    stamp.rotation.z = rotZ;
    return 0;
  }
  const s = step('object', dt / FPS);
  stamp.position.set(basePos[0], basePos[1], basePos[2]);
  stamp.scale.setScalar(mix(1.14, 1, s));
  stamp.rotation.z = rotZ;
  return (1 - s) * 0.018;
}

// ---------- Mascot: "Plumb" (architectural brass clerk with spectacles, bow tie & drafting gavel) ----------
const plumb = new THREE.Group();
const plumbBody = new THREE.Group();
plumb.add(plumbBody);

const profileCurve = new THREE.SplineCurve([
  new THREE.Vector2(0.001, 0.0),
  new THREE.Vector2(0.06, 0.05),
  new THREE.Vector2(0.14, 0.14),
  new THREE.Vector2(0.22, 0.26),
  new THREE.Vector2(0.265, 0.38),
  new THREE.Vector2(0.25, 0.50),
  new THREE.Vector2(0.19, 0.58),
  new THREE.Vector2(0.12, 0.63),
  new THREE.Vector2(0.001, 0.65),
]);
const torso = mesh(new THREE.LatheGeometry(profileCurve.getPoints(32), 48), brassMat, plumbBody, 0, 0.08, 0);

// Brass cap ring & top loop
const collarRing = mesh(new THREE.TorusGeometry(0.17, 0.022, 12, 32), brassDarkMat, plumbBody, 0, 0.66, 0);
collarRing.rotation.x = Math.PI / 2;
mesh(new THREE.TorusGeometry(0.06, 0.016, 10, 24), brassDarkMat, plumbBody, 0, 0.77, 0);

// Burnt-orange bow tie
const bowL = mesh(new THREE.ConeGeometry(0.048, 0.095, 16), std(PAL.burnt, 0.48), plumbBody, -0.055, 0.26, 0.24);
bowL.rotation.z = Math.PI / 2;
const bowR = mesh(new THREE.ConeGeometry(0.048, 0.095, 16), std(PAL.burnt, 0.48), plumbBody, 0.055, 0.26, 0.24);
bowR.rotation.z = -Math.PI / 2;
ball(0.024, std(PAL.burnt, 0.48), plumbBody, 0, 0.26, 0.245);

// Eyes in round ink glasses + bridge
const eyeWhiteMat = std('#FFFFFF', 0.32);
const eyes = [];
const pupils = [];
for (const sx of [-1, 1]) {
  const eye = ball(0.064, eyeWhiteMat, plumbBody, sx * 0.096, 0.46, 0.236);
  eye.scale.set(1, 1, 0.52);
  eyes.push(eye);
  const pupil = ball(0.032, inkMat, plumbBody, sx * 0.096, 0.46, 0.268);
  pupil.scale.set(1, 1, 0.52);
  pupils.push(pupil);
  const frame = mesh(new THREE.TorusGeometry(0.086, 0.011, 10, 32), inkMat, plumbBody, sx * 0.096, 0.46, 0.266);
  frame.castShadow = false;
}
const bridge = cyl(0.008, 0.044, inkMat, plumbBody, 0, 0.47, 0.268, 8);
bridge.rotation.z = Math.PI / 2;

// Expressive smile & surprised O-mouth
const smile = mesh(new THREE.TorusGeometry(0.048, 0.01, 8, 20, Math.PI), inkMat, plumbBody, 0, 0.36, 0.246);
smile.rotation.z = Math.PI;
const mouthO = ball(0.028, inkMat, plumbBody, 0, 0.35, 0.248);
mouthO.scale.set(1, 1.3, 0.4);
mouthO.visible = false;

// Left hand + articulated right arm holding miniature architect's brass gavel
ball(0.058, brassMat, plumbBody, -0.275, 0.34, 0.04);
const rightArm = new THREE.Group();
rightArm.position.set(0.265, 0.38, 0.04);
plumbBody.add(rightArm);
ball(0.058, brassMat, rightArm, 0.04, -0.04, 0);
const miniGavel = new THREE.Group();
miniGavel.position.set(0.045, -0.04, 0.02);
rightArm.add(miniGavel);
cyl(0.011, 0.22, woodMat, miniGavel, 0, 0.11, 0, 10);
const mgHead = cyl(0.035, 0.125, brassDarkMat, miniGavel, 0, 0.23, 0, 16);
mgHead.rotation.z = Math.PI / 2;

// Warm leather drafting shoes
const shoeMat = std('#5A3B22', 0.58);
for (const sx of [-1, 1]) {
  const foot = ball(0.08, shoeMat, plumb, sx * 0.115, 0.044, 0.05);
  foot.scale.set(1, 0.55, 1.35);
}
scene.add(plumb);

// ---------- Station 0 (x = 0.0): Live typing code card ----------
const st0 = new THREE.Group();
st0.position.set(0.0, 0, 0);
scene.add(st0);

const codeCT = canvasTex(1024, 620);
const codeCard = makeBevelCard(1.88, 1.14, codeCT);
codeCard.position.set(0.75, 0, -0.35);
st0.add(codeCard);

const HERO_CODE = [
  "import { charge } from '../billing';",
  '// ==================================',
  '// Helper function to checkout user',
  'export function checkout(u: any) {',
  "  u.roles.push('admin');",
  '  try { return charge(u); }',
  '  catch (e) {}',
  '}',
];
let lastCodeChars = -1;
function drawHeroCode(chars) {
  if (chars === lastCodeChars) return;
  lastCodeChars = chars;
  const g = codeCT.g;
  const w = codeCT.c.width;
  const h = codeCT.c.height;
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, w, h);
  g.fillStyle = PAL.burnt;
  g.fillRect(0, 0, w, 24);
  g.fillStyle = PAL.ink;
  g.font = `700 28px ${SANS}`;
  g.fillText('packages/auth/src/checkout.ts', 44, 72);
  g.fillStyle = PAL.red;
  roundRect(g, w - 265, 42, 220, 42, 12);
  g.fill();
  g.fillStyle = '#FFF';
  g.font = `700 22px ${SANS}`;
  g.fillText('4 LINT ERRORS', w - 235, 70);
  drawCode(g, HERO_CODE, 44, 146, 30, 56, chars, chars < 230);
  codeCT.tex.needsUpdate = true;
}
drawHeroCode(0);

// ---------- Station 1 (x = 4.2): Cycles triangle + deep module ----------
const st1 = new THREE.Group();
st1.position.set(4.2, 0, 0);
scene.add(st1);

const cycleGroup = new THREE.Group();
cycleGroup.position.set(-0.38, 0.65, -0.2);
st1.add(cycleGroup);

const modPos = [
  new THREE.Vector3(0, 0.46, 0),
  new THREE.Vector3(-0.54, -0.25, 0.08),
  new THREE.Vector3(0.54, -0.25, 0.08),
];
for (const [i, name] of ['auth', 'session', 'billing'].entries()) {
  const ct = canvasTex(420, 200);
  ct.g.fillStyle = '#1E293B';
  ct.g.fillRect(0, 0, 420, 200);
  ct.g.strokeStyle = PAL.brass;
  ct.g.lineWidth = 10;
  ct.g.strokeRect(10, 10, 400, 180);
  ct.g.fillStyle = '#FBF6EA';
  ct.g.font = `700 62px ${MONO}`;
  ct.g.textAlign = 'center';
  ct.g.fillText(name, 210, 122);
  ct.tex.needsUpdate = true;
  const c = makeBevelCard(0.58, 0.27, ct, false);
  c.position.set(modPos[i].x, modPos[i].y - 0.135, modPos[i].z);
  cycleGroup.add(c);
}

function makeEdge(a, b, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, dir.length(), 14), mat.clone());
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  return m;
}
const edgeAB = makeEdge(modPos[0], modPos[1], redMat);
const edgeBC = makeEdge(modPos[1], modPos[2], redMat);
const edgeCA = makeEdge(modPos[2], modPos[0], redMat);
cycleGroup.add(edgeAB, edgeBC, edgeCA);

const snapLine = new THREE.Mesh(
  new THREE.CylinderGeometry(0.015, 0.015, 1.3, 12),
  std(PAL.brass, 0.2, { emissive: col(PAL.brass), emissiveIntensity: 0.75 }),
);
snapLine.position.set(0.28, 0.12, 0.22);
snapLine.rotation.z = -0.75;
cycleGroup.add(snapLine);

const cutStamp = makeStamp('CUT 1 EDGE · CLEAN', PAL.green, 0.96, 0.24);
st1.add(cutStamp);

// Deep module comparator on right of Station 1
const deepGroup = new THREE.Group();
deepGroup.position.set(1.05, 0, -0.25);
st1.add(deepGroup);

const shallowSlices = [];
for (let i = 0; i < 8; i += 1) {
  const sl = box(0.76, 0.06, 0.42, i % 2 === 0 ? steelMat : paperMat, deepGroup, 0, 0.07 + i * 0.11, 0);
  shallowSlices.push(sl);
}

const deepCT = canvasTex(560, 440);
deepCT.g.fillStyle = '#182433';
deepCT.g.fillRect(0, 0, 560, 440);
deepCT.g.strokeStyle = PAL.brass;
deepCT.g.lineWidth = 10;
deepCT.g.strokeRect(10, 10, 540, 420);
deepCT.g.fillStyle = '#38BDF8';
deepCT.g.font = `700 30px ${MONO}`;
deepCT.g.fillText('export { analyze, verify }', 36, 90);
deepCT.g.fillStyle = '#334155';
deepCT.g.fillRect(36, 124, 488, 4);
deepCT.g.fillStyle = '#CBD5E1';
deepCT.g.font = `600 30px ${SANS}`;
deepCT.g.fillText('2 narrow entry points', 36, 194);
deepCT.g.fillStyle = '#34D399';
deepCT.g.font = `700 34px ${SANS}`;
deepCT.g.fillText('14 internals hidden', 36, 256);
deepCT.g.fillStyle = '#94A3B8';
deepCT.g.font = `500 25px ${MONO}`;
deepCT.g.fillText('0 field leaks · 0 cycles', 36, 336);
deepCT.tex.needsUpdate = true;

const deepVault = new THREE.Group();
const deepFace = makeBevelCard(0.88, 0.72, deepCT, false);
deepFace.position.set(0, 0.04, 0);
box(0.92, 0.08, 0.44, brassMat, deepVault, 0, 0.80, -0.02);
deepVault.add(deepFace);
deepGroup.add(deepVault);

const deepStamp = makeStamp('DEEP MODULE', PAL.green, 0.84, 0.22);
deepGroup.add(deepStamp);

// ---------- Station 2 (x = 8.4): Clean Architecture tiers + Anti-slop sweep ----------
const st2 = new THREE.Group();
st2.position.set(8.4, 0, 0);
scene.add(st2);

const layersGroup = new THREE.Group();
layersGroup.position.set(-0.38, 0, -0.25);
st2.add(layersGroup);

const layerMeta = [
  ['UI / ROUTES', PAL.steel],
  ['INFRASTRUCTURE', PAL.steelDark],
  ['APPLICATION', PAL.brassDark],
  ['DOMAIN', PAL.brass],
];
layerMeta.forEach(([lbl, bg], i) => {
  const ct = canvasTex(720, 120);
  ct.g.fillStyle = bg;
  ct.g.fillRect(0, 0, 720, 120);
  ct.g.fillStyle = '#FFF';
  ct.g.font = `800 46px ${SANS}`;
  ct.g.textAlign = 'center';
  ct.g.fillText(lbl, 360, 78);
  ct.tex.needsUpdate = true;
  const tier = new THREE.Mesh(
    new THREE.BoxGeometry(1.38, 0.16, 0.62),
    [paperMat, paperMat, glassMat, paperMat, new THREE.MeshStandardMaterial({ map: ct.tex, roughness: 0.42 }), paperMat],
  );
  tier.position.y = 0.14 + i * 0.27;
  tier.castShadow = true;
  tier.receiveShadow = true;
  layersGroup.add(tier);
});

const layerShield = box(1.54, 0.036, 0.74, glassMat, layersGroup, 0, 0.82, 0);
const rogueArrow = new THREE.Group();
cyl(0.03, 0.42, redMat, rogueArrow, 0, 0, 0, 14);
const arrowCone = mesh(new THREE.ConeGeometry(0.075, 0.16, 14), redMat, rogueArrow, 0, -0.26, 0);
arrowCone.rotation.x = Math.PI;
rogueArrow.position.set(0.32, 1.32, 0.42);
layersGroup.add(rogueArrow);

const layerStamp = makeStamp('LAYER-VIOLATION', PAL.red, 0.96, 0.23);
layersGroup.add(layerStamp);

// Anti-slop cards on right of Station 2
const slopGroup = new THREE.Group();
slopGroup.position.set(1.12, 0, -0.2);
st2.add(slopGroup);

const slopTitles = ['verbose-comment', 'dead-code', 'silent-catch', 'type-escape', 'duplicate-logic'];
const slopCards = slopTitles.map((name, i) => {
  const dirtyCT = canvasTex(620, 110);
  dirtyCT.g.fillStyle = '#2B1618';
  dirtyCT.g.fillRect(0, 0, 620, 110);
  dirtyCT.g.fillStyle = PAL.red;
  dirtyCT.g.fillRect(0, 0, 18, 110);
  dirtyCT.g.fillStyle = '#FECACA';
  dirtyCT.g.font = `700 40px ${MONO}`;
  dirtyCT.g.fillText(name, 40, 72);
  dirtyCT.tex.needsUpdate = true;

  const cleanCT = canvasTex(620, 110);
  cleanCT.g.fillStyle = '#10291D';
  cleanCT.g.fillRect(0, 0, 620, 110);
  cleanCT.g.fillStyle = PAL.green;
  cleanCT.g.fillRect(0, 0, 18, 110);
  cleanCT.g.fillStyle = '#BBF7D0';
  cleanCT.g.font = `700 40px ${MONO}`;
  cleanCT.g.fillText(`✓ ${name}`, 40, 72);
  cleanCT.tex.needsUpdate = true;

  const holder = new THREE.Group();
  holder.position.set(0, 0.15 + i * 0.22, 0);
  const fCard = makeBevelCard(0.96, 0.18, dirtyCT, false);
  fCard.position.set(0, -0.09, 0.012);
  const bCard = makeBevelCard(0.96, 0.18, cleanCT, false);
  bCard.position.set(0, -0.09, -0.012);
  bCard.rotation.y = Math.PI;
  holder.add(fCard, bCard);
  slopGroup.add(holder);
  return holder;
});

const straightedge = box(1.18, 0.055, 0.12, brassMat, slopGroup, 0, 1.32, 0.14);
const slopStamp = makeStamp('ZERO SLOP', PAL.green, 0.78, 0.22);
slopGroup.add(slopStamp);

// ---------- Station 3 (x = 12.6): Executive Dashboard Monitor on Oak-and-Brass Easel ----------
const st3 = new THREE.Group();
st3.position.set(12.6, 0, 0);
scene.add(st3);

box(0.95, 0.08, 0.46, inkMat, st3, 0, 0.04, -0.35);
box(0.16, 0.44, 0.12, brassDarkMat, st3, 0, 0.28, -0.4);

const dashCT = canvasTex(1600, 940);
const dashMonitor = new THREE.Group();
box(2.7, 1.58, 0.08, woodMat, dashMonitor, 0, 0, 0);
box(2.62, 1.52, 0.085, brassDarkMat, dashMonitor, 0, 0, 0.002);
const dashScr = new THREE.Mesh(
  new THREE.PlaneGeometry(2.54, 1.46),
  new THREE.MeshBasicMaterial({ map: dashCT.tex }),
);
dashScr.position.z = 0.047;
dashMonitor.add(dashScr);
dashMonitor.position.set(0, 0.94, -0.32);
st3.add(dashMonitor);

function drawDashboard(progress) {
  const g = dashCT.g;
  const w = dashCT.c.width;
  const h = dashCT.c.height;
  g.fillStyle = '#0D1117';
  g.fillRect(0, 0, w, h);

  g.textAlign = 'left';
  g.fillStyle = '#F8FAFC';
  g.font = `700 32px ${MONO}`;
  g.fillText('$ npx trueline-lint --format dashboard', 48, 66);
  g.textAlign = 'right';
  g.fillStyle = PAL.brass;
  g.font = `700 25px ${SANS}`;
  g.fillText('18 DETERMINISTIC LINTS · NODE 20+ & BUN', w - 48, 64);
  g.textAlign = 'left';

  const kpis = [
    ['TS SCOPE', '64', '2,410 files · 1.2s cached', '#F8FAFC'],
    ['TS FINDINGS', '142', 'Ratcheted in .trueline.allow', '#F59E0B'],
    ['PKG CYCLES', '0 / 0', 'All 6 layer rules clean', '#22C55E'],
    ['HYGIENE', '18', '7 anti-slop checks active', '#38BDF8'],
  ];
  kpis.forEach(([title, val, sub, color], i) => {
    const x = 48 + i * 380;
    const y = 104;
    g.fillStyle = '#151B23';
    roundRect(g, x, y, 356, 176, 18);
    g.fill();
    g.strokeStyle = '#2B3544';
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = '#94A3B8';
    g.font = `600 22px ${SANS}`;
    g.fillText(title, x + 28, y + 44);
    g.fillStyle = color;
    g.font = `800 62px ${SANS}`;
    g.fillText(val, x + 28, y + 114);
    g.fillStyle = '#94A3B8';
    g.font = `500 20px ${SANS}`;
    g.fillText(sub, x + 28, y + 152);
  });

  g.fillStyle = '#151B23';
  roundRect(g, 48, 312, 738, 452, 18);
  g.fill();
  g.strokeStyle = '#2B3544';
  g.stroke();
  g.fillStyle = '#F8FAFC';
  g.font = `700 28px ${SANS}`;
  g.fillText('TypeScript Findings by Lint', 78, 364);
  g.fillStyle = '#94A3B8';
  g.font = `600 22px ${SANS}`;
  g.fillText('142 total', 650, 364);

  [
    ['field-leak', 58, '#3B82F6'],
    ['module-cycle', 24, '#F59E0B'],
    ['layer-violation', 19, '#EF4444'],
    ['shallow-module', 16, '#A855F7'],
    ['silent-catch', 12, '#14B8A6'],
    ['type-escape', 8, '#EC4899'],
    ['duplicate-logic', 5, '#84CC16'],
  ].forEach(([lbl, count, color], i) => {
    const y = 416 + i * 48;
    g.fillStyle = '#CBD5E1';
    g.font = `500 24px ${MONO}`;
    g.fillText(lbl, 78, y);
    g.fillStyle = color;
    roundRect(g, 340, y - 20, Math.max(12, (count / 60) * 330 * progress), 22, 11);
    g.fill();
    g.fillStyle = '#94A3B8';
    g.font = `600 22px ${MONO}`;
    g.fillText(String(count), 696, y);
  });

  g.fillStyle = '#151B23';
  roundRect(g, 814, 312, 738, 452, 18);
  g.fill();
  g.strokeStyle = '#2B3544';
  g.stroke();
  g.fillStyle = '#F8FAFC';
  g.font = `700 28px ${SANS}`;
  g.fillText('Top Hotspot Packages', 844, 364);
  g.fillStyle = '#94A3B8';
  g.font = `600 22px ${SANS}`;
  g.fillText('top 6', 1465, 364);

  [
    ['packages/billing', 41, '#3B82F6'],
    ['apps/admin-portal', 34, '#F59E0B'],
    ['packages/auth-core', 26, '#14B8A6'],
    ['apps/checkout-web', 19, '#A855F7'],
    ['packages/ui-kit', 13, '#EF4444'],
    ['packages/analytics', 9, '#84CC16'],
  ].forEach(([pkg, count, color], i) => {
    const y = 416 + i * 54;
    g.fillStyle = '#CBD5E1';
    g.font = `500 24px ${MONO}`;
    g.fillText(pkg, 844, y);
    g.fillStyle = color;
    roundRect(g, 1168, y - 20, Math.max(12, (count / 45) * 290 * progress), 22, 11);
    g.fill();
    g.fillStyle = '#94A3B8';
    g.font = `600 22px ${MONO}`;
    g.fillText(String(count), 1484, y);
  });

  g.fillStyle = '#151B23';
  roundRect(g, 48, 794, 1504, 102, 18);
  g.fill();
  g.strokeStyle = '#2B3544';
  g.stroke();
  g.fillStyle = '#22C55E';
  g.font = `700 24px ${MONO}`;
  g.fillText('✓ Quick-win cycles: cut 1 edge in billing -> auth (unlocks 3 modules)', 82, 854);
  g.fillStyle = '#38BDF8';
  g.fillText('HTML · SARIF · MARKDOWN · BADGE', 1075, 854);
  dashCT.tex.needsUpdate = true;
}
drawDashboard(0);

// ---------- Station 4 (x = 16.8): Tamper-Proof Ratchet Ledger ----------
const st4 = new THREE.Group();
st4.position.set(16.8, 0, 0);
scene.add(st4);

const ledgerCT = canvasTex(896, 560);
const ledgerCard = makeBevelCard(1.52, 0.96, ledgerCT);
ledgerCard.position.set(0, 0, -0.22);
st4.add(ledgerCard);

let lastLedgerKey = '';
function drawLedger(debt) {
  const keyStr = String(debt);
  if (keyStr === lastLedgerKey) return;
  lastLedgerKey = keyStr;
  const g = ledgerCT.g;
  const w = ledgerCT.c.width;
  const h = ledgerCT.c.height;
  g.fillStyle = PAL.paper;
  g.fillRect(0, 0, w, h);
  g.fillStyle = PAL.brassDark;
  g.fillRect(0, 0, w, 24);
  g.fillStyle = PAL.ink;
  g.font = `800 42px ${MONO}`;
  g.fillText('.trueline.allow', 48, 88);
  g.fillStyle = PAL.steel;
  g.font = `600 24px ${SANS}`;
  g.fillText('TAMPER-PROOF MERGE-ONLY RATCHET LEDGER', 48, 128);
  g.fillStyle = debt === 0 ? PAL.green : PAL.burnt;
  g.font = `800 132px ${SANS}`;
  g.fillText(String(debt), 48, 304);
  g.fillStyle = '#6B6254';
  g.font = `600 30px ${SANS}`;
  g.fillText(debt === 0 ? 'DEBT CLEARED' : 'RATCHETED ENTRIES', 290, 290);
  g.fillStyle = '#E5DAC4';
  roundRect(g, 48, 360, w - 96, 36, 18);
  g.fill();
  g.fillStyle = debt === 0 ? PAL.green : PAL.brass;
  roundRect(g, 48, 360, Math.max(28, (w - 96) * (debt / 142)), 36, 18);
  g.fill();
  g.fillStyle = PAL.ink;
  g.font = `600 25px ${MONO}`;
  g.fillText('github.ratchet = "merge" · branch = "master"', 48, 464);
  ledgerCT.tex.needsUpdate = true;
}
drawLedger(142);

const tamperCT = canvasTex(768, 120);
tamperCT.g.fillStyle = '#3B1115';
tamperCT.g.fillRect(0, 0, 768, 120);
tamperCT.g.fillStyle = PAL.red;
tamperCT.g.fillRect(0, 0, 18, 120);
tamperCT.g.fillStyle = '#FECACA';
tamperCT.g.font = `700 36px ${MONO}`;
tamperCT.g.fillText('PR #42: edit .trueline.allow', 42, 74);
tamperCT.tex.needsUpdate = true;
const tamperCard = makeBevelCard(1.25, 0.24, tamperCT, false);
tamperCard.position.set(0, 1.15, -0.05);
st4.add(tamperCard);

const mergeCT = canvasTex(768, 120);
mergeCT.g.fillStyle = '#0F2A1E';
mergeCT.g.fillRect(0, 0, 768, 120);
mergeCT.g.fillStyle = PAL.green;
mergeCT.g.fillRect(0, 0, 18, 120);
mergeCT.g.fillStyle = '#BBF7D0';
mergeCT.g.font = `700 36px ${MONO}`;
mergeCT.g.fillText('PR #43 -> master · auto-ratchet', 42, 74);
mergeCT.tex.needsUpdate = true;
const mergeCard = makeBevelCard(1.25, 0.24, mergeCT, false);
mergeCard.position.set(0, 1.15, -0.05);
st4.add(mergeCard);

const tamperStamp = makeStamp('BLOCKED', PAL.red, 0.72, 0.23);
const ratchetStamp = makeStamp('TIGHTENED', PAL.green, 0.78, 0.23);
st4.add(tamperStamp, ratchetStamp);

// ---------- Station 5 (x = 21.0): Golden Finale Plaque ----------
const st5 = new THREE.Group();
st5.position.set(21.0, 0, 0);
scene.add(st5);

const endLine = box(4.2, 0.028, 0.028, std(PAL.brass, 0.22, { emissive: col(PAL.brass), emissiveIntensity: 0.6 }), st5, 0.2, 0.74, -0.5);

const endCT = canvasTex(1200, 620);
endCT.g.fillStyle = '#141B26';
endCT.g.fillRect(0, 0, 1200, 620);
endCT.g.strokeStyle = PAL.brass;
endCT.g.lineWidth = 12;
endCT.g.strokeRect(16, 16, 1168, 588);
endCT.g.fillStyle = '#FFFFFF';
endCT.g.font = `800 104px ${SANS}`;
endCT.g.textAlign = 'center';
endCT.g.fillText('trueline-lint', 600, 198);
endCT.g.fillStyle = PAL.brass;
endCT.g.fillRect(360, 234, 480, 7);
endCT.g.fillStyle = '#E2E8F0';
endCT.g.font = `600 38px ${SANS}`;
endCT.g.fillText('Deep modules. Narrow interfaces. Zero slop.', 600, 314);
endCT.g.fillStyle = '#1E293B';
roundRect(endCT.g, 220, 368, 760, 86, 18);
endCT.g.fill();
endCT.g.strokeStyle = '#475569';
endCT.g.lineWidth = 3;
endCT.g.stroke();
endCT.g.fillStyle = '#38BDF8';
endCT.g.font = `700 34px ${MONO}`;
endCT.g.fillText('npx trueline-lint --format dashboard', 600, 422);
endCT.g.fillStyle = '#CBD5E1';
endCT.g.font = `500 28px ${MONO}`;
endCT.g.fillText('github.com/Jordan-Hall/trueline', 600, 520);
endCT.tex.needsUpdate = true;

const endPlaque = makeBevelCard(2.42, 1.24, endCT);
endPlaque.position.set(0.32, 0, -0.35);
st5.add(endPlaque);

// ---------- Plumb hop & gavel choreography ----------
const HOPS = [
  { take: EV.hop1Take, land: EV.hop1Land, fromX: -0.68, toX: 2.85 },
  { take: EV.hop2Take, land: EV.hop2Land, fromX: 2.85, toX: 7.05 },
  { take: EV.hop3Take, land: EV.hop3Land, fromX: 7.05, toX: 10.9 },
  { take: EV.hop4Take, land: EV.hop4Land, fromX: 10.9, toX: 15.45 },
  { take: EV.hop5Take, land: EV.hop5Land, fromX: 15.45, toX: 19.65 },
];

function computePlumbPose(f) {
  let x = -0.68;
  let y = 0;
  let sx = 1;
  let sy = 1;
  let yaw = 0.28;

  if (f < EV.introLand) {
    const u = clamp(f / EV.introLand);
    y = (1 - u * u) * 1.3;
    sy = mix(1.24, 0.78, smooth(0.75, 1, u));
    sx = 1 / Math.sqrt(sy);
  } else if (f < EV.introLand + 18) {
    const s = step('character', (f - EV.introLand) / FPS);
    sy = mix(0.76, 1, s);
    sx = 1 / Math.sqrt(sy);
  }

  for (const h of HOPS) {
    const cf = SQ.crouchFrames;
    if (f >= h.land) {
      x = h.toX;
      if (f < h.land + 16) {
        const s = step('character', (f - h.land) / FPS);
        sy = mix(SQ.land[1], 1, s);
        sx = 1 / Math.sqrt(sy);
      }
    } else if (f >= h.take) {
      const u = (f - h.take) / (h.land - h.take);
      x = mix(h.fromX, h.toX, smooth(0, 1, u));
      y = Math.sin(Math.PI * u) * 0.95;
      sy = u < 0.25 ? SQ.takeoff[1] : u > 0.8 ? 0.85 : 1.08;
      sx = 1 / Math.sqrt(sy);
      yaw = 0.58;
      break;
    } else if (f >= h.take - cf) {
      const u = (f - (h.take - cf)) / cf;
      sy = mix(1, SQ.crouch[1], u);
      sx = 1 / Math.sqrt(sy);
      x = h.fromX;
      break;
    }
  }

  const bob = y === 0 ? Math.sin((f / FPS) * 3.0) * 0.014 : 0;
  return { x, y: y + bob, sx, sy, yaw };
}

function activeShot(f) {
  for (let i = TIMING.shots.length - 1; i >= 0; i -= 1) {
    if (f >= TIMING.shots[i].frame) return TIMING.shots[i];
  }
  return TIMING.shots[0];
}

function setSceneAt(t) {
  const f = t * FPS;
  const shot = activeShot(f);
  const u = clamp((f - shot.frame) / shot.frames);

  camera.fov = 2 * Math.atan(24 / (2 * shot.lens)) * (180 / Math.PI);
  camera.updateProjectionMatrix();
  camera.position.set(
    shot.x + shot.cam[0] + shot.drift[0] * u,
    shot.cam[1] + shot.drift[1] * u,
    shot.cam[2] + shot.drift[2] * u,
  );
  camera.lookAt(
    shot.x + shot.look[0] + shot.drift[0] * 0.4 * u,
    shot.look[1] + shot.drift[1] * 0.4 * u,
    shot.look[2],
  );

  key.position.set(shot.x + 3.2, 5.0, 4.0);
  key.target.position.set(shot.x, 0.5, 0);
  key.target.updateMatrixWorld();
  rim.position.set(shot.x - 2.6, 3.0, -3.5);
  rim.target.position.set(shot.x, 0.5, 0);
  rim.target.updateMatrixWorld();

  // Plumb animation + reactions
  const pose = computePlumbPose(f);
  plumb.position.set(pose.x, pose.y, 0.42);
  plumbBody.scale.set(pose.sx, pose.sy, pose.sx);
  plumb.rotation.y = pose.yaw + Math.sin(t * 1.4) * 0.07;

  const blink = (f % 110) > 105 ? 0.1 : 1;
  for (const e of eyes) e.scale.y = blink;
  for (const p of pupils) p.scale.y = blink;

  const shocked =
    (f >= EV.layerBonk && f < EV.layerBonk + 32) || (f >= EV.tamperBonk && f < EV.tamperBonk + 38);
  smile.visible = !shocked;
  mouthO.visible = shocked;

  // Gavel swing on impacts
  let swing = 0;
  for (const evName of ['cycleCut', 'layerBonk', 'slopSweep', 'tamperBonk', 'endSnap']) {
    const dt = f - ev(evName);
    if (dt >= -8 && dt <= 22) {
      swing = dt < 0 ? ((dt + 8) / 8) * 0.85 : 0.85 * Math.exp(-dt * 0.18) * Math.cos(dt * 0.5);
    }
  }
  rightArm.rotation.x = -0.25 - swing;

  // Station 0: live code typing
  const s0 = sp('ui', f, 'heroCodeStart');
  codeCard.scale.setScalar(Math.max(0.001, s0));
  if (f >= EV.heroCodeStart - 5 && f <= EV.hop1Take + 10) {
    const typed = Math.floor(clamp((f - EV.heroCodeStart) / 135) * 235);
    drawHeroCode(typed);
  }

  // Station 1: Cycle snap + deep module compression
  const cleared = f >= EV.cycleCut + 6;
  cycleGroup.rotation.z = cleared ? 0 : Math.sin(t * 2.5) * 0.13;
  edgeCA.visible = !cleared;
  const eCol = cleared ? col(PAL.green) : col(PAL.red);
  edgeAB.material.color.copy(eCol);
  edgeAB.material.emissive.copy(eCol);
  edgeBC.material.color.copy(eCol);
  edgeBC.material.emissive.copy(eCol);
  const snapP = sp('object', f, 'cycleCut');
  snapLine.visible = f >= EV.cycleCut && f < EV.cycleCut + 28;
  snapLine.scale.set(1, clamp(snapP * 1.2), 1);
  applyStamp(cutStamp, f, 'cycleStamp', [-0.38, 1.32, 0.1], -0.06);

  const comp = sp('object', f, 'deepComp');
  shallowSlices.forEach((sl, i) => {
    sl.visible = comp < 0.72;
    sl.position.y = mix(0.07 + i * 0.11, 0.38, comp);
    sl.scale.setScalar(1 - comp * 0.35);
  });
  deepVault.scale.setScalar(Math.max(0.001, comp));
  applyStamp(deepStamp, f, 'deepStamp', [0, 1.06, 0.25], -0.04);

  // Station 2: Layers & slop sweep
  const arr = sp('object', f, 'layerArrow');
  const bonk = sp('character', f, 'layerBonk');
  if (f < EV.layerBonk) {
    rogueArrow.position.set(0.32, mix(1.48, 0.92, arr), 0.42);
    rogueArrow.rotation.z = 0;
  } else {
    rogueArrow.position.set(mix(0.32, 0.82, bonk), mix(0.92, 1.38, bonk), 0.42);
    rogueArrow.rotation.z = bonk * 1.1;
  }
  layerShield.material.opacity = f >= EV.layerBonk && f < EV.layerBonk + 30 ? 0.88 : 0.38;
  applyStamp(layerStamp, f, 'layerStamp', [0, 1.36, 0.32], -0.06);

  const slopIn = sp('ui', f, 'slopCards');
  const sweepP = smooth(EV.slopSweep, EV.slopSweep + 48, f);
  straightedge.visible = f >= EV.slopSweep - 10 && f <= EV.slopSweep + 70;
  straightedge.position.y = mix(1.36, 0.04, sweepP);
  slopCards.forEach((card, i) => {
    card.scale.setScalar(Math.max(0.001, slopIn));
    card.rotation.y = smooth((4 - i) / 5, (4 - i) / 5 + 0.18, sweepP) * Math.PI;
  });
  applyStamp(slopStamp, f, 'slopStamp', [0, 1.34, 0.22], 0.05);

  // Station 3: Dashboard monitor
  const dIn = sp('object', f, 'dashRise');
  dashMonitor.position.y = mix(-0.4, 0.94, dIn);
  dashMonitor.scale.setScalar(Math.max(0.001, dIn));
  if (f >= EV.hop3Take && f <= EV.hop4Land + 10) {
    drawDashboard(clamp(sp('ui', f, 'dashBars')));
  }

  // Station 4: Tamper-proof ledger
  const tIn = sp('ui', f, 'tamperSlide');
  const mIn = sp('ui', f, 'mergeSlide');
  tamperCard.position.x = mix(-1.8, 0, tIn);
  tamperCard.visible = f >= EV.tamperSlide - 4 && f < EV.mergeSlide;
  mergeCard.position.x = mix(1.8, 0, mIn);
  mergeCard.visible = f >= EV.mergeSlide - 4;
  const dip1 = applyStamp(tamperStamp, f, 'tamperStamp', [0.36, 0.72, 0.06], -0.14);
  if (f >= EV.mergeSlide) tamperStamp.visible = false;
  const dip2 = applyStamp(ratchetStamp, f, 'ratchetStamp', [0.36, 0.72, 0.06], -0.08);
  ledgerCard.position.y = -(dip1 + dip2);

  if (f >= EV.hop4Take && f <= EV.hop5Land + 10) {
    let debt = 142;
    if (f >= EV.ratchet3) debt = 0;
    else if (f >= EV.ratchet2) debt = 34;
    else if (f >= EV.ratchet1) debt = 98;
    drawLedger(debt);
  }

  // Station 5: Finale
  endLine.scale.set(Math.max(0.001, sp('object', f, 'endSnap')), 1, 1);
  const titleIn = sp('ui', f, 'endTitle');
  endPlaque.scale.setScalar(Math.max(0.001, titleIn));
}

window.renderAt = function renderAt(t) {
  renderer.setRenderTarget(accumRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();

  const dt = SHUTTER / FPS / SUB;
  addMat.uniforms.weight.value = 1 / SUB;
  for (let s = 0; s < SUB; s += 1) {
    setSceneAt(Math.max(0, t - (s - (SUB - 1) / 2) * dt));
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(accumRT);
    quad.material = addMat;
    renderer.render(quadScene, quadCam);
  }

  finalMat.uniforms.frame.value = Math.round(t * FPS);
  renderer.setRenderTarget(null);
  quad.material = finalMat;
  renderer.render(quadScene, quadCam);
};

window.grab = function grab(t, quality = 0.94) {
  window.renderAt(t);
  return canvas.toDataURL('image/jpeg', quality).slice(23);
};

Promise.all([document.fonts.ready]).then(() => {
  window.__ready = true;
});

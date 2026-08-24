#!/usr/bin/env python3
"""Build a Three.js viewer over the per-pano textured meshes.

Reads <run_dir>/derived/pano_mesh/index.json and the per-pano binary
buffers + texture images, emits a single HTML at
<run_dir>/3d_viewer_meshfused.html.

The viewer uses one BufferGeometry + MeshBasicMaterial per pano, with the
pano's own equirect JPG as texture. Triangles are grouped by class so the
user can toggle facade / ground / roof / oblique on/off; an additional
toggle hides individual panos.

Must be served over HTTP (file:// blocks fetch). Bundled serve.py works:

    python3 src/py/viewers/serve.py data/raw/google_maps/spatial/<site>/<run-id>/

then open http://localhost:8765/3d_viewer_meshfused.html

Usage:
  python3 build_meshfused_viewer.py <run_dir>
"""
import argparse
import json
import os
import sys


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mesh-fused street view viewer</title>
<style>
html, body { margin: 0; height: 100%; overflow: hidden; background: #000; color: #ddd;
  font: 12px/1.4 -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif; }
#app { position: fixed; inset: 0; }
#hud { position: fixed; top: 12px; left: 12px; padding: 12px 14px;
  background: rgba(15, 18, 25, 0.86); border: 1px solid #2a313d; border-radius: 8px;
  max-width: 320px; max-height: calc(100vh - 24px); overflow-y: auto;
  backdrop-filter: blur(6px); }
#hud h1 { margin: 0 0 6px; font-size: 13px; color: #fff; font-weight: 600; }
#hud .stat { color: #8a93a4; font-size: 11px; margin-bottom: 8px; }
#hud .row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
#hud label { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
#hud input[type=checkbox] { accent-color: #4ea0ff; }
#hud input[type=range] { width: 130px; accent-color: #4ea0ff; }
#hud .group { margin-top: 8px; padding-top: 8px; border-top: 1px solid #232934; }
#hud .gtitle { color: #aab1bd; font-size: 11px; text-transform: uppercase;
  letter-spacing: .04em; margin-bottom: 4px; }
#pano-list { max-height: 260px; overflow-y: auto; padding-right: 4px; }
#pano-list label { font-size: 11px; color: #c8cdd5; }
#pano-list label code { font-family: ui-monospace, Menlo, monospace;
  color: #6f7787; font-size: 10px; }
#pano-list .swatch { width: 8px; height: 8px; border-radius: 2px; }
button { background: #1f2632; color: #ddd; border: 1px solid #2e3744;
  padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
button:hover { background: #2a3340; }
#status { position: fixed; bottom: 12px; left: 12px; color: #8a93a4; font-size: 11px;
  background: rgba(15, 18, 25, 0.7); padding: 6px 10px; border-radius: 6px; }
#cmds { position: fixed; bottom: 12px; right: 12px; color: #8a93a4; font-size: 11px;
  background: rgba(15, 18, 25, 0.7); padding: 6px 10px; border-radius: 6px;
  text-align: right; line-height: 1.6; }
#cmds kbd { color: #c8cdd5; background: #232934; border: 1px solid #303948;
  padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
<div id="app"></div>
<div id="hud">
  <h1>Mesh-fused street view</h1>
  <div class="stat" id="globalStats"></div>

  <div class="group">
    <div class="gtitle">Mode</div>
    <div class="row"><label><input type="radio" name="mode" value="texture" checked> Photo texture</label></div>
    <div class="row"><label><input type="radio" name="mode" value="class"> Class colors</label></div>
    <div class="row"><label><input type="radio" name="mode" value="plane"> Plane hash</label></div>
  </div>

  <div class="group">
    <div class="gtitle">Class filter</div>
    <div class="row"><label><input type="checkbox" data-cls="2" checked> Facade</label></div>
    <div class="row"><label><input type="checkbox" data-cls="1" checked> Ground</label></div>
    <div class="row"><label><input type="checkbox" data-cls="3" checked> Roof</label></div>
    <div class="row"><label><input type="checkbox" data-cls="4" checked> Oblique</label></div>
  </div>

  <div class="group">
    <div class="gtitle">Display</div>
    <div class="row"><label><input type="checkbox" id="wireframe"> Wireframe</label></div>
    <div class="row"><label><input type="checkbox" id="doubleSided" checked> Double sided</label></div>
    <div class="row">
      <label>Opacity <input type="range" id="opacity" min="0.1" max="1" value="1" step="0.05"></label>
    </div>
    <div class="row"><label><input type="checkbox" id="showCameras" checked> Show camera markers</label></div>
  </div>

  <div class="group">
    <div class="gtitle">Panoramas <span id="panoCount" style="color:#6f7787"></span></div>
    <div class="row" style="gap:6px">
      <button id="allOn">All on</button>
      <button id="allOff">All off</button>
      <button id="onlyRef">Only ref</button>
    </div>
    <div id="pano-list"></div>
  </div>
</div>
<div id="status">Loading…</div>
<div id="cmds">
  drag = orbit, right-drag = pan, wheel = zoom<br>
  <kbd>R</kbd> reset view &nbsp; <kbd>F</kbd> fit
</div>

<script type="importmap">
{ "imports": {
  "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
  "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
}}
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const INDEX = __INDEX_JSON__;
const CLASS_COLORS = {
  0: 0x080814,    // sky (unused)
  1: 0x4da866,    // ground
  2: 0xb380d9,    // facade
  3: 0x8c6640,    // roof
  4: 0xd933cc,    // oblique
};

const app = document.getElementById('app');
const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(40, 40, 30);
camera.up.set(0, 0, 1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 5);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const allMeshes = [];
const cameraMarkers = new THREE.Group();
scene.add(cameraMarkers);

const panoListDiv = document.getElementById('pano-list');
document.getElementById('panoCount').textContent = `(${INDEX.panos.length})`;

function hashColor(k) {
  const h = (k * 2654435761) >>> 0;
  return new THREE.Color(((h >> 16) & 0xff) / 255, ((h >> 8) & 0xff) / 255, (h & 0xff) / 255);
}

async function loadPano(panoInfo) {
  const dir = panoInfo.dir;
  const [posBuf, uvBuf, idxBuf, groups, meta] = await Promise.all([
    fetch(`derived/pano_mesh/${dir}/positions.f32`).then(r => r.arrayBuffer()),
    fetch(`derived/pano_mesh/${dir}/uvs.f32`).then(r => r.arrayBuffer()),
    fetch(`derived/pano_mesh/${dir}/indices.u32`).then(r => r.arrayBuffer()),
    fetch(`derived/pano_mesh/${dir}/groups.json`).then(r => r.json()),
    fetch(`derived/pano_mesh/${dir}/meta.json`).then(r => r.ok ? r.json() : {}),
  ]);
  const positions = new Float32Array(posBuf);
  const uvs = new Float32Array(uvBuf);
  const indices = new Uint32Array(idxBuf);
  const nVerts = positions.length / 3;

  // Pre-compute per-vertex class color and per-vertex plane-hash color from groups
  const clsColors = new Float32Array(nVerts * 3);
  const planeColors = new Float32Array(nVerts * 3);
  const triCls = new Uint8Array(indices.length / 3);
  for (const g of groups) {
    const cc = new THREE.Color(CLASS_COLORS[g.cls] || 0x888888);
    const pc = hashColor(g.plane_k);
    // Mark triangles for this group
    for (let t = 0; t < g.count_tri; t++) {
      triCls[g.start_tri + t] = g.cls;
      const triIdx = g.start_tri + t;
      const i0 = indices[triIdx * 3 + 0];
      const i1 = indices[triIdx * 3 + 1];
      const i2 = indices[triIdx * 3 + 2];
      for (const vi of [i0, i1, i2]) {
        clsColors[vi * 3 + 0] = cc.r;
        clsColors[vi * 3 + 1] = cc.g;
        clsColors[vi * 3 + 2] = cc.b;
        planeColors[vi * 3 + 0] = pc.r;
        planeColors[vi * 3 + 1] = pc.g;
        planeColors[vi * 3 + 2] = pc.b;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();

  // Texture
  const tex = await new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(`derived/pano_mesh/${dir}/texture.jpg`, resolve, undefined, reject);
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.flipY = false;
  tex.needsUpdate = true;

  const panoMeta = { ...panoInfo, ...meta };
  const matTex = makeProjectedPanoMaterial(tex, panoMeta);
  const mesh = new THREE.Mesh(geo, matTex);
  mesh.userData = {
    panoInfo: panoMeta, groups, triCls, clsColors, planeColors, texture: tex, matTex,
    positions, uvs, indices,
  };
  scene.add(mesh);
  allMeshes.push(mesh);

  // Camera marker
  const wp = panoMeta.world_pos || panoInfo.world_pos;
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x44ddff }),
  );
  dot.position.set(wp[0], wp[1], wp[2] + 1.5);
  dot.userData.panoIdx = panoMeta.pano_idx;
  cameraMarkers.add(dot);

  return mesh;
}

function makeWorldToLocalMatrix3(panoInfo) {
  const R = panoInfo.rotation_matrix_local_to_world;
  const m = new THREE.Matrix3();
  if (Array.isArray(R) && R.length === 3 && Array.isArray(R[0]) && R[0].length === 3) {
    // world->local = transpose(local->world)
    m.set(
      R[0][0], R[1][0], R[2][0],
      R[0][1], R[1][1], R[2][1],
      R[0][2], R[1][2], R[2][2],
    );
  } else {
    m.identity();
  }
  return m;
}

function makeProjectedPanoMaterial(tex, panoInfo) {
  const wp = panoInfo.world_pos || [0, 0, 0];
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      cameraCenter: { value: new THREE.Vector3(wp[0], wp[1], wp[2]) },
      worldToLocal: { value: makeWorldToLocalMatrix3(panoInfo) },
      opacity: { value: 1.0 },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D map;
      uniform vec3 cameraCenter;
      uniform mat3 worldToLocal;
      uniform float opacity;
      varying vec3 vWorldPos;
      void main() {
        const float PI = 3.141592653589793;
        vec3 local = worldToLocal * (vWorldPos - cameraCenter);
        vec3 dir = normalize(local);
        float theta = atan(dir.x, dir.y);
        float phi = asin(clamp(dir.z, -1.0, 1.0));
        vec2 uv = vec2((theta + PI) / (2.0 * PI), (0.5 * PI - phi) / PI);
        gl_FragColor = vec4(texture2D(map, uv).rgb, opacity);
      }
    `,
    side: THREE.DoubleSide,
    transparent: false,
  });
}

function rebuildIndices(mesh) {
  const { triCls, indices } = mesh.userData;
  const enabledCls = new Set([...document.querySelectorAll('input[data-cls]')]
    .filter(c => c.checked).map(c => +c.dataset.cls));
  const out = [];
  for (let t = 0; t < triCls.length; t++) {
    if (enabledCls.has(triCls[t])) {
      out.push(indices[t * 3 + 0], indices[t * 3 + 1], indices[t * 3 + 2]);
    }
  }
  mesh.geometry.setIndex(out.length ? new THREE.BufferAttribute(new Uint32Array(out), 1) : null);
}

function setMode(mode) {
  for (const m of allMeshes) {
    const ud = m.userData;
    if (mode === 'texture') {
      m.material = ud.matTex;
      m.geometry.deleteAttribute('color');
    } else if (mode === 'class') {
      const mat = ud.matCls || (ud.matCls = new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide,
      }));
      m.material = mat;
      m.geometry.setAttribute('color', new THREE.BufferAttribute(ud.clsColors, 3));
    } else if (mode === 'plane') {
      const mat = ud.matPlane || (ud.matPlane = new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide,
      }));
      m.material = mat;
      m.geometry.setAttribute('color', new THREE.BufferAttribute(ud.planeColors, 3));
    }
    applyDisplayState(m);
  }
}

function applyDisplayState(m) {
  const wf = document.getElementById('wireframe').checked;
  const ds = document.getElementById('doubleSided').checked;
  const op = parseFloat(document.getElementById('opacity').value);
  m.material.wireframe = wf;
  m.material.side = ds ? THREE.DoubleSide : THREE.FrontSide;
  m.material.transparent = op < 1;
  m.material.opacity = op;
  if (m.material.uniforms && m.material.uniforms.opacity) {
    m.material.uniforms.opacity.value = op;
  }
  m.material.needsUpdate = true;
}

function fitCameraToScene() {
  const box = new THREE.Box3();
  for (const m of allMeshes) if (m.visible) box.expandByObject(m);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = size.length() * 0.5;
  controls.target.copy(center);
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(radius * 1.6));
  camera.near = Math.max(0.1, radius / 1000);
  camera.far = radius * 10;
  camera.updateProjectionMatrix();
}

function setupPanoList() {
  for (const p of INDEX.panos) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <label>
        <input type="checkbox" data-pano="${p.pano_idx}" checked>
        <span class="swatch" style="background:#44ddff"></span>
        #${p.pano_idx} <code>${p.panoid.slice(0,10)}</code>
        <span style="color:#6f7787; font-size:10px">${(p.n_triangles/1000).toFixed(0)}k tri</span>
      </label>`;
    panoListDiv.appendChild(row);
  }
  panoListDiv.addEventListener('change', e => {
    if (e.target.matches('input[data-pano]')) {
      const idx = +e.target.dataset.pano;
      const m = allMeshes.find(mm => mm.userData.panoInfo.pano_idx === idx);
      if (m) m.visible = e.target.checked;
      const dot = cameraMarkers.children.find(d => d.userData.panoIdx === idx);
      if (dot) dot.visible = e.target.checked && document.getElementById('showCameras').checked;
    }
  });
  document.getElementById('allOn').onclick = () => {
    panoListDiv.querySelectorAll('input[data-pano]').forEach(c => { c.checked = true; });
    for (const m of allMeshes) m.visible = true;
    for (const d of cameraMarkers.children) d.visible = document.getElementById('showCameras').checked;
  };
  document.getElementById('allOff').onclick = () => {
    panoListDiv.querySelectorAll('input[data-pano]').forEach(c => { c.checked = false; });
    for (const m of allMeshes) m.visible = false;
    for (const d of cameraMarkers.children) d.visible = false;
  };
  document.getElementById('onlyRef').onclick = () => {
    panoListDiv.querySelectorAll('input[data-pano]').forEach(c => {
      c.checked = (+c.dataset.pano === 0);
    });
    for (const m of allMeshes) m.visible = (m.userData.panoInfo.pano_idx === 0);
    for (const d of cameraMarkers.children) {
      d.visible = (d.userData.panoIdx === 0) && document.getElementById('showCameras').checked;
    }
  };
}

document.querySelectorAll('input[name=mode]').forEach(el => {
  el.addEventListener('change', e => setMode(e.target.value));
});
document.querySelectorAll('input[data-cls]').forEach(el => {
  el.addEventListener('change', () => {
    for (const m of allMeshes) rebuildIndices(m);
  });
});
['wireframe', 'doubleSided', 'opacity'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    for (const m of allMeshes) applyDisplayState(m);
  });
});
document.getElementById('showCameras').addEventListener('change', e => {
  cameraMarkers.visible = e.target.checked;
});

document.addEventListener('keydown', e => {
  if (e.key === 'r' || e.key === 'R') {
    camera.position.set(40, 40, 30);
    controls.target.set(0, 0, 5);
  } else if (e.key === 'f' || e.key === 'F') {
    fitCameraToScene();
  }
});

function parseHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const mode = params.get('mode');
  if (mode && ['texture', 'class', 'plane'].includes(mode)) {
    const r = document.querySelector(`input[name=mode][value=${mode}]`);
    if (r) { r.checked = true; setMode(mode); }
  }
  const pano = params.get('pano');
  if (pano !== null) {
    const want = pano.split(',').map(Number);
    panoListDiv.querySelectorAll('input[data-pano]').forEach(c => {
      c.checked = want.includes(+c.dataset.pano);
    });
    for (const m of allMeshes) m.visible = want.includes(m.userData.panoInfo.pano_idx);
    for (const d of cameraMarkers.children) d.visible = want.includes(d.userData.panoIdx);
  }
  if (params.get('wireframe') === '1') {
    document.getElementById('wireframe').checked = true;
    for (const m of allMeshes) applyDisplayState(m);
  }
}

(async () => {
  status.textContent = `Loading ${INDEX.panos.length} panos…`;
  document.getElementById('globalStats').textContent =
    `${INDEX.panos.length} panos · ${(INDEX.total_triangles/1000).toFixed(0)}k tri · ` +
    `${(INDEX.total_vertices/1000).toFixed(0)}k vert · ${INDEX.total_area_m2.toFixed(0)} m²`;
  setupPanoList();
  let loaded = 0;
  await Promise.all(INDEX.panos.map(p => loadPano(p).then(() => {
    loaded++;
    status.textContent = `Loaded ${loaded}/${INDEX.panos.length}`;
  })));
  status.textContent = `Ready · ${INDEX.panos.length} panos · ${INDEX.total_triangles.toLocaleString()} tri`;
  parseHash();
  fitCameraToScene();
  window.addEventListener('hashchange', parseHash);
})();

(function loop() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
})();
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir')
    ap.add_argument('--out-name', default='3d_viewer_meshfused.html')
    args = ap.parse_args()

    run = args.run_dir
    idx_fp = os.path.join(run, 'derived', 'pano_mesh', 'index.json')
    if not os.path.exists(idx_fp):
        print(f'index.json not found: {idx_fp}', file=sys.stderr)
        print('Run derive_pano_mesh.py first.', file=sys.stderr)
        sys.exit(2)

    index = json.load(open(idx_fp))
    out_fp = os.path.join(run, args.out_name)
    html = HTML_TEMPLATE.replace('__INDEX_JSON__', json.dumps(index))
    with open(out_fp, 'w') as f:
        f.write(html)
    n_panos = len(index['panos'])
    print(f'Wrote {out_fp}')
    print(f'  {n_panos} panos · {index["total_triangles"]:,} tri · '
          f'{index["total_vertices"]:,} vert · {index["total_area_m2"]} m²')
    print(f'Open via: python3 src/py/viewers/serve.py {run}/')
    print(f'Then visit http://localhost:8765/{args.out_name}')


if __name__ == '__main__':
    main()

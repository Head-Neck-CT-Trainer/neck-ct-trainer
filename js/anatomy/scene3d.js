// 3D pane of the anatomy trainer: structure meshes, slice planes, picking.
// Patient LPS millimetres, +z up. No skin surface is ever shown.
// RESEARCH / EDUCATION PROTOTYPE ONLY. NOT FOR CLINICAL USE.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Structures that enclose others start see-through so their contents are visible.
const SEE_THROUGH = { Bones: 0.3, Skull: 0.22, Brain: 0.45, Airway: 0.45, 'Spinal-Canal': 0.35, 'Orbit-Lt': 0.55, 'Orbit-Rt': 0.55, 'Cervical-Spine': 0.6 };

export async function createScene(canvas, meta, glbUrl) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1419);
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4250, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.8); scene.add(key);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  const [nx, ny, nz] = meta.shape_xyz, h = meta.spacing_mm, o = meta.origin_mm;
  const size = [nx * h, ny * h, nz * h];
  const centre = new THREE.Vector3(o[0] + size[0] / 2, o[1] + size[1] / 2, o[2] + size[2] / 2);

  const byKey = Object.fromEntries(meta.structures.map((s) => [s.key, s]));
  const meshes = {};                                   // id -> THREE.Mesh
  const gltf = await new GLTFLoader().loadAsync(glbUrl);
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    let n = obj, s = null;
    while (n && !s) { s = byKey[n.name]; n = n.parent; }
    if (!s) return;
    const base = SEE_THROUGH[s.key] ?? 1;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(s.color[0] / 255, s.color[1] / 255, s.color[2] / 255),
      roughness: 0.65, metalness: 0.0, transparent: base < 1, opacity: base, depthWrite: base >= 1, side: THREE.DoubleSide,
    });
    const geo = obj.geometry.clone(); geo.applyMatrix4(obj.matrixWorld); geo.deleteAttribute('color'); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { id: s.id, key: s.key, base };
    mesh.renderOrder = base < 1 ? 2 : 1;
    meshes[s.id] = mesh; scene.add(mesh);
  });

  // translucent planes that show where the three slices cut the model
  const planes = new THREE.Group(); scene.add(planes);
  const mkPlane = (w, hgt, color) => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false })));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, hgt)), new THREE.LineBasicMaterial({ color })));
    g.renderOrder = 3; planes.add(g); return g;
  };
  const pAx = mkPlane(size[0], size[1], 0x4cc9f0);                       // normal z
  const pCo = mkPlane(size[0], size[2], 0x6fdc8c); pCo.rotation.x = Math.PI / 2;   // normal y
  const pSa = mkPlane(size[1], size[2], 0xffa94d);    // normal x
  pSa.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));

  const state = { selected: 0, hiddenGroups: new Set(), hiddenIds: new Set(), opacity: {}, reveal: true, only: 0 };

  // hand-placed landmarks: small spheres drawn on top of everything so they are never buried in bone
  const pins = {};                                      // id -> THREE.Mesh
  const pinGeo = new THREE.SphereGeometry(1, 20, 14);
  function setLandmarks(list) {
    for (const m of Object.values(pins)) { scene.remove(m); m.material.dispose(); }
    for (const k of Object.keys(pins)) delete pins[k];
    for (const l of list) {
      const m = new THREE.Mesh(pinGeo, new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }));
      m.position.set(l.mm[0], l.mm[1], l.mm[2]); m.renderOrder = 10; m.userData = { id: l.id, pin: true };
      pins[l.id] = m; scene.add(m);
    }
    apply();
  }

  function apply() {
    for (const m of Object.values(meshes)) {
      const s = byKey[m.userData.key];
      const sel = state.selected === s.id;
      let visible = !state.hiddenGroups.has(s.group);
      if (state.only) visible = s.id === state.only || s.key === 'Skull' || s.key === 'Bones';
      if (!state.reveal || state.hiddenIds.has(s.id)) visible = false;
      m.visible = visible;
      let op = state.opacity[s.key] ?? m.userData.base;
      if (state.only && (s.key === 'Skull' || s.key === 'Bones') && s.id !== state.only) op = 0.12;
      if (sel) op = Math.max(op, 0.95);
      m.material.opacity = op; m.material.transparent = op < 1; m.material.depthWrite = op >= 1;
      m.material.emissive.setHex(sel ? 0x806000 : 0x000000);
      m.renderOrder = op < 1 ? 2 : 1;
      m.material.needsUpdate = true;
    }
    for (const m of Object.values(pins)) {
      const sel = state.selected === m.userData.id;
      m.visible = state.reveal && !state.hiddenIds.has(m.userData.id) && !state.hiddenGroups.has('Landmarks') && (!state.only || state.only === m.userData.id);
      m.scale.setScalar(sel ? 3.4 : 2.0);
      m.material.color.setHex(sel ? 0xff4d6d : 0xffd166);
    }
    planes.visible = state.reveal && state.planes !== false;
  }

  function setCross(mm) {
    pAx.position.set(centre.x, centre.y, mm[2]);
    pCo.position.set(centre.x, mm[1], centre.z);
    pSa.position.set(mm[0], centre.y, centre.z);
  }

  function resetCamera() {
    controls.target.copy(centre);
    camera.position.set(centre.x + 260, centre.y - 620, centre.z + 120);   // from the front, slightly to the patient's left
    controls.update();
  }

  function resize() {
    const w = canvas.clientWidth, hh = canvas.clientHeight;
    if (!w || !hh) return;
    renderer.setSize(w, hh, false); camera.aspect = w / hh; camera.updateProjectionMatrix();
  }

  // Click picking: prefer the nearest solid structure; fall back to the nearest see-through one.
  const ray = new THREE.Raycaster(); let onPick = null; let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !onPick || !state.reveal) return;
    const id = pickAt(e.clientX, e.clientY);
    if (id) onPick(id);
  });
  function pickAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
    const pinHits = ray.intersectObjects(Object.values(pins).filter((m) => m.visible), false);
    if (pinHits.length) return pinHits[0].object.userData.id;
    const hits = ray.intersectObjects(Object.values(meshes).filter((m) => m.visible), false);
    if (!hits.length) return 0;
    const solid = hits.find((hit) => hit.object.material.opacity >= 0.9);
    return (solid || hits[0]).object.userData.id;
  }

  function frame() {
    controls.update();
    key.position.copy(camera.position);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  resetCamera(); resize(); apply(); frame();
  new ResizeObserver(resize).observe(canvas);

  return {
    meshes, pins, camera, controls, state, setLandmarks,
    select(id) { state.selected = id || 0; apply(); },
    setCross,
    setGroupVisible(group, on) { on ? state.hiddenGroups.delete(group) : state.hiddenGroups.add(group); apply(); },
    setOpacity(k, v) { state.opacity[k] = v; apply(); },
    setHiddenIds(ids) { state.hiddenIds = new Set(ids); apply(); },
    setReveal(on) { state.reveal = on; apply(); },
    setOnly(id) { state.only = id || 0; apply(); },
    setPlanes(on) { state.planes = on; apply(); },
    onPick(cb) { onPick = cb; },
    pickAt, resetCamera,
    lookFrom(dir) {                                         // dir: unit-ish vector from the centre towards the camera
      controls.target.copy(centre);
      camera.position.set(centre.x + dir[0] * 680, centre.y + dir[1] * 680, centre.z + dir[2] * 680); controls.update();
    },
    project(mm) {                                           // mm -> client pixel, for tests
      const v = new THREE.Vector3(mm[0], mm[1], mm[2]).project(camera); const r = canvas.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
    },
  };
}

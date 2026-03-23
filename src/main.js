import * as THREE from "three";
import { ThirdPersonController } from "./controller.js";
import { AudioEmitterSystem } from "./audioEmitters.js";
import { LocomotionAnimator } from "./locomotion.js";
import {
  applyCharacterScale,
  getCharacterMetrics,
  loadCharacterFromFile,
  makePlaceholderCharacter,
  suggestCharacterScale,
} from "./assets.js";

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.fog = new THREE.Fog(0x0b0e14, 40, 260);

const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1200);

const hemi = new THREE.HemisphereLight(0xdbeafe, 0x111827, 0.6);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(20, 40, 20);
dir.castShadow = true;
dir.shadow.mapSize.set(2048, 2048);
dir.shadow.camera.left = -80;
dir.shadow.camera.right = 80;
dir.shadow.camera.top = 80;
dir.shadow.camera.bottom = -80;
scene.add(dir);

const groundGeo = new THREE.PlaneGeometry(1200, 1200, 1, 1);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 1.0, metalness: 0.0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(1200, 120, 0x1f2937, 0x111827);
grid.position.y = 0.01;
scene.add(grid);

const centerGeo = new THREE.TorusGeometry(6, 0.05, 10, 160);
const centerMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95, metalness: 0.0 });
const centerRing = new THREE.Mesh(centerGeo, centerMat);
centerRing.rotation.x = Math.PI / 2;
centerRing.position.y = 0.03;
scene.add(centerRing);

let character = makePlaceholderCharacter();
scene.add(character);

const listener = new THREE.AudioListener();
character.add(listener);

const hud = {
  status: document.getElementById("status"),
  speed: document.getElementById("speed"),
  sprint: document.getElementById("sprint"),
  mode: document.getElementById("mode"),
};

function getGroundHeightAt() {
  return 0.0;
}

let latestPose = null;

const controller = new ThirdPersonController({
  camera,
  domElement: canvas,
  characterRoot: character,
  getGroundHeightAt,
  hud,
  onPose: (pose) => {
    latestPose = pose;
    listener.rotation.set(0, pose.bodyYaw, 0);
  },
});

const charFile = document.getElementById("charFile");
const modelScale = document.getElementById("modelScale");
const modelScaleValue = document.getElementById("modelScaleValue");
const charHint = document.getElementById("charHint");

const animPackFiles = document.getElementById("animPackFiles");
const animSummary = document.getElementById("animSummary");
const animClipList = document.getElementById("animClipList");

const locomotion = new LocomotionAnimator({
  characterRoot: character,
  clipListEl: animClipList,
  summaryEl: animSummary,
  statusEl: hud.status,
});

function syncCharacterMetrics(characterRoot) {
  const metrics = getCharacterMetrics(characterRoot);
  listener.position.set(0, metrics.eyeHeight, 0);
  controller.setCharacterMetrics(metrics);
  return metrics;
}

function syncCharacterAnimations() {
  locomotion.setCharacterRoot(character);
  locomotion.setEmbeddedClips(character.userData.animations || [], character.userData.sourceName || "character");
}

function updateScaleLabel(value) {
  modelScaleValue.textContent = `${Number(value).toFixed(2)}x`;
}

function applyCurrentScaleToCharacter() {
  const metrics = applyCharacterScale(character, Number(modelScale.value) || 1);
  listener.position.set(0, metrics.eyeHeight, 0);
  controller.setCharacterMetrics(metrics);
  updateScaleLabel(modelScale.value);
}

updateScaleLabel(modelScale.value);
syncCharacterMetrics(character);
syncCharacterAnimations();

modelScale.addEventListener("input", () => {
  applyCurrentScaleToCharacter();
});

charFile.addEventListener("change", async () => {
  if (!charFile.files || !charFile.files[0]) return;

  try {
    const loaded = await loadCharacterFromFile(charFile.files[0]);

    scene.remove(character);
    character = loaded;
    scene.add(character);
    character.add(listener);

    controller.setCharacterRoot(character);

    const suggestedScale = suggestCharacterScale(character, 1.8);
    modelScale.value = String(suggestedScale);
    applyCurrentScaleToCharacter();
    syncCharacterAnimations();

    const metrics = getCharacterMetrics(character);
    charHint.textContent = `${charFile.files[0].name} loaded. Raw height auto-fitted to ${metrics.height.toFixed(2)} scene units. Use the scale slider to tweak it.`;
    hud.status.textContent = "Character loaded. Movement still uses the repo's strafe convention, and any embedded clips are ready for mapping.";
  } catch (err) {
    console.error(err);
    hud.status.textContent = "Failed to load that model. Try a GLB with embedded buffers and textures.";
  }
});

animPackFiles.addEventListener("change", async () => {
  const files = Array.from(animPackFiles.files || []);
  if (!files.length) return;

  try {
    await locomotion.loadExternalClipFiles(files);
    hud.status.textContent = "Animation pack loaded. Use Preview to identify numbered strafes, then map the roles you want.";
  } catch (err) {
    console.error(err);
    hud.status.textContent = "Failed to load one or more animation clips.";
  }
});

const emitterList = document.getElementById("emitterList");
const emitters = new AudioEmitterSystem({
  listener,
  scene,
  camera,
  domOverlayList: emitterList,
  sharedTrackUI: {
    fileInput: document.getElementById("surroundFile"),
    toggleButton: document.getElementById("surroundToggle"),
    orbitCheckbox: document.getElementById("surroundOrbit"),
    radiusSlider: document.getElementById("surroundRadius"),
    radiusValue: document.getElementById("surroundRadiusValue"),
    speedSlider: document.getElementById("surroundSpeed"),
    speedValue: document.getElementById("surroundSpeedValue"),
  },
});
emitters.createEmitters();

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

let last = performance.now();
function tick() {
  const t = performance.now();
  const dt = Math.min(0.033, (t - last) / 1000);
  last = t;

  centerRing.rotation.z += dt * 0.25;

  controller.update(dt);
  locomotion.update(dt, latestPose);
  emitters.update(dt);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

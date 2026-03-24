import * as THREE from "three";
import { ThirdPersonController } from "./controller.js";
import { AudioEmitterSystem } from "./audioEmitters.js";
import { LocomotionAnimator } from "./locomotion.js";
import {
  applyCharacterFootOffset,
  applyCharacterScale,
  getCharacterMetrics,
  loadCharacterFromFile,
  makePlaceholderCharacter,
  suggestCharacterScale,
} from "./assets.js";

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
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
dir.shadow.mapSize.set(1024, 1024);
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

const centerGeo = new THREE.TorusGeometry(6, 0.05, 10, 96);
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
const modelFootOffset = document.getElementById("modelFootOffset");
const modelFootOffsetValue = document.getElementById("modelFootOffsetValue");
const charHint = document.getElementById("charHint");

const animPackFiles = document.getElementById("animPackFiles");
const clearAnimPack = document.getElementById("clearAnimPack");
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

function updateFootOffsetLabel(value) {
  modelFootOffsetValue.textContent = `${Number(value).toFixed(2)}`;
}

function applyCurrentCharacterTuning() {
  applyCharacterScale(character, Number(modelScale.value) || 1);
  const metrics = applyCharacterFootOffset(character, Number(modelFootOffset.value) || 0);
  listener.position.set(0, metrics.eyeHeight, 0);
  controller.setCharacterMetrics(metrics);
  updateScaleLabel(modelScale.value);
  updateFootOffsetLabel(modelFootOffset.value);
  return metrics;
}

updateScaleLabel(modelScale.value);
updateFootOffsetLabel(modelFootOffset.value);
syncCharacterMetrics(character);
syncCharacterAnimations();

modelScale.addEventListener("input", () => {
  applyCurrentCharacterTuning();
});

modelFootOffset.addEventListener("input", () => {
  applyCurrentCharacterTuning();
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
    modelFootOffset.value = "0";
    const metrics = applyCurrentCharacterTuning();
    syncCharacterAnimations();

    charHint.textContent = `${charFile.files[0].name} loaded. Raw height auto-fitted to ${metrics.height.toFixed(2)} scene units. If this specific model still floats or sinks a bit, use Foot Offset to nudge it without breaking the others.`;
    hud.status.textContent = "Character loaded. Embedded clips now use clearer labels, short junk clips stay hidden, and the current A/D strafe convention stays untouched.";
  } catch (err) {
    console.error(err);
    hud.status.textContent = "Failed to load that model. Try a GLB with embedded buffers and textures.";
  } finally {
    charFile.value = "";
  }
});

animPackFiles.addEventListener("change", async () => {
  const files = Array.from(animPackFiles.files || []);
  if (!files.length) return;

  try {
    await locomotion.loadExternalClipFiles(files);
    hud.status.textContent = "Animation pack loaded. Separate uploads append cleanly, same-file re-uploads replace older rows, and short junk clips stay hidden.";
  } catch (err) {
    console.error(err);
    hud.status.textContent = "Failed to load one or more animation clips.";
  } finally {
    animPackFiles.value = "";
  }
});

clearAnimPack.addEventListener("click", () => {
  locomotion.clearExternalClips();
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

let lastWidth = 0;
let lastHeight = 0;
let lastPixelRatio = 0;

function resize(force = false) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);

  if (!force && w === lastWidth && h === lastHeight && pixelRatio === lastPixelRatio) {
    return;
  }

  lastWidth = w;
  lastHeight = h;
  lastPixelRatio = pixelRatio;

  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", () => resize());
resize(true);

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

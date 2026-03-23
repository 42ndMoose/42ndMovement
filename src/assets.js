
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clamp } from "./utils.js";

const _box = new THREE.Box3();
const _meshBox = new THREE.Box3();
const _worldToRoot = new THREE.Matrix4();
const _objectToRoot = new THREE.Matrix4();
const _size = new THREE.Vector3();

function decorateForShadows(root) {
  root.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      if (obj.material) obj.frustumCulled = false;
    }
  });
}

function expandBoxFromRenderableMeshes(root, outBox) {
  let found = false;

  root.updateWorldMatrix(true, true);
  _worldToRoot.copy(root.matrixWorld).invert();
  outBox.makeEmpty();

  root.traverse((obj) => {
    if (!(obj.isMesh || obj.isSkinnedMesh)) return;
    if (!obj.geometry) return;

    if (!obj.geometry.boundingBox) {
      obj.geometry.computeBoundingBox();
    }
    if (!obj.geometry.boundingBox) return;

    _objectToRoot.multiplyMatrices(_worldToRoot, obj.matrixWorld);
    _meshBox.copy(obj.geometry.boundingBox).applyMatrix4(_objectToRoot);

    if (!Number.isFinite(_meshBox.min.y) || !Number.isFinite(_meshBox.max.y)) return;

    if (!found) {
      outBox.copy(_meshBox);
      found = true;
    } else {
      outBox.union(_meshBox);
    }
  });

  return found;
}

function measureObject(root) {
  const foundRenderableBounds = expandBoxFromRenderableMeshes(root, _box);

  if (!foundRenderableBounds) {
    _box.setFromObject(root);
  }

  if (Number.isNaN(_box.min.y) || Number.isNaN(_box.max.y) || !Number.isFinite(_box.min.y) || !Number.isFinite(_box.max.y)) {
    return {
      minY: 0,
      maxY: 1.8,
      height: 1.8,
    };
  }

  _box.getSize(_size);
  return {
    minY: _box.min.y,
    maxY: _box.max.y,
    height: Math.max(0.001, _size.y),
  };
}

function syncCharacterPlacement(characterRoot) {
  const metrics = characterRoot?.userData?.characterMetrics;
  const visualRoot = characterRoot?.userData?.visualRoot;
  if (!metrics || !visualRoot) return;

  const safeScale = Math.max(0.01, metrics.scale || 1);
  characterRoot.scale.setScalar(safeScale);
  visualRoot.position.y = metrics.baseCenterOffset + (metrics.footOffsetWorld || 0) / safeScale;
}

function makeRigFromVisual(visualRoot, rawHeightHint = null) {
  const rigRoot = new THREE.Group();
  rigRoot.name = "CharacterRigRoot";

  const visualPivot = new THREE.Group();
  visualPivot.name = "CharacterVisualPivot";
  rigRoot.add(visualPivot);
  visualPivot.add(visualRoot);

  decorateForShadows(visualRoot);

  const measured = measureObject(visualRoot);
  const rawHeight = rawHeightHint ?? measured.height;
  const baseCenterOffset = -(measured.minY + rawHeight * 0.5);

  rigRoot.userData.visualRoot = visualRoot;
  rigRoot.userData.visualPivot = visualPivot;
  rigRoot.userData.characterMetrics = {
    rawHeight,
    rawHalfHeight: rawHeight * 0.5,
    rawEyeHeight: rawHeight * 0.88 - rawHeight * 0.5,
    scale: 1,
    baseCenterOffset,
    footOffsetWorld: 0,
  };

  syncCharacterPlacement(rigRoot);
  return rigRoot;
}

export function getCharacterMetrics(characterRoot) {
  const metrics = characterRoot?.userData?.characterMetrics;
  if (!metrics) {
    return {
      height: 1.8,
      halfHeight: 0.9,
      eyeHeight: 0.68,
      scale: 1,
      footOffsetWorld: 0,
    };
  }

  const scale = Math.max(0.01, metrics.scale || 1);
  const footOffsetWorld = metrics.footOffsetWorld || 0;

  return {
    height: metrics.rawHeight * scale,
    halfHeight: Math.max(0.05, metrics.rawHalfHeight * scale - footOffsetWorld),
    eyeHeight: Math.max(0.1, metrics.rawEyeHeight * scale + footOffsetWorld),
    scale,
    footOffsetWorld,
  };
}

export function applyCharacterScale(characterRoot, scale) {
  const metrics = characterRoot?.userData?.characterMetrics;
  if (!metrics) return getCharacterMetrics(characterRoot);

  metrics.scale = clamp(scale, 0.01, 50);
  syncCharacterPlacement(characterRoot);
  return getCharacterMetrics(characterRoot);
}

export function applyCharacterFootOffset(characterRoot, offsetWorld) {
  const metrics = characterRoot?.userData?.characterMetrics;
  if (!metrics) return getCharacterMetrics(characterRoot);

  metrics.footOffsetWorld = clamp(offsetWorld, -1.0, 1.0);
  syncCharacterPlacement(characterRoot);
  return getCharacterMetrics(characterRoot);
}

export function suggestCharacterScale(characterRoot, targetHeight = 1.8) {
  const metrics = characterRoot?.userData?.characterMetrics;
  if (!metrics || !metrics.rawHeight) return 1;
  return clamp(targetHeight / metrics.rawHeight, 0.01, 6.0);
}

export async function loadCharacterFromFile(file) {
  const url = URL.createObjectURL(file);
  const loader = new GLTFLoader();

  try {
    const gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });

    const visual = gltf.scene || new THREE.Group();
    const rigRoot = makeRigFromVisual(visual);
    rigRoot.userData.sourceName = file.name;
    rigRoot.userData.animations = gltf.animations || [];
    return rigRoot;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function makePlaceholderCharacter() {
  const visual = new THREE.Group();

  const bodyGeo = new THREE.CapsuleGeometry(0.35, 1.1, 6, 14);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.85, metalness: 0.05 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  visual.add(body);

  const headGeo = new THREE.SphereGeometry(0.12, 16, 16);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.8, metalness: 0.05 });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.set(0, 0.9, 0.32);
  visual.add(head);

  const rigRoot = makeRigFromVisual(visual, 1.8);
  rigRoot.userData.sourceName = "placeholder";
  rigRoot.userData._headMarker = head;
  return rigRoot;
}

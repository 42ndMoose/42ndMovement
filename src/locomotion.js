import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clamp, damp } from "./utils.js";

const DEFAULT_ROLE = "unused";
const GENERIC_STRAFE_ROLE = "strafe";

const _rootInverse = new THREE.Matrix4();
const _objectToRoot = new THREE.Matrix4();
const _tmpBox = new THREE.Box3();
const _boundsBox = new THREE.Box3();
const _quatA = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();

const NON_LOCOMOTION_KEYWORDS = [
  "draw",
  "sheath",
  "attack",
  "slash",
  "block",
  "casting",
  "cast",
  "death",
  "impact",
  "kick",
  "power up",
  "powerup",
  "hit",
  "hurt",
  "equip",
  "unequip",
  "spell",
  "taunt",
  "emote",
  "dance",
];

export const ROLE_OPTIONS = [
  { value: "unused", label: "Unused" },
  { value: "idle", label: "Idle" },
  { value: "walk", label: "Walk" },
  { value: "run", label: "Run" },
  { value: "strafeLeft", label: "Strafe Left" },
  { value: "strafeRight", label: "Strafe Right" },
  { value: "strafe", label: "Generic Strafe" },
  { value: "crouchIdle", label: "Crouch Idle" },
  { value: "crouchMove", label: "Crouch Move" },
  { value: "jump", label: "Jump / Air" },
  { value: "fall", label: "Fall" },
  { value: "turnLeft", label: "Turn Left" },
  { value: "turnRight", label: "Turn Right" },
];

function makeEntryId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `clip-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function niceClipName(name, clipIndex) {
  const raw = String(name || "").trim();
  if (!raw) return `clip ${clipIndex + 1}`;
  return raw;
}

function buildDisplayName(sourceName, clip, clipIndex, totalClips) {
  const clipLabel = niceClipName(clip?.name, clipIndex);
  if (totalClips <= 1 && clipLabel === sourceName) return sourceName;
  return `${sourceName} • ${clipLabel}`;
}

function lowerText(...parts) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function looksLikeRootMotionPosition(trackName) {
  const normalized = String(trackName).toLowerCase();
  if (!normalized.endsWith(".position")) return false;
  return (
    normalized.includes("hips.position") ||
    normalized.includes("pelvis.position") ||
    normalized.includes("root.position") ||
    normalized.includes("armature.position") ||
    normalized.includes("mixamorighips.position")
  );
}

function looksLikeFootBone(name) {
  const n = String(name).toLowerCase();
  return n.includes("foot") || n.includes("toe") || n.includes("ankle");
}

function looksLikeFingerBone(name) {
  const n = String(name).toLowerCase();
  return n.includes("finger") || n.includes("thumb") || n.includes("index") || n.includes("middle") || n.includes("ring") || n.includes("pinky");
}

function findBestRootPositionTrack(clip) {
  const tracks = clip?.tracks || [];

  for (const track of tracks) {
    if (looksLikeRootMotionPosition(track.name)) return track;
  }

  let fallback = null;
  let bestDepth = Infinity;

  for (const track of tracks) {
    if (!String(track.name).toLowerCase().endsWith(".position")) continue;
    const targetName = String(track.name).split(".")[0] || "";
    if (looksLikeFootBone(targetName) || looksLikeFingerBone(targetName)) continue;

    const depth = targetName.split(/[/:|]/).filter(Boolean).length;
    if (depth < bestDepth) {
      bestDepth = depth;
      fallback = track;
    }
  }

  return fallback;
}

function vectorTrackDelta(track) {
  const values = track?.values;
  if (!values || values.length < 6) {
    return { x: 0, y: 0, z: 0, planarDistance: 0, verticalRange: 0, totalTravel: 0 };
  }

  const firstX = values[0];
  const firstY = values[1];
  const firstZ = values[2];
  const lastX = values[values.length - 3];
  const lastY = values[values.length - 2];
  const lastZ = values[values.length - 1];

  let minY = firstY;
  let maxY = firstY;
  let totalTravel = 0;

  for (let i = 3; i < values.length; i += 3) {
    const x0 = values[i - 3];
    const y0 = values[i - 2];
    const z0 = values[i - 1];
    const x1 = values[i];
    const y1 = values[i + 1];
    const z1 = values[i + 2];
    totalTravel += Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    if (y1 < minY) minY = y1;
    if (y1 > maxY) maxY = y1;
  }

  const dx = lastX - firstX;
  const dy = lastY - firstY;
  const dz = lastZ - firstZ;

  return {
    x: dx,
    y: dy,
    z: dz,
    planarDistance: Math.hypot(dx, dz),
    verticalRange: maxY - minY,
    totalTravel,
  };
}

function quaternionTrackTravel(track) {
  const values = track?.values;
  if (!values || values.length < 8) return 0;

  let totalAngle = 0;
  for (let i = 4; i < values.length; i += 4) {
    _quatA.set(values[i - 4], values[i - 3], values[i - 2], values[i - 1]).normalize();
    _quatB.set(values[i], values[i + 1], values[i + 2], values[i + 3]).normalize();
    totalAngle += _quatA.angleTo(_quatB);
  }
  return totalAngle;
}

function stripRootMotion(clip) {
  const keptTracks = clip.tracks.filter((track) => !looksLikeRootMotionPosition(track.name));
  return new THREE.AnimationClip(clip.name, clip.duration, keptTracks);
}

function analyzeClip(clip, sourceName = "") {
  const duration = Math.max(clip?.duration || 0, 0.0001);
  const rootTrack = findBestRootPositionTrack(clip);
  const rootMotion = rootTrack ? vectorTrackDelta(rootTrack) : {
    x: 0,
    y: 0,
    z: 0,
    planarDistance: 0,
    verticalRange: 0,
    totalTravel: 0,
  };

  let positionTravel = 0;
  let rotationTravel = 0;
  let footPositionTravel = 0;

  for (const track of clip?.tracks || []) {
    const trackName = String(track.name || "");
    const lower = trackName.toLowerCase();

    if (lower.endsWith(".position")) {
      const delta = vectorTrackDelta(track);
      positionTravel += delta.totalTravel;
      if (looksLikeFootBone(trackName)) {
        footPositionTravel += delta.totalTravel;
      }
    } else if (lower.endsWith(".quaternion")) {
      rotationTravel += quaternionTrackTravel(track);
    }
  }

  const motionEnergy = positionTravel + rotationTravel * 0.3;
  const rootPlanarSpeed = rootMotion.planarDistance / duration;
  const labelText = lowerText(sourceName, clip?.name);
  const explicitNonLocomotion = NON_LOCOMOTION_KEYWORDS.some((keyword) => labelText.includes(keyword));
  const explicitJump = labelText.includes("jump") || labelText.includes("fall");
  const explicitIdle = labelText.includes("idle");
  const explicitCrouch = labelText.includes("crouch") || labelText.includes("crouching");
  const explicitStrafe = labelText.includes("strafe");
  const explicitRun = labelText.includes("run");
  const explicitWalk = labelText.includes("walk");
  const explicitTurn = labelText.includes("turn");

  const likelyStatic = motionEnergy < 0.12 && rootMotion.planarDistance < 0.02 && rootMotion.verticalRange < 0.05;
  const likelySetup = duration <= 0.12 && likelyStatic;
  const likelyIdle = explicitIdle || (!explicitNonLocomotion && duration >= 1.0 && rootPlanarSpeed < 0.08 && motionEnergy < 4.0);
  const likelyStrafe = explicitStrafe || (rootPlanarSpeed > 0.15 && Math.abs(rootMotion.x) > Math.abs(rootMotion.z) * 1.15);
  const likelyForward = explicitRun || explicitWalk || (rootPlanarSpeed > 0.15 && Math.abs(rootMotion.z) >= Math.abs(rootMotion.x));
  const likelyRun = explicitRun || (!explicitWalk && likelyForward && rootPlanarSpeed >= 2.2);
  const likelyWalk = explicitWalk || (likelyForward && !likelyRun && rootPlanarSpeed >= 0.12);
  const likelyJump = explicitJump || (rootMotion.verticalRange > 0.18 && duration <= 1.4);
  const likelyTurn = explicitTurn || (!explicitNonLocomotion && duration <= 1.2 && rootPlanarSpeed < 0.12 && rotationTravel > 2.2 && footPositionTravel < 0.5);
  const likelyOneShot = !explicitNonLocomotion && !likelyIdle && !likelyForward && !likelyStrafe && !likelyJump && !likelyTurn && duration <= 1.25 && motionEnergy > 0.25;

  return {
    duration,
    rootMotion,
    rootPlanarSpeed,
    motionEnergy,
    likelyStatic,
    likelySetup,
    likelyIdle,
    likelyStrafe,
    likelyForward,
    likelyRun,
    likelyWalk,
    likelyJump,
    likelyTurn,
    likelyOneShot,
    explicitNonLocomotion,
    explicitCrouch,
    explicitJump,
    explicitIdle,
    explicitStrafe,
    explicitRun,
    explicitWalk,
    explicitTurn,
  };
}

function normalizeClip(clip, sourceName) {
  const stripped = stripRootMotion(clip.clone());
  stripped.name = stripped.name || sourceName;
  return stripped;
}

function inferRolePlan(sourceName, clip, usedRoles) {
  const info = analyzeClip(clip, sourceName);
  const labelText = lowerText(sourceName, clip?.name);

  if (info.likelySetup) {
    return { role: DEFAULT_ROLE, skip: true, skipReason: "likely setup / empty clip", info, autoLabel: "setup / empty" };
  }

  if (info.explicitNonLocomotion || info.likelyOneShot) {
    return { role: DEFAULT_ROLE, skip: true, skipReason: "non-locomotion clip", info, autoLabel: "non-locomotion" };
  }

  if (info.explicitCrouch && info.likelyIdle) {
    return { role: "crouchIdle", skip: false, info, autoLabel: "auto crouch idle" };
  }

  if (info.explicitCrouch) {
    return { role: "crouchMove", skip: false, info, autoLabel: "auto crouch move" };
  }

  if (info.likelyJump) {
    if (labelText.includes("fall")) {
      return { role: "fall", skip: false, info, autoLabel: "auto fall" };
    }
    return { role: "jump", skip: false, info, autoLabel: "auto jump" };
  }

  if (info.likelyTurn) {
    if (!usedRoles.has("turnLeft")) {
      return { role: "turnLeft", skip: false, info, autoLabel: "auto turn" };
    }
    if (!usedRoles.has("turnRight")) {
      return { role: "turnRight", skip: false, info, autoLabel: "auto turn" };
    }
    return { role: DEFAULT_ROLE, skip: false, info, autoLabel: "extra turn" };
  }

  if (info.likelyIdle) {
    return { role: "idle", skip: false, info, autoLabel: "auto idle" };
  }

  if (info.likelyStrafe) {
    if (labelText.includes("left")) {
      return { role: "strafeLeft", skip: false, info, autoLabel: "auto strafe left" };
    }
    if (labelText.includes("right")) {
      return { role: "strafeRight", skip: false, info, autoLabel: "auto strafe right" };
    }
    if (!usedRoles.has("strafeLeft")) {
      return { role: "strafeLeft", skip: false, info, autoLabel: "auto strafe variant" };
    }
    if (!usedRoles.has("strafeRight")) {
      return { role: "strafeRight", skip: false, info, autoLabel: "auto strafe variant" };
    }
    return { role: GENERIC_STRAFE_ROLE, skip: false, info, autoLabel: "auto generic strafe" };
  }

  if (info.likelyRun) {
    return { role: "run", skip: false, info, autoLabel: "auto run" };
  }

  if (info.likelyWalk) {
    return { role: "walk", skip: false, info, autoLabel: "auto walk" };
  }

  if (labelText.includes("idle")) {
    return { role: "idle", skip: false, info, autoLabel: "auto idle" };
  }
  if (labelText.includes("run")) {
    return { role: "run", skip: false, info, autoLabel: "auto run" };
  }
  if (labelText.includes("walk")) {
    return { role: "walk", skip: false, info, autoLabel: "auto walk" };
  }
  if (labelText.includes("strafe")) {
    if (!usedRoles.has("strafeLeft")) return { role: "strafeLeft", skip: false, info, autoLabel: "auto strafe variant" };
    if (!usedRoles.has("strafeRight")) return { role: "strafeRight", skip: false, info, autoLabel: "auto strafe variant" };
    return { role: GENERIC_STRAFE_ROLE, skip: false, info, autoLabel: "auto generic strafe" };
  }

  return { role: DEFAULT_ROLE, skip: false, info, autoLabel: "manual" };
}

function isOneShotRole(role) {
  return role === "jump" || role === "turnLeft" || role === "turnRight";
}

function makeTimeScale(speed, referenceSpeed, minScale = 0.85, maxScale = 1.75) {
  if (!Number.isFinite(referenceSpeed) || referenceSpeed <= 0.0001) return 1;
  return clamp(speed / referenceSpeed, minScale, maxScale);
}

function summarizeTrackTargets(clip) {
  const names = new Set();
  for (const track of clip.tracks || []) {
    const dot = track.name.indexOf(".");
    names.add(dot >= 0 ? track.name.slice(0, dot) : track.name);
  }
  return Array.from(names).slice(0, 6).join(", ");
}

function buildExternalFileKey(file) {
  return [
    file.name || "",
    file.size || 0,
    file.lastModified || 0,
  ].join("::");
}

function buildClipFingerprint(fileKey, clip, clipIndex) {
  return [
    fileKey,
    clip.name || "(unnamed)",
    Number.isFinite(clip.duration) ? clip.duration.toFixed(4) : "0.0000",
    clip.tracks?.length || 0,
    clipIndex,
  ].join("::");
}

function measureAnimatedRenderableBounds(root, outBox) {
  if (!root) return false;

  root.updateWorldMatrix(true, true);
  _rootInverse.copy(root.matrixWorld).invert();
  outBox.makeEmpty();

  let found = false;

  root.traverse((obj) => {
    if (!(obj.isMesh || obj.isSkinnedMesh)) return;
    if (!obj.visible) return;

    let localBounds = null;

    if (obj.isSkinnedMesh) {
      obj.skeleton?.update?.();
      obj.computeBoundingBox?.();
      localBounds = obj.boundingBox || null;
    } else {
      if (!obj.geometry?.boundingBox) {
        obj.geometry?.computeBoundingBox?.();
      }
      localBounds = obj.geometry?.boundingBox || null;
    }

    if (!localBounds) return;

    _objectToRoot.multiplyMatrices(_rootInverse, obj.matrixWorld);
    _tmpBox.copy(localBounds).applyMatrix4(_objectToRoot);

    if (!Number.isFinite(_tmpBox.min.y) || !Number.isFinite(_tmpBox.max.y)) return;

    if (!found) {
      outBox.copy(_tmpBox);
      found = true;
    } else {
      outBox.union(_tmpBox);
    }
  });

  return found;
}

export class LocomotionAnimator {
  constructor({ characterRoot, clipListEl, summaryEl, statusEl }) {
    this.characterRoot = characterRoot;
    this.clipListEl = clipListEl || null;
    this.summaryEl = summaryEl || null;
    this.statusEl = statusEl || null;

    this.loader = new GLTFLoader();
    this.mixer = null;
    this.actions = new Map();
    this.previewAction = null;
    this.previewEntryId = null;

    this.embeddedEntries = [];
    this.externalEntries = [];
    this.entries = [];
    this.availableRoles = ROLE_OPTIONS.filter((role) => role.value !== DEFAULT_ROLE);

    this._smoothedWeights = new Map();
    this._lastPose = null;
    this._skippedEmbeddedCount = 0;
    this._skippedExternalCount = 0;
    this._autoGroundWorldOffset = 0;
    this._autoGroundMaxOffset = 0.85;

    this.setCharacterRoot(characterRoot);
  }

  setCharacterRoot(characterRoot) {
    this.characterRoot = characterRoot;

    if (this.mixer) {
      this.mixer.stopAllAction();
    }

    this.mixer = new THREE.AnimationMixer(this.characterRoot);
    this.actions.clear();
    this.previewAction = null;
    this.previewEntryId = null;
    this._autoGroundWorldOffset = 0;
    this._applyAutoGroundOffset(0);
    this._rebuildActions();
  }

  setEmbeddedClips(clips, sourceName = "character") {
    const built = this._buildEntriesFromClips(clips || [], sourceName, "embedded");
    this.embeddedEntries = built.entries;
    this._skippedEmbeddedCount = built.skippedCount;

    if (!this.embeddedEntries.length && clips?.length && !built.skippedCount) {
      this.embeddedEntries.push({
        id: makeEntryId(),
        source: "embedded",
        sourceName,
        displayName: sourceName,
        role: DEFAULT_ROLE,
        clip: null,
        error: "The file reported animations, but none produced a usable clip.",
      });
    }

    this._reconcileEntries();
    this._rebuildActions();
    this._render();
  }

  async loadExternalClipFiles(files) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;

    const incomingFileKeys = new Set(list.map((file) => buildExternalFileKey(file)));
    const retainedEntries = this.externalEntries.filter((entry) => !incomingFileKeys.has(entry.fileKey));

    const loadedEntries = [];
    let skippedCount = 0;
    const usedRoles = new Set(
      this.embeddedEntries
        .concat(retainedEntries)
        .map((entry) => entry.role)
        .filter((role) => role && role !== DEFAULT_ROLE)
    );

    for (const file of list) {
      const fileKey = buildExternalFileKey(file);
      const gltf = await this._loadGltfFromFile(file);
      const clips = gltf.animations || [];

      if (!clips.length) {
        loadedEntries.push({
          id: makeEntryId(),
          source: "external",
          fileKey,
          sourceName: file.name,
          displayName: file.name,
          role: DEFAULT_ROLE,
          clip: null,
          error: "No animation clips found in this GLB. That usually means the export stripped the animation data.",
        });
        continue;
      }

      for (let clipIndex = 0; clipIndex < clips.length; clipIndex += 1) {
        const clip = clips[clipIndex];
        const plan = inferRolePlan(file.name, clip, usedRoles);
        if (plan.skip) {
          skippedCount += 1;
          continue;
        }

        const normalized = normalizeClip(clip, file.name);
        const displayName = buildDisplayName(file.name, clip, clipIndex, clips.length);
        const role = plan.role;

        if (role !== DEFAULT_ROLE && role !== GENERIC_STRAFE_ROLE) {
          usedRoles.add(role);
        }

        loadedEntries.push({
          id: makeEntryId(),
          source: "external",
          fileKey,
          fingerprint: buildClipFingerprint(fileKey, normalized, clipIndex),
          sourceName: file.name,
          displayName,
          role,
          clip: normalized,
          error: null,
          targetHint: summarizeTrackTargets(normalized),
          autoLabel: plan.autoLabel,
          analysis: plan.info,
        });
      }
    }

    const dedupedByFingerprint = new Map();
    for (const entry of retainedEntries.concat(loadedEntries)) {
      const dedupeKey = entry.fingerprint || `${entry.fileKey || entry.sourceName || entry.displayName}::${entry.error || "no-clip"}`;
      dedupedByFingerprint.set(dedupeKey, entry);
    }

    this.externalEntries = Array.from(dedupedByFingerprint.values());
    this._skippedExternalCount = skippedCount;
    this._reconcileEntries();
    this._rebuildActions();
    this._render();

    const usable = this.entries.filter((entry) => !!entry.clip).length;
    const dead = this.entries.filter((entry) => !entry.clip).length;

    if (this.statusEl) {
      if (!usable) {
        this.statusEl.textContent = "No usable locomotion clips were found in the uploaded files. The T-pose is expected in that case.";
      } else if (dead) {
        this.statusEl.textContent = `Loaded ${usable} usable clip(s). ${dead} file(s) had no usable animations.`;
      } else {
        this.statusEl.textContent = `Loaded ${usable} usable locomotion clip(s). Separate uploads append cleanly, duplicate file re-uploads replace older rows, and likely setup/combat clips are skipped out of the locomotion list.`;
      }
    }
  }

  clearExternalClips() {
    this.externalEntries = [];
    this._skippedExternalCount = 0;
    this._reconcileEntries();
    this._rebuildActions();
    this._render();

    if (this.statusEl) {
      this.statusEl.textContent = "External locomotion clips cleared.";
    }
  }

  _buildEntriesFromClips(clips, sourceName, source) {
    const usedRoles = new Set();
    const entries = [];
    let skippedCount = 0;

    for (let clipIndex = 0; clipIndex < (clips || []).length; clipIndex += 1) {
      const clip = clips[clipIndex];
      const plan = inferRolePlan(sourceName, clip, usedRoles);

      if (plan.skip) {
        skippedCount += 1;
        continue;
      }

      const normalized = normalizeClip(clip, sourceName);
      const role = plan.role;
      if (role !== DEFAULT_ROLE && role !== GENERIC_STRAFE_ROLE) {
        usedRoles.add(role);
      }

      entries.push({
        id: makeEntryId(),
        source,
        sourceName,
        displayName: buildDisplayName(sourceName, clip, clipIndex, clips.length),
        role,
        clip: normalized,
        error: null,
        targetHint: summarizeTrackTargets(normalized),
        autoLabel: plan.autoLabel,
        analysis: plan.info,
        fingerprint: `${source}::${sourceName}::${clip.name || "(unnamed)"}::${clipIndex}`,
      });
    }

    return { entries, skippedCount };
  }

  async _loadGltfFromFile(file) {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        this.loader.load(url, resolve, undefined, reject);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  _reconcileEntries() {
    this.entries = [...this.embeddedEntries, ...this.externalEntries];
  }

  _setEntryRole(entryId, nextRole) {
    const safeRole = nextRole || DEFAULT_ROLE;
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry || !entry.clip) return;

    if (safeRole !== DEFAULT_ROLE) {
      for (const other of this.entries) {
        if (other.id !== entryId && other.role === safeRole && safeRole !== GENERIC_STRAFE_ROLE) {
          other.role = DEFAULT_ROLE;
        }
      }
    }

    entry.role = safeRole;

    if (entry.source === "embedded") {
      this.embeddedEntries = this.entries.filter((item) => item.source === "embedded");
    } else {
      this.externalEntries = this.entries.filter((item) => item.source === "external");
    }

    this._rebuildActions();
    this._render();
  }

  _removeEntry(entryId) {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry) return;

    if (this.previewEntryId === entryId) {
      this.previewEntryId = null;
      this.previewAction?.setEffectiveWeight(0);
      this.previewAction = null;
    }

    if (entry.source === "embedded") {
      this.embeddedEntries = this.embeddedEntries.filter((item) => item.id !== entryId);
    } else {
      this.externalEntries = this.externalEntries.filter((item) => item.id !== entryId);
    }

    this._reconcileEntries();
    this._rebuildActions();
    this._render();

    if (this.statusEl) {
      this.statusEl.textContent = `${entry.displayName} removed from the locomotion list.`;
    }
  }

  _getAssignedEntry(role) {
    return this.entries.find((entry) => entry.role === role && !!entry.clip) || null;
  }

  _configureAction(action, role) {
    if (isOneShotRole(role)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    }

    action.enabled = true;
    action.play();
    action.setEffectiveWeight(0);
    action.setEffectiveTimeScale(1);
  }

  _rebuildActions() {
    if (!this.mixer || !this.characterRoot) return;

    this.mixer.stopAllAction();
    this.actions.clear();
    this._smoothedWeights.clear();

    for (const { value: role } of this.availableRoles) {
      const entry = this._getAssignedEntry(role);
      if (!entry) continue;

      const action = this.mixer.clipAction(entry.clip, this.characterRoot);
      this._configureAction(action, role);
      this.actions.set(role, action);
      this._smoothedWeights.set(role, 0);
    }

    if (this.previewEntryId && !this.entries.some((entry) => entry.id === this.previewEntryId)) {
      this.previewEntryId = null;
      this.previewAction = null;
    }
  }

  _setPreviewEntry(entryId) {
    if (!this.mixer) return;

    if (this.previewEntryId === entryId) {
      this.previewEntryId = null;
      this.previewAction?.setEffectiveWeight(0);
      this.previewAction = null;
      this._render();
      return;
    }

    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry?.clip) return;

    const action = this.mixer.clipAction(entry.clip, this.characterRoot);
    action.reset();
    action.enabled = true;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();

    this.previewEntryId = entryId;
    this.previewAction = action;
    this._render();
  }

  _render() {
    if (this.summaryEl) {
      const total = this.entries.length;
      const usable = this.entries.filter((entry) => !!entry.clip).length;
      const dead = this.entries.filter((entry) => !entry.clip).length;
      const mappedCount = this.entries.filter((entry) => entry.role !== DEFAULT_ROLE && !!entry.clip).length;
      const externalCount = this.externalEntries.length;
      const skippedCount = this._skippedEmbeddedCount + this._skippedExternalCount;

      if (!total) {
        this.summaryEl.textContent = skippedCount
          ? `No locomotion rows left after filtering. Skipped likely setup / combat clips: ${skippedCount}.`
          : "No locomotion clips loaded yet.";
      } else {
        this.summaryEl.textContent = `Rows: ${total}. External rows: ${externalCount}. Usable clips: ${usable}. Empty/bad files: ${dead}. Mapped roles: ${mappedCount}. Skipped likely setup / combat clips: ${skippedCount}.`;
      }
    }

    if (!this.clipListEl) return;

    this.clipListEl.innerHTML = "";

    if (!this.entries.length) {
      const empty = document.createElement("div");
      empty.className = "clipEmpty";
      empty.textContent = "Load your GLB pack here. Separate uploads append instead of stomping the existing list, likely setup/combat clips get filtered out, and every visible row can be removed on the right.";
      this.clipListEl.appendChild(empty);
      return;
    }

    for (const entry of this.entries) {
      const row = document.createElement("div");
      row.className = "clipRow";

      const info = document.createElement("div");
      info.className = "clipInfo";

      const name = document.createElement("div");
      name.className = "clipName";
      name.textContent = entry.displayName;

      const meta = document.createElement("div");
      meta.className = "clipMeta";
      if (entry.clip) {
        const sourceLabel = entry.source === "embedded" ? "from character" : "external clip";
        const autoLabel = entry.autoLabel ? ` • ${entry.autoLabel}` : "";
        const targetInfo = entry.targetHint ? ` • tracks: ${entry.targetHint}` : "";
        meta.textContent = `${sourceLabel} • ${entry.clip.duration.toFixed(2)}s${autoLabel}${targetInfo}`;
      } else {
        meta.textContent = entry.error || "No usable animation clip.";
      }

      info.appendChild(name);
      info.appendChild(meta);

      const select = document.createElement("select");
      select.className = "clipSelect";
      select.disabled = !entry.clip;
      for (const optionDef of ROLE_OPTIONS) {
        const option = document.createElement("option");
        option.value = optionDef.value;
        option.textContent = optionDef.label;
        option.selected = optionDef.value === entry.role;
        select.appendChild(option);
      }
      select.addEventListener("change", (event) => {
        this._setEntryRole(entry.id, event.target.value);
      });

      const actions = document.createElement("div");
      actions.className = "clipActions";

      const previewButton = document.createElement("button");
      previewButton.type = "button";
      previewButton.className = "clipPreviewButton";
      previewButton.disabled = !entry.clip;
      previewButton.textContent = !entry.clip ? "No clip" : (this.previewEntryId === entry.id ? "Stop" : "Preview");
      previewButton.addEventListener("click", () => {
        this._setPreviewEntry(entry.id);
      });

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "clipRemoveButton";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", () => {
        this._removeEntry(entry.id);
      });

      actions.appendChild(previewButton);
      actions.appendChild(removeButton);

      row.appendChild(info);
      row.appendChild(select);
      row.appendChild(actions);
      this.clipListEl.appendChild(row);
    }
  }

  _applyAutoGroundOffset(offsetWorld) {
    const metrics = this.characterRoot?.userData?.characterMetrics;
    const visualRoot = this.characterRoot?.userData?.visualRoot;
    if (!metrics || !visualRoot) return;

    const safeScale = Math.max(0.01, metrics.scale || 1);
    visualRoot.position.y = metrics.baseCenterOffset + ((metrics.footOffsetWorld || 0) + offsetWorld) / safeScale;
  }

  _syncAnimatedFooting(dt, pose) {
    const metrics = this.characterRoot?.userData?.characterMetrics;
    const visualRoot = this.characterRoot?.userData?.visualRoot;
    if (!metrics || !visualRoot) return;

    let targetOffsetWorld = 0;

    if (pose?.grounded && measureAnimatedRenderableBounds(this.characterRoot, _boundsBox)) {
      const safeScale = Math.max(0.01, metrics.scale || 1);
      targetOffsetWorld = clamp(-_boundsBox.min.y * safeScale, -this._autoGroundMaxOffset, this._autoGroundMaxOffset);
    }

    const lambda = targetOffsetWorld > this._autoGroundWorldOffset ? 18 : 12;
    this._autoGroundWorldOffset = damp(this._autoGroundWorldOffset, targetOffsetWorld, lambda, dt);
    this._applyAutoGroundOffset(this._autoGroundWorldOffset);
  }

  update(dt, pose) {
    if (!this.mixer) return;
    this._lastPose = pose || this._lastPose;
    const currentPose = this._lastPose;
    if (!currentPose) {
      this.mixer.update(dt);
      this._syncAnimatedFooting(dt, null);
      return;
    }

    if (this.previewEntryId && this.previewAction) {
      for (const action of this.actions.values()) {
        action.enabled = true;
        action.setEffectiveWeight(0);
      }
      this.previewAction.enabled = true;
      this.previewAction.setEffectiveWeight(1);
      this.previewAction.setEffectiveTimeScale(1);
      this.mixer.update(dt);
      this._syncAnimatedFooting(dt, currentPose);
      return;
    }

    const targets = this._computeTargets(currentPose);
    const roles = new Set([...Object.keys(targets), ...this.actions.keys()]);

    for (const role of roles) {
      const action = this.actions.get(role);
      if (!action) continue;

      const target = targets[role] || { weight: 0, timeScale: 1, resetIfRising: false };
      const prevWeight = this._smoothedWeights.get(role) || 0;
      const nextWeight = damp(prevWeight, target.weight, target.weight > prevWeight ? 20 : 14, dt);

      if (target.resetIfRising && prevWeight < 0.1 && nextWeight >= 0.1) {
        action.reset();
        action.play();
      }

      action.enabled = nextWeight > 0.0001;
      action.setEffectiveWeight(nextWeight);
      action.setEffectiveTimeScale(target.timeScale || 1);

      this._smoothedWeights.set(role, nextWeight);
    }

    this.mixer.update(dt);
    this._syncAnimatedFooting(dt, currentPose);
  }

  _computeTargets(pose) {
    const targets = {};

    const speed = Math.hypot(pose.velocityX || 0, pose.velocityZ || 0);
    const absLocalX = Math.abs(pose.localVelocityX || 0);
    const absLocalZ = Math.abs(pose.localVelocityZ || 0);
    const directionalSum = Math.max(0.0001, absLocalX + absLocalZ);
    const moveAlpha = clamp(speed / Math.max(0.001, pose.walkSpeed * 0.45), 0, 1);
    const strafeShare = clamp(absLocalX / directionalSum, 0, 1);
    const forwardShare = clamp(absLocalZ / directionalSum, 0, 1);

    const runMix = clamp(
      (speed - pose.walkSpeed * 0.65) / Math.max(0.001, pose.runReferenceSpeed - pose.walkSpeed * 0.65),
      0,
      1
    );

    if (!pose.grounded) {
      if (pose.velocityY > 0.1 && this.actions.has("jump")) {
        targets.jump = {
          weight: 1,
          timeScale: makeTimeScale(Math.max(speed, pose.walkSpeed), pose.runReferenceSpeed, 0.95, 1.4),
          resetIfRising: true,
        };
        return targets;
      }

      if (this.actions.has("fall")) {
        targets.fall = { weight: 1, timeScale: 1, resetIfRising: true };
        return targets;
      }

      if (this.actions.has("jump")) {
        targets.jump = { weight: 1, timeScale: 1, resetIfRising: true };
        return targets;
      }
    }

    if ((pose.crouchHeld || pose.slideActive) && (this.actions.has("crouchIdle") || this.actions.has("crouchMove"))) {
      if (speed < 0.2 && this.actions.has("crouchIdle")) {
        targets.crouchIdle = { weight: 1, timeScale: 1 };
        return targets;
      }

      if (this.actions.has("crouchMove")) {
        targets.crouchMove = {
          weight: 1,
          timeScale: makeTimeScale(speed, pose.walkSpeed * 0.8, 0.8, 1.35),
        };
        return targets;
      }
    }

    const idleWeight = clamp(1 - moveAlpha, 0, 1);
    if (this.actions.has("idle")) {
      targets.idle = { weight: idleWeight, timeScale: 1 };
    }

    const canStrafeLeft = this.actions.has("strafeLeft");
    const canStrafeRight = this.actions.has("strafeRight");
    const canGenericStrafe = this.actions.has(GENERIC_STRAFE_ROLE);

    if (moveAlpha > 0.001) {
      const locomotionWeight = 1 - idleWeight;
      const strafeWeight = locomotionWeight * strafeShare;
      const forwardWeight = locomotionWeight * forwardShare;

      if ((pose.localVelocityX || 0) > 0.05 && canStrafeLeft) {
        targets.strafeLeft = {
          weight: strafeWeight,
          timeScale: makeTimeScale(speed, pose.walkSpeed, 0.85, 1.45),
        };
      } else if ((pose.localVelocityX || 0) < -0.05 && canStrafeRight) {
        targets.strafeRight = {
          weight: strafeWeight,
          timeScale: makeTimeScale(speed, pose.walkSpeed, 0.85, 1.45),
        };
      } else if (strafeWeight > 0.001 && canGenericStrafe) {
        targets[GENERIC_STRAFE_ROLE] = {
          weight: strafeWeight,
          timeScale: makeTimeScale(speed, pose.walkSpeed, 0.85, 1.45),
        };
      }

      if (forwardWeight > 0.001) {
        const walkWeight = forwardWeight * (1 - runMix);
        const runWeight = forwardWeight * runMix;

        if (this.actions.has("walk")) {
          targets.walk = {
            weight: walkWeight,
            timeScale: makeTimeScale(speed, pose.walkSpeed, 0.8, 1.3),
          };
        }

        if (this.actions.has("run")) {
          targets.run = {
            weight: runWeight,
            timeScale: makeTimeScale(
              speed,
              Math.max(pose.runReferenceSpeed, pose.walkSpeed + 0.001),
              0.85,
              1.8
            ),
          };
        }
      }
    }

    const turningInPlace = speed < 0.15 && Math.abs(pose.bodyYawDelta || 0) > 0.8;
    if (turningInPlace) {
      if ((pose.bodyYawDelta || 0) > 0 && this.actions.has("turnLeft")) {
        targets.turnLeft = {
          weight: clamp(Math.abs(pose.bodyYawDelta) / 3.5, 0, 1),
          timeScale: clamp(Math.abs(pose.bodyYawDelta) / 2.2, 0.85, 1.6),
          resetIfRising: true,
        };
      } else if ((pose.bodyYawDelta || 0) < 0 && this.actions.has("turnRight")) {
        targets.turnRight = {
          weight: clamp(Math.abs(pose.bodyYawDelta) / 3.5, 0, 1),
          timeScale: clamp(Math.abs(pose.bodyYawDelta) / 2.2, 0.85, 1.6),
          resetIfRising: true,
        };
      }
    }

    return targets;
  }
}

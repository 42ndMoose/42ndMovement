import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clamp, damp } from "./utils.js";

const DEFAULT_ROLE = "unused";
const GENERIC_STRAFE_ROLE = "strafe";

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

function looksLikeRootMotionPosition(trackName) {
  const normalized = String(trackName).toLowerCase();
  if (!normalized.endsWith(".position")) return false;
  return (
    normalized.includes("hips.position") ||
    normalized.includes("pelvis.position") ||
    normalized.includes("root.position") ||
    normalized.includes("armature.position")
  );
}

function stripRootMotion(clip) {
  const keptTracks = clip.tracks.filter((track) => !looksLikeRootMotionPosition(track.name));
  return new THREE.AnimationClip(clip.name, clip.duration, keptTracks);
}

function normalizeClip(clip, sourceName) {
  const stripped = stripRootMotion(clip.clone());
  stripped.name = stripped.name || sourceName;
  return stripped;
}

function inferRoleHint(name, usedRoles) {
  const n = String(name || "").toLowerCase();

  if (n.includes("crouch") && n.includes("idle")) return "crouchIdle";
  if (n.includes("crouch") || n.includes("crouching")) return "crouchMove";
  if (n.includes("fall")) return "fall";
  if (n.includes("jump")) return "jump";
  if (n.includes("turn left")) return "turnLeft";
  if (n.includes("turn right")) return "turnRight";

  if (n.includes("strafe left")) return "strafeLeft";
  if (n.includes("strafe right")) return "strafeRight";

  if (n.includes("strafe")) {
    if (!usedRoles.has("strafeLeft")) return "strafeLeft";
    if (!usedRoles.has("strafeRight")) return "strafeRight";
    return GENERIC_STRAFE_ROLE;
  }

  if (n.includes("run") && !usedRoles.has("run")) return "run";
  if (n.includes("walk") && !usedRoles.has("walk")) return "walk";
  if (n.includes("idle") && !n.includes("block") && !n.includes("impact")) {
    if (!usedRoles.has("idle")) return "idle";
  }

  return DEFAULT_ROLE;
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
    this._rebuildActions();
  }

  setEmbeddedClips(clips, sourceName = "character") {
    this.embeddedEntries = this._buildEntriesFromClips(clips || [], sourceName, "embedded");
    if (!this.embeddedEntries.length && clips?.length) {
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

    const loadedEntries = [];
    const usedRoles = new Set(
      this.embeddedEntries
        .concat(this.externalEntries)
        .map((entry) => entry.role)
        .filter((role) => role && role !== DEFAULT_ROLE)
    );

    for (const file of list) {
      const gltf = await this._loadGltfFromFile(file);
      const clips = gltf.animations || [];

      if (!clips.length) {
        loadedEntries.push({
          id: makeEntryId(),
          source: "external",
          sourceName: file.name,
          displayName: file.name,
          role: DEFAULT_ROLE,
          clip: null,
          error: "No animation clips found in this GLB. That usually means the export stripped the animation data.",
        });
        continue;
      }

      for (const clip of clips) {
        const role = inferRoleHint(file.name, usedRoles);
        if (role !== DEFAULT_ROLE && role !== GENERIC_STRAFE_ROLE) {
          usedRoles.add(role);
        }

        const normalized = normalizeClip(clip, file.name);
        loadedEntries.push({
          id: makeEntryId(),
          source: "external",
          sourceName: file.name,
          displayName: clips.length > 1 && clip.name ? `${file.name} • ${clip.name}` : file.name,
          role,
          clip: normalized,
          error: null,
          targetHint: summarizeTrackTargets(normalized),
        });
      }
    }

    this.externalEntries = loadedEntries;
    this._reconcileEntries();
    this._rebuildActions();
    this._render();

    const usable = this.entries.filter((entry) => !!entry.clip).length;
    const dead = this.entries.filter((entry) => !entry.clip).length;

    if (this.statusEl) {
      if (!usable) {
        this.statusEl.textContent = "No usable animation clips were found in the uploaded files. The T-pose is expected in that case.";
      } else if (dead) {
        this.statusEl.textContent = `Loaded ${usable} usable clip(s). ${dead} file(s) had no usable animations.`;
      } else {
        this.statusEl.textContent = `Loaded ${usable} usable animation clip(s). Preview is on the right side of each row.`;
      }
    }
  }

  _buildEntriesFromClips(clips, sourceName, source) {
    const usedRoles = new Set();
    return (clips || []).map((clip) => {
      const role = inferRoleHint(sourceName, usedRoles);
      if (role !== DEFAULT_ROLE && role !== GENERIC_STRAFE_ROLE) {
        usedRoles.add(role);
      }

      const normalized = normalizeClip(clip, sourceName);
      return {
        id: makeEntryId(),
        source,
        sourceName,
        displayName: sourceName,
        role,
        clip: normalized,
        error: null,
        targetHint: summarizeTrackTargets(normalized),
      };
    });
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

    if (this.previewEntryId) {
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

      if (!total) {
        this.summaryEl.textContent = "No locomotion clips loaded yet.";
      } else {
        this.summaryEl.textContent = `Files processed: ${total}. Usable clips: ${usable}. Empty/bad files: ${dead}. Mapped roles: ${mappedCount}.`;
      }
    }

    if (!this.clipListEl) return;

    this.clipListEl.innerHTML = "";

    if (!this.entries.length) {
      const empty = document.createElement("div");
      empty.className = "clipEmpty";
      empty.textContent = "Load your GLB pack here. Each usable clip gets its own row with a Preview button on the right.";
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
        const targetInfo = entry.targetHint ? ` • tracks: ${entry.targetHint}` : "";
        meta.textContent = `${entry.source === "embedded" ? "from character" : "external clip"} • ${entry.clip.duration.toFixed(2)}s${targetInfo}`;
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

      const previewButton = document.createElement("button");
      previewButton.type = "button";
      previewButton.className = "clipPreviewButton";
      previewButton.disabled = !entry.clip;
      previewButton.textContent = !entry.clip ? "No clip" : (this.previewEntryId === entry.id ? "Stop" : "Preview");
      previewButton.addEventListener("click", () => {
        this._setPreviewEntry(entry.id);
      });

      row.appendChild(info);
      row.appendChild(select);
      row.appendChild(previewButton);
      this.clipListEl.appendChild(row);
    }
  }

  update(dt, pose) {
    if (!this.mixer) return;
    this._lastPose = pose || this._lastPose;
    const currentPose = this._lastPose;
    if (!currentPose) {
      this.mixer.update(dt);
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

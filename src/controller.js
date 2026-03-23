import * as THREE from "three";
import { clamp, damp, nowSec } from "./utils.js";

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camBack = new THREE.Vector3();
const _target = new THREE.Vector3();
const _camPos = new THREE.Vector3();

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function rotateAngleToward(current, target, maxDelta) {
  const delta = wrapAngle(target - current);
  return current + clamp(delta, -maxDelta, maxDelta);
}

function moveToward(current, target, maxDelta) {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

function inverseYawProjectX(worldX, worldZ, yaw) {
  return worldX * Math.cos(yaw) - worldZ * Math.sin(yaw);
}

function inverseYawProjectZ(worldX, worldZ, yaw) {
  return worldX * Math.sin(yaw) + worldZ * Math.cos(yaw);
}

export class ThirdPersonController {
  constructor({ camera, domElement, characterRoot, getGroundHeightAt, hud, onPose }) {
    this.camera = camera;
    this.domElement = domElement;
    this.characterRoot = characterRoot;
    this.getGroundHeightAt = getGroundHeightAt || (() => 0);
    this.hud = hud;
    this.onPose = onPose || null;

    this.domElement.tabIndex = this.domElement.tabIndex || 0;
    this.domElement.style.outline = "none";
    this.domElement.focus({ preventScroll: true });

    this.pos = new THREE.Vector3(0, 0.9, 0);
    this.vel = new THREE.Vector3();
    this.move = new THREE.Vector3();

    this.characterHalfHeight = 0.9;
    this.eyeHeight = 1.6;

    this.camYaw = 0;
    this.camPitch = -0.2;
    this.aimYaw = 0;
    this.aimPitch = -0.15;
    this.camTargetDist = 6.0;
    this.camDist = 6.0;
    this.camMin = 2.0;
    this.camMax = 18.0;

    this.walkSpeed = 6.0;
    this.sprintSpeeds = [0, 9.5, 13.0, 18.0, 24.0];
    this.crouchSpeedFactor = 0.78;

    this.accelGround = 52.0;
    this.accelAir = 10.0;
    this.decelGround = 28.0;
    this.airDrag = 1.35;
    this.airCarryDragFactor = 0.12;
    this.friction = 10.5;
    this.slideFriction = 1.45;
    this.slideSteerFactor = 0.28;

    this.turnRateGround = 20.0;
    this.turnRateGroundAim = 30.0;
    this.turnRateAir = 7.5;
    this.turnRateSlide = 5.0;
    this.bodyTurnRateMove = 16.0;
    this.bodyTurnRateAim = 30.0;

    this.gravity = 28.0;
    this.jumpSpeed = 9.0;
    this.jumpBuffer = 0.15;
    this.coyoteTime = 0.12;
    this.groundSnapDistance = 0.18;
    this.jumpCarryBoostMax = 1.14;
    this.jumpCarryDurationMin = 0.09;
    this.jumpCarryDurationMax = 0.22;
    this.jumpCarryDuration = 0;
    this.jumpCarryTime = 0;
    this.jumpCarryFloorSpeed = 0;
    this.jumpCarryYaw = 0;
    this.jumpCarryPreserveMinFactor = 0.95;

    this.slideEnterSpeed = 8.25;
    this.slideExitSpeed = 5.0;
    this.slideBoost = 1.08;
    this.slideActive = false;

    this.sprintStage = 0;
    this.sprintHeld = false;
    this.sprintValue = 0;
    this.lastShiftUpAt = -999;
    this.shiftChainWindow = 2.0;
    this.sprintRiseRate = 9.5;
    this.sprintDecayBaseRate = 1.8;
    this.sprintDecayExtraRate = 2.6;

    this.grounded = false;
    this.lastGroundedAt = -999;
    this.lastJumpPressedAt = -999;

    this.keys = new Set();
    this.rmbHeld = false;
    this.pointerLocked = false;
    this.sens = 0.0025;

    this._bodyYaw = 0;
    this._cameraHeightFactor = 1.0;
    this._targetCameraHeightFactor = 1.0;

    this._bindEvents();
    this._syncCharacter();
  }

  setCharacterRoot(newRoot) {
    this.characterRoot = newRoot;
    this._syncCharacter();
  }

  setCharacterMetrics({ halfHeight, eyeHeight }) {
    if (Number.isFinite(halfHeight) && halfHeight > 0) {
      this.characterHalfHeight = halfHeight;
    }
    if (Number.isFinite(eyeHeight) && eyeHeight > 0) {
      this.eyeHeight = eyeHeight;
    }

    const groundY = this.getGroundHeightAt(this.pos.x, this.pos.z);
    this.pos.y = groundY + this.characterHalfHeight;
    this.vel.y = Math.max(0, this.vel.y);
    this._syncCharacter();
  }

  _focusGame() {
    queueMicrotask(() => {
      this.domElement.focus({ preventScroll: true });
    });
  }

  async _tryKeyboardLock() {
    try {
      if (!navigator.keyboard || !navigator.keyboard.lock) return;
      await navigator.keyboard.lock([
        "KeyW", "KeyA", "KeyS", "KeyD",
        "ShiftLeft", "ShiftRight",
        "Space",
        "ControlLeft", "ControlRight",
        "KeyC",
        "AltLeft", "AltRight",
        "Backquote",
        "Tab"
      ]);
    } catch {
      // Browser can ignore this.
    }
  }

  _releaseKeyboardLock() {
    try {
      navigator.keyboard?.unlock?.();
    } catch {
      // no-op
    }
  }

  _bindEvents() {
    const onKeyDown = (e) => {
      if (e.repeat) {
        this.keys.add(e.code);
        return;
      }

      if (e.code === "AltLeft" || e.code === "AltRight" || e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();

        if (this.pointerLocked) {
          document.exitPointerLock?.();
        }

        this._focusGame();
        return;
      }

      if (
        e.ctrlKey &&
        ["KeyW", "KeyR", "KeyT", "KeyN", "Tab", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5"].includes(e.code)
      ) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        if (!this.sprintHeld) this._onShiftDown();
        this.sprintHeld = true;
      }

      if (e.code === "Space") {
        e.preventDefault();
        this.lastJumpPressedAt = nowSec();
      }

      this.keys.add(e.code);
    };

    const onKeyUp = (e) => {
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        this.sprintHeld = false;
        this.lastShiftUpAt = nowSec();
      }

      this.keys.delete(e.code);
    };

    const onMouseDown = (e) => {
      if (e.button === 2) this.rmbHeld = true;

      if (e.button === 0) {
        this.domElement.requestPointerLock?.();
        this._updateCursorStyle();
        this._focusGame();
      }
    };

    const onMouseUp = (e) => {
      if (e.button === 2) this.rmbHeld = false;
    };

    const onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.domElement;

      if (this.pointerLocked) {
        this.aimYaw = this.camYaw;
        this.aimPitch = this.camPitch;
        this._tryKeyboardLock();
      } else {
        this.camYaw = this.aimYaw;
        this.camPitch = this.aimPitch;
        this._releaseKeyboardLock();
        this._focusGame();
      }

      this._updateCursorStyle();
    };

    const onMouseMove = (e) => {
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;

      if (this.pointerLocked) {
        this.aimYaw -= dx * this.sens;
        this.aimPitch -= dy * this.sens;
        this.aimPitch = clamp(this.aimPitch, -1.1, 0.35);

        this.camYaw = this.aimYaw;
        this.camPitch = this.aimPitch;
        return;
      }

      if (!this.rmbHeld) return;

      this.camYaw -= dx * this.sens;
      this.camPitch -= dy * this.sens;
      this.camPitch = clamp(this.camPitch, -1.2, 0.35);

      this.aimYaw = this.camYaw;
      this.aimPitch = this.camPitch;
    };

    const onWheel = (e) => {
      const delta = Math.sign(e.deltaY);
      this.camTargetDist = clamp(this.camTargetDist + delta * 0.7, this.camMin, this.camMax);
    };

    const onBlur = () => {
      this.keys.clear();
      this.rmbHeld = false;
      this.sprintHeld = false;
      this.sprintStage = 0;
      this.sprintValue = 0;
      this.jumpCarryDuration = 0;
      this.jumpCarryTime = 0;
      this.jumpCarryFloorSpeed = 0;
    };

    const onVisibility = () => {
      if (document.hidden) onBlur();
    };

    window.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    this.domElement.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("pointerlockchange", onPointerLockChange);
    window.addEventListener("focus", () => this._focusGame());
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);

    this._updateCursorStyle();
  }

  _updateCursorStyle() {
    this.domElement.style.cursor = this.pointerLocked ? "none" : "crosshair";
  }

  _onShiftDown() {
    const t = nowSec();
    const dtSinceUp = t - this.lastShiftUpAt;
    this.sprintStage = (dtSinceUp <= this.shiftChainWindow)
      ? Math.min(4, Math.max(1, this.sprintStage + 1))
      : 1;
  }

  _timeSinceShiftUp() {
    return nowSec() - this.lastShiftUpAt;
  }

  _sprintStageActive() {
    if (this.sprintHeld) return this.sprintStage;
    if (this.sprintStage > 0 && this._timeSinceShiftUp() <= this.shiftChainWindow) return this.sprintStage;
    this.sprintStage = 0;
    return 0;
  }

  _sampleSprintSpeed(stageValue) {
    const maxStage = this.sprintSpeeds.length - 1;
    const clampedStage = clamp(stageValue, 0, maxStage);
    const lo = Math.floor(clampedStage);
    const hi = Math.min(maxStage, Math.ceil(clampedStage));
    const t = clampedStage - lo;
    return THREE.MathUtils.lerp(this.sprintSpeeds[lo], this.sprintSpeeds[hi], t);
  }

  _updateSprintValue(dt, stageActive) {
    let target = 0;

    if (this.sprintHeld) {
      target = stageActive;
    } else if (stageActive > 0 && this._timeSinceShiftUp() <= this.shiftChainWindow) {
      target = Math.max(0, stageActive - 1);
    }

    if (target >= this.sprintValue) {
      this.sprintValue = moveToward(this.sprintValue, target, this.sprintRiseRate * dt);
    } else {
      const decayRate = this.sprintDecayBaseRate + this.sprintValue * this.sprintDecayExtraRate;
      this.sprintValue = moveToward(this.sprintValue, target, decayRate * dt);
    }

    return target;
  }

  _isCrouchHeld() {
    return this.keys.has("KeyC") || this.keys.has("ControlLeft") || this.keys.has("ControlRight");
  }

  _consumeBufferedJump() {
    const t = nowSec();
    const jumpBuffered = (t - this.lastJumpPressedAt) <= this.jumpBuffer;
    const coyoteActive = this.grounded || (t - this.lastGroundedAt) <= this.coyoteTime;
    if (!jumpBuffered || !coyoteActive) return false;

    const planarSpeed = Math.hypot(this.vel.x, this.vel.z);
    const sprintAlpha = clamp(
      this.sprintValue / Math.max(1, this.sprintSpeeds.length - 1),
      0,
      1
    );

    if (planarSpeed > 0.0001) {
      const launchYaw = Math.atan2(this.vel.x, this.vel.z);
      const carriedSpeed = planarSpeed * THREE.MathUtils.lerp(1.0, this.jumpCarryBoostMax, sprintAlpha);
      this.vel.x = Math.sin(launchYaw) * carriedSpeed;
      this.vel.z = Math.cos(launchYaw) * carriedSpeed;
      this.jumpCarryYaw = launchYaw;
      this.jumpCarryFloorSpeed = carriedSpeed;
      this.jumpCarryDuration = THREE.MathUtils.lerp(
        this.jumpCarryDurationMin,
        this.jumpCarryDurationMax,
        sprintAlpha
      );
      this.jumpCarryTime = this.jumpCarryDuration;
    } else {
      this.jumpCarryYaw = this._bodyYaw;
      this.jumpCarryFloorSpeed = 0;
      this.jumpCarryDuration = 0;
      this.jumpCarryTime = 0;
    }

    this.lastJumpPressedAt = -999;
    this.grounded = false;
    this.slideActive = false;
    this.vel.y = this.jumpSpeed;
    return true;
  }

  _steerPlanarVelocity(targetYaw, targetSpeed, turnRate, accelRate, decelRate, dt) {
    const currentSpeed = Math.hypot(this.vel.x, this.vel.z);
    let nextYaw = targetYaw;

    if (currentSpeed > 0.0001) {
      const currentYaw = Math.atan2(this.vel.x, this.vel.z);
      nextYaw = rotateAngleToward(currentYaw, targetYaw, turnRate * dt);
    }

    let nextSpeed = currentSpeed;
    if (targetSpeed >= currentSpeed) {
      nextSpeed = moveToward(currentSpeed, targetSpeed, accelRate * dt);
    } else {
      nextSpeed = moveToward(currentSpeed, targetSpeed, decelRate * dt);
    }

    this.vel.x = Math.sin(nextYaw) * nextSpeed;
    this.vel.z = Math.cos(nextYaw) * nextSpeed;
  }

  update(dt) {
    const basisYaw = this.pointerLocked ? this.aimYaw : this.camYaw;

    _forward.set(Math.sin(basisYaw), 0, Math.cos(basisYaw));
    _right.set(_forward.z, 0, -_forward.x);

    let x = 0;
    let z = 0;

    if (this.keys.has("KeyW")) z += 1;
    if (this.keys.has("KeyS")) z -= 1;

    // Preserve the existing repo strafe convention exactly.
    if (this.keys.has("KeyD")) x -= 1;
    if (this.keys.has("KeyA")) x += 1;

    this.move.set(0, 0, 0);
    this.move.addScaledVector(_forward, z);
    this.move.addScaledVector(_right, x);

    const hasMove = this.move.lengthSq() > 0.0001;
    if (hasMove) this.move.normalize();

    const crouchHeld = this._isCrouchHeld();
    const stageActive = this._sprintStageActive();
    this._updateSprintValue(dt, stageActive);

    const planarSpeedBefore = Math.hypot(this.vel.x, this.vel.z);

    if (this.grounded && crouchHeld && !this.slideActive && planarSpeedBefore >= this.slideEnterSpeed) {
      this.slideActive = true;
      this.vel.x *= this.slideBoost;
      this.vel.z *= this.slideBoost;
    }

    if (!crouchHeld && this.slideActive && planarSpeedBefore <= this.walkSpeed * 1.1) {
      this.slideActive = false;
    }

    if (this.slideActive && planarSpeedBefore <= this.slideExitSpeed) {
      this.slideActive = false;
    }

    let baseSpeed = this.walkSpeed;
    if (this.sprintValue > 0.001) baseSpeed = this._sampleSprintSpeed(this.sprintValue);
    if (crouchHeld && !this.slideActive) baseSpeed *= this.crouchSpeedFactor;

    if (this.grounded) {
      if (this.slideActive) {
        const speed = Math.hypot(this.vel.x, this.vel.z);
        const yaw = speed > 0.001 ? Math.atan2(this.vel.x, this.vel.z) : (hasMove ? Math.atan2(this.move.x, this.move.z) : this._bodyYaw);
        const nextSpeed = Math.max(0, speed - speed * this.slideFriction * dt);
        let nextYaw = yaw;

        if (hasMove) {
          const desiredYaw = Math.atan2(this.move.x, this.move.z);
          nextYaw = rotateAngleToward(yaw, desiredYaw, this.turnRateSlide * dt);
        }

        const floor = hasMove ? Math.max(baseSpeed * 0.72, nextSpeed) : nextSpeed;
        this.vel.x = Math.sin(nextYaw) * floor;
        this.vel.z = Math.cos(nextYaw) * floor;
      } else if (hasMove) {
        const desiredYaw = Math.atan2(this.move.x, this.move.z);
        const turnRate = this.pointerLocked ? this.turnRateGroundAim : this.turnRateGround;
        this._steerPlanarVelocity(desiredYaw, baseSpeed, turnRate, this.accelGround, this.decelGround, dt);
      } else {
        this._steerPlanarVelocity(
          Math.atan2(this.vel.x, this.vel.z || 0.0001),
          0,
          this.turnRateGround,
          this.accelGround,
          this.decelGround,
          dt
        );
      }
    } else {
      const carryActive = this.jumpCarryTime > 0 && this.jumpCarryFloorSpeed > 0.0001;
      const carryAlpha = carryActive
        ? clamp(this.jumpCarryTime / Math.max(this.jumpCarryDuration, 0.0001), 0, 1)
        : 0;

      const airDrag = carryActive
        ? this.airDrag * THREE.MathUtils.lerp(1.0, this.airCarryDragFactor, carryAlpha)
        : this.airDrag;

      const airDecay = Math.exp(-airDrag * dt);
      this.vel.x *= airDecay;
      this.vel.z *= airDecay;

      if (hasMove) {
        const desiredYaw = Math.atan2(this.move.x, this.move.z);
        const carryFloorSpeed = carryActive
          ? this.jumpCarryFloorSpeed * THREE.MathUtils.lerp(this.jumpCarryPreserveMinFactor, 1.0, carryAlpha)
          : 0;

        const desiredSpeed = carryActive
          ? Math.max(Math.hypot(this.vel.x, this.vel.z), carryFloorSpeed)
          : Math.max(Math.hypot(this.vel.x, this.vel.z), baseSpeed * 0.7);

        const airAccel = carryActive ? this.accelAir * 0.75 : this.accelAir;
        this._steerPlanarVelocity(desiredYaw, desiredSpeed, this.turnRateAir, airAccel, airAccel, dt);
      }

      if (carryActive) {
        const carryFloorSpeed = this.jumpCarryFloorSpeed * THREE.MathUtils.lerp(
          this.jumpCarryPreserveMinFactor,
          1.0,
          carryAlpha
        );

        const currentSpeed = Math.hypot(this.vel.x, this.vel.z);
        if (currentSpeed < carryFloorSpeed) {
          const carryYaw = currentSpeed > 0.0001 ? Math.atan2(this.vel.x, this.vel.z) : this.jumpCarryYaw;
          this.vel.x = Math.sin(carryYaw) * carryFloorSpeed;
          this.vel.z = Math.cos(carryYaw) * carryFloorSpeed;
        }

        this.jumpCarryTime = Math.max(0, this.jumpCarryTime - dt);
      }
    }

    this._consumeBufferedJump();

    this.vel.y -= this.gravity * dt;
    this.pos.addScaledVector(this.vel, dt);

    const groundY = this.getGroundHeightAt(this.pos.x, this.pos.z);
    const footY = this.pos.y - this.characterHalfHeight;
    const distToGround = footY - groundY;

    if (this.vel.y <= 0 && distToGround <= this.groundSnapDistance) {
      this.pos.y = groundY + this.characterHalfHeight;
      this.vel.y = 0;
      this.grounded = true;
      this.lastGroundedAt = nowSec();
      this.jumpCarryDuration = 0;
      this.jumpCarryTime = 0;
      this.jumpCarryFloorSpeed = 0;
    } else {
      this.grounded = false;
    }

    this._targetCameraHeightFactor = (crouchHeld || this.slideActive) ? 0.72 : 1.0;
    this._cameraHeightFactor = damp(this._cameraHeightFactor, this._targetCameraHeightFactor, 16.0, dt);

    let targetBodyYaw = this._bodyYaw;
    const planarSpeed = Math.hypot(this.vel.x, this.vel.z);

    if (this.slideActive && planarSpeed > 0.25) {
      targetBodyYaw = Math.atan2(this.vel.x, this.vel.z);
    } else if (this.pointerLocked) {
      targetBodyYaw = this.camYaw;
    } else if (hasMove) {
      targetBodyYaw = Math.atan2(this.move.x, this.move.z);
    }

    const bodyTurnRate = this.pointerLocked ? this.bodyTurnRateAim : this.bodyTurnRateMove;
    const prevBodyYaw = this._bodyYaw;
    this._bodyYaw = rotateAngleToward(this._bodyYaw, targetBodyYaw, bodyTurnRate * dt);
    this.characterRoot.rotation.y = this._bodyYaw;

    this.camDist = damp(this.camDist, this.camTargetDist, 10.0, dt);

    const height = this.eyeHeight * this._cameraHeightFactor;
    _target.set(this.pos.x, this.pos.y + height, this.pos.z);

    _camBack.set(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch)
    );

    _camPos.copy(_target).addScaledVector(_camBack, -this.camDist);

    if (this.pointerLocked) {
      this.camera.position.copy(_camPos);
    } else {
      this.camera.position.lerp(_camPos, 1 - Math.exp(-16.0 * dt));
    }
    this.camera.lookAt(_target);

    this._syncCharacter();
    this._updateHud(stageActive);

    if (this.onPose) {
      const localVelocityX = inverseYawProjectX(this.vel.x, this.vel.z, this._bodyYaw);
      const localVelocityZ = inverseYawProjectZ(this.vel.x, this.vel.z, this._bodyYaw);
      const localMoveX = inverseYawProjectX(this.move.x, this.move.z, this._bodyYaw);
      const localMoveZ = inverseYawProjectZ(this.move.x, this.move.z, this._bodyYaw);

      this.onPose({
        position: this.pos,
        bodyYaw: this._bodyYaw,
        bodyYawDelta: wrapAngle(this._bodyYaw - prevBodyYaw) / Math.max(dt, 0.0001),
        grounded: this.grounded,
        speed: planarSpeed,
        slideActive: this.slideActive,
        crouchHeld,
        pointerLocked: this.pointerLocked,
        sprintStage: stageActive,
        sprintValue: this.sprintValue,
        velocityX: this.vel.x,
        velocityY: this.vel.y,
        velocityZ: this.vel.z,
        localVelocityX,
        localVelocityZ,
        localMoveX,
        localMoveZ,
        moveInputActive: hasMove,
        walkSpeed: this.walkSpeed,
        runReferenceSpeed: this.sprintSpeeds[1],
      });
    }
  }

  _syncCharacter() {
    this.characterRoot.position.copy(this.pos);
  }

  _updateHud(stageActive) {
    if (!this.hud) return;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.hud.speed.textContent = `Speed: ${speed.toFixed(1)}`;
    this.hud.sprint.textContent = `Sprint: ${stageActive} • carry ${this.sprintValue.toFixed(2)}${this.slideActive ? " • slide" : ""}`;
    this.hud.mode.textContent = `Mode: ${this.pointerLocked ? "aim" : "free"}`;
  }
}

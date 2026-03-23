import * as THREE from "three";
import { clamp } from "./utils.js";

const ORBIT_ANGLES = [0, Math.PI, Math.PI * 0.5, -Math.PI * 0.5, Math.PI * 0.25, -Math.PI * 0.75];

export class AudioEmitterSystem {
  constructor({ listener, scene, camera, domOverlayList, sharedTrackUI }) {
    this.listener = listener;
    this.scene = scene;
    this.camera = camera;
    this.domOverlayList = domOverlayList;

    this.raycaster = new THREE.Raycaster();
    this.mouseNDC = new THREE.Vector2();

    this.emitters = [];

    this.sharedTrack = {
      buffer: null,
      playing: false,
      orbitEnabled: true,
      orbitRadius: 8,
      orbitSpeed: 0.55,
      orbitPhase: 0,
    };

    this.sharedTrackUI = sharedTrackUI || null;

    this._bindPicking();
    this._bindSharedTrackUI();
  }

  createEmitters() {
    const points = [
      { name: "Emitter A", pos: new THREE.Vector3(8, 0, 0) },
      { name: "Emitter B", pos: new THREE.Vector3(-8, 0, 0) },
      { name: "Emitter C", pos: new THREE.Vector3(0, 0, 8) },
      { name: "Emitter D", pos: new THREE.Vector3(0, 0, -8) },
      { name: "Emitter E", pos: new THREE.Vector3(12, 0, 12) },
      { name: "Emitter F", pos: new THREE.Vector3(-12, 0, -12) },
    ];

    for (let i = 0; i < points.length; i++) {
      const e = this._makeOne(points[i], i);
      this.emitters.push(e);
      this.scene.add(e.group);
      this._addRowUI(e);
    }

    this._syncUI();
  }

  _makeOne({ name, pos }, index) {
    const group = new THREE.Group();
    group.position.copy(pos);

    const baseGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.25, 24);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.9, metalness: 0.05 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.125;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const vizGeo = new THREE.BoxGeometry(0.18, 1.0, 0.18);
    const vizMat = new THREE.MeshStandardMaterial({ color: 0xced6e0, roughness: 0.7, metalness: 0.1 });
    const viz = new THREE.Mesh(vizGeo, vizMat);
    viz.position.set(0, 0.95, 0);
    viz.castShadow = true;
    viz.receiveShadow = true;
    group.add(viz);

    const ringGeo = new THREE.TorusGeometry(1.1, 0.03, 10, 48);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 1.0, metalness: 0.0 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    group.add(ring);

    const audioAnchor = new THREE.Object3D();
    audioAnchor.position.set(0, 0.95, 0);
    group.add(audioAnchor);

    const sound = new THREE.PositionalAudio(this.listener);
    sound.setRefDistance(4);
    sound.setRolloffFactor(1.35);
    sound.setDistanceModel("inverse");
    sound.setDirectionalCone(220, 280, 0.35);
    audioAnchor.add(sound);

    const ctx = this.listener.context;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220 + index * 50;

    const gain = ctx.createGain();
    gain.gain.value = 0.0;

    osc.connect(gain);
    sound.setNodeSource(gain);
    osc.start();

    const analyser = new THREE.AudioAnalyser(sound, 64);

    group.userData._isEmitter = true;

    return {
      name,
      group,
      base,
      viz,
      ring,
      sound,
      analyser,
      audioAnchor,
      basePosition: pos.clone(),
      orbitAngle: ORBIT_ANGLES[index % ORBIT_ANGLES.length],
      playing: false,
      sourceKind: "osc",
      oscNode: osc,
      nodeGain: gain,
      fileSource: null,
      _ui: null,
    };
  }

  async setEmitterFile(emitter, file) {
    const ctx = this.listener.context;
    const arr = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arr);

    if (emitter.fileSource) {
      try { emitter.fileSource.stop(); } catch {}
      emitter.fileSource = null;
    }

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.loop = true;

    emitter.nodeGain.gain.value = emitter.playing ? 0.9 : 0.0;

    try { emitter.oscNode.disconnect(); } catch {}

    src.connect(emitter.nodeGain);
    src.start();

    emitter.sourceKind = "file";
    emitter.fileSource = src;
  }

  async setSharedTrackFile(file) {
    const ctx = this.listener.context;
    const arr = await file.arrayBuffer();
    this.sharedTrack.buffer = await ctx.decodeAudioData(arr);
    this._syncUI();
  }

  stopSharedTrack() {
    for (const emitter of this.emitters) {
      if (emitter.fileSource && emitter.sourceKind === "shared") {
        try { emitter.fileSource.stop(); } catch {}
        emitter.fileSource = null;
      }

      if (emitter.sourceKind === "shared") {
        emitter.sourceKind = "osc";
        emitter.playing = false;
        try {
          emitter.oscNode.disconnect();
        } catch {}
        emitter.oscNode.connect(emitter.nodeGain);
        emitter.nodeGain.gain.value = 0.0;
      }
    }

    this.sharedTrack.playing = false;
    this._syncUI();
  }

  startSharedTrack() {
    if (!this.sharedTrack.buffer) return;

    this.stopSharedTrack();
    this.listener.context.resume?.();

    const ctx = this.listener.context;
    const when = ctx.currentTime + 0.05;

    for (const emitter of this.emitters) {
      if (emitter.fileSource) {
        try { emitter.fileSource.stop(); } catch {}
        emitter.fileSource = null;
      }
      try { emitter.oscNode.disconnect(); } catch {}

      const src = ctx.createBufferSource();
      src.buffer = this.sharedTrack.buffer;
      src.loop = true;
      src.connect(emitter.nodeGain);
      src.start(when);

      emitter.fileSource = src;
      emitter.sourceKind = "shared";
      emitter.playing = true;
      emitter.nodeGain.gain.value = 0.72;
    }

    this.sharedTrack.playing = true;
    this._syncUI();
  }

  toggleSharedTrack() {
    if (!this.sharedTrack.buffer) return;
    if (this.sharedTrack.playing) {
      this.stopSharedTrack();
    } else {
      this.startSharedTrack();
    }
  }

  toggleEmitter(emitter) {
    this.listener.context.resume?.();

    if (this.sharedTrack.playing) {
      this.stopSharedTrack();
    }

    emitter.playing = !emitter.playing;
    emitter.nodeGain.gain.value = emitter.playing ? 0.9 : 0.0;
  }

  update(dt) {
    if (this.sharedTrack.playing && this.sharedTrack.orbitEnabled) {
      this.sharedTrack.orbitPhase += dt * this.sharedTrack.orbitSpeed;
      const listenerWorld = new THREE.Vector3();
      this.listener.getWorldPosition(listenerWorld);

      for (const emitter of this.emitters) {
        const angle = emitter.orbitAngle + this.sharedTrack.orbitPhase;
        emitter.group.position.set(
          listenerWorld.x + Math.cos(angle) * this.sharedTrack.orbitRadius,
          0,
          listenerWorld.z + Math.sin(angle) * this.sharedTrack.orbitRadius,
        );
      }
    } else {
      for (const emitter of this.emitters) {
        emitter.group.position.copy(emitter.basePosition);
      }
    }

    for (const emitter of this.emitters) {
      const data = emitter.analyser.getFrequencyData();
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / (data.length * 255);

      const height = 0.2 + avg * 3.0;
      emitter.viz.scale.y = height;
      emitter.viz.position.y = 0.45 + height * 0.5;

      const ringScale = 1.0 + avg * 0.5;
      emitter.ring.scale.set(ringScale, ringScale, ringScale);

      if (emitter.playing) emitter.ring.rotation.z += dt * (0.6 + avg * 1.2);
    }
  }

  _bindPicking() {
    window.addEventListener("click", (ev) => {
      if (document.pointerLockElement) return;

      const rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);

      this.mouseNDC.set(x, y);
      this.raycaster.setFromCamera(this.mouseNDC, this.camera);

      const hits = this.raycaster.intersectObjects(this.emitters.map((e) => e.group), true);
      if (!hits.length) return;

      const hit = hits[0].object;
      const emitterGroup = this._findEmitterGroup(hit);
      if (!emitterGroup) return;

      const emitter = this.emitters.find((e) => e.group === emitterGroup);
      if (!emitter) return;

      this.toggleEmitter(emitter);
      this._syncUI();
    });
  }

  _bindSharedTrackUI() {
    if (!this.sharedTrackUI) return;

    const {
      fileInput,
      toggleButton,
      orbitCheckbox,
      radiusSlider,
      radiusValue,
      speedSlider,
      speedValue,
    } = this.sharedTrackUI;

    if (fileInput) {
      fileInput.addEventListener("change", async () => {
        if (!fileInput.files || !fileInput.files[0]) return;
        await this.setSharedTrackFile(fileInput.files[0]);
        this._syncUI();
      });
    }

    if (toggleButton) {
      toggleButton.addEventListener("click", () => {
        this.toggleSharedTrack();
      });
    }

    if (orbitCheckbox) {
      orbitCheckbox.addEventListener("change", () => {
        this.sharedTrack.orbitEnabled = orbitCheckbox.checked;
      });
      this.sharedTrack.orbitEnabled = orbitCheckbox.checked;
    }

    if (radiusSlider) {
      const syncRadius = () => {
        this.sharedTrack.orbitRadius = clamp(Number(radiusSlider.value) || 8, 2, 18);
        if (radiusValue) radiusValue.textContent = this.sharedTrack.orbitRadius.toFixed(1);
      };
      radiusSlider.addEventListener("input", syncRadius);
      syncRadius();
    }

    if (speedSlider) {
      const syncSpeed = () => {
        this.sharedTrack.orbitSpeed = clamp(Number(speedSlider.value) || 0, -2.5, 2.5);
        if (speedValue) speedValue.textContent = this.sharedTrack.orbitSpeed.toFixed(2);
      };
      speedSlider.addEventListener("input", syncSpeed);
      syncSpeed();
    }
  }

  _findEmitterGroup(obj) {
    let cur = obj;
    while (cur) {
      if (cur.userData && cur.userData._isEmitter) return cur;
      cur = cur.parent;
    }
    return null;
  }

  _addRowUI(emitter) {
    const row = document.createElement("div");
    row.className = "emitterRow";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = emitter.name;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.addEventListener("change", async () => {
      if (!input.files || !input.files[0]) return;
      await this.setEmitterFile(emitter, input.files[0]);
      this._syncUI();
    });

    const btn = document.createElement("button");
    btn.textContent = "Play";
    btn.addEventListener("click", () => {
      this.toggleEmitter(emitter);
      this._syncUI();
    });

    row.appendChild(name);
    row.appendChild(input);
    row.appendChild(btn);
    this.domOverlayList.appendChild(row);

    emitter._ui = { row, btn, input };
  }

  _syncUI() {
    for (const e of this.emitters) {
      if (!e._ui) continue;
      e._ui.btn.textContent = e.playing ? "Stop" : "Play";
      e._ui.row.style.opacity = e.playing ? "1.0" : "0.85";
    }

    if (!this.sharedTrackUI?.toggleButton) return;

    const btn = this.sharedTrackUI.toggleButton;
    if (!this.sharedTrack.buffer) {
      btn.textContent = "Load Shared Track First";
      btn.disabled = true;
      return;
    }

    btn.disabled = false;
    btn.textContent = this.sharedTrack.playing ? "Stop Shared Track" : "Play Shared Track";
  }
}

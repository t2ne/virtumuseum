// VirtuMuseum - lógica principal (A-Frame + UI + voz + áudio + modos 360)

const $ = (sel) => document.querySelector(sel);

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ---------- Áudio (WebAudio) ----------
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ambient = null;
    this.volume = 0.6;
  }

  async ensure() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("WebAudio não suportado");
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }

  setVolume(v01) {
    this.volume = clamp(v01, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  // Música ambiente: 2 osciladores + LFO suave
  async startAmbient() {
    await this.ensure();
    if (this.ambient) return;

    const base = this.ctx.createOscillator();
    base.type = "sine";
    base.frequency.value = 220;

    const harm = this.ctx.createOscillator();
    harm.type = "sine";
    harm.frequency.value = 330;

    const lfo = this.ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.08;

    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 18;
    lfo.connect(lfoGain);
    lfoGain.connect(base.frequency);

    const g = this.ctx.createGain();
    g.gain.value = 0.0;

    // fade in
    const now = this.ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(0.14, now + 2.2);

    base.connect(g);
    harm.connect(g);
    g.connect(this.master);

    base.start();
    harm.start();
    lfo.start();

    this.ambient = { base, harm, lfo, g };
  }

  stopAmbient() {
    if (!this.ambient || !this.ctx) return;
    const { base, harm, lfo, g } = this.ambient;
    const now = this.ctx.currentTime;
    try {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0.0, now + 0.7);
      base.stop(now + 0.8);
      harm.stop(now + 0.8);
      lfo.stop(now + 0.8);
    } catch {}
    this.ambient = null;
  }

  async chime() {
    await this.ensure();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "triangle";
    o.frequency.value = 880;
    g.gain.value = 0.0;
    o.connect(g);
    g.connect(this.master);
    const now = this.ctx.currentTime;
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(0.22, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    o.start(now);
    o.stop(now + 1.0);
  }
}

const audio = new AudioEngine();

// ---------- Voz (Web Speech) ----------
class VoiceController {
  constructor() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    this.SR = SR;
    this.rec = null;
    this.running = false;
    this.onCommand = null; // (cmdText) => void
  }

  start() {
    if (!this.supported || this.running) return;
    this.rec = new this.SR();
    this.rec.lang = "pt-PT";
    this.rec.interimResults = false;
    this.rec.continuous = true;
    this.running = true;

    this.rec.onresult = (e) => {
      const last = e.results?.[e.results.length - 1];
      const text = (last?.[0]?.transcript || "").trim().toLowerCase();
      if (text && this.onCommand) this.onCommand(text);
    };
    this.rec.onerror = () => {};
    this.rec.onend = () => {
      // tenta manter ligado
      if (this.running) {
        try {
          this.rec.start();
        } catch {}
      }
    };

    try {
      this.rec.start();
    } catch {
      this.running = false;
    }
  }

  stop() {
    this.running = false;
    try {
      this.rec?.stop();
    } catch {}
    this.rec = null;
  }
}

const voice = new VoiceController();

// ---------- TTS ----------
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "pt-PT";
    u.rate = 1.0;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  } catch {}
}

// ---------- A-Frame components ----------
AFRAME.registerComponent("gltf-material-fix", {
  schema: {
    doubleSided: { type: "boolean", default: true },
    baseColor: { type: "color", default: "#d9d9df" },
    roughness: { type: "number", default: 1.0 },
    metalness: { type: "number", default: 0.0 }
  },
  init: function () {
    this.el.addEventListener("model-loaded", () => {
      const obj = this.el.getObject3D("mesh");
      if (!obj) return;
      obj.traverse((node) => {
        if (!node.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;

        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach((m) => {
          if (!m) return;
          if (this.data.doubleSided) m.side = THREE.DoubleSide;

          // Se não houver textura, aplica material base para não ficar "invisível"
          const hasMap = !!m.map;
          if (!hasMap && m.color) {
            m.color.set(this.data.baseColor);
          }
          // força sólidos (evita transparências acidentais)
          if ("opacity" in m) m.opacity = 1.0;
          m.transparent = false;
          m.depthWrite = true;
          m.depthTest = true;
          if ("alphaTest" in m) m.alphaTest = 0.0;
          if ("roughness" in m) m.roughness = this.data.roughness;
          if ("metalness" in m) m.metalness = this.data.metalness;

          m.needsUpdate = true;
        });
      });
    });
  }
});

AFRAME.registerComponent("print-aim", {
  schema: { key: { type: "string", default: "p" } },
  init: function () {
    window.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() !== this.data.key.toLowerCase()) return;
      const rig = $("#rig");
      const cam = $("#cam");
      if (!rig || !cam) return;
      const rp = rig.getAttribute("position");
      const cr = cam.getAttribute("rotation");
      const dir = new THREE.Vector3();
      cam.object3D.getWorldDirection(dir);
      console.log(
        `RIG_POS: "${rp.x.toFixed(2)} ${rp.y.toFixed(2)} ${rp.z.toFixed(2)}"  ` +
          `CAM_ROT: "${cr.x.toFixed(2)} ${cr.y.toFixed(2)} ${cr.z.toFixed(2)}"  ` +
          `DIR: "${dir.x.toFixed(3)} ${dir.y.toFixed(3)} ${dir.z.toFixed(3)}"`
      );
    });
  }
});

AFRAME.registerComponent("hotspot", {
  schema: {
    title: { type: "string" },
    desc: { type: "string" },
    audio: { type: "selector" }
  },
  init: function () {
    const el = this.el;
    el.addEventListener("click", async () => {
      showInfoCard(this.data.title, this.data.desc, "(clica no chão para teleport · Q/E para snap-turn)");

      try {
        await audio.chime();
      } catch {}

      if (this.data.audio && narrator) {
        narrator.removeAttribute("sound");
        narrator.setAttribute("sound", {
          src: this.data.audio,
          autoplay: true,
          positional: false,
          volume: 1.0
        });
      }
    });

    el.addEventListener("mouseenter", () => el.setAttribute("scale", "1.2 1.2 1.2"));
    el.addEventListener("mouseleave", () => el.setAttribute("scale", "1 1 1"));
  }
});

AFRAME.registerComponent("tour-guide", {
  schema: {
    rig: { type: "selector" },
    panel: { type: "selector" },
    text: { type: "selector" },
    narrator: { type: "selector" },
    stopsUrl: { type: "string", default: "src/data/tourStops.json" },
    stopsEl: { type: "selector" }, // fallback opcional
    autoAdvance: { type: "boolean", default: false },
    speed: { type: "number", default: 1.0 }
  },

  init: function () {
    this.idx = 0;
    this.running = false;
    this.paused = false;
    this.timers = [];
    this.stops = [];
    this.reducedMotion = false;
    this.tts = false;
    this._loadStops();
    $("#btnStop")?.addEventListener("click", () => this.stop());
  },

  setOptions: function ({ speed, reducedMotion, tts } = {}) {
    if (typeof speed === "number") this.data.speed = speed;
    if (typeof reducedMotion === "boolean") this.reducedMotion = reducedMotion;
    if (typeof tts === "boolean") this.tts = tts;
  },

  _readStopsFromDom: function () {
    const json = (this.data.stopsEl?.textContent || "").trim();
    return json ? safeJsonParse(json, []) : [];
  },

  _loadStops: async function () {
    // tenta carregar do ficheiro; fallback para o script embed (se existir)
    try {
      const url = this.data.stopsUrl || "src/data/tourStops.json";
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const stops = await r.json();
      this.stops = Array.isArray(stops) ? stops : [];
    } catch {
      this.stops = this._readStopsFromDom();
    }

    window.dispatchEvent(new CustomEvent("tour:stopsLoaded", { detail: { stops: this.stops } }));
  },

  start: function () {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.idx = 0;
    this.data.rig?.setAttribute("wasd-controls", "enabled: false");
    this._goToStop(this.idx);
  },

  pause: function () {
    if (!this.running || this.paused) return;
    this.paused = true;
    this._clearTimers();
    this.data.rig?.removeAttribute("animation__pos");
    this.data.rig?.removeAttribute("animation__rot");
  },

  resume: function () {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this._goToStop(this.idx);
  },

  stop: function () {
    this.running = false;
    this.paused = false;
    this._clearTimers();
    this.data.rig?.setAttribute("wasd-controls", "enabled: true");
    this.data.panel?.setAttribute("visible", false);
    this.data.narrator?.removeAttribute("sound");
    hideInfoCard();
    updateTourNav(false);
  },

  next: function () {
    if (!this.running) return;
    this._clearTimers();
    this.idx = this.idx + 1;
    this._goToStop(this.idx);
  },

  prev: function () {
    if (!this.running) return;
    this._clearTimers();
    this.idx = Math.max(0, this.idx - 1);
    this._goToStop(this.idx);
  },

  teleportTo: function (i) {
    if (!this.stops[i]) return;
    this._clearTimers();
    this.idx = i;
    // força modo reduzido nesta ação (teleport instantâneo)
    const prev = this.reducedMotion;
    this.reducedMotion = true;
    if (!this.running) this.running = true;
    this.paused = false;
    this.data.rig?.setAttribute("wasd-controls", "enabled: false");
    this._goToStop(this.idx);
    this.reducedMotion = prev;
  },

  _clearTimers: function () {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  },

  _yawToTarget: function (rigEl, targetEl) {
    const rigPos = new THREE.Vector3();
    const tgtPos = new THREE.Vector3();
    rigEl.object3D.getWorldPosition(rigPos);
    targetEl.object3D.getWorldPosition(tgtPos);
    const dx = tgtPos.x - rigPos.x;
    const dz = tgtPos.z - rigPos.z;
    const yawRad = Math.atan2(dx, dz);
    const yawDeg = THREE.MathUtils.radToDeg(yawRad);
    return `0 ${yawDeg} 0`;
  },

  _applyPanel: function (stop) {
    // Mostra UI HTML (não tapa o ecrã como o painel 3D)
    showInfoCard(stop.title, stop.desc, "Usa ← / → para navegar. (Esc termina a visita)");
    if (this.tts) speak(`${stop.title}. ${stop.desc}`);
  },

  _goToStop: function (i) {
    if (!this.running || this.paused) return;
    const stop = this.stops[i];
    if (!stop) {
      this.stop();
      return;
    }

    const speed = this.data.speed || 1.0;
    const moveDur = (stop.moveDur ?? 1500) / speed;
    const lookDur = (stop.lookDur ?? 600) / speed;
    const wait = (stop.wait ?? 1200) / speed;

    const rig = this.data.rig;
    if (!rig) return;

    // movimento / teleport
    if (stop.pos) {
      if (this.reducedMotion) {
        rig.setAttribute("position", stop.pos);
        rig.removeAttribute("animation__pos");
      } else {
        rig.setAttribute("animation__pos", {
          property: "position",
          to: stop.pos,
          dur: moveDur,
          easing: "easeInOutQuad"
        });
      }
    }

    const afterMove = this.reducedMotion ? 0 : moveDur;

    // ao chegar: texto/áudio + olhar
    const t1 = setTimeout(() => {
      if (!this.running || this.paused) return;

      this._applyPanel(stop);

      // áudio (A-Frame sound, se definido)
      if (stop.audio && this.data.narrator) {
        this.data.narrator.removeAttribute("sound");
        this.data.narrator.setAttribute("sound", {
          src: stop.audio,
          autoplay: true,
          positional: false,
          volume: 1.0
        });
      } else {
        this.data.narrator?.removeAttribute("sound");
      }

      // olhar para target (yaw)
      if (stop.target) {
        const targetEl = document.querySelector(stop.target);
        if (targetEl) {
          const rot = this._yawToTarget(rig, targetEl);
          if (this.reducedMotion) {
            rig.setAttribute("rotation", rot);
            rig.removeAttribute("animation__rot");
          } else {
            rig.setAttribute("animation__rot", {
              property: "rotation",
              to: rot,
              dur: lookDur,
              easing: "easeInOutQuad"
            });
          }
        }
      } else if (stop.rot) {
        // fallback: rotação explícita no stop
        if (this.reducedMotion) {
          rig.setAttribute("rotation", stop.rot);
          rig.removeAttribute("animation__rot");
        } else {
          rig.setAttribute("animation__rot", {
            property: "rotation",
            to: stop.rot,
            dur: lookDur,
            easing: "easeInOutQuad"
          });
        }
      }

      // manual tour: ativa setas/hud
      updateTourNav(true, i, this.stops.length);
    }, afterMove);

    // próximo stop (apenas se autoAdvance = true)
    if (this.data.autoAdvance) {
      const t2 = setTimeout(() => {
        if (!this.running || this.paused) return;
        this.idx = i + 1;
        this._goToStop(this.idx);
      }, afterMove + (this.reducedMotion ? 0 : lookDur) + wait);
      this.timers.push(t1, t2);
    } else {
      this.timers.push(t1);
    }
  }
});

AFRAME.registerComponent("teleport-surface", {
  schema: { rig: { type: "selector" } },
  init: function () {
    this.el.addEventListener("click", (e) => {
      const rig = this.data.rig;
      const p = e.detail?.intersection?.point;
      if (!rig || !p) return;
      // mantém y do rig (normalmente 0)
      const rp = rig.getAttribute("position");
      rig.setAttribute("position", `${p.x.toFixed(3)} ${rp.y.toFixed(3)} ${p.z.toFixed(3)}`);
    });
  }
});

AFRAME.registerComponent("bounds-keeper", {
  schema: {
    minX: { type: "number", default: -60 },
    maxX: { type: "number", default: 60 },
    minZ: { type: "number", default: -80 },
    maxZ: { type: "number", default: 80 },
    y: { type: "number", default: 0 }
  },
  init: function () {
    this.lastSafe = null;
    this.lastWarn = 0;
  },
  tick: function () {
    const el = this.el;
    const p = el.getAttribute("position");
    if (!p) return;

    // força Y (evita drift)
    if (typeof this.data.y === "number" && Math.abs(p.y - this.data.y) > 0.01) {
      el.setAttribute("position", `${p.x} ${this.data.y} ${p.z}`);
    }

    const inside =
      p.x >= this.data.minX &&
      p.x <= this.data.maxX &&
      p.z >= this.data.minZ &&
      p.z <= this.data.maxZ;

    if (inside) {
      this.lastSafe = { x: p.x, y: this.data.y, z: p.z };
      return;
    }

    // fora de limites -> volta ao último safe
    const now = performance.now();
    if (this.lastSafe) {
      el.setAttribute(
        "position",
        `${this.lastSafe.x.toFixed(3)} ${this.lastSafe.y.toFixed(3)} ${this.lastSafe.z.toFixed(3)}`
      );
    } else {
      el.setAttribute("position", `0 ${this.data.y} 3`);
    }

    if (now - this.lastWarn > 1500) {
      this.lastWarn = now;
      showToast("Voltaste para dentro do museu (evitar 'vazio').");
    }
  }
});

// ---------- UI wiring ----------
function waitForTourComponent() {
  return new Promise((resolve) => {
    const el = $("#tour");
    const existing = el?.components?.["tour-guide"];
    if (existing) return resolve(existing);
    if (!el) return resolve(null);
    const onInit = (e) => {
      if (e.detail?.name === "tour-guide") {
        el.removeEventListener("componentinitialized", onInit);
        resolve(el.components?.["tour-guide"] || null);
      }
    };
    el.addEventListener("componentinitialized", onInit);
  });
}

function setMenuOpen(open) {
  const panel = $("#menuPanel");
  if (!panel) return;
  panel.classList.toggle("is-open", open);
  panel.setAttribute("aria-hidden", String(!open));
}

function toggleMenu() {
  const panel = $("#menuPanel");
  if (!panel) return;
  setMenuOpen(!panel.classList.contains("is-open"));
}

function setUIVisible(visible) {
  const ui = $("#uiRoot");
  if (!ui) return;
  ui.classList.toggle("is-hidden", !visible);
}

function setWelcomeVisible(visible) {
  const w = $("#welcome");
  if (!w) return;
  w.classList.toggle("is-hidden", !visible);
}

function setMinimalHUD(on) {
  const ui = $("#uiRoot");
  if (!ui) return;
  ui.classList.toggle("is-minimal", !!on);
  localStorage.setItem("virtumuseum.hudMinimal", on ? "1" : "0");
}

function updateTourNav(active, idx = 0, total = 0) {
  $("#btnTourPrev")?.toggleAttribute("disabled", !active || idx <= 0);
  $("#btnTourNext")?.toggleAttribute("disabled", !active || idx >= total - 1);
  $("#btnStop")?.classList.toggle("is-hidden", !active);
  $("#btnTourPrev")?.classList.toggle("is-hidden", !active);
  $("#btnTourNext")?.classList.toggle("is-hidden", !active);
}

function showInfoCard(title, desc, hint) {
  const card = $("#infoCard");
  if (!card) return;
  $("#infoCardTitle").textContent = title || "—";
  $("#infoCardDesc").textContent = desc || "";
  $("#infoCardHint").textContent = hint || "";
  card.classList.remove("is-hidden");
}

function hideInfoCard() {
  $("#infoCard")?.classList.add("is-hidden");
}

function showToast(text) {
  // simples: reutiliza o hint do infoCard se estiver aberto; senão abre um card pequeno
  if (!$("#infoCard")?.classList.contains("is-hidden")) {
    $("#infoCardHint").textContent = text;
    return;
  }
  showInfoCard("Info", text, "");
  setTimeout(() => hideInfoCard(), 1400);
}

function setMode(mode) {
  // mode: "museum" | "pano" | "video"
  const museu = $("#museuModel");
  const sky = $("#sky360");
  const vs = $("#videoSphere");

  if (mode === "museum") {
    museu?.setAttribute("visible", true);
    sky?.setAttribute("visible", false);
    vs?.setAttribute("visible", false);
    try { $("#video360")?.pause?.(); } catch {}
  }

  if (mode === "pano") {
    museu?.setAttribute("visible", false);
    sky?.setAttribute("visible", true);
    vs?.setAttribute("visible", false);
    try { $("#video360")?.pause?.(); } catch {}
  }

  if (mode === "video") {
    museu?.setAttribute("visible", false);
    sky?.setAttribute("visible", false);
    vs?.setAttribute("visible", true);
    try { $("#video360")?.play?.(); } catch {}
  }
}

function apply360FromInputs() {
  const panoUrl = ($("#txtPanoUrl")?.value || "").trim();
  const videoUrl = ($("#txtVideoUrl")?.value || "").trim();

  if (panoUrl) {
    const panoImg = $("#panoImg");
    const sky = $("#sky360");
    if (panoImg && sky) {
      panoImg.setAttribute("src", panoUrl);
      sky.setAttribute("src", "#panoImg");
    }
    localStorage.setItem("virtumuseum.panoUrl", panoUrl);
  }

  if (videoUrl) {
    const v = $("#video360");
    if (v) {
      v.pause?.();
      v.src = videoUrl;
      v.load?.();
    }
    localStorage.setItem("virtumuseum.videoUrl", videoUrl);
  }
}

function restore360Inputs() {
  const panoUrl = localStorage.getItem("virtumuseum.panoUrl") || "";
  const videoUrl = localStorage.getItem("virtumuseum.videoUrl") || "";
  const pano = $("#txtPanoUrl");
  const vid = $("#txtVideoUrl");
  if (pano) pano.value = panoUrl;
  if (vid) vid.value = videoUrl;
  if (panoUrl || videoUrl) apply360FromInputs();
}

function setupUI() {
  $("#btnMenu")?.addEventListener("click", toggleMenu);
  $("#btnHUD")?.addEventListener("click", () => setMinimalHUD(!$("#uiRoot")?.classList.contains("is-minimal")));

  $("#btnInfoClose")?.addEventListener("click", () => hideInfoCard());

  // Welcome buttons
  $("#btnEnterExplore")?.addEventListener("click", () => enterExperience("explore"));
  $("#btnEnterTour")?.addEventListener("click", () => enterExperience("tour"));

  // teleport por clique no chão
  const floor = $("#teleportFloor");
  if (floor && !floor.hasAttribute("teleport-surface")) {
    floor.setAttribute("teleport-surface", "rig: #rig");
  }

  // modos 360
  $("#btnModeMuseum")?.addEventListener("click", () => setMode("museum"));
  $("#btnModePano")?.addEventListener("click", () => setMode("pano"));
  $("#btnModeVideo")?.addEventListener("click", () => setMode("video"));
  $("#btnApply360")?.addEventListener("click", () => apply360FromInputs());

  // ferramentas
  $("#btnPhoto")?.addEventListener("click", () => takePhoto());
  $("#btnFlashlight")?.addEventListener("click", () => toggleFlashlight());
  $("#btnReset")?.addEventListener("click", () => {
    $("#rig")?.setAttribute("position", "0 0 3");
    $("#rig")?.setAttribute("rotation", "0 0 0");
    setMode("museum");
    hideInfoCard();
  });
  $("#btnCopyPose")?.addEventListener("click", async () => {
    const rig = $("#rig");
    if (!rig) return;
    const p = rig.getAttribute("position");
    const r = rig.getAttribute("rotation");
    const text = `POS: "${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}"  ROT: "${r.x.toFixed(2)} ${r.y.toFixed(2)} ${r.z.toFixed(2)}"`;
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      showToast("Pose copiada para o clipboard.");
    } catch {
      showToast("Pose no console (clipboard indisponível).");
    }
  });

  // volume
  const rng = $("#rngVolume");
  const savedVol = Number(localStorage.getItem("virtumuseum.volume") || "60");
  if (rng) rng.value = String(clamp(savedVol, 0, 100));
  audio.setVolume((savedVol || 60) / 100);
  rng?.addEventListener("input", (e) => {
    const v = Number(e.target.value || 0);
    localStorage.setItem("virtumuseum.volume", String(v));
    audio.setVolume(v / 100);
  });

  // ambient toggle
  const chkAmbient = $("#chkAmbient");
  const ambientOn = localStorage.getItem("virtumuseum.ambient") === "1";
  if (chkAmbient) chkAmbient.checked = ambientOn;
  if (ambientOn) {
    // precisa de gesto do utilizador; tentamos quando mexer no UI
  }
  chkAmbient?.addEventListener("change", async (e) => {
    const on = !!e.target.checked;
    localStorage.setItem("virtumuseum.ambient", on ? "1" : "0");
    try {
      if (on) await audio.startAmbient();
      else audio.stopAmbient();
    } catch {}
  });

  // options para o tour
  const chkTTS = $("#chkTTS");
  const chkRM = $("#chkReducedMotion");
  const rngSpeed = $("#rngSpeed");

  const ttsOn = localStorage.getItem("virtumuseum.tts") === "1";
  const rmOn = localStorage.getItem("virtumuseum.rm") === "1";
  const speedPct = Number(localStorage.getItem("virtumuseum.speed") || "100");

  if (chkTTS) chkTTS.checked = ttsOn;
  if (chkRM) chkRM.checked = rmOn;
  if (rngSpeed) rngSpeed.value = String(clamp(speedPct, 50, 150));

  let tour = null;
  const applyTourOptions = () => {
    if (!tour) return;
    const speed = (Number(rngSpeed?.value || 100) / 100) * 1.0;
    tour?.setOptions?.({
      speed,
      reducedMotion: !!chkRM?.checked,
      tts: !!chkTTS?.checked
    });
  };
  waitForTourComponent().then((c) => {
    tour = c;
    applyTourOptions();
    // se as paragens já estavam carregadas, força a renderização da lista
    if (tour?.stops?.length) {
      window.dispatchEvent(new CustomEvent("tour:stopsLoaded", { detail: { stops: tour.stops } }));
    }
  });

  chkTTS?.addEventListener("change", (e) => {
    localStorage.setItem("virtumuseum.tts", e.target.checked ? "1" : "0");
    applyTourOptions();
  });
  chkRM?.addEventListener("change", (e) => {
    localStorage.setItem("virtumuseum.rm", e.target.checked ? "1" : "0");
    applyTourOptions();
  });
  rngSpeed?.addEventListener("input", (e) => {
    localStorage.setItem("virtumuseum.speed", String(e.target.value || 100));
    applyTourOptions();
  });

  // voz
  const voiceStatus = $("#voiceStatus");
  const btnVoice = $("#btnVoice");

  if (!voice.supported) {
    if (voiceStatus) voiceStatus.textContent = "Voz: indisponível neste browser";
    btnVoice?.setAttribute("disabled", "true");
  }

  const setVoiceStatus = (on) => {
    if (!voiceStatus) return;
    voiceStatus.textContent = on ? "Voz: ligada (pt-PT)" : "Voz: desligada";
  };

  btnVoice?.addEventListener("click", () => {
    if (!voice.supported) return;
    const on = !voice.running;
    if (on) voice.start();
    else voice.stop();
    setVoiceStatus(voice.running);
  });

  // comandos de voz
  voice.onCommand = (text) => {
    const t = text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // remove acentos
    const tourC = $("#tour")?.components?.["tour-guide"];
    if (!tourC) return;

    if (t.includes("iniciar") || t.includes("comecar") || t.includes("começar")) tourC.start();
    else if (t.includes("pausar")) tourC.pause();
    else if (t.includes("retomar") || t.includes("continuar")) tourC.resume();
    else if (t.includes("parar") || t.includes("sair") || t.includes("stop")) tourC.stop();
    else if (t.includes("proxima") || t.includes("próxima") || t.includes("seguinte")) tourC.next();
    else if (t.includes("menu")) toggleMenu();
    else if (t.includes("ajuda")) showHelp();
    else if (t.includes("lanterna")) toggleFlashlight();
    else if (t.includes("foto") || t.includes("captura")) takePhoto();
  };

  // help
  $("#btnHelp")?.addEventListener("click", showHelp);

  // stops list (teleports)
  window.addEventListener("tour:stopsLoaded", (e) => {
    const stops = e.detail?.stops || [];
    const list = $("#stopsList");
    if (!list) return;
    list.innerHTML = "";
    stops.forEach((s, i) => {
      const b = document.createElement("button");
      b.className = "secondary";
      b.textContent = `${i + 1}. ${s.title || "Stop"}`;
      b.addEventListener("click", () => {
        $("#tour")?.components?.["tour-guide"]?.teleportTo?.(i);
      });
      list.appendChild(b);
    });
  });

  // atalhos
  window.addEventListener("keydown", (e) => {
    const tourC = $("#tour")?.components?.["tour-guide"];
    if (!tourC) return;

    if (e.key === "m" || e.key === "M") toggleMenu();
    if (e.key === "h" || e.key === "H") setMinimalHUD(!$("#uiRoot")?.classList.contains("is-minimal"));
    if (e.key === "Escape") tourC.stop();

    // navegação da visita manual
    if (e.key === "ArrowRight") tourC.next();
    if (e.key === "ArrowLeft") tourC.prev();

    // snap turn (comfort)
    if (e.key === "q" || e.key === "Q") snapTurn(-30);
    if (e.key === "e" || e.key === "E") snapTurn(30);

    // foto / lanterna
    if (e.key === "c" || e.key === "C") takePhoto();
    if (e.key === "f" || e.key === "F") toggleFlashlight();
  });

  // Primeira interação: se ambient estava on, tenta ligar aqui (autoplay policy)
  document.addEventListener(
    "pointerdown",
    async () => {
      const on = $("#chkAmbient")?.checked;
      if (on) {
        try {
          await audio.startAmbient();
        } catch {}
      }
    },
    { once: true }
  );

  // restaura lanterna
  toggleFlashlight(localStorage.getItem("virtumuseum.flashlight") === "1");

  // restore welcome opts
  const ambientOn = localStorage.getItem("virtumuseum.ambient") === "1";
  const ttsOn = localStorage.getItem("virtumuseum.tts") === "1";
  const moveSpeed = Number(localStorage.getItem("virtumuseum.moveSpeed") || "10");
  $("#chkWelcomeAmbient") && ($("#chkWelcomeAmbient").checked = ambientOn);
  $("#chkWelcomeTTS") && ($("#chkWelcomeTTS").checked = ttsOn);
  $("#rngMoveSpeed") && ($("#rngMoveSpeed").value = String(clamp(moveSpeed, 4, 20)));
  $("#rngMoveSpeedMenu") && ($("#rngMoveSpeedMenu").value = String(clamp(moveSpeed, 4, 20)));

  restore360Inputs();
  setMenuOpen(false);
  setVoiceStatus(false);
  setMinimalHUD(localStorage.getItem("virtumuseum.hudMinimal") === "1");

  // começa sempre no welcome (evita começar já com UI/painéis)
  setUIVisible(false);
  setWelcomeVisible(true);
  updateTourNav(false);
}

function snapTurn(deg) {
  const rig = $("#rig");
  if (!rig) return;
  const r = rig.getAttribute("rotation");
  rig.setAttribute("rotation", `${r.x} ${r.y + deg} ${r.z}`);
}

function takePhoto() {
  try {
    const scene = AFRAME.scenes?.[0];
    const ss = scene?.components?.screenshot;
    if (!ss) {
      // ativa componente screenshot automaticamente
      scene?.setAttribute("screenshot", "width: 1920; height: 1080");
    }
    (AFRAME.scenes?.[0]?.components?.screenshot || ss)?.capture("perspective");
  } catch {
    alert("Foto: não foi possível capturar neste browser.");
  }
}

function toggleFlashlight(force) {
  const lightEl = $("#flashlight");
  if (!lightEl) return;
  const curr = Number(lightEl.getAttribute("light")?.intensity || 0);
  const on = typeof force === "boolean" ? force : curr <= 0.001;
  lightEl.setAttribute("light", "intensity", on ? 1.2 : 0.0);
  localStorage.setItem("virtumuseum.flashlight", on ? "1" : "0");
}

function setMoveSpeed(accel) {
  const rig = $("#rig");
  if (!rig) return;
  const a = clamp(Number(accel) || 10, 4, 20);
  rig.setAttribute("wasd-controls", "acceleration", a);
  localStorage.setItem("virtumuseum.moveSpeed", String(a));
  const r1 = $("#rngMoveSpeed");
  const r2 = $("#rngMoveSpeedMenu");
  if (r1) r1.value = String(a);
  if (r2) r2.value = String(a);
}

async function enterExperience(mode) {
  // aplica opções do welcome
  const amb = !!$("#chkWelcomeAmbient")?.checked;
  const tts = !!$("#chkWelcomeTTS")?.checked;
  localStorage.setItem("virtumuseum.ambient", amb ? "1" : "0");
  localStorage.setItem("virtumuseum.tts", tts ? "1" : "0");

  setMoveSpeed(Number($("#rngMoveSpeed")?.value || 10));

  // sincroniza toggles do menu
  if ($("#chkAmbient")) $("#chkAmbient").checked = amb;
  if ($("#chkTTS")) $("#chkTTS").checked = tts;

  // música: precisa de gesto do utilizador (este clique já conta)
  try {
    if (amb) await audio.startAmbient();
    else audio.stopAmbient();
  } catch {}

  setWelcomeVisible(false);
  setUIVisible(true);

  const rig = $("#rig");
  const tour = $("#tour")?.components?.["tour-guide"];
  if (!rig || !tour) return;

  // Explorar: WASD on; Tour: WASD off e navega com setas
  if (mode === "explore") {
    rig.setAttribute("wasd-controls", "enabled: true");
    updateTourNav(false);
    hideInfoCard();
    showToast("Exploração livre ativa.");
  } else {
    rig.setAttribute("wasd-controls", "enabled: false");
    tour.running = false; // garante reset
    tour.start();
    updateTourNav(true, tour.idx, tour.stops.length);
  }

  // binds dos botões de tour nav
  $("#btnTourNext")?.addEventListener("click", () => $("#tour")?.components?.["tour-guide"]?.next?.());
  $("#btnTourPrev")?.addEventListener("click", () => $("#tour")?.components?.["tour-guide"]?.prev?.());

  // menu move speed slider
  $("#rngMoveSpeedMenu")?.addEventListener("input", (e) => setMoveSpeed(e.target.value));
  $("#rngMoveSpeed")?.addEventListener("input", (e) => setMoveSpeed(e.target.value));
}

function showHelp() {
  const msg =
    "Ajuda / comandos:\n\n" +
    "- Menu: tecla M (ou botão Menu)\n" +
    "- Iniciar visita: Enter (ou botão Iniciar)\n" +
    "- Pausar/Retomar: Space\n" +
    "- Próxima paragem: N\n" +
    "- Parar visita: Esc\n\n" +
    "Voz (se suportado):\n" +
    'Diz "iniciar visita", "pausar", "retomar", "parar", "próxima", "menu", "ajuda".';
  alert(msg);
}

// init depois do DOM
window.addEventListener("DOMContentLoaded", () => {
  setupUI();
});



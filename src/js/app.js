// VirtuMuseum - lógica principal (A-Frame + UI + voz + áudio + modos 360)

const $ = (sel) => document.querySelector(sel);

function isDebugOn() {
  return localStorage.getItem("virtumuseum.debug") === "1";
}

function dlog(...args) {
  if (!isDebugOn()) return;
  console.log("[VirtuMuseum]", ...args);
}

window.VirtuMuseumDebug = {
  enable() {
    localStorage.setItem("virtumuseum.debug", "1");
    console.log("[VirtuMuseum] debug ON");
  },
  disable() {
    localStorage.setItem("virtumuseum.debug", "0");
    console.log("[VirtuMuseum] debug OFF");
  },
  status() {
    return isDebugOn();
  },
};

// Fix: alguns GLBs referenciam texturas com "\\" (ex: "01\\tex.png"), o que falha em URL no browser.
// Normaliza para "/" para permitir carregar assets existentes no disco.
(function installGltfUrlBackslashFix() {
  try {
    const mgr = window.THREE?.DefaultLoadingManager;
    if (!mgr || mgr.__virtumuseumUrlFix) return;
    mgr.__virtumuseumUrlFix = true;
    mgr.setURLModifier((url) =>
      typeof url === "string" ? url.replace(/\\/g, "/") : url
    );
  } catch {
    // noop
  }
})();

let suppressTeleportUntilMs = 0;

let experienceMode = "welcome"; // "welcome" | "explore" | "tour"

function isTouchDevice() {
  try {
    if (navigator.maxTouchPoints > 0) return true;
    if (window.matchMedia?.("(pointer: coarse)")?.matches) return true;
    return "ontouchstart" in window;
  } catch {
    return false;
  }
}

function syncBodyModeClasses() {
  try {
    document.body.classList.toggle("is-tour", experienceMode === "tour");
    document.body.classList.toggle("is-explore", experienceMode === "explore");
    document.body.classList.toggle("is-welcome", experienceMode === "welcome");
    document.body.classList.toggle("is-touch", isTouchDevice());
    syncMobileJoystickVisibility();
  } catch {
    // noop
  }
}

const joystickState = {
  active: false,
  pointerId: null,
  x: 0,
  y: 0,
  radiusPx: 0,
  centerX: 0,
  centerY: 0,
};

function setJoystickVector(nx, ny) {
  joystickState.x = clamp(nx, -1, 1);
  joystickState.y = clamp(ny, -1, 1);
}

function resetJoystick() {
  joystickState.active = false;
  joystickState.pointerId = null;
  setJoystickVector(0, 0);
  const stick = $("#mobileJoystickStick");
  if (stick) stick.style.transform = "translate(-50%, -50%)";
}

function syncMobileJoystickVisibility() {
  const el = $("#mobileJoystick");
  if (!el) return;
  const menuOpen = $("#menuPanel")?.classList.contains("is-open");
  const welcomeVisible = !$("#welcome")?.classList.contains("is-hidden");
  const tourC = $("#tour")?.components?.["tour-guide"];
  const inTour = experienceMode === "tour" || !!tourC?.running;

  const shouldShow =
    isTouchDevice() &&
    experienceMode === "explore" &&
    !welcomeVisible &&
    !menuOpen &&
    !inTour;

  el.classList.toggle("is-hidden", !shouldShow);
  el.setAttribute("aria-hidden", String(!shouldShow));
}

function getMoveSpeedUi() {
  return clamp(
    Number(localStorage.getItem("virtumuseum.moveSpeed") || "2") || 2,
    1,
    6
  );
}

function getMoveSpeedUnitsPerSec() {
  // Mapeamento linear (igual para teclado e joystick).
  // Range anterior (1.2..7.2 u/s) estava demasiado rápido para o scale do museu.
  // Novo range: ~0.22..1.32 u/s
  return getMoveSpeedUi() * 0.05;
}

function getKeyboardMoveVector() {
  // x: strafe (direita +) | y: forward (frente +)
  let x = 0;
  let y = 0;

  const has = (k) => movementKeysDown.has(k);
  // Letras
  if (has("w")) y += 1;
  if (has("s")) y -= 1;
  if (has("d")) x += 1;
  if (has("a")) x -= 1;
  // Setas (compat)
  if (has("ArrowUp") || has("arrowup")) y += 1;
  if (has("ArrowDown") || has("arrowdown")) y -= 1;
  if (has("ArrowRight") || has("arrowright")) x += 1;
  if (has("ArrowLeft") || has("arrowleft")) x -= 1;

  // normaliza (evita diagonal mais rápida)
  const m = Math.hypot(x, y);
  if (m > 1e-6 && m > 1) {
    x /= m;
    y /= m;
  }
  return { x, y };
}

function applyManualMove(dtMs, x, y) {
  if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01) return;

  const rig = $("#rig");
  const cam = $("#cam");
  if (!rig || !cam) return;

  const menuOpen = $("#menuPanel")?.classList.contains("is-open");
  const welcomeVisible = !$("#welcome")?.classList.contains("is-hidden");
  const tourC = $("#tour")?.components?.["tour-guide"];
  const inTour = experienceMode === "tour" || !!tourC?.running;
  if (experienceMode !== "explore" || welcomeVisible || menuOpen || inTour)
    return;

  const THREE = window.THREE;
  if (!THREE) return;

  const speed = getMoveSpeedUnitsPerSec();
  const dt = Math.max(0, Number(dtMs) || 0) / 1000;

  const forward = new THREE.Vector3();
  const camObj = cam.getObject3D?.("camera") || cam.object3D;
  camObj.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) return;
  forward.normalize();

  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();

  const delta = new THREE.Vector3();
  delta.addScaledVector(forward, y);
  delta.addScaledVector(right, x);

  const mag = delta.length();
  if (mag > 1) delta.multiplyScalar(1 / mag);
  delta.multiplyScalar(speed * dt);

  const p = rig.getAttribute("position");
  const next = {
    x: (p?.x || 0) + delta.x,
    y: p?.y || 0,
    z: (p?.z || 0) + delta.z,
  };

  const bounds = getBoundsForRig(rig);
  const clamped = clampPosToBounds(next, bounds);
  if (
    Math.abs(clamped.x - next.x) > 1e-4 ||
    Math.abs(clamped.z - next.z) > 1e-4
  ) {
    notifyWallHit();
  }
  rig.setAttribute("position", vec3ToString(clamped));
}

function startManualMovementLoop() {
  let last = performance.now();
  const frame = (now) => {
    const dt = now - last;
    last = now;

    // teclado
    const k = getKeyboardMoveVector();

    // joystick (só quando ativo)
    const jx = joystickState.active ? joystickState.x : 0;
    const jy = joystickState.active ? joystickState.y : 0;

    // combina (normaliza dentro do apply)
    applyManualMove(dt, k.x + jx, k.y + jy);

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function moveRigFromJoystick(dtMs) {
  // Mantido por compat (antigo loop). O movimento real está no loop unificado.
  // Se por algum motivo ainda for chamado, usa o mesmo motor.
  applyManualMove(dtMs, joystickState.x, joystickState.y);
}

function initMobileJoystick() {
  const wrap = $("#mobileJoystick");
  const base = $("#mobileJoystickBase");
  const stick = $("#mobileJoystickStick");
  if (!wrap || !base || !stick) return;

  const refreshCenter = () => {
    const r = base.getBoundingClientRect();
    joystickState.radiusPx = Math.max(1, Math.min(r.width, r.height) * 0.42);
    joystickState.centerX = r.left + r.width / 2;
    joystickState.centerY = r.top + r.height / 2;
  };

  const updateStick = (clientX, clientY) => {
    const dx = clientX - joystickState.centerX;
    const dy = clientY - joystickState.centerY;

    const maxR = joystickState.radiusPx;
    const d = Math.hypot(dx, dy) || 0;
    const k = d > maxR ? maxR / d : 1;
    const clampedX = dx * k;
    const clampedY = dy * k;

    // y em ecrã cresce para baixo; queremos +Y = avançar
    setJoystickVector(clampedX / maxR, -clampedY / maxR);

    stick.style.transform = `translate(calc(-50% + ${clampedX}px), calc(-50% + ${clampedY}px))`;
  };

  const onDown = (e) => {
    if (!isTouchDevice()) return;
    if (experienceMode !== "explore") return;
    if (wrap.classList.contains("is-hidden")) return;

    e.preventDefault?.();
    refreshCenter();
    joystickState.active = true;
    joystickState.pointerId = e.pointerId ?? null;
    try {
      base.setPointerCapture?.(e.pointerId);
    } catch {}
    updateStick(e.clientX, e.clientY);
  };

  const onMove = (e) => {
    if (!joystickState.active) return;
    if (
      joystickState.pointerId != null &&
      e.pointerId !== joystickState.pointerId
    )
      return;
    e.preventDefault?.();
    updateStick(e.clientX, e.clientY);
  };

  const onUp = (e) => {
    if (
      joystickState.pointerId != null &&
      e.pointerId !== joystickState.pointerId
    )
      return;
    resetJoystick();
  };

  base.addEventListener("pointerdown", onDown, { passive: false });
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp, { passive: true });
  window.addEventListener("pointercancel", onUp, { passive: true });

  // quando muda de orientação/tamanho
  window.addEventListener("resize", () => {
    resetJoystick();
    syncBodyModeClasses();
  });
}

const AMBIENT_URL = "src/assets/audio/jazz.mp3";

let infoCardCollapsed = false;
let infoCardImageHidden = false;

const movementKeysDown = new Set();

function isInfoCardOpen() {
  return !$("#infoCard")?.classList.contains("is-hidden");
}

function setInfoCardCollapsed(collapsed) {
  infoCardCollapsed = !!collapsed;
  $("#infoCard")?.classList.toggle("is-collapsed", infoCardCollapsed);
  const btn = $("#btnInfoToggle");
  if (btn) btn.textContent = infoCardCollapsed ? "Mostrar" : "Ocultar";
}

function setInfoCardImageHidden(hidden) {
  infoCardImageHidden = !!hidden;
  // re-aplica visibilidade ao elemento img quando houver src
  const img = $("#infoCardImg");
  if (!img) return;
  const hasSrc = !!img.getAttribute("src");
  img.classList.toggle("is-hidden", !hasSrc || infoCardImageHidden);
  const btn = $("#btnInfoImgToggle");
  if (btn) btn.textContent = infoCardImageHidden ? "Imagem: OFF" : "Imagem: ON";
}

const PAINTINGS_URL = "src/data/paintings.json";
let paintingsByCodePromise = null;

function pad3(n) {
  const s = String(n);
  return s.padStart(3, "0");
}

async function loadPaintingsByCode() {
  if (paintingsByCodePromise) return paintingsByCodePromise;
  paintingsByCodePromise = (async () => {
    const r = await fetch(PAINTINGS_URL, { cache: "no-store" });
    const json = await r.json();
    const arr = Array.isArray(json?.paintings) ? json.paintings : [];
    const map = {};
    for (const p of arr) {
      const code = typeof p?.code === "string" ? p.code.trim() : "";
      if (!code) continue;
      map[code] = p;
    }
    return map;
  })().catch(() => ({}));
  return paintingsByCodePromise;
}

function inferPaintingCodeFromStop(stop, idx) {
  if (stop?.code != null) {
    const c = String(stop.code).trim();
    return c ? c : null;
  }

  // "Quadro 1".."Quadro 40" -> "001".."040"
  const t = String(stop?.title || "").trim();
  const m = t.match(/^quadro\s*(\d+)$/i);
  if (m) return pad3(Number(m[1]));

  // fallback: index 1 => 001 (porque index 0 costuma ser "Início")
  if (Number.isInteger(idx) && idx > 0) {
    const n = idx;
    if (n >= 1 && n <= 999) return pad3(n);
  }

  return null;
}

async function openPaintingInfoByCode(code) {
  const c = String(code || "").trim();
  if (!c) return;

  const byCode = await loadPaintingsByCode();
  const p = byCode?.[c];

  if (!p) {
    showToast(`Sem informação para o quadro ${c}.`);
    return;
  }

  const { title, desc } = formatPaintingDesc(p);
  const imgUrl = imageUrlForPainting(p);

  setInfoCardImage(imgUrl || "", title || "");
  showInfoCard(
    title || `Quadro ${c}`,
    desc || "",
    experienceMode === "tour"
      ? "Usa ← / → para navegar. (Esc termina a visita)"
      : ""
  );

  // opcional: respeitar a opção TTS do user
  const ttsOn = localStorage.getItem("virtumuseum.tts") === "1";
  if (ttsOn) {
    // evita ler muitos \n
    const t = `${title}. ${String(desc || "").replace(/\n+/g, " ")}`;
    speak(t);
  }
}

// expõe para poderes chamar a partir do script que cria os quadros/hitboxes
window.VirtuMuseum = window.VirtuMuseum || {};
window.VirtuMuseum.openPaintingInfoByCode = openPaintingInfoByCode;

function imageUrlForPainting(p) {
  const type = String(p?.type || "")
    .trim()
    .toLowerCase();
  const code = String(p?.code || "").trim();
  if (!code) return "";

  const folderByType = {
    barroco: "Sala1Barroco",
    romantismo: "Sala2Romantismo",
    cubismo: "Sala3Cubismo",
    impressionismo: "Sala4Impressionismo",
  };

  const folder = folderByType[type];
  if (!folder) return "";
  const ext = code === "038" ? "jpeg" : "jpg";
  return `src/assets/images/${folder}/${code}.${ext}`;
}

function formatPaintingDesc(p) {
  const title = String(p?.title || "").trim();
  const author = String(p?.author || "").trim();
  const year = String(p?.year || "").trim();
  const materials = String(p?.materials || "").trim();
  const description = String(p?.description || "").trim();
  const history = String(p?.history || "").trim();
  const symbolism = String(p?.symbolism || "").trim();
  const type = String(p?.type || "").trim();

  const head = [author, year].filter(Boolean).join(" • ");
  const meta = [materials, type].filter(Boolean).join(" • ");

  const lines = [];
  if (head) lines.push(head);
  if (meta) lines.push(meta);
  if (head || meta) lines.push("");

  if (description) lines.push(description);

  if (history) {
    lines.push("");
    lines.push("História");
    lines.push(history);
  }

  if (symbolism) {
    lines.push("");
    lines.push("Simbolismo");
    lines.push(symbolism);
  }

  return { title, desc: lines.join("\n") };
}

async function enrichStopsWithPaintings(stops) {
  if (!Array.isArray(stops) || !stops.length) return;
  const byCode = await loadPaintingsByCode();
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const code = inferPaintingCodeFromStop(stop, i);
    if (!code) continue;
    const p = byCode?.[code];
    if (!p) continue;

    const formatted = formatPaintingDesc(p);
    if (formatted.title) stop.title = formatted.title;
    if (formatted.desc) stop.desc = formatted.desc;
    stop.paintingCode = code;
    stop.imageUrl = imageUrlForPainting(p);
  }
}

function isFullscreen() {
  return !!document.fullscreenElement;
}

async function toggleFullscreen() {
  try {
    if (isFullscreen()) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    showToast("Fullscreen indisponível neste browser.");
  }
}

function syncFullscreenButtons() {
  const label = isFullscreen() ? "Sair de fullscreen" : "Fullscreen";
  $("#btnFullscreen") && ($("#btnFullscreen").textContent = label);
  $("#btnFullscreenWelcome") &&
    ($("#btnFullscreenWelcome").textContent = label);
}

function setTeleportEnabled(enabled) {
  const floor = $("#teleportFloor");
  if (!floor) return;

  // UX decision: floor-click teleport is disabled.
  // Movement during tour happens only via arrows/menu.
  if (enabled) return;

  if (floor.hasAttribute("teleport-surface")) {
    floor.removeAttribute("teleport-surface");
  }
}

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

function parseVec3String(v) {
  if (typeof v !== "string") return null;
  const parts = v
    .trim()
    .split(/\s+/)
    .map((n) => Number(n));
  if (parts.length < 3) return null;
  const [x, y, z] = parts;
  if (![x, y, z].every((n) => Number.isFinite(n))) return null;
  return { x, y, z };
}

function vec3ToString(p) {
  return `${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)}`;
}

function getBoundsForRig(rigEl) {
  // Prefer bounds applied by our 4-walls system (doesn't depend on component init timing).
  if (activeGalleryBounds) return activeGalleryBounds;
  const bk = rigEl?.components?.["bounds-keeper"];
  const d = bk?.data;
  if (!d) return { minX: -60, maxX: 60, minZ: -80, maxZ: 80, y: 0 };
  return {
    minX: Number(d.minX),
    maxX: Number(d.maxX),
    minZ: Number(d.minZ),
    maxZ: Number(d.maxZ),
    y: Number(d.y),
  };
}

function clampPosToBounds(pos, bounds) {
  return {
    x: clamp(pos.x, bounds.minX, bounds.maxX),
    y: bounds.y,
    z: clamp(pos.z, bounds.minZ, bounds.maxZ),
  };
}

// --- 4 WALLS (simple bounds + optional visual boxes) ---

const DEFAULT_GALLERY_BOUNDS = {
  // fallback seguro se os stops não carregarem (ex: abrir via file:// sem fetch)
  // (um pouco mais largo do que o necessário, para evitar ficar "apertado")
  minX: -22.0,
  maxX: 14.0,
  minZ: -13.0,
  maxZ: 14.0,
  y: 0,
};

let activeGalleryBounds = null;

// Ajustes por parede (valores em metros):
// - positivo = puxa a parede para dentro (mais "perto")
// - negativo = empurra a parede para fora (menos "perto")
// Ordem/nomes: north=maxZ, south=minZ, east=maxX, west=minX
// Tuned by feedback: 1ª (+), 2ª (-), 3ª (tiny +), 4ª (tiny -)
const WALL_TWEAK = {
  north: -0.1,
  south: -1.2,
  east: 0.25,
  west: 0.85,
};

function applyWallTweak(bounds) {
  const b = { ...bounds };

  // north/south (Z)
  b.maxZ = Number(b.maxZ) - Number(WALL_TWEAK.north || 0);
  b.minZ = Number(b.minZ) + Number(WALL_TWEAK.south || 0);

  // east/west (X)
  b.maxX = Number(b.maxX) - Number(WALL_TWEAK.east || 0);
  b.minX = Number(b.minX) + Number(WALL_TWEAK.west || 0);

  // sanity
  if (b.maxX <= b.minX) {
    const mid = (b.maxX + b.minX) / 2;
    b.minX = mid - 0.1;
    b.maxX = mid + 0.1;
  }
  if (b.maxZ <= b.minZ) {
    const mid = (b.maxZ + b.minZ) / 2;
    b.minZ = mid - 0.1;
    b.maxZ = mid + 0.1;
  }
  return b;
}

let lastWallHitAt = 0;
function notifyWallHit() {
  const now = performance.now();
  if (now - lastWallHitAt < 900) return;
  lastWallHitAt = now;
  showToast("Parede.");
}

function computeBoundsFromStops(stops, pad = 2.25) {
  if (!Array.isArray(stops) || !stops.length) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  let found = 0;

  for (const s of stops) {
    const p = parseVec3String(String(s?.pos || ""));
    if (!p) continue;
    found++;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  if (!found) return null;
  return {
    minX: minX - pad,
    maxX: maxX + pad,
    minZ: minZ - pad,
    maxZ: maxZ + pad,
    y: 0,
  };
}

function ensureVisualWalls(bounds) {
  const scene = document.querySelector("a-scene");
  if (!scene) return;

  const ensure = (id) => {
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement("a-box");
    el.setAttribute("id", id);
    el.setAttribute(
      "material",
      "color: #7c5cff; opacity: 0.18; transparent: true; side: double"
    );
    el.setAttribute("shadow", "cast: false; receive: false");
    scene.appendChild(el);
    return el;
  };

  const wallH = 3;
  const thick = 0.12;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const w = Math.max(0.1, bounds.maxX - bounds.minX);
  const d = Math.max(0.1, bounds.maxZ - bounds.minZ);

  const n = ensure("wallNorth");
  n.setAttribute("width", w);
  n.setAttribute("height", wallH);
  n.setAttribute("depth", thick);
  n.setAttribute("position", `${cx} ${wallH / 2} ${bounds.maxZ}`);

  const s = ensure("wallSouth");
  s.setAttribute("width", w);
  s.setAttribute("height", wallH);
  s.setAttribute("depth", thick);
  s.setAttribute("position", `${cx} ${wallH / 2} ${bounds.minZ}`);

  const e = ensure("wallEast");
  e.setAttribute("width", thick);
  e.setAttribute("height", wallH);
  e.setAttribute("depth", d);
  e.setAttribute("position", `${bounds.maxX} ${wallH / 2} ${cz}`);

  const o = ensure("wallWest");
  o.setAttribute("width", thick);
  o.setAttribute("height", wallH);
  o.setAttribute("depth", d);
  o.setAttribute("position", `${bounds.minX} ${wallH / 2} ${cz}`);
}

function applyFourWalls(bounds, { visual = true } = {}) {
  const rig = $("#rig");
  if (!rig || !bounds) return;
  const raw = {
    minX: Number(bounds.minX),
    maxX: Number(bounds.maxX),
    minZ: Number(bounds.minZ),
    maxZ: Number(bounds.maxZ),
    y: Number(bounds.y ?? 0),
  };
  if (![raw.minX, raw.maxX, raw.minZ, raw.maxZ, raw.y].every(Number.isFinite))
    return;

  const b = applyWallTweak(raw);

  // torna as bounds imediatamente ativas para o clamp (mesmo antes do component init)
  activeGalleryBounds = b;

  // colisão real: clamp via bounds-keeper
  rig.setAttribute(
    "bounds-keeper",
    `minX: ${b.minX}; maxX: ${b.maxX}; minZ: ${b.minZ}; maxZ: ${b.maxZ}; y: ${b.y}`
  );

  if (visual) ensureVisualWalls(b);
}

function setZoomFov(fov) {
  const cam = $("#cam");
  if (!cam) return;
  const v = clamp(Number(fov) || 80, 30, 90);
  cam.setAttribute("camera", "fov", v);
  localStorage.setItem("virtumuseum.fov", String(v));
  // Slider representa "zoom" (direita = mais zoom), mas internamente guardamos FOV.
  const sliderV = clamp(120 - v, 30, 90);
  $("#rngZoom") && ($("#rngZoom").value = String(sliderV));
}

function setZoomFromSlider(sliderValue) {
  const sv = clamp(Number(sliderValue) || 60, 30, 90);
  const fov = clamp(120 - sv, 30, 90);
  setZoomFov(fov);
}

function resetWASDVelocity() {
  const rig = $("#rig");
  const wasd = rig?.components?.["wasd-controls"];
  const v = wasd?.velocity;
  if (!v) return;
  v.x = 0;
  v.y = 0;
  v.z = 0;
}

// Spawn pose do jogo: lida uma vez a partir do HTML (e fica fixa).
// Isto evita bugs em que o "spawn" é acidentalmente capturado depois do user se mover.
const FALLBACK_SPAWN_RIG_POS = "0 0 4";
const FALLBACK_SPAWN_RIG_ROT = "0 0 0";
const FALLBACK_SPAWN_CAM_ROT = "0 0 0";

let SPAWN_RIG_POS = FALLBACK_SPAWN_RIG_POS;
let SPAWN_RIG_ROT = FALLBACK_SPAWN_RIG_ROT;
let SPAWN_CAM_ROT = FALLBACK_SPAWN_CAM_ROT;
let spawnInitialized = false;

function vec3AttrToString(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const parsed = parseVec3String(v);
    return parsed ? vec3ToString(parsed) : v.trim();
  }
  if (
    typeof v === "object" &&
    [v.x, v.y, v.z].every((n) => Number.isFinite(Number(n)))
  ) {
    return `${Number(v.x)} ${Number(v.y)} ${Number(v.z)}`;
  }
  return null;
}

function initSpawnPoseOnce() {
  if (spawnInitialized) return;
  const rig = $("#rig");
  const cam = $("#cam");
  if (!rig || !cam) return;

  const rp = vec3AttrToString(rig.getAttribute("position"));
  const rr = vec3AttrToString(rig.getAttribute("rotation"));
  const cr = vec3AttrToString(cam.getAttribute("rotation"));

  if (rp) SPAWN_RIG_POS = rp;
  if (rr) SPAWN_RIG_ROT = rr;
  if (cr) SPAWN_CAM_ROT = cr;

  spawnInitialized = true;
  dlog("spawn initialized", { SPAWN_RIG_POS, SPAWN_RIG_ROT, SPAWN_CAM_ROT });
}

function hardResetUserPose() {
  initSpawnPoseOnce();

  const rig = $("#rig");
  const before = rig?.getAttribute?.("position");
  if (rig) {
    rig.removeAttribute("animation__pos");
    rig.removeAttribute("animation__rot");
    rig.setAttribute("position", SPAWN_RIG_POS);
    rig.setAttribute("rotation", SPAWN_RIG_ROT);

    // Também força o object3D já (evita 1-2 frames em que o estado antigo ainda aparece)
    try {
      const p = parseVec3String(SPAWN_RIG_POS);
      if (p) rig.object3D.position.set(p.x, p.y, p.z);
    } catch {}
    try {
      const r = parseVec3String(SPAWN_RIG_ROT);
      if (r) {
        rig.object3D.rotation.set(
          THREE.MathUtils.degToRad(r.x),
          THREE.MathUtils.degToRad(r.y),
          THREE.MathUtils.degToRad(r.z)
        );
      }
    } catch {}
  }

  const cam = $("#cam");
  cam?.setAttribute("rotation", SPAWN_CAM_ROT);

  // Reset real do look-controls (yaw/pitch internos). Sem isto, o user pode
  // re-entrar e ficar com orientação/estado antigo (e em alguns browsers isso
  // também dá a sensação de "não resetou").
  try {
    const lc = cam?.components?.["look-controls"];
    if (lc?.yawObject?.rotation) lc.yawObject.rotation.y = 0;
    if (lc?.pitchObject?.rotation) lc.pitchObject.rotation.x = 0;
    if (cam?.object3D?.rotation) cam.object3D.rotation.set(0, 0, 0);
  } catch {}

  movementKeysDown.clear();
  resetWASDVelocity();

  // debug only
  dlog("hardResetUserPose", {
    from: vec3AttrToString(before),
    to: SPAWN_RIG_POS,
    rigObj3D: rig ? vec3ToString(rig.object3D.position) : null,
  });
}

// ---------- Áudio (WebAudio) ----------
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ambient = null;
    this.ambientBuffer = null;
    this.volume = 0.6;
    this._ambientStartPromise = null;
    this._ambientStopRequested = false;
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

  async _loadAmbientBuffer() {
    await this.ensure();
    if (this.ambientBuffer) return this.ambientBuffer;
    const r = await fetch(AMBIENT_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const ab = await r.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);
    this.ambientBuffer = buf;
    return buf;
  }

  // Música ambiente: jazz.mp3 (loop)
  async startAmbient() {
    if (this.ambient?.src) return;
    if (this._ambientStartPromise) return this._ambientStartPromise;

    this._ambientStopRequested = false;

    this._ambientStartPromise = (async () => {
      await this.ensure();
      // autoplay policies podem suspender o contexto
      try {
        if (this.ctx?.state === "suspended") await this.ctx.resume();
      } catch {}

      // double-check after awaits
      if (this.ambient?.src) return;

      const buf = await this._loadAmbientBuffer();
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      const g = this.ctx.createGain();
      g.gain.value = 0.0;
      const now = this.ctx.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(0.0, now);
      g.gain.linearRampToValueAtTime(0.22, now + 0.8);

      src.connect(g);
      g.connect(this.master);
      src.start();

      this.ambient = { src, g };
      src.onended = () => {
        if (this.ambient?.src === src) this.ambient = null;
      };

      if (this._ambientStopRequested) {
        this.stopAmbient();
      }
    })().finally(() => {
      this._ambientStartPromise = null;
    });

    return this._ambientStartPromise;
  }

  stopAmbient() {
    this._ambientStopRequested = true;
    if (!this.ambient || !this.ctx) return;
    const { src, g } = this.ambient;
    const now = this.ctx.currentTime;

    // manter referência até efetivamente parar (evita startAmbient duplicar)
    try {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0.0, now + 0.25);
    } catch {}
    try {
      src.stop(now + 0.26);
    } catch {
      // fallback: se falhar o agendamento, tenta parar já
      try {
        src.stop();
      } catch {}
    }
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
    this.rec.continuous = false;
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
    metalness: { type: "number", default: 0.0 },
  },
  init: function () {
    this.el.addEventListener("model-loaded", () => {
      const obj = this.el.getObject3D("mesh");
      if (!obj) return;
      obj.traverse((node) => {
        if (!node.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;

        const mats = Array.isArray(node.material)
          ? node.material
          : [node.material];
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
    window.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() !== this.data.key.toLowerCase()) return;

      const rig = $("#rig");
      const cam = $("#cam");
      if (!rig || !cam) return;

      const rp = rig.getAttribute("position");
      const cr = cam.getAttribute("rotation");

      const dir = new THREE.Vector3();
      cam.object3D.getWorldDirection(dir);

      // yaw em graus (o que interessa para o tour "rot": "0 YAW 0")
      const yawDeg = THREE.MathUtils.radToDeg(Math.atan2(dir.x, dir.z));

      console.log(
        `RIG_POS: "${rp.x.toFixed(2)} ${rp.y.toFixed(2)} ${rp.z.toFixed(
          2
        )}"  ` +
          `CAM_ROT: "${cr.x.toFixed(2)} ${cr.y.toFixed(2)} ${cr.z.toFixed(
            2
          )}"  ` +
          `DIR: "${dir.x.toFixed(3)} ${dir.y.toFixed(3)} ${dir.z.toFixed(
            3
          )}"  ` +
          `YAW: "${yawDeg.toFixed(2)}"`
      );
    });
  },
});

AFRAME.registerComponent("hotspot", {
  schema: {
    title: { type: "string" },
    desc: { type: "string" },
    audio: { type: "selector" },
  },
  init: function () {
    const el = this.el;

    // Destaque visual simples (descoberta)
    if (!el.hasAttribute("animation__pulse")) {
      el.setAttribute("animation__pulse", {
        property: "scale",
        dir: "alternate",
        dur: 900,
        easing: "easeInOutSine",
        loop: true,
        to: "1.25 1.25 1.25",
      });
    }

    el.addEventListener("click", async () => {
      suppressTeleportUntilMs = performance.now() + 250;
      const tourC = $("#tour")?.components?.["tour-guide"];
      const stops = tourC?.stops;
      const match = Array.isArray(stops)
        ? stops.find((s) => s?.target === `#${el.id}`)
        : null;

      const title = this.data.title || match?.title || el.id || "Hotspot";
      const desc = this.data.desc || match?.desc || "";

      dlog("hotspot click", {
        id: el.id,
        title,
        pos: el.getAttribute("position"),
      });

      const tourRunning = !!tourC?.running;
      setInfoCardImage(match?.imageUrl || "", title);
      showInfoCard(
        title,
        desc,
        tourRunning ? "Usa Q/E ou ←/→ para navegar." : ""
      );

      try {
        await audio.chime();
      } catch {}

      const narratorEl = document.querySelector("#narrator");
      if (narratorEl) narratorEl.removeAttribute("sound");
      if (this.data.audio && narratorEl) {
        narratorEl.setAttribute("sound", {
          src: this.data.audio,
          autoplay: true,
          positional: false,
          volume: 1.0,
        });
      }
    });

    el.addEventListener("mouseenter", () => {
      el.setAttribute("material", "transparent", true);
      el.setAttribute("material", "opacity", 0.75);
    });
    el.addEventListener("mouseleave", () => {
      el.setAttribute("material", "transparent", false);
      el.setAttribute("material", "opacity", 1.0);
    });
  },
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
    speed: { type: "number", default: 1.0 },
  },

  init: function () {
    this.idx = 0;
    this.running = false;
    this.paused = false;
    this.timers = [];
    this.stops = [];
    this.reducedMotion = false;
    this.tts = false;
    this.stopsLoaded = false;
    this._stopsReady = this._loadStops();
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
    try {
      const url = this.data.stopsUrl || "src/data/tourStops.json";
      const r = await fetch(url, { cache: "no-store" });
      console.log("[tour] fetch", url, "status", r.status);
      const stops = await r.json();
      this.stops = Array.isArray(stops) ? stops : [];
    } catch (err) {
      console.warn("[tour] falhou carregar stops:", err);
      this.stops = this._readStopsFromDom();
    }

    console.log("[tour] stops carregados:", this.stops.length, this.stops[0]);

    // Enriquecimento via paintings.json (título/descrição/imagem), quando disponível.
    await enrichStopsWithPaintings(this.stops);

    this.stopsLoaded = true;

    window.dispatchEvent(
      new CustomEvent("tour:stopsLoaded", { detail: { stops: this.stops } })
    );
  },

  start: async function () {
    if (this.running) return;
    experienceMode = "tour";
    syncBodyModeClasses();
    this.running = true;
    this.paused = false;
    this.idx = 0;
    this.data.rig?.setAttribute("wasd-controls", "enabled", false);

    // reset pose para evitar começar "torto" ao mudar de explorar -> tour
    this.data.rig?.setAttribute("rotation", "0 0 0");
    $("#cam")?.setAttribute("rotation", "0 0 0");
    resetWASDVelocity();

    try {
      await this._stopsReady;
    } catch {}

    if (!this.stops?.length) {
      showToast("Visita: não foi possível carregar as paragens.");
      this.stop();
      return;
    }

    const prevRM = this.reducedMotion;
    this.reducedMotion = true; // teleport instantâneo no 1º stop
    this._goToStop(this.idx);
    this.reducedMotion = prevRM;
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
    const leavingTour = experienceMode === "tour";
    if (leavingTour) experienceMode = "explore";
    syncBodyModeClasses();
    this._clearTimers();
    // Movimento manual (teclado/joystick) — mantém wasd-controls sempre desligado.
    if (leavingTour)
      this.data.rig?.setAttribute("wasd-controls", "enabled", false);
    setTeleportEnabled(false);
    this.data.panel?.setAttribute("visible", false);
    this.data.narrator?.removeAttribute("sound");
    hideInfoCard();
    updateTourNav(false);
  },

  next: function () {
    if (!this.running) return;
    if (this.idx >= this.stops.length - 1) {
      showToast("Já estás na última paragem.");
      updateTourNav(true, this.idx, this.stops.length);
      return;
    }
    this._clearTimers();
    this.idx = this.idx + 1;
    this._goToStop(this.idx);
  },

  prev: function () {
    if (!this.running) return;
    if (this.idx <= 0) {
      showToast("Já estás na primeira paragem.");
      updateTourNav(true, this.idx, this.stops.length);
      return;
    }
    this._clearTimers();
    this.idx = Math.max(0, this.idx - 1);
    this._goToStop(this.idx);
  },

  teleportTo: function (i) {
    if (!this.stopsLoaded) {
      this._stopsReady?.then(() => this.teleportTo(i));
      return;
    }
    if (!this.stops[i]) return;
    localStorage.setItem("virtumuseum.lastStopIdx", String(i));
    this._clearTimers();
    this.idx = i;
    // força modo reduzido nesta ação (teleport instantâneo)
    const prev = this.reducedMotion;
    this.reducedMotion = true;
    if (!this.running) this.running = true;
    this.paused = false;
    this.data.rig?.setAttribute("wasd-controls", "enabled", false);
    this._goToStop(this.idx);
    this.reducedMotion = prev;
  },

  // Teleport simples para exploração (não liga visita, não mostra setas, não bloqueia WASD)
  jumpTo: function (i) {
    if (!this.stopsLoaded) {
      this._stopsReady?.then(() => this.jumpTo(i));
      return;
    }
    const stop = this.stops?.[i];
    const rig = this.data.rig;
    if (!stop || !rig) return;

    const bounds = getBoundsForRig(rig);
    const parsed = parseVec3String(stop.pos || "");
    if (parsed) {
      const clamped = clampPosToBounds(parsed, bounds);
      rig.setAttribute("position", vec3ToString(clamped));
    }

    // rotação apenas em yaw (evita inclinar a câmara e parecer que o museu mexe)
    if (stop.target) {
      const targetEl = document.querySelector(stop.target);
      if (targetEl) {
        rig.setAttribute("rotation", this._yawToTarget(rig, targetEl));
      }
    } else if (stop.rot) {
      const r = parseVec3String(stop.rot);
      if (r) rig.setAttribute("rotation", `0 ${r.y} 0`);
    }

    rig.removeAttribute("animation__pos");
    /*     rig.removeAttribute("animation__rot");
     */ showToast(`Teleport: ${stop.title || "paragem"}`);
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

  _pitchToTarget: function (rigEl, targetEl) {
    // Pitch para olhar para cima/baixo sem inclinar o mundo:
    // aplica-se depois na câmara (look-controls), não no rig.
    const camEl = document.querySelector("#cam");
    const camObj = camEl?.getObject3D?.("camera") || camEl?.object3D;
    if (!camObj) return 0;

    const camPos = new THREE.Vector3();
    const tgtPos = new THREE.Vector3();
    camObj.getWorldPosition(camPos);
    targetEl.object3D.getWorldPosition(tgtPos);

    const dx = tgtPos.x - camPos.x;
    const dy = tgtPos.y - camPos.y;
    const dz = tgtPos.z - camPos.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz < 1e-6) return 0;

    const pitchRad = Math.atan2(dy, horiz);
    // Em three.js, X positivo olha para baixo, portanto invertimos.
    return -THREE.MathUtils.radToDeg(pitchRad);
  },

  _applyPanel: function (stop) {
    // Mostra UI HTML (não tapa o ecrã como o painel 3D)
    setInfoCardImage(stop?.imageUrl || "", stop?.title || "");
    showInfoCard(
      stop.title,
      stop.desc,
      "Usa ← / → para navegar. (Esc termina a visita)"
    );
    if (this.tts) speak(`${stop.title}. ${stop.desc}`);
  },

  _goToStop: function (i) {
    if (!this.running || this.paused) return;
    const stop = this.stops[i];
    if (!stop) {
      showToast("Paragem inválida.");
      updateTourNav(true, this.idx, this.stops.length);
      return;
    }

    const speed = this.data.speed || 1.0;
    const moveDur = (stop.moveDur ?? 1500) / speed;
    const lookDur = (stop.lookDur ?? 600) / speed;
    const wait = (stop.wait ?? 1200) / speed;

    const rig = this.data.rig;
    if (!rig) return;
    const bounds = getBoundsForRig(rig);

    // Inter-state: enquanto muda de paragem
    const destTitle = stop.title
      ? `A caminho: ${stop.title}`
      : "A mudar de paragem…";
    setInfoCardTransition(true, destTitle);
    $("#btnTourPrev")?.setAttribute("disabled", "true");
    $("#btnTourNext")?.setAttribute("disabled", "true");

    // -----------------------------
    // 1) MOVIMENTO / TELEPORT (POS)
    // -----------------------------
    if (stop.pos) {
      const parsed = parseVec3String(stop.pos);
      if (!parsed) {
        showToast("Paragem com posição inválida.");
      } else {
        const clamped = clampPosToBounds(parsed, bounds);
        const toPos = vec3ToString(clamped);

        if (this.reducedMotion) {
          rig.setAttribute("position", toPos);
          rig.removeAttribute("animation__pos");
        } else {
          rig.setAttribute("animation__pos", {
            property: "position",
            to: toPos,
            dur: moveDur,
            easing: "easeInOutQuad",
          });
        }
      }
    }
    // -----------------------------
    // 2) ROTAÇÃO (yaw no rig; pitch na câmara)
    // -----------------------------
    let yawStr = null;
    let pitchDeg = 0;

    if (stop.target) {
      const targetEl = document.querySelector(stop.target);
      if (targetEl) {
        yawStr = this._yawToTarget(rig, targetEl);
        pitchDeg = this._pitchToTarget(rig, targetEl);
      }
    } else if (stop.rot) {
      const r = parseVec3String(stop.rot);
      if (r) {
        // yaw no rig, pitch na câmara; ignora roll
        yawStr = `0 ${r.y} 0`;
        pitchDeg = Number(r.x) || 0;
      }
    }

    if (yawStr) {
      if (this.reducedMotion) {
        rig.setAttribute("rotation", yawStr);
        rig.removeAttribute("animation__rot");
      } else {
        rig.setAttribute("animation__rot", {
          property: "rotation",
          to: yawStr,
          dur: lookDur,
          easing: "easeInOutQuad",
        });
      }
    }

    // Pitch: aplicar via look-controls para não “rodar o mundo”.
    const camEl = document.querySelector("#cam");
    const lc = camEl?.components?.["look-controls"];
    const applyPitch = (deg) => {
      if (!lc?.pitchObject) return;
      lc.pitchObject.rotation.x = THREE.MathUtils.degToRad(Number(deg) || 0);
      // limpa roll para evitar inclinação lateral
      lc.pitchObject.rotation.z = 0;
    };

    // Se não houver stop.rot/target, volta a pitch 0 para não "herdar" do stop anterior.
    if (!stop.target && !stop.rot) pitchDeg = 0;

    if (this.reducedMotion || lookDur <= 0) {
      applyPitch(pitchDeg);
    } else {
      const startPitch = lc?.pitchObject
        ? THREE.MathUtils.radToDeg(lc.pitchObject.rotation.x)
        : 0;
      const start = performance.now();
      const dur = Math.max(0, Number(lookDur) || 0);
      const step = (now) => {
        const t = clamp((now - start) / dur, 0, 1);
        // easeInOutQuad
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const v = startPitch + (pitchDeg - startPitch) * eased;
        applyPitch(v);
        if (t < 1 && this.running && !this.paused) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    const afterMove = this.reducedMotion ? 0 : moveDur;
    const minInterDelay = afterMove === 0 ? 80 : 0;

    // ao chegar: texto/áudio
    const t1 = setTimeout(() => {
      if (!this.running || this.paused) return;

      setInfoCardTransition(false);

      // Em vez de abrir a descrição completa automaticamente:
      setInfoCardImage("", "");
      showInfoCard(
        stop.title || "Paragem",
        "",
        "Clica no quadro para ver a informação."
      );

      // áudio do stop (se estiveres a usar stop.audio) podes manter ou remover:
      if (stop.audio && this.data.narrator) {
        this.data.narrator.removeAttribute("sound");
        this.data.narrator.setAttribute("sound", {
          src: stop.audio,
          autoplay: true,
          positional: false,
          volume: 1.0,
        });
      } else {
        this.data.narrator?.removeAttribute("sound");
      }

      updateTourNav(true, i, this.stops.length);
      this._applyPanel(stop);

      // áudio
      if (stop.audio && this.data.narrator) {
        this.data.narrator.removeAttribute("sound");
        this.data.narrator.setAttribute("sound", {
          src: stop.audio,
          autoplay: true,
          positional: false,
          volume: 1.0,
        });
      } else {
        this.data.narrator?.removeAttribute("sound");
      }

      // NÃO remover animation__rot aqui (senão “mata” a rotação do stop)
      updateTourNav(true, i, this.stops.length);
    }, afterMove + minInterDelay);

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
  },
});

AFRAME.registerComponent("teleport-surface", {
  schema: {
    rig: { type: "selector" },
    enabled: { type: "boolean", default: false },
  },
  init: function () {
    this.el.addEventListener("click", (e) => {
      if (!this.data.enabled) {
        dlog("teleport ignored (disabled)");
        return;
      }

      const rig = this.data.rig;
      const p = e.detail?.intersection?.point;
      if (!rig || !p) return;

      const now = performance.now();
      if (now < suppressTeleportUntilMs) {
        dlog("teleport ignored (suppressed)", {
          untilMs: suppressTeleportUntilMs,
          now,
        });
        return;
      }

      // Evita bug em que clicar num hotspot também dispara teleport no chão.
      // Alguns browsers/versões podem emitir click para múltiplas interseções.
      const cursor =
        document.querySelector("#cam a-cursor") ||
        document.querySelector("a-cursor");
      const ray = cursor?.components?.raycaster;
      const intersections = ray?.intersections;
      if (Array.isArray(intersections) && intersections.length) {
        let nearestHotspot = Infinity;
        let nearestFloor = Infinity;

        for (const it of intersections) {
          const el = it?.object?.el;
          const dist = Number(it?.distance);
          if (!el || !Number.isFinite(dist)) continue;
          if (el === this.el) nearestFloor = Math.min(nearestFloor, dist);
          if (el.classList?.contains("hotspot"))
            nearestHotspot = Math.min(nearestHotspot, dist);
        }

        dlog("teleport click intersections", {
          nearestHotspot,
          nearestFloor,
          point: { x: p.x, y: p.y, z: p.z },
        });

        if (nearestHotspot + 0.01 < nearestFloor) {
          dlog("teleport ignored (hotspot closer)");
          return;
        }
      }

      const bounds = getBoundsForRig(rig);
      const clamped = clampPosToBounds({ x: p.x, y: bounds.y, z: p.z }, bounds);
      rig.setAttribute("position", vec3ToString(clamped));
      dlog("teleported", { to: clamped, bounds });
    });
  },
});

AFRAME.registerComponent("bounds-keeper", {
  schema: {
    minX: { type: "number", default: -60 },
    maxX: { type: "number", default: 60 },
    minZ: { type: "number", default: -80 },
    maxZ: { type: "number", default: 80 },
    y: { type: "number", default: 0 },
  },
  init: function () {
    this.lastSafe = null;
    this.lastWarn = 0;

    const p = this.el.getAttribute("position");
    if (p) {
      const b = getBoundsForRig(this.el);
      const inside =
        p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;
      if (inside) this.lastSafe = { x: p.x, y: b.y, z: p.z };
    }
  },
  tick: function () {
    const el = this.el;
    const p = el.getAttribute("position");
    if (!p) return;

    const b = getBoundsForRig(el);

    // força Y (evita drift)
    if (typeof b.y === "number" && Math.abs(p.y - b.y) > 0.01) {
      el.setAttribute("position", `${p.x} ${b.y} ${p.z}`);
    }

    const inside =
      p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;

    if (inside) {
      this.lastSafe = { x: p.x, y: b.y, z: p.z };
      return;
    }

    // fora de limites -> volta ao último safe
    const now = performance.now();
    if (this.lastSafe) {
      el.setAttribute(
        "position",
        `${this.lastSafe.x.toFixed(3)} ${this.lastSafe.y.toFixed(
          3
        )} ${this.lastSafe.z.toFixed(3)}`
      );
    } else {
      el.setAttribute("position", `0 ${b.y} 3`);
    }

    if (now - this.lastWarn > 1500) {
      this.lastWarn = now;
      showToast("Voltaste para dentro do museu (evitar 'vazio').");
    }
  },
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
function syncMovementLock() {
  const rig = $("#rig");
  const cam = $("#cam");
  const tourC = $("#tour")?.components?.["tour-guide"];

  const menuOpen = $("#menuPanel")?.classList.contains("is-open");
  const welcomeVisible = !$("#welcome")?.classList.contains("is-hidden"); // ecrã inicial
  const inTour = experienceMode === "tour" || !!tourC?.running;

  if (!rig) return;

  // ✅ bloquear SEMPRE no welcome e quando o menu está aberto
  const mustLock =
    welcomeVisible || experienceMode === "welcome" || menuOpen || inTour;

  // Importante: não usamos o motor do wasd-controls para movimento.
  // Mantém sempre desligado para teclado/joystick usarem o mesmo caminho.
  rig.setAttribute("wasd-controls", "enabled", false);

  // (opcional mas recomendado) também bloquear rotação enquanto menu/welcome
  if (cam) {
    const lockLook = welcomeVisible || menuOpen;
    cam.setAttribute("look-controls", "enabled", !lockLook);
  }

  // (opcional) parar "inércia" caso estivesse a andar
  const wc = rig.components?.["wasd-controls"];
  if (mustLock && wc?.velocity) {
    wc.velocity.set(0, 0, 0);
  }

  if (mustLock) {
    movementKeysDown.clear();
    resetJoystick();
  }

  syncMobileJoystickVisibility();
}

function setMenuOpen(open) {
  const panel = $("#menuPanel");
  if (!panel) return;
  // Backdrop desativado (menu não deve escurecer o ecrã).
  $("#menuBackdrop")?.setAttribute("aria-hidden", "true");

  // Evita warning: aria-hidden num ancestor que ainda retém focus.
  if (!open) {
    const ae = document.activeElement;
    if (ae && panel.contains(ae)) {
      try {
        ae.blur?.();
      } catch {}
      try {
        $("#btnMenu")?.focus?.();
      } catch {}
    }
  }

  panel.classList.toggle("is-open", open);
  panel.setAttribute("aria-hidden", String(!open));
  try {
    document.body.classList.toggle("is-menu-open", !!open);
  } catch {}
  syncMovementLock();
}

function toggleMenu() {
  const panel = $("#menuPanel");
  if (!panel) return;
  setMenuOpen(!panel.classList.contains("is-open"));
  syncMovementLock();
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

function backToWelcome() {
  try {
    speechSynthesis?.cancel?.();
  } catch {}

  $("#video360")?.pause?.();
  $("#narrator")?.removeAttribute("sound");

  const tour = $("#tour")?.components?.["tour-guide"];
  try {
    tour?.stop?.();
  } catch {}

  // trava movimento imediatamente (evita um tick de WASD aplicar posição antiga)
  const rig = $("#rig");
  try {
    rig?.setAttribute?.("wasd-controls", "enabled", false);
  } catch {}
  resetWASDVelocity();

  // reset total do utilizador para a posição inicial
  hardResetUserPose();
  // Alguns componentes (ex: controls) podem aplicar o estado no frame seguinte.
  // Força de novo no próximo frame para garantir que a posição efetivamente salta.
  requestAnimationFrame(() => hardResetUserPose());

  setTeleportEnabled(false);
  hideInfoCard();
  setMenuOpen(false);
  setUIVisible(false);
  setWelcomeVisible(true);
  experienceMode = "welcome";
  syncBodyModeClasses();
  updateTourNav(false);
  syncMovementLock();

  // sincroniza toggles do welcome e garante que a música segue a preferência
  const ambOn = localStorage.getItem("virtumuseum.ambient") === "1";
  $("#chkWelcomeAmbient") && ($("#chkWelcomeAmbient").checked = ambOn);
  $("#chkAmbient") && ($("#chkAmbient").checked = ambOn);
  try {
    if (ambOn) audio.startAmbient();
    else audio.stopAmbient();
  } catch {}
}

function setMinimalHUD(hudOff) {
  const ui = $("#uiRoot");
  if (!ui) return;
  ui.classList.toggle("is-hud-off", !!hudOff);

  // compat: mantém o mesmo storage key usado anteriormente
  localStorage.setItem("virtumuseum.hudMinimal", hudOff ? "1" : "0");

  const btn = $("#btnHUD");
  if (btn) {
    const visible = !hudOff;
    btn.textContent = visible ? "HUD: ON" : "HUD: OFF";
    btn.setAttribute("aria-pressed", visible ? "true" : "false");
  }
  if (hudOff) {
    setMenuOpen(false);
    hideInfoCard();
  }
  dlog("hud", { visible: !hudOff });
}

function updateTourNav(active, idx = 0, total = 0) {
  // Nunca mostrar UI de tour fora do modo de visita
  if (experienceMode !== "tour") active = false;
  $("#btnTourPrev")?.toggleAttribute("disabled", !active || idx <= 0);
  $("#btnTourNext")?.toggleAttribute("disabled", !active || idx >= total - 1);
  $("#btnStop")?.classList.toggle("is-hidden", !active);
  $("#btnTourPrev")?.classList.toggle("is-hidden", !active);
  $("#btnTourNext")?.classList.toggle("is-hidden", !active);
  $("#tourNav")?.classList.toggle("is-hidden", !active);
  $("#tourNav")?.setAttribute("aria-hidden", String(!active));
}

function showInfoCard(title, desc, hint) {
  const card = $("#infoCard");
  if (!card) return;

  // No modo visita guiada, o botão "Fechar" não deve aparecer.
  const closeBtn = $("#btnInfoClose");
  const hideClose = experienceMode === "tour";
  closeBtn?.classList.toggle("is-hidden", hideClose);
  closeBtn?.setAttribute("aria-hidden", String(hideClose));

  $("#infoCardTitle").textContent = title || "—";
  $("#infoCardDesc").textContent = desc || "";
  $("#infoCardHint").textContent = hint || "";
  card.classList.remove("is-hidden");
}

function setInfoCardImage(url, alt) {
  const img = $("#infoCardImg");
  if (!img) return;
  const u = String(url || "").trim();
  if (!u) {
    img.classList.add("is-hidden");
    img.removeAttribute("src");
    img.alt = "";
    return;
  }
  img.src = u;
  img.alt = alt || "";
  // respeita o toggle do utilizador
  setInfoCardImageHidden(infoCardImageHidden);
}

function setInfoCardTransition(active, title = "A mudar…") {
  // Apenas no modo visita guiada.
  if (experienceMode !== "tour") return;
  const card = $("#infoCard");
  if (!card) return;
  card.setAttribute("aria-busy", active ? "true" : "false");
  if (!active) return;
  setInfoCardImage("", "");
  showInfoCard(title, "", "");
}

function hideInfoCard() {
  $("#infoCard")?.classList.add("is-hidden");
  setInfoCardImage("", "");
  setInfoCardCollapsed(false);
  setInfoCardImageHidden(false);
}

function showToast(text) {
  // simples: reutiliza o hint do infoCard se estiver aberto; senão abre um card pequeno
  if (!$("#infoCard")?.classList.contains("is-hidden")) {
    $("#infoCardHint").textContent = text;
    return;
  }
  setInfoCardImage("", "");
  showInfoCard("Info", text, experienceMode === "tour" ? "" : "");
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
    try {
      $("#video360")?.pause?.();
    } catch {}
  }

  if (mode === "pano") {
    museu?.setAttribute("visible", false);
    sky?.setAttribute("visible", true);
    vs?.setAttribute("visible", false);
    try {
      $("#video360")?.pause?.();
    } catch {}
  }

  if (mode === "video") {
    museu?.setAttribute("visible", false);
    sky?.setAttribute("visible", false);
    vs?.setAttribute("visible", true);
    try {
      $("#video360")?.play?.();
    } catch {}
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

function blockMoveKeys(e, { allowLeftRight = false } = {}) {
  const k = String(e?.key || "").toLowerCase();

  // WASD + setas
  const isMove =
    k === "w" ||
    k === "a" ||
    k === "s" ||
    k === "d" ||
    k === "arrowup" ||
    k === "arrowdown" ||
    k === "arrowleft" ||
    k === "arrowright";

  if (!isMove) return false;

  // opcional: permitir ←/→ (ex: tour)
  if (allowLeftRight && (k === "arrowleft" || k === "arrowright")) return false;

  e.preventDefault?.();
  e.stopPropagation?.();
  return true;
}

function setupUI() {
  $("#btnMenu")?.addEventListener("click", toggleMenu);
  $("#btnHUD")?.addEventListener("click", () =>
    setMinimalHUD(!$("#uiRoot")?.classList.contains("is-hud-off"))
  );

  $("#btnFullscreen")?.addEventListener("click", toggleFullscreen);
  $("#btnFullscreenWelcome")?.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", syncFullscreenButtons);
  syncFullscreenButtons();

  $("#btnBackToWelcome")?.addEventListener("click", backToWelcome);

  $("#btnInfoClose")?.addEventListener("click", () => hideInfoCard());
  $("#btnInfoToggle")?.addEventListener("click", () =>
    setInfoCardCollapsed(!infoCardCollapsed)
  );
  $("#btnInfoImgToggle")?.addEventListener("click", () =>
    setInfoCardImageHidden(!infoCardImageHidden)
  );

  // Welcome buttons
  $("#btnEnterExplore")?.addEventListener("click", () =>
    enterExperience("explore")
  );
  $("#btnEnterTour")?.addEventListener("click", () => enterExperience("tour"));

  // Welcome: música ambiente deve controlar playback (e sincronizar com menu)
  $("#chkWelcomeAmbient")?.addEventListener("change", async (e) => {
    const on = !!e.target.checked;
    localStorage.setItem("virtumuseum.ambient", on ? "1" : "0");
    if ($("#chkAmbient")) $("#chkAmbient").checked = on;
    try {
      if (on) await audio.startAmbient();
      else audio.stopAmbient();
    } catch {}
  });

  // teleport por clique no chão
  setTeleportEnabled(false);

  // modos 360
  $("#btnModeMuseum")?.addEventListener("click", () => setMode("museum"));
  $("#btnModePano")?.addEventListener("click", () => setMode("pano"));
  $("#btnModeVideo")?.addEventListener("click", () => setMode("video"));
  $("#btnApply360")?.addEventListener("click", () => apply360FromInputs());

  // ferramentas
  $("#btnPhoto")?.addEventListener("click", () => takePhoto());
  $("#btnFlashlight")?.addEventListener("click", () => toggleFlashlight());
  $("#btnReset")?.addEventListener("click", () => {
    hardResetUserPose();
    setMode("museum");
    hideInfoCard();
  });
  $("#btnCopyPose")?.addEventListener("click", async () => {
    const rig = $("#rig");
    if (!rig) return;
    const p = rig.getAttribute("position");
    const r = rig.getAttribute("rotation");
    const text = `POS: "${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(
      2
    )}"  ROT: "${r.x.toFixed(2)} ${r.y.toFixed(2)} ${r.z.toFixed(2)}"`;
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
    if ($("#chkWelcomeAmbient")) $("#chkWelcomeAmbient").checked = on;
    try {
      if (on) await audio.startAmbient();
      else audio.stopAmbient();
    } catch {}
  });

  // options para o tour
  const chkTTS = $("#chkTTS");
  const chkRM = $("#chkReducedMotion");
  const rngSpeed = $("#rngSpeed");
  const rngZoom = $("#rngZoom");

  const ttsOn = localStorage.getItem("virtumuseum.tts") === "1";
  const rmOn = localStorage.getItem("virtumuseum.rm") === "1";
  const speedPct = Number(localStorage.getItem("virtumuseum.speed") || "100");
  const savedFov = Number(localStorage.getItem("virtumuseum.fov") || "80");

  if (chkTTS) chkTTS.checked = ttsOn;
  if (chkRM) chkRM.checked = rmOn;
  if (rngSpeed) rngSpeed.value = String(clamp(speedPct, 50, 150));
  // slider representa zoom; o valor guardado é FOV
  if (rngZoom) rngZoom.value = String(clamp(120 - savedFov, 30, 90));
  setZoomFov(savedFov || 80);

  let tour = null;
  const applyTourOptions = () => {
    if (!tour) return;
    const speed = (Number(rngSpeed?.value || 100) / 100) * 1.0;
    tour?.setOptions?.({
      speed,
      reducedMotion: !!chkRM?.checked,
      tts: !!chkTTS?.checked,
    });
  };
  waitForTourComponent().then((c) => {
    tour = c;
    applyTourOptions();
    // se as paragens já estavam carregadas, força a renderização da lista
    if (tour?.stops?.length) {
      window.dispatchEvent(
        new CustomEvent("tour:stopsLoaded", { detail: { stops: tour.stops } })
      );
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

  rngZoom?.addEventListener("input", (e) => setZoomFromSlider(e.target.value));

  // zoom via wheel (fora de UI)
  window.addEventListener(
    "wheel",
    (e) => {
      const t = e.target;
      const inUi =
        (t?.closest &&
          (t.closest("#uiRoot") ||
            t.closest("#welcome") ||
            t.closest("#infoCard"))) ||
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA";
      if (inUi) return;

      const delta = Number(e.deltaY) || 0;
      if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return;

      // trackpad pode ser muito sensível
      const curr = Number(localStorage.getItem("virtumuseum.fov") || "80");
      const next = clamp(curr + Math.sign(delta) * 2, 30, 90);
      if (next === curr) return;

      e.preventDefault();
      setZoomFov(next);
    },
    { passive: false }
  );

  // voz
  const voiceStatus = $("#voiceStatus");
  const btnVoice = $("#btnVoice");

  if (!voice.supported) {
    if (voiceStatus)
      voiceStatus.textContent = "Voz: indisponível neste browser";
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

    if (t.includes("iniciar") || t.includes("comecar")) {
      // Start "a sério": sai do welcome/menu e reseta para o spawn.
      enterExperience("tour");
    } else if (t.includes("pausar")) tourC.pause();
    else if (t.includes("retomar") || t.includes("continuar")) tourC.resume();
    else if (t.includes("parar") || t.includes("sair") || t.includes("stop"))
      tourC.stop();
    else if (t.includes("proxima") || t.includes("seguinte")) tourC.next();
    else if (t.includes("anterior") || t.includes("antes")) tourC.prev();
    // Comandos para mostrar ou ocultar imagem do quadro
    else if (
      t.includes("imagem on") ||
      t.includes("mostrar imagem") ||
      t.includes("on") ||
      t.includes("imagem ligar")
    ) {
      setInfoCardImageHidden(false);
      showToast("Imagens ativadas.");
    } else if (
      t.includes("imagem off") ||
      t.includes("ocultar imagem") ||
      t.includes("off") ||
      t.includes("imagem desligar")
    ) {
      setInfoCardImageHidden(true);
      showToast("Imagens ocultadas.");
    } else if (
      t.includes("ocultar painel") ||
      t.includes("ocultar info") ||
      t.includes("ocultar") ||
      t.includes("fechar painel")
    ) {
      setInfoCardCollapsed(true);
    } else if (
      t.includes("mostrar painel") ||
      t.includes("mostrar info") ||
      t.includes("mostrar") ||
      t.includes("abrir painel")
    ) {
      setInfoCardCollapsed(false);
    } else if (t.includes("menu")) toggleMenu();
    else if (t.includes("ajuda")) showHelp();
    else if (t.includes("lanterna")) toggleFlashlight();
    else if (t.includes("foto") || t.includes("captura")) takePhoto();
  };

  // help
  $("#btnHelp")?.addEventListener("click", showHelp);

  // stops list (teleports)
  window.addEventListener("tour:stopsLoaded", (e) => {
    const stops = e.detail?.stops || [];

    // aplica 4 paredes baseadas nas posições reais dos stops (sem depender de paintings.json)
    const computed = computeBoundsFromStops(stops);
    if (computed) applyFourWalls(computed, { visual: true });

    const list = $("#stopsList");
    if (!list) return;
    list.innerHTML = "";
    stops.forEach((s, i) => {
      const b = document.createElement("button");
      b.className = "secondary";
      b.textContent = `${i + 1}. ${s.title || "Stop"}`;
      b.addEventListener("click", () => {
        const tourC = $("#tour")?.components?.["tour-guide"];
        if (!tourC) return;
        localStorage.setItem("virtumuseum.lastStopIdx", String(i));
        if (experienceMode !== "tour") {
          showToast("Teleports disponíveis apenas na visita guiada.");
          return;
        }
        tourC.teleportTo?.(i);
      });
      list.appendChild(b);
    });
  });

  // atalhos
  window.addEventListener(
    "keydown",
    (e) => {
      const menuOpen = $("#menuPanel")?.classList.contains("is-open");
      const welcomeVisible = !$("#welcome")?.classList.contains("is-hidden");
      if (menuOpen || welcomeVisible || experienceMode === "welcome") {
        if (blockMoveKeys(e)) return;
      }

      const tourC = $("#tour")?.components?.["tour-guide"];
      const inTourMode = experienceMode === "tour" || !!tourC?.running;

      // Se o utilizador estiver em modo tour, nunca deixar teclas de movimento (exceto ←/→ para navegar)
      if (inTourMode && blockMoveKeys(e, { allowLeftRight: true })) return;

      const infoOpen = !$("#infoCard")?.classList.contains("is-hidden");
      const key = e.key;
      const keyLower = String(key || "").toLowerCase();

      // tracking para remover "sliding" do wasd-controls
      if (
        keyLower === "w" ||
        keyLower === "a" ||
        keyLower === "s" ||
        keyLower === "d" ||
        key === "ArrowUp" ||
        key === "ArrowDown" ||
        key === "ArrowLeft" ||
        key === "ArrowRight"
      ) {
        movementKeysDown.add(keyLower || key);
      }

      // Se o info card estiver aberto, não deixar as setas moverem o utilizador.
      // (Em tour, setas esquerda/direita continuam a navegar.)
      if (infoOpen) {
        if (key === "ArrowUp" || key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
        }
        if (!inTourMode && (key === "ArrowLeft" || key === "ArrowRight")) {
          e.preventDefault();
          e.stopPropagation();
        }
      }

      // No modo visita guiada: bloquear movimento manual completamente.
      // WASD + setas cima/baixo não devem mexer; esquerda/direita navega.
      if (inTourMode) {
        if (
          keyLower === "w" ||
          keyLower === "a" ||
          keyLower === "s" ||
          keyLower === "d" ||
          key === "ArrowUp" ||
          key === "ArrowDown"
        ) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        if (key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          tourC.next();
          return;
        }
        if (key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          tourC.prev();
          return;
        }
      }

      if (
        tourC.running &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown")
      ) {
        // garante que as setas não são usadas para movement controls
        e.preventDefault();
        e.stopPropagation();
      }

      const ae = document.activeElement;
      const isTyping =
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.isContentEditable);
      if (isTyping && e.key !== "Escape") return;

      if (e.key === "m" || e.key === "M") toggleMenu();
      if (e.key === "h" || e.key === "H")
        setMinimalHUD(!$("#uiRoot")?.classList.contains("is-hud-off"));
      if (e.key === "Escape") tourC.stop();

      // iniciar / pausar / próxima (conforme UI/hints)
      if (e.key === "Enter") {
        // Start "a sério" para não herdar posição da sessão anterior.
        // Mantém semântica: Enter inicia a visita guiada.
        e.preventDefault();
        e.stopPropagation();
        enterExperience("tour");
      }
      if (e.key === " " || e.code === "Space") {
        if (tourC.running && !tourC.paused) tourC.pause();
        else if (tourC.running && tourC.paused) tourC.resume();
      }
      if (e.key === "n" || e.key === "N") tourC.next();

      // navegação da visita manual (fallback; normalmente já foi tratado acima)
      if (tourC) {
        if (e.key === "ArrowRight") tourC.next();
        if (e.key === "ArrowLeft") tourC.prev();
      }

      // navegação alternativa (Q/E)
      if (e.key === "q" || e.key === "Q") tourC.prev();
      if (e.key === "e" || e.key === "E") tourC.next();

      // foto / lanterna
      if (e.key === "c" || e.key === "C") takePhoto();
      if (e.key === "f" || e.key === "F") toggleFlashlight();
    },
    { capture: true }
  );

  // keyup: remove inércia / "sliding"
  window.addEventListener(
    "keyup",
    (e) => {
      const key = e.key;
      const keyLower = String(key || "").toLowerCase();
      if (
        keyLower === "w" ||
        keyLower === "a" ||
        keyLower === "s" ||
        keyLower === "d" ||
        key === "ArrowUp" ||
        key === "ArrowDown" ||
        key === "ArrowLeft" ||
        key === "ArrowRight"
      ) {
        movementKeysDown.delete(keyLower || key);
        if (movementKeysDown.size === 0) resetWASDVelocity();
      }
    },
    { capture: true }
  );

  // binds (uma vez) — evita duplicação ao entrar/sair
  $("#btnTourNext")?.addEventListener("click", () =>
    $("#tour")?.components?.["tour-guide"]?.next?.()
  );
  $("#btnTourPrev")?.addEventListener("click", () =>
    $("#tour")?.components?.["tour-guide"]?.prev?.()
  );
  $("#rngMoveSpeedMenu")?.addEventListener("input", (e) =>
    setMoveSpeed(e.target.value)
  );
  $("#rngMoveSpeed")?.addEventListener("input", (e) =>
    setMoveSpeed(e.target.value)
  );

  // restaura lanterna
  toggleFlashlight(localStorage.getItem("virtumuseum.flashlight") === "1");

  // restore welcome opts
  const moveSpeed = Number(
    localStorage.getItem("virtumuseum.moveSpeed") || "2"
  );
  $("#chkWelcomeAmbient") && ($("#chkWelcomeAmbient").checked = ambientOn);
  $("#chkWelcomeTTS") && ($("#chkWelcomeTTS").checked = ttsOn);
  $("#rngMoveSpeed") &&
    ($("#rngMoveSpeed").value = String(clamp(moveSpeed, 1, 6)));
  $("#rngMoveSpeedMenu") &&
    ($("#rngMoveSpeedMenu").value = String(clamp(moveSpeed, 1, 6)));

  restore360Inputs();
  setMenuOpen(false);
  setVoiceStatus(false);
  setMinimalHUD(localStorage.getItem("virtumuseum.hudMinimal") === "1");

  // começa sempre no welcome (evita começar já com UI/painéis)
  setUIVisible(false);
  setWelcomeVisible(true);
  experienceMode = "welcome";
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
  const uiVal = clamp(Number(accel) || 2, 1, 6);
  // Slider é a fonte da verdade para a velocidade.
  // O movimento (teclado/joystick) usa getMoveSpeedUnitsPerSec().
  // Mantemos valores também no wasd-controls só para consistência/debug,
  // mas o componente fica sempre com enabled=false.
  rig.setAttribute("wasd-controls", "acceleration", clamp(uiVal * 1.0, 0.5, 8));
  localStorage.setItem("virtumuseum.moveSpeed", String(uiVal));
  const r1 = $("#rngMoveSpeed");
  const r2 = $("#rngMoveSpeedMenu");
  if (r1) r1.value = String(uiVal);
  if (r2) r2.value = String(uiVal);
}

async function enterExperience(mode) {
  // Sempre que entras (explore/tour) voltas à pose de spawn.
  // Isto evita que uma sessão anterior "vaze" posição/rotação para a próxima.
  hardResetUserPose();

  // aplica opções do welcome
  const amb = !!$("#chkWelcomeAmbient")?.checked;
  const tts = !!$("#chkWelcomeTTS")?.checked;
  localStorage.setItem("virtumuseum.ambient", amb ? "1" : "0");
  localStorage.setItem("virtumuseum.tts", tts ? "1" : "0");

  setMoveSpeed(Number($("#rngMoveSpeed")?.value || 2));

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
    experienceMode = "explore";
    syncBodyModeClasses();
    tour.stop();
    setTeleportEnabled(false);
    rig.setAttribute("wasd-controls", "enabled", false);
    updateTourNav(false);
    hideInfoCard();
    showToast("Exploração livre ativa.");
  } else {
    // garante reset do estado anterior sem efeitos colaterais
    tour.stop();
    experienceMode = "tour";
    syncBodyModeClasses();
    rig.setAttribute("wasd-controls", "enabled", false);
    setTeleportEnabled(false);
    tour.start();
    updateTourNav(true, tour.idx, tour.stops.length);
  }
  syncMovementLock();
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

function initApp() {
  setupUI();

  // 4 paredes "à volta" da galeria (fallback). Se os stops carregarem, isto é refinado.
  applyFourWalls(DEFAULT_GALLERY_BOUNDS, { visual: true });

  // joystick overlay (só em touch/mobile)
  initMobileJoystick();

  // movimento unificado (teclado + joystick)
  startManualMovementLoop();

  // garante que o spawn fica inicializado logo no arranque
  initSpawnPoseOnce();

  // inicia classes do body
  syncBodyModeClasses();
}

// init robusto
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}

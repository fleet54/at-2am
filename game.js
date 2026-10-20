"use strict";

/**
 * 凌晨两点的实验室
 * ------------------------------------------------------------------
 * 一辆只会跑的智能车，和一个不想回邮件的人。
 *
 * 纯 Canvas + 原生 JS，没有任何外部依赖，双击 index.html 就能跑。
 * 空格切换自动驾驶（就是个简化版 PID 循迹），方向键随时接管。
 */

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: false });

// ---------- 小工具 ----------
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const wrapAngle = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};

// ---------- 赛道 ----------
// 用一条闭合的抖动椭圆当中心线，采样成点表，找最近点来做「在线内/线外」判定。
const WORLD = { rx: 430, ry: 320, wobble: 0.13, half: 54 };
const SAMPLES = 900;
const track = [];

for (let i = 0; i < SAMPLES; i += 1) {
  const t = i / SAMPLES;
  const a = t * TAU;
  const w = 1 + WORLD.wobble * Math.sin(3 * a + 0.6) + 0.055 * Math.cos(5 * a + 1.4);
  track.push({ x: Math.cos(a) * WORLD.rx * w, y: Math.sin(a) * WORLD.ry * w });
}

function buildTrackPath() {
  const p = new Path2D();
  p.moveTo(track[0].x, track[0].y);
  for (let i = 1; i < track.length; i += 1) p.lineTo(track[i].x, track[i].y);
  p.closePath();
  return p;
}
const trackPath = buildTrackPath();

function trackAt(index) {
  const n = track.length;
  const i = ((index % n) + n) % n;
  return track[i];
}

function tangentAt(index) {
  const a = trackAt(index);
  const b = trackAt(index + 6);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function nearestIndex(x, y, hint) {
  let best = -1;
  let bestD = Infinity;
  const n = track.length;
  if (hint >= 0) {
    for (let k = -45; k <= 45; k += 1) {
      const i = ((hint + k) % n + n) % n;
      const p = track[i];
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD < 160 * 160) return best;
  }
  bestD = Infinity;
  for (let i = 0; i < n; i += 1) {
    const p = track[i];
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ---------- 零件（收集物） ----------
const PARTS_AT = [0.14, 0.33, 0.52, 0.7, 0.88];
const parts = PARTS_AT.map((t, i) => {
  const idx = Math.floor(t * SAMPLES);
  const p = trackAt(idx);
  const q = trackAt(idx + 4);
  const tangent = Math.atan2(q.y - p.y, q.x - p.x);
  const side = i % 2 === 0 ? 1 : -1;
  return {
    x: p.x + Math.cos(tangent + Math.PI / 2) * side * 18,
    y: p.y + Math.sin(tangent + Math.PI / 2) * side * 18,
    taken: false,
    phase: rand(0, TAU)
  };
});

// ---------- 车 ----------
const car = {
  x: trackAt(0).x,
  y: trackAt(0).y,
  angle: 0,
  speed: 0,
  idx: 0,
  off: false,
  steerVis: 0
};

const state = {
  mode: "intro", // intro | run | done
  lap: 0,
  laps: 3,
  time: 0,
  best: null,
  auto: true,
  parts: 0,
  halfDone: false,
  message: null,
  ending: 0,
  shake: 0,
  started: 0,
  glow: 0
};

const keys = Object.create(null);
let particles = [];
let marks = [];
let motes = [];

// ---------- 音效（全部现场合成，不加载任何文件） ----------
let audio = null;
let engine = null;
let engineGain = null;
let engineFilter = null;
let muted = false;

function initAudio() {
  if (audio) return;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return;
  try {
    audio = new Ctor();
    engine = audio.createOscillator();
    engine.type = "sawtooth";
    engine.frequency.value = 48;
    engineFilter = audio.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = 420;
    engineGain = audio.createGain();
    engineGain.gain.value = 0;
    engine.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(audio.destination);
    engine.start();
  } catch {
    audio = null;
  }
}

function blip(freq, duration = 0.16, type = "sine", volume = 0.09) {
  if (!audio || muted) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const now = audio.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

function chime(up = true) {
  blip(up ? 720 : 520, 0.18, "triangle", 0.07);
  setTimeout(() => blip(up ? 1080 : 390, 0.22, "triangle", 0.05), 90);
}

// ---------- 尺寸 ----------
let W = 0;
let H = 0;
let DPR = 1;
let scale = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  scale = clamp(Math.min(W / 1060, H / 900) * 0.96, 0.72, 1.5);
  motes = Array.from({ length: 70 }, () => ({
    x: rand(0, W),
    y: rand(0, H),
    r: rand(0.6, 2.2),
    a: rand(0.05, 0.3),
    vy: rand(2, 9),
    vx: rand(-1.5, 1.5)
  }));
}

window.addEventListener("resize", resize);

// ---------- 输入 ----------
function anyKey() {
  initAudio();
  if (audio && audio.state === "suspended") audio.resume();
}

window.addEventListener("keydown", (e) => {
  anyKey();
  const k = e.key.toLowerCase();
  if (["arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(k)) e.preventDefault();
  keys[k] = true;

  if (k === " " || e.code === "Space") {
    state.auto = !state.auto;
    pop(state.auto ? "自动驾驶：已接管" : "手动驾驶：方向盘给你");
    blip(state.auto ? 620 : 480, 0.12, "square", 0.05);
  }
  if (k === "m") {
    muted = !muted;
    if (engineGain && audio) engineGain.gain.value = 0;
    pop(muted ? "静音" : "声音打开");
  }
  if (k === "r") reset(true);
  if (k === "arrowleft" || k === "a" || k === "arrowright" || k === "d") {
    if (state.mode === "intro") startRun();
    if (state.auto) {
      state.auto = false;
      pop("手动接管");
    }
  }
  if (k === "arrowup" || k === "w") {
    if (state.mode === "intro") startRun();
  }
});

window.addEventListener("keyup", (e) => {
  keys[e.key.toLowerCase()] = false;
});

// ---------- 提示文字 ----------
function pop(text) {
  state.message = { text, life: 2.2, max: 2.2 };
}

// ---------- 粒子 ----------
function spark(x, y, color, count, spread = 1) {
  for (let i = 0; i < count; i += 1) {
    const a = rand(0, TAU);
    const s = rand(30, 210) * spread;
    particles.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: rand(0.25, 0.7),
      max: 0.7,
      size: rand(1.2, 3.4),
      blend: "lighter",
      color
    });
  }
}

function smoke(x, y, color, drift) {
  particles.push({
    x: x + rand(-4, 4),
    y: y + rand(-4, 4),
    vx: rand(-26, 26) + drift.x * 0.55,
    vy: rand(-26, 26) + drift.y * 0.55,
    life: rand(0.45, 1.1),
    max: 1.1,
    size: rand(3, 7),
    grow: rand(6, 14),
    blend: "normal",
    color
  });
}

// ---------- 状态流转 ----------
function reset(keepBest) {
  car.x = trackAt(0).x;
  car.y = trackAt(0).y;
  car.speed = 0;
  car.idx = 0;
  car.angle = Math.atan2(trackAt(6).y - trackAt(0).y, trackAt(6).x - trackAt(0).x);
  state.mode = "intro";
  state.lap = 0;
  state.time = 0;
  state.parts = 0;
  state.halfDone = false;
  state.auto = true;
  state.ending = 0;
  state.message = null;
  state.glow = 0;
  parts.forEach((p) => (p.taken = false));
  particles = [];
  marks = [];
}

function startRun() {
  const p0 = trackAt(0);
  const p1 = trackAt(6);
  car.x = p0.x;
  car.y = p0.y;
  car.angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  car.speed = 0;
  car.idx = 0;
  car.off = false;
  state.mode = "run";
  state.lap = 0;
  state.time = 0;
  state.parts = 0;
  state.halfDone = false;
  state.started = performance.now();
  parts.forEach((p) => {
    p.taken = false;
  });
  pop("三圈。跑完就去睡。");
  chime(true);
}

// ---------- 物理与逻辑 ----------
function updateCar(dt) {
  const throttleUp = keys["arrowup"] || keys["w"] ? 1 : 0;
  const brake = keys["arrowdown"] || keys["s"] ? 1 : 0;
  let steerInput = 0;
  if (keys["arrowleft"] || keys["a"]) steerInput -= 1;
  if (keys["arrowright"] || keys["d"]) steerInput += 1;

  const idx = nearestIndex(car.x, car.y, car.idx);
  car.idx = idx;
  const center = track[idx];
  const dist = Math.hypot(car.x - center.x, car.y - center.y);
  car.off = dist > WORLD.half;

  let throttle = 0;
  let steer = 0;

  if (state.auto) {
    // 循迹：航向误差 + 横向偏差（纯追踪太爱切内道，改成 PD）
    const dir = tangentAt(idx + 12);
    const lateral = (car.x - center.x) * -Math.sin(dir) + (car.y - center.y) * Math.cos(dir);
    const headingErr = wrapAngle(dir - car.angle);
    steer = clamp(headingErr * 2.4 - lateral * 0.02, -1, 1);
    // 前面这段路弯不弯：两条切线夹角越大，越该松油
    const bend = Math.abs(wrapAngle(tangentAt(idx + 150) - tangentAt(idx + 10)));
    throttle = clamp(1.2 - bend * 0.6, 0.4, 1);
    throttle = Math.min(throttle, 1 - Math.abs(steer) * 0.2);
    if (state.mode === "intro") throttle = 0.55;
  } else {
    steer = steerInput;
    throttle = throttleUp ? 1 : brake ? -1 : 0.28;
  }

  if (state.mode === "done") {
    // 完赛后自己慢慢巡游，别撞墙
    const look = trackAt(idx + 80);
    const diff = wrapAngle(Math.atan2(look.y - car.y, look.x - car.x) - car.angle);
    steer = clamp(diff * 2.4, -1, 1);
    throttle = 0.35;
  }

  car.steerVis = lerp(car.steerVis, steer, 1 - Math.pow(0.001, dt));

  const maxSpeed = 430;
  const targetSpeed = throttle >= 0 ? throttle * maxSpeed : -90;
  const responsiveness = throttle < 0 ? 6.5 : 2.9;
  car.speed = lerp(car.speed, targetSpeed, 1 - Math.pow(0.001, dt * responsiveness * 0.35));

  if (car.off) car.speed *= Math.pow(0.42, dt);

  // 转向角速度随车速增长后饱和：高速时转弯半径不再随速度变大
  const grip = clamp(Math.abs(car.speed) / 110, 0, 1);
  const turnRate = 2.75 * clamp(Math.abs(car.speed) / 260, 0, 1.3);
  car.angle += steer * turnRate * grip * dt * (car.speed < 0 ? -1 : 1);

  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;
  car.x = nx;
  car.y = ny;

  // 圈数：从接近终点的一段跨过起点
  if (state.mode === "run") {
    const frac = idx / SAMPLES;
    if (frac > 0.5 && frac < 0.75) state.halfDone = true;
    if (state.halfDone && idx < SAMPLES * 0.06 && car.speed > 0) {
      state.halfDone = false;
      state.lap += 1;
      if (state.lap >= state.laps) {
        finishRun();
      } else {
        pop(["第一圈。", "第二圈。再快一点。", "最后一圈。"][state.lap - 1] || "又来一圈");
        chime(true);
        state.glow = 1;
      }
      spark(car.x, car.y, "rgba(120,220,255,0.9)", 18, 1.4);
    }
  }

  // 零件（只有正式开跑之后才算，开场巡游时别把人家零件先捡了）
  for (const p of parts) {
    if (state.mode !== "run") break;
    if (!p.taken && Math.hypot(p.x - car.x, p.y - car.y) < 34) {
      p.taken = true;
      state.parts += 1;
      spark(p.x, p.y, "rgba(255,214,120,0.95)", 22, 1.3);
      chime(false);
      if (state.parts === parts.length) {
        pop("零件集齐：车灯彻底亮了");
        state.glow = 1;
      } else {
        pop(`捡到一个零件 ${state.parts}/${parts.length}`);
      }
    }
  }

  // 车尾的烟和胎痕
  const back = { x: car.x - Math.cos(car.angle) * 16, y: car.y - Math.sin(car.angle) * 16 };
  if (Math.abs(car.speed) > 40) {
    if (Math.random() < 0.34) {
      smoke(back.x, back.y, car.off ? "rgba(120,96,70,0.26)" : "rgba(150,170,210,0.13)", {
        x: -Math.cos(car.angle) * 18,
        y: -Math.sin(car.angle) * 18
      });
    }
    // 只有打方向、轮胎在响的时候才留痕
    if (Math.abs(car.speed) > 210 && Math.abs(car.steerVis) > 0.45 && Math.random() < 0.4) {
      marks.push({ x: back.x, y: back.y, a: 0.3 });
      if (marks.length > 600) marks.shift();
    }
  }
  if (car.off && Math.abs(car.speed) > 120 && Math.random() < 0.5) {
    spark(back.x, back.y, "rgba(255,190,120,0.8)", 2, 0.6);
    state.shake = Math.max(state.shake, 2.5);
  }

  if (state.mode === "run") state.time = (performance.now() - state.started) / 1000;
}

function finishRun() {
  state.mode = "done";
  state.ending = 0;
  state.shake = 8;
  state.best = state.time;
  pop("跑完了。");
  chime(true);
  for (let i = 0; i < 6; i += 1) {
    setTimeout(() => {
      spark(car.x + rand(-120, 120), car.y + rand(-120, 120), ["rgba(255,190,120,0.95)", "rgba(140,220,255,0.95)", "rgba(255,140,180,0.9)"][i % 3], 34, 1.8);
      blip(rand(600, 1200), 0.2, "triangle", 0.05);
    }, i * 130);
  }
}

// ---------- 绘制 ----------
function drawBackground(t) {
  const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 40, W * 0.5, H * 0.5, Math.max(W, H) * 0.85);
  g.addColorStop(0, "#111a2e");
  g.addColorStop(0.55, "#0a0f1c");
  g.addColorStop(1, "#05070d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 地板网格
  const ox = -car.x * 0.35;
  const oy = -car.y * 0.35;
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = "#3f6ea8";
  ctx.lineWidth = 1;
  const step = 64;
  const sx = ((ox + (W / 2) * 0) % step) - step;
  for (let x = sx; x < W; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  const sy = ((oy + 0) % step) - step;
  for (let y = sy; y < H; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.restore();

  // 飘尘
  ctx.save();
  for (const m of motes) {
    m.y -= m.vy * 0.016;
    m.x += m.vx * 0.016;
    if (m.y < -10) {
      m.y = H + 10;
      m.x = rand(0, W);
    }
    if (m.x < -10) m.x = W + 10;
    if (m.x > W + 10) m.x = -10;
    ctx.globalAlpha = m.a * (0.7 + 0.3 * Math.sin(t * 0.001 + m.r * 10));
    ctx.fillStyle = "#bcd6ff";
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawTrack() {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // 外发光边
  ctx.strokeStyle = "rgba(78,170,255,0.16)";
  ctx.lineWidth = WORLD.half * 2 + 26;
  ctx.stroke(trackPath);

  // 沥青
  ctx.strokeStyle = "#1d2740";
  ctx.lineWidth = WORLD.half * 2;
  ctx.stroke(trackPath);

  // 中间那道发光的线（有点沥青味儿）
  ctx.strokeStyle = "rgba(110,164,235,0.13)";
  ctx.lineWidth = WORLD.half * 2 - 22;
  ctx.stroke(trackPath);

  // 路肩
  ctx.save();
  ctx.setLineDash([26, 30]);
  ctx.strokeStyle = "rgba(120,200,255,0.30)";
  ctx.lineWidth = 3;
  ctx.stroke(trackPath);
  ctx.restore();

  // 中线虚影
  ctx.save();
  ctx.setLineDash([10, 46]);
  ctx.strokeStyle = "rgba(190,220,255,0.16)";
  ctx.lineWidth = 2;
  ctx.stroke(trackPath);
  ctx.restore();

  // 起跑线
  const p0 = trackAt(0);
  const p1 = trackAt(8);
  const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  ctx.save();
  ctx.translate(p0.x, p0.y);
  ctx.rotate(ang);
  const cw = 10;
  for (let i = -5; i < 5; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      ctx.fillStyle = (i + j) % 2 === 0 ? "rgba(226,238,255,0.75)" : "rgba(40,52,74,0.9)";
      ctx.fillRect(0, i * cw, cw, cw);
    }
  }
  ctx.restore();
}

function drawParts(t) {
  for (const p of parts) {
    if (p.taken) continue;
    const pulse = 0.7 + 0.3 * Math.sin(t * 0.004 + p.phase);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(t * 0.001 + p.phase);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "rgba(255,214,120,0.9)";
    ctx.shadowColor = "rgba(255,200,90,0.9)";
    ctx.shadowBlur = 18 * pulse;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(11, 0);
    ctx.lineTo(0, 11);
    ctx.lineTo(-11, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawCar() {
  const speedRatio = clamp(Math.abs(car.speed) / 430, 0, 1);
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);

  // 车头灯光锥
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const cone = ctx.createLinearGradient(10, 0, 190, 0);
  const hot = 0.18 + 0.2 * state.glow;
  cone.addColorStop(0, `rgba(255,240,200,${hot})`);
  cone.addColorStop(1, "rgba(255,240,200,0)");
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(10, -7);
  ctx.lineTo(190, -52 - 10 * speedRatio);
  ctx.lineTo(190, 52 + 10 * speedRatio);
  ctx.lineTo(10, 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 车身
  ctx.shadowColor = "rgba(90,180,255,0.55)";
  ctx.shadowBlur = 14 + 18 * speedRatio;
  const bodyGrad = ctx.createLinearGradient(-16, -9, 16, 9);
  bodyGrad.addColorStop(0, "#7fd0ff");
  bodyGrad.addColorStop(0.5, "#2f7fd6");
  bodyGrad.addColorStop(1, "#1b4f8f");
  ctx.fillStyle = bodyGrad;
  roundRect(-17, -9, 34, 18, 6);
  ctx.fill();
  ctx.shadowBlur = 0;

  // 挡风玻璃
  ctx.fillStyle = "rgba(12,26,44,0.9)";
  roundRect(-1, -6.5, 10, 13, 3);
  ctx.fill();

  // 前灯
  ctx.fillStyle = "rgba(255,246,214,0.95)";
  ctx.beginPath();
  ctx.arc(15, -5, 1.8, 0, TAU);
  ctx.arc(15, 5, 1.8, 0, TAU);
  ctx.fill();

  // 尾灯
  ctx.fillStyle = "rgba(255,80,90,0.85)";
  ctx.fillRect(-18, -6.5, 3, 4);
  ctx.fillRect(-18, 2.5, 3, 4);

  // 轮子
  ctx.fillStyle = "#0a1020";
  const steerOffset = car.steerVis * 0.5;
  ctx.save();
  ctx.translate(11, 0);
  ctx.rotate(steerOffset);
  ctx.fillRect(-4, -11, 8, 4);
  ctx.fillRect(-4, 7, 8, 4);
  ctx.restore();
  ctx.fillRect(-13, -12, 8, 4);
  ctx.fillRect(-13, 8, 8, 4);

  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawParticles(dt) {
  // 先更新，再分两种混合模式画：烟是普通混合，火花是叠加
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.95;
    p.vy *= 0.95;
    if (p.grow) p.size += p.grow * dt;
  }

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  for (const p of particles) {
    if (p.blend !== "normal") continue;
    const a = clamp(p.life / p.max, 0, 1);
    ctx.globalAlpha = a * 0.85;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.7 + a * 0.6), 0, TAU);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "lighter";
  for (const p of particles) {
    if (p.blend === "normal") continue;
    const a = clamp(p.life / p.max, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.5 + a), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawMarks() {
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#000";
  for (const m of marks) {
    m.a *= 0.9995;
    ctx.globalAlpha = Math.max(m.a * 0.5, 0);
    ctx.beginPath();
    ctx.arc(m.x, m.y, 1.6, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawHud() {
  ctx.save();
  ctx.font = "600 15px 'Microsoft YaHei', system-ui, sans-serif";
  ctx.textBaseline = "top";

  const pad = 28;
  // 左上
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = "rgba(10,16,28,0.55)";
  roundRect(pad - 12, pad - 10, 250, 96, 12);
  ctx.fill();

  ctx.fillStyle = "#9fc3ee";
  ctx.fillText("圈数", pad, pad);
  ctx.fillStyle = "#e8f2ff";
  ctx.font = "700 26px 'Microsoft YaHei', system-ui, sans-serif";
  ctx.fillText(`${Math.min(state.lap, state.laps)} / ${state.laps}`, pad + 52, pad - 6);

  ctx.font = "600 14px 'Microsoft YaHei', system-ui, sans-serif";
  ctx.fillStyle = "#9fc3ee";
  ctx.fillText("时间", pad, pad + 34);
  ctx.fillStyle = "#dfeaff";
  ctx.fillText(`${state.time.toFixed(1)}s`, pad + 52, pad + 33);

  ctx.fillStyle = "#9fc3ee";
  ctx.fillText("零件", pad, pad + 60);
  ctx.fillStyle = "#ffd678";
  ctx.fillText(`${state.parts} / ${parts.length}`, pad + 52, pad + 60);

  // 速度条
  const speedRatio = clamp(Math.abs(car.speed) / 430, 0, 1);
  const bw = 180;
  const bx = W - pad - bw;
  const by = pad + 4;
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = "rgba(10,16,28,0.5)";
  roundRect(bx - 12, by - 14, bw + 24, 52, 10);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(120,170,230,0.22)";
  roundRect(bx, by, bw, 8, 4);
  ctx.fill();
  const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  grad.addColorStop(0, "#4ea8ff");
  grad.addColorStop(1, "#a8f0ff");
  ctx.fillStyle = grad;
  roundRect(bx, by, Math.max(4, bw * speedRatio), 8, 4);
  ctx.fill();
  ctx.fillStyle = "rgba(200,225,255,0.75)";
  ctx.font = "600 12px 'Microsoft YaHei', system-ui, sans-serif";
  ctx.fillText(`${Math.round(Math.abs(car.speed) * 0.42)} km/h · ${state.auto ? "AUTO" : "手动"}`, bx, by + 16);

  // 偏离提示
  if (car.off && state.mode !== "done") {
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(performance.now() * 0.02);
    ctx.fillStyle = "#ff9f6a";
    ctx.font = "600 14px 'Microsoft YaHei', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("轮胎：这路我不熟。", W / 2, H - 60);
    ctx.textAlign = "left";
  }

  // 弹幕式提示
  if (state.message) {
    const m = state.message;
    const a = clamp(m.life / m.max, 0, 1);
    ctx.globalAlpha = Math.min(1, a * 2);
    ctx.textAlign = "center";
    ctx.font = "600 17px 'Microsoft YaHei', system-ui, sans-serif";
    ctx.fillStyle = "#cfe6ff";
    ctx.shadowColor = "rgba(80,160,255,0.6)";
    ctx.shadowBlur = 16;
    ctx.fillText(m.text, W / 2, 92);
    ctx.shadowBlur = 0;
    ctx.textAlign = "left";
  }

  ctx.restore();
}

function drawIntro(t) {
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.textAlign = "center";

  ctx.fillStyle = "rgba(6,10,18,0.42)";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#eaf3ff";
  ctx.font = "700 44px 'Microsoft YaHei', system-ui, sans-serif";
  ctx.shadowColor = "rgba(90,170,255,0.65)";
  ctx.shadowBlur = 30;
  ctx.fillText("凌晨两点的实验室", W / 2, H * 0.36);
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#8fb4dd";
  ctx.font = "400 16px 'Microsoft YaHei', system-ui, sans-serif";
  ctx.fillText("一辆只会跑的智能车，和一个不想回邮件的人。", W / 2, H * 0.36 + 44);

  ctx.fillStyle = "#d8e8ff";
  ctx.font = "600 18px 'Microsoft YaHei', system-ui, sans-serif";
  const blink = 0.55 + 0.45 * Math.sin(t * 0.004);
  ctx.globalAlpha = blink;
  ctx.fillText("按 → 或 D 开始 · 空格接管方向盘", W / 2, H * 0.36 + 116);

  ctx.globalAlpha = 0.8;
  ctx.fillStyle = "#6f88ab";
  ctx.font = "400 13px 'Microsoft YaHei', system-ui, sans-serif";
  ctx.fillText("三圈。跑完就去睡。", W / 2, H * 0.36 + 150);
  ctx.restore();
}

const ENDING_LINES = [
  { text: "三圈，跑完了。", delay: 0.4, size: 40, color: "#eaf3ff" },
  { text: "轮胎还热着，实验室的灯还亮着。", delay: 2.0, size: 19, color: "#a9c6e8" },
  { text: "今晚不用回那封邮件，", delay: 3.6, size: 21, color: "#cfe2ff" },
  { text: "也不用想那七个岗位。", delay: 4.8, size: 21, color: "#cfe2ff" },
  { text: "先睡。代码明天还是你的。", delay: 6.4, size: 23, color: "#ffd9a8" },
  { text: "R 再跑一次 · 空格接管方向盘", delay: 8.2, size: 13, color: "#6f88ab" }
];

function drawEnding() {
  const t = state.ending;
  ctx.save();
  ctx.textAlign = "center";
  const alpha = clamp(t / 0.8, 0, 1);
  ctx.globalAlpha = alpha * 0.6;
  ctx.fillStyle = "rgba(5,8,14,1)";
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;

  let y = H * 0.30;
  for (const line of ENDING_LINES) {
    const local = clamp((t - line.delay) / 0.9, 0, 1);
    if (local <= 0) {
      y += line.size + 22;
      continue;
    }
    ctx.globalAlpha = local;
    ctx.fillStyle = line.color;
    ctx.font = `700 ${line.size}px 'Microsoft YaHei', system-ui, sans-serif`;
    if (line.size > 30) {
      ctx.shadowColor = "rgba(90,170,255,0.6)";
      ctx.shadowBlur = 28;
    } else {
      ctx.shadowBlur = 0;
    }
    ctx.fillText(line.text, W / 2, y);
    ctx.shadowBlur = 0;
    y += line.size + 22;
  }
  ctx.restore();
}

// ---------- 主循环 ----------
let last = performance.now();

function frame(now) {
  const dtRaw = (now - last) / 1000;
  last = now;
  const dt = Math.min(dtRaw, 0.05);

  if (state.mode === "run" || state.mode === "intro" || state.mode === "done") {
    updateCar(dt);
  }
  if (state.mode === "done") state.ending += dt;
  if (state.message) {
    state.message.life -= dt;
    if (state.message.life <= 0) state.message = null;
  }
  state.shake *= Math.pow(0.02, dt);
  state.glow *= Math.pow(0.35, dt);

  if (state.mode === "intro") state.started += dt;

  // 引擎声
  if (engineGain && audio) {
    const target = muted ? 0 : 0.02 + 0.05 * clamp(Math.abs(car.speed) / 430, 0, 1);
    engineGain.gain.value = lerp(engineGain.gain.value, target, 0.08);
    engine.frequency.value = 44 + Math.abs(car.speed) * 0.16;
    engineFilter.frequency.value = 360 + Math.abs(car.speed) * 1.6;
  }

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawBackground(now);

  const shakeX = state.shake > 0.2 ? rand(-state.shake, state.shake) : 0;
  const shakeY = state.shake > 0.2 ? rand(-state.shake, state.shake) : 0;

  ctx.save();
  ctx.translate(W / 2 + shakeX, H / 2 + shakeY);
  ctx.scale(scale, scale);
  drawTrack();
  drawMarks();
  drawParts(now);
  drawParticles(dt);
  drawCar();
  ctx.restore();

  // 完赛后把 HUD 收起来，把画面让给那几句话
  if (state.mode !== "done" || state.ending < 0.5) drawHud();

  if (state.mode === "intro") drawIntro(now);
  if (state.mode === "done") drawEnding();
  requestAnimationFrame(frame);
}

// ---------- 启动 ----------
resize();
reset(false);
car.angle = Math.atan2(trackAt(6).y - trackAt(0).y, trackAt(6).x - trackAt(0).x);

// 给自动化测试留个观察口（浏览器控制台里也能看）
window.__game = { state, car, parts, track, SAMPLES, WORLD, step: updateCar };

requestAnimationFrame((t) => {
  last = t;
  frame(t);
});

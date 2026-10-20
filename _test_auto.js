"use strict";

/**
 * 自动驾驶通关测试：不按方向键，只按一次 ↑ 开局，
 * 然后让游戏自己的自动驾驶跑，断言 3 圈跑完、进入 done。
 */

const fs = require("fs");
const path = require("path");

const noop = () => {};

function makeCtx() {
  const grad = { addColorStop: noop };
  const base = {
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    measureText: () => ({ width: 10 }),
    setLineDash: noop
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol") return undefined;
      return noop;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
}

const ctx = makeCtx();
const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: noop };

const listeners = Object.create(null);
const rafQueue = [];
let now = 0;

global.Path2D = class {
  moveTo() {}
  lineTo() {}
  closePath() {}
  arc() {}
};
global.document = { getElementById: () => canvas, createElement: () => canvas, addEventListener: noop };
global.window = {
  innerWidth: 1600,
  innerHeight: 900,
  devicePixelRatio: 1,
  addEventListener(type, handler) {
    (listeners[type] = listeners[type] || []).push(handler);
  },
  requestAnimationFrame: (cb) => rafQueue.push(cb)
};
global.requestAnimationFrame = (cb) => rafQueue.push(cb);
global.performance = { now: () => now };

function key(k) {
  for (const handler of listeners.keydown || []) {
    handler({ key: k, code: "", preventDefault: noop });
  }
}

new Function(fs.readFileSync(path.join(__dirname, "game.js"), "utf8"))();

const game = global.window.__game;
if (!game) {
  console.error("FAIL: window.__game 没有暴露");
  process.exit(1);
}

let frames = 0;
let offFrames = 0;
const MAX = 4000;

while (rafQueue.length > 0 && frames < MAX) {
  const cb = rafQueue.shift();
  now += 16.7;
  if (frames === 10) key("ArrowUp"); // 开局（不碰自动驾驶开关）
  cb(now);
  frames += 1;
  if (game.state.mode === "run" && game.car.off) offFrames += 1;
  if (game.state.mode === "done") break;
}

const { state, car } = game;
const offRatio = frames > 0 ? offFrames / frames : 1;

console.log(
  JSON.stringify(
    {
      frames,
      mode: state.mode,
      lap: state.lap,
      parts: state.parts,
      time: Number(state.time.toFixed(2)),
      best: Number(state.best.toFixed(2)),
      offFrames,
      offRatio: Number(offRatio.toFixed(3)),
      speed: Number(car.speed.toFixed(1))
    },
    null,
    2
  )
);

let failed = false;
if (state.mode !== "done") {
  console.error(`FAIL: ${frames} 帧后仍在 ${state.mode}，圈数 ${state.lap}`);
  failed = true;
}
if (state.lap < 3) {
  console.error(`FAIL: 只跑了 ${state.lap} 圈`);
  failed = true;
}
if (!(state.time > 0)) {
  console.error(`FAIL: 用时异常 ${state.time}`);
  failed = true;
}
if (offRatio > 0.15) {
  console.error(`FAIL: 出赛道帧占比 ${(offRatio * 100).toFixed(1)}% 过高，自动驾驶没控住车`);
  failed = true;
}

console.log(failed ? "AUTO FAIL" : `AUTO OK: 自动驾驶 ${state.time.toFixed(1)}s 跑完 3 圈，出赛道占比 ${(offRatio * 100).toFixed(1)}%`);
process.exit(failed ? 1 : 0);

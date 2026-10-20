"use strict";

/**
 * 无头冒烟测试：给 game.js 喂一套假的 DOM / Canvas，跑 1200 帧，
 * 中途模拟按键，确认没有运行时异常。
 * 这不是「好看」的验证，但能挡住 90% 的「打开就白屏」。
 */

const fs = require("fs");
const path = require("path");

const noop = () => {};

function makeCtx() {
  const grad = { addColorStop: noop };
  const base = {
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    setLineDash: noop,
    getLineDash: () => [],
    getImageData: () => ({ data: new Uint8ClampedArray(4) })
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

class FakePath2D {
  moveTo() {}
  lineTo() {}
  closePath() {}
  arc() {}
  rect() {}
}

const canvas = {
  width: 0,
  height: 0,
  style: {},
  getContext: () => ctx,
  addEventListener: noop
};

const listeners = Object.create(null);
let rafQueue = [];
let now = 0;

global.Path2D = FakePath2D;
global.document = {
  getElementById: () => canvas,
  createElement: () => canvas,
  addEventListener: noop
};
global.window = {
  innerWidth: 1600,
  innerHeight: 900,
  devicePixelRatio: 2,
  addEventListener(type, handler) {
    (listeners[type] = listeners[type] || []).push(handler);
  },
  AudioContext: undefined,
  webkitAudioContext: undefined,
  requestAnimationFrame: (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }
};
global.requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
global.performance = { now: () => now };

function key(type, k, code) {
  const handlers = listeners[type] || [];
  for (const handler of handlers) {
    handler({ key: k, code: code || "", preventDefault: noop });
  }
}

const source = fs.readFileSync(path.join(__dirname, "game.js"), "utf8");
// eslint-disable-next-line no-new-func
new Function(source)();

let frames = 0;
const MAX = 1400;
while (rafQueue.length > 0 && frames < MAX) {
  const cb = rafQueue.shift();
  now += 16.7;
  if (frames === 30) key("keydown", " ", "Space"); // 切手动
  if (frames === 31) key("keydown", " ", "Space"); // 切回自动，顺便测分支
  if (frames === 60) key("keydown", "ArrowRight");
  if (frames === 120) key("keyup", "ArrowRight");
  if (frames === 200) key("keydown", "ArrowUp");
  if (frames === 400) key("keyup", "ArrowUp");
  if (frames === 500) key("keydown", "ArrowLeft");
  if (frames === 560) key("keyup", "ArrowLeft");
  if (frames === 800) key("keydown", "r");
  if (frames === 900) key("keydown", "ArrowRight"); // 重新开局
  if (frames === 1000) key("keydown", "m");
  cb(now);
  frames += 1;
  if (frames % 200 === 0) {
    process.stdout.write(`frame ${frames} ok\n`);
  }
}

process.stdout.write(`SMOKE OK: ${frames} frames, canvas ${canvas.width}x${canvas.height}\n`);
if (frames < 100) {
  process.exitCode = 1;
  process.stdout.write("SMOKE FAIL: 循环没跑起来（requestAnimationFrame 没被调用）\n");
}

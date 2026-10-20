"use strict";

/**
 * 通过本地 DevTools 协议，确认真实浏览器窗口里的游戏确实在跑，
 * 并顺手截一张真实的页面图。
 * 用法: node _cdp.js <debugPort> <outputPng>
 */

const fs = require("fs");
const path = require("path");

const port = process.argv[2];
const out = process.argv[3] || path.join(__dirname, "shots", "shot-live.png");

async function main() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === "page" && String(t.url).includes("at-2am"));
  if (!page) {
    console.error("FAIL: 找不到游戏页面");
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  if (process.argv[4] === "reload") {
    await send("Page.reload", { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 2500));
  }

  const probe = await send("Runtime.evaluate", {
    expression: `(function(){
      var g = window.__game;
      if (!g) return "NO_GAME";
      return JSON.stringify({
        mode: g.state.mode,
        lap: g.state.lap,
        speed: Math.round(g.car.speed),
        parts: g.state.parts,
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
        canvas: document.getElementById("game").width + "x" + document.getElementById("game").height
      });
    })()`,
    returnByValue: true
  });

  console.log("PROBE:", probe.result.value);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("SHOT:", out, fs.statSync(out).size, "bytes");
  ws.close();
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});

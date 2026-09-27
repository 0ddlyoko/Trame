import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const w = dom.window;
w.requestAnimationFrame = (cb) => { Promise.resolve().then(() => cb(w.performance.now())); return 0; };
for (const k of Object.getOwnPropertyNames(w)) {
  if (k in globalThis) continue;
  try { globalThis[k] = w[k]; } catch {}
}
globalThis.window = w; globalThis.document = w.document;
globalThis.requestAnimationFrame = w.requestAnimationFrame;

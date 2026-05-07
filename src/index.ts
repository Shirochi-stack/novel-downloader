import { cleanDOM } from "./lib/cleanDOM";
import { getHtmlDOM } from "./lib/http";
import { getRule } from "./router/download";
import { environments } from "./detect";
import { init as globalInit } from "./global";
import { log } from "./log";
import "./ui/fixVue";
import { init as uiInit } from "./ui/ui";

async function printEnvironments() {
  log.info("[Init]开始载入小说下载器……");
  Object.entries(await environments()).forEach((kv) =>
    log.info("[Init]" + kv.join("："))
  );
}

async function main(ev?: Event) {
  if (ev) {
    document.removeEventListener(ev.type, main);
  }

  globalInit();
  await printEnvironments();
  await uiInit();
}

// Bridge mode: skip full UI init, just expose internals for external callers.
// Exports:
//   __ND_getRule()    — returns the rule class/instance matching window.location
//   __ND_getHtmlDOM() — fetches a URL, returns { doc, charset } DOM object
//   __ND_cleanDOM()   — sanitises a DOM element for EPUB-safe XHTML output
if ((window as any).__ND_BRIDGE_MODE) {
  (window as any).__ND_getRule = getRule;
  (window as any).__ND_getHtmlDOM = getHtmlDOM;
  try { (window as any).__ND_cleanDOM = cleanDOM; } catch(e) {}
  (window as any).__ND_READY = true;
  log.info("[Init] Bridge mode - skipping UI init, getRule exposed.");
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  // noinspection JSIgnoredPromiseFromCall
  main();
}

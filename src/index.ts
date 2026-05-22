async function runBridgeMode() {
  const [{ cleanDOM }, { getHtmlDOM }, { getRule }, { log }] =
    await Promise.all([
      import("./lib/cleanDOM"),
      import("./lib/http"),
      import("./router/download"),
      import("./log"),
    ]);

  (window as any).__ND_getRule = getRule;
  (window as any).__ND_getHtmlDOM = getHtmlDOM;
  (window as any).__ND_cleanDOM = cleanDOM;
  (window as any).__ND_READY = true;
  log.info("[Init] Bridge mode - skipping UI init, getRule exposed.");
}

async function runNormalMode() {
  const { run } = await import("./bootstrap/top");
  await run();
}

(((window as any).__ND_BRIDGE_MODE ? runBridgeMode : runNormalMode)()).catch(
  (err) => {
    // Logger may not be initialized yet — use console directly.
    // eslint-disable-next-line no-console
    console.error("[novel-downloader] bootstrap failed", err);
  },
);

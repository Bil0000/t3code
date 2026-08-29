// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off -- Disposable Electron visual-test entrypoint, outside the application Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { analyzeWindowCaptureAnimation } from "./WindowCaptureAnimationAnalysis.ts";
import {
  WindowCaptureTransition,
  windowCaptureAnimationOverlayBounds,
} from "./WindowCaptureTransition.ts";

function readOutputDirectory(): string {
  const value = process.env.T3_WINDOW_CAPTURE_LAB_OUTPUT?.trim();
  if (!value) throw new Error("T3_WINDOW_CAPTURE_LAB_OUTPUT is required");
  return value;
}

const outputDirectory = readOutputDirectory();
const recordVideo = process.env.T3_WINDOW_CAPTURE_LAB_RECORD !== "0";
Electron.app.setPath("userData", NodePath.join(outputDirectory, "user-data"));
Electron.app.setName("T3 Window Capture Motion Lab");

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const targetHtml = `<!doctype html>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#050505;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{display:flex;align-items:flex-start;justify-content:center;padding-top:40px}
#shell{position:relative;width:min(760px,calc(100vw - 96px));height:430px;border:1px solid #252525;border-radius:24px;background:#101010;box-shadow:0 30px 100px rgba(0,0,0,.45)}
#title{position:absolute;inset:34px 34px auto;font-size:28px;text-align:center}
#composer{position:absolute;inset:100px 34px 34px;border:1px solid #2b2b2b;border-radius:20px;background:#151515}
#attachments{display:flex;gap:8px;padding:24px}
#slot{position:relative;width:208px;height:112px;overflow:hidden;border:4px solid #ff00ff;border-radius:8px;background:#111;visibility:hidden}
#slot[data-visible]{visibility:visible}
#snapshot{display:block;width:100%;height:100%;object-fit:cover}
#details{position:absolute;inset-inline:0;bottom:0;display:flex;align-items:center;gap:6px;padding:24px 10px 8px;background:linear-gradient(to top,rgba(0,0,0,.85),rgba(0,0,0,.55),transparent)}
#icon{display:grid;width:28px;height:28px;place-items:center;border-radius:6px;background:rgba(255,255,255,.2);font-size:10px;font-weight:600}
#copy{min-width:0}.line{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:14px}.app{font-size:11px;font-weight:500}.window{color:rgba(255,255,255,.7);font-size:9px}
#prompt{position:absolute;left:24px;bottom:28px;color:#777;font-size:18px}
#handoff-marker{position:fixed;right:8px;bottom:8px;width:8px;height:8px;background:transparent}
#handoff-marker[data-phase="native"]{background:#ff0000}
#handoff-marker[data-phase="dom"]{background:#00ff00}
</style>
<div id="shell">
  <div id="title">Window capture motion lab</div>
  <div id="composer">
    <div id="attachments">
      <div id="slot"><img id="snapshot"><div id="details"><div id="icon">T</div><div id="copy"><div class="line app">T3 Code</div><div class="line window">Deterministic source window</div></div></div></div>
    </div>
    <div id="prompt">Ask for changes, send follow-ups, or attach images</div>
</div>
<div id="handoff-marker"></div>
</div>`;

const sourceHtml = `<!doctype html>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{background:linear-gradient(135deg,#10192f,#421a56);color:white}
#grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.08) 1px,transparent 1px);background-size:32px 32px}
#mark{position:absolute;left:64px;top:72px;font-size:54px;font-weight:700;letter-spacing:-2px}
#sub{position:absolute;left:68px;top:145px;font-size:22px;color:rgba(255,255,255,.72)}
#blocks{position:absolute;right:70px;bottom:70px;display:grid;grid-template-columns:repeat(3,86px);gap:12px}
.block{height:86px;border:1px solid rgba(255,255,255,.25);border-radius:18px;background:rgba(255,255,255,.1)}
</style>
<div id="grid"></div><div id="mark">CAPTURE SOURCE</div><div id="sub">Every frame should move. The last frame must match the card.</div><div id="blocks">${'<div class="block"></div>'.repeat(6)}</div>`;

async function loadHtml(window: Electron.BrowserWindow, html: string): Promise<void> {
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

async function startRecording(window: Electron.BrowserWindow, sourceId: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async()=>{
    const stream=await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{mandatory:{
        chromeMediaSource:"desktop",
        chromeMediaSourceId:${JSON.stringify(sourceId)},
        minFrameRate:60,
        maxFrameRate:60
      }}
    });
    const mimeType=["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm"]
      .find((candidate)=>MediaRecorder.isTypeSupported(candidate));
    const chunks=[];
    const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:20000000});
    window.__windowCaptureAnimationRecording={chunks,recorder,stream};
    await new Promise((resolve,reject)=>{
      recorder.addEventListener("start",()=>requestAnimationFrame(()=>resolve()),{once:true});
      recorder.addEventListener("error",(event)=>reject(event.error),{once:true});
      recorder.addEventListener("dataavailable",(event)=>{if(event.data.size>0) chunks.push(event.data)});
      recorder.start(16);
    });
  })()`);
}

async function stopRecording(window: Electron.BrowserWindow): Promise<Buffer> {
  const encoded = (await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const recording=window.__windowCaptureAnimationRecording;
    if(!recording){reject(new Error("Animation recording was not started"));return;}
    recording.recorder.addEventListener("error",(event)=>reject(event.error),{once:true});
    recording.recorder.addEventListener("stop",()=>{
      const blob=new Blob(recording.chunks,{type:recording.recorder.mimeType});
      const reader=new FileReader();
      reader.addEventListener("error",()=>reject(reader.error),{once:true});
      reader.addEventListener("load",()=>{
        recording.stream.getTracks().forEach((track)=>track.stop());
        resolve(String(reader.result).split(",")[1]);
      },{once:true});
      reader.readAsDataURL(blob);
    },{once:true});
    recording.recorder.stop();
  })`)) as string;
  return Buffer.from(encoded, "base64");
}

async function findDisplayCaptureSource(
  displayId: number,
): Promise<Electron.DesktopCapturerSource> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sources = await Electron.desktopCapturer.getSources({
      types: ["screen"],
      fetchWindowIcons: false,
      thumbnailSize: { width: 1, height: 1 },
    });
    const exact = sources.find((captureSource) => captureSource.display_id === String(displayId));
    if (exact) return exact;
    if (sources.length === 1 && sources[0]) return sources[0];
    await delay(50);
  }
  throw new Error("The lab display was not available to the recorder");
}

async function run(): Promise<void> {
  await Electron.app.whenReady();
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  const targetHtmlPath = NodePath.join(outputDirectory, "target.html");
  await NodeFSP.writeFile(targetHtmlPath, targetHtml);
  const display = Electron.screen.getPrimaryDisplay();
  const useWorkArea =
    display.workArea.x !== display.bounds.x || display.workArea.y !== display.bounds.y;
  const width = Math.min(1_100, display.workArea.width - 80);
  const height = Math.min(760, display.workArea.height - 80);
  const bounds = {
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
    width,
    height,
  };
  const target = new Electron.BrowserWindow({
    ...bounds,
    show: false,
    backgroundColor: "#050505",
    title: "T3 Window Capture Motion Lab",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  const source = new Electron.BrowserWindow({
    ...bounds,
    show: false,
    backgroundColor: "#10192f",
    title: "Deterministic source window",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  await Promise.all([target.loadFile(targetHtmlPath), loadHtml(source, sourceHtml)]);
  source.show();
  source.focus();
  await delay(650);

  const thumbnail = await source.webContents.capturePage();
  const sourceBounds = source.getContentBounds();
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Disposable Electron visual-test entrypoint has no Effect runtime.
  const boundOverlayToFlight = process.platform === "win32";
  const transition = new WindowCaptureTransition({
    boundOverlayToFlight,
    useWorkArea,
  });
  const id = "00000000-0000-4000-8000-000000000001";
  await transition.begin(id, sourceBounds, thumbnail.toDataURL(), true, false);

  const targetFrame = (await target.webContents.executeJavaScript(`(() => {
    const frame=document.getElementById("slot").getBoundingClientRect();
    return {
      viewport:{x:frame.x,y:frame.y,width:frame.width,height:frame.height},
      screen:{x:window.screenX+frame.x,y:window.screenY+frame.y,width:frame.width,height:frame.height}
    };
  })()`)) as {
    readonly viewport: Electron.Rectangle;
    readonly screen: Electron.Rectangle;
  };
  const targetBounds = target.getBounds();
  const targetContentBounds = target.getContentBounds();
  const zoomFactor = target.webContents.getZoomFactor();
  const destination = {
    x: targetContentBounds.x + targetFrame.viewport.x * zoomFactor,
    y: targetContentBounds.y + targetFrame.viewport.y * zoomFactor,
    width: targetFrame.viewport.width * zoomFactor,
    height: targetFrame.viewport.height * zoomFactor,
  };
  target.show();
  source.hide();
  if (recordVideo) {
    const displaySource = await findDisplayCaptureSource(display.id);
    await startRecording(target, displaySource.id);
    // Chromium's macOS screen stream has a short startup gap before it reaches
    // steady cadence. Keep that gap in the lab pre-roll, not in the measured flight.
    await delay(350);
  } else {
    await delay(50);
  }
  await transition.startFlash(id);
  transition.animateTo(id, {
    frame: destination,
    backgroundColor: "rgb(17, 17, 17)",
    borderColor: "#ff00ff",
    borderWidth: 4,
    cornerRadius: 8,
    scaleFactor: zoomFactor,
    probeColor: "#ff00ff",
    traceSamples: true,
  });
  setTimeout(() => {
    transition.animateTo(id, {
      frame: destination,
      backgroundColor: "rgb(17, 17, 17)",
      borderColor: "#ff00ff",
      borderWidth: 4,
      cornerRadius: 8,
      scaleFactor: zoomFactor,
      probeColor: "#ff00ff",
      details: { appName: "T3 Code", windowTitle: "Deterministic source window" },
    });
  }, 120);
  await transition.waitForLanding(id);
  const trace = transition.trace(id);
  if (!trace) throw new Error("The native transition did not return a frame trace");
  const traceAnalysis = analyzeWindowCaptureAnimation(trace, trace.target, {
    expectFlash: true,
    ...(recordVideo ? {} : { frameBudgetMs: 1_000 / Math.max(60, display.displayFrequency || 60) }),
  });

  await target.webContents.executeJavaScript(`new Promise((resolve)=>{
    const slot=document.getElementById("slot");
    document.getElementById("snapshot").src=${JSON.stringify(thumbnail.toDataURL())};
    slot.dataset.visible="";
    requestAnimationFrame(()=>requestAnimationFrame(resolve));
  })`);
  if (recordVideo) {
    await target.webContents.executeJavaScript(`new Promise((resolve)=>{
      document.getElementById("handoff-marker").dataset.phase="native";
      requestAnimationFrame(()=>requestAnimationFrame(resolve));
    })`);
    await delay(100);
    await transition.complete(id);
    await target.webContents.executeJavaScript(`new Promise((resolve)=>{
      document.getElementById("handoff-marker").dataset.phase="dom";
      requestAnimationFrame(()=>requestAnimationFrame(resolve));
    })`);
    await delay(300);
    const recording = await stopRecording(target);
    await NodeFSP.writeFile(NodePath.join(outputDirectory, "motion.webm"), recording);
  } else {
    await transition.complete(id);
  }
  const overlayBounds = windowCaptureAnimationOverlayBounds(
    Electron.screen.getAllDisplays(),
    useWorkArea,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    displayBounds: display.bounds,
    overlayBounds,
    sourceBounds,
    targetWindowBounds: targetBounds,
    targetContentBounds,
    targetFrame,
    destination,
    trace,
    traceAnalysis,
  };
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(outputDirectory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  const finalScreenshot = await target.webContents.capturePage();
  await NodeFSP.writeFile(NodePath.join(outputDirectory, "final.png"), finalScreenshot.toPNG());
  await delay(650);
  target.destroy();
  source.destroy();
  Electron.app.quit();
  process.exitCode = traceAnalysis.passed ? 0 : 2;
}

void run().catch(async (error: unknown) => {
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(outputDirectory, "error.txt"),
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  Electron.app.exit(1);
});

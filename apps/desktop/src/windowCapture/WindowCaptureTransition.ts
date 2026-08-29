// @effect-diagnostics globalTimers:off -- The isolated animation window is driven by Chromium's animation clock and guarded by a native timeout.
import * as Electron from "electron";

import type { WindowCaptureAnimationTrace } from "./WindowCaptureAnimationAnalysis.ts";
import { windowCaptureSpring } from "./WindowCaptureSpring.ts";

const CAPTURE_TRANSITION_FLASH_DURATION_MS = 300;
const CAPTURE_TRANSITION_TIMEOUT_MS = 6_000;
const CAPTURE_TRANSITION_SOURCE_CORNER_RADIUS = 12;
const CAPTURE_TRANSITION_ACCESSORY_FADE_DURATION_MS = 125;

export type WindowCaptureAnimationDestination = {
  readonly frame: Electron.Rectangle;
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly borderWidth: number;
  readonly cornerRadius: number;
  readonly scaleFactor: number;
  readonly probeColor?: string | undefined;
  readonly traceSamples?: boolean | undefined;
  readonly details?:
    | {
        readonly appName: string;
        readonly windowTitle: string;
        readonly appIconDataUrl?: string | undefined;
      }
    | undefined;
};

type ActiveWindowCaptureTransition = {
  readonly id: string;
  readonly overlayBounds: Electron.Rectangle;
  readonly sourceFrame: Electron.Rectangle;
  readonly window: Electron.BrowserWindow;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  flight: Promise<WindowCaptureAnimationTrace | undefined> | undefined;
  trace: WindowCaptureAnimationTrace | undefined;
};

export function windowCaptureAnimationOverlayBounds(
  displays: ReadonlyArray<
    Pick<Electron.Display, "bounds"> & Partial<Pick<Electron.Display, "workArea">>
  >,
  useWorkArea = false,
): Electron.Rectangle {
  const firstDisplay = displays[0];
  const first = (useWorkArea ? firstDisplay?.workArea : undefined) ??
    firstDisplay?.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  let left = first.x;
  let top = first.y;
  let right = first.x + first.width;
  let bottom = first.y + first.height;
  for (const display of displays.slice(1)) {
    const bounds = (useWorkArea ? display.workArea : undefined) ?? display.bounds;
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function captureTransitionHtml({
  flash,
  overlayBounds,
  sourceBounds,
}: {
  readonly flash: boolean;
  readonly overlayBounds: Electron.Rectangle;
  readonly sourceBounds: Electron.Rectangle;
}): string {
  const source = {
    x: sourceBounds.x - overlayBounds.x,
    y: sourceBounds.y - overlayBounds.y,
    width: sourceBounds.width,
    height: sourceBounds.height,
  };
  const sourceJson = JSON.stringify(source);
  return `<!doctype html><title>T3 Code Window Capture Animation</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
#card{position:absolute;left:${source.x}px;top:${source.y}px;width:${source.width}px;height:${source.height}px;contain:strict;overflow:hidden;border-radius:${CAPTURE_TRANSITION_SOURCE_CORNER_RADIUS}px;background:#fff;box-shadow:0 24px 70px rgba(0,0,0,.24);transform:translate3d(0,0,0) scale(1);transform-origin:center;backface-visibility:hidden;will-change:transform}
#content{position:absolute;inset:0;overflow:hidden;border-radius:inherit;transform:translate3d(0,0,0) scale(1);transform-origin:center;backface-visibility:hidden;will-change:transform}
.snapshot{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:fill;transform:translate3d(0,0,0) scale(1);transform-origin:center;backface-visibility:hidden;will-change:transform}
#flash{position:absolute;inset:0;background:#fff;opacity:0;will-change:opacity;${flash ? "" : "display:none"}}
#details{--details-scale:1;position:absolute;inset-inline:0;bottom:0;display:flex;min-width:0;align-items:center;gap:calc(6px * var(--details-scale));padding:calc(24px * var(--details-scale)) calc(10px * var(--details-scale)) calc(8px * var(--details-scale));background:linear-gradient(to top,rgba(0,0,0,.85),rgba(0,0,0,.55),transparent);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;will-change:opacity}
#details:not([data-ready]){visibility:hidden}
#app-icon,#app-fallback{width:calc(28px * var(--details-scale));height:calc(28px * var(--details-scale));flex:none;border-radius:calc(6px * var(--details-scale))}
#app-icon{display:none;object-fit:cover}
#app-fallback{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.2);color:#fff;font-size:calc(10px * var(--details-scale));font-weight:500;text-transform:uppercase}
#details-copy{min-width:0;flex:1}
#app-name,#window-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:calc(14px * var(--details-scale))}
#app-name{color:#fff;font-size:calc(11px * var(--details-scale));font-weight:500}
#window-title{color:rgba(255,255,255,.7);font-size:calc(9px * var(--details-scale))}
#border{position:absolute;z-index:2;inset:0;box-sizing:border-box;border:0 solid transparent;border-radius:inherit;opacity:0;will-change:opacity}
#probe{position:absolute;z-index:10;inset:0;display:none;box-sizing:border-box;border:4px solid transparent;border-radius:inherit}
</style>
<div id="card"><div id="content"><img id="snapshot" class="snapshot"><div id="details"><img id="app-icon"><div id="app-fallback"></div><div id="details-copy"><div id="app-name"></div><div id="window-title"></div></div></div></div><div id="border"></div><div id="flash"></div><div id="probe"></div></div>
<script>
const source=${sourceJson};
const card=document.getElementById("card");
const content=document.getElementById("content");
const snapshot=document.getElementById("snapshot");
const flashLayer=document.getElementById("flash");
const detailsLayer=document.getElementById("details");
const appIcon=document.getElementById("app-icon");
const appFallback=document.getElementById("app-fallback");
const appName=document.getElementById("app-name");
const windowTitle=document.getElementById("window-title");
const borderLayer=document.getElementById("border");
const probe=document.getElementById("probe");
const applyDetails=(details)=>{
  if(!details) return;
  detailsLayer.dataset.ready="";
  appName.textContent=details.appName;
  windowTitle.textContent=details.windowTitle||"Captured window";
  appFallback.textContent=details.appName.slice(0,1);
  if(details.appIconDataUrl){
    appIcon.src=details.appIconDataUrl;
    appIcon.style.display="block";
    appFallback.style.display="none";
  }
};
window.updateCaptureDetails=applyDetails;
window.setCaptureSnapshot=async(src)=>{
  snapshot.src=src;
  await snapshot.decode();
};
let flashSequence=0;
let flashAnimation;
window.prepareCaptureFlash=()=>{
  if (!${flash}) return false;
  flashSequence+=1;
  flashAnimation?.cancel();
  flashAnimation=undefined;
  flashLayer.style.opacity=".96";
  return true;
};
window.startCaptureFlash=()=>{
  if (!window.prepareCaptureFlash()) return false;
  const sequence=flashSequence;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(sequence!==flashSequence) return;
    flashAnimation=flashLayer.animate([
      {offset:0,opacity:.96},
      {offset:.38,opacity:.96},
      {offset:.68,opacity:.28},
      {offset:1,opacity:0}
    ],{duration:${CAPTURE_TRANSITION_FLASH_DURATION_MS},fill:"forwards",easing:"cubic-bezier(.2,.8,.2,1)"});
  }));
  return true;
};
window.startCaptureTransition=async(destination)=>{
  const target=destination.frame;
  const borderWidth=Math.min(
    Math.max(0,destination.borderWidth),
    Math.max(0,(Math.min(target.width,target.height)-1)/2)
  );
  const contentTarget={
    width:Math.max(1,target.width-borderWidth*2),
    height:Math.max(1,target.height-borderWidth*2)
  };
  const sourceCenter={x:source.x+source.width/2,y:source.y+source.height/2};
  const targetCenter={x:target.x+target.width/2,y:target.y+target.height/2};
  const lerp=(from,to,progress)=>from+(to-from)*progress;
  const rectAt=(progress)=>({
    width:Math.max(1,lerp(source.width,target.width,progress)),
    height:Math.max(1,lerp(source.height,target.height,progress)),
    centerX:lerp(sourceCenter.x,targetCenter.x,progress),
    centerY:lerp(sourceCenter.y,targetCenter.y,progress)
  });
  const transformAt=(progress)=>{
    const {width,height,centerX,centerY}=rectAt(progress);
    return "translate3d("+(centerX-targetCenter.x)+"px,"+(centerY-targetCenter.y)+"px,0) scale("+(width/target.width)+","+(height/target.height)+")";
  };
  const contentTransformAt=(progress)=>{
    const width=lerp(target.width,contentTarget.width,progress);
    const height=lerp(target.height,contentTarget.height,progress);
    return "translate3d(0,0,0) scale("+(width/contentTarget.width)+","+(height/contentTarget.height)+")";
  };
  const imageWidth=Math.max(1,snapshot.naturalWidth||source.width);
  const imageHeight=Math.max(1,snapshot.naturalHeight||source.height);
  const coverScale=Math.max(contentTarget.width/imageWidth,contentTarget.height/imageHeight);
  const snapshotTargetScale={
    x:(imageWidth*coverScale)/contentTarget.width,
    y:(imageHeight*coverScale)/contentTarget.height
  };
  const snapshotScaleAt=(progress)=>({
    x:lerp(1,snapshotTargetScale.x,progress),
    y:lerp(1,snapshotTargetScale.y,progress)
  });
  const snapshotTransformAt=(progress)=>{
    const scale=snapshotScaleAt(progress);
    return "translate3d(0,0,0) scale("+scale.x+","+scale.y+")";
  };
  const linearEasing=(valueAt)=>"linear("+destination.spring.samples.map(({offset,progress})=>valueAt(progress)+" "+(offset*100)+"%").join(",")+")";
  card.style.left=target.x+"px";
  card.style.top=target.y+"px";
  card.style.width=target.width+"px";
  card.style.height=target.height+"px";
  card.style.borderRadius=destination.cornerRadius+"px";
  card.style.backgroundColor=destination.backgroundColor;
  content.style.inset=borderWidth+"px";
  content.style.borderRadius=Math.max(0,destination.cornerRadius-borderWidth)+"px";
  borderLayer.style.borderWidth=borderWidth+"px";
  borderLayer.style.borderColor=destination.borderColor;
  if(destination.probeColor){probe.style.display="block";probe.style.borderColor=destination.probeColor;}
  detailsLayer.style.setProperty("--details-scale",String(destination.scaleFactor));
  applyDetails(destination.details);
  const startedAt=performance.now();
  const samples=[];
  let sampleFrame=0;
  const sample=()=>{
    const frame=card.getBoundingClientRect();
    samples.push({
      elapsedMs:performance.now()-startedAt,
      animationTimeMs:Number(animation.currentTime||0),
      x:frame.x,
      y:frame.y,
      width:frame.width,
      height:frame.height,
      detailsOpacity:Number.parseFloat(getComputedStyle(detailsLayer).opacity),
      flashOpacity:Number.parseFloat(getComputedStyle(flashLayer).opacity)
    });
    sampleFrame=requestAnimationFrame(sample);
  };
  card.style.boxShadow="none";
  const springEasing=linearEasing((progress)=>progress);
  const snapshotEnd=snapshotScaleAt(1);
  const snapshotAxis=Math.abs(snapshotEnd.x-1)>Math.abs(snapshotEnd.y-1)?"x":"y";
  const snapshotDelta=snapshotEnd[snapshotAxis]-1;
  const snapshotEasing=Math.abs(snapshotDelta)<1e-6
    ? springEasing
    : linearEasing((progress)=>(snapshotScaleAt(progress)[snapshotAxis]-1)/snapshotDelta);
  const animation=card.animate([
    {transform:transformAt(0)},
    {transform:transformAt(1)}
  ],{duration:destination.spring.durationMs,fill:"forwards",easing:springEasing});
  const contentAnimation=content.animate([
    {transform:contentTransformAt(0)},
    {transform:contentTransformAt(1)}
  ],{duration:destination.spring.durationMs,fill:"forwards",easing:springEasing});
  const snapshotAnimation=snapshot.animate([
    {transform:snapshotTransformAt(0)},
    {transform:snapshotTransformAt(1)}
  ],{duration:destination.spring.durationMs,fill:"forwards",easing:snapshotEasing});
  const borderAnimation=borderLayer.animate([
    {opacity:0},
    {opacity:1}
  ],{duration:destination.spring.durationMs,fill:"forwards",easing:springEasing});
  const detailsAnimation=detailsLayer.animate([
    {opacity:0},
    {opacity:1}
  ],{
    delay:Math.max(0,destination.spring.response*1000-${CAPTURE_TRANSITION_ACCESSORY_FADE_DURATION_MS}),
    duration:${CAPTURE_TRANSITION_ACCESSORY_FADE_DURATION_MS},
    fill:"forwards",
    easing:"ease-in"
  });
  if(destination.traceSamples) sample();
  await Promise.all([
    animation.finished.catch(()=>undefined),
    contentAnimation.finished.catch(()=>undefined),
    snapshotAnimation.finished.catch(()=>undefined),
    borderAnimation.finished.catch(()=>undefined),
    detailsAnimation.finished.catch(()=>undefined)
  ]);
  if(destination.traceSamples){
    cancelAnimationFrame(sampleFrame);
    sample();
    cancelAnimationFrame(sampleFrame);
  }
  return {source,target,spring:destination.spring,samples};
};
</script>`;
}

export class WindowCaptureTransition {
  private active: ActiveWindowCaptureTransition | undefined;
  private readonly useWorkArea: boolean;

  constructor(useWorkArea = false) {
    this.useWorkArea = useWorkArea;
  }

  async begin(
    id: string,
    sourceBounds: Electron.Rectangle,
    thumbnail: Electron.NativeImage,
    flash: boolean,
    startFlash = true,
  ): Promise<void> {
    this.dispose();
    const requestedOverlayBounds = windowCaptureAnimationOverlayBounds(
      Electron.screen.getAllDisplays(),
      this.useWorkArea,
    );
    const window = new Electron.BrowserWindow({
      ...requestedOverlayBounds,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      focusable: false,
      frame: false,
      hasShadow: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      title: "T3 Code Window Capture Animation",
      transparent: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const overlayBounds = window.getBounds();
    window.setIgnoreMouseEvents(true);
    try {
      await window.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(captureTransitionHtml({ flash, overlayBounds, sourceBounds })),
      );
      if (window.isDestroyed()) return;
      await window.webContents.executeJavaScript(
        `window.setCaptureSnapshot(${JSON.stringify(thumbnail.toDataURL())})`,
      );
      if (flash && startFlash) {
        await window.webContents.executeJavaScript("window.prepareCaptureFlash()");
      }
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    if (window.isDestroyed()) return;
    const active: ActiveWindowCaptureTransition = {
      id,
      overlayBounds,
      sourceFrame: sourceBounds,
      window,
      closeTimer: undefined,
      flight: undefined,
      trace: undefined,
    };
    this.active = active;
    window.showInactive();
    if (flash && startFlash) await this.startFlash(id);
    active.closeTimer = setTimeout(() => {
      if (this.active === active) this.dispose();
    }, CAPTURE_TRANSITION_TIMEOUT_MS);
  }

  async startFlash(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id || active.window.isDestroyed()) return;
    await active.window.webContents.executeJavaScript("window.startCaptureFlash()").catch(() => {});
  }

  animateTo(id: string, destination: WindowCaptureAnimationDestination): void {
    const active = this.active;
    if (!active || active.id !== id || active.window.isDestroyed()) return;
    if (active.flight) {
      if (destination.details) {
        void active.window.webContents
          .executeJavaScript(`window.updateCaptureDetails(${JSON.stringify(destination.details)})`)
          .catch(() => undefined);
      }
      return;
    }
    const localFrame = {
      x: destination.frame.x - active.overlayBounds.x,
      y: destination.frame.y - active.overlayBounds.y,
      width: destination.frame.width,
      height: destination.frame.height,
    };
    const spring = windowCaptureSpring(active.sourceFrame, destination.frame);
    active.flight = Promise.resolve().then(async () => {
      if (active.window.isDestroyed() || this.active !== active) return;
      const result = (await active.window.webContents.executeJavaScript(
        `window.startCaptureTransition(${JSON.stringify({
          frame: localFrame,
          backgroundColor: destination.backgroundColor,
          borderColor: destination.borderColor,
          borderWidth: Math.max(0, destination.borderWidth),
          cornerRadius: Math.max(0, destination.cornerRadius),
          scaleFactor: Math.max(0.1, destination.scaleFactor),
          probeColor: destination.probeColor,
          traceSamples: destination.traceSamples,
          details: destination.details,
          spring,
        })}).catch((error)=>({captureTransitionError:String(error),stack:error&&error.stack}))`,
      )) as
        | WindowCaptureAnimationTrace
        | { readonly captureTransitionError: string; readonly stack?: string | undefined };
      if ("captureTransitionError" in result) {
        throw new Error(result.stack ?? result.captureTransitionError);
      }
      const trace = result;
      active.trace = trace;
      return trace;
    });
  }

  async complete(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id) return;
    await this.waitForLanding(id);
    if (this.active === active) this.dispose();
  }

  dismiss(id: string): void {
    if (this.active?.id === id) this.dispose();
  }

  async waitForLanding(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id) return;
    try {
      await active.flight;
    } catch (error) {
      if (active.window.isDestroyed() || this.active !== active) return;
      throw error;
    }
  }

  trace(id: string): WindowCaptureAnimationTrace | undefined {
    const active = this.active;
    return active?.id === id ? active.trace : undefined;
  }

  dispose(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    if (active.closeTimer) clearTimeout(active.closeTimer);
    if (!active.window.isDestroyed()) active.window.destroy();
  }
}

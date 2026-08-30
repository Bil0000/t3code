import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";

import * as Electron from "electron";

const DURATION_MS = 360;
const EASING = "cubic-bezier(.2,.8,.2,1)";
const TIMEOUT_MS = 6_000;
const MARGIN = 72;

type WindowCaptureAnimationDetails = {
  readonly appName: string;
  readonly windowTitle: string;
  readonly appIconDataUrl?: string | undefined;
};

export type WindowCaptureAnimationDestination = {
  readonly frame: Electron.Rectangle;
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly borderWidth: number;
  readonly cornerRadius: number;
  readonly scaleFactor: number;
  readonly details?: WindowCaptureAnimationDetails | undefined;
};

type ActiveTransition = {
  readonly id: string;
  readonly source: Electron.Rectangle;
  readonly window: Electron.BrowserWindow;
  bounds: Electron.Rectangle;
  details?: WindowCaptureAnimationDetails | undefined;
  timer?: Fiber.Fiber<void> | undefined;
  flight?: Promise<void> | undefined;
};

type WindowCaptureTransitionOptions = {
  readonly boundOverlayToFlight?: boolean | undefined;
  readonly useWorkArea?: boolean | undefined;
  readonly alwaysOnTopLevel?:
    | NonNullable<Parameters<Electron.BrowserWindow["setAlwaysOnTop"]>[1]>
    | undefined;
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

export function windowCaptureAnimationFlightBounds(
  source: Electron.Rectangle,
  target: Electron.Rectangle,
): Electron.Rectangle {
  const padding = MARGIN;
  const x = Math.floor(Math.min(source.x, target.x) - padding);
  const y = Math.floor(Math.min(source.y, target.y) - padding);
  return {
    x,
    y,
    width: Math.ceil(Math.max(source.x + source.width, target.x + target.width) + padding) - x,
    height: Math.ceil(Math.max(source.y + source.height, target.y + target.height) + padding) - y,
  };
}

function createWindow(
  bounds: Electron.Rectangle,
  alwaysOnTopLevel: WindowCaptureTransitionOptions["alwaysOnTopLevel"],
): Electron.BrowserWindow {
  const window = new Electron.BrowserWindow({
    ...bounds,
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
  if (alwaysOnTopLevel) window.setAlwaysOnTop(true, alwaysOnTopLevel);
  window.setIgnoreMouseEvents(true);
  return window;
}

function transitionHtml(
  sourceBounds: Electron.Rectangle,
  overlayBounds: Electron.Rectangle,
  flash: boolean,
): string {
  const source = {
    x: sourceBounds.x - overlayBounds.x,
    y: sourceBounds.y - overlayBounds.y,
    width: sourceBounds.width,
    height: sourceBounds.height,
  };
  return `<!doctype html><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
#card{position:absolute;left:${source.x}px;top:${source.y}px;width:${source.width}px;height:${source.height}px;contain:strict;overflow:hidden;border-radius:12px;background:#fff;box-shadow:0 24px 70px rgba(0,0,0,.24);transform-origin:center;will-change:transform}
#content{position:absolute;inset:0;overflow:hidden;border-radius:inherit;transform-origin:center;will-change:transform}
#snapshot{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;transform-origin:center;will-change:transform}
#flash{position:absolute;inset:0;background:#fff;opacity:0;${flash ? "" : "display:none"}}
#details{--scale:1;position:absolute;inset-inline:0;bottom:0;display:flex;align-items:center;gap:calc(6px * var(--scale));padding:calc(24px * var(--scale)) calc(10px * var(--scale)) calc(8px * var(--scale));background:linear-gradient(to top,rgba(0,0,0,.85),rgba(0,0,0,.55),transparent);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0}
#details:not([data-ready]){visibility:hidden}
#icon,#fallback{width:calc(28px * var(--scale));height:calc(28px * var(--scale));flex:none;border-radius:calc(6px * var(--scale))}
#icon{display:none;object-fit:cover}
#fallback{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.2);color:#fff;font-size:calc(10px * var(--scale));font-weight:500;text-transform:uppercase}
#copy{min-width:0;flex:1}#app,#title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:calc(14px * var(--scale))}
#app{color:#fff;font-size:calc(11px * var(--scale));font-weight:500}#title{color:rgba(255,255,255,.7);font-size:calc(9px * var(--scale))}
#border{position:absolute;z-index:2;inset:0;box-sizing:border-box;border:0 solid transparent;border-radius:inherit;opacity:0}
</style><div id="card"><div id="content"><img id="snapshot"><div id="details"><img id="icon"><div id="fallback"></div><div id="copy"><div id="app"></div><div id="title"></div></div></div></div><div id="border"></div><div id="flash"></div></div><script>
const source=${JSON.stringify(source)},card=document.getElementById("card"),content=document.getElementById("content"),snapshot=document.getElementById("snapshot"),details=document.getElementById("details"),border=document.getElementById("border");
window.setCaptureSnapshot=async src=>{snapshot.src=src;await snapshot.decode()};
window.rebaseCaptureSource=next=>{Object.assign(source,next);Object.assign(card.style,{left:source.x+"px",top:source.y+"px",width:source.width+"px",height:source.height+"px"})};
window.startCaptureFlash=()=>document.getElementById("flash").animate([{opacity:.14},{offset:.38,opacity:.14},{offset:.68,opacity:.04},{opacity:0}],{duration:300,fill:"forwards",easing:"${EASING}"});
const applyDetails=value=>{
  if(!value)return;
  details.dataset.ready="";
  document.getElementById("app").textContent=value.appName;
  document.getElementById("title").textContent=value.windowTitle||"Captured window";
  document.getElementById("fallback").textContent=value.appName.slice(0,1);
  if(value.appIconDataUrl){
    const icon=document.getElementById("icon");icon.src=value.appIconDataUrl;icon.style.display="block";document.getElementById("fallback").style.display="none";
  }
};
window.updateCaptureDetails=applyDetails;
window.startCaptureTransition=async destination=>{
  const target=destination.frame,borderWidth=Math.min(Math.max(0,destination.borderWidth),Math.max(0,(Math.min(target.width,target.height)-1)/2));
  const inner={width:Math.max(1,target.width-borderWidth*2),height:Math.max(1,target.height-borderWidth*2)};
  const sourceCenter={x:source.x+source.width/2,y:source.y+source.height/2},targetCenter={x:target.x+target.width/2,y:target.y+target.height/2};
  const initial="translate3d("+(sourceCenter.x-targetCenter.x)+"px,"+(sourceCenter.y-targetCenter.y)+"px,0) scale("+(source.width/target.width)+","+(source.height/target.height)+")";
  const imageWidth=Math.max(1,snapshot.naturalWidth||source.width),imageHeight=Math.max(1,snapshot.naturalHeight||source.height),cover=Math.max(inner.width/imageWidth,inner.height/imageHeight);
  Object.assign(card.style,{left:target.x+"px",top:target.y+"px",width:target.width+"px",height:target.height+"px",borderRadius:destination.cornerRadius+"px",backgroundColor:destination.backgroundColor,boxShadow:"none"});
  Object.assign(content.style,{inset:borderWidth+"px",borderRadius:Math.max(0,destination.cornerRadius-borderWidth)+"px"});
  Object.assign(border.style,{borderWidth:borderWidth+"px",borderColor:destination.borderColor});
  details.style.setProperty("--scale",String(destination.scaleFactor));
  applyDetails(destination.details);
  const options={duration:${DURATION_MS},fill:"forwards",easing:"${EASING}"};
  await Promise.all([
    card.animate([{transform:initial},{transform:"translate3d(0,0,0) scale(1)"}],options).finished.catch(()=>undefined),
    content.animate([{transform:"scale("+(target.width/inner.width)+","+(target.height/inner.height)+")"},{transform:"scale(1)"}],options).finished.catch(()=>undefined),
    snapshot.animate([{transform:"scale(1)"},{transform:"scale("+((imageWidth*cover)/inner.width)+","+((imageHeight*cover)/inner.height)+")"}],options).finished.catch(()=>undefined),
    border.animate([{opacity:0},{opacity:1}],options).finished.catch(()=>undefined),
    details.animate([{opacity:0},{opacity:1}],{delay:235,duration:125,fill:"forwards",easing:"ease-in"}).finished.catch(()=>undefined)
  ])
};
</script>`;
}

export class WindowCaptureTransition {
  private active: ActiveTransition | undefined;
  private readonly boundOverlayToFlight: boolean;
  private readonly useWorkArea: boolean;
  private readonly alwaysOnTopLevel: WindowCaptureTransitionOptions["alwaysOnTopLevel"];

  constructor(options: WindowCaptureTransitionOptions = {}) {
    this.boundOverlayToFlight = options.boundOverlayToFlight ?? false;
    this.useWorkArea = options.useWorkArea ?? false;
    this.alwaysOnTopLevel = options.alwaysOnTopLevel;
  }

  async begin(
    id: string,
    source: Electron.Rectangle,
    snapshotDataUrl: string,
    flash: boolean,
  ): Promise<void> {
    this.dispose();
    const requestedBounds = this.boundOverlayToFlight
      ? windowCaptureAnimationFlightBounds(source, source)
      : windowCaptureAnimationOverlayBounds(Electron.screen.getAllDisplays(), this.useWorkArea);
    const window = createWindow(requestedBounds, this.alwaysOnTopLevel);
    const active: ActiveTransition = {
      id,
      source,
      window,
      bounds: window.getBounds(),
    };
    active.timer = Effect.runFork(
      Effect.sleep(TIMEOUT_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (this.active === active) this.dispose();
          }),
        ),
      ),
    );
    this.active = active;
    try {
      await window.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(transitionHtml(source, active.bounds, flash)),
      );
      if (!window.isDestroyed()) {
        await window.webContents.executeJavaScript(
          `window.setCaptureSnapshot(${JSON.stringify(snapshotDataUrl)})`,
        );
      }
    } catch (error) {
      if (this.active === active) this.dispose();
      else if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    if (window.isDestroyed() || this.active !== active) return;
    window.showInactive();
    if (flash) {
      await window.webContents
        .executeJavaScript("window.startCaptureFlash()")
        .catch(() => undefined);
    }
  }

  animateTo(id: string, destination: WindowCaptureAnimationDestination): void {
    const active = this.active;
    if (!active || active.id !== id) return;
    if (destination.details) active.details = destination.details;
    if (active.flight) {
      if (destination.details && !active.window.isDestroyed()) {
        void active.window.webContents
          .executeJavaScript(
            "window.updateCaptureDetails(" + JSON.stringify(destination.details) + ")",
          )
          .catch(() => undefined);
      }
      return;
    }
    active.flight = this.runFlight(active, destination);
  }

  private async runFlight(
    active: ActiveTransition,
    destination: WindowCaptureAnimationDestination,
  ): Promise<void> {
    const window = active.window;
    let bounds = active.bounds;
    if (this.boundOverlayToFlight) {
      const requested = windowCaptureAnimationFlightBounds(active.source, destination.frame);
      if (
        requested.x !== bounds.x ||
        requested.y !== bounds.y ||
        requested.width !== bounds.width ||
        requested.height !== bounds.height
      ) {
        window.setBounds(requested, false);
        bounds = window.getBounds();
        active.bounds = bounds;
        await window.webContents.executeJavaScript(
          `window.rebaseCaptureSource(${JSON.stringify({
            x: active.source.x - bounds.x,
            y: active.source.y - bounds.y,
            width: active.source.width,
            height: active.source.height,
          })})`,
        );
      }
    }
    if (window.isDestroyed() || this.active !== active) return;
    await window.webContents.executeJavaScript(
      `window.startCaptureTransition(${JSON.stringify({
        ...destination,
        frame: {
          x: destination.frame.x - bounds.x,
          y: destination.frame.y - bounds.y,
          width: destination.frame.width,
          height: destination.frame.height,
        },
        borderWidth: Math.max(0, destination.borderWidth),
        cornerRadius: Math.max(0, destination.cornerRadius),
        scaleFactor: Math.max(0.1, destination.scaleFactor),
        details: active.details,
      })})`,
    );
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

  async complete(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id) return;
    await this.waitForLanding(id).catch(() => undefined);
    if (this.active === active) this.dispose();
  }

  dismiss(id: string): void {
    if (this.active?.id === id) this.dispose();
  }

  dispose(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    active.timer?.interruptUnsafe();
    if (!active.window.isDestroyed()) active.window.destroy();
  }
}

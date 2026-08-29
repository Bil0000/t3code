import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const desktopDirectory = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = NodePath.resolve(desktopDirectory, "..", "..");
const timestamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replace(/\.\d{3}Z$/, "Z");
const outputDirectory = NodePath.join(
  repoRoot,
  ".artifacts",
  "window-capture-animation",
  timestamp,
);
const bundleDirectory = NodePath.join(
  desktopDirectory,
  "node_modules",
  ".cache",
  "window-capture-animation",
  timestamp,
);
NodeFS.mkdirSync(outputDirectory, { recursive: true });
NodeFS.mkdirSync(bundleDirectory, { recursive: true });

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode ?? 1);
  }
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}

const pack = NodeChildProcess.spawnSync(
  "pnpm",
  [
    "exec",
    "vp",
    "pack",
    "src/windowCapture/WindowCaptureAnimationLab.ts",
    "--format",
    "cjs",
    "--out-dir",
    bundleDirectory,
    "--platform",
    "node",
    "--deps.never-bundle",
    "electron",
    "--no-clean",
    "--sourcemap",
  ],
  { cwd: desktopDirectory, encoding: "utf8" },
);
if (pack.status !== 0) {
  process.stderr.write(pack.stdout ?? "");
  process.stderr.write(pack.stderr ?? "");
  process.exit(pack.status ?? 1);
}

const rawVideoPath = NodePath.join(outputDirectory, "motion.webm");
const videoPath = NodePath.join(outputDirectory, "motion.mp4");

const entryPath = NodePath.join(bundleDirectory, "WindowCaptureAnimationLab.cjs");
const electronCommand = resolveElectronLaunchCommand([entryPath]);
const childEnvironment = {
  ...process.env,
  T3_WINDOW_CAPTURE_LAB_OUTPUT: outputDirectory,
  T3_WINDOW_CAPTURE_LAB_RECORD: process.argv.includes("--trace-only") ? "0" : "1",
};
delete childEnvironment.ELECTRON_RUN_AS_NODE;
const lab = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  cwd: desktopDirectory,
  env: childEnvironment,
  stdio: "inherit",
});
const labExit = await waitForExit(lab);

const reportPath = NodePath.join(outputDirectory, "report.json");
if (NodeFS.existsSync(reportPath)) {
  const report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
  process.stdout.write(`${JSON.stringify(report.traceAnalysis, null, 2)}\n`);
}
if (NodeFS.existsSync(reportPath) && NodeFS.existsSync(rawVideoPath)) {
  const normalizeVideo = NodeChildProcess.spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      rawVideoPath,
      "-vf",
      "fps=60",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      videoPath,
    ],
    { cwd: desktopDirectory, encoding: "utf8" },
  );
  process.stdout.write(normalizeVideo.stdout ?? "");
  process.stderr.write(normalizeVideo.stderr ?? "");
  if (normalizeVideo.status !== 0) process.exitCode = normalizeVideo.status ?? 1;
  const videoAnalysis = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(desktopDirectory, "scripts", "analyze-window-capture-animation-video.mjs"),
      videoPath,
      reportPath,
    ],
    { cwd: desktopDirectory, encoding: "utf8" },
  );
  process.stdout.write(videoAnalysis.stdout ?? "");
  process.stderr.write(videoAnalysis.stderr ?? "");
  if (videoAnalysis.status !== 0) process.exitCode = videoAnalysis.status ?? 1;
}
process.stdout.write(`[window-capture-animation-lab] ${outputDirectory}\n`);
if (labExit !== 0) process.exitCode = labExit;

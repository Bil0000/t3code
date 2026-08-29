import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [videoPath, reportPath] = process.argv.slice(2);
if (!videoPath || !reportPath) {
  throw new Error("Usage: analyze-window-capture-animation-video.mjs <video.mp4> <report.json>");
}

const report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
const probe = JSON.parse(
  NodeChildProcess.execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height,avg_frame_rate",
      "-of",
      "json",
      videoPath,
    ],
    { encoding: "utf8" },
  ),
);
const videoStream = probe.streams?.[0];
if (!videoStream) throw new Error("The lab recording has no video stream");
const [rateNumerator, rateDenominator] = String(videoStream.avg_frame_rate).split("/").map(Number);
const frameRate = rateDenominator > 0 ? rateNumerator / rateDenominator : 60;

const display = report.displayBounds;
const windowBounds = report.targetWindowBounds;
const cropScaleX = videoStream.width / display.width;
const cropScaleY = videoStream.height / display.height;
const crop = {
  x: Math.max(0, Math.round((windowBounds.x - display.x) * cropScaleX)),
  y: Math.max(0, Math.round((windowBounds.y - display.y) * cropScaleY)),
  width: Math.round(windowBounds.width * cropScaleX),
  height: Math.round(windowBounds.height * cropScaleY),
};
const frameWidth = Math.round(windowBounds.width);
const frameHeight = Math.round(windowBounds.height);
const frameSize = frameWidth * frameHeight * 3;
const decoder = NodeChildProcess.spawn(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    videoPath,
    "-vf",
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${frameWidth}:${frameHeight}:flags=neighbor,fps=60`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);

const detected = [];
let carry = Buffer.alloc(0);
let frameIndex = 0;
let lastNativeHandoffFrame;
let firstDomHandoffFrame;

function handoffPhase(frame) {
  let red = 0;
  let green = 0;
  for (let y = Math.max(0, frameHeight - 20); y < frameHeight; y += 1) {
    let offset = (y * frameWidth + Math.max(0, frameWidth - 20)) * 3;
    for (let x = Math.max(0, frameWidth - 20); x < frameWidth; x += 1, offset += 3) {
      const pixelRed = frame[offset];
      const pixelGreen = frame[offset + 1];
      const pixelBlue = frame[offset + 2];
      if (pixelRed > 180 && pixelGreen < 80 && pixelBlue < 80) red += 1;
      if (pixelGreen > 180 && pixelRed < 80 && pixelBlue < 80) green += 1;
    }
  }
  if (red >= 16) return "native";
  if (green >= 16) return "dom";
  return null;
}

function detectProbeOutline(frame) {
  let minX = frameWidth;
  let minY = frameHeight;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < frameHeight; y += 1) {
    let offset = y * frameWidth * 3;
    for (let x = 0; x < frameWidth; x += 1, offset += 3) {
      const red = frame[offset];
      const green = frame[offset + 1];
      const blue = frame[offset + 2];
      if (red < 180 || blue < 180 || green > 90 || red < green * 2.2 || blue < green * 2.2) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
    }
  }
  if (count < 60 || maxX < minX || maxY < minY) return null;
  return {
    frameIndex,
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    pixelCount: count,
  };
}

for await (const chunk of decoder.stdout) {
  carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
  while (carry.length >= frameSize) {
    const frame = carry.subarray(0, frameSize);
    const rectangle = detectProbeOutline(frame);
    if (rectangle) detected.push(rectangle);
    const phase = handoffPhase(frame);
    if (phase === "native") {
      lastNativeHandoffFrame = { frameIndex, pixels: Buffer.from(frame) };
    } else if (phase === "dom" && !firstDomHandoffFrame) {
      firstDomHandoffFrame = { frameIndex, pixels: Buffer.from(frame) };
    }
    carry = carry.subarray(frameSize);
    frameIndex += 1;
  }
}
const decoderExit = await new Promise((resolve) => decoder.once("exit", (code) => resolve(code)));
if (decoderExit !== 0) throw new Error(`ffmpeg frame decoder exited with ${decoderExit}`);

const sequences = [];
for (const rectangle of detected) {
  const current = sequences.at(-1);
  if (!current || rectangle.frameIndex > current.at(-1).frameIndex + 1) {
    sequences.push([rectangle]);
  } else {
    current.push(rectangle);
  }
}
const sequence = sequences.sort((left, right) => right.length - left.length)[0] ?? [];
if (sequence.length === 0) throw new Error("No magenta animation probe was detected in the video");

function rectangleError(left, right) {
  return Math.max(
    Math.abs(left.x - right.x),
    Math.abs(left.y - right.y),
    Math.abs(left.width - right.width),
    Math.abs(left.height - right.height),
  );
}

function center(rectangle) {
  return { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 };
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function springProgress(elapsedSeconds, response, dampingFraction) {
  if (elapsedSeconds <= 0) return 0;
  const angularFrequency = (2 * Math.PI) / response;
  const dampingComplement = Math.sqrt(1 - dampingFraction * dampingFraction);
  const dampedAngularFrequency = angularFrequency * dampingComplement;
  const decay = Math.exp(-dampingFraction * angularFrequency * elapsedSeconds);
  return (
    1 -
    decay *
      (Math.cos(dampedAngularFrequency * elapsedSeconds) +
        (dampingFraction / dampingComplement) * Math.sin(dampedAngularFrequency * elapsedSeconds))
  );
}

function expectedFrameTravelRatio(frameRate, spring) {
  if (!spring) return 0.22;
  // macOS screen capture can coalesce two compositor frames even when its
  // output stream is normalized to 60 Hz. Compare against that cadence.
  const intervalSeconds = 2 / frameRate;
  const durationSeconds = spring.durationMs / 1_000;
  const sampleStep = intervalSeconds / 20;
  let maximum = 0;
  for (let time = intervalSeconds; time <= durationSeconds; time += sampleStep) {
    maximum = Math.max(
      maximum,
      Math.abs(
        springProgress(time, spring.response, spring.dampingFraction) -
          springProgress(time - intervalSeconds, spring.response, spring.dampingFraction),
      ),
    );
  }
  return maximum + 0.03;
}

let lastMotionIndex = 0;
for (let index = 1; index < sequence.length; index += 1) {
  if (rectangleError(sequence[index - 1], sequence[index]) >= 0.75) lastMotionIndex = index;
}
const samples = sequence.slice(0, Math.min(sequence.length, lastMotionIndex + 3));
const target = {
  x: Math.round(report.destination.x - windowBounds.x),
  y: Math.round(report.destination.y - windowBounds.y),
  width: Math.round(report.destination.width),
  height: Math.round(report.destination.height),
};

function handoffPixelDifference(before, after, rectangle) {
  if (!before || !after) return null;
  const inset = Math.min(6, Math.floor(Math.min(rectangle.width, rectangle.height) / 8));
  const channelDifferences = [];
  let total = 0;
  let count = 0;
  for (let y = rectangle.y + inset; y < rectangle.y + rectangle.height - inset; y += 1) {
    for (let x = rectangle.x + inset; x < rectangle.x + rectangle.width - inset; x += 1) {
      const offset = (y * frameWidth + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(
          before.pixels[offset + channel] - after.pixels[offset + channel],
        );
        channelDifferences.push(difference);
        total += difference;
        count += 1;
      }
    }
  }
  channelDifferences.sort((left, right) => left - right);
  return {
    beforeFrame: before.frameIndex,
    afterFrame: after.frameIndex,
    meanChannelDifference: count === 0 ? 0 : total / count,
    p95ChannelDifference: channelDifferences[Math.floor(channelDifferences.length * 0.95)] ?? 0,
  };
}

const handoffPixelDifferenceResult = handoffPixelDifference(
  lastNativeHandoffFrame,
  firstDomHandoffFrame,
  target,
);
const source = samples[0];
const totalTravel = Math.max(
  1,
  Math.hypot(
    source.x - target.x,
    source.y - target.y,
    source.width - target.width,
    source.height - target.height,
  ),
);
const firstMotionSample = samples.find((sample) => rectangleError(sample, source) >= 2);
let largestFrameTravelRatio = 0;
let previousMotionSample = samples[0];
for (const sample of samples.slice(1)) {
  if (rectangleError(previousMotionSample, sample) < 0.75) continue;
  const elapsedFrames = Math.max(1, sample.frameIndex - previousMotionSample.frameIndex);
  largestFrameTravelRatio = Math.max(
    largestFrameTravelRatio,
    Math.hypot(
      previousMotionSample.x - sample.x,
      previousMotionSample.y - sample.y,
      previousMotionSample.width - sample.width,
      previousMotionSample.height - sample.height,
    ) /
      totalTravel /
      elapsedFrames,
  );
  previousMotionSample = sample;
}
const landingStart = samples.findIndex(
  (sample) => sample.width <= target.width * 1.08 && distance(center(sample), center(target)) <= 12,
);
const landingSamples = landingStart >= 0 ? samples.slice(landingStart) : [];
let landingMinScale = Number.POSITIVE_INFINITY;
let landingMinIndex = -1;
for (let index = 0; index < landingSamples.length; index += 1) {
  const scale = landingSamples[index].width / target.width;
  if (scale < landingMinScale) {
    landingMinScale = scale;
    landingMinIndex = index;
  }
}
const landingMaxScaleAfterMin = landingSamples
  .slice(Math.max(0, landingMinIndex + 1))
  .reduce((maximum, sample) => Math.max(maximum, sample.width / target.width), 0);
const finalRectErrorPx = rectangleError(samples.at(-1), target);
const settlingRectErrorPx = landingSamples
  .slice(-3)
  .reduce((maximum, sample) => Math.max(maximum, rectangleError(sample, target)), 0);
const firstMotionMs = firstMotionSample
  ? ((firstMotionSample.frameIndex - samples[0].frameIndex) / frameRate) * 1_000
  : null;
const allowedFrameTravelRatio = expectedFrameTravelRatio(frameRate, report.trace?.spring);
const issues = [];
if (samples.length < 8)
  issues.push("fewer than 8 independently captured motion frames were detected");
if (finalRectErrorPx > 2) {
  issues.push("the compositor handoff does not finish on the DOM attachment");
}
if (settlingRectErrorPx > 2) {
  issues.push("the compositor does not settle onto the DOM attachment before handoff");
}
if (landingMinScale > 0.995) {
  issues.push("the compositor recording does not contain the compression bounce");
}
if (landingMaxScaleAfterMin < Math.min(0.995, landingMinScale + 0.02)) {
  issues.push("the compositor recording does not contain the rebound");
}
if (!handoffPixelDifferenceResult) {
  issues.push("the native-to-DOM handoff markers were not detected");
} else if (
  handoffPixelDifferenceResult.meanChannelDifference > 4 ||
  handoffPixelDifferenceResult.p95ChannelDifference > 20
) {
  issues.push("the native card visibly changes when the DOM attachment takes over");
}

const analysis = {
  passed: issues.length === 0,
  issues,
  metrics: {
    detectedFrameCount: sequence.length,
    analyzedFrameCount: samples.length,
    captureFrameRate: frameRate,
    firstDetectedFrame: sequence[0].frameIndex,
    lastMotionFrame: samples.at(-1).frameIndex,
    firstMotionMs,
    finalRectErrorPx,
    settlingRectErrorPx,
    largestFrameTravelRatio,
    allowedFrameTravelRatio,
    landingMinScale,
    landingMaxScaleAfterMin,
    handoffPixelDifference: handoffPixelDifferenceResult,
  },
  source,
  target,
  samples,
};
const outputPath = NodePath.join(NodePath.dirname(reportPath), "video-analysis.json");
NodeFS.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));

const contactStart = Math.max(0, (sequence[0].frameIndex - 3) / frameRate);
const contactDuration = Math.min(
  1.2,
  (samples.at(-1).frameIndex - sequence[0].frameIndex + 8) / frameRate,
);
NodeChildProcess.spawnSync(
  "ffmpeg",
  [
    "-y",
    "-v",
    "error",
    "-ss",
    String(contactStart),
    "-t",
    String(contactDuration),
    "-i",
    videoPath,
    "-vf",
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},fps=30,scale=420:-1,tile=6x6:padding=2:margin=2`,
    "-frames:v",
    "1",
    NodePath.join(NodePath.dirname(reportPath), "contact-sheet.png"),
  ],
  { stdio: "inherit" },
);

process.stdout.write(
  `${JSON.stringify({ passed: analysis.passed, issues: analysis.issues, metrics: analysis.metrics }, null, 2)}\n`,
);
process.exitCode = analysis.passed ? 0 : 2;

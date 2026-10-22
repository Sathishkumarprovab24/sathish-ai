// Long-form video pipeline: one prompt -> script -> shots -> images -> narration -> animated MP4.
// Video models only generate short clips, so a long video is planned as many short shots
// that are rendered individually and joined together at the end.
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import ffmpegPath from "ffmpeg-static";

const SHOT_SECONDS = 9;
const MIN_SHOT_SECONDS = 5;
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 25;
// The free image endpoint rejects parallel anonymous requests (HTTP 402), so fetch one at a time
const IMAGE_CONCURRENCY = 1;
const IMAGE_RETRY_DELAYS_MS = [0, 5_000, 15_000];
const FALLBACK_GRADIENTS = [
  ["0x1e3a8a", "0x0f766e"],
  ["0x4c1d95", "0x1e40af"],
  ["0x7c2d12", "0x831843"],
  ["0x064e3b", "0x1e3a8a"],
];
const FONT_FILE ="C\\:/Windows/Fonts/arial.ttf";
const VIDEO_ROOT = path.join(process.cwd(), "uploads", "videos");

const jobs = new Map();

export function getVideoJob(jobId) {
  return jobs.get(jobId) || null;
}

export function hasActiveJob(owner) {
  return Array.from(jobs.values()).some(
    (job) => job.owner === owner && !["done", "error"].includes(job.status)
  );
}

export function startVideoJob({ openai, model, prompt, minutes, voice, owner, onDone }) {
  const id = randomUUID();
  const job = {
    id,
    owner,
    prompt,
    minutes,
    status: "planning",
    step: "Writing the script...",
    done: 0,
    total: 0,
    title: "",
    videoUrl: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  runPipeline(job, { openai, model, voice })
    .then(async () => {
      try {
        await onDone?.(job);
      } catch (err) {
        // The video itself is fine; only the follow-up step (e.g. saving to the library) failed
        console.error(`Video job ${id} onDone failed:`, err);
      }
    })
    .catch((err) => {
      console.error(`Video job ${id} failed:`, err);
      job.status = "error";
      job.error = err.message || "Video generation failed.";
    });

  return job;
}

async function runPipeline(job, { openai, model, voice }) {
  const dir = path.join(VIDEO_ROOT, job.id);
  await fs.promises.mkdir(dir, { recursive: true });

  const shotCount = Math.max(1, Math.round((job.minutes * 60) / SHOT_SECONDS));
  const plan = await planVideo(openai, model, job.prompt, shotCount);
  job.title = plan.title;
  job.total = plan.shots.length;

  // Images are fetched a few at a time; every shot shares the same style text and seed
  // so characters and look stay as consistent as an image model allows.
  job.status = "images";
  job.step = "Drawing scenes...";
  job.done = 0;
  const seed = Math.floor(Math.random() * 1_000_000);
  const images = new Array(plan.shots.length).fill(null);
  await runWithConcurrency(plan.shots, IMAGE_CONCURRENCY, async (shot, index) => {
    const imagePrompt = [plan.style, plan.characters, shot.visual].filter(Boolean).join(". ");
    images[index] = await fetchShotImage(imagePrompt, seed, path.join(dir, `shot_${pad(index)}.jpg`));
    job.done += 1;
  });

  job.status = "rendering";
  job.step = "Animating shots...";
  job.done = 0;
  const segments = [];
  for (let index = 0; index < plan.shots.length; index += 1) {
    const shot = plan.shots[index];
    const audioFile = voice ? await synthesizeSpeech(shot.narration, path.join(dir, `voice_${pad(index)}.wav`)) : null;
    const audioSeconds = audioFile ? wavDurationSeconds(audioFile) : 0;
    const duration = Math.max(MIN_SHOT_SECONDS, audioSeconds ? audioSeconds + 0.6 : SHOT_SECONDS);

    const captionFile = path.join(dir, `caption_${pad(index)}.txt`);
    await fs.promises.writeFile(captionFile, wrapText(shot.narration, 60), "utf8");

    const segmentFile = path.join(dir, `segment_${pad(index)}.mp4`);
    await renderSegment({ image: images[index], audio: audioFile, caption: captionFile, duration, output: segmentFile, index });
    segments.push(segmentFile);
    job.done += 1;
  }

  job.status = "joining";
  job.step = "Joining the final video...";
  const listFile = path.join(dir, "segments.txt");
  await fs.promises.writeFile(
    listFile,
    segments.map((file) => `file '${path.basename(file)}'`).join("\n"),
    "utf8"
  );
  await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", "segments.txt", "-c", "copy", "-movflags", "+faststart", "video.mp4"], dir);

  await cleanupIntermediates(dir);

  job.status = "done";
  job.step = "Your video is ready.";
  job.videoUrl = `/uploads/videos/${job.id}/video.mp4`;
}

async function planVideo(openai, model, prompt, shotCount) {
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.8,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a film director planning a narrated animated video. Reply with JSON only, shaped as " +
          '{"title": string, "style": string, "characters": string, "shots": [{"narration": string, "visual": string}]}. ' +
          "style: one sentence describing the visual style used for every shot (e.g. 3D Pixar-style animation, soft lighting). " +
          "characters: a fixed physical description of each recurring character, reused in every shot. " +
          `shots: exactly ${shotCount} items in story order with a clear beginning, middle and end. ` +
          "narration: 1-2 spoken sentences (15-25 words). visual: what the camera sees, concrete and specific, no text in the image.",
      },
      { role: "user", content: prompt },
    ],
  });

  let data;
  try {
    data = JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    throw new Error("The script writer returned an invalid plan. Please try again.");
  }

  const shots = (Array.isArray(data.shots) ? data.shots : [])
    .filter((shot) => shot && (shot.narration || shot.visual))
    .slice(0, shotCount)
    .map((shot) => ({
      narration: String(shot.narration || "").trim(),
      visual: String(shot.visual || shot.narration || "").trim(),
    }));

  if (shots.length === 0) {
    throw new Error("The script writer did not return any shots. Please try again.");
  }

  return {
    title: String(data.title || "Untitled video").trim(),
    style: String(data.style || "").trim(),
    characters: String(data.characters || "").trim(),
    shots,
  };
}

// Pollinations image endpoint. Works without a key for a handful of images, then answers 402;
// set POLLINATIONS_TOKEN in .env for reliable use. Returns null on failure so the shot
// falls back to a gradient background.
export async function fetchShotImage(prompt, seed, output, width = WIDTH, height = HEIGHT) {
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}` +
    `?width=${width}&height=${height}&seed=${seed}`;
  const headers = process.env.POLLINATIONS_TOKEN
    ? { Authorization: `Bearer ${process.env.POLLINATIONS_TOKEN}` }
    : {};

  for (let attempt = 1; attempt <= IMAGE_RETRY_DELAYS_MS.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, IMAGE_RETRY_DELAYS_MS[attempt - 1]));
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(90_000) });
      if (response.status === 402 && !process.env.POLLINATIONS_TOKEN) {
        console.warn("Image service needs POLLINATIONS_TOKEN (free quota used up); using a plain background.");
        return null;
      }
      const type = response.headers.get("content-type") || "";
      if (!response.ok || !type.startsWith("image/")) {
        throw new Error(`Image request failed (${response.status})`);
      }
      await fs.promises.writeFile(output, Buffer.from(await response.arrayBuffer()));
      return output;
    } catch (err) {
      console.warn(`Shot image attempt ${attempt} failed:`, err.message);
    }
  }
  return null;
}

// Uses the speech engine built into Windows, so narration needs no API key.
function synthesizeSpeech(text, output) {
  if (process.platform !== "win32" || !text) return Promise.resolve(null);

  const script =
    "Add-Type -AssemblyName System.Speech; " +
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
    "$s.SetOutputToWaveFile($env:TTS_OUT); $s.Speak($env:TTS_TEXT); $s.Dispose()";

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, TTS_OUT: output, TTS_TEXT: text },
      windowsHide: true,
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && fs.existsSync(output) ? output : null));
  });
}

function wavDurationSeconds(file) {
  try {
    const buffer = fs.readFileSync(file);
    const byteRate = buffer.readUInt32LE(28);
    // Find the "data" chunk instead of assuming a 44-byte header
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === "data") return byteRate ? size / byteRate : 0;
      offset += 8 + size;
    }
  } catch (err) {
    console.warn("Could not read narration length:", err.message);
  }
  return 0;
}

function renderSegment({ image, audio, caption, duration, output, index }) {
  const frames = Math.ceil(duration * FPS);
  const captionPath = caption.replace(/\\/g, "/").replace(/:/g, "\\:");
  const subtitle =
    `drawtext=fontfile='${FONT_FILE}':textfile='${captionPath}':fontcolor=white:fontsize=30:line_spacing=8:` +
    `box=1:boxcolor=black@0.55:boxborderw=16:x=(w-text_w)/2:y=h-text_h-48`;

  // Alternate zooming in and out so consecutive shots don't feel identical
  const zoom = index % 2 === 0 ? "min(zoom+0.0007,1.18)" : "if(eq(on,0),1.18,max(zoom-0.0007,1))";
  const motion =
    `scale=${WIDTH * 2}:-2,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`;

  const args = ["-y"];
  if (image) {
    args.push("-i", image);
  } else {
    const palette = FALLBACK_GRADIENTS[index % FALLBACK_GRADIENTS.length];
    args.push(
      "-f", "lavfi",
      "-i", `gradients=s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${duration}:c0=${palette[0]}:c1=${palette[1]}:speed=0.008`
    );
  }
  if (audio) {
    args.push("-i", audio);
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }

  const videoFilter = image ? `${motion},${subtitle},format=yuv420p` : `${subtitle},format=yuv420p`;
  args.push(
    "-filter_complex", `[0:v]${videoFilter}[v];[1:a]aresample=44100,apad[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", duration.toFixed(2),
    "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
    output
  );

  return runFfmpeg(args);
}

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", ...args], { cwd, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed: ${stderr.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

async function cleanupIntermediates(dir) {
  const files = await fs.promises.readdir(dir);
  await Promise.all(
    files
      .filter((file) => file !== "video.mp4")
      .map((file) => fs.promises.rm(path.join(dir, file), { force: true }))
  );
}

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function wrapText(text, maxChars) {
  const lines = [];
  let line = "";
  String(text).split(/\s+/).filter(Boolean).forEach((word) => {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  });
  if (line) lines.push(line);
  return lines.join("\n");
}

function pad(index) {
  return String(index).padStart(3, "0");
}

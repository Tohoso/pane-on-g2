import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WhisperProvider = "groq" | "faster-whisper" | "whisper.cpp" | "openai-cloud" | "mock" | "none";
export type TranscribePcm = (buffer: Buffer) => Promise<string>;

export class SttUnavailableError extends Error {
  readonly code = "STT_UNAVAILABLE";

  constructor(message = "No Whisper provider is available") {
    super(message);
    this.name = "SttUnavailableError";
  }
}

export async function transcribePcm(buffer: Buffer): Promise<string> {
  const provider = detectWhisperProvider();
  if (provider === "none") throw new SttUnavailableError();
  if (provider === "mock") return mockTranscribe(buffer);
  if (provider === "groq") return await transcribeWithGroq(buffer);

  const dir = await mkdtemp(join(tmpdir(), "pane-on-g2-stt-"));
  const wavPath = join(dir, "audio.wav");
  try {
    await writeFile(wavPath, pcmS16le16kMonoToWav(buffer));
    if (provider === "faster-whisper") return await transcribeWithFasterWhisper(wavPath);
    if (provider === "whisper.cpp") return await transcribeWithWhisperCpp(wavPath);
    return await transcribeWithOpenAiCloud(wavPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function detectWhisperProvider(): WhisperProvider {
  const forced = process.env.PANE_ON_G2_STT_PROVIDER as WhisperProvider | undefined;
  if (forced && ["groq", "faster-whisper", "whisper.cpp", "openai-cloud", "mock", "none"].includes(forced)) return forced;

  if (process.env.GROQ_API_KEY) return "groq";
  if (hasPythonModule("faster_whisper")) return "faster-whisper";
  if (findWhisperCppCommand() && findWhisperCppModel()) return "whisper.cpp";
  if (process.env.OPENAI_API_KEY) return "openai-cloud";
  return "none";
}

function mockTranscribe(buffer: Buffer): string {
  const durationSec = Math.max(buffer.length / (16_000 * 2), 0);
  return `(STT mock) recording ${durationSec.toFixed(1)}s / ${buffer.length} bytes`;
}

async function transcribeWithGroq(pcm: Buffer): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new SttUnavailableError("GROQ_API_KEY is not set");

  const wav = pcmS16le16kMonoToWav(pcm);
  const model = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";
  const form = new FormData();
  form.set("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.set("model", model);
  form.set("response_format", "verbose_json");
  form.set("language", process.env.GROQ_STT_LANGUAGE || "ja");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { "authorization": `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Groq STT failed: ${response.status} ${await response.text().catch(() => "")}`.trim());
  }
  const body = (await response.json()) as { text?: string };
  return (body.text || "").trim();
}

export function pcmS16le16kMonoToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(16_000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

function hasPythonModule(moduleName: string): boolean {
  try {
    execFileSync("python3", ["-c", `import ${moduleName}`], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

function commandExists(command: string): boolean {
  try {
    execFileSync("command", ["-v", command], { shell: true, stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function findWhisperCppCommand(): string | null {
  for (const command of ["whisper-cli", "whisper.cpp", "main"]) {
    if (commandExists(command)) return command;
  }
  return null;
}

function findWhisperCppModel(): string | null {
  const envPath = process.env.WHISPER_CPP_MODEL || process.env.WHISPER_MODEL_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  for (const candidate of [
    join(homedir(), "models/whisper/ggml-large-v3-turbo.bin"),
    join(homedir(), "models/ggml-large-v3-turbo.bin"),
    "/srv/pane-on-g2/models/whisper/ggml-large-v3-turbo.bin",
    "/srv/models/whisper/ggml-large-v3-turbo.bin",
    "/models/whisper/ggml-large-v3-turbo.bin",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function transcribeWithFasterWhisper(wavPath: string): Promise<string> {
  const model = process.env.WHISPER_MODEL || "large-v3-turbo";
  const script = [
    "import sys",
    "from faster_whisper import WhisperModel",
    `model = WhisperModel(${JSON.stringify(model)}, device='auto', compute_type='int8')`,
    "segments, _ = model.transcribe(sys.argv[1], language='ja', vad_filter=True)",
    "print(''.join(segment.text for segment in segments).strip())",
  ].join("\n");
  const { stdout } = await execFileAsync("python3", ["-c", script, wavPath], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function transcribeWithWhisperCpp(wavPath: string): Promise<string> {
  const command = findWhisperCppCommand();
  const model = findWhisperCppModel();
  if (!command || !model) throw new SttUnavailableError("whisper.cpp command or model missing");
  const { stdout } = await execFileAsync(command, ["-m", model, "-f", wavPath, "-l", "ja", "-nt", "-np"], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function transcribeWithOpenAiCloud(wavPath: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new SttUnavailableError("OPENAI_API_KEY is not set");
  const form = new FormData();
  form.set("model", process.env.OPENAI_STT_MODEL || "whisper-1");
  form.set("file", new Blob([await readFile(wavPath)], { type: "audio/wav" }), "audio.wav");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!response.ok) throw new Error(`OpenAI STT failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as { text?: string };
  return (body.text || "").trim();
}

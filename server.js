const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(cors());

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function stripVtt(vtt, withTimestamps) {
  const lines = String(vtt).replace(/\r/g, "").split("\n");
  const out = [];
  let last = "";

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (/^\d+$/.test(line)) continue;
    if (line.includes("-->")) {
      if (withTimestamps) out.push(`[${line}]`);
      continue;
    }

    const cleaned = line
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    if (!cleaned) continue;
    if (cleaned === last) continue;

    out.push(cleaned);
    last = cleaned;
  }

  return withTimestamps ? out.join("\n") : out.join(" ");
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "yt transcript api via yt-dlp" });
});

app.get("/api/transcript", async (req, res) => {
  const { url, lang = "", timestamps = "0" } = req.query;
  const withTimestamps = timestamps === "1";

  if (!url) {
    return res.status(400).json({ ok: false, error: "Missing url" });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytsub-"));
  const outputTemplate = path.join(tmpDir, "sub.%(ext)s");

  try {
    const langs = lang ? `${lang}.*,${lang}` : "ar.*,ar,en.*,en";
    const args = [
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", langs,
      "--sub-format", "vtt/best",
      "-o", outputTemplate,
      url
    ];

    await run("yt-dlp", args);

    const files = fs.readdirSync(tmpDir);
    const vttFile = files.find(f => f.endsWith(".vtt"));

    if (!vttFile) {
      return res.status(404).json({ ok: false, error: "No captions found" });
    }

    const fullPath = path.join(tmpDir, vttFile);
    const vtt = fs.readFileSync(fullPath, "utf8");
    const text = stripVtt(vtt, withTimestamps);

    if (!text.trim()) {
      return res.status(404).json({ ok: false, error: "Transcript is empty" });
    }

    return res.json({
      ok: true,
      count: text.split(withTimestamps ? "\n" : " ").filter(Boolean).length,
      text
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to fetch transcript"
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

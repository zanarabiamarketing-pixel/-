const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    return u.searchParams.get("v");
  } catch {
    return url;
  }
}

function decodeHtml(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractJsonObject(source, marker) {
  const startIndex = source.indexOf(marker);
  if (startIndex === -1) return null;

  const braceStart = source.indexOf("{", startIndex);
  if (braceStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(braceStart, i + 1);
      }
    }
  }

  return null;
}

function getPlayerResponseFromHtml(html) {
  const markers = [
    "var ytInitialPlayerResponse = ",
    "ytInitialPlayerResponse = ",
    'window["ytInitialPlayerResponse"] = '
  ];

  for (const marker of markers) {
    const raw = extractJsonObject(html, marker);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {}
  }

  return null;
}

function getCaptionTracks(playerResponse) {
  return playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
}

function parseJson3(data, withTimestamps = false) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const items = [];

  for (const ev of events) {
    if (!Array.isArray(ev?.segs)) continue;
    const text = ev.segs.map(s => s?.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const start = Number(ev.tStartMs || 0) / 1000;
    items.push(withTimestamps ? `[${formatTime(start)}] ${text}` : text);
  }

  return items;
}

function parseXmlTranscript(xml, withTimestamps = false) {
  const results = [];

  const textRegex = /<text[^>]*start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;

  while ((m = textRegex.exec(xml)) !== null) {
    const start = parseFloat(m[1] || "0");
    const text = decodeHtml(m[2].replace(/<[^>]+>/g, "").trim());
    if (text) results.push(withTimestamps ? `[${formatTime(start)}] ${text}` : text);
  }

  if (results.length) return results;

  const pRegex = /<p\b[^>]*t="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = pRegex.exec(xml)) !== null) {
    const start = Number(m[1] || "0") / 1000;
    const inner = m[2]
      .replace(/<s\b[^>]*>/g, "")
      .replace(/<\/s>/g, "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "");

    const text = decodeHtml(inner).replace(/\s+/g, " ").trim();
    if (text) results.push(withTimestamps ? `[${formatTime(start)}] ${text}` : text);
  }

  return results;
}

function formatTime(sec) {
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function pickTrack(tracks, lang) {
  if (!tracks.length) return null;

  if (lang) {
    const exactManual = tracks.find(t => t.languageCode === lang && !t.kind);
    const exactAny = tracks.find(t => t.languageCode === lang);
    if (exactManual) return exactManual;
    if (exactAny) return exactAny;
  }

  const manualArabic = tracks.find(t => (t.languageCode || "").startsWith("ar") && !t.kind);
  const anyArabic = tracks.find(t => (t.languageCode || "").startsWith("ar"));
  const manualEnglish = tracks.find(t => (t.languageCode || "").startsWith("en") && !t.kind);

  return manualArabic || anyArabic || manualEnglish || tracks[0];
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "yt transcript api" });
});

app.get("/api/transcript", async (req, res) => {
  try {
    const { url, lang = "", timestamps = "0" } = req.query;
    const withTimestamps = timestamps === "1";

    if (!url) {
      return res.status(400).json({ ok: false, error: "Missing url" });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ ok: false, error: "Invalid YouTube URL" });
    }

    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const html = await pageRes.text();
    const playerResponse = getPlayerResponseFromHtml(html);
    const tracks = getCaptionTracks(playerResponse);

    if (!tracks.length) {
      return res.status(404).json({ ok: false, error: "No captions found" });
    }

    const chosenTrack = pickTrack(tracks, lang);
    if (!chosenTrack?.baseUrl) {
      return res.status(404).json({ ok: false, error: "No valid caption track found" });
    }

    const json3Url = new URL(String(chosenTrack.baseUrl).replace(/\\u0026/g, "&"));
    json3Url.searchParams.set("fmt", "json3");

    let items = [];

    try {
      const jsonRes = await fetch(json3Url.toString(), {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const raw = await jsonRes.text();

      if (jsonRes.ok && raw.trim().startsWith("{")) {
        const data = JSON.parse(raw);
        items = parseJson3(data, withTimestamps);
      }
    } catch {}

    if (!items.length) {
      const xmlRes = await fetch(String(chosenTrack.baseUrl).replace(/\\u0026/g, "&"), {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const xml = await xmlRes.text();
      items = parseXmlTranscript(xml, withTimestamps);
    }

    if (!items.length) {
      return res.status(404).json({ ok: false, error: "Transcript is empty" });
    }

    return res.json({
      ok: true,
      videoId,
      language: chosenTrack.languageCode || "",
      count: items.length,
      text: withTimestamps ? items.join("\n") : items.join(" ")
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "Failed to fetch transcript" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

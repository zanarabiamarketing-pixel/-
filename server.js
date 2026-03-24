const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.replace("/", "");
    }
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

function extractCaptionTracks(html) {
  const match = html.match(/"captionTracks":(\[.*?\])/);
  if (!match) return [];

  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

function parseXmlTranscript(xml) {
  const results = [];
  const regex = /<text[^>]*start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;

  while ((m = regex.exec(xml)) !== null) {
    const start = parseFloat(m[1] || "0");
    const text = decodeHtml(m[2].replace(/<[^>]+>/g, "").trim());
    if (text) results.push({ start, text });
  }

  return results;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "yt transcript api" });
});

app.get("/api/transcript", async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: "Missing url" });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: "Invalid YouTube URL" });
    }

    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const html = await pageRes.text();
    const tracks = extractCaptionTracks(html);

    if (!tracks.length) {
      return res.status(404).json({ error: "No captions found" });
    }

    const captionUrl = String(tracks[0].baseUrl).replace(/\\u0026/g, "&");

    const capRes = await fetch(captionUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const xml = await capRes.text();
    const items = parseXmlTranscript(xml);

    if (!items.length) {
      return res.status(404).json({ error: "Transcript is empty" });
    }

    const text = items.map(x => x.text).join(" ");

    res.json({
      ok: true,
      videoId,
      count: items.length,
      text
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch transcript" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

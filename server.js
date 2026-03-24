const express = require('express');
const cors = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function extractVideoId(input) {
  if (!input) return null;

  // raw ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input);

    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.replace(/^\//, '').split('/')[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (url.searchParams.get('v')) {
      const id = url.searchParams.get('v');
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const shortsIndex = parts.indexOf('shorts');
    if (shortsIndex !== -1 && parts[shortsIndex + 1]) {
      const id = parts[shortsIndex + 1];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
  } catch (_) {
    return null;
  }

  return null;
}

function normalizeLanguage(lang) {
  if (!lang) return '';
  return String(lang).trim().toLowerCase();
}

function formatTime(seconds) {
  const total = Math.floor(Number(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function transcriptToText(items, includeTimestamps = false) {
  if (!includeTimestamps) {
    return items.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim();
  }

  return items
    .map(item => `[${formatTime(item.offset / 1000)}] ${item.text}`)
    .join('\n');
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'yt-transcript-api',
    endpoint: '/api/transcript?url=YOUTUBE_URL&lang=ar&timestamps=1'
  });
});

app.get('/api/transcript', async (req, res) => {
  try {
    const input = req.query.url || req.query.video || req.query.id;
    const language = normalizeLanguage(req.query.lang);
    const includeTimestamps = String(req.query.timestamps || '').trim() === '1';

    const videoId = extractVideoId(input);
    if (!videoId) {
      return res.status(400).json({
        ok: false,
        error: 'رابط الفيديو أو معرف الفيديو غير صحيح'
      });
    }

    let transcript;
    if (language) {
      transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: language });
    } else {
      transcript = await YoutubeTranscript.fetchTranscript(videoId);
    }

    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'لم يتم العثور على ترجمة لهذا الفيديو'
      });
    }

    const text = transcriptToText(transcript, includeTimestamps);

    return res.json({
      ok: true,
      videoId,
      language: language || 'auto',
      timestamps: includeTimestamps,
      count: transcript.length,
      text,
      transcript
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'حدث خطأ أثناء استخراج الترجمة';
    return res.status(500).json({
      ok: false,
      error: message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

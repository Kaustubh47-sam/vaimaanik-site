'use strict';

const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const pdfParse = require('pdf-parse');
const { rateLimit } = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.resolve(process.env.CERTIFICATE_DATA_DIR || path.join(ROOT_DIR, 'data', 'certificates'));
const ADMIN_TOKEN = process.env.CERT_ADMIN_TOKEN || '';

const MAX_ZIP_BYTES = 160 * 1024 * 1024;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_PDF_BYTES = 400 * 1024 * 1024;
const MAX_PDF_COUNT = 2500;
const COLLEGE_STOP_WORDS = new Set([
  'of', 'the', 'and', 'college', 'institute', 'institution', 'university',
  'technology', 'engineering', 'autonomous', 'campus'
]);
const NAME_PREFIXES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof']);

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ZIP_BYTES, files: 1 }
});

const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { detail: 'Too many verification attempts. Please wait a minute and try again.' }
});

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeUsn(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function isValidEventId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function safeTokenEqual(provided, expected) {
  const left = Buffer.from(String(provided || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function getBearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function getDownloadName(entryName) {
  const normalizedPath = String(entryName || '').replace(/\\/g, '/');
  const original = path.posix.basename(normalizedPath) || 'certificate.pdf';
  const safe = original.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe || 'certificate'}.pdf`;
}

async function readEventIndex(eventId) {
  const indexPath = path.join(DATA_DIR, 'indices', `${eventId}.json`);
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function evaluateRecord(record, nameTokens, usn, collegeTokens) {
  const words = new Set(record.words || []);
  const normalizedText = record.normalizedText || '';
  const usnPattern = usn.split('').map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]*');
  const usnRegex = new RegExp(`(?:^|[^a-z0-9])${usnPattern}(?:$|[^a-z0-9])`);
  if (!usnRegex.test(normalizedText)) return null;

  const matchedName = nameTokens.filter(token => words.has(token)).length;
  const nameCoverage = matchedName / nameTokens.length;
  if (nameCoverage < 1) return null;

  const matchedCollege = collegeTokens.filter(token => words.has(token)).length;
  const collegeCoverage = collegeTokens.length ? matchedCollege / collegeTokens.length : 0;
  const minimumCollegeCoverage = collegeTokens.length <= 2 ? 1 : 0.7;
  if (collegeCoverage < minimumCollegeCoverage) return null;

  return { record, score: nameCoverage * 0.55 + collegeCoverage * 0.45 };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'vaimaanik-certificate-portal' });
});

app.post('/api/admin/certificates/upload', archiveUpload.single('archive'), async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ detail: 'Organizer uploads are not configured. Set CERT_ADMIN_TOKEN on the server.' });
  }
  if (!safeTokenEqual(getBearerToken(req), ADMIN_TOKEN)) {
    return res.status(401).json({ detail: 'Organizer access key is incorrect.' });
  }

  const eventId = String(req.body.eventId || '').trim();
  const eventName = String(req.body.eventName || '').trim().slice(0, 160);
  if (!isValidEventId(eventId)) {
    return res.status(400).json({ detail: 'A valid event ID is required.' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ detail: 'Choose a ZIP archive to upload.' });
  }
  if (req.file.buffer.length < 4 || req.file.buffer[0] !== 0x50 || req.file.buffer[1] !== 0x4b) {
    return res.status(400).json({ detail: 'The uploaded file is not a valid ZIP archive.' });
  }

  const archiveId = crypto.randomUUID();
  const archiveDir = path.join(DATA_DIR, 'pdfs', eventId, archiveId);
  const indexDir = path.join(DATA_DIR, 'indices');
  let oldIndex = null;
  let archiveCreated = false;

  try {
    await fs.mkdir(archiveDir, { recursive: true });
    archiveCreated = true;
    await fs.mkdir(indexDir, { recursive: true });
    oldIndex = await readEventIndex(eventId);

    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    const pdfEntries = entries.filter(entry => !entry.isDirectory && /\.pdf$/i.test(entry.entryName));
    if (!pdfEntries.length) {
      throw Object.assign(new Error('No PDF files were found inside this ZIP archive.'), { statusCode: 422 });
    }
    if (pdfEntries.length > MAX_PDF_COUNT) {
      throw Object.assign(new Error(`The archive contains too many PDFs. The limit is ${MAX_PDF_COUNT}.`), { statusCode: 413 });
    }

    let totalPdfBytes = 0;
    let scannedPdfCount = 0;
    const records = [];

    for (const entry of pdfEntries) {
      const declaredSize = Number(entry.header && entry.header.size || 0);
      if (declaredSize > MAX_PDF_BYTES) {
        throw Object.assign(new Error(`A PDF exceeds the ${MAX_PDF_BYTES / (1024 * 1024)} MB per-file limit.`), { statusCode: 413 });
      }
      totalPdfBytes += declaredSize;
      if (totalPdfBytes > MAX_TOTAL_PDF_BYTES) {
        throw Object.assign(new Error('The uncompressed PDF total exceeds the archive processing limit.'), { statusCode: 413 });
      }

      const pdfBuffer = entry.getData();
      if (!pdfBuffer || !pdfBuffer.length) continue;
      const parsed = await pdfParse(pdfBuffer);
      const extractedText = String(parsed.text || '').replace(/\u0000/g, ' ').trim();
      const normalized = normalizeText(extractedText);
      if (normalized.length < 12) {
        scannedPdfCount += 1;
        continue;
      }

      const fileId = `${crypto.randomUUID()}.pdf`;
      await fs.writeFile(path.join(archiveDir, fileId), pdfBuffer, { flag: 'wx' });
      const downloadName = getDownloadName(entry.entryName);
      records.push({
        fileId,
        downloadName,
        words: [...new Set(normalized.split(/\s+/).filter(Boolean))],
        normalizedText: normalized
      });
    }

    if (!records.length) {
      throw Object.assign(new Error('No searchable PDF text was found. These files may be scanned images; run OCR on them and upload the searchable PDFs.'), { statusCode: 422 });
    }

    const index = {
      eventId,
      eventName,
      archiveId,
      uploadedAt: new Date().toISOString(),
      indexedPdfCount: records.length,
      scannedPdfCount,
      records
    };
    const indexPath = path.join(indexDir, `${eventId}.json`);
    const tempIndexPath = `${indexPath}.${archiveId}.tmp`;
    await fs.writeFile(tempIndexPath, JSON.stringify(index), { flag: 'wx' });
    await fs.rm(indexPath, { force: true });
    await fs.rename(tempIndexPath, indexPath);

    if (oldIndex && oldIndex.archiveId && oldIndex.archiveId !== archiveId) {
      await fs.rm(path.join(DATA_DIR, 'pdfs', eventId, oldIndex.archiveId), { recursive: true, force: true }).catch(() => {});
    }

    return res.json({
      ok: true,
      eventId,
      eventName,
      indexedPdfCount: records.length,
      scannedPdfCount,
      ignoredNonPdfCount: entries.filter(entry => !entry.isDirectory && !/\.pdf$/i.test(entry.entryName)).length
    });
  } catch (error) {
    if (archiveCreated) await fs.rm(archiveDir, { recursive: true, force: true }).catch(() => {});
    const status = Number(error.statusCode) || 400;
    return res.status(status).json({ detail: error.message || 'Unable to process the ZIP archive.' });
  }
});

app.post('/api/certificates/lookup', lookupLimiter, async (req, res) => {
  const eventId = String(req.body && req.body.eventId || '').trim();
  const name = String(req.body && req.body.name || '').trim();
  const usn = normalizeUsn(req.body && req.body.usn);
  const college = String(req.body && req.body.college || '').trim();

  if (!isValidEventId(eventId) || !name || !usn || !college) {
    return res.status(400).json({ detail: 'Enter your full name, USN and college name.' });
  }
  if (name.length > 120 || usn.length > 40 || college.length > 160) {
    return res.status(400).json({ detail: 'One or more verification fields are too long.' });
  }

  try {
    const index = await readEventIndex(eventId);
    if (!index || !Array.isArray(index.records) || !index.records.length) {
      return res.status(404).json({ detail: 'Certificates have not been uploaded for this event yet.' });
    }

    const nameTokens = normalizeText(name).split(/\s+/).filter(token => token && !NAME_PREFIXES.has(token));
    const collegeTokens = [...new Set(normalizeText(college).split(/\s+/).filter(token => token && !COLLEGE_STOP_WORDS.has(token)))];
    if (!nameTokens.length || !collegeTokens.length) {
      return res.status(400).json({ detail: 'Enter a more complete name and college name.' });
    }

    const matches = index.records
      .map(record => evaluateRecord(record, nameTokens, usn, collegeTokens))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (!matches.length) {
      return res.status(404).json({ detail: 'No certificate matched all three details for this event. Check the spelling and try again.' });
    }
    if (matches.length > 1 && Math.abs(matches[0].score - matches[1].score) < 0.0001) {
      return res.status(409).json({ detail: 'More than one certificate matched these details. Please contact the organisers so they can check the archive.' });
    }

    const record = matches[0].record;
    const pdfPath = path.join(DATA_DIR, 'pdfs', eventId, index.archiveId, record.fileId);
    const pdfBuffer = await fs.readFile(pdfPath);
    const asciiName = record.downloadName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'e-certificate.pdf';
    const encodedName = encodeURIComponent(record.downloadName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Content-Length': String(pdfBuffer.length),
      'Cache-Control': 'no-store'
    });
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error('Certificate lookup error:', error);
    return res.status(500).json({ detail: 'The certificate archive could not be searched. Please try again later.' });
  }
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ detail: error.code === 'LIMIT_FILE_SIZE' ? 'ZIP archive is larger than the 160 MB upload limit.' : error.message });
  }
  console.error('Unhandled server error:', error);
  return res.status(500).json({ detail: 'An unexpected server error occurred.' });
});

fs.mkdir(DATA_DIR, { recursive: true })
  .then(() => app.listen(PORT, () => {
    console.log(`VAIMAANIK Certificate Portal running at http://localhost:${PORT}`);
    if (!ADMIN_TOKEN) console.warn('CERT_ADMIN_TOKEN is not set: organizer ZIP uploads are disabled.');
    console.log(`Certificate archive directory: ${DATA_DIR}`);
  }))
  .catch(error => {
    console.error('Unable to create certificate data directory:', error);
    process.exit(1);
  });

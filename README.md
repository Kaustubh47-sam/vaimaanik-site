# VAIMAANIK 2026 — E-Certificate Portal

This bundle adds an event-specific certificate portal to the supplied `index.html` and includes the Node.js service required to upload ZIP archives and search the PDFs inside them.

## Visual Recall archive already installed

The supplied bundle is preloaded with the Visual Recall certificate archive. It contains **17 individual searchable PDFs** and an event index for `visualRecall`. Participants can use the Visual Recall E-CERTIFICATE button immediately after the complete bundle is deployed; you do not need to upload this ZIP again through Organizer access. The archive was checked against the included `Certificate_Index.csv`: all 17 participant rows match exactly one PDF using name, USN, and college.

The uploaded ZIP also contained `Certificate_Index.csv` and `README.txt`; these are reference files and are not treated as certificates.

## What it does

- The **E-CERTIFICATE** button on each event card opens the certificate portal inside the website.
- The selected event is carried into the portal automatically. A participant must enter **Full Name**, **USN**, and **College Name**.
- The lookup searches only the PDF archive uploaded for that event. It checks the USN, all name tokens, and the meaningful college-name keywords before returning a PDF download.
- An **Organizer access** panel lets an authorized organiser upload or replace the ZIP archive for the selected event.
- ZIPs may contain PDFs in nested folders. Non-PDF files are ignored.

## Requirements

- Node.js 18 or newer.
- A Node-capable hosting service or server with persistent disk storage. A static-only host such as GitHub Pages cannot run the upload/search API by itself.
- Each PDF must contain selectable/searchable text. Scanned image-only certificates are reported as skipped; run OCR on those PDFs before uploading. All 17 Visual Recall PDFs in this bundle contain extractable text.

## Run locally on Windows PowerShell

Open PowerShell in this folder and run:

```powershell
npm install
$env:CERT_ADMIN_TOKEN = "replace-this-with-a-long-random-secret"
$env:PORT = "3000"
npm start
```

Then open `http://localhost:3000`.

Keep the `CERT_ADMIN_TOKEN` private. It is entered in the Organizer access panel when uploading ZIP files. The token is checked by the server and is not stored in the page's local storage.

## Upload one event archive

1. Open the website and go to the relevant event card.
2. Click **E-CERTIFICATE**.
3. Expand **Organizer access · Upload certificate ZIP for this event**.
4. Enter the organizer access key, select that event's ZIP file, and upload it.
5. Repeat for each event. Uploading a new ZIP for an event replaces that event's previous archive.

The ZIP file can contain any number of folders, subject to the configured limits. PDF file names are not used for participant matching; PDF text is indexed.

## Matching rules

- USN is matched as an alphanumeric identifier, ignoring case, spaces, and punctuation.
- Every meaningful name token must be present in the PDF text.
- College matching requires the meaningful college-name keywords to be present (all keywords for one- or two-keyword names, at least 70% for longer names).
- The certificate must satisfy all three checks. A non-match does not reveal which field was incorrect.

These checks tolerate differences in letter case and common punctuation, but participants should enter the same registered spelling used on the certificate.

## Hosting and persistence

Deploy the complete folder as a Node.js app, not just `public/index.html`. Set `CERT_ADMIN_TOKEN` as a server environment variable. Set `CERTIFICATE_DATA_DIR` to a persistent disk path if the hosting platform uses ephemeral app storage. The website and `/api/...` routes should be served from the same origin; this avoids browser CORS configuration.

Example environment variables:

- `CERT_ADMIN_TOKEN`: required for ZIP uploads.
- `CERTIFICATE_DATA_DIR`: optional persistent path for indexed PDF files and event indexes.
- `PORT`: hosting platform's port (usually supplied automatically).

The server exposes `GET /api/health` for a basic health check.

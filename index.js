// index.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const { google } = require('googleapis');
const sharp = require('sharp');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

// === chống Google 429: retry 5 lần ===
async function fetchPdfWithRetry(url, headers, attempt = 1) {
  try {
    return await axios.get(url, {
      responseType: 'arraybuffer',
      headers,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  } catch (err) {
    if (err.response && err.response.status === 429 && attempt < 5) {
      const delay = 3000 + Math.floor(Math.random() * 3000);
      console.log(`⚠️ Google 429 — retry ${attempt}/5 after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return fetchPdfWithRetry(url, headers, attempt + 1);
    }
    throw err;
  }
}

// Convert PDF → PNG + trim
function convertPdfToPng(pdfPath, outPrefix) {
  return new Promise((resolve, reject) => {
    execFile('pdftoppm', ['-png', '-singlefile', '-r', '150', pdfPath, outPrefix], async (err) => {
      if (err) return reject(err);
      const pngPath = outPrefix + '.png';
      if (!fs.existsSync(pngPath)) return reject(new Error('PNG conversion failed'));

      try {
        const img = sharp(pngPath);
        const trimmedBuffer = await img.trim().toBuffer();
        await fs.promises.writeFile(pngPath, trimmedBuffer);
        resolve(pngPath);
      } catch (e) {
        reject(e);
      }
    });
  });
}

let telegramClient;

async function main() {
  try {
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
    const SHEET_NAMES = (process.env.SHEET_NAMES || 'Ladi,Mydu').split(',').map(s => s.trim()).filter(Boolean);
    const START_COL = process.env.START_COL || 'F';
    const END_COL = process.env.END_COL || 'AD';
    const MAX_ROWS_PER_FILE = Number(process.env.MAX_ROWS_PER_FILE || '40');
    const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID);
    const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
    const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    if (!serviceAccountJson || !SPREADSHEET_ID || !TELEGRAM_API_ID || !TELEGRAM_API_HASH || !TELEGRAM_SESSION || !TELEGRAM_CHAT_ID) {
      throw new Error('Missing required environment variables. Required: GOOGLE_SERVICE_ACCOUNT_JSON, SPREADSHEET_ID, TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, TELEGRAM_CHAT_ID');
    }

    // === Connect using the personal Telegram account (saved StringSession) ===
    telegramClient = new TelegramClient(
      new StringSession(TELEGRAM_SESSION),
      TELEGRAM_API_ID,
      TELEGRAM_API_HASH,
      { connectionRetries: 5 }
    );
    await telegramClient.connect();
    const telegramMe = await telegramClient.getMe(); // also verifies that the saved session is authorized
    console.log('✅ Telegram personal account connected:', telegramMe.username || telegramMe.firstName || 'authorized user');

    // Load dialogs so Telegram can resolve numeric group IDs from the existing TELEGRAM_CHAT_ID setting.
    await telegramClient.getDialogs({ limit: 500 });
    const chatRef = /^-?\\d+$/.test(String(TELEGRAM_CHAT_ID)) ? Number(TELEGRAM_CHAT_ID) : TELEGRAM_CHAT_ID;
    if (typeof chatRef === 'number' && !Number.isSafeInteger(chatRef)) {
      throw new Error('TELEGRAM_CHAT_ID is outside the safe integer range. Use the group username (for example @groupname) instead.');
    }
    const telegramChat = await telegramClient.getEntity(chatRef);
    console.log('📨 Telegram destination resolved');

    const creds = JSON.parse(serviceAccountJson);

    // === Authorize ===
    const jwtClient = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      ['https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/spreadsheets.readonly'],
      null
    );
    await jwtClient.authorize();
    const tokenObj = await jwtClient.getAccessToken();
    const accessToken = tokenObj?.token;
    if (!accessToken) throw new Error('Failed to obtain access token');

    const sheetsApi = google.sheets({ version: 'v4', auth: jwtClient });

    // === TMP DIR ===
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetpdf-'));

    // ============================
    //   ✅ GỌI METADATA 1 LẦN
    // ============================
    const metadata = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const allSheets = metadata.data.sheets || [];
    console.log(`📄 Loaded metadata for ${allSheets.length} sheets`);

    // ============================
    //   XỬ LÝ TỪNG SHEET
    // ============================
    for (const sheetName of SHEET_NAMES) {
      console.log('--- Processing sheet:', sheetName);

      // tìm sheetInfo từ metadata đã cache
      const sheetInfo = allSheets.find(s => s.properties?.title === sheetName);
      if (!sheetInfo) { console.log(`⚠️ Sheet "${sheetName}" not found — skipping`); continue; }
      const gid = sheetInfo.properties.sheetId;

      // Lấy F5:K6
      const rangeRes = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!F5:K6`
      });
      const values = rangeRes.data.values || [];
      const f5 = values[0]?.[0] || '';
      const j5 = values[0]?.[4] || '';
      const k5 = values[0]?.[5] || '';
      const k6 = values[1]?.[5] || '';
      if (!k6) { console.log(`⚠️ Sheet "${sheetName}" K6 trống — bỏ qua`); continue; }
      const captionText = `${f5}    ${j5}    ${k5}`;

      // Last row col K
      const colRes = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!K1:K2000`
      });
      const colVals = colRes.data.values || [];
      let lastRow = 1;
      for (let i = colVals.length - 1; i >= 0; i--) {
        if (colVals[i]?.[0]) { lastRow = i + 1; break; }
      }
      console.log('Last row detected (col K):', lastRow);
      
      // =================================================
      // ✅ ÉP EXPORT ĐỦ 15 DÒNG NẾU DỮ LIỆU <= 15
      // =================================================
      if (lastRow <= 15) {
        console.log(`📏 Sheet có ${lastRow} dòng → ép export đủ 15 dòng`);
        lastRow = 15;
      }
      
      // build chunks
      let chunks = [];
      let startRow = 1;
      while (startRow <= lastRow) {
        const endRow = Math.min(startRow + MAX_ROWS_PER_FILE - 1, lastRow);
        chunks.push({ startRow, endRow });
        startRow = endRow + 1;
      }
      if (chunks.length > 1) {
        const lastChunk = chunks[chunks.length - 1];
        const sz = lastChunk.endRow - lastChunk.startRow + 1;
        if (sz < 9) {
          chunks[chunks.length - 2].endRow = lastChunk.endRow;
          chunks.pop();
          console.log(`⚡ Gộp chunk cuối nhỏ (${sz} rows)`);
        }
      }

      // Export từng chunk
      const albumImages = [];

      for (const chunk of chunks) {
        const rangeParam = `${sheetName}!${START_COL}${chunk.startRow}:${END_COL}${chunk.endRow}`;
        const exportUrl =
          `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=pdf` +
          `&portrait=false&size=A4&fitw=true&sheetnames=false&printtitle=false&pagenumbers=false` +
          `&gridlines=false&fzr=false&gid=${gid}&range=${encodeURIComponent(rangeParam)}`;

        console.log(`➡ Export PDF for ${sheetName} rows ${chunk.startRow}-${chunk.endRow}`);
        const pdfResp = await fetchPdfWithRetry(exportUrl, { Authorization: `Bearer ${accessToken}` });

        const pdfName = `${sheetName}_${chunk.startRow}-${chunk.endRow}.pdf`;
        const pdfPath = path.join(tmpDir, pdfName);
        fs.writeFileSync(pdfPath, Buffer.from(pdfResp.data));

        const outPrefix = path.join(tmpDir, path.basename(pdfName, '.pdf'));
        const pngPath = await convertPdfToPng(pdfPath, outPrefix);

        // Delay chunk nhỏ
        const sz = chunk.endRow - chunk.startRow + 1;
        if (sz < MAX_ROWS_PER_FILE) {
          const extra = 500 + (MAX_ROWS_PER_FILE - sz) * 100;
          console.log(`⏱ Delay thêm ${extra}ms cho chunk nhỏ (${sz} rows)`);
          await new Promise(r => setTimeout(r, extra));
        }

        albumImages.push({
          path: pngPath,
          fileName: path.basename(pngPath)
        });
      }

      // SEND ALBUM through the personal Telegram account (MTProto)
      console.log(`📤 Sending ${albumImages.length} image(s) for sheet ${sheetName}`);
      // Telegram albums accept up to 10 media items per request.
      for (let i = 0; i < albumImages.length; i += 10) {
        const batch = albumImages.slice(i, i + 10);
        const files = batch.map(img => img.path);
        const caption = i === 0 ? captionText : '';
        const sent = await telegramClient.sendFile(telegramChat, {
          file: files.length === 1 ? files[0] : files,
          caption
        });
        console.log(`📸 Sent batch ${Math.floor(i / 10) + 1}: ${Array.isArray(sent) ? sent.length : 1} message(s)`);
      }

      // Cleanup
      albumImages.forEach(img => {
        try { fs.unlinkSync(img.path); } catch {}
        try {
          const pdfPath = path.join(tmpDir, img.fileName.replace('.png', '.pdf'));
          fs.unlinkSync(pdfPath);
        } catch {}
      });
    }

    // Cleanup temp folder
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('🎉 All sheets processed successfully');
  } catch (err) {
    console.error('ERROR:', err?.message || err);
    process.exitCode = 1;
  } finally {
    if (telegramClient) {
      try { await telegramClient.disconnect(); } catch (disconnectError) {
        console.warn('Telegram disconnect warning:', disconnectError?.message || disconnectError);
      }
    }
  }
}

main();

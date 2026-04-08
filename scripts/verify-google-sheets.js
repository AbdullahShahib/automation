#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function main() {
  const sheetId = (process.env.DEFAULT_SHEET_ID || '').trim();
  const credentialsPathRaw = (process.env.GOOGLE_CREDENTIALS_PATH || '').trim();

  if (!sheetId) {
    console.error('ERROR: DEFAULT_SHEET_ID is empty in .env');
    process.exit(1);
  }

  if (!credentialsPathRaw) {
    console.error('ERROR: GOOGLE_CREDENTIALS_PATH is empty in .env');
    process.exit(1);
  }

  const credentialsPath = path.isAbsolute(credentialsPathRaw)
    ? credentialsPathRaw
    : path.join(process.cwd(), credentialsPathRaw);

  if (!fs.existsSync(credentialsPath)) {
    console.error(`ERROR: Credentials file not found at: ${credentialsPath}`);
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const title = meta.data.properties?.title || '(unknown title)';
    const tabs = (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);

    console.log('OK: Google Sheets access verified.');
    console.log(`Sheet ID: ${sheetId}`);
    console.log(`Title: ${title}`);
    console.log(`Tabs: ${tabs.join(', ') || '(none found)'}`);
  } catch (e) {
    console.error('ERROR: Google Sheets API access failed.');
    console.error(e.message);
    process.exit(1);
  }
}

main();

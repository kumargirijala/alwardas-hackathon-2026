/*
 * Alwardas Hackathon 2026 - Google Sheets bridge
 *
 * Sheet ID and registration tab are already set for your form.
 * Set GOOGLE_SHEETS_TOKEN in your Node server to the same secret below.
 * Deploy as a Web App: Execute as you, access: Anyone with the link.
 * Keep the token private; do not put it in browser JavaScript.
 */
const SHEET_ID = '12Wwi3h8T0jb_2Q3HGMf1m6YIaXs0EQTyLX6QC_h3VNg';
const REGISTRATION_SHEET = 'Form Responses 1';
const RESPONSE_SHEET = 'Exam Responses';
const ACCESS_TOKEN = 'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET';

function authorized_(token) {
  return token && token === ACCESS_TOKEN;
}

function doGet(e) {
  const token = e && e.parameter ? e.parameter.token : '';
  const action = e && e.parameter ? e.parameter.action : '';
  if (!authorized_(token)) return json_({ ok: false, error: 'Unauthorized' });
  if (action !== 'students') return json_({ ok: false, error: 'Unknown action' });

  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(REGISTRATION_SHEET);
  if (!sh) return json_({ ok: false, error: 'Registration sheet not found' });
  const values = sh.getDataRange().getDisplayValues();
  if (!values.length) return json_({ students: [] });
  const headers = values.shift();
  const students = values
    .filter(r => r.some(v => String(v).trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
  return json_({ students });
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (_) {}
  if (!authorized_(body.token)) return json_({ ok: false, error: 'Unauthorized' });

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(RESPONSE_SHEET) || ss.insertSheet(RESPONSE_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Timestamp','Email','Name','Reg No','Round','Question ID','Selected Option','Saved At']);
  }
  sh.appendRow([
    new Date(), body.email || '', body.name || '', body.regNo || '',
    body.round || '', body.questionId || '', body.option || '', body.savedAt ? new Date(body.savedAt) : new Date()
  ]);
  return json_({ ok: true });
}

function json_(x) {
  return ContentService.createTextOutput(JSON.stringify(x)).setMimeType(ContentService.MimeType.JSON);
}

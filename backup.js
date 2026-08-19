// Daily CSV backup → S3.
// Reads data.sqlite directly (works whether or not the server is running),
// builds the same CSV format the UI export produces, uploads to S3.
require('dotenv').config();

const path = require('path');
const Database = require('better-sqlite3');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const DB_PATH = path.join(__dirname, 'data.sqlite');
const BUCKET = process.env.AWS_S3_BUCKET;
const REGION = process.env.AWS_REGION || 'eu-central-1';
const PREFIX = (process.env.AWS_S3_PREFIX || 'backups').replace(/\/+$/, '');

if (!BUCKET) {
  console.error('AWS_S3_BUCKET env var is required');
  process.exit(1);
}
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY env vars are required');
  process.exit(1);
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsv() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const accounts = db.prepare('SELECT name, currency FROM accounts').all();
  const currencyByAccount = Object.fromEntries(accounts.map(a => [a.name, a.currency]));
  const txs = db.prepare('SELECT * FROM transactions ORDER BY date DESC, id DESC').all();
  db.close();

  const header = 'account,date,description,category,amount,type,consolidated,currency,to_account';
  const rows = txs.map(tx => {
    const currency = currencyByAccount[tx.account] || 'EUR';
    return [
      csvEscape(tx.account),
      tx.date,
      csvEscape(tx.description),
      csvEscape(tx.category),
      tx.amount,
      tx.type,
      tx.consolidated,
      currency,
      csvEscape(tx.to_account || ''),
    ].join(',');
  });
  return { csv: header + '\n' + rows.join('\n') + '\n', count: txs.length };
}

async function main() {
  const { csv, count } = buildCsv();
  const date = new Date().toISOString().split('T')[0];
  const key = `${PREFIX}/money-tracker-${date}.csv`;

  const s3 = new S3Client({ region: REGION });
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: csv,
    ContentType: 'text/csv',
  }));

  console.log(`[${new Date().toISOString()}] Backup uploaded: s3://${BUCKET}/${key} (${count} transactions, ${csv.length} bytes)`);
}

main().catch(err => {
  console.error(`[${new Date().toISOString()}] Backup failed:`, err);
  process.exit(1);
});

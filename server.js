const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'data.sqlite');

// Init database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// Foreign keys off — accounts and transactions are loosely coupled

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    name TEXT PRIMARY KEY,
    currency TEXT NOT NULL DEFAULT 'EUR',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('expense', 'income', 'transfer')),
    consolidated TEXT NOT NULL DEFAULT 'no',
    to_account TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account);
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
`);

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'app')));

// ===== ACCOUNTS =====

app.get('/api/accounts', (req, res) => {
  const rows = db.prepare('SELECT * FROM accounts ORDER BY name').all();
  res.json(rows);
});

app.post('/api/accounts', (req, res) => {
  const { name, currency = 'EUR' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.prepare('INSERT OR REPLACE INTO accounts (name, currency) VALUES (?, ?)').run(name, currency);
  res.json({ ok: true });
});

app.put('/api/accounts/:name', (req, res) => {
  const oldName = req.params.name;
  const { name: newName, currency } = req.body;
  if (!newName || !currency) return res.status(400).json({ error: 'name and currency required' });

  const txn = db.transaction(() => {
    if (oldName !== newName) {
      // Insert new account first, move transactions, delete old
      db.prepare('INSERT OR IGNORE INTO accounts (name, currency) VALUES (?, ?)').run(newName, currency);
      db.prepare('UPDATE transactions SET account = ? WHERE account = ?').run(newName, oldName);
      db.prepare('DELETE FROM accounts WHERE name = ?').run(oldName);
      // Update currency in case it already existed
      db.prepare('UPDATE accounts SET currency = ? WHERE name = ?').run(currency, newName);
    } else {
      db.prepare('UPDATE accounts SET currency = ? WHERE name = ?').run(currency, oldName);
    }
  });
  txn();
  res.json({ ok: true });
});

app.delete('/api/accounts/:name', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE name = ?').run(req.params.name);
  res.json({ ok: true });
});

app.get('/api/accounts/balances', (req, res) => {
  // For transfers: amount is positive, subtract from source (account), add to dest (to_account)
  // For expense/income: amount is already signed correctly
  const rows = db.prepare(`
    SELECT name, SUM(bal) as balance FROM (
      SELECT account as name,
        CASE WHEN type = 'transfer' THEN -amount ELSE amount END as bal
      FROM transactions
      UNION ALL
      SELECT to_account as name, amount as bal
      FROM transactions
      WHERE type = 'transfer' AND to_account != ''
    ) GROUP BY name
  `).all();
  const balances = {};
  for (const r of rows) balances[r.name] = r.balance;
  res.json(balances);
});

// ===== TRANSACTIONS =====

app.get('/api/transactions', (req, res) => {
  const { account, type, limit = '50', offset = '0' } = req.query;
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];

  if (account) { sql += ' AND (account = ? OR to_account = ?)'; params.push(account, account); }
  if (type) { sql += ' AND type = ?'; params.push(type); }

  // Get total count
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);

  sql += ' ORDER BY date DESC, id DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const rows = db.prepare(sql).all(...params);
  res.json({ rows, total });
});

app.get('/api/transactions/all', (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date DESC, id DESC').all();
  res.json(rows);
});

app.get('/api/transactions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.post('/api/transactions', (req, res) => {
  const { account, date, description, category, amount, type, consolidated, to_account } = req.body;
  const result = db.prepare(
    'INSERT INTO transactions (account, date, description, category, amount, type, consolidated, to_account) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(account, date, description || '', category || '', amount, type, consolidated || 'no', to_account || '');
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/transactions/:id', (req, res) => {
  const { account, date, description, category, amount, type, consolidated, to_account } = req.body;
  db.prepare(
    'UPDATE transactions SET account=?, date=?, description=?, category=?, amount=?, type=?, consolidated=?, to_account=? WHERE id=?'
  ).run(account, date, description || '', category || '', amount, type, consolidated || 'no', to_account || '', Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/transactions/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ===== CATEGORIES =====

app.get('/api/categories', (req, res) => {
  const rows = db.prepare("SELECT DISTINCT category FROM transactions WHERE category != '' ORDER BY category").all();
  res.json(rows.map(r => r.category));
});

// ===== BULK IMPORT =====

app.post('/api/import', (req, res) => {
  const { transactions, currencyMap = {} } = req.body;

  const txn = db.transaction(() => {
    // Upsert accounts (including transfer destination accounts)
    const accountNames = new Set();
    for (const t of transactions) {
      if (t.account) accountNames.add(t.account);
      if (t.to_account) accountNames.add(t.to_account);
    }
    const upsertAcct = db.prepare(
      'INSERT INTO accounts (name, currency) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET currency = excluded.currency'
    );
    for (const name of accountNames) {
      upsertAcct.run(name, currencyMap[name] || 'EUR');
    }

    // Insert transactions
    const insertTx = db.prepare(
      'INSERT INTO transactions (account, date, description, category, amount, type, consolidated, to_account) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const t of transactions) {
      insertTx.run(t.account, t.date, t.description || '', t.category || '', t.amount, t.type, t.consolidated || 'no', t.to_account || '');
    }
  });

  txn();
  res.json({ imported: transactions.length });
});

// ===== CLEAR ALL =====

app.post('/api/clear', (req, res) => {
  db.exec('DELETE FROM transactions; DELETE FROM accounts;');
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Money Tracker running at http://localhost:${PORT}`);
});

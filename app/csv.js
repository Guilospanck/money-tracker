export function parseCSV(text) {
  const lines = [];
  let current = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field);
        field = '';
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        current.push(field);
        field = '';
        if (current.length > 1 || current[0] !== '') lines.push(current);
        current = [];
        if (ch === '\r') i++;
      } else {
        field += ch;
      }
    }
  }

  // Last field
  if (field || current.length > 0) {
    current.push(field);
    if (current.length > 1 || current[0] !== '') lines.push(current);
  }

  const headers = lines[0] || [];
  const rows = lines.slice(1);
  return { headers, rows };
}

export function mapToTransactions(headers, rows) {
  const iAccount = headers.indexOf('account');
  const iDate = headers.indexOf('date');
  const iDesc = headers.indexOf('description');
  const iCategory = headers.indexOf('category');
  const iAmount = headers.indexOf('amount');
  const iType = headers.indexOf('type');
  const iConsolidated = headers.indexOf('consolidated');
  const iCurrency = headers.indexOf('currency');
  const iToAccount = headers.indexOf('to_account');

  const transactions = [];

  for (const row of rows) {
    const amount = parseFloat(row[iAmount]);
    if (isNaN(amount)) continue;

    const tx = {
      account: row[iAccount] || '',
      date: row[iDate] || '',
      description: row[iDesc] || '',
      category: row[iCategory] || '',
      amount,
      type: row[iType] || 'expense',
      consolidated: row[iConsolidated] || 'no',
      to_account: (iToAccount >= 0 ? row[iToAccount] : '') || ''
    };

    // Attach currency if present (used by inferCurrencyMap, not stored on tx in DB)
    if (iCurrency >= 0 && row[iCurrency]) {
      tx.currency = row[iCurrency];
    }

    transactions.push(tx);
  }

  return transactions;
}

// Build currency map from imported transactions.
// Uses the 'currency' column if present, otherwise infers from account name.
export function inferCurrencyMap(transactions) {
  const map = {};

  // If transactions already have currency data (from CSV column), use it
  for (const tx of transactions) {
    if (tx.currency && tx.account && !map[tx.account]) {
      map[tx.account] = tx.currency;
    }
  }

  // For any accounts without explicit currency, infer from name.
  // Add regexes matching your own account names (e.g. /^MyBank/); unmatched falls back to EUR.
  const brlPatterns = [/BRL/i, /Real/i, /R\$/, /Poupança/];
  const eurPatterns = [/EUR/i, /Euro/i, /^€/];

  const names = [...new Set(transactions.flatMap(tx => [tx.account, tx.to_account]).filter(Boolean))];
  for (const name of names) {
    if (map[name]) continue;
    if (brlPatterns.some(p => p.test(name))) {
      map[name] = 'BRL';
    } else if (eurPatterns.some(p => p.test(name))) {
      map[name] = 'EUR';
    } else {
      map[name] = 'EUR';
    }
  }

  return map;
}

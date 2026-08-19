const API = '/api';

async function request(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function openDB() {
  // No-op — server handles DB init
}

export async function addTransaction(tx) {
  const { id } = await request('/transactions', { method: 'POST', body: tx });
  return id;
}

export async function updateTransaction(tx) {
  await request(`/transactions/${tx.id}`, { method: 'PUT', body: tx });
  return tx.id;
}

export async function getTransaction(id) {
  return request(`/transactions/${id}`);
}

export async function deleteTransaction(id) {
  await request(`/transactions/${id}`, { method: 'DELETE' });
}

export async function getAllTransactions(filter = {}) {
  const params = new URLSearchParams();
  if (filter.account) params.set('account', filter.account);
  if (filter.type) params.set('type', filter.type);
  params.set('limit', '100000'); // get all for now
  const { rows } = await request(`/transactions?${params}`);
  return rows;
}

export async function addAccount(name, currency = 'EUR') {
  await request('/accounts', { method: 'POST', body: { name, currency } });
}

export async function updateAccount(oldName, newName, currency) {
  await request(`/accounts/${encodeURIComponent(oldName)}`, {
    method: 'PUT',
    body: { name: newName, currency }
  });
}

export async function getAllAccounts() {
  return request('/accounts');
}

export async function deleteAccount(name) {
  await request(`/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function getCategories() {
  return request('/categories');
}

export async function bulkAddTransactions(txArray, currencyMap = {}) {
  const { imported } = await request('/import', {
    method: 'POST',
    body: { transactions: txArray, currencyMap }
  });
  return imported;
}

export async function getAccountBalances() {
  return request('/accounts/balances');
}

export async function clearAllData() {
  await request('/clear', { method: 'POST' });
}

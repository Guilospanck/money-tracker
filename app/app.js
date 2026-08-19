import {
  openDB, addTransaction, updateTransaction, getTransaction, deleteTransaction,
  getAllTransactions, addAccount, updateAccount, getAllAccounts, deleteAccount,
  getCategories, bulkAddTransactions, getAccountBalances, clearAllData
} from './db.js';
import { parseCSV, mapToTransactions, inferCurrencyMap } from './csv.js';

// ===== INIT =====
await openDB();

// ===== NAVIGATION =====
const navBtns = document.querySelectorAll('nav button[data-nav]');
const views = document.querySelectorAll('section[data-view]');

function navigate(view) {
  views.forEach(v => v.classList.toggle('active', v.dataset.view === view));
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.nav === view));

  if (view === 'transactions') loadTransactions();
  if (view === 'accounts') loadAccounts();
  if (view === 'add') loadAddForm();
}

navBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.nav === 'add') pendingResetAddForm = true;
    navigate(btn.dataset.nav);
  });
});
let pendingResetAddForm = false;

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

const CURRENCY_SYMBOLS = { EUR: '\u20ac', BRL: 'R$' };

function formatAmount(n, currency = 'EUR') {
  // Treat very small values as zero
  if (Math.abs(n) < 0.005) n = 0;
  const abs = Math.abs(n).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sym = CURRENCY_SYMBOLS[currency] || currency;
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}${sym} ${abs}`;
}

// Build a lookup from account name -> currency, refreshed when needed
let accountCurrencyMap = {};
async function refreshCurrencyMap() {
  const accounts = await getAllAccounts();
  accountCurrencyMap = {};
  for (const a of accounts) {
    accountCurrencyMap[a.name] = a.currency || 'EUR';
  }
}

// ===== TRANSACTIONS VIEW =====
const txList = document.getElementById('tx-list');
const filterAccount = document.getElementById('filter-account');
const filterType = document.getElementById('filter-type');
let txPage = 0;
const PAGE_SIZE = 50;
let pendingAccountFilter = null;

filterAccount.addEventListener('change', () => { txPage = 0; loadTransactions(); });
filterType.addEventListener('change', () => { txPage = 0; loadTransactions(); });

async function loadTransactions() {
  await refreshCurrencyMap();

  // Populate account filter dropdown
  const accounts = await getAllAccounts();
  const selectedAccount = pendingAccountFilter || filterAccount.value;
  pendingAccountFilter = null;
  filterAccount.innerHTML = '<option value="">All accounts</option>';
  accounts.sort((a, b) => a.name.localeCompare(b.name)).forEach(a => {
    const sym = CURRENCY_SYMBOLS[a.currency] || a.currency || '';
    filterAccount.innerHTML += `<option value="${esc(a.name)}">${esc(a.name)} (${sym})</option>`;
  });
  filterAccount.value = selectedAccount;

  // Build filter and fetch
  const filter = {};
  if (filterAccount.value) filter.account = filterAccount.value;
  if (filterType.value) filter.type = filterType.value;
  const allTx = await getAllTransactions(filter);

  const visible = allTx.slice(0, (txPage + 1) * PAGE_SIZE);
  const hasMore = allTx.length > visible.length;

  if (visible.length === 0) {
    txList.innerHTML = '<div class="empty">No transactions yet</div>';
    return;
  }

  const activeAccountFilter = filterAccount.value;

  let html = '';
  for (const tx of visible) {
    // For transfers, determine if we're viewing from source or destination perspective
    let displayAmount = tx.amount;
    let amountCls = tx.type === 'income' ? 'positive' : tx.type === 'transfer' ? 'transfer' : 'negative';
    let currency = accountCurrencyMap[tx.account] || 'EUR';

    if (tx.type === 'transfer') {
      if (activeAccountFilter && activeAccountFilter === tx.to_account) {
        // Viewing from destination: money coming in
        displayAmount = tx.amount;
        currency = accountCurrencyMap[tx.to_account] || 'EUR';
      } else {
        // Viewing from source or all: money going out
        displayAmount = -tx.amount;
      }
    }

    html += `
      <div class="tx-swipe-container" data-id="${tx.id}">
        <div class="tx-swipe-actions">
          <button class="tx-edit-btn">&#9998;<span>Edit</span></button>
          <button class="tx-delete-btn">&times;<span>Delete</span></button>
        </div>
        <div class="tx-item">
          <div class="tx-info">
            <div class="tx-desc">${esc(tx.description || '(no description)')}</div>
            <div class="tx-meta">${tx.date} &middot; <span class="tx-badge">${esc(tx.account)}</span>${tx.to_account ? ' &rarr; <span class="tx-badge">' + esc(tx.to_account) + '</span>' : ''}${tx.category ? ' &middot; ' + esc(tx.category) : ''}</div>
          </div>
          <div class="tx-amount ${amountCls}">${formatAmount(displayAmount, currency)}</div>
        </div>
      </div>`;
  }

  if (hasMore) {
    html += `<button class="load-more" id="load-more">Load more (${allTx.length - visible.length} remaining)</button>`;
  }

  txList.innerHTML = html;

  // Swipe-to-reveal setup
  initSwipeActionsOn(txList);

  // Action button handlers
  txList.querySelectorAll('.tx-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const container = btn.closest('.tx-swipe-container');
      const id = Number(container.dataset.id);
      if (confirm('Delete this transaction?')) {
        await deleteTransaction(id);
        container.remove();
        toast('Deleted');
      }
    });
  });

  txList.querySelectorAll('.tx-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.tx-swipe-container');
      const id = Number(container.dataset.id);
      // Close swipe first
      const item = container.querySelector('.tx-item');
      item.style.transform = '';
      editTransaction(id);
    });
  });

  // Load more
  const loadMoreBtn = document.getElementById('load-more');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => { txPage++; loadTransactions(); });
  }
}

// ===== ADD/EDIT TRANSACTION =====
const addForm = document.getElementById('add-form');
const addFormHeader = document.querySelector('[data-view="add"] header');
const addFormSubmitBtn = document.querySelector('#add-form .btn-primary');
const typeSelector = document.getElementById('type-selector');
const addAccountSelect = document.getElementById('add-account');
const addDate = document.getElementById('add-date');
const addDesc = document.getElementById('add-desc');
const addCategory = document.getElementById('add-category');
const addAmount = document.getElementById('add-amount');
const addToAccount = document.getElementById('add-to-account');
const toAccountGroup = document.getElementById('to-account-group');
const categoryList = document.getElementById('category-list');
let selectedType = 'expense';
let editingTxId = null; // null = add mode, number = edit mode

function updateTransferFields() {
  toAccountGroup.style.display = selectedType === 'transfer' ? '' : 'none';
  // Update label on account field
  document.querySelector('label[for="add-account"], #add-account').closest('.form-group').querySelector('label').textContent =
    selectedType === 'transfer' ? 'From Account' : 'Account';
}

// Type selector
typeSelector.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedType = btn.dataset.type;
    typeSelector.querySelectorAll('button').forEach(b => b.className = '');
    btn.className = `active-${selectedType}`;
    updateTransferFields();
  });
});
// Default
typeSelector.querySelector('[data-type="expense"]').className = 'active-expense';

async function loadAddForm() {
  if (pendingResetAddForm) {
    pendingResetAddForm = false;
    resetAddForm();
  }
  await refreshCurrencyMap();
  const accounts = await getAllAccounts();
  const currentVal = addAccountSelect.value;
  addAccountSelect.innerHTML = '';
  accounts.sort((a, b) => a.name.localeCompare(b.name)).forEach(a => {
    const sym = CURRENCY_SYMBOLS[a.currency] || a.currency || '';
    addAccountSelect.innerHTML += `<option value="${esc(a.name)}">${esc(a.name)} (${sym})</option>`;
  });
  if (currentVal) addAccountSelect.value = currentVal;

  // Populate to-account dropdown
  const currentToVal = addToAccount.value;
  addToAccount.innerHTML = '';
  accounts.sort((a, b) => a.name.localeCompare(b.name)).forEach(a => {
    const sym = CURRENCY_SYMBOLS[a.currency] || a.currency || '';
    addToAccount.innerHTML += `<option value="${esc(a.name)}">${esc(a.name)} (${sym})</option>`;
  });
  if (currentToVal) addToAccount.value = currentToVal;

  updateAmountLabel();
  updateTransferFields();

  // Set default date to today
  if (!addDate.value) {
    addDate.value = new Date().toISOString().split('T')[0];
  }

  // Populate categories datalist
  const cats = await getCategories();
  categoryList.innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
}

function updateAmountLabel() {
  const currency = accountCurrencyMap[addAccountSelect.value] || 'EUR';
  const sym = CURRENCY_SYMBOLS[currency] || currency;
  document.querySelector('#add-amount').placeholder = `0.00 ${sym}`;
}

addAccountSelect.addEventListener('change', updateAmountLabel);

// Only allow digits and one decimal separator
addAmount.addEventListener('input', () => {
  let v = addAmount.value.replace(/[^0-9.,]/g, '').replace(',', '.');
  // Keep only the first dot
  const parts = v.split('.');
  if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
  // Max 2 decimal places
  if (parts.length === 2 && parts[1].length > 2) v = parts[0] + '.' + parts[1].slice(0, 2);
  addAmount.value = v;
});

async function editTransaction(id) {
  const tx = await getTransaction(id);
  if (!tx) return;

  editingTxId = id;
  addFormHeader.textContent = 'Edit Transaction';
  addFormSubmitBtn.textContent = 'Save Changes';

  // Navigate to the form and populate
  navigate('add');

  // Set type
  selectedType = tx.type || 'expense';
  typeSelector.querySelectorAll('button').forEach(b => b.className = '');
  const typeBtn = typeSelector.querySelector(`[data-type="${selectedType}"]`);
  if (typeBtn) typeBtn.className = `active-${selectedType}`;

  // Set fields
  addAccountSelect.value = tx.account;
  addDate.value = tx.date;
  addDesc.value = tx.description || '';
  addCategory.value = tx.category || '';
  addAmount.value = Math.abs(tx.amount);
  if (tx.to_account) addToAccount.value = tx.to_account;
  updateAmountLabel();
  updateTransferFields();
}

function resetAddForm() {
  editingTxId = null;
  addFormHeader.textContent = 'Add Transaction';
  addFormSubmitBtn.textContent = 'Add Transaction';
  addDesc.value = '';
  addCategory.value = '';
  addAmount.value = '';
  addDate.value = new Date().toISOString().split('T')[0];
  selectedType = 'expense';
  typeSelector.querySelectorAll('button').forEach(b => b.className = '');
  typeSelector.querySelector('[data-type="expense"]').className = 'active-expense';
  updateTransferFields();
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  let amount = parseFloat(addAmount.value.replace(',', '.'));
  if (isNaN(amount) || amount === 0) return;

  // Make expenses negative
  if (selectedType === 'expense') amount = -Math.abs(amount);
  else amount = Math.abs(amount);

  // For transfers, amount is always positive (it's the transfer amount)
  if (selectedType === 'transfer') amount = Math.abs(amount);

  const txData = {
    account: addAccountSelect.value,
    date: addDate.value,
    description: addDesc.value,
    category: addCategory.value,
    amount,
    type: selectedType,
    consolidated: 'no',
    to_account: selectedType === 'transfer' ? addToAccount.value : ''
  };

  if (editingTxId !== null) {
    txData.id = editingTxId;
    // Preserve consolidated status from original
    const original = await getTransaction(editingTxId);
    if (original) txData.consolidated = original.consolidated;
    await updateTransaction(txData);
    toast('Transaction updated');
  } else {
    await addTransaction(txData);
    toast('Transaction added');
  }

  resetAddForm();
  navigate('transactions');
});

// ===== ACCOUNTS VIEW =====
const accountList = document.getElementById('account-list');
const newAccountName = document.getElementById('new-account-name');
const addAccountBtn = document.getElementById('add-account-btn');

const newAccountCurrency = document.getElementById('new-account-currency');

addAccountBtn.addEventListener('click', async () => {
  const name = newAccountName.value.trim();
  if (!name) return;
  await addAccount(name, newAccountCurrency.value);
  newAccountName.value = '';
  toast('Account added');
  loadAccounts();
});

async function loadAccounts() {
  const accounts = await getAllAccounts();
  const balances = await getAccountBalances();

  if (accounts.length === 0) {
    accountList.innerHTML = '<div class="empty">No accounts yet</div>';
    return;
  }

  accounts.sort((a, b) => a.name.localeCompare(b.name));

  accountList.innerHTML = accounts.map(a => {
    const bal = balances[a.name] || 0;
    const cls = bal > 0 ? 'positive' : bal < 0 ? 'negative' : '';
    const currency = a.currency || 'EUR';
    return `
      <div class="acct-swipe-container" data-account="${esc(a.name)}" data-currency="${currency}">
        <div class="tx-swipe-actions">
          <button class="tx-edit-btn acct-edit-btn">&#9998;<span>Edit</span></button>
          <button class="tx-delete-btn acct-delete-btn">&times;<span>Delete</span></button>
        </div>
        <div class="account-item">
          <div>
            <span class="acct-name">${esc(a.name)}</span>
            <span class="acct-currency">${currency}</span>
          </div>
          <span class="acct-balance ${cls}">${formatAmount(bal, currency)}</span>
        </div>
      </div>`;
  }).join('');

  // Swipe-to-reveal for accounts
  initSwipeActionsOn(accountList);

  // Click account row to view transactions
  accountList.querySelectorAll('.account-item').forEach(item => {
    item.addEventListener('click', () => {
      // Don't navigate if swipe is open
      if (currentlyOpenSwipe) return;
      const container = item.closest('.acct-swipe-container');
      pendingAccountFilter = container.dataset.account;
      txPage = 0;
      navigate('transactions');
    });
  });

  // Edit button opens modal
  accountList.querySelectorAll('.acct-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.acct-swipe-container');
      // Close swipe
      const item = container.querySelector('.account-item');
      item.style.transition = 'transform 0.25s ease';
      item.style.transform = '';
      container._swipeClose?.();
      openAccountEditModal(container.dataset.account, container.dataset.currency);
    });
  });

  // Delete button
  accountList.querySelectorAll('.acct-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const container = btn.closest('.acct-swipe-container');
      const name = container.dataset.account;
      if (!confirm(`Delete account "${name}"? Transactions will keep their account reference.`)) return;
      await deleteAccount(name);
      toast('Account deleted');
      loadAccounts();
    });
  });
}

// ===== ACCOUNT EDIT MODAL =====
const accountModal = document.getElementById('account-modal');
const editAccountName = document.getElementById('edit-account-name');
const editAccountCurrency = document.getElementById('edit-account-currency');
const editAccountSave = document.getElementById('edit-account-save');
const editAccountCancel = document.getElementById('edit-account-cancel');
let editingAccountOriginalName = null;

function openAccountEditModal(name, currency) {
  editingAccountOriginalName = name;
  editAccountName.value = name;
  editAccountCurrency.value = currency;
  accountModal.style.display = '';
}

function closeAccountEditModal() {
  accountModal.style.display = 'none';
  editingAccountOriginalName = null;
}

accountModal.addEventListener('click', (e) => {
  if (e.target === accountModal) closeAccountEditModal();
});

editAccountCancel.addEventListener('click', closeAccountEditModal);

editAccountSave.addEventListener('click', async () => {
  const newName = editAccountName.value.trim();
  if (!newName) return;
  await updateAccount(editingAccountOriginalName, newName, editAccountCurrency.value);
  closeAccountEditModal();
  toast('Account updated');
  loadAccounts();
});

// ===== IMPORT VIEW =====
const importArea = document.getElementById('import-area');
const importFile = document.getElementById('import-file');
const importStatus = document.getElementById('import-status');
const importBtn = document.getElementById('import-btn');
const exportBtn = document.getElementById('export-btn');
const clearBtn = document.getElementById('clear-btn');
let pendingImport = null;

importArea.addEventListener('click', () => importFile.click());

let pendingCurrencyMap = {};

importFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const { headers, rows } = parseCSV(ev.target.result);
    pendingImport = mapToTransactions(headers, rows);
    pendingCurrencyMap = inferCurrencyMap(pendingImport);
    importStatus.innerHTML = `<span class="count">${pendingImport.length}</span> transactions ready to import`;
    importBtn.style.display = 'block';
  };
  reader.readAsText(file);
});

importBtn.addEventListener('click', async () => {
  if (!pendingImport) return;
  importBtn.disabled = true;
  importBtn.textContent = 'Importing...';

  const count = await bulkAddTransactions(pendingImport, pendingCurrencyMap);
  toast(`Imported ${count} transactions`);
  pendingImport = null;
  importBtn.style.display = 'none';
  importBtn.disabled = false;
  importBtn.textContent = 'Import Data';
  importStatus.innerHTML = '';
  importFile.value = '';
});

exportBtn.addEventListener('click', async () => {
  await refreshCurrencyMap();
  const allTx = await getAllTransactions();
  const header = 'account,date,description,category,amount,type,consolidated,currency,to_account';
  const rows = allTx.map(tx => {
    const esc = (s) => {
      s = String(s);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const currency = accountCurrencyMap[tx.account] || 'EUR';
    return [esc(tx.account), tx.date, esc(tx.description), esc(tx.category), tx.amount, tx.type, tx.consolidated, currency, esc(tx.to_account || '')].join(',');
  });

  const csv = header + '\n' + rows.join('\n') + '\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `money-tracker-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported');
});

clearBtn.addEventListener('click', async () => {
  if (!confirm('Delete ALL data? This cannot be undone.')) return;
  if (!confirm('Are you really sure?')) return;
  await clearAllData();
  toast('All data cleared');
  loadTransactions();
});

// ===== UTILS =====
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ===== SWIPE TO REVEAL =====
let currentlyOpenSwipe = null;

function initSwipeActionsOn(parentEl) {
  const THRESHOLD = 60;
  const ACTION_WIDTH = 140;

  // Find all swipe containers (tx-swipe-container or acct-swipe-container)
  parentEl.querySelectorAll('[class$="-swipe-container"]').forEach(container => {
    // The slideable element is the first child that isn't the actions
    const item = container.querySelector('.tx-item, .account-item');
    if (!item) return;
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    let isOpen = false;

    function setTransform(x) {
      item.style.transform = `translateX(${x}px)`;
      item.style.transition = 'none';
    }

    function snapTo(x) {
      item.style.transition = 'transform 0.25s ease';
      item.style.transform = `translateX(${x}px)`;
    }

    function close() {
      snapTo(0);
      isOpen = false;
      if (currentlyOpenSwipe === container) currentlyOpenSwipe = null;
    }

    function open() {
      if (currentlyOpenSwipe && currentlyOpenSwipe !== container) {
        currentlyOpenSwipe._swipeClose?.();
      }
      snapTo(-ACTION_WIDTH);
      isOpen = true;
      currentlyOpenSwipe = container;
    }

    container._swipeClose = close;

    item.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      currentX = isOpen ? -ACTION_WIDTH : 0;
      isDragging = false;
    }, { passive: true });

    item.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - startX;
      if (Math.abs(dx) > 10) isDragging = true;
      if (!isDragging) return;
      let newX = currentX + dx;
      newX = Math.max(-ACTION_WIDTH - 20, Math.min(0, newX));
      setTransform(newX);
    }, { passive: true });

    item.addEventListener('touchend', (e) => {
      if (!isDragging) {
        if (isOpen) { close(); return; }
        return;
      }
      const dx = e.changedTouches[0].clientX - startX;
      if (isOpen) {
        if (dx > THRESHOLD) close(); else open();
      } else {
        if (dx < -THRESHOLD) open(); else close();
      }
    });

    item.addEventListener('click', () => {
      if (isOpen) close();
    });
  });
}

// Close open swipe when tapping outside
document.addEventListener('touchstart', (e) => {
  if (currentlyOpenSwipe && !currentlyOpenSwipe.contains(e.target)) {
    currentlyOpenSwipe._swipeClose?.();
    currentlyOpenSwipe = null;
  }
}, { passive: true });

// ===== SERVICE WORKER =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ===== INITIAL LOAD =====
loadTransactions();

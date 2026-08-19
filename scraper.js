const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // ===== LOGIN =====
  console.log("Logging in...");
  await page.goto("https://wwws.minhaseconomias.com.br/", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#email", { timeout: 30000 });
  await page.fill("#email", process.env.ME_EMAIL);
  await page.fill("#senha", process.env.ME_PASSWORD);
  await page.click('button[name="OK"]');
  // Wait until the login form is gone (post-login page rendered)
  await page.waitForFunction(() => !document.querySelector("#email"), {
    timeout: 30000,
  });
  // Then wait for the dashboard to fully load before issuing API calls
  await page.waitForLoadState("load");
  console.log("Logged in successfully.");

  // Helper: get a fresh clientid
  async function getClientId() {
    const res = await page.evaluate(async () => {
      const r = await fetch("/direct.do", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "init" }),
      });
      return r.json();
    });
    return res[0].clientid;
  }

  // Helper: queue + query API call
  let tidCounter = 100;
  async function apiCall(method, data = null) {
    const clientid = await getClientId();
    const tid = tidCounter++;

    // Queue
    await page.evaluate(
      async ({ tid, method, data, clientid }) => {
        await fetch("/direct.do", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([
            { tid, data, action: "queue", method, clientid },
          ]),
        });
      },
      { tid, method, data, clientid },
    );

    // Query - read as ArrayBuffer to handle iso-8859-1 charset properly
    const result = await page.evaluate(
      async ({ tid, clientid }) => {
        const r = await fetch("/direct.do", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: [tid], action: "query", clientid }),
        });
        const buf = await r.arrayBuffer();
        // Decode as latin1 (iso-8859-1) since the server uses that charset
        const text = new TextDecoder("iso-8859-1").decode(buf);
        return JSON.parse(text);
      },
      { tid, clientid },
    );

    return result[0]?.data;
  }

  // ===== LOAD ACCOUNTS =====
  console.log("\nLoading accounts...");
  const accounts = await apiCall("loadcontas");
  const accountMap = {};
  const accountCurrencyMap = {};
  // Currency is inferred from the account name. Add regexes matching your own
  // account names here (e.g. /^MyBank/) so they map to the right currency;
  // anything unmatched falls back to EUR in inferCurrency() below.
  const brlPatterns = [/BRL/i, /Real/i, /R\$/, /Poupança/];
  const eurPatterns = [/EUR/i, /Euro/i, /^€/];

  function inferCurrency(name) {
    if (brlPatterns.some((p) => p.test(name))) return "BRL";
    if (eurPatterns.some((p) => p.test(name))) return "EUR";
    return "EUR";
  }

  const activeAccountIds = new Set();
  const activeAccountNames = new Set();
  if (Array.isArray(accounts)) {
    accounts.forEach((a) => {
      accountMap[a.id] = a.nome; // Keep full map for name resolution
      const isActive = String(a.ativo) === "true";
      if (isActive) {
        activeAccountIds.add(String(a.id));
        activeAccountNames.add(a.nome);
        accountCurrencyMap[a.nome] = inferCurrency(a.nome);
      }
    });
    const activeAccounts = accounts.filter((a) => String(a.ativo) === "true");
    const inactiveAccounts = accounts.filter((a) => String(a.ativo) !== "true");
    console.log(
      `Found ${accounts.length} accounts (${activeAccounts.length} active, ${inactiveAccounts.length} inactive):`,
    );
    activeAccounts.forEach((a) =>
      console.log(
        `  - ${a.nome} (id: ${a.id}, currency: ${inferCurrency(a.nome)})`,
      ),
    );
    if (inactiveAccounts.length > 0) {
      console.log("  Skipping inactive accounts:");
      inactiveAccounts.forEach((a) =>
        console.log(`    - ${a.nome} (id: ${a.id})`),
      );
    }
  }

  // ===== LOAD CATEGORIES =====
  console.log("\nLoading categories...");
  const categories = await apiCall("loadcategorias");
  const categoryMap = {};
  if (Array.isArray(categories)) {
    categories.forEach((c) => {
      categoryMap[c.id] = c.text;
    });
    console.log(`Found ${categories.length} categories.`);
  }

  // ===== LOAD ALL TRANSACTIONS =====
  // Earliest year to pull transactions from. Override with ME_START_YEAR in .env.
  const startYear = Number(process.env.ME_START_YEAR) || 2020;

  // Generate initial balance transactions for accounts with valorInicial
  const initialBalanceTxs = [];
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      if (String(a.ativo) !== "true") continue;
      const valStr = (a.valorInicial || "0")
        .replace(/\./g, "")
        .replace(",", ".");
      const val = parseFloat(valStr);
      if (val !== 0) {
        initialBalanceTxs.push({
          contaId: a.id,
          dataTransacao: `01/01/${startYear}`,
          descricao: "Saldo inicial",
          categoriaId: null,
          valor: a.valorInicial,
          tipoTransacaoId: val > 0 ? "R" : "D",
          consolidada: true,
          _syntheticId: `initial-${a.id}`,
        });
        console.log(`  Initial balance for ${a.nome}: ${a.valorInicial}`);
      }
    }
  }
  const now = new Date();
  const endYear = now.getFullYear();
  const endMonth = now.getMonth() + 1;

  const allTransactions = [...initialBalanceTxs];
  const globalSeenIds = new Set(); // Dedup across all months
  console.log(
    `\nLoading transactions from ${startYear}-01 to ${endYear}-${String(endMonth).padStart(2, "0")}...`,
  );

  for (let year = startYear; year <= endYear; year++) {
    const mEnd = year === endYear ? endMonth : 12;

    for (let month = 1; month <= mEnd; month++) {
      const dataInicio = `01/${String(month).padStart(2, "0")}/${year}`;
      const lastDay = new Date(year, month, 0).getDate();
      const dataFim = `${lastDay}/${String(month).padStart(2, "0")}/${year}`;

      const data = await apiCall("transacaoCarregar", [
        { dataInicio, dataFim, contasAtivas: false },
      ]);

      if (data?.root) {
        // Filter: only positive IDs and only from active accounts
        const raw = data.root.filter(
          (t) => Number(t.id) > 0 && activeAccountIds.has(String(t.contaId)),
        );
        // Group transfer entries by id to find pairs
        const transferPairs = {};
        const txs = [];
        for (const t of raw) {
          if (t.tipoTransacaoId === "T") {
            if (!transferPairs[t.id]) transferPairs[t.id] = [];
            transferPairs[t.id].push(t);
          } else {
            // Non-transfer: dedup by global ID
            if (!globalSeenIds.has(t.id)) {
              globalSeenIds.add(t.id);
              txs.push(t);
            }
          }
        }
        // Process transfer pairs: source = account with negative amount, dest = account with positive amount
        for (const [id, entries] of Object.entries(transferPairs)) {
          const numId = Number(id);
          if (globalSeenIds.has(numId)) continue; // Already processed in another month
          globalSeenIds.add(numId);

          if (entries.length === 2) {
            const neg = entries.find(
              (e) =>
                parseFloat(e.valor.replace(/\./g, "").replace(",", ".")) < 0,
            );
            const pos = entries.find(
              (e) =>
                parseFloat(e.valor.replace(/\./g, "").replace(",", ".")) >= 0,
            );
            if (neg && pos) {
              // Source account is the negative entry's account, dest is the positive entry's account
              neg._toAccount =
                accountMap[pos.contaId] || accountMap[neg.contaDestinoId] || "";
              txs.push(neg);
            } else {
              // Fallback: push first entry
              entries[0]._toAccount =
                accountMap[entries[0].contaDestinoId] || "";
              txs.push(entries[0]);
            }
          } else if (entries.length === 1) {
            // Single entry — the other side was from an inactive account (filtered out)
            // Use contaDestinoId for destination name
            entries[0]._toAccount = accountMap[entries[0].contaDestinoId] || "";
            txs.push(entries[0]);
          } else {
            // 3+ entries with same ID (shouldn't happen) — take first
            entries[0]._toAccount = accountMap[entries[0].contaDestinoId] || "";
            txs.push(entries[0]);
          }
        }
        if (txs.length > 0) {
          allTransactions.push(...txs);
          process.stdout.write(
            `  ${year}-${String(month).padStart(2, "0")}: ${txs.length} transactions\n`,
          );
        }
      }
    }
  }

  console.log(`\nTotal transactions: ${allTransactions.length}`);

  // ===== MAP TYPES AND BUILD CSV =====
  const typeMap = { D: "expense", R: "income", T: "transfer" };

  const escape = (s) => {
    s = String(s);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const csvHeader =
    "account,date,description,category,amount,type,consolidated,currency,to_account";
  const csvRows = allTransactions.map((tx) => {
    const account = accountMap[tx.contaId] || `Unknown(${tx.contaId})`;
    const category = categoryMap[tx.categoriaId] || "";
    const type = typeMap[tx.tipoTransacaoId] || tx.tipoTransacaoId || "unknown";

    // Parse date from dd/mm/yy to yyyy-mm-dd
    let date = tx.dataTransacao;
    if (date) {
      const parts = date.split("/");
      if (parts.length === 3) {
        let y = parts[2];
        if (y.length === 2) y = "20" + y;
        date = `${y}-${parts[1]}-${parts[0]}`;
      }
    }

    // Parse value - Brazilian format: 1.234,56
    let amount = tx.valor || "0";
    amount = amount.replace(/\./g, "").replace(",", ".");

    // Expenses should be negative
    if (type === "expense" && parseFloat(amount) > 0) {
      amount = "-" + amount;
    }

    // For transfers, ensure amount is positive (it represents the transfer amount)
    if (type === "transfer") {
      amount = String(Math.abs(parseFloat(amount)));
    }

    const currency = accountCurrencyMap[account] || "EUR";
    // Only include to_account if it's an active account
    const toAccountName = tx._toAccount || "";
    const toAccount = activeAccountNames.has(toAccountName)
      ? toAccountName
      : "";

    return [
      escape(account),
      date,
      escape(tx.descricao || ""),
      escape(category),
      amount,
      type,
      tx.consolidada ? "yes" : "no",
      currency,
      escape(toAccount),
    ].join(",");
  });

  const csv = csvHeader + "\n" + csvRows.join("\n") + "\n";
  const outputPath = path.join(__dirname, "transactions.csv");
  fs.writeFileSync(outputPath, csv, "utf-8");
  console.log(`\nCSV exported to: ${outputPath}`);
  console.log(`Total rows: ${csvRows.length}`);

  // Show a sample
  console.log("\nSample (first 5 rows):");
  csvRows.slice(0, 5).forEach((r) => console.log(`  ${r}`));

  await browser.close();
})();

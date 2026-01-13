import React, { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar } from 'recharts';

// ======================
// SUPABASE SERVICE WITH DETAILED AUDIT
// ======================

const SupabaseService = {
  client: null,
  isConfigured: false,
  tableName: 'transactions',
  lastProcessingLog: [],

  init(url, anonKey, tableName = 'transactions') {
    if (!url || !anonKey) { this.isConfigured = false; return false; }
    this.client = {
      url: url.replace(/\/$/, ''),
      headers: { 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }
    };
    this.tableName = tableName;
    this.isConfigured = true;
    return true;
  },

  async getTransactions() {
    if (!this.isConfigured) throw new Error('Not configured');
    const url = `${this.client.url}/rest/v1/${this.tableName}?select=*&order=transaction_date.asc`;
    const response = await fetch(url, { method: 'GET', headers: this.client.headers });
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
    return await response.json();
  },

  processTransactions(rawTransactions) {
    this.lastProcessingLog = [];
    const log = (msg) => this.lastProcessingLog.push(msg);
    log(`=== START: ${rawTransactions.length} raw transactions ===`);
    
    const positionsMap = {};
    const trades = [];
    const fees = [];
    const dividends = [];
    const stats = { cash: 0, fees: 0, taxes: 0, dividends: 0, buys: 0, sells: 0, skipped: 0 };
    const skippedDetails = [];
    
    const sorted = [...rawTransactions].sort((a, b) => new Date(a.transaction_date) - new Date(b.transaction_date));
    
    sorted.forEach((tx, idx) => {
      const symbol = (tx.symbol || '').trim();
      const assetType = (tx.asset_type || '').toLowerCase().trim();
      const txType = (tx.transaction_type || '').toLowerCase().trim();
      const qty = parseFloat(tx.quantity) || 0;
      const price = parseFloat(tx.price_per_unit) || 0;
      const ccy = (tx.currency || 'EUR').toUpperCase();
      const date = tx.transaction_date;
      
      // CASH
      if (symbol.toLowerCase() === 'cash' || assetType === 'cash') { stats.cash++; return; }
      
      // FEES
      if (symbol.toLowerCase() === 'fee' || assetType === 'expense') {
        fees.push({ id: `fee-${idx}`, type: 'Transaction Fee', amount: Math.abs(price), currency: ccy, date });
        stats.fees++;
        log(`FEE: ${ccy} ${Math.abs(price).toFixed(2)} on ${date}`);
        return;
      }
      
      // TAX
      if (assetType === 'tax' || txType === 'withholding tax') {
        fees.push({ id: `tax-${idx}`, type: 'Withholding Tax', amount: Math.abs(price), currency: ccy, date, symbol });
        stats.taxes++;
        return;
      }
      
      // DIVIDENDS
      if (assetType === 'cash dividends' || assetType === 'dividend' || txType === 'cash dividends' || txType === 'dividend') {
        const cleanSym = symbol.split(':')[0];
        const amt = Math.abs(qty) < 0.0001 ? Math.abs(price) : Math.abs(price * qty);
        if (amt > 0.001) {
          dividends.push({ id: `div-${idx}`, symbol: cleanSym, fullSymbol: symbol, amount: amt, currency: ccy, date });
          log(`DIVIDEND: ${cleanSym} ${ccy} ${amt.toFixed(2)} on ${date}`);
        }
        stats.dividends++;
        return;
      }
      
      // TRADES
      const isTradeAsset = ['stock', 'etf', 'equity'].includes(assetType);
      const isTradeAction = ['buy', 'sell', 'transfer in', 'transfer out'].includes(txType);
      
      if ((isTradeAsset || isTradeAction) && Math.abs(qty) > 0.00001 && price > 0) {
        const cleanSym = symbol.split(':')[0];
        const exchange = symbol.includes(':') ? symbol.split(':')[1].toUpperCase() : '';
        
        // Determine buy/sell
        let isBuy;
        if (txType === 'sell' || txType === 'transfer out') isBuy = false;
        else if (txType === 'buy' || txType === 'transfer in') isBuy = true;
        else isBuy = qty > 0;
        
        const absQty = Math.abs(qty);
        const tradeType = isBuy ? 'buy' : 'sell';
        
        trades.push({
          id: `trade-${idx}`, symbol: cleanSym, fullSymbol: symbol, type: tradeType,
          shares: absQty, price, date, currency: ccy, exchange,
          _rawQty: qty, _rawTxType: tx.transaction_type, _rawAssetType: tx.asset_type
        });
        
        log(`TRADE: ${tradeType.toUpperCase()} ${cleanSym} ${absQty.toFixed(4)} @ ${ccy} ${price.toFixed(2)} on ${date}`);
        
        if (!positionsMap[cleanSym]) {
          positionsMap[cleanSym] = { symbol: cleanSym, fullSymbol: symbol, type: assetType === 'etf' ? 'ETF' : 'Stock',
            shares: 0, totalCost: 0, avgPrice: 0, currency: ccy, exchange, firstBuyDate: null };
        }
        
        const pos = positionsMap[cleanSym];
        if (isBuy) {
          pos.shares += absQty;
          pos.totalCost += absQty * price;
          pos.avgPrice = pos.shares > 0 ? pos.totalCost / pos.shares : 0;
          if (!pos.firstBuyDate) pos.firstBuyDate = date;
          stats.buys++;
        } else {
          const costSold = absQty * pos.avgPrice;
          pos.shares = Math.max(0, pos.shares - absQty);
          pos.totalCost = Math.max(0, pos.totalCost - costSold);
          stats.sells++;
        }
        return;
      }
      
      stats.skipped++;
      skippedDetails.push({ symbol, assetType: tx.asset_type, txType: tx.transaction_type, qty, price });
    });
    
    const openPositions = Object.values(positionsMap)
      .filter(p => p.shares > 0.00001)
      .map((p, i) => ({ id: i + 1, symbol: p.symbol, fullSymbol: p.fullSymbol, name: p.symbol, type: p.type,
        shares: p.shares, avgPrice: p.avgPrice, currentPrice: p.avgPrice, currency: p.currency, exchange: p.exchange }));
    
    log(`=== DONE: ${stats.buys} buys, ${stats.sells} sells, ${trades.length} total trades ===`);
    
    return { positions: openPositions, trades, fees, dividends, allPositions: positionsMap, stats, skippedDetails, processingLog: this.lastProcessingLog };
  }
};

// HELPERS
const COLORS = ['#6366f1', '#a855f7', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#14b8a6'];
const loadStorage = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
const saveStorage = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const EUR_RATE = { USD: 0.92, EUR: 1, GBP: 1.17 };
const toEUR = (amt, ccy) => ccy === 'EUR' ? amt : amt * (EUR_RATE[ccy] || 0.92);
const fmt = (v, c = 'EUR') => `${c === 'USD' ? '$' : '€'} ${Math.abs(v).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A';

// MAIN COMPONENT
export default function PortfolioDashboard() {
  const [positions, setPositions] = useState([]);
  const [trades, setTrades] = useState([]);
  const [fees, setFees] = useState([]);
  const [dividends, setDividends] = useState([]);
  const [rawTx, setRawTx] = useState([]);
  const [processingStats, setProcessingStats] = useState(null);
  const [processingLog, setProcessingLog] = useState([]);
  const [skippedDetails, setSkippedDetails] = useState([]);
  
  const [activeTab, setActiveTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [source, setSource] = useState('local');
  const [status, setStatus] = useState({ state: 'idle', msg: '' });
  
  const [showSettings, setShowSettings] = useState(false);
  const [sbUrl, setSbUrl] = useState(loadStorage('sb_url', ''));
  const [sbKey, setSbKey] = useState(loadStorage('sb_key', ''));
  const [sbTable, setSbTable] = useState(loadStorage('sb_table', 'transactions'));

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      if (sbUrl && sbKey && SupabaseService.init(sbUrl, sbKey, sbTable)) {
        try {
          const raw = await SupabaseService.getTransactions();
          if (raw?.length) {
            setRawTx(raw);
            const p = SupabaseService.processTransactions(raw);
            setPositions(p.positions); setTrades(p.trades); setFees(p.fees); setDividends(p.dividends);
            setProcessingStats(p.stats); setProcessingLog(p.processingLog); setSkippedDetails(p.skippedDetails);
            setSource('supabase'); setLastUpdate(new Date());
          }
        } catch (e) { console.error(e); }
      }
      setLoading(false);
    };
    load();
  }, [sbUrl, sbKey, sbTable]);

  const sync = async () => {
    if (!SupabaseService.isConfigured) return setStatus({ state: 'error', msg: 'Not configured' });
    setStatus({ state: 'loading', msg: 'Loading...' });
    try {
      const raw = await SupabaseService.getTransactions();
      if (raw?.length) {
        setRawTx(raw);
        const p = SupabaseService.processTransactions(raw);
        setPositions(p.positions); setTrades(p.trades); setFees(p.fees); setDividends(p.dividends);
        setProcessingStats(p.stats); setProcessingLog(p.processingLog); setSkippedDetails(p.skippedDetails);
        setSource('supabase'); setLastUpdate(new Date());
        setStatus({ state: 'success', msg: `✓ ${raw.length} tx → ${p.stats.buys} buys, ${p.stats.sells} sells, ${p.dividends.length} divs` });
      }
    } catch (e) { setStatus({ state: 'error', msg: e.message }); }
    setTimeout(() => setStatus({ state: 'idle', msg: '' }), 8000);
  };

  const saveSettings = () => {
    saveStorage('sb_url', sbUrl); saveStorage('sb_key', sbKey); saveStorage('sb_table', sbTable);
    if (sbUrl && sbKey) { SupabaseService.init(sbUrl, sbKey, sbTable); sync(); }
    setShowSettings(false);
  };

  const totalFees = useMemo(() => fees.reduce((s, f) => s + toEUR(f.amount, f.currency), 0), [fees]);
  const totalDivs = useMemo(() => dividends.reduce((s, d) => s + toEUR(d.amount, d.currency), 0), [dividends]);
  
  const metrics = useMemo(() => {
    let val = 0, cost = 0;
    positions.forEach(p => { val += toEUR(p.shares * p.currentPrice, p.currency); cost += toEUR(p.shares * p.avgPrice, p.currency); });
    return { val, cost, gain: val - cost };
  }, [positions]);

  // GAINS ANALYSIS WITH FULL AUDIT
  const gains = useMemo(() => {
    const auditLog = [];
    const log = (m) => auditLog.push(m);
    log(`=== GAINS START: ${trades.length} trades ===`);
    
    const buyTrades = trades.filter(t => t.type === 'buy');
    const sellTrades = trades.filter(t => t.type === 'sell');
    log(`Buys: ${buyTrades.length}, Sells: ${sellTrades.length}`);
    
    const results = { bySymbol: [], realized: 0, unrealized: 0, proceeds: 0, costSold: 0,
      shortRealized: 0, longRealized: 0, shortUnrealized: 0, longUnrealized: 0, auditLog };
    
    if (!trades.length) return results;
    
    const symbols = [...new Set(trades.map(t => t.symbol))];
    log(`Symbols: ${symbols.join(', ')}`);
    
    symbols.forEach(sym => {
      const symTrades = trades.filter(t => t.symbol === sym).sort((a, b) => new Date(a.date) - new Date(b.date));
      const symBuys = symTrades.filter(t => t.type === 'buy');
      const symSells = symTrades.filter(t => t.type === 'sell');
      
      log(`\n--- ${sym}: ${symBuys.length} buys, ${symSells.length} sells ---`);
      
      const pos = positions.find(p => p.symbol === sym);
      const ccy = pos?.currency || symTrades[0]?.currency || 'EUR';
      const curPrice = pos?.currentPrice || pos?.avgPrice || 0;
      const fullySold = !pos || pos.shares < 0.00001;
      
      const lots = [];
      const sells = [];
      let symRealized = 0, symCostSold = 0, symProceeds = 0;
      
      symTrades.forEach(t => {
        if (t.type === 'buy') {
          lots.push({ date: t.date, shares: t.shares, remaining: t.shares, price: t.price });
          log(`  BUY: ${t.shares.toFixed(4)} @ ${t.price.toFixed(2)} on ${t.date}`);
        } else if (t.type === 'sell') {
          log(`  SELL: ${t.shares.toFixed(4)} @ ${t.price.toFixed(2)} on ${t.date}`);
          let toSell = t.shares;
          const proceeds = t.shares * t.price;
          let costBasis = 0;
          const lotsUsed = [];
          
          for (let i = 0; i < lots.length && toSell > 0.00001; i++) {
            if (lots[i].remaining > 0.00001) {
              const use = Math.min(lots[i].remaining, toSell);
              costBasis += use * lots[i].price;
              lots[i].remaining -= use;
              toSell -= use;
              lotsUsed.push({ date: lots[i].date, shares: use, price: lots[i].price });
              log(`    FIFO: ${use.toFixed(4)} from lot @ ${lots[i].price.toFixed(2)}`);
            }
          }
          
          if (toSell > 0.00001) log(`    WARNING: ${toSell.toFixed(4)} unmatched`);
          
          const gain = proceeds - costBasis;
          const gainEUR = toEUR(gain, ccy);
          const days = lotsUsed.length ? Math.ceil((new Date(t.date) - new Date(lotsUsed[0].date)) / 86400000) : 0;
          const isLong = days > 365;
          
          log(`    Gain: ${ccy} ${gain.toFixed(2)} → €${gainEUR.toFixed(2)} (${days}d, ${isLong ? 'long' : 'short'})`);
          
          symRealized += gainEUR;
          symCostSold += toEUR(costBasis, ccy);
          symProceeds += toEUR(proceeds, ccy);
          
          if (isLong) results.longRealized += gainEUR;
          else results.shortRealized += gainEUR;
          
          sells.push({ date: t.date, shares: t.shares, price: t.price, gain: gainEUR, days, isLong });
        }
      });
      
      // Unrealized
      let remShares = 0, remCost = 0;
      lots.forEach(l => {
        if (l.remaining > 0.00001) {
          remShares += l.remaining;
          remCost += l.remaining * l.price;
          const unrealized = (l.remaining * curPrice) - (l.remaining * l.price);
          const days = Math.ceil((Date.now() - new Date(l.date)) / 86400000);
          if (days > 365) results.longUnrealized += toEUR(unrealized, ccy);
          else results.shortUnrealized += toEUR(unrealized, ccy);
        }
      });
      
      const symUnrealized = toEUR((remShares * curPrice) - remCost, ccy);
      log(`  Total: realized €${symRealized.toFixed(2)}, unrealized €${symUnrealized.toFixed(2)}`);
      
      results.bySymbol.push({
        symbol: sym, currency: ccy, fullySold,
        realized: symRealized, unrealized: symUnrealized, total: symRealized + symUnrealized,
        proceeds: symProceeds, costSold: symCostSold,
        sellCount: sells.length, buyCount: symBuys.length, sells,
        remShares, remCost: toEUR(remCost, ccy), curVal: toEUR(remShares * curPrice, ccy)
      });
      
      results.realized += symRealized;
      results.unrealized += symUnrealized;
      results.proceeds += symProceeds;
      results.costSold += symCostSold;
    });
    
    log(`\n=== TOTALS: realized €${results.realized.toFixed(2)}, unrealized €${results.unrealized.toFixed(2)} ===`);
    return results;
  }, [trades, positions]);

  const allocation = useMemo(() => {
    const byType = {};
    positions.forEach(p => { byType[p.type] = (byType[p.type] || 0) + toEUR(p.shares * p.currentPrice, p.currency); });
    const total = Object.values(byType).reduce((s, v) => s + v, 0);
    return Object.entries(byType).map(([t, v]) => ({ name: t, value: v, pct: total > 0 ? (v / total) * 100 : 0 }));
  }, [positions]);

  const s = {
    container: { minHeight: '100vh', backgroundColor: '#030712', color: '#fff', fontFamily: 'system-ui' },
    header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e293b', backgroundColor: '#0a0d14' },
    logo: { width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg, #6366f1, #a855f7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 },
    badge: { fontSize: 11, padding: '4px 10px', borderRadius: 20, fontWeight: 600 },
    btn: { padding: '10px 16px', borderRadius: 10, border: '1px solid #374151', cursor: 'pointer', fontWeight: 500, fontSize: 14, backgroundColor: '#111827', color: '#d1d5db' },
    btnP: { padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14, background: 'linear-gradient(135deg, #6366f1, #a855f7)', color: '#fff' },
    tabs: { display: 'flex', gap: 8, padding: '12px 24px', borderBottom: '1px solid #1e293b', backgroundColor: '#0a0d14', overflowX: 'auto' },
    tab: { padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 500, fontSize: 14, backgroundColor: 'transparent', color: '#6b7280' },
    tabA: { backgroundColor: '#1e293b', color: '#fff' },
    main: { padding: 24 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 },
    card: { padding: 20, borderRadius: 16, backgroundColor: '#111827', border: '1px solid #1e293b' },
    cardL: { fontSize: 13, color: '#6b7280', margin: 0, marginBottom: 8 },
    cardV: { fontSize: 24, fontWeight: 700, margin: 0 },
    chart: { padding: 24, borderRadius: 16, backgroundColor: '#111827', border: '1px solid #1e293b' },
    chartT: { fontSize: 18, fontWeight: 600, margin: 0 },
    modal: { position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 },
    modalC: { backgroundColor: '#111827', borderRadius: 20, padding: 32, width: '100%', maxWidth: 500, border: '1px solid #1e293b', maxHeight: '90vh', overflowY: 'auto' },
    input: { width: '100%', padding: 14, borderRadius: 10, border: '1px solid #374151', backgroundColor: '#0a0d14', color: '#fff', fontSize: 14, boxSizing: 'border-box', marginBottom: 16 },
    inputL: { display: 'block', fontSize: 13, fontWeight: 500, color: '#9ca3af', marginBottom: 6 },
    pre: { backgroundColor: '#0a0d14', padding: 16, borderRadius: 8, fontSize: 11, fontFamily: 'monospace', overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap', color: '#d1d5db' }
  };

  if (loading) return <div style={{ ...s.container, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><p style={{ color: '#6b7280' }}>Loading...</p></div>;

  return (
    <div style={s.container}>
      <header style={s.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={s.logo}>📈</div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Portfolio</h1>
              <span style={{ ...s.badge, backgroundColor: source === 'supabase' ? 'rgba(52,211,153,0.2)' : 'rgba(251,191,36,0.2)', color: source === 'supabase' ? '#34d399' : '#fbbf24' }}>{source === 'supabase' ? '☁️ Cloud' : '💾 Local'}</span>
            </div>
            <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{lastUpdate ? lastUpdate.toLocaleTimeString() : ''}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button style={s.btn} onClick={sync}>{status.state === 'loading' ? '⏳' : '🔄'}</button>
          <button style={s.btn} onClick={() => setShowSettings(true)}>⚙️</button>
        </div>
      </header>

      {status.msg && <div style={{ padding: '12px 24px', textAlign: 'center', fontSize: 14, backgroundColor: status.state === 'error' ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)', color: status.state === 'error' ? '#f87171' : '#34d399' }}>{status.msg}</div>}

      <nav style={s.tabs}>
        {['overview', 'holdings', 'gains', 'dividends', 'fees', 'trades', 'audit'].map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{ ...s.tab, ...(activeTab === t ? s.tabA : {}) }}>{t === 'audit' ? '🔍 AUDIT' : t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
      </nav>

      <main style={s.main}>
        {activeTab === 'overview' && (
          <div>
            <div style={{ ...s.grid, marginBottom: 24 }}>
              <div style={{ ...s.card, background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(168,85,247,0.1))' }}><p style={s.cardL}>Value</p><p style={s.cardV}>{fmt(metrics.val)}</p></div>
              <div style={s.card}><p style={s.cardL}>Gain/Loss</p><p style={{ ...s.cardV, color: metrics.gain >= 0 ? '#34d399' : '#f87171' }}>{fmt(metrics.gain)}</p></div>
              <div style={s.card}><p style={s.cardL}>Dividends</p><p style={{ ...s.cardV, color: '#34d399' }}>{fmt(totalDivs)}</p></div>
              <div style={s.card}><p style={s.cardL}>Fees</p><p style={{ ...s.cardV, color: '#f87171' }}>{fmt(totalFees)}</p></div>
            </div>
            <div style={s.chart}>
              <h3 style={{ ...s.chartT, marginBottom: 16 }}>Holdings ({positions.length})</h3>
              {!positions.length ? <p style={{ color: '#6b7280', textAlign: 'center', padding: 24 }}>No positions</p> : positions.map(p => (
                <div key={p.symbol} style={{ display: 'flex', justifyContent: 'space-between', padding: 14, borderRadius: 10, backgroundColor: '#0a0d14', marginBottom: 8 }}>
                  <div><p style={{ fontWeight: 600, margin: 0 }}>{p.symbol}</p><p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{p.shares.toFixed(4)} @ {fmt(p.avgPrice, p.currency)}</p></div>
                  <p style={{ fontWeight: 600, margin: 0 }}>{fmt(toEUR(p.shares * p.currentPrice, p.currency))}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'holdings' && (
          <div style={s.chart}>
            <h3 style={{ ...s.chartT, marginBottom: 16 }}>Holdings ({positions.length})</h3>
            {positions.map(p => (
              <div key={p.symbol} style={{ display: 'flex', justifyContent: 'space-between', padding: 14, borderRadius: 10, backgroundColor: '#0a0d14', marginBottom: 8 }}>
                <div><p style={{ fontWeight: 600, margin: 0 }}>{p.symbol} <span style={{ fontSize: 11, color: '#6b7280' }}>{p.type}</span></p><p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{p.shares.toFixed(4)} @ {fmt(p.avgPrice, p.currency)}</p></div>
                <div style={{ textAlign: 'right' }}><p style={{ fontWeight: 600, margin: 0 }}>{fmt(toEUR(p.shares * p.currentPrice, p.currency))}</p></div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'gains' && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Realized vs Unrealized Gains</h2>
            <p style={{ color: '#6b7280', marginBottom: 24 }}>FIFO • {trades.length} trades • {gains.bySymbol.filter(g => g.sellCount > 0).length} with sells</p>
            <div style={{ ...s.grid, marginBottom: 24 }}>
              <div style={{ ...s.card, background: 'linear-gradient(135deg, rgba(52,211,153,0.15), rgba(16,185,129,0.1))' }}><p style={s.cardL}>Total</p><p style={{ ...s.cardV, color: (gains.realized + gains.unrealized) >= 0 ? '#34d399' : '#f87171' }}>{fmt(gains.realized + gains.unrealized)}</p></div>
              <div style={s.card}><p style={s.cardL}>Realized</p><p style={{ ...s.cardV, color: gains.realized >= 0 ? '#34d399' : '#f87171' }}>{fmt(gains.realized)}</p></div>
              <div style={s.card}><p style={s.cardL}>Unrealized</p><p style={{ ...s.cardV, color: gains.unrealized >= 0 ? '#34d399' : '#f87171' }}>{fmt(gains.unrealized)}</p></div>
              <div style={s.card}><p style={s.cardL}>Proceeds</p><p style={s.cardV}>{fmt(gains.proceeds)}</p></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
              <div style={s.chart}><h4 style={{ color: '#fff', marginBottom: 12 }}>Realized</h4><div style={{ display: 'flex', gap: 12 }}><div style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#0a0d14' }}><p style={{ color: '#6b7280', fontSize: 11, margin: 0 }}>Short</p><p style={{ color: gains.shortRealized >= 0 ? '#34d399' : '#f87171', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{fmt(gains.shortRealized)}</p></div><div style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#0a0d14' }}><p style={{ color: '#6b7280', fontSize: 11, margin: 0 }}>Long</p><p style={{ color: gains.longRealized >= 0 ? '#34d399' : '#f87171', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{fmt(gains.longRealized)}</p></div></div></div>
              <div style={s.chart}><h4 style={{ color: '#fff', marginBottom: 12 }}>Unrealized</h4><div style={{ display: 'flex', gap: 12 }}><div style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#0a0d14' }}><p style={{ color: '#6b7280', fontSize: 11, margin: 0 }}>Short</p><p style={{ color: gains.shortUnrealized >= 0 ? '#34d399' : '#f87171', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{fmt(gains.shortUnrealized)}</p></div><div style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#0a0d14' }}><p style={{ color: '#6b7280', fontSize: 11, margin: 0 }}>Long</p><p style={{ color: gains.longUnrealized >= 0 ? '#34d399' : '#f87171', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{fmt(gains.longUnrealized)}</p></div></div></div>
            </div>
            <div style={s.chart}>
              <h3 style={{ ...s.chartT, marginBottom: 16 }}>By Symbol ({gains.bySymbol.length})</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ borderBottom: '1px solid #1e293b' }}><th style={{ textAlign: 'left', padding: '10px 8px', color: '#6b7280' }}>Symbol</th><th style={{ textAlign: 'center', padding: '10px 8px', color: '#6b7280' }}>Buys</th><th style={{ textAlign: 'center', padding: '10px 8px', color: '#6b7280' }}>Sells</th><th style={{ textAlign: 'right', padding: '10px 8px', color: '#6b7280' }}>Realized</th><th style={{ textAlign: 'right', padding: '10px 8px', color: '#6b7280' }}>Unrealized</th><th style={{ textAlign: 'right', padding: '10px 8px', color: '#6b7280' }}>Total</th></tr></thead>
                <tbody>{gains.bySymbol.map(g => (<tr key={g.symbol} style={{ borderBottom: '1px solid #1e293b' }}><td style={{ padding: '12px 8px' }}><span style={{ fontWeight: 500 }}>{g.symbol}</span>{g.fullySold && <span style={{ marginLeft: 8, fontSize: 10, padding: '2px 6px', borderRadius: 4, backgroundColor: 'rgba(248,113,113,0.2)', color: '#f87171' }}>SOLD</span>}</td><td style={{ textAlign: 'center', padding: '12px 8px', color: '#34d399' }}>{g.buyCount}</td><td style={{ textAlign: 'center', padding: '12px 8px', color: '#f87171' }}>{g.sellCount}</td><td style={{ textAlign: 'right', padding: '12px 8px', color: g.realized >= 0 ? '#34d399' : '#f87171', fontWeight: 500 }}>{g.sellCount > 0 ? fmt(g.realized) : '—'}</td><td style={{ textAlign: 'right', padding: '12px 8px', color: g.unrealized >= 0 ? '#34d399' : '#f87171', fontWeight: 500 }}>{g.fullySold ? '—' : fmt(g.unrealized)}</td><td style={{ textAlign: 'right', padding: '12px 8px', color: g.total >= 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>{fmt(g.total)}</td></tr>))}</tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'dividends' && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24 }}>Dividends ({dividends.length})</h2>
            <div style={{ ...s.grid, marginBottom: 24 }}><div style={{ ...s.card, background: 'linear-gradient(135deg, rgba(52,211,153,0.15), rgba(16,185,129,0.1))' }}><p style={s.cardL}>Total</p><p style={{ ...s.cardV, color: '#34d399' }}>{fmt(totalDivs)}</p></div><div style={s.card}><p style={s.cardL}>Count</p><p style={s.cardV}>{dividends.length}</p></div></div>
            <div style={s.chart}>{!dividends.length ? <p style={{ color: '#6b7280', textAlign: 'center', padding: 24 }}>No dividends found</p> : [...dividends].sort((a, b) => new Date(b.date) - new Date(a.date)).map((d, i) => (<div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: 12, borderRadius: 8, backgroundColor: '#0a0d14', marginBottom: 8 }}><div><p style={{ fontWeight: 500, margin: 0 }}>{d.symbol}</p><p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{fmtDate(d.date)}</p></div><p style={{ fontWeight: 500, color: '#34d399', margin: 0 }}>{fmt(d.amount, d.currency)}</p></div>))}</div>
          </div>
        )}

        {activeTab === 'fees' && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24 }}>Fees ({fees.length})</h2>
            <div style={{ ...s.grid, marginBottom: 24 }}><div style={{ ...s.card, background: 'linear-gradient(135deg, rgba(248,113,113,0.15), rgba(239,68,68,0.1))' }}><p style={s.cardL}>Total</p><p style={{ ...s.cardV, color: '#f87171' }}>{fmt(totalFees)}</p></div><div style={s.card}><p style={s.cardL}>Tx Fees</p><p style={s.cardV}>{fmt(fees.filter(f => f.type === 'Transaction Fee').reduce((s, f) => s + toEUR(f.amount, f.currency), 0))}</p></div><div style={s.card}><p style={s.cardL}>Tax</p><p style={s.cardV}>{fmt(fees.filter(f => f.type === 'Withholding Tax').reduce((s, f) => s + toEUR(f.amount, f.currency), 0))}</p></div></div>
            <div style={s.chart}>{!fees.length ? <p style={{ color: '#6b7280', textAlign: 'center', padding: 24 }}>No fees found</p> : [...fees].sort((a, b) => new Date(b.date) - new Date(a.date)).map((f, i) => (<div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: 12, borderRadius: 8, backgroundColor: '#0a0d14', marginBottom: 8 }}><div><p style={{ fontWeight: 500, margin: 0 }}>{f.type}</p><p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{fmtDate(f.date)}</p></div><p style={{ fontWeight: 500, color: '#f87171', margin: 0 }}>{fmt(f.amount, f.currency)}</p></div>))}</div>
          </div>
        )}

        {activeTab === 'trades' && (
          <div style={s.chart}>
            <h3 style={{ ...s.chartT, marginBottom: 16 }}>Trades ({trades.length})</h3>
            {!trades.length ? <p style={{ color: '#6b7280', textAlign: 'center', padding: 24 }}>No trades</p> : (
              <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}><thead><tr style={{ borderBottom: '1px solid #1e293b' }}><th style={{ textAlign: 'left', padding: '8px', color: '#6b7280' }}>Date</th><th style={{ textAlign: 'left', padding: '8px', color: '#6b7280' }}>Symbol</th><th style={{ textAlign: 'center', padding: '8px', color: '#6b7280' }}>Type</th><th style={{ textAlign: 'right', padding: '8px', color: '#6b7280' }}>Shares</th><th style={{ textAlign: 'right', padding: '8px', color: '#6b7280' }}>Price</th><th style={{ textAlign: 'right', padding: '8px', color: '#6b7280' }}>Value</th></tr></thead><tbody>{[...trades].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 100).map((t, i) => (<tr key={i} style={{ borderBottom: '1px solid #1e293b' }}><td style={{ padding: '8px', color: '#9ca3af' }}>{fmtDate(t.date)}</td><td style={{ padding: '8px', fontWeight: 500 }}>{t.symbol}</td><td style={{ padding: '8px', textAlign: 'center' }}><span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600, backgroundColor: t.type === 'buy' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)', color: t.type === 'buy' ? '#34d399' : '#f87171' }}>{t.type.toUpperCase()}</span></td><td style={{ padding: '8px', textAlign: 'right', color: '#d1d5db' }}>{t.shares.toFixed(4)}</td><td style={{ padding: '8px', textAlign: 'right', color: '#d1d5db' }}>{fmt(t.price, t.currency)}</td><td style={{ padding: '8px', textAlign: 'right', fontWeight: 500 }}>{fmt(t.shares * t.price, t.currency)}</td></tr>))}</tbody></table></div>
            )}
          </div>
        )}

        {activeTab === 'audit' && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>🔍 Comprehensive Audit</h2>
            <p style={{ color: '#6b7280', marginBottom: 24 }}>Debug information to identify issues</p>
            
            <div style={{ ...s.grid, marginBottom: 24 }}>
              <div style={s.card}><p style={s.cardL}>Raw Tx</p><p style={s.cardV}>{rawTx.length}</p></div>
              <div style={s.card}><p style={s.cardL}>Trades</p><p style={s.cardV}>{trades.length}</p></div>
              <div style={s.card}><p style={s.cardL}>Positions</p><p style={s.cardV}>{positions.length}</p></div>
              <div style={s.card}><p style={s.cardL}>Dividends</p><p style={s.cardV}>{dividends.length}</p></div>
            </div>

            {processingStats && (
              <div style={{ ...s.chart, marginBottom: 24 }}>
                <h3 style={{ ...s.chartT, marginBottom: 16 }}>📊 Processing Stats</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
                  <div style={{ padding: 12, borderRadius: 8, backgroundColor: '#0a0d14' }}><p style={{ color: '#6b7280', fontSize: 11, margin: 0 }}>Cash</p><p style={{ color: '#9ca3af', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{processingStats.cash}</p></div>
                  <div style={{ padding: 12, borderRadius: 8, backgroundColor: '#0a0d14' }}><p style={{ color: '#6b7280', fontSize: 11, margin: 0 }}>Fees</p><p style={{ color: '#f87171', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{processingStats.fees}</p></div>
                  <div style={{ padding: 12, borderRadius: 8, backgroundColor: '#0a0d14' }}><p style={{ color: '#6b7280', fontSize: 11, margin: 0 }}>Taxes</p><p style={{ color: '#f87171', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{processingStats.taxes}</p></div>
                  <div style={{ padding: 12, borderRadius: 8, backgroundColor: '#0a0d14' }}><p style={{ color: '#6b7280', fontSize: 11, margin: 0 }}>Dividends</p><p style={{ color: '#34d399', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{processingStats.dividends}</p></div>
                  <div style={{ padding: 12, borderRadius: 8, backgroundColor: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)' }}><p style={{ color: '#34d399', fontSize: 11, margin: 0 }}>BUYS</p><p style={{ color: '#34d399', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{processingStats.buys}</p></div>
                  <div style={{ padding: 12, borderRadius: 8, backgroundColor: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)' }}><p style={{ color: '#f87171', fontSize: 11, margin: 0 }}>SELLS</p><p style={{ color: '#f87171', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{processingStats.sells}</p></div>
                  <div style={{ padding: 12, borderRadius: 8, backgroundColor: '#0a0d14' }}><p style={{ color: '#6b7280', fontSize: 11, margin: 0 }}>Skipped</p><p style={{ color: '#fbbf24', fontSize: 18, fontWeight: 600, margin: '4px 0 0' }}>{processingStats.skipped}</p></div>
                </div>
              </div>
            )}

            <div style={{ ...s.chart, marginBottom: 24 }}>
              <h3 style={{ ...s.chartT, marginBottom: 16 }}>✅ Trade Verification</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={{ padding: 16, borderRadius: 10, backgroundColor: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)' }}>
                  <p style={{ color: '#34d399', fontWeight: 600, margin: 0, marginBottom: 8 }}>BUY: {trades.filter(t => t.type === 'buy').length}</p>
                  {trades.filter(t => t.type === 'buy').slice(0, 5).map((t, i) => (<p key={i} style={{ color: '#9ca3af', fontSize: 10, margin: '2px 0', fontFamily: 'monospace' }}>{t.date} {t.symbol} {t.shares.toFixed(2)}@{t.price.toFixed(2)} qty={t._rawQty}</p>))}
                </div>
                <div style={{ padding: 16, borderRadius: 10, backgroundColor: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)' }}>
                  <p style={{ color: '#f87171', fontWeight: 600, margin: 0, marginBottom: 8 }}>SELL: {trades.filter(t => t.type === 'sell').length}</p>
                  {trades.filter(t => t.type === 'sell').slice(0, 5).map((t, i) => (<p key={i} style={{ color: '#9ca3af', fontSize: 10, margin: '2px 0', fontFamily: 'monospace' }}>{t.date} {t.symbol} {t.shares.toFixed(2)}@{t.price.toFixed(2)} qty={t._rawQty}</p>))}
                </div>
              </div>
            </div>

            <div style={{ ...s.chart, marginBottom: 24 }}>
              <h3 style={{ ...s.chartT, marginBottom: 16 }}>📈 Gains Audit</h3>
              <pre style={s.pre}>{gains.auditLog?.join('\n') || 'No log'}</pre>
            </div>

            <div style={{ ...s.chart, marginBottom: 24 }}>
              <h3 style={{ ...s.chartT, marginBottom: 16 }}>📋 Raw Tx Sample (30)</h3>
              <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, fontFamily: 'monospace' }}><thead><tr style={{ backgroundColor: '#0a0d14' }}><th style={{ padding: 4, textAlign: 'left', color: '#6b7280' }}>Date</th><th style={{ padding: 4, textAlign: 'left', color: '#6b7280' }}>Symbol</th><th style={{ padding: 4, textAlign: 'right', color: '#6b7280' }}>Qty</th><th style={{ padding: 4, textAlign: 'right', color: '#6b7280' }}>Price</th><th style={{ padding: 4, textAlign: 'left', color: '#6b7280' }}>Asset</th><th style={{ padding: 4, textAlign: 'left', color: '#6b7280' }}>TxType</th></tr></thead><tbody>{rawTx.slice(0, 30).map((tx, i) => (<tr key={i} style={{ borderBottom: '1px solid #1e293b' }}><td style={{ padding: 4, color: '#9ca3af' }}>{tx.transaction_date}</td><td style={{ padding: 4, color: '#fff' }}>{tx.symbol}</td><td style={{ padding: 4, textAlign: 'right', color: parseFloat(tx.quantity) < 0 ? '#f87171' : '#34d399' }}>{tx.quantity}</td><td style={{ padding: 4, textAlign: 'right', color: '#d1d5db' }}>{parseFloat(tx.price_per_unit || 0).toFixed(2)}</td><td style={{ padding: 4, color: '#a78bfa' }}>{tx.asset_type}</td><td style={{ padding: 4, color: '#fbbf24' }}>{tx.transaction_type}</td></tr>))}</tbody></table></div>
            </div>

            <div style={s.chart}>
              <h3 style={{ ...s.chartT, marginBottom: 16 }}>📝 Processing Log</h3>
              <pre style={s.pre}>{processingLog.join('\n') || 'No log'}</pre>
            </div>
          </div>
        )}
      </main>

      {showSettings && (
        <div style={s.modal}><div style={s.modalC}>
          <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24 }}>⚙️ Supabase</h3>
          <label style={s.inputL}>URL</label><input type="text" value={sbUrl} onChange={e => setSbUrl(e.target.value)} style={s.input} placeholder="https://xxx.supabase.co" />
          <label style={s.inputL}>Anon Key</label><input type="password" value={sbKey} onChange={e => setSbKey(e.target.value)} style={s.input} placeholder="eyJ..." />
          <label style={s.inputL}>Table</label><input type="text" value={sbTable} onChange={e => setSbTable(e.target.value)} style={s.input} placeholder="transactions" />
          {source === 'supabase' && <div style={{ padding: 12, borderRadius: 8, backgroundColor: 'rgba(52,211,153,0.1)', marginBottom: 16 }}><p style={{ fontSize: 12, color: '#34d399', margin: 0 }}>✅ {rawTx.length} tx</p></div>}
          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}><button onClick={() => setShowSettings(false)} style={{ ...s.btn, flex: 1 }}>Cancel</button><button onClick={saveSettings} style={{ ...s.btnP, flex: 1 }}>Save</button></div>
        </div></div>
      )}
    </div>
  );
}

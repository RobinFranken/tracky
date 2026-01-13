import React, { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area, BarChart, Bar } from 'recharts';

// ======================
// CONSTANTS
// ======================

const COLORS = ['#6366f1', '#a855f7', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6'];
const YEAR_COLORS = { 2021: '#94a3b8', 2022: '#f87171', 2023: '#fbbf24', 2024: '#34d399', 2025: '#818cf8', 2026: '#a78bfa' };
const TIMEFRAMES = [
  { key: '1W', label: '1W', days: 7 },
  { key: '1M', label: '1M', days: 30 },
  { key: '3M', label: '3M', days: 90 },
  { key: 'YTD', label: 'YTD', days: null },
  { key: '1Y', label: '1Y', days: 365 },
  { key: 'ALL', label: 'All', days: 1825 }
];

// ======================
// SUPABASE SERVICE
// ======================

const SupabaseService = {
  client: null,
  isConfigured: false,
  tableName: 'transactions',

  init(url, anonKey, tableName = 'transactions') {
    if (!url || !anonKey) { this.isConfigured = false; return false; }
    this.client = { url: url.replace(/\/$/, ''), headers: { 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' } };
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
    const positionsMap = {};
    const trades = [];
    const fees = [];
    const dividends = [];
    const stats = { cash: 0, fees: 0, taxes: 0, dividends: 0, buys: 0, sells: 0, skipped: 0 };
    
    const sorted = [...rawTransactions].sort((a, b) => new Date(a.transaction_date) - new Date(b.transaction_date));
    
    sorted.forEach((tx, idx) => {
      const symbol = (tx.symbol || '').trim();
      const assetType = (tx.asset_type || '').toLowerCase().trim();
      const txType = (tx.transaction_type || '').toLowerCase().trim();
      const qty = parseFloat(tx.quantity) || 0;
      const price = parseFloat(tx.price_per_unit) || 0;
      const ccy = (tx.currency || 'EUR').toUpperCase();
      const date = tx.transaction_date;
      
      if (symbol.toLowerCase() === 'cash' || assetType === 'cash') { stats.cash++; return; }
      
      if (symbol.toLowerCase() === 'fee' || assetType === 'expense') {
        fees.push({ id: `fee-${idx}`, type: 'Transaction Fee', amount: Math.abs(price), currency: ccy, date });
        stats.fees++;
        return;
      }
      
      if (assetType === 'tax' || txType === 'withholding tax') {
        fees.push({ id: `tax-${idx}`, type: 'Withholding Tax', amount: Math.abs(price), currency: ccy, date, symbol });
        stats.taxes++;
        return;
      }
      
      if (assetType === 'cash dividends' || assetType === 'dividend' || txType === 'cash dividends' || txType === 'dividend') {
        const cleanSym = symbol.split(':')[0];
        const amt = Math.abs(qty) < 0.0001 ? Math.abs(price) : Math.abs(price * qty);
        if (amt > 0.001) dividends.push({ id: `div-${idx}`, symbol: cleanSym, fullSymbol: symbol, amount: amt, currency: ccy, date });
        stats.dividends++;
        return;
      }
      
      const isTradeAsset = ['stock', 'etf', 'equity'].includes(assetType);
      const isTradeAction = ['buy', 'sell', 'transfer in', 'transfer out'].includes(txType);
      
      if ((isTradeAsset || isTradeAction) && Math.abs(qty) > 0.00001 && price > 0) {
        const cleanSym = symbol.split(':')[0];
        const exchange = symbol.includes(':') ? symbol.split(':')[1].toUpperCase() : '';
        
        let isBuy;
        if (txType === 'sell' || txType === 'transfer out') isBuy = false;
        else if (txType === 'buy' || txType === 'transfer in') isBuy = true;
        else isBuy = qty > 0;
        
        const absQty = Math.abs(qty);
        const tradeType = isBuy ? 'buy' : 'sell';
        
        trades.push({ id: `trade-${idx}`, symbol: cleanSym, fullSymbol: symbol, type: tradeType, shares: absQty, price, date, currency: ccy, exchange, _rawQty: qty, _rawTxType: tx.transaction_type });
        
        if (!positionsMap[cleanSym]) {
          positionsMap[cleanSym] = { symbol: cleanSym, fullSymbol: symbol, type: assetType === 'etf' ? 'ETF' : 'Stock', shares: 0, totalCost: 0, avgPrice: 0, currency: ccy, exchange, firstBuyDate: null };
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
    });
    
    const openPositions = Object.values(positionsMap)
      .filter(p => p.shares > 0.00001)
      .map((p, i) => ({ id: i + 1, symbol: p.symbol, fullSymbol: p.fullSymbol, name: p.symbol, type: p.type, shares: p.shares, avgPrice: p.avgPrice, currentPrice: p.avgPrice, currency: p.currency, exchange: p.exchange, purchaseDate: p.firstBuyDate }));
    
    return { positions: openPositions, trades, fees, dividends, allPositions: positionsMap, stats };
  }
};

// ======================
// PRICE SERVICE
// ======================

const PriceService = {
  cache: {},
  cacheTime: 5 * 60 * 1000, // 5 min cache
  finnhubKey: '',
  
  init(finnhubKey = '') {
    this.finnhubKey = finnhubKey;
    // Load cache from localStorage
    try {
      const cached = JSON.parse(localStorage.getItem('price_cache') || '{}');
      this.cache = cached;
    } catch {}
  },
  
  saveCache() {
    try { localStorage.setItem('price_cache', JSON.stringify(this.cache)); } catch {}
  },
  
  isCached(symbol) {
    const cached = this.cache[symbol];
    return cached && (Date.now() - cached.time < this.cacheTime);
  },
  
  // Map exchange suffixes to Yahoo Finance format
  mapSymbol(symbol, exchange) {
    const exMap = { 'XAMS': '.AS', 'XETR': '.DE', 'XLON': '.L', 'XPAR': '.PA', 'XNAS': '', 'XNYS': '', 'NYSE': '', 'NASDAQ': '' };
    const suffix = exMap[exchange?.toUpperCase()] || '';
    return symbol + suffix;
  },
  
  // Yahoo Finance (works for most stocks via chart API)
  async fetchYahoo(symbol, exchange) {
    const ySymbol = this.mapSymbol(symbol, exchange);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=1d&range=5d`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const quote = data.chart?.result?.[0]?.meta;
      if (quote?.regularMarketPrice) {
        return {
          price: quote.regularMarketPrice,
          prevClose: quote.previousClose || quote.chartPreviousClose,
          change: quote.regularMarketPrice - (quote.previousClose || quote.chartPreviousClose || quote.regularMarketPrice),
          changePct: quote.previousClose ? ((quote.regularMarketPrice - quote.previousClose) / quote.previousClose) * 100 : 0,
          currency: quote.currency || 'USD',
          source: 'yahoo'
        };
      }
    } catch (e) { console.log('Yahoo error:', symbol, e.message); }
    return null;
  },
  
  // Finnhub (US stocks)
  async fetchFinnhub(symbol) {
    if (!this.finnhubKey) return null;
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${this.finnhubKey}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.c && data.c > 0) {
        return {
          price: data.c,
          prevClose: data.pc,
          change: data.d,
          changePct: data.dp,
          high: data.h,
          low: data.l,
          open: data.o,
          source: 'finnhub'
        };
      }
    } catch (e) { console.log('Finnhub error:', symbol, e.message); }
    return null;
  },
  
  // CoinGecko (crypto)
  async fetchCoinGecko(symbol) {
    const cryptoMap = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'ADA': 'cardano', 'DOT': 'polkadot', 'DOGE': 'dogecoin', 'XRP': 'ripple', 'LINK': 'chainlink', 'AVAX': 'avalanche-2', 'MATIC': 'matic-network' };
    const id = cryptoMap[symbol.toUpperCase()];
    if (!id) return null;
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=eur,usd&include_24hr_change=true`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      if (data[id]) {
        return {
          price: data[id].eur,
          priceUSD: data[id].usd,
          changePct: data[id].eur_24h_change || 0,
          currency: 'EUR',
          source: 'coingecko'
        };
      }
    } catch (e) { console.log('CoinGecko error:', symbol, e.message); }
    return null;
  },
  
  // Main fetch function with fallback
  async getPrice(symbol, exchange, type) {
    // Check cache first
    if (this.isCached(symbol)) {
      return this.cache[symbol].data;
    }
    
    let result = null;
    
    // Try crypto first if it looks like crypto
    if (type?.toLowerCase() === 'crypto') {
      result = await this.fetchCoinGecko(symbol);
    }
    
    // Try Yahoo (works for most international stocks)
    if (!result) {
      result = await this.fetchYahoo(symbol, exchange);
    }
    
    // Try Finnhub for US stocks
    if (!result && this.finnhubKey) {
      result = await this.fetchFinnhub(symbol);
    }
    
    // Cache the result
    if (result) {
      this.cache[symbol] = { data: result, time: Date.now() };
      this.saveCache();
    }
    
    return result;
  },
  
  // Batch fetch all positions
  async fetchAllPrices(positions, onProgress) {
    const results = {};
    let completed = 0;
    
    for (const pos of positions) {
      try {
        const price = await this.getPrice(pos.symbol, pos.exchange, pos.type);
        if (price) {
          results[pos.symbol] = price;
        }
        completed++;
        if (onProgress) onProgress(completed, positions.length);
        
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        console.error('Price fetch error:', pos.symbol, e);
      }
    }
    
    return results;
  }
};

// ======================
// HELPERS
// ======================

const loadStorage = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
const saveStorage = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const EUR_RATE = { USD: 0.92, EUR: 1, GBP: 1.17 };
const toEUR = (amt, ccy) => ccy === 'EUR' ? amt : amt * (EUR_RATE[ccy] || 0.92);
const fmt = (v, c = 'EUR') => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: c === 'USD' ? 'USD' : 'EUR', minimumFractionDigits: 2 }).format(v);
const fmtPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A';

// Generate yearly performance from trades
const generateYearlyPerformance = (trades, positions) => {
  const years = {};
  const tradesByYear = {};
  
  trades.forEach(t => {
    const year = new Date(t.date).getFullYear();
    if (!tradesByYear[year]) tradesByYear[year] = [];
    tradesByYear[year].push(t);
  });
  
  Object.keys(tradesByYear).forEach(year => {
    const yearTrades = tradesByYear[year];
    const buys = yearTrades.filter(t => t.type === 'buy');
    const sells = yearTrades.filter(t => t.type === 'sell');
    const invested = buys.reduce((s, t) => s + toEUR(t.shares * t.price, t.currency), 0);
    const proceeds = sells.reduce((s, t) => s + toEUR(t.shares * t.price, t.currency), 0);
    
    years[year] = {
      year: parseInt(year),
      invested,
      proceeds,
      trades: yearTrades.length,
      buys: buys.length,
      sells: sells.length
    };
  });
  
  return years;
};

// ======================
// MAIN COMPONENT
// ======================

export default function PortfolioDashboard() {
  const [positions, setPositions] = useState([]);
  const [trades, setTrades] = useState([]);
  const [fees, setFees] = useState([]);
  const [dividends, setDividends] = useState([]);
  const [rawTx, setRawTx] = useState([]);
  const [stats, setStats] = useState(null);
  
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedTimeframe, setSelectedTimeframe] = useState('1Y');
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedPosition, setSelectedPosition] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [source, setSource] = useState('local');
  const [status, setStatus] = useState({ state: 'idle', msg: '' });
  
  const [showSettings, setShowSettings] = useState(false);
  const [sbUrl, setSbUrl] = useState(loadStorage('sb_url', ''));
  const [sbKey, setSbKey] = useState(loadStorage('sb_key', ''));
  const [sbTable, setSbTable] = useState(loadStorage('sb_table', 'transactions'));
  const [finnhubKey, setFinnhubKey] = useState(loadStorage('finnhub_key', ''));
  const [priceProgress, setPriceProgress] = useState({ loading: false, current: 0, total: 0 });
  const [lastPriceUpdate, setLastPriceUpdate] = useState(null);

  // Initialize price service
  useEffect(() => {
    PriceService.init(finnhubKey);
  }, [finnhubKey]);

  // Fetch live prices
  const fetchPrices = async (positionsToUpdate) => {
    if (!positionsToUpdate?.length) return;
    
    setPriceProgress({ loading: true, current: 0, total: positionsToUpdate.length });
    
    try {
      const prices = await PriceService.fetchAllPrices(positionsToUpdate, (current, total) => {
        setPriceProgress({ loading: true, current, total });
      });
      
      // Update positions with live prices
      setPositions(prev => prev.map(p => {
        const livePrice = prices[p.symbol];
        if (livePrice) {
          return {
            ...p,
            currentPrice: livePrice.price,
            priceChange: livePrice.change || 0,
            priceChangePct: livePrice.changePct || 0,
            priceCurrency: livePrice.currency || p.currency,
            priceSource: livePrice.source
          };
        }
        return p;
      }));
      
      setLastPriceUpdate(new Date());
    } catch (e) {
      console.error('Price fetch error:', e);
    }
    
    setPriceProgress({ loading: false, current: 0, total: 0 });
  };

  // Load data
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      if (sbUrl && sbKey && SupabaseService.init(sbUrl, sbKey, sbTable)) {
        try {
          const raw = await SupabaseService.getTransactions();
          if (raw?.length) {
            setRawTx(raw);
            const p = SupabaseService.processTransactions(raw);
            setPositions(p.positions);
            setTrades(p.trades);
            setFees(p.fees);
            setDividends(p.dividends);
            setStats(p.stats);
            setSource('supabase');
            setLastUpdate(new Date());
            
            // Auto-fetch prices after loading
            if (p.positions.length > 0) {
              setTimeout(() => fetchPrices(p.positions), 500);
            }
          }
        } catch (e) { console.error(e); }
      }
      setLoading(false);
    };
    load();
  }, [sbUrl, sbKey, sbTable]);

  const sync = async () => {
    if (!SupabaseService.isConfigured) return setStatus({ state: 'error', msg: 'Not configured' });
    setStatus({ state: 'loading', msg: 'Syncing...' });
    try {
      const raw = await SupabaseService.getTransactions();
      if (raw?.length) {
        setRawTx(raw);
        const p = SupabaseService.processTransactions(raw);
        setPositions(p.positions);
        setTrades(p.trades);
        setFees(p.fees);
        setDividends(p.dividends);
        setStats(p.stats);
        setSource('supabase');
        setLastUpdate(new Date());
        setStatus({ state: 'success', msg: `✓ Synced ${raw.length} transactions` });
        
        // Fetch live prices after loading positions
        if (p.positions.length > 0) {
          setTimeout(() => fetchPrices(p.positions), 500);
        }
      }
    } catch (e) { setStatus({ state: 'error', msg: e.message }); }
    setTimeout(() => setStatus({ state: 'idle', msg: '' }), 5000);
  };

  const saveSettings = () => {
    saveStorage('sb_url', sbUrl);
    saveStorage('sb_key', sbKey);
    saveStorage('sb_table', sbTable);
    saveStorage('finnhub_key', finnhubKey);
    PriceService.init(finnhubKey);
    if (sbUrl && sbKey) { SupabaseService.init(sbUrl, sbKey, sbTable); sync(); }
    setShowSettings(false);
  };

  // Metrics
  const totalFees = useMemo(() => fees.reduce((s, f) => s + toEUR(f.amount, f.currency), 0), [fees]);
  const totalDivs = useMemo(() => dividends.reduce((s, d) => s + toEUR(d.amount, d.currency), 0), [dividends]);
  
  const metrics = useMemo(() => {
    let val = 0, cost = 0;
    positions.forEach(p => {
      val += toEUR(p.shares * p.currentPrice, p.currency);
      cost += toEUR(p.shares * p.avgPrice, p.currency);
    });
    return { val, cost, gain: val - cost, pct: cost > 0 ? ((val - cost) / cost) * 100 : 0 };
  }, [positions]);

  // Gains Analysis (FIFO)
  const gains = useMemo(() => {
    const results = { bySymbol: [], realized: 0, unrealized: 0, proceeds: 0, costSold: 0, shortRealized: 0, longRealized: 0, shortUnrealized: 0, longUnrealized: 0 };
    if (!trades.length) return results;
    
    const symbols = [...new Set(trades.map(t => t.symbol))];
    
    symbols.forEach(sym => {
      const symTrades = trades.filter(t => t.symbol === sym).sort((a, b) => new Date(a.date) - new Date(b.date));
      const symBuys = symTrades.filter(t => t.type === 'buy');
      const symSells = symTrades.filter(t => t.type === 'sell');
      
      const pos = positions.find(p => p.symbol === sym);
      const ccy = pos?.currency || symTrades[0]?.currency || 'EUR';
      const curPrice = pos?.currentPrice || pos?.avgPrice || 0;
      const fullySold = !pos || pos.shares < 0.00001;
      
      const lots = [];
      let symRealized = 0, symCostSold = 0, symProceeds = 0;
      
      symTrades.forEach(t => {
        if (t.type === 'buy') {
          lots.push({ date: t.date, shares: t.shares, remaining: t.shares, price: t.price });
        } else if (t.type === 'sell') {
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
            }
          }
          
          const gain = proceeds - costBasis;
          const gainEUR = toEUR(gain, ccy);
          const days = lotsUsed.length ? Math.ceil((new Date(t.date) - new Date(lotsUsed[0].date)) / 86400000) : 0;
          const isLong = days > 365;
          
          symRealized += gainEUR;
          symCostSold += toEUR(costBasis, ccy);
          symProceeds += toEUR(proceeds, ccy);
          
          if (isLong) results.longRealized += gainEUR;
          else results.shortRealized += gainEUR;
        }
      });
      
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
      
      results.bySymbol.push({
        symbol: sym, currency: ccy, fullySold,
        realized: symRealized, unrealized: symUnrealized, total: symRealized + symUnrealized,
        proceeds: symProceeds, costSold: symCostSold,
        sellCount: symSells.length, buyCount: symBuys.length,
        remShares, remCost: toEUR(remCost, ccy)
      });
      
      results.realized += symRealized;
      results.unrealized += symUnrealized;
      results.proceeds += symProceeds;
      results.costSold += symCostSold;
    });
    
    return results;
  }, [trades, positions]);

  // Allocation
  const allocation = useMemo(() => {
    const byType = {};
    positions.forEach(p => { const v = toEUR(p.shares * p.currentPrice, p.currency); byType[p.type] = (byType[p.type] || 0) + v; });
    const total = Object.values(byType).reduce((s, v) => s + v, 0);
    return Object.entries(byType).map(([t, v]) => ({ name: t, value: v, pct: total > 0 ? (v / total) * 100 : 0 }));
  }, [positions]);

  // Historical data for chart
  const historicalData = useMemo(() => {
    if (!positions.length) return [];
    const tf = TIMEFRAMES.find(t => t.key === selectedTimeframe);
    let days = tf?.days || 365;
    if (tf?.key === 'YTD') {
      const now = new Date();
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      days = Math.ceil((now - startOfYear) / 86400000);
    }
    
    const curVal = positions.reduce((s, p) => s + toEUR(p.shares * p.currentPrice, p.currency), 0);
    const data = [];
    for (let i = days; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      // Simulate historical values with some variance
      const variance = 1 - (i / days) * 0.15 + (Math.sin(i * 0.1) * 0.03);
      data.push({ date: d.toISOString().split('T')[0], value: curVal * variance });
    }
    return data;
  }, [positions, selectedTimeframe]);

  // Yearly performance
  const yearlyPerformance = useMemo(() => generateYearlyPerformance(trades, positions), [trades, positions]);
  const availableYears = useMemo(() => Object.keys(yearlyPerformance).map(Number).sort((a, b) => b - a), [yearlyPerformance]);

  // Yearly chart data
  const yearlyChartData = useMemo(() => {
    return availableYears.map(year => ({
      year: year.toString(),
      invested: yearlyPerformance[year]?.invested || 0,
      proceeds: yearlyPerformance[year]?.proceeds || 0,
      trades: yearlyPerformance[year]?.trades || 0
    })).reverse();
  }, [yearlyPerformance, availableYears]);

  // Dividends by year
  const dividendsByYear = useMemo(() => {
    const byYear = {};
    dividends.forEach(d => {
      const year = new Date(d.date).getFullYear();
      byYear[year] = (byYear[year] || 0) + toEUR(d.amount, d.currency);
    });
    return Object.entries(byYear).map(([y, v]) => ({ year: y, amount: v })).sort((a, b) => b.year - a.year);
  }, [dividends]);

  // Period metrics
  const periodMetrics = useMemo(() => {
    if (historicalData.length < 2) return { change: 0, pct: 0 };
    const start = historicalData[0].value;
    const end = historicalData[historicalData.length - 1].value;
    return { change: end - start, pct: start > 0 ? ((end - start) / start) * 100 : 0 };
  }, [historicalData]);

  // Styles
  const styles = {
    container: { minHeight: '100vh', backgroundColor: '#030712', color: '#fff', fontFamily: 'system-ui, -apple-system, sans-serif' },
    header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e293b', background: 'linear-gradient(180deg, #0f172a 0%, #030712 100%)' },
    logo: { width: 44, height: 44, borderRadius: 14, background: 'linear-gradient(135deg, #6366f1, #a855f7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, boxShadow: '0 4px 12px rgba(99,102,241,0.3)' },
    badge: { fontSize: 11, padding: '4px 12px', borderRadius: 20, fontWeight: 600 },
    btn: { padding: '10px 16px', borderRadius: 12, border: '1px solid #374151', cursor: 'pointer', fontWeight: 500, fontSize: 14, backgroundColor: '#111827', color: '#d1d5db', transition: 'all 0.2s' },
    btnPrimary: { padding: '10px 20px', borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14, background: 'linear-gradient(135deg, #6366f1, #a855f7)', color: '#fff', boxShadow: '0 4px 12px rgba(99,102,241,0.3)' },
    tabs: { display: 'flex', gap: 8, padding: '16px 24px', borderBottom: '1px solid #1e293b', backgroundColor: '#0a0d14', overflowX: 'auto' },
    tab: { padding: '12px 24px', borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 500, fontSize: 14, backgroundColor: 'transparent', color: '#6b7280', transition: 'all 0.2s' },
    tabActive: { backgroundColor: '#1e293b', color: '#fff' },
    main: { padding: 24, maxWidth: 1600, margin: '0 auto' },
    grid4: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 },
    card: { padding: 24, borderRadius: 20, backgroundColor: '#111827', border: '1px solid #1e293b', transition: 'all 0.2s' },
    cardLabel: { fontSize: 13, color: '#6b7280', margin: 0, marginBottom: 8, fontWeight: 500 },
    cardValue: { fontSize: 28, fontWeight: 700, margin: 0 },
    cardSub: { fontSize: 13, marginTop: 8 },
    chartCard: { padding: 24, borderRadius: 20, backgroundColor: '#111827', border: '1px solid #1e293b' },
    chartTitle: { fontSize: 18, fontWeight: 600, margin: 0 },
    tfBtns: { display: 'flex', gap: 4, backgroundColor: '#0a0d14', padding: 4, borderRadius: 12 },
    tfBtn: (active) => ({ padding: '8px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 500, fontSize: 13, backgroundColor: active ? '#374151' : 'transparent', color: active ? '#fff' : '#6b7280' }),
    modal: { position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20, backdropFilter: 'blur(4px)' },
    modalContent: { backgroundColor: '#111827', borderRadius: 24, padding: 32, width: '100%', maxWidth: 600, border: '1px solid #1e293b', maxHeight: '90vh', overflowY: 'auto' },
    input: { width: '100%', padding: 14, borderRadius: 12, border: '1px solid #374151', backgroundColor: '#0a0d14', color: '#fff', fontSize: 14, boxSizing: 'border-box', marginBottom: 16 },
    inputLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: '#9ca3af', marginBottom: 8 },
    row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 14, backgroundColor: '#0a0d14', marginBottom: 10, cursor: 'pointer', transition: 'all 0.2s', border: '1px solid transparent' },
    rowHover: { backgroundColor: '#1e293b', borderColor: '#374151' }
  };

  if (loading) return (
    <div style={{ ...styles.container, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>📊</div>
        <p style={{ color: '#6b7280', fontSize: 16 }}>Loading portfolio...</p>
      </div>
    </div>
  );

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={styles.logo}>📈</div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Portfolio Tracker</h1>
              <span style={{ ...styles.badge, backgroundColor: source === 'supabase' ? 'rgba(52,211,153,0.2)' : 'rgba(251,191,36,0.2)', color: source === 'supabase' ? '#34d399' : '#fbbf24' }}>
                {source === 'supabase' ? '☁️ Cloud Synced' : '💾 Local'}
              </span>
            </div>
            {lastUpdate && <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>Data: {lastUpdate.toLocaleTimeString()} {lastPriceUpdate && `• Prices: ${lastPriceUpdate.toLocaleTimeString()}`}</p>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          {priceProgress.loading && (
            <span style={{ padding: '10px 16px', fontSize: 13, color: '#6b7280' }}>
              📊 Fetching prices... {priceProgress.current}/{priceProgress.total}
            </span>
          )}
          <button style={styles.btn} onClick={() => fetchPrices(positions)} disabled={priceProgress.loading || !positions.length}>
            💹 Update Prices
          </button>
          <button style={styles.btn} onClick={sync} disabled={status.state === 'loading'}>
            {status.state === 'loading' ? '⏳ Syncing...' : '🔄 Refresh'}
          </button>
          <button style={styles.btn} onClick={() => setShowSettings(true)}>⚙️</button>
        </div>
      </header>

      {status.msg && (
        <div style={{ padding: '14px 24px', textAlign: 'center', fontSize: 14, fontWeight: 500, backgroundColor: status.state === 'error' ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)', color: status.state === 'error' ? '#f87171' : '#34d399', borderBottom: '1px solid ' + (status.state === 'error' ? 'rgba(248,113,113,0.2)' : 'rgba(52,211,153,0.2)') }}>
          {status.msg}
        </div>
      )}

      {/* Tabs */}
      <nav style={styles.tabs}>
        {['overview', 'holdings', 'performance', 'gains', 'dividends', 'fees', 'trades'].map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{ ...styles.tab, ...(activeTab === t ? styles.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main style={styles.main}>
        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div>
            {/* Key Metrics */}
            <div style={{ ...styles.grid4, marginBottom: 24 }}>
              <div style={{ ...styles.card, background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(168,85,247,0.1))', borderColor: 'rgba(99,102,241,0.3)' }}>
                <p style={styles.cardLabel}>Portfolio Value</p>
                <p style={styles.cardValue}>{fmt(metrics.val)}</p>
                <p style={{ ...styles.cardSub, color: periodMetrics.pct >= 0 ? '#34d399' : '#f87171' }}>{fmtPct(periodMetrics.pct)} this period</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Total Gain/Loss</p>
                <p style={{ ...styles.cardValue, color: (gains.realized + gains.unrealized) >= 0 ? '#34d399' : '#f87171' }}>{fmt(gains.realized + gains.unrealized)}</p>
                <p style={{ ...styles.cardSub, color: '#6b7280' }}>{fmt(gains.realized)} realized</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Dividends Received</p>
                <p style={{ ...styles.cardValue, color: '#34d399' }}>{fmt(totalDivs)}</p>
                <p style={{ ...styles.cardSub, color: '#6b7280' }}>{dividends.length} payments</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Total Fees & Tax</p>
                <p style={{ ...styles.cardValue, color: '#f87171' }}>{fmt(totalFees)}</p>
                <p style={{ ...styles.cardSub, color: '#6b7280' }}>{fees.length} transactions</p>
              </div>
            </div>

            {/* Chart and Allocation */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24, marginBottom: 24 }}>
              <div style={styles.chartCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                  <div>
                    <h3 style={styles.chartTitle}>Portfolio Performance</h3>
                    <p style={{ fontSize: 13, color: periodMetrics.change >= 0 ? '#34d399' : '#f87171', margin: '4px 0 0' }}>
                      {fmt(periodMetrics.change)} ({fmtPct(periodMetrics.pct)}) in period
                    </p>
                  </div>
                  <div style={styles.tfBtns}>
                    {TIMEFRAMES.map(tf => (
                      <button key={tf.key} onClick={() => setSelectedTimeframe(tf.key)} style={styles.tfBtn(selectedTimeframe === tf.key)}>{tf.label}</button>
                    ))}
                  </div>
                </div>
                <div style={{ height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historicalData}>
                      <defs>
                        <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={v => v.slice(5)} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={v => `€${(v/1000).toFixed(0)}k`} domain={['auto', 'auto']} />
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12 }} formatter={v => [fmt(v), 'Value']} labelFormatter={l => fmtDate(l)} />
                      <Area type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2} fill="url(#colorValue)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div style={styles.chartCard}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 20 }}>Asset Allocation</h3>
                <div style={{ height: 180 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={allocation} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                        {allocation.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12 }} formatter={v => fmt(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ marginTop: 16 }}>
                  {allocation.map((a, i) => (
                    <div key={a.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: COLORS[i % COLORS.length] }} />
                        <span style={{ color: '#d1d5db', fontSize: 14 }}>{a.name}</span>
                      </div>
                      <span style={{ color: '#9ca3af', fontSize: 14, fontWeight: 500 }}>{a.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Top Holdings */}
            <div style={styles.chartCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h3 style={styles.chartTitle}>Top Holdings</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => fetchPrices(positions)} disabled={priceProgress.loading} style={{ ...styles.btn, padding: '8px 14px', fontSize: 12 }}>
                    {priceProgress.loading ? '...' : '💹 Prices'}
                  </button>
                  <button onClick={() => setActiveTab('holdings')} style={{ ...styles.btn, padding: '8px 14px', fontSize: 12 }}>View All →</button>
                </div>
              </div>
              {[...positions].sort((a, b) => toEUR(b.shares * b.currentPrice, b.currency) - toEUR(a.shares * a.currentPrice, a.currency)).slice(0, 5).map((p, idx) => (
                <div key={p.symbol} onClick={() => setSelectedPosition(p)} style={styles.row} onMouseOver={e => Object.assign(e.currentTarget.style, styles.rowHover)} onMouseOut={e => Object.assign(e.currentTarget.style, { backgroundColor: '#0a0d14', borderColor: 'transparent' })}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg, ${COLORS[idx % COLORS.length]}40, ${COLORS[idx % COLORS.length]}20)`, border: `1px solid ${COLORS[idx % COLORS.length]}50`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, color: COLORS[idx % COLORS.length] }}>{p.symbol.slice(0, 4)}</div>
                    <div>
                      <p style={{ fontWeight: 600, margin: 0, fontSize: 15 }}>
                        {p.symbol}
                        {p.priceSource && <span style={{ fontSize: 10, color: '#6366f1', marginLeft: 8 }}>● LIVE</span>}
                      </p>
                      <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>{p.shares.toFixed(2)} @ {fmt(p.currentPrice, p.priceCurrency || p.currency)}</p>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontWeight: 600, margin: 0, fontSize: 16 }}>{fmt(toEUR(p.shares * p.currentPrice, p.priceCurrency || p.currency))}</p>
                    {p.priceChangePct !== undefined && p.priceChangePct !== 0 ? (
                      <p style={{ fontSize: 13, color: p.priceChangePct >= 0 ? '#34d399' : '#f87171', margin: '2px 0 0' }}>
                        {p.priceChangePct >= 0 ? '▲' : '▼'} {Math.abs(p.priceChangePct).toFixed(2)}%
                      </p>
                    ) : (
                      <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>{((toEUR(p.shares * p.currentPrice, p.currency) / metrics.val) * 100).toFixed(1)}%</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* HOLDINGS TAB */}
        {activeTab === 'holdings' && (
          <div style={styles.chartCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={styles.chartTitle}>All Holdings ({positions.length})</h3>
              <button onClick={() => fetchPrices(positions)} disabled={priceProgress.loading} style={{ ...styles.btn, padding: '8px 16px', fontSize: 13 }}>
                {priceProgress.loading ? `Updating ${priceProgress.current}/${priceProgress.total}...` : '💹 Update Prices'}
              </button>
            </div>
            {[...positions].sort((a, b) => toEUR(b.shares * b.currentPrice, b.currency) - toEUR(a.shares * a.currentPrice, a.currency)).map((p, idx) => (
              <div key={p.symbol} onClick={() => setSelectedPosition(p)} style={styles.row} onMouseOver={e => Object.assign(e.currentTarget.style, styles.rowHover)} onMouseOut={e => Object.assign(e.currentTarget.style, { backgroundColor: '#0a0d14', borderColor: 'transparent' })}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: `linear-gradient(135deg, ${COLORS[idx % COLORS.length]}40, ${COLORS[idx % COLORS.length]}20)`, border: `1px solid ${COLORS[idx % COLORS.length]}50`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, color: COLORS[idx % COLORS.length] }}>{p.symbol.slice(0, 4)}</div>
                  <div>
                    <p style={{ fontWeight: 600, margin: 0, fontSize: 15 }}>
                      {p.symbol} <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 400 }}>{p.type}</span>
                      {p.priceSource && <span style={{ fontSize: 10, color: '#6366f1', marginLeft: 8 }}>● LIVE</span>}
                    </p>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>
                      {p.shares.toFixed(4)} shares • Avg: {fmt(p.avgPrice, p.currency)} • Now: {fmt(p.currentPrice, p.priceCurrency || p.currency)}
                    </p>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontWeight: 600, margin: 0, fontSize: 16 }}>{fmt(toEUR(p.shares * p.currentPrice, p.priceCurrency || p.currency))}</p>
                  {p.priceChangePct !== undefined && p.priceChangePct !== 0 ? (
                    <p style={{ fontSize: 13, color: p.priceChangePct >= 0 ? '#34d399' : '#f87171', margin: '2px 0 0' }}>
                      {p.priceChangePct >= 0 ? '▲' : '▼'} {Math.abs(p.priceChangePct).toFixed(2)}% today
                    </p>
                  ) : (
                    <p style={{ fontSize: 13, color: gains.bySymbol.find(g => g.symbol === p.symbol)?.unrealized >= 0 ? '#34d399' : '#f87171', margin: '2px 0 0' }}>
                      {fmt(gains.bySymbol.find(g => g.symbol === p.symbol)?.unrealized || 0)} unrealized
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* PERFORMANCE TAB */}
        {activeTab === 'performance' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
              <div style={styles.chartCard}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 20 }}>Yearly Activity</h3>
                <div style={{ height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={yearlyChartData}>
                      <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={v => `€${(v/1000).toFixed(0)}k`} />
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12 }} formatter={v => fmt(v)} />
                      <Bar dataKey="invested" fill="#6366f1" radius={[4, 4, 0, 0]} name="Invested" />
                      <Bar dataKey="proceeds" fill="#34d399" radius={[4, 4, 0, 0]} name="Proceeds" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div style={styles.chartCard}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 20 }}>Dividends by Year</h3>
                <div style={{ height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dividendsByYear}>
                      <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={v => `€${v.toFixed(0)}`} />
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12 }} formatter={v => fmt(v)} />
                      <Bar dataKey="amount" fill="#10b981" radius={[4, 4, 0, 0]} name="Dividends" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div style={styles.chartCard}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 20 }}>Year by Year Summary</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #1e293b' }}>
                    <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Year</th>
                    <th style={{ textAlign: 'right', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Invested</th>
                    <th style={{ textAlign: 'right', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Proceeds</th>
                    <th style={{ textAlign: 'center', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Trades</th>
                    <th style={{ textAlign: 'right', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Dividends</th>
                  </tr>
                </thead>
                <tbody>
                  {availableYears.map(year => (
                    <tr key={year} style={{ borderBottom: '1px solid #1e293b' }}>
                      <td style={{ padding: '14px 8px', fontWeight: 600, color: YEAR_COLORS[year] || '#fff' }}>{year}</td>
                      <td style={{ padding: '14px 8px', textAlign: 'right', color: '#34d399' }}>{fmt(yearlyPerformance[year]?.invested || 0)}</td>
                      <td style={{ padding: '14px 8px', textAlign: 'right', color: '#f87171' }}>{fmt(yearlyPerformance[year]?.proceeds || 0)}</td>
                      <td style={{ padding: '14px 8px', textAlign: 'center', color: '#9ca3af' }}>{yearlyPerformance[year]?.trades || 0}</td>
                      <td style={{ padding: '14px 8px', textAlign: 'right', color: '#34d399' }}>{fmt(dividendsByYear.find(d => d.year === year.toString())?.amount || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* GAINS TAB */}
        {activeTab === 'gains' && (
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Realized vs Unrealized Gains</h2>
            <p style={{ color: '#6b7280', marginBottom: 24 }}>Tax lot analysis using FIFO method • {trades.length} trades • {gains.bySymbol.filter(g => g.sellCount > 0).length} positions with sells</p>
            
            <div style={{ ...styles.grid4, marginBottom: 24 }}>
              <div style={{ ...styles.card, background: 'linear-gradient(135deg, rgba(52,211,153,0.15), rgba(16,185,129,0.1))', borderColor: 'rgba(52,211,153,0.3)' }}>
                <p style={styles.cardLabel}>Total Gain</p>
                <p style={{ ...styles.cardValue, color: (gains.realized + gains.unrealized) >= 0 ? '#34d399' : '#f87171' }}>{fmt(gains.realized + gains.unrealized)}</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Realized</p>
                <p style={{ ...styles.cardValue, color: gains.realized >= 0 ? '#34d399' : '#f87171' }}>{fmt(gains.realized)}</p>
                <p style={{ ...styles.cardSub, color: '#6b7280' }}>From {gains.bySymbol.filter(g => g.sellCount > 0).length} positions sold</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Unrealized</p>
                <p style={{ ...styles.cardValue, color: gains.unrealized >= 0 ? '#34d399' : '#f87171' }}>{fmt(gains.unrealized)}</p>
                <p style={{ ...styles.cardSub, color: '#6b7280' }}>Paper gains on holdings</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Sale Proceeds</p>
                <p style={styles.cardValue}>{fmt(gains.proceeds)}</p>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
              <div style={styles.chartCard}>
                <h4 style={{ color: '#fff', marginBottom: 16, fontWeight: 600 }}>Realized by Holding Period</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#0a0d14' }}>
                    <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Short-term (&lt;1yr)</p>
                    <p style={{ color: gains.shortRealized >= 0 ? '#34d399' : '#f87171', fontSize: 22, fontWeight: 600, margin: '6px 0 0' }}>{fmt(gains.shortRealized)}</p>
                  </div>
                  <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#0a0d14' }}>
                    <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Long-term (&gt;1yr)</p>
                    <p style={{ color: gains.longRealized >= 0 ? '#34d399' : '#f87171', fontSize: 22, fontWeight: 600, margin: '6px 0 0' }}>{fmt(gains.longRealized)}</p>
                  </div>
                </div>
              </div>
              <div style={styles.chartCard}>
                <h4 style={{ color: '#fff', marginBottom: 16, fontWeight: 600 }}>Unrealized by Holding Period</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#0a0d14' }}>
                    <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Short-term (&lt;1yr)</p>
                    <p style={{ color: gains.shortUnrealized >= 0 ? '#34d399' : '#f87171', fontSize: 22, fontWeight: 600, margin: '6px 0 0' }}>{fmt(gains.shortUnrealized)}</p>
                  </div>
                  <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#0a0d14' }}>
                    <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Long-term (&gt;1yr)</p>
                    <p style={{ color: gains.longUnrealized >= 0 ? '#34d399' : '#f87171', fontSize: 22, fontWeight: 600, margin: '6px 0 0' }}>{fmt(gains.longUnrealized)}</p>
                  </div>
                </div>
              </div>
            </div>

            <div style={styles.chartCard}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 20 }}>Position Breakdown ({gains.bySymbol.length})</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #1e293b' }}>
                    <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Symbol</th>
                    <th style={{ textAlign: 'center', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Buys</th>
                    <th style={{ textAlign: 'center', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Sells</th>
                    <th style={{ textAlign: 'right', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Realized</th>
                    <th style={{ textAlign: 'right', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Unrealized</th>
                    <th style={{ textAlign: 'right', padding: '12px 8px', color: '#6b7280', fontWeight: 500, fontSize: 13 }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {[...gains.bySymbol].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).map(g => (
                    <tr key={g.symbol} style={{ borderBottom: '1px solid #1e293b' }}>
                      <td style={{ padding: '14px 8px' }}>
                        <span style={{ fontWeight: 600 }}>{g.symbol}</span>
                        {g.fullySold && <span style={{ marginLeft: 10, fontSize: 10, padding: '3px 8px', borderRadius: 6, backgroundColor: 'rgba(248,113,113,0.2)', color: '#f87171', fontWeight: 600 }}>SOLD</span>}
                      </td>
                      <td style={{ textAlign: 'center', padding: '14px 8px', color: '#34d399' }}>{g.buyCount}</td>
                      <td style={{ textAlign: 'center', padding: '14px 8px', color: '#f87171' }}>{g.sellCount}</td>
                      <td style={{ textAlign: 'right', padding: '14px 8px', color: g.realized >= 0 ? '#34d399' : '#f87171', fontWeight: 500 }}>{g.sellCount > 0 ? fmt(g.realized) : '—'}</td>
                      <td style={{ textAlign: 'right', padding: '14px 8px', color: g.unrealized >= 0 ? '#34d399' : '#f87171', fontWeight: 500 }}>{g.fullySold ? '—' : fmt(g.unrealized)}</td>
                      <td style={{ textAlign: 'right', padding: '14px 8px', color: g.total >= 0 ? '#34d399' : '#f87171', fontWeight: 700 }}>{fmt(g.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* DIVIDENDS TAB */}
        {activeTab === 'dividends' && (
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Dividend Income</h2>
            <div style={{ ...styles.grid4, marginBottom: 24 }}>
              <div style={{ ...styles.card, background: 'linear-gradient(135deg, rgba(52,211,153,0.15), rgba(16,185,129,0.1))', borderColor: 'rgba(52,211,153,0.3)' }}>
                <p style={styles.cardLabel}>Total Received</p>
                <p style={{ ...styles.cardValue, color: '#34d399' }}>{fmt(totalDivs)}</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Payments</p>
                <p style={styles.cardValue}>{dividends.length}</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>This Year</p>
                <p style={{ ...styles.cardValue, color: '#34d399' }}>{fmt(dividends.filter(d => new Date(d.date).getFullYear() === new Date().getFullYear()).reduce((s, d) => s + toEUR(d.amount, d.currency), 0))}</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Avg per Payment</p>
                <p style={styles.cardValue}>{fmt(dividends.length > 0 ? totalDivs / dividends.length : 0)}</p>
              </div>
            </div>

            <div style={styles.chartCard}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 20 }}>Dividend History</h3>
              {!dividends.length ? (
                <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>No dividend payments recorded</p>
              ) : (
                [...dividends].sort((a, b) => new Date(b.date) - new Date(a.date)).map((d, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: 12, backgroundColor: '#0a0d14', marginBottom: 10 }}>
                    <div>
                      <p style={{ fontWeight: 600, margin: 0, fontSize: 15 }}>{d.symbol}</p>
                      <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>{fmtDate(d.date)}</p>
                    </div>
                    <p style={{ fontWeight: 600, color: '#34d399', margin: 0, fontSize: 16 }}>{fmt(d.amount, d.currency)}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* FEES TAB */}
        {activeTab === 'fees' && (
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Fees & Taxes</h2>
            <div style={{ ...styles.grid4, marginBottom: 24 }}>
              <div style={{ ...styles.card, background: 'linear-gradient(135deg, rgba(248,113,113,0.15), rgba(239,68,68,0.1))', borderColor: 'rgba(248,113,113,0.3)' }}>
                <p style={styles.cardLabel}>Total Fees</p>
                <p style={{ ...styles.cardValue, color: '#f87171' }}>{fmt(totalFees)}</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Transaction Fees</p>
                <p style={styles.cardValue}>{fmt(fees.filter(f => f.type === 'Transaction Fee').reduce((s, f) => s + toEUR(f.amount, f.currency), 0))}</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Withholding Tax</p>
                <p style={styles.cardValue}>{fmt(fees.filter(f => f.type === 'Withholding Tax').reduce((s, f) => s + toEUR(f.amount, f.currency), 0))}</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Fee Count</p>
                <p style={styles.cardValue}>{fees.length}</p>
              </div>
            </div>

            <div style={styles.chartCard}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 20 }}>Fee History</h3>
              {!fees.length ? (
                <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>No fees recorded</p>
              ) : (
                [...fees].sort((a, b) => new Date(b.date) - new Date(a.date)).map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: 12, backgroundColor: '#0a0d14', marginBottom: 10 }}>
                    <div>
                      <p style={{ fontWeight: 600, margin: 0, fontSize: 15 }}>{f.type}</p>
                      <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>{fmtDate(f.date)} {f.symbol && `• ${f.symbol}`}</p>
                    </div>
                    <p style={{ fontWeight: 600, color: '#f87171', margin: 0, fontSize: 16 }}>{fmt(f.amount, f.currency)}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* TRADES TAB */}
        {activeTab === 'trades' && (
          <div style={styles.chartCard}>
            <h3 style={{ ...styles.chartTitle, marginBottom: 20 }}>Trade History ({trades.length})</h3>
            {!trades.length ? (
              <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>No trades recorded</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #1e293b' }}>
                      <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280', fontWeight: 500 }}>Date</th>
                      <th style={{ textAlign: 'left', padding: '12px 8px', color: '#6b7280', fontWeight: 500 }}>Symbol</th>
                      <th style={{ textAlign: 'center', padding: '12px 8px', color: '#6b7280', fontWeight: 500 }}>Type</th>
                      <th style={{ textAlign: 'right', padding: '12px 8px', color: '#6b7280', fontWeight: 500 }}>Shares</th>
                      <th style={{ textAlign: 'right', padding: '12px 8px', color: '#6b7280', fontWeight: 500 }}>Price</th>
                      <th style={{ textAlign: 'right', padding: '12px 8px', color: '#6b7280', fontWeight: 500 }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...trades].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 100).map((t, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '12px 8px', color: '#9ca3af' }}>{fmtDate(t.date)}</td>
                        <td style={{ padding: '12px 8px', fontWeight: 600 }}>{t.symbol}</td>
                        <td style={{ padding: '12px 8px', textAlign: 'center' }}>
                          <span style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, backgroundColor: t.type === 'buy' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)', color: t.type === 'buy' ? '#34d399' : '#f87171' }}>{t.type.toUpperCase()}</span>
                        </td>
                        <td style={{ padding: '12px 8px', textAlign: 'right', color: '#d1d5db' }}>{t.shares.toFixed(4)}</td>
                        <td style={{ padding: '12px 8px', textAlign: 'right', color: '#d1d5db' }}>{fmt(t.price, t.currency)}</td>
                        <td style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 600 }}>{fmt(t.shares * t.price, t.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Position Detail Modal */}
      {selectedPosition && (
        <div style={styles.modal} onClick={() => setSelectedPosition(null)}>
          <div style={{ ...styles.modalContent, maxWidth: 700 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <div>
                <h3 style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>
                  {selectedPosition.symbol}
                  {selectedPosition.priceSource && <span style={{ fontSize: 12, color: '#6366f1', marginLeft: 12, fontWeight: 500 }}>● LIVE</span>}
                </h3>
                <p style={{ color: '#6b7280', margin: '6px 0 0', fontSize: 14 }}>{selectedPosition.type} • {selectedPosition.exchange || 'Unknown Exchange'}</p>
              </div>
              <button onClick={() => setSelectedPosition(null)} style={{ ...styles.btn, padding: '8px 14px', fontSize: 16 }}>✕</button>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
              <div style={{ padding: 20, borderRadius: 14, backgroundColor: '#0a0d14' }}>
                <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Shares Held</p>
                <p style={{ color: '#fff', fontSize: 24, fontWeight: 700, margin: '6px 0 0' }}>{selectedPosition.shares.toFixed(4)}</p>
              </div>
              <div style={{ padding: 20, borderRadius: 14, backgroundColor: '#0a0d14' }}>
                <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Average Cost</p>
                <p style={{ color: '#fff', fontSize: 24, fontWeight: 700, margin: '6px 0 0' }}>{fmt(selectedPosition.avgPrice, selectedPosition.currency)}</p>
              </div>
              <div style={{ padding: 20, borderRadius: 14, backgroundColor: '#0a0d14' }}>
                <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Current Price</p>
                <p style={{ color: '#fff', fontSize: 24, fontWeight: 700, margin: '6px 0 0' }}>{fmt(selectedPosition.currentPrice, selectedPosition.priceCurrency || selectedPosition.currency)}</p>
                {selectedPosition.priceChangePct !== undefined && selectedPosition.priceChangePct !== 0 && (
                  <p style={{ color: selectedPosition.priceChangePct >= 0 ? '#34d399' : '#f87171', fontSize: 13, margin: '4px 0 0' }}>
                    {selectedPosition.priceChangePct >= 0 ? '▲' : '▼'} {Math.abs(selectedPosition.priceChangePct).toFixed(2)}% today
                  </p>
                )}
              </div>
              <div style={{ padding: 20, borderRadius: 14, backgroundColor: '#0a0d14' }}>
                <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Market Value</p>
                <p style={{ color: '#fff', fontSize: 24, fontWeight: 700, margin: '6px 0 0' }}>{fmt(toEUR(selectedPosition.shares * selectedPosition.currentPrice, selectedPosition.priceCurrency || selectedPosition.currency))}</p>
              </div>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
              <div style={{ padding: 20, borderRadius: 14, backgroundColor: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)' }}>
                <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Cost Basis</p>
                <p style={{ color: '#fff', fontSize: 22, fontWeight: 600, margin: '6px 0 0' }}>{fmt(selectedPosition.shares * selectedPosition.avgPrice, selectedPosition.currency)}</p>
              </div>
              {gains.bySymbol.find(g => g.symbol === selectedPosition.symbol) && (
                <div style={{ padding: 20, borderRadius: 14, backgroundColor: gains.bySymbol.find(g => g.symbol === selectedPosition.symbol).unrealized >= 0 ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)', border: `1px solid ${gains.bySymbol.find(g => g.symbol === selectedPosition.symbol).unrealized >= 0 ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}` }}>
                  <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>Unrealized P&L</p>
                  <p style={{ color: gains.bySymbol.find(g => g.symbol === selectedPosition.symbol).unrealized >= 0 ? '#34d399' : '#f87171', fontSize: 22, fontWeight: 600, margin: '6px 0 0' }}>
                    {fmt(gains.bySymbol.find(g => g.symbol === selectedPosition.symbol).unrealized)}
                    <span style={{ fontSize: 14, fontWeight: 400, marginLeft: 8 }}>
                      ({((gains.bySymbol.find(g => g.symbol === selectedPosition.symbol).unrealized / (selectedPosition.shares * selectedPosition.avgPrice)) * 100).toFixed(1)}%)
                    </span>
                  </p>
                </div>
              )}
            </div>
            
            <h4 style={{ color: '#fff', marginBottom: 14, fontWeight: 600 }}>Transaction History</h4>
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {trades.filter(t => t.symbol === selectedPosition.symbol).sort((a, b) => new Date(b.date) - new Date(a.date)).map((t, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: 14, borderRadius: 10, backgroundColor: '#0a0d14', marginBottom: 8 }}>
                  <div>
                    <span style={{ padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, backgroundColor: t.type === 'buy' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)', color: t.type === 'buy' ? '#34d399' : '#f87171', marginRight: 10 }}>{t.type.toUpperCase()}</span>
                    <span style={{ color: '#9ca3af', fontSize: 13 }}>{fmtDate(t.date)}</span>
                  </div>
                  <span style={{ color: '#d1d5db', fontSize: 14 }}>{t.shares.toFixed(4)} @ {fmt(t.price, t.currency)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div style={styles.modal} onClick={() => setShowSettings(false)}>
          <div style={styles.modalContent} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 22, fontWeight: 700, marginBottom: 24 }}>⚙️ Settings</h3>
            
            <div style={{ marginBottom: 24, padding: 16, borderRadius: 12, backgroundColor: '#0a0d14' }}>
              <h4 style={{ color: '#fff', margin: '0 0 16px', fontSize: 16 }}>☁️ Supabase Connection</h4>
              <label style={styles.inputLabel}>Project URL</label>
              <input type="text" value={sbUrl} onChange={e => setSbUrl(e.target.value)} style={styles.input} placeholder="https://xxxxx.supabase.co" />
              <label style={styles.inputLabel}>Anon Key</label>
              <input type="password" value={sbKey} onChange={e => setSbKey(e.target.value)} style={styles.input} placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." />
              <label style={styles.inputLabel}>Table Name</label>
              <input type="text" value={sbTable} onChange={e => setSbTable(e.target.value)} style={{...styles.input, marginBottom: 0}} placeholder="transactions" />
            </div>
            
            <div style={{ marginBottom: 24, padding: 16, borderRadius: 12, backgroundColor: '#0a0d14' }}>
              <h4 style={{ color: '#fff', margin: '0 0 16px', fontSize: 16 }}>💹 Live Prices</h4>
              <label style={styles.inputLabel}>Finnhub API Key (optional, for US stocks)</label>
              <input type="password" value={finnhubKey} onChange={e => setFinnhubKey(e.target.value)} style={{...styles.input, marginBottom: 8}} placeholder="Enter your Finnhub API key..." />
              <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
                Get a free key at <a href="https://finnhub.io" target="_blank" rel="noopener noreferrer" style={{ color: '#6366f1' }}>finnhub.io</a> • Yahoo Finance is used as fallback for all stocks
              </p>
            </div>
            
            {source === 'supabase' && (
              <div style={{ padding: 14, borderRadius: 12, backgroundColor: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', marginBottom: 16 }}>
                <p style={{ fontSize: 13, color: '#34d399', margin: 0 }}>✅ Connected • {rawTx.length} transactions loaded</p>
              </div>
            )}
            
            <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
              <button onClick={() => setShowSettings(false)} style={{ ...styles.btn, flex: 1 }}>Cancel</button>
              <button onClick={saveSettings} style={{ ...styles.btnPrimary, flex: 1 }}>Save & Connect</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

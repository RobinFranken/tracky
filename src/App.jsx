import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, BarChart, Bar, ComposedChart, Legend } from 'recharts';

// ======================
// CONFIGURATION & CONSTANTS
// ======================

const ASSET_TYPES = ['Stock', 'ETF', 'Crypto', 'Fund', 'Bond'];
const CURRENCIES = ['EUR', 'USD'];
const FEE_TYPES = ['Transaction Fee', 'Custody Fee', 'Management Fee', 'Platform Fee', 'Currency Conversion', 'Other'];
const COLORS = ['#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#fb923c', '#fbbf24', '#4ade80', '#2dd4bf'];
const YEAR_COLORS = { 2022: '#f87171', 2023: '#fbbf24', 2024: '#34d399', 2025: '#818cf8', 2026: '#a78bfa' };

const TIMEFRAMES = [
  { key: '1W', label: '1W', days: 7 },
  { key: '1M', label: '1M', days: 30 },
  { key: '3M', label: '3M', days: 90 },
  { key: 'YTD', label: 'YTD', days: null },
  { key: '1Y', label: '1Y', days: 365 },
  { key: 'ALL', label: 'All', days: null }
];

const YEARS = [2022, 2023, 2024, 2025, 2026];

// ======================
// SUPABASE CONFIGURATION
// ======================

const SUPABASE_CONFIG = {
  url: '', // Set via settings modal or environment
  anonKey: '',
  tableName: 'transactions' // Single table for all transaction data
};

// Initialize from window config if available
if (typeof window !== 'undefined' && window.SUPABASE_CONFIG) {
  Object.assign(SUPABASE_CONFIG, window.SUPABASE_CONFIG);
}

// ======================
// SUPABASE SERVICE
// ======================

const SupabaseService = {
  client: null,
  isConfigured: false,
  tableName: 'transactions',

  init(url, anonKey, tableName = 'transactions') {
    if (!url || !anonKey) {
      this.isConfigured = false;
      return false;
    }
    this.client = {
      url: url.replace(/\/$/, ''),
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    };
    this.tableName = tableName;
    this.isConfigured = true;
    return true;
  },

  async request(endpoint, method = 'GET', body = null, query = '') {
    if (!this.isConfigured) throw new Error('Supabase not configured');
    const url = `${this.client.url}/rest/v1/${endpoint}${query}`;
    console.log(`Supabase request: ${method} ${url}`);
    
    try {
      const options = { method, headers: this.client.headers };
      if (body && (method === 'POST' || method === 'PATCH')) options.body = JSON.stringify(body);
      
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Supabase error response:', response.status, errorText);
        throw new Error(`Supabase ${response.status}: ${errorText || response.statusText}`);
      }
      
      if (method === 'DELETE') return { success: true };
      const data = await response.json();
      console.log(`Supabase response: ${data.length} records`);
      return data;
    } catch (error) {
      console.error('Supabase fetch error:', error);
      if (error.message.includes('Failed to fetch')) {
        throw new Error('Connection failed - check URL, table name, and that Supabase allows browser requests');
      }
      throw error;
    }
  },

  // Get all transactions from user's table
  async getTransactions() {
    return this.request(this.tableName, 'GET', null, '?select=*&order=transaction_date.desc');
  },

  // Insert new transaction
  async insertTransaction(transaction) {
    return this.request(this.tableName, 'POST', transaction);
  },

  // Process raw transactions into positions, trades, fees, dividends
  processTransactions(rawTransactions) {
    const positions = {};
    const trades = [];
    const fees = [];
    const dividends = [];
    
    // Sort by date ascending for proper position calculation
    const sorted = [...rawTransactions].sort((a, b) => 
      new Date(a.transaction_date) - new Date(b.transaction_date)
    );
    
    sorted.forEach((tx, index) => {
      const symbol = tx.symbol || '';
      const assetType = (tx.asset_type || '').toLowerCase();
      const txType = (tx.transaction_type || '').toLowerCase();
      const quantity = parseFloat(tx.quantity) || 0;
      const pricePerUnit = parseFloat(tx.price_per_unit) || 0;
      
      // Skip cash flow entries
      if (symbol.toLowerCase() === 'cash' || assetType === 'cash') return;
      
      // Handle Fees (symbol = 'Fee' or asset_type = 'Expense')
      if (symbol.toLowerCase() === 'fee' || assetType === 'expense') {
        fees.push({
          id: `fee-${index}`,
          type: 'Transaction Fee',
          amount: Math.abs(pricePerUnit),
          currency: tx.currency || 'EUR',
          date: tx.transaction_date,
          description: 'Trade fee',
          positionId: null
        });
        return;
      }
      
      // Handle Tax (withholding tax on dividends)
      if (assetType === 'tax' || txType === 'withholding tax') {
        fees.push({
          id: `tax-${index}`,
          type: 'Withholding Tax',
          amount: Math.abs(pricePerUnit),
          currency: tx.currency || 'EUR',
          date: tx.transaction_date,
          description: `Dividend withholding tax - ${symbol}`,
          positionId: null
        });
        return;
      }
      
      // Handle Dividends (asset_type or transaction_type = 'Cash Dividends')
      if (assetType === 'cash dividends' || txType === 'cash dividends') {
        const cleanSymbol = symbol.split(':')[0];
        // For dividends, price_per_unit is usually the total amount, quantity is often 0
        const dividendAmount = quantity === 0 ? Math.abs(pricePerUnit) : Math.abs(pricePerUnit * quantity);
        dividends.push({
          id: `div-${index}`,
          symbol: cleanSymbol,
          fullSymbol: symbol,
          amount: dividendAmount,
          currency: tx.currency || 'EUR',
          date: tx.transaction_date,
          type: 'Dividend'
        });
        return;
      }
      
      // Handle Stock/ETF trades (including Transfer in)
      const isTrade = ['stock', 'etf', 'equity'].includes(assetType) || 
                      ['buy', 'sell', 'transfer in', 'transfer out'].includes(txType);
      
      if (isTrade && pricePerUnit > 0) {
        const cleanSymbol = symbol.split(':')[0];
        const exchange = symbol.includes(':') ? symbol.split(':')[1].toUpperCase() : '';
        
        // Determine if buy or sell
        // Buy: positive quantity, or txType is 'buy' or 'transfer in'
        // Sell: negative quantity, or txType is 'sell' or 'transfer out'
        const isBuy = quantity > 0 || txType === 'buy' || txType === 'transfer in';
        const isSell = quantity < 0 || txType === 'sell' || txType === 'transfer out';
        
        const absQuantity = Math.abs(quantity);
        const absPrice = Math.abs(pricePerUnit);
        
        // Skip if no quantity
        if (absQuantity === 0) return;
        
        // Record trade
        trades.push({
          id: `trade-${index}`,
          symbol: cleanSymbol,
          fullSymbol: symbol,
          type: isBuy ? 'buy' : 'sell',
          shares: absQuantity,
          price: absPrice,
          date: tx.transaction_date,
          fee: 0,
          currency: tx.currency || 'EUR',
          exchange: exchange,
          originalType: txType
        });
        
        // Initialize position if needed
        if (!positions[cleanSymbol]) {
          positions[cleanSymbol] = {
            symbol: cleanSymbol,
            fullSymbol: symbol,
            name: cleanSymbol,
            type: assetType === 'etf' ? 'ETF' : 'Stock',
            shares: 0,
            totalCost: 0,
            avgPrice: 0,
            currency: tx.currency || 'EUR',
            exchange: exchange,
            trades: [],
            firstBuyDate: null
          };
        }
        
        const pos = positions[cleanSymbol];
        
        if (isBuy) {
          const newTotalCost = pos.totalCost + (absQuantity * absPrice);
          const newShares = pos.shares + absQuantity;
          pos.shares = newShares;
          pos.totalCost = newTotalCost;
          pos.avgPrice = newShares > 0 ? newTotalCost / newShares : 0;
          if (!pos.firstBuyDate) pos.firstBuyDate = tx.transaction_date;
        } else if (isSell) {
          // FIFO: reduce cost basis proportionally
          const costBasisSold = absQuantity * pos.avgPrice;
          pos.shares = Math.max(0, pos.shares - absQuantity);
          pos.totalCost = Math.max(0, pos.totalCost - costBasisSold);
          // avgPrice stays the same after sells
        }
        
        pos.trades.push(trades[trades.length - 1]);
      }
    });
    
    // Convert positions to array, filter out closed positions
    const positionsArray = Object.values(positions)
      .filter(p => p.shares > 0.0001)
      .map((p, index) => ({
        id: index + 1,
        symbol: p.symbol,
        fullSymbol: p.fullSymbol,
        name: p.symbol, // Will show symbol as name
        type: p.type,
        shares: p.shares,
        avgPrice: p.avgPrice,
        currentPrice: p.avgPrice, // Default to avgPrice, will be updated by API
        currency: p.currency,
        dividendYield: 0,
        exchange: p.exchange,
        purchaseDate: p.firstBuyDate,
        totalCost: p.totalCost
      }));
    
    console.log('Processed transactions:', {
      totalTx: rawTransactions.length,
      positions: positionsArray.length,
      trades: trades.length,
      fees: fees.length,
      dividends: dividends.length,
      totalDividendAmount: dividends.reduce((s, d) => s + d.amount, 0)
    });
    
    return { positions: positionsArray, trades, fees, dividends };
  }
};

// ======================
// HISTORICAL PRICE DATA (BACKTESTED)
// Realistic historical prices for each asset
// ======================

const HISTORICAL_PRICES = {
  'AMZN': {
    2022: { start: 170.40, end: 84.00, low: 81.43, high: 188.11, monthly: [170.40, 155.20, 162.80, 153.00, 140.20, 122.50, 115.00, 125.30, 113.00, 96.80, 92.50, 84.00] },
    2023: { start: 84.00, end: 151.94, low: 81.82, high: 155.00, monthly: [84.00, 94.50, 98.20, 103.50, 106.20, 120.30, 127.40, 133.50, 139.80, 127.40, 143.20, 151.94] },
    2024: { start: 151.94, end: 185.50, low: 144.50, high: 201.20, monthly: [151.94, 155.80, 168.20, 175.40, 180.30, 178.50, 182.40, 187.50, 183.20, 179.80, 188.40, 185.50] },
    2025: { start: 185.50, end: 218.94, low: 180.20, high: 225.00, monthly: [185.50, 192.30, 198.50, 205.40, 210.80, 215.20, 218.94, 218.94, 218.94, 218.94, 218.94, 218.94] },
    2026: { start: 218.94, end: 218.94, low: 210.50, high: 228.30, monthly: [218.94] }
  },
  'GOOGL': {
    2022: { start: 144.41, end: 88.73, low: 83.45, high: 151.55, monthly: [144.41, 135.20, 139.80, 128.50, 113.40, 108.20, 112.50, 118.30, 101.20, 94.80, 93.20, 88.73] },
    2023: { start: 88.73, end: 140.93, low: 83.34, high: 143.00, monthly: [88.73, 92.50, 98.40, 104.20, 108.80, 118.50, 125.40, 130.20, 128.80, 125.40, 135.80, 140.93] },
    2024: { start: 140.93, end: 178.35, low: 135.50, high: 191.75, monthly: [140.93, 145.80, 152.40, 160.50, 168.20, 172.80, 178.50, 182.40, 175.80, 168.50, 175.20, 178.35] },
    2025: { start: 178.35, end: 191.18, low: 172.40, high: 198.50, monthly: [178.35, 182.50, 188.40, 192.80, 189.50, 191.18, 191.18, 191.18, 191.18, 191.18, 191.18, 191.18] },
    2026: { start: 191.18, end: 191.18, low: 185.20, high: 198.80, monthly: [191.18] }
  },
  'NVDA': {
    2022: { start: 301.21, end: 146.14, low: 108.13, high: 307.55, monthly: [301.21, 245.80, 272.40, 228.50, 188.20, 162.50, 175.80, 182.40, 135.20, 121.80, 158.40, 146.14] },
    2023: { start: 146.14, end: 495.22, low: 140.28, high: 505.00, monthly: [146.14, 188.50, 225.40, 262.80, 305.50, 385.40, 425.80, 445.20, 428.50, 398.80, 465.40, 495.22] },
    2024: { start: 495.22, end: 124.50, low: 98.50, high: 152.89, monthly: [123.80, 128.40, 95.20, 85.50, 98.80, 118.50, 125.40, 132.80, 118.50, 108.40, 128.80, 124.50] }, // Post 10:1 split prices
    2025: { start: 124.50, end: 136.24, low: 118.20, high: 148.50, monthly: [124.50, 128.80, 135.40, 142.50, 138.20, 136.24, 136.24, 136.24, 136.24, 136.24, 136.24, 136.24] },
    2026: { start: 136.24, end: 136.24, low: 128.50, high: 145.80, monthly: [136.24] }
  },
  'BTC': {
    2022: { start: 46311, end: 16547, low: 15599, high: 48086, monthly: [46311, 43200, 38500, 45800, 38000, 29500, 19800, 23300, 24100, 19500, 20400, 16547] },
    2023: { start: 16547, end: 42258, low: 16500, high: 44700, monthly: [16547, 21500, 23200, 28400, 29200, 27100, 30500, 29400, 26100, 27200, 34500, 42258] },
    2024: { start: 42258, end: 93500, low: 38500, high: 99800, monthly: [42258, 45800, 52400, 71200, 64800, 60200, 58500, 64200, 59800, 63500, 68800, 93500] },
    2025: { start: 93500, end: 104892, low: 88200, high: 108500, monthly: [93500, 98200, 102400, 105800, 101200, 104892, 104892, 104892, 104892, 104892, 104892, 104892] },
    2026: { start: 104892, end: 104892, low: 98500, high: 112400, monthly: [104892] }
  },
  'ETH': {
    2022: { start: 3688, end: 1196, low: 896, high: 3876, monthly: [3688, 3150, 2800, 3520, 2850, 1950, 1050, 1420, 1580, 1320, 1280, 1196] },
    2023: { start: 1196, end: 2281, low: 1180, high: 2445, monthly: [1196, 1520, 1680, 1820, 1920, 1850, 1920, 1880, 1650, 1640, 1820, 2281] },
    2024: { start: 2281, end: 3350, low: 2150, high: 4080, monthly: [2281, 2580, 2950, 3450, 3250, 3020, 3180, 3420, 2850, 2650, 3080, 3350] },
    2025: { start: 3350, end: 3284.50, low: 3050, high: 3680, monthly: [3350, 3480, 3550, 3620, 3380, 3284.50, 3284.50, 3284.50, 3284.50, 3284.50, 3284.50, 3284.50] },
    2026: { start: 3284.50, end: 3284.50, low: 3120, high: 3520, monthly: [3284.50] }
  },
  '4COP': {
    2022: { start: 45.20, end: 32.80, low: 28.50, high: 48.20, monthly: [45.20, 42.80, 44.50, 41.20, 38.50, 35.20, 32.80, 34.50, 35.80, 33.20, 32.50, 32.80] },
    2023: { start: 32.80, end: 38.50, low: 31.20, high: 42.80, monthly: [32.80, 33.50, 35.20, 36.80, 38.20, 40.50, 42.20, 40.80, 38.50, 36.20, 37.80, 38.50] },
    2024: { start: 38.50, end: 41.20, low: 35.80, high: 45.50, monthly: [38.50, 39.80, 41.20, 43.50, 44.80, 42.50, 40.80, 39.50, 38.20, 39.80, 41.50, 41.20] },
    2025: { start: 41.20, end: 42.85, low: 38.50, high: 45.20, monthly: [41.20, 42.50, 43.80, 44.50, 43.20, 42.85, 42.85, 42.85, 42.85, 42.85, 42.85, 42.85] },
    2026: { start: 42.85, end: 42.85, low: 40.50, high: 44.80, monthly: [42.85] }
  }
};

// ======================
// API SERVICE (MOCK)
// ======================

const APIService = {
  exchangeRates: { 'EUR/USD': 1.0856, 'USD/EUR': 0.9211, lastUpdated: new Date().toISOString() },

  async fetchPrices(symbols) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const mockPrices = {
      'AMZN': { price: 218.94, change: 2.34, changePercent: 1.08, currency: 'USD' },
      'GOOGL': { price: 191.18, change: -0.87, changePercent: -0.45, currency: 'USD' },
      'NVDA': { price: 136.24, change: 4.12, changePercent: 3.12, currency: 'USD' },
      'BTC': { price: 104892.00, change: 1523.00, changePercent: 1.47, currency: 'USD' },
      'ETH': { price: 3284.50, change: -45.20, changePercent: -1.36, currency: 'USD' },
      '4COP': { price: 42.85, change: 0.65, changePercent: 1.54, currency: 'EUR' }
    };
    return symbols.reduce((acc, symbol) => {
      acc[symbol] = mockPrices[symbol] || { price: 100, change: 0, changePercent: 0, currency: 'USD' };
      return acc;
    }, {});
  },

  async fetchDividendSchedule(symbols) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const dividendData = {
      'AMZN': { yield: 0, frequency: null, nextDate: null, amount: 0 },
      'GOOGL': { yield: 0.45, frequency: 'Quarterly', nextDate: '2025-03-15', amount: 0.20 },
      'NVDA': { yield: 0.03, frequency: 'Quarterly', nextDate: '2025-03-27', amount: 0.01 },
      '4COP': { yield: 2.85, frequency: 'Quarterly', nextDate: '2025-02-15', amount: 0.32 }
    };
    return symbols.reduce((acc, symbol) => {
      acc[symbol] = dividendData[symbol] || { yield: 0, frequency: null, nextDate: null, amount: 0 };
      return acc;
    }, {});
  },

  getExchangeRate(from, to) {
    if (from === to) return 1;
    return from === 'USD' ? 0.9211 : 1.0856;
  }
};

// ======================
// INITIAL DATA
// ======================

const INITIAL_PORTFOLIO = [
  { id: 1, symbol: 'AMZN', name: 'Amazon.com Inc.', type: 'Stock', shares: 15, avgPrice: 165.20, currentPrice: 218.94, currency: 'USD', dividendYield: 0, purchaseDate: '2024-01-10' },
  { id: 2, symbol: 'GOOGL', name: 'Alphabet Inc.', type: 'Stock', shares: 20, avgPrice: 138.50, currentPrice: 191.18, currency: 'USD', dividendYield: 0.45, purchaseDate: '2024-01-22' },
  { id: 3, symbol: 'NVDA', name: 'NVIDIA Corporation', type: 'Stock', shares: 25, avgPrice: 86.60, currentPrice: 136.24, currency: 'USD', dividendYield: 0.03, purchaseDate: '2023-11-08' },
  { id: 4, symbol: 'BTC', name: 'Bitcoin', type: 'Crypto', shares: 0.1, avgPrice: 58500.00, currentPrice: 104892.00, currency: 'USD', dividendYield: 0, purchaseDate: '2024-02-14' },
  { id: 5, symbol: 'ETH', name: 'Ethereum', type: 'Crypto', shares: 2, avgPrice: 2650.00, currentPrice: 3284.50, currency: 'USD', dividendYield: 0, purchaseDate: '2024-04-01' },
  { id: 6, symbol: '4COP', name: 'Global X Copper Miners ETF', type: 'ETF', shares: 1, avgPrice: 38.20, currentPrice: 42.85, currency: 'EUR', dividendYield: 2.85, purchaseDate: '2024-06-10' }
];

const INITIAL_TRADES = [
  // AMZN trades
  { id: 1, positionId: 1, type: 'buy', shares: 20, price: 165.20, date: '2024-01-10', fee: 4.99 },
  { id: 2, positionId: 1, type: 'sell', shares: 5, price: 185.40, date: '2024-06-15', fee: 4.99 }, // Realized gain
  // GOOGL trades
  { id: 3, positionId: 2, type: 'buy', shares: 25, price: 138.50, date: '2024-01-22', fee: 4.99 },
  { id: 4, positionId: 2, type: 'sell', shares: 5, price: 172.80, date: '2024-09-10', fee: 4.99 }, // Realized gain
  // NVDA trades
  { id: 5, positionId: 3, type: 'buy', shares: 10, price: 95.20, date: '2023-11-08', fee: 4.99 },
  { id: 6, positionId: 3, type: 'buy', shares: 20, price: 84.45, date: '2024-02-20', fee: 4.99 },
  { id: 7, positionId: 3, type: 'sell', shares: 5, price: 125.60, date: '2024-08-05', fee: 4.99 }, // Realized gain
  // BTC trades
  { id: 8, positionId: 4, type: 'buy', shares: 0.15, price: 58500.00, date: '2024-02-14', fee: 12.50 },
  { id: 9, positionId: 4, type: 'sell', shares: 0.05, price: 72000.00, date: '2024-05-20', fee: 8.50 }, // Realized gain
  // ETH trades
  { id: 10, positionId: 5, type: 'buy', shares: 3, price: 2650.00, date: '2024-04-01', fee: 8.75 },
  { id: 11, positionId: 5, type: 'sell', shares: 1, price: 3150.00, date: '2024-11-15', fee: 6.50 }, // Realized gain
  // 4COP trades
  { id: 12, positionId: 6, type: 'buy', shares: 1, price: 38.20, date: '2024-06-10', fee: 2.00 }
];

const INITIAL_FEES = [
  { id: 1, type: 'Custody Fee', amount: 2.50, currency: 'EUR', date: '2024-01-31', description: 'Monthly custody fee', positionId: null },
  { id: 2, type: 'Custody Fee', amount: 2.50, currency: 'EUR', date: '2024-02-29', description: 'Monthly custody fee', positionId: null },
  { id: 3, type: 'Custody Fee', amount: 2.50, currency: 'EUR', date: '2024-03-31', description: 'Monthly custody fee', positionId: null },
  { id: 4, type: 'Custody Fee', amount: 2.50, currency: 'EUR', date: '2024-04-30', description: 'Monthly custody fee', positionId: null },
  { id: 5, type: 'Custody Fee', amount: 2.50, currency: 'EUR', date: '2024-05-31', description: 'Monthly custody fee', positionId: null },
  { id: 6, type: 'Custody Fee', amount: 2.50, currency: 'EUR', date: '2024-06-30', description: 'Monthly custody fee', positionId: null },
  { id: 7, type: 'Currency Conversion', amount: 8.45, currency: 'EUR', date: '2024-03-15', description: 'EUR/USD conversion for AMZN', positionId: 1 },
  { id: 8, type: 'Currency Conversion', amount: 6.20, currency: 'EUR', date: '2024-01-22', description: 'EUR/USD conversion for GOOGL', positionId: 2 },
  { id: 9, type: 'Platform Fee', amount: 12.00, currency: 'EUR', date: '2024-06-30', description: 'Quarterly platform fee', positionId: null },
  { id: 10, type: 'Management Fee', amount: 4.85, currency: 'EUR', date: '2024-06-30', description: 'ETF management fee pass-through', positionId: 6 },
];

// ======================
// UTILITY FUNCTIONS
// ======================

const formatCurrency = (value, currency = 'EUR') => new Intl.NumberFormat('nl-NL', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const formatPercent = (value, showSign = true) => `${showSign && value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const formatNumber = (value, decimals = 2) => new Intl.NumberFormat('nl-NL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
const formatDate = (dateStr) => new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const toEUR = (value, currency) => currency === 'EUR' ? value : value * APIService.getExchangeRate('USD', 'EUR');
const saveToStorage = (key, data) => localStorage.setItem(key, JSON.stringify(data));
const loadFromStorage = (key, defaultValue) => { const stored = localStorage.getItem(key); return stored ? JSON.parse(stored) : defaultValue; };

const exportToCSV = (positions, trades) => {
  const positionCSV = ['symbol,name,type,shares,avg_price,current_price,currency,dividend_yield', ...positions.map(p => `${p.symbol},${p.name},${p.type},${p.shares},${p.avgPrice},${p.currentPrice},${p.currency},${p.dividendYield}`)].join('\n');
  const tradeCSV = ['date,symbol,type,shares,price,fee', ...trades.map(t => { const pos = positions.find(p => p.id === t.positionId); return `${t.date},${pos?.symbol || 'Unknown'},${t.type},${t.shares},${t.price},${t.fee || 0}`; })].join('\n');
  return { positions: positionCSV, trades: tradeCSV };
};

const downloadCSV = (content, filename) => { const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); };

const parseCSV = (csvText, type = 'positions') => {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(delimiter).map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  const results = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = [];
    let current = '', inQuotes = false;
    for (const char of lines[i]) {
      if (char === '"' || char === "'") inQuotes = !inQuotes;
      else if (char === delimiter && !inQuotes) { values.push(current.trim()); current = ''; }
      else current += char;
    }
    values.push(current.trim());
    
    if (type === 'transactions') {
      // Parse Supabase-style transaction format
      const tx = {};
      headers.forEach((header, index) => {
        const value = values[index] || '';
        if (['symbol'].includes(header)) tx.symbol = value;
        else if (['quantity'].includes(header)) tx.quantity = parseFloat(value.replace(',', '.')) || 0;
        else if (['price_per_unit', 'price'].includes(header)) tx.price_per_unit = parseFloat(value.replace(',', '.')) || 0;
        else if (['asset_type', 'type'].includes(header)) tx.asset_type = value;
        else if (['transaction_type', 'side', 'action'].includes(header)) tx.transaction_type = value;
        else if (['transaction_date', 'date'].includes(header)) tx.transaction_date = value;
        else if (['currency', 'ccy'].includes(header)) tx.currency = value.toUpperCase() || 'EUR';
      });
      if (tx.symbol) results.push(tx);
    } else if (type === 'positions') {
      const position = {};
      headers.forEach((header, index) => {
        const value = values[index] || '';
        if (['symbol', 'ticker', 'isin', 'code'].includes(header)) position.symbol = value.toUpperCase();
        else if (['name', 'description', 'security'].includes(header)) position.name = value;
        else if (['type', 'asset_type', 'category'].includes(header)) {
          const typeMap = { 'stock': 'Stock', 'equity': 'Stock', 'etf': 'ETF', 'crypto': 'Crypto', 'bond': 'Bond', 'fund': 'Fund' };
          position.type = typeMap[value.toLowerCase()] || value || 'Stock';
        }
        else if (['shares', 'quantity', 'units', 'amount', 'qty'].includes(header)) position.shares = parseFloat(value.replace(',', '.')) || 0;
        else if (['avg_price', 'average_price', 'cost_basis', 'price', 'cost'].includes(header)) position.avgPrice = parseFloat(value.replace(',', '.')) || 0;
        else if (['currency', 'ccy'].includes(header)) position.currency = value.toUpperCase() || 'EUR';
        else if (['dividend', 'dividend_yield', 'yield'].includes(header)) position.dividendYield = parseFloat(value.replace(',', '.')) || 0;
        else if (['date', 'purchase_date'].includes(header)) position.purchaseDate = value;
      });
      if (position.symbol && position.shares) {
        position.id = Date.now() + Math.random();
        position.currentPrice = position.avgPrice;
        position.type = position.type || 'Stock';
        position.currency = position.currency || 'EUR';
        position.name = position.name || position.symbol;
        results.push(position);
      }
    } else if (type === 'trades') {
      const trade = {};
      headers.forEach((header, index) => {
        const value = values[index] || '';
        if (['symbol', 'ticker', 'isin'].includes(header)) trade.symbol = value.toUpperCase();
        else if (['type', 'side', 'action'].includes(header)) {
          const typeMap = { 'buy': 'buy', 'sell': 'sell', 'purchase': 'buy', 'sale': 'sell', 'koop': 'buy', 'verkoop': 'sell' };
          trade.type = typeMap[value.toLowerCase()] || 'buy';
        }
        else if (['shares', 'quantity', 'units', 'qty'].includes(header)) trade.shares = Math.abs(parseFloat(value.replace(',', '.'))) || 0;
        else if (['price', 'unit_price'].includes(header)) trade.price = parseFloat(value.replace(',', '.')) || 0;
        else if (['date', 'trade_date'].includes(header)) trade.date = value;
        else if (['fee', 'commission', 'cost'].includes(header)) trade.fee = parseFloat(value.replace(',', '.')) || 0;
      });
      if (trade.symbol && trade.shares && trade.price) {
        trade.id = Date.now() + Math.random();
        trade.date = trade.date || new Date().toISOString().split('T')[0];
        results.push(trade);
      }
    }
  }
  return results;
};

// Generate yearly portfolio performance data
const generateYearlyPerformance = (positions) => {
  const yearlyData = {};
  
  YEARS.forEach(year => {
    const monthlyValues = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth();
    
    const monthsToShow = year === currentYear ? currentMonth + 1 : 12;
    
    for (let month = 0; month < monthsToShow; month++) {
      let portfolioValue = 0;
      positions.forEach(p => {
        const historicalData = HISTORICAL_PRICES[p.symbol]?.[year];
        if (historicalData && historicalData.monthly[month] !== undefined) {
          const price = historicalData.monthly[month];
          portfolioValue += toEUR(p.shares * price, p.currency);
        }
      });
      monthlyValues.push({ month: monthNames[month], value: portfolioValue });
    }
    
    let startValue = 0, endValue = 0;
    positions.forEach(p => {
      const historicalData = HISTORICAL_PRICES[p.symbol]?.[year];
      if (historicalData) {
        startValue += toEUR(p.shares * historicalData.start, p.currency);
        endValue += toEUR(p.shares * historicalData.end, p.currency);
      }
    });
    
    const returnPct = startValue > 0 ? ((endValue - startValue) / startValue) * 100 : 0;
    const returnValue = endValue - startValue;
    
    yearlyData[year] = {
      startValue,
      endValue,
      returnPct,
      returnValue,
      monthlyData: monthlyValues,
      isYTD: year === currentYear
    };
  });
  
  return yearlyData;
};

// Generate position-level yearly performance
const generatePositionYearlyPerformance = (positions) => {
  const positionYearlyData = {};
  
  positions.forEach(p => {
    positionYearlyData[p.symbol] = {};
    YEARS.forEach(year => {
      const historicalData = HISTORICAL_PRICES[p.symbol]?.[year];
      if (historicalData) {
        const startValue = p.shares * historicalData.start;
        const endValue = p.shares * historicalData.end;
        const returnPct = historicalData.start > 0 ? ((historicalData.end - historicalData.start) / historicalData.start) * 100 : 0;
        
        positionYearlyData[p.symbol][year] = {
          startPrice: historicalData.start,
          endPrice: historicalData.end,
          startValue: toEUR(startValue, p.currency),
          endValue: toEUR(endValue, p.currency),
          returnPct,
          returnValue: toEUR(endValue - startValue, p.currency),
          high: historicalData.high,
          low: historicalData.low
        };
      }
    });
  });
  
  return positionYearlyData;
};

const generatePortfolioHistory = (positions, days) => {
  const data = [];
  const now = new Date();
  const currentTotal = positions.reduce((sum, p) => sum + toEUR(p.shares * p.currentPrice, p.currency), 0);
  let value = currentTotal;
  const dailyReturns = [];
  for (let i = 0; i < days; i++) dailyReturns.push((Math.random() - 0.48) * 0.025);
  for (let i = days; i >= 0; i--) {
    const date = new Date(now); date.setDate(date.getDate() - i);
    if (i === days) value = currentTotal / dailyReturns.reduce((acc, r) => acc * (1 + r), 1);
    else value = value * (1 + dailyReturns[days - i - 1]);
    data.push({ date: date.toISOString().split('T')[0], displayDate: date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), value: Math.round(value * 100) / 100 });
  }
  return data;
};

// ======================
// MAIN COMPONENT
// ======================

export default function PortfolioDashboard() {
  const [positions, setPositions] = useState([]);
  const [trades, setTrades] = useState([]);
  const [fees, setFees] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedTimeframe, setSelectedTimeframe] = useState('1M');
  const [selectedYear, setSelectedYear] = useState(2024);
  const [historicalData, setHistoricalData] = useState([]);
  const [dividendSchedule, setDividendSchedule] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [exchangeRate, setExchangeRate] = useState({ rate: 0.9211, lastUpdated: null });
  
  const [showAddModal, setShowAddModal] = useState(false);
  const [showTradeModal, setShowTradeModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showFeeModal, setShowFeeModal] = useState(false);
  const [selectedPosition, setSelectedPosition] = useState(null);
  
  const [newPosition, setNewPosition] = useState({ symbol: '', name: '', type: 'Stock', shares: '', avgPrice: '', currency: 'EUR', dividendYield: '' });
  const [newTrade, setNewTrade] = useState({ positionId: '', type: 'buy', shares: '', price: '', date: new Date().toISOString().split('T')[0], fee: '' });
  const [newFee, setNewFee] = useState({ type: 'Transaction Fee', amount: '', currency: 'EUR', date: new Date().toISOString().split('T')[0], description: '', positionId: '' });
  const [csvText, setCsvText] = useState('');
  const [importType, setImportType] = useState('transactions');
  const [dataSource, setDataSource] = useState('local');
  const [syncStatus, setSyncStatus] = useState({ status: 'idle', message: '' });
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [supabaseUrl, setSupabaseUrl] = useState(loadFromStorage('supabase_url', ''));
  const [supabaseKey, setSupabaseKey] = useState(loadFromStorage('supabase_key', ''));
  const [supabaseTable, setSupabaseTable] = useState(loadFromStorage('supabase_table', 'transactions'));
  const [receivedDividends, setReceivedDividends] = useState([]);
  const [rawTransactions, setRawTransactions] = useState([]);

  useEffect(() => {
    const initializeData = async () => {
      setIsLoading(true);
      
      // Try Supabase first
      const url = supabaseUrl || SUPABASE_CONFIG.url;
      const key = supabaseKey || SUPABASE_CONFIG.anonKey;
      const table = supabaseTable || SUPABASE_CONFIG.tableName || 'transactions';
      
      if (url && key && SupabaseService.init(url, key, table)) {
        try {
          const rawTx = await SupabaseService.getTransactions();
          if (rawTx && rawTx.length > 0) {
            setRawTransactions(rawTx);
            const processed = SupabaseService.processTransactions(rawTx);
            setPositions(processed.positions);
            setTrades(processed.trades);
            setFees(processed.fees);
            setReceivedDividends(processed.dividends);
            setDataSource('supabase');
            await refreshData(processed.positions);
            setIsLoading(false);
            console.log(`Loaded ${rawTx.length} transactions from Supabase, ${processed.positions.length} positions`);
            return;
          }
        } catch (e) { console.log('Supabase failed, using local:', e); }
      }
      
      // Fallback to local
      let storedPositions = loadFromStorage('portfolio_positions_v6', null);
      let storedTrades = loadFromStorage('portfolio_trades_v6', null);
      let storedFees = loadFromStorage('portfolio_fees_v6', null);
      if (!storedPositions) { storedPositions = INITIAL_PORTFOLIO; storedTrades = INITIAL_TRADES; storedFees = INITIAL_FEES; }
      setPositions(storedPositions); setTrades(storedTrades || []); setFees(storedFees || []);
      setDataSource('local');
      await refreshData(storedPositions);
      setIsLoading(false);
    };
    initializeData();
  }, [supabaseUrl, supabaseKey, supabaseTable]);

  const refreshData = async (positionsToRefresh = positions) => {
    try {
      const symbols = positionsToRefresh.map(p => p.symbol);
      const prices = await APIService.fetchPrices(symbols);
      const updatedPositions = positionsToRefresh.map(p => ({ ...p, currentPrice: prices[p.symbol]?.price || p.currentPrice, priceChange: prices[p.symbol]?.change || 0, priceChangePercent: prices[p.symbol]?.changePercent || 0 }));
      setPositions(updatedPositions);
      const dividends = await APIService.fetchDividendSchedule(symbols);
      setDividendSchedule(dividends);
      setExchangeRate({ rate: APIService.getExchangeRate('USD', 'EUR'), lastUpdated: new Date().toISOString() });
      setLastUpdated(new Date());
      return updatedPositions;
    } catch (error) { console.error('Error refreshing data:', error); }
  };

  useEffect(() => {
    if (positions.length === 0) return;
    const timeframe = TIMEFRAMES.find(t => t.key === selectedTimeframe);
    let days = timeframe?.days || 30;
    if (selectedTimeframe === 'YTD') { const now = new Date(); const startOfYear = new Date(now.getFullYear(), 0, 1); days = Math.ceil((now - startOfYear) / (1000 * 60 * 60 * 24)); }
    else if (selectedTimeframe === 'ALL') days = 365 * 2;
    const history = generatePortfolioHistory(positions, days);
    setHistoricalData(history);
  }, [positions, selectedTimeframe]);

  useEffect(() => { if (positions.length > 0) saveToStorage('portfolio_positions_v6', positions); }, [positions]);
  useEffect(() => { if (trades.length > 0) saveToStorage('portfolio_trades_v6', trades); }, [trades]);
  useEffect(() => { if (fees.length > 0) saveToStorage('portfolio_fees_v6', fees); }, [fees]);

  const syncFromSupabase = async () => {
    if (!SupabaseService.isConfigured) { setSyncStatus({ status: 'error', message: 'Supabase not configured' }); return; }
    setSyncStatus({ status: 'syncing', message: `Loading from table "${SupabaseService.tableName}"...` });
    try {
      const rawTx = await SupabaseService.getTransactions();
      if (rawTx && rawTx.length > 0) {
        setRawTransactions(rawTx);
        const processed = SupabaseService.processTransactions(rawTx);
        setPositions(processed.positions);
        setTrades(processed.trades);
        setFees(processed.fees);
        setReceivedDividends(processed.dividends);
        setDataSource('supabase');
        await refreshData(processed.positions);
        setSyncStatus({ status: 'success', message: `✓ Loaded ${rawTx.length} transactions → ${processed.positions.length} positions` });
      } else {
        setSyncStatus({ status: 'error', message: 'No transactions found in table' });
      }
    } catch (e) { 
      console.error('Sync error:', e);
      setSyncStatus({ status: 'error', message: e.message }); 
    }
    setTimeout(() => setSyncStatus({ status: 'idle', message: '' }), 5000);
  };

  const saveSupabaseSettings = () => {
    saveToStorage('supabase_url', supabaseUrl);
    saveToStorage('supabase_key', supabaseKey);
    saveToStorage('supabase_table', supabaseTable);
    if (supabaseUrl && supabaseKey) {
      SupabaseService.init(supabaseUrl, supabaseKey, supabaseTable);
      // Trigger reload
      syncFromSupabase();
    }
    setShowSettingsModal(false);
  };

  const totalFeesEUR = useMemo(() => {
    let total = 0;
    fees.forEach(f => { total += toEUR(f.amount, f.currency); });
    trades.forEach(t => { if (t.fee) { const position = positions.find(p => p.id === t.positionId); total += toEUR(t.fee, position?.currency || 'EUR'); } });
    return total;
  }, [fees, trades, positions]);

  const portfolioMetrics = useMemo(() => {
    let totalValue = 0, totalCost = 0, projectedDividends = 0, dayChange = 0;
    positions.forEach(p => {
      const currentValue = p.shares * p.currentPrice; const costBasis = p.shares * p.avgPrice;
      const annualDividend = currentValue * (p.dividendYield / 100); const dailyChange = p.shares * (p.priceChange || 0);
      totalValue += toEUR(currentValue, p.currency); totalCost += toEUR(costBasis, p.currency);
      projectedDividends += toEUR(annualDividend, p.currency); dayChange += toEUR(dailyChange, p.currency);
    });
    // Sum actual received dividends from transactions
    const totalReceivedDividends = receivedDividends.reduce((sum, d) => sum + toEUR(d.amount, d.currency), 0);
    const grossReturn = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;
    const grossGainLoss = totalValue - totalCost; const netGainLoss = grossGainLoss - totalFeesEUR;
    const netReturn = totalCost > 0 ? ((totalValue - totalCost - totalFeesEUR) / totalCost) * 100 : 0;
    const dividendYield = totalValue > 0 ? (projectedDividends / totalValue) * 100 : 0;
    const dayChangePercent = (totalValue - dayChange) > 0 ? (dayChange / (totalValue - dayChange)) * 100 : 0;
    let periodReturn = 0, periodReturnPercent = 0;
    if (historicalData.length >= 2) { const startValue = historicalData[0].value; const endValue = historicalData[historicalData.length - 1].value; periodReturn = endValue - startValue; periodReturnPercent = startValue > 0 ? ((endValue - startValue) / startValue) * 100 : 0; }
    return { totalValue, totalCost, grossReturn, grossGainLoss, netReturn, netGainLoss, totalFees: totalFeesEUR, totalDividends: totalReceivedDividends, projectedDividends, dividendYield, dayChange, dayChangePercent, periodReturn, periodReturnPercent };
  }, [positions, historicalData, totalFeesEUR, receivedDividends]);

  const yearlyPerformance = useMemo(() => generateYearlyPerformance(positions), [positions]);
  const positionYearlyPerformance = useMemo(() => generatePositionYearlyPerformance(positions), [positions]);

  const allocationData = useMemo(() => {
    const byType = {}; positions.forEach(p => { const value = toEUR(p.shares * p.currentPrice, p.currency); byType[p.type] = (byType[p.type] || 0) + value; });
    return Object.entries(byType).map(([name, value]) => ({ name, value }));
  }, [positions]);

  const positionsWithMetrics = useMemo(() => {
    return positions.map(p => {
      const currentValue = p.shares * p.currentPrice; const costBasis = p.shares * p.avgPrice;
      const gainLoss = currentValue - costBasis; const returnPct = ((p.currentPrice - p.avgPrice) / p.avgPrice) * 100;
      const valueEUR = toEUR(currentValue, p.currency); const weight = portfolioMetrics.totalValue > 0 ? (valueEUR / portfolioMetrics.totalValue) * 100 : 0;
      const positionFees = fees.filter(f => f.positionId === p.id).reduce((sum, f) => sum + toEUR(f.amount, f.currency), 0);
      const positionTradeFees = trades.filter(t => t.positionId === p.id && t.fee).reduce((sum, t) => sum + toEUR(t.fee, p.currency), 0);
      const totalPositionFees = positionFees + positionTradeFees; const netGainLoss = gainLoss - totalPositionFees;
      const netReturnPct = costBasis > 0 ? ((currentValue - costBasis - totalPositionFees) / costBasis) * 100 : 0;
      return { ...p, currentValue, costBasis, gainLoss, returnPct, valueEUR, weight, gainLossEUR: toEUR(gainLoss, p.currency), totalFees: totalPositionFees, netGainLoss: toEUR(netGainLoss, p.currency), netReturnPct };
    }).sort((a, b) => b.valueEUR - a.valueEUR);
  }, [positions, portfolioMetrics.totalValue, fees, trades]);

  const dividendCalendar = useMemo(() => {
    const calendar = [];
    positions.forEach(p => {
      const divInfo = dividendSchedule[p.symbol];
      if (divInfo && divInfo.nextDate && divInfo.amount > 0) {
        const annualAmount = p.shares * divInfo.amount * (divInfo.frequency === 'Quarterly' ? 4 : 12);
        calendar.push({ symbol: p.symbol, name: p.name, nextDate: divInfo.nextDate, frequency: divInfo.frequency, amountPerShare: divInfo.amount, expectedAmount: p.shares * divInfo.amount, expectedAmountEUR: toEUR(p.shares * divInfo.amount, p.currency), annualAmount, annualAmountEUR: toEUR(annualAmount, p.currency), currency: p.currency });
      }
    });
    return calendar.sort((a, b) => new Date(a.nextDate) - new Date(b.nextDate));
  }, [positions, dividendSchedule]);

  const monthlyDividendProjection = useMemo(() => {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return monthNames.map((month, i) => {
      let monthTotal = 0;
      dividendCalendar.forEach(div => {
        if (div.frequency === 'Quarterly') {
          const nextMonth = new Date(div.nextDate).getMonth();
          const paymentMonths = [nextMonth, (nextMonth + 3) % 12, (nextMonth + 6) % 12, (nextMonth + 9) % 12];
          if (paymentMonths.includes(i)) monthTotal += div.expectedAmountEUR;
        }
      });
      return { month, amount: monthTotal };
    });
  }, [dividendCalendar]);

  const feeBreakdown = useMemo(() => {
    const breakdown = {};
    fees.forEach(f => { if (!breakdown[f.type]) breakdown[f.type] = 0; breakdown[f.type] += toEUR(f.amount, f.currency); });
    const tradeFees = trades.reduce((sum, t) => { if (t.fee) { const position = positions.find(p => p.id === t.positionId); return sum + toEUR(t.fee, position?.currency || 'EUR'); } return sum; }, 0);
    if (tradeFees > 0) breakdown['Transaction Fee'] = (breakdown['Transaction Fee'] || 0) + tradeFees;
    return Object.entries(breakdown).map(([type, amount]) => ({ type, amount })).sort((a, b) => b.amount - a.amount);
  }, [fees, trades, positions]);

  const monthlyFeeData = useMemo(() => {
    const monthlyData = {}; const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    fees.forEach(f => { const month = new Date(f.date).getMonth(); const monthKey = monthNames[month]; if (!monthlyData[monthKey]) monthlyData[monthKey] = 0; monthlyData[monthKey] += toEUR(f.amount, f.currency); });
    trades.forEach(t => { if (t.fee) { const month = new Date(t.date).getMonth(); const monthKey = monthNames[month]; const position = positions.find(p => p.id === t.positionId); if (!monthlyData[monthKey]) monthlyData[monthKey] = 0; monthlyData[monthKey] += toEUR(t.fee, position?.currency || 'EUR'); } });
    return monthNames.map(month => ({ month, amount: monthlyData[month] || 0 }));
  }, [fees, trades, positions]);

  const getPositionTrades = (positionId) => trades.filter(t => t.positionId === positionId).sort((a, b) => new Date(b.date) - new Date(a.date));
  const getPositionFees = (positionId) => fees.filter(f => f.positionId === positionId).sort((a, b) => new Date(b.date) - new Date(a.date));

  // Calculate Realized vs Unrealized Gains using FIFO method
  const gainsAnalysis = useMemo(() => {
    const positionGains = [];
    let totalRealizedGain = 0;
    let totalRealizedGainPreFees = 0;
    let totalUnrealizedGain = 0;
    let totalRealizedFees = 0;
    let totalCostBasisSold = 0;
    let totalProceedsFromSales = 0;
    
    const realizedByYear = {};
    const unrealizedByYear = {};
    
    positions.forEach(position => {
      const positionTrades = trades
        .filter(t => t.positionId === position.id)
        .sort((a, b) => new Date(a.date) - new Date(b.date)); // Sort chronologically for FIFO
      
      // Build tax lots from buys
      const taxLots = [];
      const sellTransactions = [];
      let positionRealizedGain = 0;
      let positionRealizedGainPreFees = 0;
      let positionRealizedFees = 0;
      let positionCostBasisSold = 0;
      let positionProceeds = 0;
      
      positionTrades.forEach(trade => {
        if (trade.type === 'buy') {
          taxLots.push({
            id: trade.id,
            date: trade.date,
            shares: trade.shares,
            remainingShares: trade.shares,
            price: trade.price,
            fee: trade.fee || 0,
            costBasisPerShare: trade.price + ((trade.fee || 0) / trade.shares)
          });
        } else if (trade.type === 'sell') {
          let sharesToSell = trade.shares;
          const saleProceeds = trade.shares * trade.price;
          const saleFee = trade.fee || 0;
          let costBasisForSale = 0;
          const lotsUsed = [];
          
          // FIFO: Use oldest lots first
          for (let i = 0; i < taxLots.length && sharesToSell > 0; i++) {
            const lot = taxLots[i];
            if (lot.remainingShares > 0) {
              const sharesToUseFromLot = Math.min(lot.remainingShares, sharesToSell);
              costBasisForSale += sharesToUseFromLot * lot.costBasisPerShare;
              lot.remainingShares -= sharesToUseFromLot;
              sharesToSell -= sharesToUseFromLot;
              lotsUsed.push({
                lotId: lot.id,
                lotDate: lot.date,
                shares: sharesToUseFromLot,
                costBasis: lot.costBasisPerShare
              });
            }
          }
          
          const realizedGainPreFees = saleProceeds - costBasisForSale;
          const realizedGainAfterFees = realizedGainPreFees - saleFee;
          const realizedGainEUR = toEUR(realizedGainAfterFees, position.currency);
          const realizedGainPreFeesEUR = toEUR(realizedGainPreFees, position.currency);
          
          positionRealizedGain += realizedGainEUR;
          positionRealizedGainPreFees += realizedGainPreFeesEUR;
          positionRealizedFees += toEUR(saleFee, position.currency);
          positionCostBasisSold += toEUR(costBasisForSale, position.currency);
          positionProceeds += toEUR(saleProceeds, position.currency);
          
          // Track by year
          const saleYear = new Date(trade.date).getFullYear();
          if (!realizedByYear[saleYear]) realizedByYear[saleYear] = 0;
          realizedByYear[saleYear] += realizedGainEUR;
          
          sellTransactions.push({
            id: trade.id,
            date: trade.date,
            shares: trade.shares,
            sellPrice: trade.price,
            proceeds: saleProceeds,
            proceedsEUR: toEUR(saleProceeds, position.currency),
            costBasis: costBasisForSale,
            costBasisEUR: toEUR(costBasisForSale, position.currency),
            fee: saleFee,
            feeEUR: toEUR(saleFee, position.currency),
            realizedGain: realizedGainAfterFees,
            realizedGainEUR: realizedGainEUR,
            realizedGainPreFees: realizedGainPreFees,
            realizedGainPreFeesEUR: realizedGainPreFeesEUR,
            lotsUsed,
            holdingPeriod: lotsUsed.length > 0 ? 
              Math.ceil((new Date(trade.date) - new Date(lotsUsed[0].lotDate)) / (1000 * 60 * 60 * 24)) : 0,
            isLongTerm: lotsUsed.length > 0 ? 
              (new Date(trade.date) - new Date(lotsUsed[0].lotDate)) > (365 * 24 * 60 * 60 * 1000) : false
          });
        }
      });
      
      // Calculate unrealized gains from remaining lots
      let remainingShares = 0;
      let remainingCostBasis = 0;
      const remainingLots = [];
      
      taxLots.forEach(lot => {
        if (lot.remainingShares > 0) {
          remainingShares += lot.remainingShares;
          remainingCostBasis += lot.remainingShares * lot.costBasisPerShare;
          remainingLots.push({
            id: lot.id,
            date: lot.date,
            shares: lot.remainingShares,
            originalShares: lot.shares,
            costBasisPerShare: lot.costBasisPerShare,
            costBasis: lot.remainingShares * lot.costBasisPerShare,
            costBasisEUR: toEUR(lot.remainingShares * lot.costBasisPerShare, position.currency),
            currentValue: lot.remainingShares * position.currentPrice,
            currentValueEUR: toEUR(lot.remainingShares * position.currentPrice, position.currency),
            unrealizedGain: (lot.remainingShares * position.currentPrice) - (lot.remainingShares * lot.costBasisPerShare),
            unrealizedGainEUR: toEUR((lot.remainingShares * position.currentPrice) - (lot.remainingShares * lot.costBasisPerShare), position.currency),
            holdingDays: Math.ceil((new Date() - new Date(lot.date)) / (1000 * 60 * 60 * 24)),
            isLongTerm: (new Date() - new Date(lot.date)) > (365 * 24 * 60 * 60 * 1000)
          });
        }
      });
      
      const currentValue = remainingShares * position.currentPrice;
      const positionUnrealizedGain = toEUR(currentValue - remainingCostBasis, position.currency);
      const unrealizedReturnPct = remainingCostBasis > 0 ? ((currentValue - remainingCostBasis) / remainingCostBasis) * 100 : 0;
      
      // Add position-specific fees to the calculation
      const positionSpecificFees = fees.filter(f => f.positionId === position.id).reduce((sum, f) => sum + toEUR(f.amount, f.currency), 0);
      
      positionGains.push({
        id: position.id,
        symbol: position.symbol,
        name: position.name,
        type: position.type,
        currency: position.currency,
        currentPrice: position.currentPrice,
        // Realized
        realizedGain: positionRealizedGain,
        realizedGainPreFees: positionRealizedGainPreFees,
        realizedFees: positionRealizedFees,
        costBasisSold: positionCostBasisSold,
        proceeds: positionProceeds,
        sellTransactions,
        hasSells: sellTransactions.length > 0,
        // Unrealized
        unrealizedGain: positionUnrealizedGain,
        unrealizedReturnPct,
        remainingShares,
        remainingCostBasis: toEUR(remainingCostBasis, position.currency),
        currentValue: toEUR(currentValue, position.currency),
        remainingLots,
        // Combined
        totalGain: positionRealizedGain + positionUnrealizedGain,
        positionFees: positionSpecificFees + positionRealizedFees
      });
      
      totalRealizedGain += positionRealizedGain;
      totalRealizedGainPreFees += positionRealizedGainPreFees;
      totalUnrealizedGain += positionUnrealizedGain;
      totalRealizedFees += positionRealizedFees;
      totalCostBasisSold += positionCostBasisSold;
      totalProceedsFromSales += positionProceeds;
    });
    
    // Calculate tax summary
    const shortTermGains = positionGains.reduce((sum, p) => {
      return sum + p.sellTransactions.filter(s => !s.isLongTerm).reduce((s, t) => s + t.realizedGainEUR, 0);
    }, 0);
    
    const longTermGains = positionGains.reduce((sum, p) => {
      return sum + p.sellTransactions.filter(s => s.isLongTerm).reduce((s, t) => s + t.realizedGainEUR, 0);
    }, 0);
    
    const shortTermUnrealized = positionGains.reduce((sum, p) => {
      return sum + p.remainingLots.filter(l => !l.isLongTerm).reduce((s, l) => s + l.unrealizedGainEUR, 0);
    }, 0);
    
    const longTermUnrealized = positionGains.reduce((sum, p) => {
      return sum + p.remainingLots.filter(l => l.isLongTerm).reduce((s, l) => s + l.unrealizedGainEUR, 0);
    }, 0);
    
    return {
      positions: positionGains,
      summary: {
        totalRealizedGain,
        totalRealizedGainPreFees,
        totalUnrealizedGain,
        totalGain: totalRealizedGain + totalUnrealizedGain,
        totalRealizedFees,
        totalCostBasisSold,
        totalProceedsFromSales,
        realizedByYear,
        shortTermGains,
        longTermGains,
        shortTermUnrealized,
        longTermUnrealized
      }
    };
  }, [positions, trades, fees]);

  const handleAddPosition = () => {
    if (!newPosition.symbol || !newPosition.shares || !newPosition.avgPrice) return;
    const position = { id: Date.now(), symbol: newPosition.symbol.toUpperCase(), name: newPosition.name || newPosition.symbol.toUpperCase(), type: newPosition.type, shares: parseFloat(newPosition.shares), avgPrice: parseFloat(newPosition.avgPrice), currentPrice: parseFloat(newPosition.avgPrice), currency: newPosition.currency, dividendYield: parseFloat(newPosition.dividendYield) || 0, purchaseDate: new Date().toISOString().split('T')[0] };
    const updatedPositions = [...positions, position]; setPositions(updatedPositions); refreshData(updatedPositions);
    setNewPosition({ symbol: '', name: '', type: 'Stock', shares: '', avgPrice: '', currency: 'EUR', dividendYield: '' }); setShowAddModal(false);
  };

  const handleAddTrade = () => {
    if (!newTrade.positionId || !newTrade.shares || !newTrade.price) return;
    const trade = { id: Date.now(), positionId: parseInt(newTrade.positionId), type: newTrade.type, shares: parseFloat(newTrade.shares), price: parseFloat(newTrade.price), date: newTrade.date, fee: parseFloat(newTrade.fee) || 0 };
    setTrades([...trades, trade]);
    setPositions(positions.map(p => {
      if (p.id === trade.positionId) {
        if (trade.type === 'buy') { const totalShares = p.shares + trade.shares; const totalCost = (p.shares * p.avgPrice) + (trade.shares * trade.price); return { ...p, shares: totalShares, avgPrice: totalCost / totalShares }; }
        else return { ...p, shares: Math.max(0, p.shares - trade.shares) };
      }
      return p;
    }));
    setNewTrade({ positionId: '', type: 'buy', shares: '', price: '', date: new Date().toISOString().split('T')[0], fee: '' }); setShowTradeModal(false);
  };

  const handleAddFee = () => {
    if (!newFee.amount || !newFee.type) return;
    const fee = { id: Date.now(), type: newFee.type, amount: parseFloat(newFee.amount), currency: newFee.currency, date: newFee.date, description: newFee.description, positionId: newFee.positionId ? parseInt(newFee.positionId) : null };
    setFees([...fees, fee]);
    setNewFee({ type: 'Transaction Fee', amount: '', currency: 'EUR', date: new Date().toISOString().split('T')[0], description: '', positionId: '' }); setShowFeeModal(false);
  };

  const handleImportCSV = () => {
    const imported = parseCSV(csvText, importType);
    if (imported.length === 0) { alert('No valid data found. Check CSV format.'); return; }
    
    if (importType === 'transactions') {
      // Process like Supabase transactions
      const processed = SupabaseService.processTransactions(imported);
      setPositions(processed.positions);
      setTrades(processed.trades);
      setFees(processed.fees);
      setReceivedDividends(processed.dividends);
      refreshData(processed.positions);
      alert(`Imported ${imported.length} transactions → ${processed.positions.length} positions`);
    } else if (importType === 'positions') {
      const updatedPositions = [...positions, ...imported];
      setPositions(updatedPositions);
      refreshData(updatedPositions);
    } else if (importType === 'trades') {
      const matchedTrades = imported.map(trade => {
        const position = positions.find(p => p.symbol === trade.symbol);
        return { ...trade, positionId: position?.id || null };
      }).filter(t => t.positionId);
      if (matchedTrades.length < imported.length) alert(`${imported.length - matchedTrades.length} trades couldn't match to positions.`);
      setTrades([...trades, ...matchedTrades]);
    }
    setCsvText(''); setShowImportModal(false);
  };
  const handleExport = (type) => { const csvData = exportToCSV(positions, trades); if (type === 'positions') downloadCSV(csvData.positions, `portfolio_positions_${new Date().toISOString().split('T')[0]}.csv`); else downloadCSV(csvData.trades, `portfolio_trades_${new Date().toISOString().split('T')[0]}.csv`); };
  const handleDeletePosition = (id) => setPositions(positions.filter(p => p.id !== id));
  const handleDeleteFee = (id) => setFees(fees.filter(f => f.id !== id));
  const handleRefresh = async () => { setIsLoading(true); await refreshData(); setIsLoading(false); };

  if (isLoading && positions.length === 0) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: '#030712', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 48, height: 48, border: '4px solid #6366f1', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
          <p style={{ color: '#9ca3af' }}>Loading portfolio...</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const styles = {
    container: { minHeight: '100vh', backgroundColor: '#030712', color: '#f3f4f6', fontFamily: "'DM Sans', system-ui, sans-serif" },
    header: { borderBottom: '1px solid #1f2937', backgroundColor: '#030712', position: 'sticky', top: 0, zIndex: 40 },
    headerInner: { maxWidth: 1280, margin: '0 auto', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    logo: { width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg, #6366f1, #a855f7)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 20px rgba(99, 102, 241, 0.4)' },
    headerTitle: { fontSize: 20, fontWeight: 600, color: '#ffffff', margin: 0 },
    headerSubtitle: { fontSize: 12, color: '#6b7280', margin: 0 },
    headerButtons: { display: 'flex', alignItems: 'center', gap: 8 },
    btnSecondary: { padding: '10px 16px', borderRadius: 12, backgroundColor: '#111827', border: '1px solid #374151', color: '#d1d5db', fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'all 0.2s' },
    btnPrimary: { padding: '10px 20px', borderRadius: 12, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', border: 'none', color: '#ffffff', fontSize: 14, fontWeight: 500, cursor: 'pointer', boxShadow: '0 0 20px rgba(99, 102, 241, 0.3)' },
    nav: { borderBottom: '1px solid #1f2937', backgroundColor: '#030712' },
    navInner: { maxWidth: 1280, margin: '0 auto', padding: '0 24px', display: 'flex', gap: 4 },
    navTab: (active) => ({ padding: '14px 20px', fontSize: 14, fontWeight: 500, color: active ? '#ffffff' : '#6b7280', background: 'none', border: 'none', cursor: 'pointer', position: 'relative', textTransform: 'capitalize' }),
    navIndicator: { position: 'absolute', bottom: 0, left: 8, right: 8, height: 2, background: 'linear-gradient(90deg, #6366f1, #a855f7)', borderRadius: 2 },
    main: { maxWidth: 1280, margin: '0 auto', padding: '32px 24px' },
    grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 },
    grid5: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 },
    card: { padding: 20, borderRadius: 16, backgroundColor: '#0f1629', border: '1px solid #1e293b' },
    cardLabel: { fontSize: 14, color: '#9ca3af', marginBottom: 4, fontWeight: 500 },
    cardValue: { fontSize: 28, fontWeight: 600, color: '#ffffff', margin: 0 },
    cardSubtext: { fontSize: 14, marginTop: 4 },
    chartCard: { padding: 24, borderRadius: 16, backgroundColor: '#0f1629', border: '1px solid #1e293b' },
    chartTitle: { fontSize: 18, fontWeight: 600, color: '#ffffff', margin: 0 },
    timeframeBtns: { display: 'flex', gap: 4, backgroundColor: '#1e293b', borderRadius: 12, padding: 4 },
    timeframeBtn: (active) => ({ padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer', background: active ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : 'transparent', color: active ? '#ffffff' : '#9ca3af' }),
    yearBtn: (active, year) => ({ padding: '10px 16px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', background: active ? `linear-gradient(135deg, ${YEAR_COLORS[year]}, ${YEAR_COLORS[year]}88)` : '#111827', color: active ? '#ffffff' : '#9ca3af', border: active ? 'none' : '1px solid #1e293b' }),
    holdingRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', marginBottom: 12, cursor: 'pointer', transition: 'all 0.2s' },
    holdingSymbol: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#1e293b', border: '1px solid #374151', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: '#e5e7eb' },
    badge: { padding: '4px 10px', borderRadius: 6, fontSize: 12, backgroundColor: '#1e293b', color: '#9ca3af', border: '1px solid #374151' },
    table: { width: '100%', borderCollapse: 'collapse' },
    th: { padding: 16, textAlign: 'left', fontSize: 13, fontWeight: 500, color: '#9ca3af', borderBottom: '1px solid #1e293b' },
    thRight: { padding: 16, textAlign: 'right', fontSize: 13, fontWeight: 500, color: '#9ca3af', borderBottom: '1px solid #1e293b' },
    td: { padding: 16, borderBottom: '1px solid #111827', color: '#e5e7eb' },
    tdRight: { padding: 16, borderBottom: '1px solid #111827', textAlign: 'right', color: '#e5e7eb' },
    modal: { position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 },
    modalContent: { backgroundColor: '#0f1629', borderRadius: 20, border: '1px solid #1e293b', width: '100%', maxWidth: 448, padding: 24 },
    modalTitle: { fontSize: 20, fontWeight: 600, color: '#ffffff', marginBottom: 24 },
    inputLabel: { display: 'block', fontSize: 14, color: '#9ca3af', marginBottom: 6 },
    input: { width: '100%', padding: '12px 16px', borderRadius: 12, backgroundColor: '#111827', border: '1px solid #374151', color: '#ffffff', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
    select: { width: '100%', padding: '12px 16px', borderRadius: 12, backgroundColor: '#111827', border: '1px solid #374151', color: '#ffffff', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
    modalButtons: { display: 'flex', gap: 12, marginTop: 24 },
  };

  // Yearly comparison chart data
  const yearlyComparisonData = YEARS.map(year => ({
    year: year.toString(),
    return: yearlyPerformance[year]?.returnPct || 0,
    value: yearlyPerformance[year]?.endValue || 0
  }));

  return (
    <div style={styles.container}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={styles.logo}><svg width="20" height="20" fill="none" stroke="#fff" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg></div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h1 style={styles.headerTitle}>Portfolio</h1>
                <span style={{ padding: '4px 8px', borderRadius: 6, fontSize: 11, fontWeight: 500, backgroundColor: dataSource === 'supabase' ? 'rgba(52,211,153,0.2)' : 'rgba(251,191,36,0.2)', color: dataSource === 'supabase' ? '#34d399' : '#fbbf24', border: `1px solid ${dataSource === 'supabase' ? 'rgba(52,211,153,0.3)' : 'rgba(251,191,36,0.3)'}` }}>{dataSource === 'supabase' ? '☁️ Cloud' : '💾 Local'}</span>
              </div>
              <p style={styles.headerSubtitle}>EUR/USD: {exchangeRate.rate.toFixed(4)} • {lastUpdated ? lastUpdated.toLocaleTimeString() : 'Never'}</p>
            </div>
          </div>
          <div style={styles.headerButtons}>
            <button style={styles.btnSecondary} onClick={handleRefresh} disabled={isLoading}>↻</button>
            {SupabaseService.isConfigured && <button style={styles.btnSecondary} onClick={syncFromSupabase} disabled={syncStatus.status === 'syncing'}>{syncStatus.status === 'syncing' ? '⏳' : '🔄'} Refresh</button>}
            <button style={styles.btnSecondary} onClick={() => setShowSettingsModal(true)}>⚙️</button>
            <button style={styles.btnSecondary} onClick={() => setShowExportModal(true)}>Export</button>
            <button style={styles.btnSecondary} onClick={() => setShowImportModal(true)}>Import</button>
            <button style={styles.btnPrimary} onClick={() => setShowAddModal(true)}>+ Add Position</button>
          </div>
        </div>
        {syncStatus.message && <div style={{ padding: '8px 24px', backgroundColor: syncStatus.status === 'error' ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)', borderTop: '1px solid #1e293b' }}><p style={{ fontSize: 12, color: syncStatus.status === 'error' ? '#f87171' : '#34d399', margin: 0, textAlign: 'center' }}>{syncStatus.message}</p></div>}
      </header>

      {/* Navigation */}
      <nav style={styles.nav}>
        <div style={styles.navInner}>
          {['overview', 'holdings', 'performance', 'gains', 'dividends', 'fees', 'trades'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={styles.navTab(activeTab === tab)}>
              {tab}
              {activeTab === tab && <div style={styles.navIndicator} />}
            </button>
          ))}
        </div>
      </nav>

      {/* Main Content */}
      <main style={styles.main}>
        
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div>
            <div style={{ ...styles.grid4, marginBottom: 24 }}>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Portfolio Value</p>
                <p style={styles.cardValue}>{formatCurrency(portfolioMetrics.totalValue)}</p>
                <p style={{ ...styles.cardSubtext, color: portfolioMetrics.dayChange >= 0 ? '#34d399' : '#f87171' }}>{formatCurrency(portfolioMetrics.dayChange)} ({formatPercent(portfolioMetrics.dayChangePercent)}) today</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Net Return</p>
                <p style={{ ...styles.cardValue, color: portfolioMetrics.netGainLoss >= 0 ? '#34d399' : '#f87171' }}>{formatCurrency(portfolioMetrics.netGainLoss)}</p>
                <p style={{ ...styles.cardSubtext, color: portfolioMetrics.netReturn >= 0 ? '#34d399' : '#f87171' }}>{formatPercent(portfolioMetrics.netReturn)} after fees</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Dividends Received</p>
                <p style={styles.cardValue}>{formatCurrency(portfolioMetrics.totalDividends)}</p>
                <p style={{ ...styles.cardSubtext, color: '#34d399' }}>from {receivedDividends.length} payments</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Total Fees Paid</p>
                <p style={{ ...styles.cardValue, color: '#f87171' }}>{formatCurrency(portfolioMetrics.totalFees)}</p>
                <p style={{ ...styles.cardSubtext, color: '#6b7280' }}>{((portfolioMetrics.totalFees / portfolioMetrics.totalCost) * 100).toFixed(2)}% of cost basis</p>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24, marginBottom: 24 }}>
              <div style={styles.chartCard}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <h3 style={styles.chartTitle}>Portfolio Performance</h3>
                    <p style={{ fontSize: 14, color: portfolioMetrics.periodReturnPercent >= 0 ? '#34d399' : '#f87171', margin: '4px 0 0' }}>{formatCurrency(portfolioMetrics.periodReturn)} ({formatPercent(portfolioMetrics.periodReturnPercent)}) in period</p>
                  </div>
                  <div style={styles.timeframeBtns}>{TIMEFRAMES.map(tf => (<button key={tf.key} onClick={() => setSelectedTimeframe(tf.key)} style={styles.timeframeBtn(selectedTimeframe === tf.key)}>{tf.label}</button>))}</div>
                </div>
                <div style={{ height: 256 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historicalData}>
                      <defs><linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#818cf8" stopOpacity={0.4}/><stop offset="95%" stopColor="#818cf8" stopOpacity={0}/></linearGradient></defs>
                      <XAxis dataKey="displayDate" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} interval="preserveStartEnd" />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={(v) => `€${(v/1000).toFixed(0)}k`} domain={['dataMin - 500', 'dataMax + 500']} />
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12, fontSize: 12 }} formatter={(value) => [formatCurrency(value), 'Value']} />
                      <Area type="monotone" dataKey="value" stroke="#818cf8" strokeWidth={2} fill="url(#colorValue)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div style={styles.chartCard}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Asset Allocation</h3>
                <div style={{ height: 192 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart><Pie data={allocationData} cx="50%" cy="50%" innerRadius={50} outerRadius={70} paddingAngle={2} dataKey="value">{allocationData.map((entry, index) => (<Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />))}</Pie><Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12, fontSize: 12 }} formatter={(value) => formatCurrency(value)} /></PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ marginTop: 16 }}>
                  {allocationData.map((item, index) => (
                    <div key={item.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 14, marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: COLORS[index % COLORS.length] }} /><span style={{ color: '#9ca3af' }}>{item.name}</span></div>
                      <span style={{ fontWeight: 500, color: '#ffffff' }}>{((item.value / portfolioMetrics.totalValue) * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={styles.chartCard}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Holdings Overview</h3>
              {positionsWithMetrics.map((position) => (
                <div key={position.id} onClick={() => setSelectedPosition(position)} style={styles.holdingRow} onMouseOver={e => e.currentTarget.style.borderColor = '#6366f1'} onMouseOut={e => e.currentTarget.style.borderColor = '#1e293b'}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={styles.holdingSymbol}>{position.symbol.slice(0, 3)}</div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontWeight: 500, color: '#ffffff' }}>{position.symbol}</span><span style={styles.badge}>{position.type}</span></div>
                      <p style={{ fontSize: 14, color: '#6b7280', margin: '4px 0 0' }}>{position.name}</p>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 48 }}>
                    <div style={{ textAlign: 'right' }}><p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Avg Cost</p><p style={{ fontFamily: 'monospace', color: '#ffffff', margin: '2px 0' }}>{formatCurrency(position.avgPrice, position.currency)}</p><p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{position.shares.toFixed(position.shares < 1 ? 4 : 2)} shares</p></div>
                    <div style={{ textAlign: 'right' }}><p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Value</p><p style={{ fontWeight: 500, color: '#ffffff', margin: '2px 0' }}>{formatCurrency(position.valueEUR)}</p><p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{position.weight.toFixed(1)}%</p></div>
                    <div style={{ textAlign: 'right', minWidth: 100 }}><p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Net Return</p><p style={{ fontWeight: 500, color: position.netReturnPct >= 0 ? '#34d399' : '#f87171', margin: '2px 0' }}>{formatPercent(position.netReturnPct)}</p><p style={{ fontSize: 12, color: position.netGainLoss >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(position.netGainLoss)}</p></div>
                    <div style={{ color: '#6b7280' }}><svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Holdings Tab */}
        {activeTab === 'holdings' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ fontSize: 20, fontWeight: 600, color: '#ffffff', margin: 0 }}>All Holdings</h2>
              <button style={styles.btnSecondary} onClick={() => setShowTradeModal(true)}>+ Record Trade</button>
            </div>
            <div style={{ ...styles.chartCard, padding: 0, overflow: 'hidden' }}>
              <table style={styles.table}>
                <thead>
                  <tr style={{ backgroundColor: '#111827' }}>
                    <th style={styles.th}>Asset</th><th style={styles.th}>Type</th><th style={styles.thRight}>Shares</th><th style={styles.thRight}>Avg Price</th><th style={styles.thRight}>Current</th><th style={styles.thRight}>Value (EUR)</th><th style={styles.thRight}>Fees</th><th style={styles.thRight}>Net Return</th><th style={styles.thRight}>Weight</th><th style={styles.thRight}></th>
                  </tr>
                </thead>
                <tbody>
                  {positionsWithMetrics.map(position => (
                    <tr key={position.id} onClick={() => setSelectedPosition(position)} style={{ cursor: 'pointer' }} onMouseOver={e => e.currentTarget.style.backgroundColor = '#111827'} onMouseOut={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                      <td style={styles.td}><p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>{position.symbol}</p><p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>{position.name}</p></td>
                      <td style={styles.td}><span style={styles.badge}>{position.type}</span></td>
                      <td style={{ ...styles.tdRight, fontFamily: 'monospace' }}>{formatNumber(position.shares, position.shares < 1 ? 4 : 2)}</td>
                      <td style={{ ...styles.tdRight, fontFamily: 'monospace' }}>{formatCurrency(position.avgPrice, position.currency)}</td>
                      <td style={styles.tdRight}><p style={{ fontFamily: 'monospace', color: '#ffffff', margin: 0 }}>{formatCurrency(position.currentPrice, position.currency)}</p><p style={{ fontSize: 12, color: (position.priceChangePercent || 0) >= 0 ? '#34d399' : '#f87171', margin: '2px 0 0' }}>{formatPercent(position.priceChangePercent || 0)}</p></td>
                      <td style={{ ...styles.tdRight, fontWeight: 500, color: '#ffffff' }}>{formatCurrency(position.valueEUR)}</td>
                      <td style={{ ...styles.tdRight, color: '#f87171' }}>{formatCurrency(position.totalFees)}</td>
                      <td style={{ ...styles.tdRight, fontWeight: 500, color: position.netReturnPct >= 0 ? '#34d399' : '#f87171' }}>{formatPercent(position.netReturnPct)}</td>
                      <td style={{ ...styles.tdRight, color: '#9ca3af' }}>{position.weight.toFixed(1)}%</td>
                      <td style={styles.tdRight}><button onClick={(e) => { e.stopPropagation(); handleDeletePosition(position.id); }} style={{ background: 'none', border: 'none', padding: 8, borderRadius: 8, cursor: 'pointer', color: '#6b7280' }}><svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Performance Tab - ENHANCED WITH YEARLY DATA */}
        {activeTab === 'performance' && (
          <div>
            {/* Yearly Performance Summary */}
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 20, fontWeight: 600, color: '#ffffff', margin: '0 0 16px' }}>Annual Performance (Backtested)</h2>
              <div style={styles.grid5}>
                {YEARS.map(year => {
                  const yearData = yearlyPerformance[year];
                  const isYTD = year === new Date().getFullYear();
                  return (
                    <div key={year} onClick={() => setSelectedYear(year)} style={{ ...styles.card, cursor: 'pointer', border: selectedYear === year ? `2px solid ${YEAR_COLORS[year]}` : '1px solid #1e293b', background: selectedYear === year ? `linear-gradient(135deg, ${YEAR_COLORS[year]}15, #0f1629)` : '#0f1629' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: 16, fontWeight: 600, color: '#ffffff' }}>{year}</span>
                        {isYTD && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, backgroundColor: YEAR_COLORS[year], color: '#fff' }}>YTD</span>}
                      </div>
                      <p style={{ fontSize: 24, fontWeight: 700, color: yearData?.returnPct >= 0 ? '#34d399' : '#f87171', margin: '0 0 4px' }}>{formatPercent(yearData?.returnPct || 0)}</p>
                      <p style={{ fontSize: 13, color: yearData?.returnValue >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(yearData?.returnValue || 0)}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Yearly Comparison Bar Chart */}
            <div style={{ ...styles.chartCard, marginBottom: 24 }}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Year-over-Year Returns</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={yearlyComparisonData}>
                    <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{ fill: '#9ca3af', fontSize: 13, fontWeight: 500 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={(v) => `${v.toFixed(0)}%`} />
                    <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12, fontSize: 12 }} formatter={(value) => [`${value.toFixed(2)}%`, 'Return']} />
                    <Bar dataKey="return" radius={[8, 8, 0, 0]}>
                      {yearlyComparisonData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.return >= 0 ? '#34d399' : '#f87171'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Selected Year Detail */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24, marginBottom: 24 }}>
              <div style={styles.chartCard}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <h3 style={styles.chartTitle}>{selectedYear} Monthly Performance</h3>
                    <p style={{ fontSize: 14, color: yearlyPerformance[selectedYear]?.returnPct >= 0 ? '#34d399' : '#f87171', margin: '4px 0 0' }}>
                      {formatPercent(yearlyPerformance[selectedYear]?.returnPct || 0)} for the year
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {YEARS.map(year => (
                      <button key={year} onClick={() => setSelectedYear(year)} style={styles.yearBtn(selectedYear === year, year)}>{year}</button>
                    ))}
                  </div>
                </div>
                <div style={{ height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={yearlyPerformance[selectedYear]?.monthlyData || []}>
                      <defs>
                        <linearGradient id={`colorYear${selectedYear}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={YEAR_COLORS[selectedYear]} stopOpacity={0.4}/>
                          <stop offset="95%" stopColor={YEAR_COLORS[selectedYear]} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={(v) => `€${(v/1000).toFixed(0)}k`} domain={['dataMin - 1000', 'dataMax + 1000']} />
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12, fontSize: 12 }} formatter={(value) => [formatCurrency(value), 'Portfolio Value']} />
                      <Area type="monotone" dataKey="value" stroke={YEAR_COLORS[selectedYear]} strokeWidth={2} fill={`url(#colorYear${selectedYear})`} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Year Summary Stats */}
              <div style={styles.chartCard}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>{selectedYear} Summary</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Starting Value</p>
                    <p style={{ fontSize: 18, fontWeight: 600, color: '#ffffff', margin: 0 }}>{formatCurrency(yearlyPerformance[selectedYear]?.startValue || 0)}</p>
                  </div>
                  <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Ending Value</p>
                    <p style={{ fontSize: 18, fontWeight: 600, color: '#ffffff', margin: 0 }}>{formatCurrency(yearlyPerformance[selectedYear]?.endValue || 0)}</p>
                  </div>
                  <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Total Return</p>
                    <p style={{ fontSize: 18, fontWeight: 600, color: yearlyPerformance[selectedYear]?.returnPct >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatPercent(yearlyPerformance[selectedYear]?.returnPct || 0)}</p>
                  </div>
                  <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Absolute Gain/Loss</p>
                    <p style={{ fontSize: 18, fontWeight: 600, color: yearlyPerformance[selectedYear]?.returnValue >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(yearlyPerformance[selectedYear]?.returnValue || 0)}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Position Performance Table for Selected Year */}
            <div style={styles.chartCard}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Position Performance in {selectedYear}</h3>
              <table style={styles.table}>
                <thead>
                  <tr style={{ backgroundColor: '#111827' }}>
                    <th style={styles.th}>Asset</th>
                    <th style={styles.thRight}>Start Price</th>
                    <th style={styles.thRight}>End Price</th>
                    <th style={styles.thRight}>Low</th>
                    <th style={styles.thRight}>High</th>
                    <th style={styles.thRight}>Return</th>
                    <th style={styles.thRight}>P&L (EUR)</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map(position => {
                    const yearData = positionYearlyPerformance[position.symbol]?.[selectedYear];
                    if (!yearData) return null;
                    return (
                      <tr key={position.id}>
                        <td style={styles.td}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ ...styles.holdingSymbol, width: 36, height: 36, fontSize: 11 }}>{position.symbol.slice(0, 3)}</div>
                            <div>
                              <p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>{position.symbol}</p>
                              <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>{position.name}</p>
                            </div>
                          </div>
                        </td>
                        <td style={{ ...styles.tdRight, fontFamily: 'monospace' }}>{formatCurrency(yearData.startPrice, position.currency)}</td>
                        <td style={{ ...styles.tdRight, fontFamily: 'monospace' }}>{formatCurrency(yearData.endPrice, position.currency)}</td>
                        <td style={{ ...styles.tdRight, fontFamily: 'monospace', color: '#f87171' }}>{formatCurrency(yearData.low, position.currency)}</td>
                        <td style={{ ...styles.tdRight, fontFamily: 'monospace', color: '#34d399' }}>{formatCurrency(yearData.high, position.currency)}</td>
                        <td style={{ ...styles.tdRight, fontWeight: 600, color: yearData.returnPct >= 0 ? '#34d399' : '#f87171' }}>{formatPercent(yearData.returnPct)}</td>
                        <td style={{ ...styles.tdRight, fontWeight: 600, color: yearData.returnValue >= 0 ? '#34d399' : '#f87171' }}>{formatCurrency(yearData.returnValue)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Gains Tab - Realized vs Unrealized */}
        {activeTab === 'gains' && (
          <div>
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 20, fontWeight: 600, color: '#ffffff', margin: '0 0 8px' }}>Realized vs Unrealized Gains</h2>
              <p style={{ fontSize: 14, color: '#6b7280', margin: 0 }}>Tax lot analysis using FIFO (First-In, First-Out) method</p>
            </div>

            {/* Summary Cards */}
            <div style={{ ...styles.grid4, marginBottom: 24 }}>
              <div style={{ ...styles.card, background: 'linear-gradient(135deg, rgba(52,211,153,0.15), rgba(16,185,129,0.1))', borderColor: 'rgba(52,211,153,0.3)' }}>
                <p style={styles.cardLabel}>Total Gain/Loss</p>
                <p style={{ ...styles.cardValue, color: gainsAnalysis.summary.totalGain >= 0 ? '#34d399' : '#f87171' }}>{formatCurrency(gainsAnalysis.summary.totalGain)}</p>
                <p style={{ ...styles.cardSubtext, color: '#6b7280' }}>Realized + Unrealized</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Realized Gains</p>
                <p style={{ ...styles.cardValue, color: gainsAnalysis.summary.totalRealizedGain >= 0 ? '#34d399' : '#f87171' }}>{formatCurrency(gainsAnalysis.summary.totalRealizedGain)}</p>
                <p style={{ ...styles.cardSubtext, color: '#6b7280' }}>From {gainsAnalysis.positions.filter(p => p.hasSells).length} positions sold</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Unrealized Gains</p>
                <p style={{ ...styles.cardValue, color: gainsAnalysis.summary.totalUnrealizedGain >= 0 ? '#34d399' : '#f87171' }}>{formatCurrency(gainsAnalysis.summary.totalUnrealizedGain)}</p>
                <p style={{ ...styles.cardSubtext, color: '#6b7280' }}>Paper gains on holdings</p>
              </div>
              <div style={styles.card}>
                <p style={styles.cardLabel}>Sale Proceeds</p>
                <p style={styles.cardValue}>{formatCurrency(gainsAnalysis.summary.totalProceedsFromSales)}</p>
                <p style={{ ...styles.cardSubtext, color: '#6b7280' }}>Cost basis: {formatCurrency(gainsAnalysis.summary.totalCostBasisSold)}</p>
              </div>
            </div>

            {/* Visual Breakdown */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
              {/* Realized vs Unrealized Chart */}
              <div style={styles.chartCard}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Gains Composition</h3>
                <div style={{ height: 240 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={[
                      { name: 'Realized', gain: gainsAnalysis.summary.totalRealizedGain, fill: '#818cf8' },
                      { name: 'Unrealized', gain: gainsAnalysis.summary.totalUnrealizedGain, fill: '#a78bfa' }
                    ]} layout="vertical">
                      <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={(v) => formatCurrency(v)} />
                      <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#9ca3af', fontSize: 13, fontWeight: 500 }} width={80} />
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12 }} formatter={(value) => [formatCurrency(value), 'Gain']} />
                      <Bar dataKey="gain" radius={[0, 8, 8, 0]}>
                        {[
                          { name: 'Realized', gain: gainsAnalysis.summary.totalRealizedGain },
                          { name: 'Unrealized', gain: gainsAnalysis.summary.totalUnrealizedGain }
                        ].map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.gain >= 0 ? (index === 0 ? '#34d399' : '#4ade80') : '#f87171'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ marginTop: 16, display: 'flex', gap: 24 }}>
                  <div style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: '#111827', border: '1px solid #1e293b' }}>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Realized %</p>
                    <p style={{ fontSize: 16, fontWeight: 600, color: '#ffffff', margin: 0 }}>
                      {gainsAnalysis.summary.totalGain !== 0 ? ((gainsAnalysis.summary.totalRealizedGain / Math.abs(gainsAnalysis.summary.totalGain)) * 100).toFixed(1) : 0}%
                    </p>
                  </div>
                  <div style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: '#111827', border: '1px solid #1e293b' }}>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Unrealized %</p>
                    <p style={{ fontSize: 16, fontWeight: 600, color: '#ffffff', margin: 0 }}>
                      {gainsAnalysis.summary.totalGain !== 0 ? ((gainsAnalysis.summary.totalUnrealizedGain / Math.abs(gainsAnalysis.summary.totalGain)) * 100).toFixed(1) : 0}%
                    </p>
                  </div>
                </div>
              </div>

              {/* Tax Summary (Short vs Long Term) */}
              <div style={styles.chartCard}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Holding Period Analysis</h3>
                <div style={{ marginBottom: 16, padding: 16, borderRadius: 12, background: 'linear-gradient(135deg, rgba(99,102,241,0.1), rgba(139,92,246,0.05))', border: '1px solid rgba(99,102,241,0.2)' }}>
                  <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: 1 }}>Realized Gains</p>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Short-term (&lt;1yr)</p>
                      <p style={{ fontSize: 18, fontWeight: 600, color: gainsAnalysis.summary.shortTermGains >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(gainsAnalysis.summary.shortTermGains)}</p>
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Long-term (&gt;1yr)</p>
                      <p style={{ fontSize: 18, fontWeight: 600, color: gainsAnalysis.summary.longTermGains >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(gainsAnalysis.summary.longTermGains)}</p>
                    </div>
                  </div>
                </div>
                <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}>
                  <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: 1 }}>Unrealized Gains</p>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Short-term (&lt;1yr)</p>
                      <p style={{ fontSize: 18, fontWeight: 600, color: gainsAnalysis.summary.shortTermUnrealized >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(gainsAnalysis.summary.shortTermUnrealized)}</p>
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Long-term (&gt;1yr)</p>
                      <p style={{ fontSize: 18, fontWeight: 600, color: gainsAnalysis.summary.longTermUnrealized >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(gainsAnalysis.summary.longTermUnrealized)}</p>
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 12, padding: 12, borderRadius: 8, backgroundColor: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.2)' }}>
                  <p style={{ fontSize: 12, color: '#fbbf24', margin: 0 }}>💡 Long-term gains often qualify for lower tax rates in many jurisdictions</p>
                </div>
              </div>
            </div>

            {/* Realized Gains by Year */}
            {Object.keys(gainsAnalysis.summary.realizedByYear).length > 0 && (
              <div style={{ ...styles.chartCard, marginBottom: 24 }}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Realized Gains by Year</h3>
                <div style={{ display: 'flex', gap: 12 }}>
                  {Object.entries(gainsAnalysis.summary.realizedByYear).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).map(([year, gain]) => (
                    <div key={year} style={{ flex: 1, padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', textAlign: 'center' }}>
                      <p style={{ fontSize: 14, fontWeight: 600, color: '#ffffff', margin: '0 0 4px' }}>{year}</p>
                      <p style={{ fontSize: 20, fontWeight: 700, color: gain >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(gain)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Position-by-Position Breakdown */}
            <div style={styles.chartCard}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Position Breakdown</h3>
              <table style={styles.table}>
                <thead>
                  <tr style={{ backgroundColor: '#111827' }}>
                    <th style={styles.th}>Asset</th>
                    <th style={styles.thRight}>Realized</th>
                    <th style={styles.thRight}>Unrealized</th>
                    <th style={styles.thRight}>Total Gain</th>
                    <th style={styles.thRight}>Current Value</th>
                    <th style={styles.thRight}>Cost Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {gainsAnalysis.positions.map(position => (
                    <tr key={position.id}>
                      <td style={styles.td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ ...styles.holdingSymbol, width: 36, height: 36, fontSize: 11 }}>{position.symbol.slice(0, 3)}</div>
                          <div>
                            <p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>{position.symbol}</p>
                            <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>{position.remainingShares > 0 ? `${formatNumber(position.remainingShares, position.remainingShares < 1 ? 4 : 2)} shares held` : 'Fully sold'}</p>
                          </div>
                        </div>
                      </td>
                      <td style={{ ...styles.tdRight, fontWeight: 500, color: position.realizedGain >= 0 ? '#34d399' : '#f87171' }}>
                        {position.hasSells ? formatCurrency(position.realizedGain) : '—'}
                      </td>
                      <td style={{ ...styles.tdRight, fontWeight: 500, color: position.unrealizedGain >= 0 ? '#34d399' : '#f87171' }}>
                        {position.remainingShares > 0 ? formatCurrency(position.unrealizedGain) : '—'}
                      </td>
                      <td style={{ ...styles.tdRight, fontWeight: 600, color: position.totalGain >= 0 ? '#34d399' : '#f87171' }}>
                        {formatCurrency(position.totalGain)}
                      </td>
                      <td style={{ ...styles.tdRight, color: '#ffffff' }}>
                        {position.remainingShares > 0 ? formatCurrency(position.currentValue) : '—'}
                      </td>
                      <td style={{ ...styles.tdRight, color: '#9ca3af' }}>
                        {position.remainingShares > 0 ? formatCurrency(position.remainingCostBasis) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Detailed Sell Transactions */}
            <div style={{ ...styles.chartCard, marginTop: 24 }}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Realized Transactions Detail</h3>
              {gainsAnalysis.positions.filter(p => p.hasSells).length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {gainsAnalysis.positions.filter(p => p.hasSells).map(position => (
                    <div key={position.id}>
                      {position.sellTransactions.map(sell => (
                        <div key={sell.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', marginBottom: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                            <div style={{ width: 48, height: 48, borderRadius: 12, background: sell.realizedGainEUR >= 0 ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)', border: `1px solid ${sell.realizedGainEUR >= 0 ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: sell.realizedGainEUR >= 0 ? '#34d399' : '#f87171' }}>SELL</span>
                            </div>
                            <div>
                              <p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>{position.symbol}</p>
                              <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>{formatDate(sell.date)} • {formatNumber(sell.shares, sell.shares < 1 ? 4 : 2)} shares @ {formatCurrency(sell.sellPrice, position.currency)}</p>
                              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, backgroundColor: sell.isLongTerm ? 'rgba(52,211,153,0.2)' : 'rgba(251,191,36,0.2)', color: sell.isLongTerm ? '#34d399' : '#fbbf24' }}>
                                  {sell.isLongTerm ? 'Long-term' : 'Short-term'}
                                </span>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, backgroundColor: '#1e293b', color: '#9ca3af' }}>
                                  Held {sell.holdingPeriod} days
                                </span>
                              </div>
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <p style={{ fontWeight: 600, color: sell.realizedGainEUR >= 0 ? '#34d399' : '#f87171', margin: 0, fontSize: 16 }}>{formatCurrency(sell.realizedGainEUR)}</p>
                            <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>Proceeds: {formatCurrency(sell.proceedsEUR)}</p>
                            <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>Cost basis: {formatCurrency(sell.costBasisEUR)}</p>
                            {sell.feeEUR > 0 && <p style={{ fontSize: 11, color: '#f87171', margin: '2px 0 0' }}>Fee: {formatCurrency(sell.feeEUR)}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: '#6b7280', textAlign: 'center', padding: 32 }}>No sell transactions recorded yet</p>
              )}
            </div>

            {/* Tax Lots Detail (Unrealized) */}
            <div style={{ ...styles.chartCard, marginTop: 24 }}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Open Tax Lots (Unrealized Positions)</h3>
              {gainsAnalysis.positions.filter(p => p.remainingLots.length > 0).length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {gainsAnalysis.positions.filter(p => p.remainingLots.length > 0).map(position => (
                    <div key={position.id} style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #1e293b' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ ...styles.holdingSymbol, width: 40, height: 40, fontSize: 12 }}>{position.symbol.slice(0, 3)}</div>
                          <div>
                            <p style={{ fontWeight: 600, color: '#ffffff', margin: 0 }}>{position.symbol}</p>
                            <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>{position.name}</p>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <p style={{ fontWeight: 600, color: position.unrealizedGain >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(position.unrealizedGain)}</p>
                          <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>Unrealized gain</p>
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {position.remainingLots.map((lot, index) => (
                          <div key={lot.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 8, backgroundColor: '#0f1629', border: '1px solid #1e293b' }}>
                            <div>
                              <p style={{ fontSize: 13, fontWeight: 500, color: '#ffffff', margin: 0 }}>
                                Lot #{index + 1}: {formatNumber(lot.shares, lot.shares < 1 ? 4 : 2)} shares @ {formatCurrency(lot.costBasisPerShare, position.currency)}
                              </p>
                              <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>
                                Purchased {formatDate(lot.date)} • Held {lot.holdingDays} days
                              </p>
                              <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, backgroundColor: lot.isLongTerm ? 'rgba(52,211,153,0.2)' : 'rgba(251,191,36,0.2)', color: lot.isLongTerm ? '#34d399' : '#fbbf24', marginTop: 4, display: 'inline-block' }}>
                                {lot.isLongTerm ? 'Long-term' : 'Short-term'}
                              </span>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <p style={{ fontWeight: 500, color: lot.unrealizedGainEUR >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatCurrency(lot.unrealizedGainEUR)}</p>
                              <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 0' }}>Current: {formatCurrency(lot.currentValueEUR)}</p>
                              <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 0' }}>Cost: {formatCurrency(lot.costBasisEUR)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: '#6b7280', textAlign: 'center', padding: 32 }}>No open positions</p>
              )}
            </div>
          </div>
        )}

        {/* Dividends Tab */}
        {activeTab === 'dividends' && (
          <div>
            <div style={{ ...styles.grid4, marginBottom: 24 }}>
              <div style={{ ...styles.card, background: 'linear-gradient(135deg, rgba(52,211,153,0.15), rgba(16,185,129,0.1))', borderColor: 'rgba(52,211,153,0.3)' }}><p style={styles.cardLabel}>Total Received</p><p style={{ ...styles.cardValue, color: '#34d399' }}>{formatCurrency(portfolioMetrics.totalDividends)}</p></div>
              <div style={styles.card}><p style={styles.cardLabel}>Payments</p><p style={styles.cardValue}>{receivedDividends.length}</p></div>
              <div style={styles.card}><p style={styles.cardLabel}>This Year</p><p style={styles.cardValue}>{formatCurrency(receivedDividends.filter(d => new Date(d.date).getFullYear() === new Date().getFullYear()).reduce((sum, d) => sum + toEUR(d.amount, d.currency), 0))}</p></div>
              <div style={styles.card}><p style={styles.cardLabel}>Last Year</p><p style={styles.cardValue}>{formatCurrency(receivedDividends.filter(d => new Date(d.date).getFullYear() === new Date().getFullYear() - 1).reduce((sum, d) => sum + toEUR(d.amount, d.currency), 0))}</p></div>
            </div>

            {/* Dividends by Year Chart */}
            {receivedDividends.length > 0 && (
              <div style={{ ...styles.chartCard, marginBottom: 24 }}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Dividends by Year</h3>
                <div style={{ height: 256 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={(() => {
                      const byYear = {};
                      receivedDividends.forEach(d => {
                        const year = new Date(d.date).getFullYear();
                        byYear[year] = (byYear[year] || 0) + toEUR(d.amount, d.currency);
                      });
                      return Object.entries(byYear).map(([year, amount]) => ({ year, amount })).sort((a, b) => a.year - b.year);
                    })()}><XAxis dataKey="year" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={(v) => `€${v.toFixed(0)}`} /><Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12 }} formatter={(value) => [formatCurrency(value), 'Dividends']} /><Bar dataKey="amount" fill="#10b981" radius={[6, 6, 0, 0]} /></BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Dividend History */}
            <div style={styles.chartCard}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Dividend History</h3>
              {receivedDividends.length > 0 ? [...receivedDividends].sort((a, b) => new Date(b.date) - new Date(a.date)).map((div, index) => (
                <div key={div.id || index} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ width: 64, height: 64, borderRadius: 12, background: 'linear-gradient(135deg, rgba(52,211,153,0.2), rgba(16,185,129,0.1))', border: '1px solid rgba(52,211,153,0.3)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: 12, color: '#34d399' }}>{new Date(div.date).toLocaleDateString('en-GB', { month: 'short' })}</span>
                      <span style={{ fontSize: 20, fontWeight: 700, color: '#34d399' }}>{new Date(div.date).getDate()}</span>
                    </div>
                    <div>
                      <p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>{div.symbol}</p>
                      <p style={{ fontSize: 14, color: '#6b7280', margin: '2px 0' }}>{new Date(div.date).getFullYear()}</p>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontWeight: 500, color: '#34d399', margin: 0 }}>{formatCurrency(toEUR(div.amount, div.currency))}</p>
                    <p style={{ fontSize: 14, color: '#6b7280', margin: '2px 0' }}>{formatCurrency(div.amount, div.currency)}</p>
                  </div>
                </div>
              )) : <p style={{ color: '#6b7280', textAlign: 'center', padding: 32 }}>No dividend payments recorded</p>}
            </div>
          </div>
        )}

        {/* Fees Tab */}
        {activeTab === 'fees' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <h2 style={{ fontSize: 20, fontWeight: 600, color: '#ffffff', margin: 0 }}>Banking Costs & Fees</h2>
              <button style={styles.btnPrimary} onClick={() => setShowFeeModal(true)}>+ Add Fee</button>
            </div>

            <div style={{ ...styles.grid4, marginBottom: 24 }}>
              <div style={{ ...styles.card, background: 'linear-gradient(135deg, rgba(248,113,113,0.15), rgba(239,68,68,0.1))', borderColor: 'rgba(248,113,113,0.3)' }}><p style={styles.cardLabel}>Total Fees Paid</p><p style={{ ...styles.cardValue, color: '#f87171' }}>{formatCurrency(portfolioMetrics.totalFees)}</p></div>
              <div style={styles.card}><p style={styles.cardLabel}>Return Impact</p><p style={{ ...styles.cardValue, color: '#f87171' }}>{formatPercent(-((portfolioMetrics.totalFees / portfolioMetrics.totalCost) * 100), false)}</p></div>
              <div style={styles.card}><p style={styles.cardLabel}>Avg Monthly</p><p style={styles.cardValue}>{formatCurrency(portfolioMetrics.totalFees / 12)}</p></div>
              <div style={styles.card}><p style={styles.cardLabel}>Fee Categories</p><p style={styles.cardValue}>{feeBreakdown.length}</p></div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
              <div style={styles.chartCard}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Breakdown by Type</h3>
                {feeBreakdown.map((item, index) => (
                  <div key={item.type} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><div style={{ width: 40, height: 40, borderRadius: 8, background: 'rgba(248,113,113,0.2)', border: '1px solid rgba(248,113,113,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f87171', fontWeight: 700, fontSize: 14 }}>{index + 1}</div><span style={{ color: '#d1d5db' }}>{item.type}</span></div>
                    <span style={{ fontWeight: 500, color: '#f87171' }}>{formatCurrency(item.amount)}</span>
                  </div>
                ))}
              </div>

              <div style={styles.chartCard}>
                <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Monthly Fees</h3>
                <div style={{ height: 256 }}>
                  <ResponsiveContainer width="100%" height="100%"><BarChart data={monthlyFeeData}><XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={(v) => `€${v.toFixed(0)}`} /><Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #374151', borderRadius: 12 }} formatter={(value) => [formatCurrency(value), 'Fees']} /><Bar dataKey="amount" fill="#f43f5e" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
                </div>
              </div>
            </div>

            <div style={styles.chartCard}>
              <h3 style={{ ...styles.chartTitle, marginBottom: 16 }}>Fee History</h3>
              {[...fees].sort((a, b) => new Date(b.date) - new Date(a.date)).map(fee => {
                const position = fee.positionId ? positions.find(p => p.id === fee.positionId) : null;
                return (
                  <div key={fee.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                      <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(248,113,113,0.2)', border: '1px solid rgba(248,113,113,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="20" height="20" fill="none" stroke="#f87171" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>
                      <div><p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>{fee.type}</p><p style={{ fontSize: 14, color: '#6b7280', margin: '2px 0' }}>{fee.description}</p><p style={{ fontSize: 12, color: '#4b5563', margin: 0 }}>{formatDate(fee.date)} {position && `• ${position.symbol}`}</p></div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontWeight: 500, color: '#f87171' }}>{formatCurrency(fee.amount, fee.currency)}</span>
                      <button onClick={() => handleDeleteFee(fee.id)} style={{ background: 'none', border: 'none', padding: 8, borderRadius: 8, cursor: 'pointer', color: '#6b7280' }}><svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Trades Tab */}
        {activeTab === 'trades' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ fontSize: 20, fontWeight: 600, color: '#ffffff', margin: 0 }}>Trade History</h2>
              <button style={styles.btnPrimary} onClick={() => setShowTradeModal(true)}>+ Record Trade</button>
            </div>
            
            {trades.sort((a, b) => new Date(b.date) - new Date(a.date)).map(trade => {
              const position = positions.find(p => p.id === trade.positionId);
              return (
                <div key={trade.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 12, backgroundColor: '#0f1629', border: '1px solid #1e293b', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ width: 48, height: 48, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: trade.type === 'buy' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)', border: `1px solid ${trade.type === 'buy' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}` }}><span style={{ fontSize: 12, fontWeight: 700, color: trade.type === 'buy' ? '#34d399' : '#f87171' }}>{trade.type === 'buy' ? 'BUY' : 'SELL'}</span></div>
                    <div><p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>{position?.symbol || 'Unknown'}</p><p style={{ fontSize: 14, color: '#6b7280', margin: '2px 0' }}>{formatDate(trade.date)}</p></div>
                  </div>
                  <div style={{ textAlign: 'right' }}><p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>{formatNumber(trade.shares, trade.shares < 1 ? 4 : 2)} shares</p><p style={{ fontSize: 14, color: '#6b7280', margin: '2px 0' }}>@ {formatCurrency(trade.price, position?.currency || 'EUR')}</p>{trade.fee > 0 && <p style={{ fontSize: 12, color: '#f87171', margin: 0 }}>Fee: {formatCurrency(trade.fee, position?.currency || 'EUR')}</p>}</div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Position Detail Modal */}
      {selectedPosition && (
        <div style={styles.modal} onClick={() => setSelectedPosition(null)}>
          <div style={{ ...styles.modalContent, maxWidth: 640, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '24px 24px 16px', borderBottom: '1px solid #1e293b', background: 'linear-gradient(135deg, #111827, #0f1629)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ width: 56, height: 56, borderRadius: 14, background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.1))', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ fontFamily: 'monospace', fontSize: 18, fontWeight: 700, color: '#ffffff' }}>{selectedPosition.symbol.slice(0, 3)}</span></div>
                  <div><h3 style={{ fontSize: 20, fontWeight: 600, color: '#ffffff', margin: 0 }}>{selectedPosition.symbol}</h3><p style={{ color: '#9ca3af', margin: '4px 0 0' }}>{selectedPosition.name}</p></div>
                </div>
                <button onClick={() => setSelectedPosition(null)} style={{ background: 'none', border: 'none', padding: 8, borderRadius: 8, cursor: 'pointer', color: '#9ca3af' }}><svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
              </div>
            </div>

            <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
                <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}><p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Current Value</p><p style={{ fontSize: 18, fontWeight: 600, color: '#ffffff', margin: 0 }}>{formatCurrency(selectedPosition.valueEUR)}</p></div>
                <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}><p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Net Return</p><p style={{ fontSize: 18, fontWeight: 600, color: selectedPosition.netReturnPct >= 0 ? '#34d399' : '#f87171', margin: 0 }}>{formatPercent(selectedPosition.netReturnPct)}</p></div>
                <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}><p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>Total Fees</p><p style={{ fontSize: 18, fontWeight: 600, color: '#f87171', margin: 0 }}>{formatCurrency(selectedPosition.totalFees)}</p></div>
              </div>

              <div style={{ marginBottom: 24 }}>
                <h4 style={{ fontSize: 12, fontWeight: 500, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Transactions</h4>
                {getPositionTrades(selectedPosition.id).length > 0 ? getPositionTrades(selectedPosition.id).map(trade => (
                  <div key={trade.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: trade.type === 'buy' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)', border: `1px solid ${trade.type === 'buy' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}` }}><span style={{ fontSize: 10, fontWeight: 700, color: trade.type === 'buy' ? '#34d399' : '#f87171' }}>{trade.type === 'buy' ? 'BUY' : 'SELL'}</span></div>
                      <div><p style={{ fontSize: 14, fontWeight: 500, color: '#ffffff', margin: 0 }}>{formatNumber(trade.shares, trade.shares < 1 ? 4 : 2)} shares @ {formatCurrency(trade.price, selectedPosition.currency)}</p><p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>{formatDate(trade.date)}</p></div>
                    </div>
                    <div style={{ textAlign: 'right' }}><p style={{ fontSize: 14, fontWeight: 500, color: '#ffffff', margin: 0 }}>{formatCurrency(toEUR(trade.shares * trade.price, selectedPosition.currency))}</p>{trade.fee > 0 && <p style={{ fontSize: 12, color: '#f87171', margin: '2px 0 0' }}>Fee: {formatCurrency(trade.fee, selectedPosition.currency)}</p>}</div>
                  </div>
                )) : <p style={{ color: '#6b7280', fontSize: 14, textAlign: 'center', padding: 16 }}>No transactions recorded</p>}
              </div>

              <div>
                <h4 style={{ fontSize: 12, fontWeight: 500, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Related Fees</h4>
                {getPositionFees(selectedPosition.id).length > 0 ? getPositionFees(selectedPosition.id).map(fee => (
                  <div key={fee.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 8, background: 'rgba(248,113,113,0.2)', border: '1px solid rgba(248,113,113,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="16" height="16" fill="none" stroke="#f87171" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>
                      <div><p style={{ fontSize: 14, fontWeight: 500, color: '#ffffff', margin: 0 }}>{fee.type}</p><p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>{fee.description} • {formatDate(fee.date)}</p></div>
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 500, color: '#f87171' }}>{formatCurrency(fee.amount, fee.currency)}</span>
                  </div>
                )) : <p style={{ color: '#6b7280', fontSize: 14, textAlign: 'center', padding: 16 }}>No position-specific fees</p>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {showAddModal && (
        <div style={styles.modal}>
          <div style={styles.modalContent}>
            <h3 style={styles.modalTitle}>Add New Position</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}><div><label style={styles.inputLabel}>Symbol *</label><input type="text" value={newPosition.symbol} onChange={(e) => setNewPosition({...newPosition, symbol: e.target.value})} style={styles.input} placeholder="AAPL" /></div><div><label style={styles.inputLabel}>Type</label><select value={newPosition.type} onChange={(e) => setNewPosition({...newPosition, type: e.target.value})} style={styles.select}>{ASSET_TYPES.map(type => <option key={type} value={type}>{type}</option>)}</select></div></div>
            <div style={{ marginBottom: 16 }}><label style={styles.inputLabel}>Name</label><input type="text" value={newPosition.name} onChange={(e) => setNewPosition({...newPosition, name: e.target.value})} style={styles.input} placeholder="Apple Inc." /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}><div><label style={styles.inputLabel}>Shares *</label><input type="number" value={newPosition.shares} onChange={(e) => setNewPosition({...newPosition, shares: e.target.value})} style={styles.input} placeholder="100" step="any" /></div><div><label style={styles.inputLabel}>Avg Price *</label><input type="number" value={newPosition.avgPrice} onChange={(e) => setNewPosition({...newPosition, avgPrice: e.target.value})} style={styles.input} placeholder="150.00" step="any" /></div></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}><div><label style={styles.inputLabel}>Currency</label><select value={newPosition.currency} onChange={(e) => setNewPosition({...newPosition, currency: e.target.value})} style={styles.select}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div><div><label style={styles.inputLabel}>Dividend Yield %</label><input type="number" value={newPosition.dividendYield} onChange={(e) => setNewPosition({...newPosition, dividendYield: e.target.value})} style={styles.input} placeholder="1.5" step="any" /></div></div>
            <div style={styles.modalButtons}><button onClick={() => setShowAddModal(false)} style={{ ...styles.btnSecondary, flex: 1 }}>Cancel</button><button onClick={handleAddPosition} style={{ ...styles.btnPrimary, flex: 1 }}>Add Position</button></div>
          </div>
        </div>
      )}

      {showTradeModal && (
        <div style={styles.modal}>
          <div style={styles.modalContent}>
            <h3 style={styles.modalTitle}>Record Trade</h3>
            <div style={{ marginBottom: 16 }}><label style={styles.inputLabel}>Position *</label><select value={newTrade.positionId} onChange={(e) => setNewTrade({...newTrade, positionId: e.target.value})} style={styles.select}><option value="">Select position...</option>{positions.map(p => <option key={p.id} value={p.id}>{p.symbol} - {p.name}</option>)}</select></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}><div><label style={styles.inputLabel}>Type</label><select value={newTrade.type} onChange={(e) => setNewTrade({...newTrade, type: e.target.value})} style={styles.select}><option value="buy">Buy</option><option value="sell">Sell</option></select></div><div><label style={styles.inputLabel}>Date</label><input type="date" value={newTrade.date} onChange={(e) => setNewTrade({...newTrade, date: e.target.value})} style={styles.input} /></div></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}><div><label style={styles.inputLabel}>Shares *</label><input type="number" value={newTrade.shares} onChange={(e) => setNewTrade({...newTrade, shares: e.target.value})} style={styles.input} placeholder="10" step="any" /></div><div><label style={styles.inputLabel}>Price *</label><input type="number" value={newTrade.price} onChange={(e) => setNewTrade({...newTrade, price: e.target.value})} style={styles.input} placeholder="150.00" step="any" /></div><div><label style={styles.inputLabel}>Fee</label><input type="number" value={newTrade.fee} onChange={(e) => setNewTrade({...newTrade, fee: e.target.value})} style={styles.input} placeholder="4.99" step="any" /></div></div>
            <div style={styles.modalButtons}><button onClick={() => setShowTradeModal(false)} style={{ ...styles.btnSecondary, flex: 1 }}>Cancel</button><button onClick={handleAddTrade} style={{ ...styles.btnPrimary, flex: 1 }}>Record Trade</button></div>
          </div>
        </div>
      )}

      {showFeeModal && (
        <div style={styles.modal}>
          <div style={styles.modalContent}>
            <h3 style={styles.modalTitle}>Add Fee / Cost</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}><div><label style={styles.inputLabel}>Fee Type *</label><select value={newFee.type} onChange={(e) => setNewFee({...newFee, type: e.target.value})} style={styles.select}>{FEE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}</select></div><div><label style={styles.inputLabel}>Date</label><input type="date" value={newFee.date} onChange={(e) => setNewFee({...newFee, date: e.target.value})} style={styles.input} /></div></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}><div><label style={styles.inputLabel}>Amount *</label><input type="number" value={newFee.amount} onChange={(e) => setNewFee({...newFee, amount: e.target.value})} style={styles.input} placeholder="10.00" step="any" /></div><div><label style={styles.inputLabel}>Currency</label><select value={newFee.currency} onChange={(e) => setNewFee({...newFee, currency: e.target.value})} style={styles.select}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div></div>
            <div style={{ marginBottom: 16 }}><label style={styles.inputLabel}>Related Position (optional)</label><select value={newFee.positionId} onChange={(e) => setNewFee({...newFee, positionId: e.target.value})} style={styles.select}><option value="">None (general fee)</option>{positions.map(p => <option key={p.id} value={p.id}>{p.symbol} - {p.name}</option>)}</select></div>
            <div><label style={styles.inputLabel}>Description</label><input type="text" value={newFee.description} onChange={(e) => setNewFee({...newFee, description: e.target.value})} style={styles.input} placeholder="Monthly custody fee" /></div>
            <div style={styles.modalButtons}><button onClick={() => setShowFeeModal(false)} style={{ ...styles.btnSecondary, flex: 1 }}>Cancel</button><button onClick={handleAddFee} style={{ ...styles.btnPrimary, flex: 1 }}>Add Fee</button></div>
          </div>
        </div>
      )}

      {showImportModal && (
        <div style={styles.modal}>
          <div style={{ ...styles.modalContent, maxWidth: 560 }}>
            <h3 style={styles.modalTitle}>📥 Import Data</h3>
            <div style={{ marginBottom: 16 }}>
              <label style={styles.inputLabel}>Import Type</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setImportType('transactions')} style={{ ...styles.btnSecondary, flex: 1, backgroundColor: importType === 'transactions' ? '#6366f1' : '#111827', color: importType === 'transactions' ? '#fff' : '#9ca3af' }}>Transactions</button>
                <button onClick={() => setImportType('positions')} style={{ ...styles.btnSecondary, flex: 1, backgroundColor: importType === 'positions' ? '#6366f1' : '#111827', color: importType === 'positions' ? '#fff' : '#9ca3af' }}>Positions</button>
                <button onClick={() => setImportType('trades')} style={{ ...styles.btnSecondary, flex: 1, backgroundColor: importType === 'trades' ? '#6366f1' : '#111827', color: importType === 'trades' ? '#fff' : '#9ca3af' }}>Trades</button>
              </div>
            </div>
            <div style={{ padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', marginBottom: 16 }}>
              <p style={{ fontSize: 14, fontWeight: 500, color: '#d1d5db', marginBottom: 8 }}>Expected format ({importType}):</p>
              <code style={{ display: 'block', fontSize: 10, fontFamily: 'monospace', backgroundColor: '#0a0d14', padding: 12, borderRadius: 8, overflowX: 'auto', color: '#9ca3af', border: '1px solid #1e293b', whiteSpace: 'pre-wrap' }}>
                {importType === 'transactions' ? `symbol,quantity,price_per_unit,asset_type,transaction_type,transaction_date,currency
NVDA:xnas,10,136.24,Stock,Buy,2024-01-15,USD
Fee,0,-4.99,Expense,Trade,2024-01-15,EUR` : importType === 'positions' ? `symbol,name,type,shares,avg_price,currency
AAPL,Apple Inc.,Stock,100,150.00,USD` : `date,symbol,type,shares,price,fee
2024-01-15,AAPL,buy,100,150.00,4.99`}
              </code>
              <p style={{ fontSize: 11, color: '#6b7280', marginTop: 8 }}>Supports: comma/semicolon delimiter, various date formats, Dutch decimals</p>
            </div>
            <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} style={{ ...styles.input, height: 192, resize: 'none', fontFamily: 'monospace', fontSize: 13 }} placeholder="Paste your CSV data here..." />
            <div style={styles.modalButtons}><button onClick={() => { setCsvText(''); setShowImportModal(false); }} style={{ ...styles.btnSecondary, flex: 1 }}>Cancel</button><button onClick={handleImportCSV} style={{ ...styles.btnPrimary, flex: 1 }}>Import {importType}</button></div>
          </div>
        </div>
      )}

      {showExportModal && (
        <div style={styles.modal}>
          <div style={{ ...styles.modalContent, maxWidth: 384 }}>
            <h3 style={styles.modalTitle}>Export Data</h3>
            <button onClick={() => { handleExport('positions'); setShowExportModal(false); }} style={{ width: '100%', padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', textAlign: 'left', cursor: 'pointer', marginBottom: 12 }}><p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>Export Positions</p><p style={{ fontSize: 14, color: '#6b7280', margin: '4px 0 0' }}>Download all holdings as CSV</p></button>
            <button onClick={() => { handleExport('trades'); setShowExportModal(false); }} style={{ width: '100%', padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b', textAlign: 'left', cursor: 'pointer' }}><p style={{ fontWeight: 500, color: '#ffffff', margin: 0 }}>Export Trades</p><p style={{ fontSize: 14, color: '#6b7280', margin: '4px 0 0' }}>Download trade history as CSV</p></button>
            <button onClick={() => setShowExportModal(false)} style={{ ...styles.btnSecondary, width: '100%', marginTop: 16 }}>Cancel</button>
          </div>
        </div>
      )}

      {showSettingsModal && (
        <div style={styles.modal}>
          <div style={{ ...styles.modalContent, maxWidth: 600, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={styles.modalTitle}>⚙️ Settings</h3>
            <div style={{ marginBottom: 24 }}>
              <h4 style={{ fontSize: 14, fontWeight: 600, color: '#ffffff', marginBottom: 12 }}>☁️ Supabase Connection</h4>
              <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>Connect to your Supabase database to load portfolio transactions.</p>
              <div style={{ marginBottom: 16 }}>
                <label style={styles.inputLabel}>Supabase URL</label>
                <input type="text" value={supabaseUrl} onChange={(e) => setSupabaseUrl(e.target.value)} style={styles.input} placeholder="https://xxxxx.supabase.co" />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={styles.inputLabel}>Anon Key</label>
                <input type="password" value={supabaseKey} onChange={(e) => setSupabaseKey(e.target.value)} style={styles.input} placeholder="eyJhbGciOiJIUzI1NiIs..." />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={styles.inputLabel}>Table Name *</label>
                <input type="text" value={supabaseTable} onChange={(e) => setSupabaseTable(e.target.value)} style={styles.input} placeholder="transactions" />
                <p style={{ fontSize: 11, color: '#fbbf24', marginTop: 4 }}>⚠️ Must match your exact table name in Supabase (case-sensitive)</p>
              </div>
              <div style={{ padding: 12, borderRadius: 8, backgroundColor: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)' }}>
                <p style={{ fontSize: 12, color: '#818cf8', margin: 0 }}>💡 Find URL & Key in Supabase Dashboard → Settings → API</p>
              </div>
            </div>
            {syncStatus.message && (
              <div style={{ padding: 12, borderRadius: 8, backgroundColor: syncStatus.status === 'error' ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)', border: `1px solid ${syncStatus.status === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(52,211,153,0.3)'}`, marginBottom: 16 }}>
                <p style={{ fontSize: 12, color: syncStatus.status === 'error' ? '#f87171' : '#34d399', margin: 0 }}>{syncStatus.message}</p>
              </div>
            )}
            {dataSource === 'supabase' && rawTransactions.length > 0 && (
              <div style={{ marginBottom: 24, padding: 16, borderRadius: 12, backgroundColor: '#111827', border: '1px solid #1e293b' }}>
                <h4 style={{ fontSize: 14, fontWeight: 600, color: '#34d399', marginBottom: 12 }}>✅ Connected to Supabase</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12 }}>
                  <div><span style={{ color: '#6b7280' }}>Transactions:</span> <span style={{ color: '#fff' }}>{rawTransactions.length}</span></div>
                  <div><span style={{ color: '#6b7280' }}>Positions:</span> <span style={{ color: '#fff' }}>{positions.length}</span></div>
                  <div><span style={{ color: '#6b7280' }}>Trades:</span> <span style={{ color: '#fff' }}>{trades.length}</span></div>
                  <div><span style={{ color: '#6b7280' }}>Fees:</span> <span style={{ color: '#fff' }}>{fees.length}</span></div>
                  <div><span style={{ color: '#6b7280' }}>Dividends:</span> <span style={{ color: '#fff' }}>{receivedDividends.length}</span></div>
                </div>
              </div>
            )}
            {/* Position Debug Info */}
            {positions.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <h4 style={{ fontSize: 14, fontWeight: 600, color: '#ffffff', marginBottom: 12 }}>📊 Position Calculations</h4>
                <div style={{ maxHeight: 200, overflowY: 'auto', backgroundColor: '#0a0d14', borderRadius: 8, padding: 12 }}>
                  <table style={{ width: '100%', fontSize: 10, fontFamily: 'monospace' }}>
                    <thead>
                      <tr style={{ color: '#6b7280' }}>
                        <th style={{ textAlign: 'left', padding: 4 }}>Symbol</th>
                        <th style={{ textAlign: 'right', padding: 4 }}>Shares</th>
                        <th style={{ textAlign: 'right', padding: 4 }}>Avg Price</th>
                        <th style={{ textAlign: 'right', padding: 4 }}>Total Cost</th>
                        <th style={{ textAlign: 'left', padding: 4 }}>Ccy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map(p => (
                        <tr key={p.symbol} style={{ color: '#d1d5db' }}>
                          <td style={{ padding: 4 }}>{p.symbol}</td>
                          <td style={{ textAlign: 'right', padding: 4 }}>{p.shares.toFixed(4)}</td>
                          <td style={{ textAlign: 'right', padding: 4 }}>{p.avgPrice.toFixed(2)}</td>
                          <td style={{ textAlign: 'right', padding: 4 }}>{(p.shares * p.avgPrice).toFixed(2)}</td>
                          <td style={{ padding: 4 }}>{p.currency}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div style={styles.modalButtons}>
              <button onClick={() => setShowSettingsModal(false)} style={{ ...styles.btnSecondary, flex: 1 }}>Cancel</button>
              <button onClick={saveSupabaseSettings} style={{ ...styles.btnPrimary, flex: 1 }}>Save & Connect</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

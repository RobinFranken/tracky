'use client'
import { useEffect, useState } from 'react';
import { getPortfolioSummary } from '@/services/portfolio';
import { AreaChart, Area, Tooltip, ResponsiveContainer } from 'recharts';

// Mapping symbols to their respective API IDs
const CRYPTO_MAP = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana' };
const STOCK_KEY = process.env.NEXT_PUBLIC_TWELVE_DATA_KEY;

export default function Dashboard() {
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [totalValue, setTotalValue] = useState(0);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    async function loadPortfolioData() {
      try {
        setLoading(true);
        const portfolio = await getPortfolioSummary();
        if (!portfolio || portfolio.length === 0) { setHoldings([]); setLoading(false); return; }

        // 1. Fetch Crypto Prices (CoinGecko)
        const cryptoSymbols = portfolio.filter(item => CRYPTO_MAP[item.symbol.toUpperCase()]);
        const cryptoIds = cryptoSymbols.map(item => CRYPTO_MAP[item.symbol.toUpperCase()]).join(',');
        let cryptoPrices = {};
        if (cryptoIds) {
          const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cryptoIds}&vs_currencies=usd`);
          cryptoPrices = await res.json();
        }

        // 2. Fetch Stock Prices (Twelve Data)
        const stockSymbols = portfolio.filter(item => !CRYPTO_MAP[item.symbol.toUpperCase()]).map(item => item.symbol).join(',');
        let stockPrices = {};
        if (stockSymbols && STOCK_KEY) {
          const res = await fetch(`https://api.twelvedata.com/price?symbol=${stockSymbols}&apikey=${STOCK_KEY}`);
          stockPrices = await res.json();
        }

        // 3. Merge & Calculate
        const mergedData = portfolio.map((item) => {
          const symbol = item.symbol.toUpperCase();
          const isCrypto = CRYPTO_MAP[symbol];
          
          // Get price from either Crypto or Stock API
          let livePrice = isCrypto 
            ? cryptoPrices[CRYPTO_MAP[symbol]]?.usd 
            : parseFloat(stockPrices[symbol]?.price || stockPrices?.price); // Twelve Data format varies if single vs multiple

          livePrice = livePrice || item.avg_buy_price; // Fallback to cost
          
          const marketValue = livePrice * item.total_qty;
          const totalCost = item.avg_buy_price * item.total_qty;

          return {
            ...item,
            currentPrice: livePrice,
            marketValue,
            gainLoss: marketValue - totalCost,
            gainLossPercentage: totalCost !== 0 ? ((marketValue - totalCost) / Math.abs(totalCost)) * 100 : 0
          };
        });

        const currentTotal = mergedData.reduce((acc, curr) => acc + curr.marketValue, 0);
        setTotalValue(currentTotal);
        setHoldings(mergedData);
        setHistory([
          { d: '1', v: currentTotal * 0.95 }, { d: '2', v: currentTotal * 0.98 },
          { d: '3', v: currentTotal * 0.96 }, { d: '4', v: currentTotal }
        ]);

      } catch (err) {
        console.error("Dashboard Fetch Error:", err);
      } finally {
        setLoading(false);
      }
    }
    loadPortfolioData();
  }, []);

  if (loading) return <div className="flex items-center justify-center min-h-screen bg-black text-white">Refining Data...</div>;

  return (
    <main className="p-8 bg-black min-h-screen text-white font-sans max-w-6xl mx-auto">
      {/* Top Nav/Stats */}
      <div className="flex justify-between items-start mb-12">
        <div>
          <p className="text-slate-500 text-xs uppercase font-bold tracking-widest">Live Portfolio Value</p>
          <h1 className="text-6xl font-black mt-2 tracking-tighter">
            ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </h1>
        </div>
        <div className="flex gap-3">
          <a href="/history" className="bg-slate-900 text-white font-bold py-3 px-6 rounded-full border border-slate-800 hover:bg-slate-800 transition-all text-sm">
            View Logs
          </a>
          <a href="/add-trade" className="bg-white text-black font-bold py-3 px-6 rounded-full hover:bg-emerald-400 transition-all text-sm">
            + New Trade
          </a>
        </div>
      </div>

      {/* Hero Graph */}
      <div className="h-48 mb-12 bg-slate-900/20 rounded-3xl border border-slate-800 p-2 overflow-hidden">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={history}>
            <Tooltip content={() => null} />
            <Area type="monotone" dataKey="v" stroke="#10b981" strokeWidth={3} fillOpacity={0.2} fill="#10b981" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Asset Table */}
      <div className="bg-slate-900/40 border border-slate-800 rounded-3xl overflow-hidden backdrop-blur-md">
        <table className="w-full text-left">
          <thead className="bg-slate-950/50 text-slate-500 text-[10px] uppercase tracking-widest">
            <tr>
              <th className="p-5">Asset</th>
              <th className="p-5 text-right">Holdings</th>
              <th className="p-5 text-right">Market Price</th>
              <th className="p-5 text-right">Value</th>
              <th className="p-5 text-right">Profit / Loss</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {holdings.map((item) => (
              <tr key={item.symbol} className="hover:bg-slate-800/20 transition-all">
                <td className="p-5 font-black text-xl">{item.symbol}</td>
                <td className="p-5 text-right">
                  <div className="font-bold">{item.total_qty}</div>
                  <div className="text-[10px] text-slate-500 uppercase">Avg: ${Number(item.avg_buy_price).toFixed(2)}</div>
                </td>
                <td className="p-5 text-right font-mono text-slate-400">
                  ${item.currentPrice?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td className="p-5 text-right font-bold text-lg">
                  ${item.marketValue?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td className={`p-5 text-right font-bold ${item.gainLoss >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                  <div>{item.gainLoss >= 0 ? '+' : ''}${Math.abs(item.gainLoss).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                  <div className="text-xs font-medium uppercase">{item.gainLossPercentage?.toFixed(2)}%</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
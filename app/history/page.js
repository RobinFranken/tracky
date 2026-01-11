'use client'
import { useEffect, useState } from 'react';
import { getAllTransactions } from '@/services/portfolio';

export default function History() {
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    async function loadLogs() {
      const data = await getAllTransactions();
      setLogs(data);
    }
    loadLogs();
  }, []);

  return (
    <main className="p-8 bg-black min-h-screen text-white font-sans">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-10">
          <h1 className="text-4xl font-black tracking-tighter text-white">Trade Logs</h1>
          <a href="/dashboard" className="text-slate-400 hover:text-white transition-all text-sm">← Back to Dashboard</a>
        </div>

        <div className="bg-slate-900/40 border border-slate-800 rounded-3xl overflow-hidden">
          <table className="w-full text-left">
            <thead className="bg-slate-900 text-slate-500 text-[10px] uppercase tracking-widest">
              <tr>
                <th className="p-5">Date</th>
                <th className="p-5">Type</th>
                <th className="p-5">Asset</th>
                <th className="p-5 text-right">Quantity</th>
                <th className="p-5 text-right">Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-800/20 transition-all">
                  <td className="p-5 text-slate-400 text-sm">
                    {new Date(log.transaction_date).toLocaleDateString()}
                  </td>
                  <td className="p-5">
                    <span className={`text-[10px] font-bold px-2 py-1 rounded-md ${log.quantity > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                      {log.quantity > 0 ? 'BUY' : 'SELL'}
                    </span>
                  </td>
                  <td className="p-5 font-bold">{log.symbol}</td>
                  <td className="p-5 text-right font-mono">{Math.abs(log.quantity)}</td>
                  <td className="p-5 text-right font-mono text-slate-300">${Number(log.price_per_unit).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
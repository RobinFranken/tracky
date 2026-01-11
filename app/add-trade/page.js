'use client'
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { recordTransaction } from '@/services/portfolio';

export default function AddTrade() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [type, setType] = useState('buy'); // 'buy' or 'sell'
  const [formData, setFormData] = useState({
    symbol: '',
    quantity: '',
    price_per_unit: '',
    asset_type: 'crypto'
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await recordTransaction({ ...formData, type });
      router.push('/dashboard');
    } catch (err) {
      alert("Error logging trade: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="p-8 bg-black min-h-screen text-white font-sans flex items-center justify-center">
      <div className="max-w-md w-full bg-slate-900/50 p-8 rounded-3xl border border-slate-800 backdrop-blur-md">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-black tracking-tighter">Log Trade</h1>
          <div className="flex bg-black p-1 rounded-xl border border-slate-800">
            <button 
              onClick={() => setType('buy')}
              className={`px-4 py-1 rounded-lg text-xs font-bold transition-all ${type === 'buy' ? 'bg-emerald-500 text-black' : 'text-slate-500'}`}
            >BUY</button>
            <button 
              onClick={() => setType('sell')}
              className={`px-4 py-1 rounded-lg text-xs font-bold transition-all ${type === 'sell' ? 'bg-rose-500 text-white' : 'text-slate-500'}`}
            >SELL</button>
          </div>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase">Ticker</label>
            <input required className="w-full bg-slate-950 border border-slate-800 p-4 rounded-xl mt-1 focus:border-white outline-none"
              placeholder="BTC, AMZN, etc." value={formData.symbol}
              onChange={(e) => setFormData({...formData, symbol: e.target.value})} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase">Quantity</label>
              <input required type="number" step="any" className="w-full bg-slate-950 border border-slate-800 p-4 rounded-xl mt-1"
                placeholder="0.00" value={formData.quantity}
                onChange={(e) => setFormData({...formData, quantity: e.target.value})} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase">Price</label>
              <input required type="number" step="any" className="w-full bg-slate-950 border border-slate-800 p-4 rounded-xl mt-1"
                placeholder="$" value={formData.price_per_unit}
                onChange={(e) => setFormData({...formData, price_per_unit: e.target.value})} />
            </div>
          </div>

          <button type="submit" disabled={loading}
            className={`w-full font-black py-4 rounded-xl mt-4 transition-all ${type === 'buy' ? 'bg-emerald-500 text-black' : 'bg-rose-500 text-white'}`}>
            {loading ? 'Processing...' : `Confirm ${type.toUpperCase()}`}
          </button>
        </form>
      </div>
    </main>
  );
}
'use client'
import { recordTransaction } from '@/services/portfolio';
import { useState } from 'react';

export default function AddTrade() {
  const [symbol, setSymbol] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Logic to call our service
    await recordTransaction({
      symbol: symbol,
      quantity: 10,       // You'd get these from form inputs
      price_per_unit: 150,
      asset_type: 'stock'
    });
    alert('Trade Logged!');
  };

  return (
    <form onSubmit={handleSubmit} className="p-10">
      <input 
        value={symbol} 
        onChange={(e) => setSymbol(e.target.value)}
        placeholder="Ticker (e.g. BTC)"
        className="border p-2 rounded mr-2 text-black"
      />
      <button type="submit" className="bg-blue-500 text-white p-2 rounded">
        Add to Tracky
      </button>
    </form>
  );
}
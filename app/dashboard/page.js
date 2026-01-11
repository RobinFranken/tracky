'use client'
import { useEffect, useState } from 'react';
import { getPortfolioSummary } from '@/services/portfolio';

// 1. Ensure the function name is Capitalized (Dashboard, not dashboard)
export default function Dashboard() { 
  const [holdings, setHoldings] = useState([]);

  useEffect(() => {
    async function loadData() {
      try {
        const data = await getPortfolioSummary();
        setHoldings(data || []);
      } catch (err) {
        console.error(err);
      }
    }
    loadData();
  }, []);

  // 2. Ensure it RETURNS valid JSX (tags like <div>, <h1>, etc.)
  return (
    <main className="p-8 bg-black min-h-screen text-white">
      <h1 className="text-3xl font-bold mb-6">Tracky Dashboard</h1>
      {/* ... the rest of the table code ... */}
    </main>
  );
}
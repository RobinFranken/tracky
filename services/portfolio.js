import { supabase } from '../lib/supabase';

// Use this to save a new trade
export const recordTransaction = async (tradeData) => {
  const { data, error } = await supabase
    .from('transactions')
    .insert([tradeData]);
  
  if (error) throw error;
  return data;
};

// Use this to fetch your current positions (the View we created)
export const getPortfolioSummary = async () => {
  const { data, error } = await supabase
    .from('portfolio_summary')
    .select('*');
    
  if (error) throw error;
  return data;
};
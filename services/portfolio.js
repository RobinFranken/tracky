import { supabase } from '../lib/supabase';

export const recordTransaction = async (tradeData) => {
  const { data: { user } } = await supabase.auth.getUser();
  
  // The Architect: If it's a sell, we ensure the quantity is stored as a negative number
  const quantity = tradeData.type === 'sell' 
    ? -Math.abs(tradeData.quantity) 
    : Math.abs(tradeData.quantity);

  const { data, error } = await supabase
    .from('transactions')
    .insert([{
      symbol: tradeData.symbol.toUpperCase(),
      quantity: quantity,
      price_per_unit: tradeData.price_per_unit,
      asset_type: tradeData.asset_type,
      user_id: user?.id || null 
    }]);
  
  if (error) throw error;
  return data;
};

// New function for the Trade Log page
export const getAllTransactions = async () => {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .order('transaction_date', { ascending: false });
    
  if (error) throw error;
  return data;
};

export const getPortfolioSummary = async () => {
  const { data, error } = await supabase
    .from('portfolio_summary')
    .select('*');
    
  if (error) throw error;
  return data;
};
import supabase from '../lib/supabase.js';
import { createRaffleHandler } from '../lib/raffle.js';
export default createRaffleHandler({ db: supabase });

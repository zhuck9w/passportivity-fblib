import { createClient } from '@supabase/supabase-js';
import { env } from './env';

export const supabase = createClient(env.supabaseUrl, env.supabaseServerKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

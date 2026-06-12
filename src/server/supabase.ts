import { createClient } from '@supabase/supabase-js';
import { env } from './env';
import { supabaseFetch } from './proxy';

// undefined unless the PROXY_SUPABASE flag (see proxy.ts) is on — then DB traffic is
// proxied too. Otherwise supabase-js keeps its default direct fetch.
const proxyFetch = supabaseFetch();

export const supabase = createClient(env.supabaseUrl, env.supabaseServerKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  },
  ...(proxyFetch ? { global: { fetch: proxyFetch } } : {})
});

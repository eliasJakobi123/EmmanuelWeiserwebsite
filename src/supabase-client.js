/** Gemeinsamer Supabase-Client (Anon) für main + Admin. */
export async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = import.meta.env.VITE_SUPABASE_URL || ''
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
  if (!url || !key) return null
  return createClient(url, key)
}

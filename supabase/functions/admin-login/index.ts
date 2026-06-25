import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const { email, password } = await req.json()
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: secrets } = await sb
      .from('vault.decrypted_secrets')
      .select('name, decrypted_secret')
      .in('name', ['ADMIN_EMAIL', 'ADMIN_PASSWORD'])

    const adminEmail = secrets?.find(s => s.name === 'ADMIN_EMAIL')?.decrypted_secret
    const adminPass  = secrets?.find(s => s.name === 'ADMIN_PASSWORD')?.decrypted_secret

    if (!adminEmail || !adminPass || email !== adminEmail || password !== adminPass) {
      return new Response(JSON.stringify({ ok: false }), { status: 401, headers: CORS })
    }
    return new Response(JSON.stringify({ ok: true, session: adminPass }), { headers: CORS })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: CORS })
  }
})

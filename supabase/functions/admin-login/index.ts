import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const { email, password } = await req.json()
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: adminEmail } = await sb.rpc('get_vault_secret', { p_name: 'ADMIN_EMAIL' })
    const { data: adminPass }  = await sb.rpc('get_vault_secret', { p_name: 'ADMIN_PASSWORD' })

    if (!adminEmail || !adminPass || email !== adminEmail || password !== adminPass) {
      return new Response(JSON.stringify({ ok: false }), { status: 401, headers: CORS })
    }
    return new Response(JSON.stringify({ ok: true, session: adminPass }), { headers: CORS })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: CORS })
  }
})

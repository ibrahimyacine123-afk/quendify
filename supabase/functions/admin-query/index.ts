import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const body = await req.json()
    const ADMIN_PASS = Deno.env.get('ADMIN_PASS')
    if (!ADMIN_PASS || body.admin_pass !== ADMIN_PASS) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    switch (body.action) {

      case 'get-transactions': {
        const { data, error } = await sb.from('client_transactions').select('*').order('created_at', { ascending: false })
        if (error) throw error
        return new Response(JSON.stringify(data), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'get-clients': {
        const [{ data: users, error: ue }, { data: txs, error: te }] = await Promise.all([
          sb.from('quendify_users').select('id, full_name, email, phone, country, created_at, is_active').order('created_at', { ascending: false }),
          sb.from('client_transactions').select('email, amount_send, currency_from, status')
        ])
        if (ue || te) throw ue || te
        return new Response(JSON.stringify({ users, txs }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'toggle-active': {
        const { user_id } = body
        if (!user_id) {
          return new Response(JSON.stringify({ error: 'user_id requis' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        const { data: current, error: fe } = await sb.from('quendify_users').select('is_active').eq('id', user_id).maybeSingle()
        if (fe) throw fe
        if (!current) {
          return new Response(JSON.stringify({ error: 'Utilisateur introuvable' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        const newValue = !current.is_active
        const { error: ue } = await sb.from('quendify_users').update({ is_active: newValue }).eq('id', user_id)
        if (ue) throw ue
        return new Response(JSON.stringify({ ok: true, is_active: newValue }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'update-status': {
        const { id, tx_id, new_status, old_status, note } = body
        const { error: ue } = await sb.from('client_transactions')
          .update({ status: new_status, updated_at: new Date().toISOString() })
          .eq('id', id)
        if (ue) throw ue
        await sb.from('tx_status_history').insert([{ tx_id, old_status, new_status, note: note || null }])
        if (new_status === 'processing' || new_status === 'completed') {
          const { data: tx } = await sb.from('client_transactions')
            .select('email, first_name, last_name, amount_send, currency_from, amount_receive, currency_to, recipient_momo')
            .eq('id', id).maybeSingle()
          if (tx) {
            const isCompleted = new_status === 'completed'
            await fetch(Deno.env.get('SUPABASE_URL')! + '/functions/v1/send-status', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! },
              body: JSON.stringify({
                email: tx.email, name: tx.first_name, txId: tx_id,
                status: isCompleted ? 'completed' : 'received',
                amount: Number(tx.amount_send).toLocaleString('fr'), currency: tx.currency_from,
                received: Number(tx.amount_receive).toLocaleString('fr'), currencyTo: tx.currency_to,
                ...(isCompleted ? {
                  recipientName: `${tx.first_name}${tx.last_name ? ' ' + tx.last_name : ''}`,
                  corridor: `${tx.currency_from} → ${tx.currency_to}`,
                  receptionMode: tx.recipient_momo ? `Mobile Money · ${tx.recipient_momo}` : 'Virement bancaire',
                  confirmedAt: new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Istanbul' })
                } : {})
              })
            }).catch(() => {})
          }
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'update-corridor': {
        const { id, margin } = body
        if (typeof margin !== 'number' || margin < 0 || margin > 1) {
          return new Response(JSON.stringify({ error: 'Marge invalide (doit être entre 0 et 1)' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        const { error } = await sb.from('qnd_corridors').update({ margin }).eq('id', id)
        if (error) throw error
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'update-corridor-bulk': {
        const { margin } = body
        if (typeof margin !== 'number' || margin < 0 || margin > 1) {
          return new Response(JSON.stringify({ error: 'Marge invalide (doit être entre 0 et 1)' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        const { error } = await sb.from('qnd_corridors').update({ margin }).neq('id', 0)
        if (error) throw error
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'get-accounts': {
        const { data, error } = await sb.from('qnd_collection_accounts').select('*').order('sort_order')
        if (error) throw error
        return new Response(JSON.stringify(data), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'save-account': {
        const { id, currency, label, account_name, bank_name, account_number, extra, active, country_code } = body
        const { error } = await sb.from('qnd_collection_accounts')
          .update({ currency, label, account_name, bank_name, account_number, extra, active, country_code })
          .eq('id', id)
        if (error) throw error
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'add-account': {
        const { currency, method, label, account_name, bank_name, account_number, extra, country_code } = body
        if (!currency || !method) {
          return new Response(JSON.stringify({ error: 'currency et method requis' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        const { data, error } = await sb.from('qnd_collection_accounts')
          .insert([{ currency, method, label, account_name, bank_name, account_number, extra, country_code, active: true, is_primary: false }])
          .select('id').single()
        if (error) throw error
        return new Response(JSON.stringify({ ok: true, id: data.id }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'delete-account': {
        const { id } = body
        const { error } = await sb.from('qnd_collection_accounts').delete().eq('id', id)
        if (error) throw error
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'set-primary-account': {
        // Le compte "Principal" est scopé PAR PAYS (currency + country_code).
        // Définir un principal pour le Bénin ne touche pas les comptes des autres pays.
        const { id, currency, country_code } = body
        let demote = sb.from('qnd_collection_accounts').update({ is_primary: false }).eq('currency', currency)
        demote = country_code ? demote.eq('country_code', country_code) : demote.is('country_code', null)
        const { error: e1 } = await demote
        if (e1) throw e1
        const { error: e2 } = await sb.from('qnd_collection_accounts')
          .update({ is_primary: true })
          .eq('id', id)
        if (e2) throw e2
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'get-history': {
        const { data, error } = await sb.from('tx_status_history').select('*').order('changed_at', { ascending: false }).limit(50)
        if (error) throw error
        return new Response(JSON.stringify(data), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      case 'get-stats': {
        const [{ data: txs, error: te }, { data: users, error: ue }] = await Promise.all([
          sb.from('client_transactions').select('*'),
          sb.from('quendify_users').select('id')
        ])
        if (te || ue) throw te || ue
        return new Response(JSON.stringify({ txs, users }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      default:
        return new Response(JSON.stringify({ error: 'Action inconnue' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})

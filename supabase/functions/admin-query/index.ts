import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = ['https://www.quendify.com', 'https://quendify.com']

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (origin && ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin
  return h
}

function countryOf(v: unknown): string | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s ? s.toUpperCase() : null
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ===== Trades P2P =====
const P2P_FIATS = ['XOF', 'XAF', 'TRY', 'EUR']

type P2PTrade = {
  side: 'buy' | 'sell'
  fiat_currency: string
  fiat_amount: number
  usdt_amount: number
  fee_usdt: number
  traded_at: string
  order_no: string | null
  tx_id: string | null
  note: string | null
}

function positive(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

function validateTrade(b: Record<string, unknown>): { trade: P2PTrade } | { error: string } {
  const side = String(b.side ?? '')
  if (side !== 'buy' && side !== 'sell') return { error: 'Sens invalide (achat ou vente)' }
  const fiat_currency = String(b.fiat_currency ?? '').toUpperCase()
  if (!P2P_FIATS.includes(fiat_currency)) return { error: 'Devise invalide' }
  const fiat_amount = positive(b.fiat_amount)
  const usdt_amount = positive(b.usdt_amount)
  if (!fiat_amount || !usdt_amount) return { error: 'Montants invalides' }
  const rawFee = b.fee_usdt
  const fee_usdt = rawFee === undefined || rawFee === null || rawFee === '' ? 0 : Number(rawFee)
  if (!Number.isFinite(fee_usdt) || fee_usdt < 0) return { error: 'Frais invalides' }
  if (side === 'buy' && fee_usdt >= usdt_amount) return { error: 'Frais supérieurs aux USDT reçus' }
  const traded = new Date(String(b.traded_at ?? ''))
  if (isNaN(traded.getTime())) return { error: 'Date invalide' }
  if (traded.getTime() > Date.now() + 5 * 60 * 1000) return { error: 'Date dans le futur' }
  const order_no = String(b.order_no ?? '').trim() || null
  if (order_no && order_no.length > 64) return { error: "N° d'ordre trop long" }
  const tx_id = String(b.tx_id ?? '').trim().toUpperCase() || null
  const note = String(b.note ?? '').trim().slice(0, 200) || null
  return {
    trade: {
      side, fiat_currency, fiat_amount, usdt_amount, fee_usdt,
      traded_at: traded.toISOString(), order_no, tx_id, note,
    },
  }
}

Deno.serve(async (req: Request) => {
  const CORS = corsHeaders(req.headers.get('origin'))
  function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const body = await req.json()
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const token = body.admin_pass
    if (!token) return json({ error: 'Session invalide ou expirée' }, 401)
    const tokenHash = await sha256Hex(token)
    const { data: session, error: se } = await sb.from('admin_sessions')
      .select('id, expires_at').eq('token_hash', tokenHash).maybeSingle()
    if (se) throw se
    if (!session || new Date(session.expires_at) <= new Date()) {
      return json({ error: 'Session invalide ou expirée' }, 401)
    }

    switch (body.action) {

      case 'logout': {
        const { error } = await sb.from('admin_sessions').delete().eq('id', session.id)
        if (error) throw error
        return json({ ok: true })
      }

      case 'get-transactions': {
        const { data, error } = await sb.from('client_transactions').select('*').order('created_at', { ascending: false })
        if (error) throw error
        return json(data)
      }

      case 'get-clients': {
        const [{ data: users, error: ue }, { data: txs, error: te }] = await Promise.all([
          sb.from('quendify_users').select('id, full_name, email, phone, country, created_at, is_active').order('created_at', { ascending: false }),
          sb.from('client_transactions').select('email, amount_send, currency_from, status')
        ])
        if (ue || te) throw ue || te
        return json({ users, txs })
      }

      case 'toggle-active': {
        const { user_id } = body
        if (!user_id) {
          return json({ error: 'user_id requis' }, 400)
        }
        const { data: current, error: fe } = await sb.from('quendify_users').select('is_active').eq('id', user_id).maybeSingle()
        if (fe) throw fe
        if (!current) {
          return json({ error: 'Utilisateur introuvable' }, 404)
        }
        const newValue = !current.is_active
        const { error: ue } = await sb.from('quendify_users').update({ is_active: newValue }).eq('id', user_id)
        if (ue) throw ue
        return json({ ok: true, is_active: newValue })
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
        return json({ ok: true })
      }

      case 'update-corridor': {
        const { id, margin } = body
        if (typeof margin !== 'number' || margin < 0 || margin > 1) {
          return json({ error: 'Marge invalide (doit être entre 0 et 1)' }, 400)
        }
        const { error } = await sb.from('qnd_corridors').update({ margin }).eq('id', id)
        if (error) throw error
        return json({ ok: true })
      }

      case 'update-corridor-bulk': {
        const { margin } = body
        if (typeof margin !== 'number' || margin < 0 || margin > 1) {
          return json({ error: 'Marge invalide (doit être entre 0 et 1)' }, 400)
        }
        const { error } = await sb.from('qnd_corridors').update({ margin }).neq('id', 0)
        if (error) throw error
        return json({ ok: true })
      }

      case 'get-accounts': {
        const { data, error } = await sb.from('qnd_collection_accounts').select('*').order('sort_order')
        if (error) throw error
        return json(data)
      }

      case 'save-account': {
        const { id, currency, label, account_name, bank_name, account_number, extra, active } = body
        const { error } = await sb.from('qnd_collection_accounts')
          .update({
            currency, label, account_name, bank_name, account_number, extra, active,
            ...('country_code' in body ? { country_code: countryOf(body.country_code) } : {})
          })
          .eq('id', id)
        if (error) throw error
        return json({ ok: true })
      }

      case 'add-account': {
        const { currency, method, label, account_name, bank_name, account_number, extra, country_code } = body
        if (!currency || !method) {
          return json({ error: 'currency et method requis' }, 400)
        }
        const { data, error } = await sb.from('qnd_collection_accounts')
          .insert([{ currency, method, label, account_name, bank_name, account_number, extra, country_code: countryOf(country_code), active: true, is_primary: false }])
          .select('id').single()
        if (error) throw error
        return json({ ok: true, id: data.id })
      }

      case 'delete-account': {
        const { id } = body
        const { error } = await sb.from('qnd_collection_accounts').delete().eq('id', id)
        if (error) throw error
        return json({ ok: true })
      }

      case 'set-primary-account': {
        // Le compte "Principal" est scopé PAR PAYS (currency + country_code).
        // Définir un principal pour le Bénin ne touche pas les comptes des autres pays.
        const { id } = body
        const { data: acc, error: fe } = await sb.from('qnd_collection_accounts')
          .select('currency, country_code').eq('id', id).maybeSingle()
        if (fe) throw fe
        if (!acc) {
          return json({ error: 'Compte introuvable' }, 404)
        }
        let demote = sb.from('qnd_collection_accounts').update({ is_primary: false }).eq('currency', acc.currency).neq('id', id)
        demote = acc.country_code ? demote.eq('country_code', acc.country_code) : demote.is('country_code', null)
        const { error: e1 } = await demote
        if (e1) throw e1
        const { error: e2 } = await sb.from('qnd_collection_accounts')
          .update({ is_primary: true })
          .eq('id', id)
        if (e2) throw e2
        return json({ ok: true })
      }

      case 'get-history': {
        const { data, error } = await sb.from('tx_status_history').select('*').order('changed_at', { ascending: false }).limit(50)
        if (error) throw error
        return json(data)
      }

      case 'get-stats': {
        const [{ data: txs, error: te }, { data: users, error: ue }] = await Promise.all([
          sb.from('client_transactions').select('*'),
          sb.from('quendify_users').select('id')
        ])
        if (te || ue) throw te || ue
        return json({ txs, users })
      }

      // ===== Trades P2P (achats/ventes d'USDT sur Binance) =====
      case 'get-p2p': {
        const { data, error } = await sb.from('qnd_p2p_trades').select('*').order('traded_at', { ascending: false })
        if (error) throw error
        return json(data)
      }

      case 'add-p2p': {
        const v = validateTrade(body)
        if ('error' in v) return json({ error: v.error }, 400)
        if (v.trade.tx_id) {
          const { data: tx, error: te } = await sb.from('client_transactions')
            .select('tx_id').eq('tx_id', v.trade.tx_id).maybeSingle()
          if (te) throw te
          if (!tx) return json({ error: 'Transfert lié introuvable : ' + v.trade.tx_id }, 400)
        }
        const { data, error } = await sb.from('qnd_p2p_trades')
          .insert([{ ...v.trade, source: 'manual' }]).select('id').single()
        if (error) {
          if (error.code === '23505') return json({ error: "Ce n° d'ordre Binance est déjà enregistré" }, 409)
          throw error
        }
        return json({ ok: true, id: data.id })
      }

      case 'delete-p2p': {
        const id = Number(body.id)
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'id invalide' }, 400)
        const { data, error } = await sb.from('qnd_p2p_trades').delete().eq('id', id).select('id')
        if (error) throw error
        if (!data || !data.length) return json({ error: 'Trade introuvable' }, 404)
        return json({ ok: true })
      }

      default:
        return json({ error: 'Action inconnue' }, 400)
    }
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})

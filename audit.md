# Audit Quendify — 2026-06-29

## Faux positifs (agent a lu les fichiers locaux uniquement)
Les EF login-user, register-user, save-profile, declare-payment, get-transactions, get-rate, admin-query **existent toutes en production Supabase** — leurs sources ne sont pas toutes trackées localement.

---

## 🔴 CRITIQUES

| # | Problème | Fichier | Ligne |
|---|---------|---------|-------|
| C1 | `admin-login` retourne le mot de passe admin en clair dans le champ `session` au lieu d'un token opaque | supabase/functions/admin-login/index.ts | 23 |
| C2 | `send-telegram` sans authentification — n'importe qui peut appeler l'EF et envoyer un message Telegram | supabase/functions/send-telegram/index.ts | — |

---

## 🟠 ÉLEVÉS

| # | Problème | Fichier | Détail |
|---|---------|---------|--------|
| E1 | Token HMAC signé avec `SUPABASE_SERVICE_ROLE_KEY` — pas un secret dédié aux tokens | create-transaction, get-transactions, declare-payment, save-profile | Risque : rotation de la clé service role invalide tous les tokens membres |
| E2 | `admin-login` sans rate limiting → brute force du mot de passe admin possible | supabase/functions/admin-login/index.ts | — |
| E3 | Vérifier que save-profile, get-transactions, declare-payment utilisent toutes bien `verifyToken` HMAC (certaines ont pu être écrites avant la standardisation) | supabase/functions/ | Audit des EF une par une |
| E4 | `onclick="openTxDetail('${safeId}')"` — injection possible si `safeId` mal échappé | admin.html | ~548 |
| E5 | `select('*')` sur `qnd_countries` sans filtre de colonnes | espace.html | 330 |

---

## 🟡 MOYENS

| # | Problème | Fichier | Détail |
|---|---------|---------|--------|
| M1 | `localStorage` non encrypté (token membre, profil, session admin) | acces.html, espace.html, admin.html | sessionStorage serait mieux pour la session admin |
| M2 | `SUPABASE_URL` + `SUPABASE_KEY` dupliqués en dur dans 5 fichiers HTML | Tous | Refactoriser via un fichier config partagé ou variable Vercel |
| M3 | Aucun fichier de migration SQL dans le repo — schéma non versionné | Repo | Risque de dérive entre local et prod |
| M4 | Pas de timeout sur les `fetch()` → une requête peut pendre indéfiniment | Tous | Ajouter `AbortSignal.timeout(10000)` |
| M5 | Google Fonts chargées séparément dans chaque fichier HTML (3-4 fois) | acces.html, espace.html, admin*.html | Impact performance premier chargement |
| M6 | Aucun test d'intégration (Cypress / Playwright) | Repo | — |

---

## ✅ Points positifs

- OTP 100% serveur (send-otp + verify-otp) avec expiration 10 min + RLS `email_otps` verrouillée
- HMAC stateless sur les EF sensibles (create-transaction, declare-payment, save-profile, get-transactions)
- Secrets Telegram/Resend/Admin dans Supabase Vault
- AbortController sur les calculs de taux live (tfCalc)
- Validation IBAN turc côté client (TR + 24 chiffres)
- `lsGet/lsSet/lsRm` avec try/catch (fix crash Safari navigation privée)
- Fixes Safari : optional chaining, aspect-ratio OTP, localStorage
- CORS configuré sur toutes les EF
- Auto-refresh admin désactivé si onglet caché (T8)
- Stats volume groupées par devise (T7)
- Bénéficiaire validé par mode de réception (T12)
- Warning suppression compte principal (T13)

---

## Priorités pour la prochaine session

1. **C1** — Remplacer le mot de passe en session dans admin-login par un token HMAC dédié
2. **C2** — Ajouter authentification sur send-telegram (vérifier admin_pass ou token)
3. **E1** — Générer un secret HMAC dédié aux tokens membres (séparé de SERVICE_ROLE_KEY)
4. **E2** — Rate limiting sur admin-login (ex: 5 tentatives / minute)
5. **E3** — Auditer chaque EF pour confirmer verifyToken en place

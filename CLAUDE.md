# CLAUDE.md — Quendify

> Ce fichier est lu par Claude Code à chaque session. Il définit l'architecture du projet
> et les règles de discipline à respecter SANS EXCEPTION. Ce sont des règles apprises
> en production, sur une application qui manie l'argent réel de clients. Les ignorer
> a déjà cassé le login et l'inscription en prod. Respecte-les.

---

## 1. CE QU'EST QUENDIFY

Quendify est une application de transfert d'argent **Turquie ⇄ Afrique** (corridors TRY ⇄ XOF/XAF, plus USDT et EUR). C'est la marque mère **Sonsuz** côté infrastructure.

- **100% frontend statique** : HTML/CSS/JS pur, **aucun framework, aucun build step**. Le SDK Supabase est chargé via CDN.
- **Déploiement** : GitHub → Vercel (rebuild automatique au push sur `main`).
- **Backend** : Supabase, projet `wptgwvzyremlkboyrpwk` (région Tokyo) — PostgreSQL + Edge Functions (Deno) + RLS + Vault.

### Fichiers principaux
- `index.html` — redirection vers `acces.html`
- `acces.html` — authentification (connexion + inscription)
- `espace.html` — espace membre (simulateur de transfert, historique, profil)
- `admin.html` — dashboard admin (transferts, stats, base clients)
- `admin-taux.html` — gestion des marges/commissions par corridor
- `admin-comptes.html` — gestion des comptes de collecte

### Tables Supabase
- `quendify_users` — membres (email, password_hash, nom, IBAN, etc.)
- `email_otps` — codes OTP temporaires pour vérification email
- `client_transactions` — tous les transferts
- `qnd_countries` — pays disponibles (devise, drapeau, modes, `coming_soon`)
- `qnd_corridors` — corridors de change (from_currency, to_currency, margin, active)
- `qnd_collection_accounts` — comptes où les clients envoient l'argent (`is_primary`, `active`, `sort_order`)
- `tx_status_history` — journal d'audit des changements de statut

### Edge Functions (toutes en `verify_jwt: false`, secrets dans Supabase Vault)
- `login-user` — connexion (vérifie email + code côté serveur)
- `register-user` — inscription (INSERT via service role)
- `save-profile` — mise à jour profil (vérif token HMAC)
- `declare-payment` — déclaration de paiement (vérif ownership)
- `admin-query` — TOUTES les opérations admin (get/save/add/delete corridors, comptes, stats, set-primary)
- `send-otp` — envoi du code OTP par email (Resend)
- `send-status` — email au client au changement de statut (+ reçu de confirmation)
- `confirm-transaction` — confirmation de réception + reçu

---

## 2. RÈGLES DE SÉCURITÉ — NON NÉGOCIABLES

Cette app manie l'argent de clients réels sur des corridors sensibles. La sécurité prime sur la vitesse.

1. **Aucun secret dans le frontend.** Tokens (Telegram, Twilio/WhatsApp), clés API (Resend), `service_role` : tout vit dans les secrets Supabase / Vault, jamais dans le JS de la page. La clé `anon` est publique par nature — ne jamais s'appuyer dessus pour protéger des données.

2. **Toute écriture sensible passe par une Edge Function en service role**, jamais par la clé anon directe. `quendify_users`, `client_transactions`, `qnd_corridors`, `qnd_collection_accounts` sont verrouillées par RLS. Une écriture via clé anon échoue silencieusement (faux positif "✓"). Si tu ajoutes une écriture, route-la par `admin-query` ou une Edge Function dédiée.

3. **JAMAIS fermer/durcir une policy RLS avant d'avoir construit ET testé le nouveau chemin.** L'ordre correct :
   a. Déployer la nouvelle Edge Function
   b. Recâbler le frontend pour l'appeler
   c. **Tester le parcours réel** (login / inscription / transfert)
   d. SEULEMENT après confirmation : `DROP` l'ancienne policy
   Faire l'inverse a déjà cassé le login en prod. Le nouveau pont avant de brûler l'ancien.

4. **Toujours un ROLLBACK avant de modifier la prod.** Avant tout `DROP`/`ALTER` sur la base, générer et montrer un script de retour arrière.

---

## 3. RÈGLES SUPABASE

1. **DDL → `apply_migration`, jamais `execute_sql`.** Toute modification de structure (ADD COLUMN, DROP POLICY, CREATE POLICY, etc.) passe par `apply_migration` pour garder un historique versionné. `execute_sql` ne laisse aucune trace.

2. **Edge Functions : `verify_jwt: false`** pour les appels frontend non authentifiés.

3. **`pg_net` n'accepte que du `jsonb`** — incompatible avec les APIs form-encoded (Twilio). Utiliser une Edge Function comme pont.

4. **Vault** : pas d'upsert natif — supprimer le secret avant de le réinsérer. Lecture via `vault.decrypted_secrets`.

---

## 4. RÈGLES GIT / DÉPLOIEMENT

1. **Identité Git configurée** (`user.email` + `user.name`) avant tout commit — sinon le commit échoue silencieusement et rien ne part en ligne.

2. **`commit` ≠ `push`.** Après chaque changement de fichier : `git add` + `commit` + **`git push origin main`**. Sans le push, Vercel ne rebuild pas et le code reste local. C'est l'erreur classique — toujours vérifier que le push est fait.

3. **Confirmer que Vercel est "Ready"** après le push avant de tester (~1 min). Tant que le déploiement n'est pas Ready, la prod sert l'ancienne version.

4. **Le cache navigateur ment.** Après un déploiement, `Ctrl+Shift+R` ne suffit pas toujours. **Toujours tester en navigation privée** (incognito) pour avoir la vraie version à jour. Beaucoup de "bugs" apparents sont en réalité du cache.

5. **Uploads GitHub volumineux par l'UI web** peuvent tronquer silencieusement — préférer le push CLI.

---

## 5. RÈGLES DE TRAVAIL

1. **Un seul chantier à la fois.** Ne pas mélanger plusieurs corrections dans une même passe. Si l'utilisateur signale plusieurs problèmes, les traiter dans l'ordre de gravité (l'argent/la sécurité d'abord), un par un.

2. **Diagnostiquer AVANT de corriger.** Lire l'état réel (logs, structure des tables, code existant) avant de proposer un fix. Ne jamais deviner. Montrer la cause exacte.

3. **Montrer le plan/code AVANT d'appliquer** sur la prod. L'utilisateur valide, ensuite on exécute.

4. **Ne pas afficher de faux succès.** Un `try/catch` qui montre une vraie erreur vaut mieux qu'un toast "✓" qui ment quand l'écriture a échoué.

5. **Comprendre l'existant avant de reconstruire.** Beaucoup de besoins sont déjà partiellement couverts. Vérifier les colonnes/fonctions existantes avant d'en créer.

---

## 6. RÈGLES MÉTIER

1. **Ne jamais mélanger les devises.** XOF, XAF, TRY, USDT, EUR sont distincts. Un total qui additionne des montants de devises différentes est FAUX. Toujours grouper par devise (afficher "50 000 TRY + 20 000 XOF", jamais convertir silencieusement).

2. **Les stats financières ne comptent que les transactions `completed`.** Une transaction `pending` ou `processing` n'est pas de l'argent réel. Volume, commission, revenu : `completed` uniquement. Le nombre total et le taux de succès peuvent compter tout (vue opérationnelle).

3. **Le client ne voit que ce qui est livrable.** Un corridor non opérationnel est `coming_soon` (visible mais transfert désactivé), jamais transférable. Ne jamais laisser un client initier un transfert qu'on ne peut pas honorer.

4. **Marge par défaut = spread invisible.** Le modèle de revenu est le spread embarqué dans le taux affiché, zéro commission visible. Un corridor sans marge configurée tombe sur un fallback — éviter les fallbacks non maîtrisés.

5. **Un seul compte `is_primary` par devise.** Le passage à un nouveau compte principal démarque l'ancien (unset-all puis set-one).

---

## 7. STYLE DE COMMUNICATION

- Réponses **courtes et directes**. L'utilisateur (Aurel) préfère agir et tester vite plutôt que recevoir de longues explications.
- Français, ton direct ("VAS Y").
- Verdicts nets plutôt que recommandations hésitantes.
- Pas de sur-formatage inutile.

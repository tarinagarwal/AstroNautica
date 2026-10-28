# Runbook: a domain is blocked or seized

**Goal:** readers keep finding us within hours. Published content is unaffected; only one door closed.

1. **Confirm.** Check from inside the affected network (ask a trusted reader) and from outside (e.g. RIPE Atlas or
   OONI Probe results). Note whether it is DNS blocking (domain resolves wrongly), IP blocking, or seizure (registrar
   shows a seizure notice).
2. **Announce the alternatives** on the Telegram channel immediately: the spare domains, the onion address, the APK
   download link and the IPFS gateway link (all already on the "How to reach us" page).
3. **Add a new spare domain** if more than one is blocked:
   - Register it at a registrar outside India with WHOIS privacy (Njalla, Porkbun or Namecheap; never `.in`).
   - Point it at the `web` hosts (A/AAAA records) or the static build on IPFS (DNSLink).
   - Add the TLS certificate (Let's Encrypt via the web container's ACME client).
4. **Sign a new mirror list** with the owner key so official clients and the site show the new domain:
   `node scripts/owner-sign-list.mjs mirrors --add https://new-domain.example` (owner machine, offline key file),
   then publish the signed event: `node scripts/publish-events.mjs <file>` from any online machine. The app and the
   site pick it up within minutes.
5. **If seized**, do not try to recover the domain through the same registrar if that exposes the owner. Let it go;
   remove it from the mirror list so clients stop trying it.
6. Record the incident (date, domain, type of block) in `docs/incidents.md`.

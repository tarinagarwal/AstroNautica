# Runbook: remove a moderator (lost device, compromise, or leaving)

Removal takes effect in every official client as soon as the new moderator list reaches them.

1. **Owner signs a new moderator list** with `until = <now>` on the moderator's entry (keep the entry: approvals they
   made before now stay verifiable): `node scripts/owner-sign-list.mjs moderators --remove <npub>`, then publish it.
2. **Effects, automatically:**
   - Their unlisted, hidden, muted, featured and contributor-list entries stop counting.
   - The API stops accepting their actions within 30 s (it refreshes lists), and their claims are released.
   - New submissions are no longer wrapped for their X25519 key.
3. **Review their recent actions** in the owner area → Audit log. If they unlisted stories wrongly, nothing to do
   (their entries no longer count). If they approved stories that shouldn't have been published, unlist them yourself
   (owner entries are not capped) — the copies can't be erased.
4. **Pending submissions** stay wrapped for the removed key; that key can't fetch them any more (the API refuses), and
   remaining moderators re-wrap for any new moderator from "Re-wrap needed".
5. If their device was seized, assume they could read submissions that were pending at that time; tell affected
   contributors through the app (feedback note) if appropriate.

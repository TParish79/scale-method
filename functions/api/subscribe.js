/**
 * Cloudflare Pages Function — POST /api/subscribe
 *
 * Receives a completed scorecard submission from index.html and creates/updates the
 * subscriber in MailerLite, dropping them into the group for their weakest SCALE phase.
 * Joining that group is what fires the matching automation in MailerLite.
 *
 * ── SETUP (do these once) ──────────────────────────────────────────────────────────
 *  1. In MailerLite, create five Groups, one per phase. Name them however you like.
 *  2. Open each group and copy its Group ID (Subscribers → Groups → click a group →
 *     the ID is in the URL, e.g. .../groups/123456789). Paste the IDs into GROUP_IDS
 *     below. These IDs are NOT secret, so it's fine to keep them here in the repo.
 *  3. In MailerLite, create an API token (Integrations → API). Do NOT paste it here.
 *     Instead, in the Cloudflare Pages dashboard:
 *        Settings → Environment variables → add  MAILERLITE_API_KEY = <your token>
 *     (mark it encrypted). Set it for Production (and Preview if you use preview builds).
 *
 *  Everything MailerLite-specific lives between the two ===== markers below, so if you
 *  ever switch email platforms you only touch that one block.
 */

// Map each phase name (sent by the front-end) to its MailerLite Group ID.
// Replace the placeholder strings with your real IDs from step 2 above.
const GROUP_IDS = {
  Strategy:  "188268204952388682",
  Customer:  "188268221097313808",
  Action:    "188268234548446446",
  Leverage:  "188268248022648694",
  Endurance: "188268258337490214",
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const email = (body.email || "").trim();
  const name = (body.name || "").trim();
  const weakestPhase = body.weakestPhase;

  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: "Invalid email" }, 400);
  }

  const groupId = GROUP_IDS[weakestPhase];
  if (!groupId || groupId.startsWith("REPLACE_WITH")) {
    // Don't hard-fail the lead just because a group ID is missing — capture the
    // subscriber anyway and log it so you can fix the mapping.
    console.warn("No valid group ID for phase:", weakestPhase);
  }

  if (!env.MAILERLITE_API_KEY) {
    console.error("MAILERLITE_API_KEY env var is not set in Cloudflare Pages.");
    return json({ ok: false, error: "Server not configured" }, 500);
  }

  // ===================== MAILERLITE-SPECIFIC BLOCK (swap here if you migrate) =====================
  const payload = {
    email,
    fields: {
      name,
      scale_score:          body.overallScore,
      weakest_phase:        weakestPhase,
      scale_band:           body.band,
      phases_needing_work:  body.phasesNeedingWork,
    },
    groups: groupId && !groupId.startsWith("REPLACE_WITH") ? [groupId] : [],
  };

  let resp;
  try {
    resp = await fetch("https://connect.mailerlite.com/api/subscribers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${env.MAILERLITE_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("MailerLite request failed:", err);
    return json({ ok: false, error: "Upstream request failed" }, 502);
  }
  // ===============================================================================================

  if (!resp.ok) {
    const detail = await resp.text();
    console.error("MailerLite error", resp.status, detail);
    return json({ ok: false, error: "MailerLite rejected the subscriber" }, 502);
  }

  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

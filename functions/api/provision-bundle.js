/**
 * Cloudflare Pages Function — POST /api/provision-bundle
 *
 * Called by a Zapier webhook when a Complete System bundle purchase is recorded
 * in Gumroad. Does three things automatically:
 *   1. Creates a Supabase Auth user and sends them a branded invite email
 *      so they can set their own password and access the AI Advisor
 *   2. Inserts a profiles row with access_until = today + 90 days
 *   3. Adds them to the MailerLite "SCALE — Complete System Buyers" group,
 *      which fires the bundle post-purchase automation
 *
 * ── SETUP (do these once) ──────────────────────────────────────────────────────
 *  1. In Cloudflare Pages dashboard → Settings → Environment variables, add:
 *       SUPABASE_URL             = https://gcslyakmnuqiyxytvjnv.supabase.co
 *       SUPABASE_SERVICE_ROLE_KEY = <your Supabase service role key>  ← encrypted
 *       BUNDLE_WEBHOOK_SECRET    = <a secret string you choose>       ← encrypted
 *       MAILERLITE_API_KEY       = <already set>
 *
 *  2. In Supabase → Authentication → Email Templates → "Invite User",
 *     customize the email to match your brand. This is the email buyers
 *     receive to set their password and access the Advisor.
 *
 *  3. In Zapier, create a zap:
 *       Trigger: Gumroad — New Sale (filter to Complete System product)
 *       Action:  Webhooks by Zapier — POST
 *         URL:     https://the30dayscale.com/api/provision-bundle
 *         Headers: Content-Type: application/json
 *                  X-Bundle-Secret: <same secret string from step 1>
 *         Body:    { "email": "{{buyer email}}", "name": "{{buyer name}}" }
 *
 *  4. Push this file to GitHub at:
 *     functions/api/provision-bundle.js
 */

const EMAIL_RE        = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUNDLE_GROUP_ID = "188734470514280198";

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── Security: verify the request came from your Zapier zap ──────────────────
  const secret = request.headers.get("x-bundle-secret");
  if (!env.BUNDLE_WEBHOOK_SECRET || secret !== env.BUNDLE_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const name  = (body.name  || "").trim();

  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: "Invalid email" }, 400);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Supabase env vars not configured.");
    return json({ ok: false, error: "Server not configured" }, 500);
  }

  // ── Step 1: Invite user via Supabase Auth ────────────────────────────────────
  const inviteResp = await fetch(
    `${env.SUPABASE_URL}/auth/v1/invite`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ email }),
    }
  );

  if (!inviteResp.ok) {
    const detail = await inviteResp.text();
    // If user already exists, don't hard-fail — they may be re-purchasing
    if (!detail.includes("already been registered")) {
      console.error("Supabase invite error:", inviteResp.status, detail);
      return json({ ok: false, error: "Failed to create user account" }, 502);
    }
  }

  // ── Step 2: Get user ID and insert/update profiles row ───────────────────────
  // Calculate access_until = today + 90 days
  const accessUntil = new Date();
  accessUntil.setDate(accessUntil.getDate() + 90);
  const accessUntilStr = accessUntil.toISOString().split("T")[0]; // YYYY-MM-DD

  // Look up the user by email to get their UUID
  const userLookup = await fetch(
    `${env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!userLookup.ok) {
    console.error("Failed to look up user:", await userLookup.text());
    return json({ ok: false, error: "Failed to look up user" }, 502);
  }

  const userData = await userLookup.json();
  const user = userData.users?.[0];

  if (!user?.id) {
    console.error("User not found after invite:", email);
    return json({ ok: false, error: "User not found" }, 502);
  }

  // Upsert the profiles row
  const profileResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({ id: user.id, access_until: accessUntilStr }),
    }
  );

  if (!profileResp.ok) {
    console.error("Failed to insert profile:", await profileResp.text());
    // Non-fatal — user can still access the app, we just log it
  }

  // ── Step 3: Add to MailerLite "Complete System Buyers" group ─────────────────
  if (!env.MAILERLITE_API_KEY) {
    console.error("MAILERLITE_API_KEY not set.");
    // Non-fatal — provisioning still succeeded
  } else {
    const mlResp = await fetch("https://connect.mailerlite.com/api/subscribers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${env.MAILERLITE_API_KEY}`,
      },
      body: JSON.stringify({
        email,
        fields: { name },
        groups: [BUNDLE_GROUP_ID],
      }),
    });

    if (!mlResp.ok) {
      console.error("MailerLite error:", mlResp.status, await mlResp.text());
      // Non-fatal — provisioning still succeeded
    }
  }

  return json({ ok: true, access_until: accessUntilStr });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

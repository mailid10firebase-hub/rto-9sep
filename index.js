// index.js
import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ✅ Validate SERVICE_ACCOUNT_KEY exists
if (!process.env.SERVICE_ACCOUNT_KEY) {
  console.error("❌ SERVICE_ACCOUNT_KEY env var missing");
  process.exit(1);
}

let serviceAccount;
try {
  // Parse SERVICE_ACCOUNT_KEY directly (no automatic \\n -> \n replacement)
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("❌ Failed to parse SERVICE_ACCOUNT_KEY as JSON:", e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// ✅ health check
app.get("/", (req, res) => {
  res.send("FCM Backend is running ✅");
});

// ✅ send force-online route
app.post("/send-force-online", async (req, res) => {
  try {
    // Debug body preview
    const bodyPreview = JSON.stringify(req.body, null, 0).slice(0, 2000);
    console.log("Incoming /send-force-online body:", bodyPreview);

    // accept both tokens and registration_ids
    const body = req.body || {};
    let tokens = Array.isArray(body.tokens)
      ? body.tokens
      : Array.isArray(body.registration_ids)
      ? body.registration_ids
      : null;

    if (!tokens || tokens.length === 0) {
      console.warn("⚠️ No tokens provided or invalid format.");
      return res
        .status(400)
        .json({ success: false, error: "No tokens provided or invalid format" });
    }

    console.log(`📨 Preparing to send to ${tokens.length} tokens.`);

    // Batch into <=500 tokens
    const MAX = 500;
    const batches = [];
    for (let i = 0; i < tokens.length; i += MAX) {
      batches.push(tokens.slice(i, i + MAX));
    }

    const summary = [];
    for (const batch of batches) {
      const message = {
        tokens: batch,
        data: { action: "start_core_service" },
        android: {
          priority: "high",
          ttl: 60 * 1000 // 1 minute
        }
      };

      const resp = await admin.messaging().sendMulticast(message);

      // make responses JSON-friendly
      const mapped = resp.responses.map((r, idx) => ({
        success: !!r.success,
        error: r.error ? r.error.message : null,
        index: idx
      }));

      console.log(
        `✅ Batch sent size=${batch.length}, success=${resp.successCount}, fail=${resp.failureCount}`
      );
      if (resp.failureCount > 0) {
        console.warn("❌ Failures:", mapped.filter(m => !m.success));
      }

      summary.push({
        batchSize: batch.length,
        successCount: resp.successCount,
        failureCount: resp.failureCount,
        details: mapped
      });
    }

    return res.json({ success: true, batches: summary });
  } catch (err) {
    console.error(
      "🔥 Error in /send-force-online:",
      err?.stack || err?.message || err
    );
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server_error" });
  }
});

// ✅ dynamic port for Render
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});

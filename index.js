// index.js
import express from "express";
import admin from "firebase-admin";
import https from "https";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- Read service account from either raw JSON or base64-encoded JSON ----
if (!process.env.SERVICE_ACCOUNT_KEY && !process.env.SERVICE_ACCOUNT_KEY_B64) {
  console.error("❌ Missing env: set SERVICE_ACCOUNT_KEY (raw JSON) or SERVICE_ACCOUNT_KEY_B64 (base64 JSON)");
  process.exit(1);
}

let serviceAccountRaw = null;

try {
  if (process.env.SERVICE_ACCOUNT_KEY_B64) {
    // Preferred: base64 encoded JSON to avoid newline escaping on platforms like Render
    const decoded = Buffer.from(process.env.SERVICE_ACCOUNT_KEY_B64, "base64").toString("utf8");
    serviceAccountRaw = JSON.parse(decoded);
    console.log("✅ Loaded service account from SERVICE_ACCOUNT_KEY_B64");
  } else {
    // Fallback: raw JSON string (may contain escaped \\n)
    serviceAccountRaw = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
    console.log("✅ Loaded service account from SERVICE_ACCOUNT_KEY");
  }
} catch (err) {
  console.error("❌ Failed to parse service account JSON:", err?.message || err);
  process.exit(1);
}

// Defensive: ensure private_key has real newlines
if (serviceAccountRaw && serviceAccountRaw.private_key) {
  // Replace literal backslash-n sequences with real newlines (common render/host escaping issue)
  serviceAccountRaw.private_key = serviceAccountRaw.private_key.replace(/\\n/g, "\n");
} else {
  console.error("❌ serviceAccount JSON missing private_key");
  process.exit(1);
}

// Sanity check (non-sensitive): show whether private_key starts correctly
if (typeof serviceAccountRaw.private_key !== "string" || !serviceAccountRaw.private_key.includes("BEGIN PRIVATE KEY")) {
  console.error("❌ private_key doesn't contain BEGIN marker — PEM invalid");
  process.exit(1);
}

// Optional safe preview for debugging (shows first chars, with newlines escaped for readability)
const preview = serviceAccountRaw.private_key.slice(0, 40).replace(/\n/g, "\\n");
console.log("private_key preview (escaped):", preview);

// --- ADDED: project_id + proxy logs (short) ---
console.log("project_id:", serviceAccountRaw.project_id);
console.log("HTTP_PROXY:", process.env.HTTP_PROXY);
console.log("HTTPS_PROXY:", process.env.HTTPS_PROXY);
console.log("FIREBASE_EMULATOR_HOST:", process.env.FIREBASE_EMULATOR_HOST);

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountRaw),
  });
  console.log("✅ firebase-admin initialized");
} catch (err) {
  console.error("🔥 Failed to initialize firebase-admin:", err?.message || err);
  process.exit(1);
}

// --- debug endpoint to test reachability to FCM endpoint ---
app.get("/_debug_fcm_reach", (req, res) => {
  const url = `https://fcm.googleapis.com/v1/projects/${serviceAccountRaw.project_id}/messages:send`;
  https
    .get(url, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res.status(200).json({ statusCode: r.statusCode, bodySnippet: d.slice(0, 1000) }));
    })
    .on("error", (e) => res.status(500).json({ err: e.message }));
});

// --- routes ---
app.get("/", (req, res) => {
  res.send("FCM Backend is running ✅");
});

app.post("/send-force-online", async (req, res) => {
  try {
    const bodyPreview = JSON.stringify(req.body, null, 0).slice(0, 2000);
    console.log("Incoming /send-force-online body:", bodyPreview);

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

      // --- ADDED: detailed try/catch around sendMulticast ---
      let resp;
      try {
        resp = await admin.messaging().sendMulticast(message);
      } catch (err) {
        try {
          console.error("sendMulticast ERR (ownProps):", Object.getOwnPropertyNames(err).reduce((acc, k) => { acc[k] = err[k]; return acc; }, {}));
        } catch (e) {
          console.error("sendMulticast ERR (unable to serialize err)", e);
        }
        if (err && err.response) {
          try {
            console.error("err.response.status:", err.response.status);
            const data = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
            console.error("err.response.data snippet:", data.slice(0, 1000));
          } catch (e) {}
        }
        // rethrow to be caught by outer catch and return 500
        throw err;
      }

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
    console.error("🔥 Error in /send-force-online:", err?.stack || err?.message || err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "server_error" });
  }
});

// dynamic port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});

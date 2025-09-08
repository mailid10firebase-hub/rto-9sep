// index.js
import express from "express";
import admin from "firebase-admin";
import https from "https";
import dotenv from "dotenv";
dotenv.config();

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
    const decoded = Buffer.from(process.env.SERVICE_ACCOUNT_KEY_B64, "base64").toString("utf8");
    serviceAccountRaw = JSON.parse(decoded);
    console.log("✅ Loaded service account from SERVICE_ACCOUNT_KEY_B64");
  } else {
    serviceAccountRaw = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
    console.log("✅ Loaded service account from SERVICE_ACCOUNT_KEY");
  }
} catch (err) {
  console.error("❌ Failed to parse service account JSON:", err?.message || err);
  process.exit(1);
}

// Ensure private_key newlines are real
if (serviceAccountRaw && serviceAccountRaw.private_key) {
  serviceAccountRaw.private_key = serviceAccountRaw.private_key.replace(/\\n/g, "\n");
} else {
  console.error("❌ serviceAccount JSON missing private_key");
  process.exit(1);
}

if (typeof serviceAccountRaw.private_key !== "string" || !serviceAccountRaw.private_key.includes("BEGIN PRIVATE KEY")) {
  console.error("❌ private_key doesn't contain BEGIN marker — PEM invalid");
  process.exit(1);
}

const preview = serviceAccountRaw.private_key.slice(0, 40).replace(/\n/g, "\\n");
console.log("private_key preview (escaped):", preview);
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

// Quick debug to see what messaging methods exist
try {
  const messaging = admin.messaging();
  console.log("messaging methods:", {
    hasSendMulticast: typeof messaging.sendMulticast === "function",
    hasSendAll: typeof messaging.sendAll === "function",
    hasSend: typeof messaging.send === "function",
  });
} catch (e) {
  console.warn("Could not introspect admin.messaging():", e?.message || e);
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

// --- util: send one batch with multiple fallback strategies ---
async function sendBatchWithFallback(batchTokens) {
  const messaging = admin.messaging();

  // message template used for sendMulticast (tokens array) or per-token/sendAll
  const multicastMessage = {
    tokens: batchTokens,
    data: { action: "start_core_service" },
    android: {
      priority: "high",
      ttl: 60 * 1000 // 1 minute in ms
    },
  };

  // If sendMulticast exists, prefer that (gives per-target responses)
  if (typeof messaging.sendMulticast === "function") {
    return messaging.sendMulticast(multicastMessage);
  }

  // If sendAll exists, convert to array of messages and call sendAll
  if (typeof messaging.sendAll === "function") {
    const messages = batchTokens.map(token => ({
      token,
      data: { action: "start_core_service" },
      android: { priority: "high", ttl: 60 * 1000 }
    }));
    // sendAll returns {responses: [...], successCount, failureCount}
    return messaging.sendAll(messages);
  }

  // Fallback: call send() per token and aggregate results
  const promises = batchTokens.map(token =>
    messaging.send({
      token,
      data: { action: "start_core_service" },
      android: { priority: "high", ttl: 60 * 1000 }
    }).then(r => ({ success: true, result: r }))
      .catch(e => ({ success: false, error: e }))
  );

  const settled = await Promise.all(promises);
  // Normalize to an object shaped similar to sendMulticast/sendAll
  const responses = settled.map(s => {
    if (s.success) return { success: true };
    // make error message string
    return { success: false, error: (s.error && s.error.message) ? s.error.message : String(s.error) };
  });
  const successCount = responses.filter(r => r.success).length;
  const failureCount = responses.length - successCount;
  return { responses, successCount, failureCount };
}

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
      let resp;
      try {
        resp = await sendBatchWithFallback(batch);
      } catch (err) {
        // Try to log serializable parts of error
        console.error("sendBatch ERR (ownProps):", (() => {
          try {
            const names = Object.getOwnPropertyNames(err || {}).reduce((acc, k) => {
              acc[k] = err[k];
              return acc;
            }, {});
            return names;
          } catch (e) {
            return { err: "unable to serialize error" };
          }
        })());
        // If axios-like response exists
        if (err && err.response) {
          try {
            console.error("err.response.status:", err.response.status);
            const data = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
            console.error("err.response.data snippet:", data.slice(0, 1000));
          } catch (e) {}
        }
        // Return 500 to caller with error message
        console.error("🔥 Error sending batch:", err?.stack || err?.message || err);
        return res.status(500).json({ success: false, error: err?.message || "send_error" });
      }

      // Normalize different response shapes (sendMulticast/sendAll/fallback)
      // Both sendMulticast and sendAll return .responses array and successCount/failureCount
      const responsesArray = Array.isArray(resp.responses) ? resp.responses : (resp?.responses ? resp.responses : []);
      const successCount = typeof resp.successCount === "number" ? resp.successCount : (responsesArray.filter(r => r.success).length || 0);
      const failureCount = typeof resp.failureCount === "number" ? resp.failureCount : (responsesArray.length - successCount);

      const mapped = (responsesArray.length > 0)
        ? responsesArray.map((r, idx) => ({
            success: !!r.success,
            error: r.error ? (r.error.message || String(r.error)) : null,
            index: idx
          }))
        : batch.map((_, idx) => ({ success: null, error: "no per-target info", index: idx }));

      console.log(`✅ Batch sent size=${batch.length}, success=${successCount}, fail=${failureCount}`);
      if (failureCount > 0) {
        const fails = mapped.filter(m => !m.success);
        console.warn("❌ Failures:", fails.slice(0, 10));
      }

      summary.push({
        batchSize: batch.length,
        successCount,
        failureCount,
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

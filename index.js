// index.js (updated)
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

// --- helper: sanitize incoming tokens and keep original indices ---
function sanitizeTokens(rawTokens) {
  const cleaned = [];
  const seen = new Set();
  const removed = [];

  rawTokens.forEach((t, origIdx) => {
    if (typeof t !== "string") {
      removed.push({ origIdx, reason: "not-a-string", raw: t });
      return;
    }
    let s = t.trim();
    // remove obvious garbage tokens
    if (!s || /^(unavailable|null|undefined)$/i.test(s)) {
      removed.push({ origIdx, reason: "unavailable-or-empty", raw: s });
      return;
    }
    // skip extremely short strings (very likely truncated)
    if (s.length < 20) {
      removed.push({ origIdx, reason: "too-short", raw: s });
      return;
    }
    // dedupe
    if (seen.has(s)) {
      removed.push({ origIdx, reason: "duplicate", raw: s });
      return;
    }
    seen.add(s);
    cleaned.push({ token: s, origIdx });
  });

  return { cleaned, removed };
}

function maskTokenSnippet(tok) {
  try {
    const s = String(tok);
    if (s.length <= 14) return s;
    return s.slice(0, 8) + "..." + s.slice(-6);
  } catch (e) {
    return "token_snippet_error";
  }
}

// --- util: send one batch with multiple fallback strategies ---
// returns object: { responses: [...], successCount, failureCount }
async function sendBatchWithFallback(batchTokens) {
  const messaging = admin.messaging();

  const multicastMessage = {
    tokens: batchTokens,
    data: { action: "start_core_service" },
    android: {
      priority: "high",
      ttl: 60 * 1000 // 1 minute in ms
    },
  };

  if (typeof messaging.sendMulticast === "function") {
    return messaging.sendMulticast(multicastMessage);
  }

  if (typeof messaging.sendAll === "function") {
    const messages = batchTokens.map(token => ({
      token,
      data: { action: "start_core_service" },
      android: { priority: "high", ttl: 60 * 1000 }
    }));
    return messaging.sendAll(messages);
  }

  // fallback: per-token send
  const promises = batchTokens.map(token =>
    messaging.send({
      token,
      data: { action: "start_core_service" },
      android: { priority: "high", ttl: 60 * 1000 }
    }).then(r => ({ success: true, result: r }))
      .catch(e => ({ success: false, error: e }))
  );

  const settled = await Promise.all(promises);
  const responses = settled.map(s => {
    if (s.success) return { success: true };
    return { success: false, error: (s.error && (s.error.message || s.error.code)) ? (s.error.message || s.error.code) : String(s.error) };
  });
  const successCount = responses.filter(r => r.success).length;
  const failureCount = responses.length - successCount;
  return { responses, successCount, failureCount };
}

// --- routes ---
app.get("/", (req, res) => {
  res.send("FCM Backend is running ✅");
});

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

app.post("/send-force-online", async (req, res) => {
  try {
    const bodyPreview = JSON.stringify(req.body, null, 0).slice(0, 2000);
    console.log("Incoming /send-force-online body:", bodyPreview);

    const body = req.body || {};
    let tokensRaw = Array.isArray(body.tokens)
      ? body.tokens
      : Array.isArray(body.registration_ids)
      ? body.registration_ids
      : null;

    if (!tokensRaw || tokensRaw.length === 0) {
      console.warn("⚠️ No tokens provided or invalid format.");
      return res
        .status(400)
        .json({ success: false, error: "No tokens provided or invalid format" });
    }

    // sanitize tokens and keep original indices
    const { cleaned, removed } = sanitizeTokens(tokensRaw);
    console.log(`Token sanitize: kept=${cleaned.length}, removed=${removed.length}`);
    if (removed.length > 0) {
      console.warn("Sample removed tokens:", removed.slice(0, 10));
    }

    if (cleaned.length === 0) {
      return res.status(400).json({ success: false, error: "All tokens were invalid after sanitize", removed });
    }

    // prepare array of raw token strings for sending and a mapping to original indices
    const cleanedTokens = cleaned.map(c => c.token);
    const origIndexMap = cleaned.map(c => c.origIdx); // cleanedTokens[i] -> origIndexMap[i]

    // Batch into <=500 tokens
    const MAX = 500;
    const batches = [];
    for (let i = 0; i < cleanedTokens.length; i += MAX) {
      batches.push({
        tokens: cleanedTokens.slice(i, i + MAX),
        startIndex: i
      });
    }

    const summary = [];
    for (const batch of batches) {
      let resp;
      try {
        resp = await sendBatchWithFallback(batch.tokens);
      } catch (err) {
        console.error("sendBatch ERR (serializable props):", (() => {
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

        if (err && err.response) {
          try {
            console.error("err.response.status:", err.response.status);
            const data = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
            console.error("err.response.data snippet:", data.slice(0, 1000));
          } catch (e) {}
        }

        console.error("🔥 Error sending batch:", err?.stack || err?.message || err);
        return res.status(500).json({ success: false, error: err?.message || "send_error" });
      }

      // Normalize response to get per-target results
      const responsesArray = Array.isArray(resp.responses) ? resp.responses : (resp?.responses ? resp.responses : []);
      const successCount = typeof resp.successCount === "number" ? resp.successCount : (responsesArray.filter(r => r.success).length || 0);
      const failureCount = typeof resp.failureCount === "number" ? resp.failureCount : (responsesArray.length - successCount);

      // Map responses back to original request indices and token snippets
      const mapped = (responsesArray.length > 0)
        ? responsesArray.map((r, idx) => {
            const globalCleanedIndex = batch.startIndex + idx;
            const originalIndex = origIndexMap[globalCleanedIndex];
            const token = batch.tokens[idx];
            const tokenSnippet = maskTokenSnippet(token);
            // extract error message safely
            let errorMsg = null;
            if (r.error) {
              if (typeof r.error === "string") errorMsg = r.error;
              else if (r.error.message) errorMsg = r.error.message;
              else if (r.error.code) errorMsg = r.error.code;
              else errorMsg = JSON.stringify(r.error);
            }
            return {
              success: !!r.success,
              error: errorMsg,
              indexInBatch: idx,
              cleanedIndex: globalCleanedIndex,
              originalIndex,
              tokenSnippet
            };
          })
        : batch.tokens.map((tok, idx) => {
            const globalCleanedIndex = batch.startIndex + idx;
            const originalIndex = origIndexMap[globalCleanedIndex];
            return {
              success: null,
              error: "no per-target info",
              indexInBatch: idx,
              cleanedIndex: globalCleanedIndex,
              originalIndex,
              tokenSnippet: maskTokenSnippet(tok)
            };
          });

      console.log(`✅ Batch sent size=${batch.tokens.length}, success=${successCount}, fail=${failureCount}`);
      if (failureCount > 0) {
        const fails = mapped.filter(m => !m.success);
        console.warn("❌ Failures (sample up to 10):", fails.slice(0, 10));
      }

      summary.push({
        batchSize: batch.tokens.length,
        successCount,
        failureCount,
        details: mapped
      });
    }

    // Return sanitized removed tokens info + per-batch details
    return res.json({
      success: true,
      originalTotal: tokensRaw.length,
      sanitizedKept: cleanedTokens.length,
      sanitizedRemovedCount: removed.length,
      sanitizedRemovedSample: removed.slice(0, 20),
      batches: summary
    });
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

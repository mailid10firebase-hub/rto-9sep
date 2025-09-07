import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json());

// ⚠️ Render ke env var se service account JSON load karo
if (!process.env.SERVICE_ACCOUNT_KEY) {
  console.error("❌ SERVICE_ACCOUNT_KEY env var missing");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// ✅ health check route (Render pe test karne ke liye)
app.get("/", (req, res) => {
  res.send("FCM Backend is running ✅");
});

// ✅ route jo forceOnline FCM bhejega
app.post("/send-force-online", async (req, res) => {
  try {
    const { tokens } = req.body;

    if (!tokens || tokens.length === 0) {
      return res.status(400).json({ success: false, error: "No tokens provided" });
    }

    const message = {
      data: { action: "start_core_service" },
      tokens: tokens
    };

    const response = await admin.messaging().sendMulticast(message);

    res.json({
      success: true,
      sentCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses
    });
  } catch (err) {
    console.error("Error sending FCM:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Render ke liye dynamic PORT
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});

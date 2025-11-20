// ================= KITE SCREENER BACKEND (FINAL VERSION) =================

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

// ------------- ENV VARIABLES -------------
const API_KEY = process.env.KITE_API_KEY;
const API_SECRET = process.env.KITE_API_SECRET;
const ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN;

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ------------- EXPRESS SERVER -------------
const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// ------------- SUPABASE -------------
const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ------------- TEST ENDPOINT -------------
app.get("/", (req, res) => {
  res.json({
    status: "Kite Backend Running",
    time: new Date().toISOString()
  });
});

// ------------- INSTRUMENT TOKENS (IMPORTANT) -------------
// Replace these with the REAL numeric tokens for stocks you want.
// I will generate these for you once you give me your watchlist.
const TOKENS = [
  738561,     // RELIANCE
  2953217,    // TCS
  408065,     // INFY
  341249,     // HDFCBANK
  1270529,    // ICICIBANK
  779521      // SBIN
];

// ------------------- ALERT SETTINGS -------------------
const settings = {
  relVolThreshold: 1.5,
  changePctThreshold: 2,
  cooldownMs: 15000,
};

const state = {}; // symbol → local state

// ------------------- SUPABASE LOG ---------------------
async function logAlert(symbol, price, criteria) {
  await supabase.from("nse_screener_alerts").insert([
    {
      timestamp: new Date().toISOString(),
      symbol,
      price,
      criteria_hit: criteria,
      user_id: "server"
    }
  ]);
}

// ------------------- KITE WEBSOCKET --------------------
function startKiteWS() {
  const ws = new WebSocket("wss://ws.kite.trade/?api_key=" + API_KEY + "&access_token=" + ACCESS_TOKEN);

  ws.on("open", () => {
    console.log("Kite WebSocket Connected");

    // Subscribe to ticks
    ws.send(
      JSON.stringify({
        a: "subscribe",
        v: TOKENS
      })
    );

    // Mode: full ticks
    ws.send(
      JSON.stringify({
        a: "mode",
        v: ["full", TOKENS]
      })
    );
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (!data.data) return;

    data.data.forEach(async (tick) => {
      const token = tick.instrument_token;
      if (!token) return;

      const price = tick.last_price;
      const volume = tick.volume;
      const prevHigh = tick.ohlc?.high || price * 1.01;
      const prevLow = tick.ohlc?.low || price * 0.99;

      // Map token → symbol manually
      const index = TOKENS.indexOf(token);
      const symbol = ["RELIANCE","TCS","INFY","HDFCBANK","ICICIBANK","SBIN"][index];

      if (!symbol) return;

      // initialize local state
      if (!state[symbol]) {
        state[symbol] = {
          prevPrice: price,
          prevDayHigh: prevHigh,
          prevDayLow: prevLow,
          avgVolume: volume || 1000,
          lastAlertAt: 0
        };
        return;
      }

      const st = state[symbol];
      st.prevPrice = st.price ?? price;
      st.price = price;
      st.volume = volume;
      st.relativeVolume = st.volume / st.avgVolume;

      const mid = (st.prevDayHigh + st.prevDayLow) / 2;
      st.changePct = ((st.price - mid) / mid) * 100;

      // ---------------- ALERT LOGIC ----------------
      const crossedHigh =
        st.prevPrice <= st.prevDayHigh && st.price > st.prevDayHigh;

      if (!crossedHigh) return;
      if (st.relativeVolume <= settings.relVolThreshold) return;
      if (st.changePct <= settings.changePctThreshold) return;
      if (Date.now() - st.lastAlertAt < settings.cooldownMs) return;

      st.lastAlertAt = Date.now();

      const msgText = `High Cross + RelVol>${settings.relVolThreshold} + Change%>${settings.changePctThreshold}`;

      // Log to supabase
      await logAlert(symbol, st.price, msgText);

      // Emit to frontend
      io.emit("alert", {
        symbol,
        price: st.price,
        criteriaHit: msgText,
        timestamp: new Date().toISOString()
      });

      console.log("ALERT:", symbol, msgText);
    });
  });

  ws.on("close", () => {
    console.log("Kite WS closed — reconnecting in 3s");
    setTimeout(startKiteWS, 3000);
  });

  ws.on("error", (err) => console.error("Kite WS Error:", err));
}

startKiteWS();

// ------------------- SOCKET.IO --------------------
io.on("connection", socket => {
  console.log("Frontend connected:", socket.id);
});

// ------------------- START SERVER --------------------
server.listen(PORT, () => {
  console.log(`Backend live on port ${PORT}`);
});

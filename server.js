// ================================================================
//  NSE SCREENER BACKEND (Kite Connect + Supabase + Socket.IO)
// ================================================================

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { KiteTicker } from "kiteconnect";

// 🔥 Import the full token + symbol set
import { TOKENS, SYMBOLS } from "./instrumentTokens.js";

// --------------------- ENV VARIABLES ---------------------
const API_KEY = process.env.KITE_API_KEY;
const ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN;

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// --------------------- EXPRESS SERVER ---------------------
const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// --------------------- SUPABASE ---------------------
const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --------------------- HEALTH CHECK ---------------------
app.get("/", (req, res) => {
  res.json({
    status: "Kite Backend Running",
    time: new Date().toISOString()
  });
});

// --------------------- ALERT SETTINGS ---------------------
const settings = {
  relVolThreshold: 1.5,
  changePctThreshold: 2,
  cooldownMs: 15000
};

const state = {}; // Stores last known data per symbol

// --------------------- SUPABASE LOG ---------------------
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

// ================================================================
//                    KITE TICKER (THE CORRECT WAY)
// ================================================================
function startTicker() {
  const ticker = new KiteTicker({
    api_key: API_KEY,
    access_token: ACCESS_TOKEN
  });

  ticker.connect();

  ticker.on("connect", () => {
    console.log("Kite WebSocket Connected");

    // Subscribe to ALL tokens
    ticker.subscribe(TOKENS);

    // Full tick data
    ticker.setMode(ticker.modeFull, TOKENS);
  });

  ticker.on("ticks", async (ticks) => {
    ticks.forEach(async (tick) => {
      const token = tick.instrument_token;

      const index = TOKENS.indexOf(token);
      if (index === -1) return;

      const symbol = SYMBOLS[index];
      const price = tick.last_price;
      const volume = tick.volume;
      const prevHigh = tick.ohlc?.high || price * 1.01;
      const prevLow = tick.ohlc?.low || price * 0.99;

      // Initialize state
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

      // ---------------- ALERT CONDITIONS ----------------
      const crossedHigh =
        st.prevPrice <= st.prevDayHigh && st.price > st.prevDayHigh;

      if (!crossedHigh) return;
      if (st.relativeVolume <= settings.relVolThreshold) return;
      if (st.changePct <= settings.changePctThreshold) return;
      if (Date.now() - st.lastAlertAt < settings.cooldownMs) return;

      st.lastAlertAt = Date.now();

      const msgText =
        `High Cross + RelVol>${settings.relVolThreshold} + Change%>${settings.changePctThreshold}`;

      // Log to Supabase
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

  ticker.on("error", (err) => console.error("Kite WS Error:", err));

  ticker.on("disconnect", () => {
    console.log("Ticker disconnected — reconnecting in 3s...");
    setTimeout(startTicker, 3000);
  });
}

startTicker();

// ------------------- SOCKET.IO --------------------
io.on("connection", (socket) => {
  console.log("Frontend connected:", socket.id);
});

// ------------------- START SERVER --------------------
server.listen(PORT, () => {
  console.log(`Backend live on port ${PORT}`);
});

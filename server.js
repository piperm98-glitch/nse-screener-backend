import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fetch from "node-fetch";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// ---------------- ENV VARIABLES ----------------
const API_KEY = process.env.KITE_API_KEY;
const API_SECRET = process.env.KITE_API_SECRET;
const ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;

// -------------- SUPABASE (server-side) --------------
const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// -------------- EXPRESS + SOCKET.IO -----------------
const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

// -------------- SIMPLE STATUS ENDPOINT --------------
app.get("/", (req, res) => {
  res.json({
    status: "Backend running",
    time: new Date().toISOString(),
  });
});

// -------------- WATCHLIST (YOU MAY EDIT) --------------
const INSTRUMENTS = [
  "NSE_EQ|RELIANCE",
  "NSE_EQ|TCS",
  "NSE_EQ|INFY",
  "NSE_EQ|HDFCBANK",
  "NSE_EQ|ICICIBANK",
  "NSE_EQ|SBIN",
];

// -------------- ALERT FILTER SETTINGS --------------
const settings = {
  relVolThreshold: 1.5,
  changePctThreshold: 2,
  highCross: true,
  cooldownMs: 15000
};

// -------------- INTERNAL STATE --------------
const state = {}; // per-symbol memory

// -------------- SUPABASE LOGGING --------------
async function logAlert(symbol, price, msg) {
  const { error } = await supabase
    .from("nse_screener_alerts")
    .insert([
      {
        timestamp: new Date().toISOString(),
        symbol,
        price,
        criteria_hit: msg,
        user_id: "server"
      },
    ]);

  if (error) console.error("Supabase Error:", error);
}

// -------------- UPSTOX WEBSOCKET LOGIC --------------
// Render does not allow WebSocket outbound easily in free tier,
// so we will first fetch AUTHORIZED URL from Upstox REST API:

async function getUpstoxWsUrl() {
  const res = await fetch(
    "https://api.upstox.com/v2/market-data/feed/authorize",
    {
      headers: {
        Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`
      }
    }
  );

  const json = await res.json();
  return json.data.authorizedRedirectUri;
}

async function startUpstoxStream() {
  const wsUrl = await getUpstoxWsUrl();
  console.log("Upstox WS URL:", wsUrl);

  const WebSocket = (await import("ws")).default;
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("Upstox WebSocket Connected");

    ws.send(
      JSON.stringify({
        guid: "abc-123",
        method: "sub",
        data: {
          mode: "full",
          instrumentKeys: INSTRUMENTS
        }
      })
    );
  });

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }

    if (!data?.data?.feeds) return;

    Object.values(data.data.feeds).forEach(async (tick) => {
      const symbol = tick?.instrumentKey?.split("|")[1];
      if (!symbol) return;

      const price = tick?.ltp || 0;
      const volume = tick?.volume || 0;
      const prevHigh = tick?.ohlc?.prevHigh || price * 1.01;
      const prevLow = tick?.ohlc?.prevLow || price * 0.99;

      if (!state[symbol]) {
        state[symbol] = {
          prevPrice: price,
          prevDayHigh: prevHigh,
          prevDayLow: prevLow,
          avgVolume: volume || 1000,
          lastAlertAt: 0,
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

      // ALERT LOGIC
      let triggered = false;

      if (settings.highCross) {
        if (st.prevPrice <= st.prevDayHigh && st.price > st.prevDayHigh) {
          triggered = true;
        }
      }

      if (!triggered) return;

      if (st.relativeVolume <= settings.relVolThreshold) return;
      if (st.changePct <= settings.changePctThreshold) return;

      if (Date.now() - st.lastAlertAt < settings.cooldownMs) return;
      st.lastAlertAt = Date.now();

      const msgText = `High Cross + RelVol > ${settings.relVolThreshold} + Change% > ${settings.changePctThreshold}`;

      // SAVE TO SUPABASE
      await logAlert(symbol, st.price, msgText);

      // SEND TO ALL CONNECTED CLIENTS
      io.emit("alert", {
        symbol,
        price: st.price,
        criteriaHit: msgText,
        timestamp: new Date().toISOString()
      });

      console.log("ALERT:", symbol, msgText);
    });
  });

  ws.on("close", () => console.log("Upstox WS Closed"));
  ws.on("error", (err) => console.error("Upstox WS Error:", err));
}

startUpstoxStream();

// -------------- SOCKET.IO CONNECTIONS --------------
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
});

// -------------- START SERVER --------------
server.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

# 🪙 Midas

> Autonomous XAU/USD trading agent for Valetax (MT5), powered by LLMs.
> *Everything it touches turns to gold.*
> Inspired by [Meridian](https://github.com/yunus-0x/meridian) architecture.

---

## Apa Ini?

Bot trading emas (XAU/USD) yang bisa:
- 🔍 **Cari setup entry sendiri** — analisis multi-timeframe, cek spread, filter sesi
- 📊 **Pantau posisi open** — breakeven, trailing stop, partial close
- 🧠 **Belajar dari tiap trade** — auto-extract lesson dari win & loss
- 📈 **Evolve strategy** — auto-adjust parameter dari hasil trading
- 💬 **Bisa dichat** — tanya-tanya atau kasih instruksi langsung

Kayak punya trader AI yang kerja 24/7, makin lama makin pinter.

---

## Arsitektur (Simpel)

```
LLM (OpenRouter)          ← Otak: mikir, analisis, ambil keputusan
    ↕
agent.js (ReAct Loop)     ← Sistem saraf: prompt → mikir → eksekusi → repeat
    ↕
MT5 Bridge (Python)       ← Tangan: buka/tutup order, ambil data
    ↕
MT5 Desktop               ← Platform: konek ke Valetax
```

Dua agent spesialis jalan paralel:
- **Setup Scanner** (tiap 15 menit) — nyari peluang entry
- **Position Manager** (tiap 5 menit) — pantau & atur posisi open

---

## Quick Start

### Prasyarat

- **Node.js 18+**
- **Python 3.8+** + `pip install MetaTrader5`
- **MT5 Desktop** terinstall & login Valetax
- **OpenRouter API key** (gratis tier cukup)

### Install

```bash
git clone https://github.com/dexa555/midas
cd midas
npm install
```

### Setup

```bash
# 1. Copy template
cp .env.example .env
cp user-config.example.json user-config.json

# 2. Isi .env — API key & akun MT5
nano .env
```

### Jalanin

```bash
# Testing logic (tanpa MT5, tanpa order real)
npm run dev

# Full pipeline pake akun demo
# (isi .env dulu: DRY_RUN=false, MT5 credentials)
npm start
```

---

## Mode Testing

| Mode | MT5 | Order Real | Buat |
|------|-----|-----------|------|
| `npm run dev` | ❌ | ❌ | Debug logic & prompt |
| Demo account | ✅ | ✅ (duit palsu) | Tes full pipeline |
| Live account | ✅ | ✅ (duit bener) | Production |

---

## Perintah (REPL & CLI)

```
/status      → Cek balance + posisi open
/screen      → Scan setup entry manual
/manage      → Review posisi manual
/lessons     → Lihat lesson yang udah dipelajari
/evolve      → Auto-evolve parameter
/stop        → Shutdown
```

```bash
midas balance
midas positions
midas screen --dry-run
midas performance
midas lessons
midas lessons add "jangan entry pas asia kalo gaada struktur"
midas evolve
midas config get
midas config set screening.riskPerTradePct 2.0
```

---

## Fitur Utama

### 🧠 Learning System (lessons.js)

Setiap kali posisi ditutup, bot auto-belajar:

```
Trade Close → Record Hasil → LLM Analisis → Simpan Lesson
                                              ↓
                            Lesson di-inject ke prompt next cycle
```

Bot jadi inget: "oh setup kayak gini kemarin loss, skip" atau "ini pattern yang kemarin profit, gas!"

### 📈 Auto-Evolution

Setelah 5+ trade, bot bisa auto-adjust parameter:
- Win rate tinggi → naikin risk dikit
- Win rate rendah → turunin risk
- Banyak loss di sesi tertentu → perketat filter

### 🛑 Safety

- Emergency stop kalau max daily loss tercapai
- Max consecutive losses auto-berhenti
- Max positions limit
- Session filter (cuma trading pas London/NY)

---

## Config Utama

Semua bisa di-edit di `user-config.json` atau dari CLI:

```json
{
  "screening": {
    "maxPositions": 3,
    "riskPerTradePct": 1.0,
    "minRiskRewardRatio": 1.5,
    "maxSpreadPips": 35,
    "minATR": 200,
    "allowedSessions": ["London", "New York"]
  },
  "management": {
    "breakevenAfterPips": 100,
    "breakevenLockPips": 10,
    "partialClosePct": 50,
    "partialCloseAfterPips": 80,
    "trailingStopPips": 0
  },
  "risk": {
    "maxDailyLossPct": 3.0,
    "maxConsecutiveLosses": 5
  }
}
```

---

## Struktur Project

```
midas/
├── index.js              # Main entry: cron + REPL
├── agent.js              # ReAct agent loop (jantung)
├── prompt.js             # System prompt/SOP per role
├── lessons.js            # Learning & evolution system
├── decision-log.js       # Trade journal + stats
├── state.js              # Position & risk tracker
├── config.js             # Config manager
├── bridge/
│   ├── mt5_bridge.py     # Python MT5 bridge
│   └── bridge.js         # Node.js client
├── tools/
│   ├── definitions.js    # Tool definitions
│   └── executor.js       # Tool execution
└── CONTEXT.md            # Dokumentasi teknis lengkap
```

---

## Butuh Bantuan?

Baca `CONTEXT.md` buat dokumentasi teknis lengkap — diagram arsitektur, data flow, cara extend.

---

## Credits

- Arsitektur: [Meridian](https://github.com/yunus-0x/meridian) by yunus-0x
- Broker: [Valetax](https://valetax.com) via MT5
- LLM: [OpenRouter](https://openrouter.ai)

---

*Dibuat oleh Exa 🦾 & 0xDexa*

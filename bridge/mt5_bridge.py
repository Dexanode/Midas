"""
MT5 Bridge for Forex LLM Agent
Runs as a lightweight JSON-RPC style subprocess.
Communicates with Node.js via stdin/stdout JSON lines.

Requires: pip install MetaTrader5
MT5 Terminal must be running and logged into Valetax account.
"""

import sys
import json
import os
import MetaTrader5 as mt5
from datetime import datetime, timezone

def respond(data):
    sys.stdout.write(json.dumps(data) + "\n")
    sys.stdout.flush()

def init_mt5():
    """Initialize MT5 connection. Reads credentials from env if available, else auto-connects."""
    login = os.environ.get("MT5_LOGIN")
    password = os.environ.get("MT5_PASSWORD")
    server = os.environ.get("MT5_SERVER", "Valetax-Demo")  # or Valetax-Live

    if login and password:
        if not mt5.initialize(login=int(login), password=password, server=server):
            return {"ok": False, "error": f"MT5 init failed: {mt5.last_error()}"}
    else:
        if not mt5.initialize():
            return {"ok": False, "error": f"MT5 init failed: {mt5.last_error()}"}

    account = mt5.account_info()
    if account is None:
        mt5.shutdown()
        return {"ok": False, "error": f"Failed to get account info: {mt5.last_error()}"}

    return {
        "ok": True,
        "account": {
            "login": account.login,
            "server": account.server,
            "balance": account.balance,
            "equity": account.equity,
            "margin": account.margin,
            "free_margin": account.margin_free,
            "leverage": account.leverage,
            "currency": account.currency,
        }
    }

def get_ohlcv(params):
    """Fetch OHLCV bars from MT5."""
    symbol = params.get("symbol", "XAUUSD")
    timeframe_str = params.get("timeframe", "M5")
    bars = params.get("bars", 100)

    tf_map = {
        "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1, "W1": mt5.TIMEFRAME_W1,
    }
    tf = tf_map.get(timeframe_str, mt5.TIMEFRAME_M5)

    rates = mt5.copy_rates_from_pos(symbol, tf, 0, bars)
    if rates is None or len(rates) == 0:
        return {"ok": False, "error": f"No rates for {symbol} {timeframe_str}: {mt5.last_error()}"}

    candles = []
    for r in rates:
        candles.append({
            "time": int(r["time"]),
            "open": round(r["open"], 2),
            "high": round(r["high"], 2),
            "low": round(r["low"], 2),
            "close": round(r["close"], 2),
            "tick_volume": int(r["tick_volume"]),
            "spread": int(r["spread"]),
        })

    return {"ok": True, "symbol": symbol, "timeframe": timeframe_str, "bars": len(candles), "candles": candles}

def get_balance(params):
    """Get current account balance/info."""
    account = mt5.account_info()
    if account is None:
        return {"ok": False, "error": str(mt5.last_error())}

    return {
        "ok": True,
        "balance": account.balance,
        "equity": account.equity,
        "margin": account.margin,
        "free_margin": account.margin_free,
        "profit": account.profit,
        "leverage": account.leverage,
        "currency": account.currency,
    }

def get_positions(params=None):
    """Get all open positions."""
    positions = mt5.positions_get()
    if positions is None:
        return {"ok": True, "positions": [], "count": 0}

    result = []
    for p in positions:
        result.append({
            "ticket": p.ticket,
            "symbol": p.symbol,
            "type": "BUY" if p.type == mt5.ORDER_TYPE_BUY else "SELL",
            "volume": p.volume,
            "open_price": p.price_open,
            "current_price": p.price_current,
            "sl": p.sl,
            "tp": p.tp,
            "profit": p.profit,
            "swap": p.swap,
            "commission": p.commission,
            "comment": p.comment,
            "open_time": str(p.time) if p.time else None,
            "pnl_pips": round((p.price_current - p.price_open) * 10, 1) if p.type == mt5.ORDER_TYPE_BUY else round((p.price_open - p.price_current) * 10, 1),
        })

    return {"ok": True, "positions": result, "count": len(result)}

def open_order(params):
    """Open a new market order."""
    symbol = params["symbol"]
    order_type = params["type"].upper()

    type_map = {"BUY": mt5.ORDER_TYPE_BUY, "SELL": mt5.ORDER_TYPE_SELL}
    if order_type not in type_map:
        return {"ok": False, "error": f"Invalid type: {order_type}"}

    volume = float(params.get("volume", 0.01))
    sl = float(params.get("sl", 0))
    tp = float(params.get("tp", 0))
    comment = params.get("comment", "forex-llm")
    deviation = int(params.get("deviation", 20))

    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        return {"ok": False, "error": f"Symbol not found: {symbol}"}

    if not symbol_info.visible:
        mt5.symbol_select(symbol, True)

    price = mt5.symbol_info_tick(symbol).ask if order_type == "BUY" else mt5.symbol_info_tick(symbol).bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": type_map[order_type],
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": deviation,
        "magic": 420691,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"ok": False, "error": f"Order failed: retcode={result.retcode}, {result.comment}"}

    return {
        "ok": True,
        "ticket": result.order,
        "symbol": symbol,
        "type": order_type,
        "volume": volume,
        "price": result.price,
        "sl": sl,
        "tp": tp,
    }

def close_position(params):
    """Close a position by ticket."""
    ticket = int(params["ticket"])
    deviation = int(params.get("deviation", 20))

    position = mt5.positions_get(ticket=ticket)
    if position is None or len(position) == 0:
        return {"ok": False, "error": f"Position {ticket} not found"}

    position = position[0]
    symbol = position.symbol
    volume = position.volume
    pos_type = position.type

    tick = mt5.symbol_info_tick(symbol)
    price = tick.bid if pos_type == mt5.ORDER_TYPE_BUY else tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": mt5.ORDER_TYPE_SELL if pos_type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY,
        "position": ticket,
        "price": price,
        "deviation": deviation,
        "magic": 420691,
        "comment": "forex-llm close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"ok": False, "error": f"Close failed: retcode={result.retcode}, {result.comment}"}

    return {
        "ok": True,
        "ticket": ticket,
        "symbol": symbol,
        "close_price": result.price,
        "profit": position.profit,
    }

def modify_position(params):
    """Modify SL/TP of an open position."""
    ticket = int(params["ticket"])
    sl = float(params.get("sl", 0))
    tp = float(params.get("tp", 0))

    position = mt5.positions_get(ticket=ticket)
    if position is None or len(position) == 0:
        return {"ok": False, "error": f"Position {ticket} not found"}

    result = mt5.order_modify(ticket=ticket, sl=sl, tp=tp)
    return {"ok": True, "ticket": ticket, "sl": sl, "tp": tp}

def get_spread(params):
    """Get current spread for a symbol."""
    symbol = params.get("symbol", "XAUUSD")
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"ok": False, "error": f"Symbol not found: {symbol}"}

    spread = (tick.ask - tick.bid) * 10
    return {"ok": True, "symbol": symbol, "spread_pips": round(spread, 1), "bid": tick.bid, "ask": tick.ask}

def get_news(params=None):
    """Get economic calendar news (placeholder — needs external API like ForexFactory)."""
    # MT5 doesn't have built-in news API. This is a stub.
    # In production, integrate with ForexFactory API or similar.
    return {
        "ok": True,
        "news": [],
        "note": "News feed requires external API (ForexFactory, FXStreet, etc). Implement via web_fetch in Node.js layer."
    }

ROUTES = {
    "init": init_mt5,
    "get_ohlcv": get_ohlcv,
    "get_balance": get_balance,
    "get_positions": get_positions,
    "open_order": open_order,
    "close_position": close_position,
    "modify_position": modify_position,
    "get_spread": get_spread,
    "get_news": get_news,
}

def main():
    """Main JSON-line RPC loop."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            respond({"ok": False, "error": "Invalid JSON"})
            continue

        method = request.get("method")
        params = request.get("params") or {}
        req_id = request.get("id")

        if method == "shutdown":
            mt5.shutdown()
            respond({"ok": True, "id": req_id})
            break

        handler = ROUTES.get(method)
        if not handler:
            respond({"ok": False, "error": f"Unknown method: {method}", "id": req_id})
            continue

        try:
            result = handler(params)
            result["id"] = req_id
            respond(result)
        except Exception as e:
            respond({"ok": False, "error": str(e), "id": req_id})

    mt5.shutdown()

if __name__ == "__main__":
    main()

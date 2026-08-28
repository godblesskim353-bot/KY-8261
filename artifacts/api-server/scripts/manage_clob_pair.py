#!/usr/bin/env python3
"""Polymarket CLOB bridge for the Binance-driven dual-track BTC bot.

The Node supervisor uses this bridge for market-style FAK orders, one resting
opposite-side GTC defense order, status reconciliation, and confirmed cancellation.
stdout is a JSON protocol; diagnostics stay on stderr.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

# py_clob_client_v2 constructs its httpx client during import. Proxy variables
# must therefore be set before importing the client.
_proxy = os.environ.get("RESIDENTIAL_PROXY_URL", "").strip()
if _proxy:
    os.environ["HTTP_PROXY"] = _proxy
    os.environ["HTTPS_PROXY"] = _proxy

from py_clob_client_v2 import ClobClient, OrderArgsV2, OrderType
from py_clob_client_v2.clob_types import OpenOrderParams, TradeParams


CLOB_HOST = "https://clob.polymarket.com"
POLYGON_CHAIN_ID = 137
DEFAULT_DEPOSIT_WALLET_SIGNATURE_TYPE = 3


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def diagnostic_log(label: str, value: object) -> None:
    print(f"====== {label} ======: {value!r}", file=sys.stderr, flush=True)


def unavailable(code: str, detail: str | None = None) -> None:
    payload: dict[str, Any] = {"ok": False, "code": code}
    if detail:
        payload["detail"] = detail
    emit(payload)
    sys.exit(0)


def configured_signature_type() -> int:
    raw = os.environ.get("POLYMARKET_SIGNATURE_TYPE", "").strip()
    if not raw:
        return DEFAULT_DEPOSIT_WALLET_SIGNATURE_TYPE
    try:
        signature_type = int(raw)
    except ValueError:
        unavailable("INVALID_SIGNATURE_TYPE")
    if signature_type not in (0, 1, 2, 3):
        unavailable("INVALID_SIGNATURE_TYPE")
    return signature_type


def configured_client() -> ClobClient:
    private_key = os.environ.get("POLYMARKET_PRIVATE_KEY", "").strip()
    funder = os.environ.get("POLYMARKET_FUNDER", "").strip()
    proxy = os.environ.get("RESIDENTIAL_PROXY_URL", "").strip()
    if not private_key or not funder:
        unavailable("AUTHENTICATION_NOT_CONFIGURED")
    if not proxy:
        unavailable("PROXY_NOT_CONFIGURED")

    signature_type = configured_signature_type()
    l1_client = ClobClient(
        host=CLOB_HOST,
        chain_id=POLYGON_CHAIN_ID,
        key=private_key,
        signature_type=signature_type,
        funder=funder,
        use_server_time=True,
    )
    return ClobClient(
        host=CLOB_HOST,
        chain_id=POLYGON_CHAIN_ID,
        key=private_key,
        creds=l1_client.derive_api_key(),
        signature_type=signature_type,
        funder=funder,
        use_server_time=True,
    )


def payload() -> dict[str, Any]:
    if len(sys.argv) != 3:
        unavailable("INVALID_REQUEST")
    try:
        value = json.loads(sys.argv[2])
    except json.JSONDecodeError:
        unavailable("INVALID_REQUEST")
    if not isinstance(value, dict):
        unavailable("INVALID_REQUEST")
    return value


def required_string(value: dict[str, Any], key: str) -> str:
    raw = value.get(key)
    if not isinstance(raw, str) or not raw.strip():
        unavailable("INVALID_REQUEST")
    return raw.strip()


def required_positive_number(value: dict[str, Any], key: str) -> float:
    raw = value.get(key)
    if isinstance(raw, bool):
        unavailable("INVALID_REQUEST")
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        unavailable("INVALID_REQUEST")
    if not parsed > 0:
        unavailable("INVALID_REQUEST")
    return parsed


def required_probability(value: dict[str, Any], key: str) -> float:
    parsed = required_positive_number(value, key)
    if parsed >= 1:
        unavailable("INVALID_REQUEST")
    return parsed


def accepted_order_id(response: object) -> str | None:
    if not isinstance(response, dict) or response.get("success") is False:
        return None
    value = response.get("orderID") or response.get("order_id")
    return value if isinstance(value, str) and value else None


def valid_market_buy_amount_precision(order: object) -> bool:
    try:
        maker_amount = int(getattr(order, "makerAmount"))
        taker_amount = int(getattr(order, "takerAmount"))
    except (AttributeError, TypeError, ValueError):
        return False
    return maker_amount % 10_000 == 0 and taker_amount % 100 == 0


def valid_market_sell_amount_precision(order: object) -> bool:
    try:
        maker_amount = int(getattr(order, "makerAmount"))
        taker_amount = int(getattr(order, "takerAmount"))
    except (AttributeError, TypeError, ValueError):
        return False
    return maker_amount % 100 == 0 and taker_amount % 10_000 == 0


def submit_single_order(value: dict[str, Any], *, side: str, order_type: str, success_code: str) -> None:
    token_id = required_string(value, "tokenId")
    direction = required_string(value, "leg").upper()
    price = required_probability(value, "price")
    size = required_positive_number(value, "size")
    client_id = required_string(value, "clientId")
    if not client_id.startswith("0x") or len(client_id) != 66:
        unavailable("INVALID_CLIENT_ID")
    if direction not in ("UP", "DOWN"):
        unavailable("INVALID_REQUEST")

    client = configured_client()
    order = client.create_order(
        OrderArgsV2(
            token_id=token_id,
            price=price,
            size=size,
            side=side,
            expiration=0,
            # Installed py-clob-client-v2 OrderArgsV2 exposes metadata bytes32.
            # It is signed into the deterministic order and is our recovery key.
            metadata=client_id,
        )
    )
    precision_ok = (
        valid_market_buy_amount_precision(order)
        if side == "BUY"
        else valid_market_sell_amount_precision(order)
    )
    if not precision_ok:
        emit(
            {
                "ok": False,
                "code": f"{side}_AMOUNT_PRECISION_INVALID",
                "detail": "The signed single-leg order does not meet Polymarket amount precision limits.",
                "orders": [{"leg": direction, "accepted": False, "orderId": None}],
                "noOrdersAccepted": True,
            }
        )
        return

    response = client.post_order(order, order_type=order_type, defer_exec=True)
    diagnostic_log(f"【{side} {order_type} order response】", response)
    order_id = accepted_order_id(response)
    explicitly_rejected = (
        isinstance(response, dict)
        and response.get("success") is False
        and order_id is None
    )
    emit(
        {
            "ok": bool(order_id),
            "code": success_code if order_id else f"{side}_{order_type}_REJECTED",
            "orders": [{"leg": direction, "accepted": bool(order_id), "orderId": order_id}],
            "noOrdersAccepted": explicitly_rejected,
        }
    )


def submit_fak_buy(value: dict[str, Any]) -> None:
    submit_single_order(
        value,
        side="BUY",
        order_type=OrderType.FAK,
        success_code="FAK_SINGLE_BUY_ACCEPTED",
    )


def submit_fak_sell(value: dict[str, Any]) -> None:
    submit_single_order(
        value,
        side="SELL",
        order_type=OrderType.FAK,
        success_code="FAK_SINGLE_SELL_ACCEPTED",
    )


def submit_gtc_buy(value: dict[str, Any]) -> None:
    submit_single_order(
        value,
        side="BUY",
        order_type=OrderType.GTC,
        success_code="GTC_DEFENSE_BUY_ACCEPTED",
    )


def cancel_orders(value: dict[str, Any]) -> None:
    raw_ids = value.get("orderIds")
    if not isinstance(raw_ids, list):
        unavailable("INVALID_REQUEST")
    order_ids = [item for item in raw_ids if isinstance(item, str) and item]
    if not order_ids:
        emit({"ok": True, "code": "NO_OPEN_ORDERS"})
        return
    response = configured_client().cancel_orders(order_ids)
    diagnostic_log("【cancel response】", response)
    canceled = response.get("canceled") if isinstance(response, dict) else None
    not_canceled = response.get("not_canceled") if isinstance(response, dict) else None
    canceled_ids = set(canceled) if isinstance(canceled, list) else set()
    confirmed = all(order_id in canceled_ids for order_id in dict.fromkeys(order_ids)) and (
        not_canceled in (None, {}, [])
    )
    emit(
        {
            "ok": confirmed,
            "code": "CANCEL_CONFIRMED" if confirmed else "CANCEL_UNCONFIRMED",
            "detail": None if confirmed else repr(response)[:300],
            "orderIds": order_ids,
        }
    )


def get_orders(value: dict[str, Any]) -> None:
    raw_ids = value.get("orderIds")
    if not isinstance(raw_ids, list):
        unavailable("INVALID_REQUEST")
    order_ids = [item for item in raw_ids if isinstance(item, str) and item]
    if not order_ids:
        emit({"ok": True, "code": "ORDER_STATUS", "orders": []})
        return
    client = configured_client()
    orders = []
    for order_id in order_ids:
        response = client.get_order(order_id)
        diagnostic_log("【order status response】", {"orderId": order_id, "response": response})
        if isinstance(response, dict):
            executed_price = response.get("avg_price") or response.get("average_price") or response.get("averagePrice") or response.get("matched_price")
            if executed_price is None:
                executed_price = executed_vwap_for_order(
                    client.get_trades(TradeParams(asset_id=response.get("asset_id") or response.get("token_id"))),
                    order_id,
                )
            orders.append(
                {
                    "orderId": order_id,
                    "status": str(response.get("status") or "UNKNOWN"),
                    "sizeMatched": response.get("size_matched") or response.get("sizeMatched"),
                    # `price` is a resting limit, not a proven execution price.
                    # Only expose fields supplied by CLOB as execution averages.
                    "executedPrice": executed_price,
                    "originalSize": response.get("original_size") or response.get("originalSize"),
                    "price": response.get("price"),
                    "side": response.get("side"),
                    "tokenId": response.get("asset_id") or response.get("token_id"),
                }
            )
    emit({"ok": True, "code": "ORDER_STATUS", "orders": orders})


def executed_vwap_for_order(trades: object, order_id: str) -> float | None:
    """VWAP only fills carrying an exact taker_order_id or maker order_id link.

    py-clob-client-v2 TradeParams can filter by asset/market but not order ID, so
    every returned trade is inspected and unrelated fills are deliberately ignored.
    """
    fills: list[tuple[float, float]] = []
    for trade in trades if isinstance(trades, list) else []:
        if not isinstance(trade, dict):
            continue
        if trade.get("taker_order_id") == order_id or trade.get("takerOrderId") == order_id:
            price = trade.get("price")
            quantity = trade.get("size") or trade.get("amount") or trade.get("size_matched")
            try:
                if float(price) > 0 and float(quantity) > 0:
                    fills.append((float(price), float(quantity)))
            except (TypeError, ValueError):
                pass
        makers = trade.get("maker_orders") or trade.get("makerOrders") or []
        for maker in makers if isinstance(makers, list) else []:
            if not isinstance(maker, dict) or (maker.get("order_id") or maker.get("orderId")) != order_id:
                continue
            price = maker.get("price")
            quantity = maker.get("matched_amount") or maker.get("size_matched") or maker.get("size")
            try:
                if float(price) > 0 and float(quantity) > 0:
                    fills.append((float(price), float(quantity)))
            except (TypeError, ValueError):
                pass
    total = sum(quantity for _, quantity in fills)
    return sum(price * quantity for price, quantity in fills) / total if total > 0 else None


def recover_order(value: dict[str, Any]) -> None:
    client_id = required_string(value, "clientId")
    token_id = required_string(value, "tokenId")
    client = configured_client()
    candidates: dict[str, dict[str, Any]] = {}
    for order in client.get_open_orders(OpenOrderParams(asset_id=token_id)):
        if isinstance(order, dict) and order.get("metadata") == client_id:
            order_id = order.get("id") or order.get("orderID") or order.get("order_id")
            if isinstance(order_id, str):
                candidates[order_id] = order
    # Realistic v2 trade responses identify constituent maker/taker orders.
    for trade in client.get_trades(TradeParams(asset_id=token_id)):
        if not isinstance(trade, dict):
            continue
        for item in [trade, *(trade.get("maker_orders") or [])]:
            if isinstance(item, dict) and item.get("metadata") == client_id:
                order_id = item.get("order_id") or item.get("id")
                if isinstance(order_id, str):
                    candidates[order_id] = item
    if len(candidates) != 1:
        emit({"ok": False, "code": "RECOVERY_NOT_UNIQUE", "detail": f"{len(candidates)} matching orders"})
        return
    order_id = next(iter(candidates))
    emit({"ok": True, "code": "ORDER_RECOVERED", "orders": [{"orderId": order_id}]})


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    value = payload()
    try:
        if action == "submit_fak_buy":
            submit_fak_buy(value)
        elif action == "submit_fak_sell":
            submit_fak_sell(value)
        elif action == "submit_gtc_buy":
            submit_gtc_buy(value)
        elif action == "cancel_orders":
            cancel_orders(value)
        elif action == "get_orders":
            get_orders(value)
        elif action == "recover_order":
            recover_order(value)
        else:
            unavailable("INVALID_ACTION")
    except SystemExit:
        raise
    except Exception as exc:
        diagnostic_log("【CLOB execution error】", f"{type(exc).__name__}: {exc}")
        detail = f"{type(exc).__name__}: {str(exc)[:160]}" if str(exc) else type(exc).__name__
        emit({"ok": False, "code": "CLOB_EXECUTION_UNAVAILABLE", "detail": detail})
        sys.exit(0)


if __name__ == "__main__":
    main()
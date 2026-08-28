#!/usr/bin/env python3
"""Single-leg Polymarket CLOB bridge for the directional BTC bot.

The Node supervisor uses this bridge for one market-style FAK BUY and repeated
market-style FAK SELL orders at the live best bid. It intentionally contains no pair
submission, Merge, or missing-leg recovery path. stdout is a JSON protocol;
diagnostics stay on stderr.
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
            orders.append(
                {
                    "orderId": order_id,
                    "status": str(response.get("status") or "UNKNOWN"),
                    "sizeMatched": response.get("size_matched") or response.get("sizeMatched"),
                    "originalSize": response.get("original_size") or response.get("originalSize"),
                    "price": response.get("price"),
                    "side": response.get("side"),
                    "tokenId": response.get("asset_id") or response.get("token_id"),
                }
            )
    emit({"ok": True, "code": "ORDER_STATUS", "orders": orders})


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    value = payload()
    try:
        if action == "submit_fak_buy":
            submit_fak_buy(value)
        elif action == "submit_fak_sell":
            submit_fak_sell(value)
        elif action == "cancel_orders":
            cancel_orders(value)
        elif action == "get_orders":
            get_orders(value)
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
#!/usr/bin/env python3
"""Submit and inspect a protected BTC YES/NO CLOB order pair.

This is intentionally a CLOB two-leg bridge, not a Combo RFQ bridge: public
Combo RFQ does not permit contradictory YES/NO legs from one binary market.
Every submitted leg is a FOK limit buy, so it must fully fill immediately or
cancel. Sensitive wallet and proxy values remain in server environment only.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

# CRITICAL: py_clob_client_v2's HTTP layer (http_helpers/helpers.py) builds a
# single module-level httpx.Client() the moment it is imported. httpx only
# reads HTTP_PROXY/HTTPS_PROXY from the environment at construction time, not
# per-request. If the proxy env vars were set *after* this import (as
# configured_client() used to do), every order request would silently go out
# directly from this server's own IP instead of RESIDENTIAL_PROXY_URL -- with
# no error, just a plain-looking rejection from Polymarket (e.g. a regional
# block) that gives no hint the proxy was ever bypassed. Setting the env vars
# here, before the import below, is required for the proxy to take effect.
_proxy = os.environ.get("RESIDENTIAL_PROXY_URL", "").strip()
if _proxy:
    os.environ["HTTP_PROXY"] = _proxy
    os.environ["HTTPS_PROXY"] = _proxy

from py_clob_client_v2 import ClobClient, OrderArgsV2, OrderType, PostOrdersV2Args


CLOB_HOST = "https://clob.polymarket.com"
POLYGON_CHAIN_ID = 137
DEFAULT_DEPOSIT_WALLET_SIGNATURE_TYPE = 3


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def diagnostic_log(label: str, value: object) -> None:
    # Keep diagnostics on stderr: stdout is the machine-readable JSON protocol
    # consumed by automatic-pair-execution.ts.
    print(f"====== {label} ======: {value!r}", file=sys.stderr, flush=True)


def unavailable(code: str) -> None:
    emit({"ok": False, "code": code})
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

    os.environ["HTTP_PROXY"] = proxy
    os.environ["HTTPS_PROXY"] = proxy

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


def accepted_order_id(response: object) -> str | None:
    if not isinstance(response, dict) or response.get("success") is False:
        return None
    value = response.get("orderID") or response.get("order_id")
    return value if isinstance(value, str) and value else None


def submit_pair(value: dict[str, Any]) -> None:
    yes_token_id = required_string(value, "yesTokenId")
    no_token_id = required_string(value, "noTokenId")
    yes_price = required_positive_number(value, "yesPrice")
    no_price = required_positive_number(value, "noPrice")
    size = required_positive_number(value, "size")
    expiration = int(required_positive_number(value, "expiration"))
    if expiration <= int(time.time()) + 5:
        unavailable("ORDER_EXPIRY_INVALID")

    client = configured_client()
    orders = [
        client.create_order(
            OrderArgsV2(
                token_id=yes_token_id,
                price=yes_price,
                size=size,
                side="BUY",
                expiration=expiration,
            )
        ),
        client.create_order(
            OrderArgsV2(
                token_id=no_token_id,
                price=no_price,
                size=size,
                side="BUY",
                expiration=expiration,
            )
        ),
    ]
    responses = client.post_orders(
        [
            PostOrdersV2Args(order=orders[0], orderType=OrderType.FOK),
            PostOrdersV2Args(order=orders[1], orderType=OrderType.FOK),
        ],
        defer_exec=True,
    )
    diagnostic_log("【實盤下單回傳結果】", responses)
    if not isinstance(responses, list) or len(responses) != 2:
        unavailable("PAIR_SUBMISSION_UNCONFIRMED")

    order_ids = [accepted_order_id(response) for response in responses]
    accepted = [order_id for order_id in order_ids if order_id]
    fully_accepted = len(accepted) == 2
    cancellation_requested = False
    if not fully_accepted and accepted:
        cancellation_requested = True
        try:
            client.cancel_orders(accepted)
        except Exception:
            pass

    emit(
        {
            "ok": fully_accepted,
            "code": "FOK_PAIR_ACCEPTED" if fully_accepted else "FOK_PAIR_UNCONFIRMED",
            "orders": [
                {"leg": "YES", "accepted": bool(order_ids[0]), "orderId": order_ids[0]},
                {"leg": "NO", "accepted": bool(order_ids[1]), "orderId": order_ids[1]},
            ],
            "cancellationRequested": cancellation_requested,
        }
    )


def cancel_orders(value: dict[str, Any]) -> None:
    raw_ids = value.get("orderIds")
    if not isinstance(raw_ids, list):
        unavailable("INVALID_REQUEST")
    order_ids = [item for item in raw_ids if isinstance(item, str) and item]
    if not order_ids:
        emit({"ok": True, "code": "NO_OPEN_ORDERS"})
        return
    configured_client().cancel_orders(order_ids)
    emit({"ok": True, "code": "CANCEL_REQUESTED", "orderIds": order_ids})


def get_orders(value: dict[str, Any]) -> None:
    raw_ids = value.get("orderIds")
    if not isinstance(raw_ids, list):
        unavailable("INVALID_REQUEST")
    order_ids = [item for item in raw_ids if isinstance(item, str) and item]
    client = configured_client()
    orders = []
    for order_id in order_ids:
        response = client.get_order(order_id)
        if isinstance(response, dict):
            orders.append(
                {
                    "orderId": order_id,
                    "status": str(response.get("status") or "UNKNOWN"),
                    "sizeMatched": response.get("size_matched") or response.get("sizeMatched"),
                }
            )
    emit({"ok": True, "code": "ORDER_STATUS", "orders": orders})


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    value = payload()
    try:
        if action == "submit_pair":
            submit_pair(value)
        elif action == "cancel_orders":
            cancel_orders(value)
        elif action == "get_orders":
            get_orders(value)
        else:
            unavailable("INVALID_ACTION")
    except SystemExit:
        raise
    except Exception as exc:
        diagnostic_log("【實盤下單嚴重噴錯】", f"{type(exc).__name__}: {exc}")
        # Classify the failure instead of swallowing it silently: the caller
        # (automatic-pair-execution.ts) surfaces this in the operator-facing
        # lifecycle reason, so a real bug (auth/proxy/signing/API rejection)
        # is distinguishable from an expected FOK price-race loss. Only the
        # exception type and a short message are emitted -- never raw
        # request/response bodies, which could echo signed payloads.
        detail = f"{type(exc).__name__}: {str(exc)[:160]}" if str(exc) else type(exc).__name__
        emit({"ok": False, "code": "CLOB_EXECUTION_UNAVAILABLE", "detail": detail})
        sys.exit(0)


if __name__ == "__main__":
    main()
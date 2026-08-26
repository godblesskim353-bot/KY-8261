#!/usr/bin/env python3
"""Read a Polymarket CLOB collateral balance through the official credential flow.

This helper deliberately performs only two authenticated CLOB operations:
1. Derive the signer's existing L2 API credential.
2. Read the collateral balance and allowance.

It never creates credentials, submits orders, changes allowances, transfers funds,
or writes sensitive values to stdout/stderr.
"""

from __future__ import annotations

import json
import os
import sys
from decimal import Decimal, InvalidOperation

from py_clob_client_v2 import AssetType, BalanceAllowanceParams, ClobClient


CLOB_HOST = "https://clob.polymarket.com"
POLYGON_CHAIN_ID = 137
# The attached wallet implementation uses a Deposit Wallet signer/proxy
# relationship. Other wallet types must opt in explicitly with this variable.
DEFAULT_DEPOSIT_WALLET_SIGNATURE_TYPE = 3
COLLATERAL_DECIMALS = Decimal("1000000")


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def unavailable(code: str) -> None:
    emit({"ok": False, "code": code})
    sys.exit(1)


def configured_signature_type() -> int:
    raw = os.environ.get("POLYMARKET_SIGNATURE_TYPE", "").strip()
    if not raw:
        return DEFAULT_DEPOSIT_WALLET_SIGNATURE_TYPE
    try:
        value = int(raw)
    except ValueError:
        unavailable("INVALID_SIGNATURE_TYPE")
    if value not in (0, 1, 2, 3):
        unavailable("INVALID_SIGNATURE_TYPE")
    return value


def parse_balance_pusd(response: object) -> str:
    if not isinstance(response, dict):
        raise ValueError("Unexpected balance response")
    raw_balance = response.get("balance")
    if not isinstance(raw_balance, (str, int)):
        raise ValueError("Missing balance value")

    balance_minor_units = Decimal(str(raw_balance))
    if not balance_minor_units.is_finite() or balance_minor_units < 0:
        raise ValueError("Invalid balance value")

    return format(balance_minor_units / COLLATERAL_DECIMALS, "f")


def main() -> None:
    private_key = os.environ.get("POLYMARKET_PRIVATE_KEY", "").strip()
    funder = os.environ.get("POLYMARKET_FUNDER", "").strip()
    proxy = os.environ.get("RESIDENTIAL_PROXY_URL", "").strip()
    if not private_key or not funder:
        unavailable("AUTHENTICATION_NOT_CONFIGURED")
    if not proxy:
        unavailable("PROXY_NOT_CONFIGURED")

    # py-clob-client-v2 uses HTTP clients that respect these standard variables.
    # Do not allow a direct connection if the residential proxy is unavailable.
    os.environ["HTTP_PROXY"] = proxy
    os.environ["HTTPS_PROXY"] = proxy

    signature_type = configured_signature_type()
    try:
        l1_client = ClobClient(
            host=CLOB_HOST,
            chain_id=POLYGON_CHAIN_ID,
            key=private_key,
            signature_type=signature_type,
            funder=funder,
        )
        credentials = l1_client.derive_api_key()

        l2_client = ClobClient(
            host=CLOB_HOST,
            chain_id=POLYGON_CHAIN_ID,
            key=private_key,
            creds=credentials,
            signature_type=signature_type,
            funder=funder,
        )
        params = BalanceAllowanceParams(
            asset_type=AssetType.COLLATERAL,
            signature_type=signature_type,
        )
        l2_client.update_balance_allowance(params)
        response = l2_client.get_balance_allowance(params)
        emit({"ok": True, "balancePusd": parse_balance_pusd(response)})
    except (InvalidOperation, ValueError):
        unavailable("AUTHENTICATED_BALANCE_INVALID")
    except Exception:
        # Do not serialize HTTP errors: those may contain credential headers.
        unavailable("AUTHENTICATED_BALANCE_UNAVAILABLE")


if __name__ == "__main__":
    main()
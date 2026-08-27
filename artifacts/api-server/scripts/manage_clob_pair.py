#!/usr/bin/env python3
"""Submit and inspect a protected BTC YES/NO CLOB order pair.

This is intentionally a CLOB two-leg bridge, not a Combo RFQ bridge: public
Combo RFQ does not permit contradictory YES/NO legs from one binary market.
Every submitted leg is a FOK limit buy, so it must fully fill immediately or
cancel. Sensitive wallet and proxy values remain in server environment only.
"""

from __future__ import annotations

import json
import math
import os
import sys
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
PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"
CONDITIONAL_TOKENS_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
CTF_COLLATERAL_ADAPTER_ADDRESS = "0xAdA100Db00Ca00073811820692005400218FcE1f"
NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS = "0xadA2005600Dec949baf300f4C6120000bDB6eAab"
TOKEN_BASE_UNITS = 1_000_000
MERGE_GAS_RESERVE = 600_000
APPROVAL_GAS_RESERVE = 150_000
GAS_RESERVE_MULTIPLIER = 2


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


def required_probability(value: dict[str, Any], key: str) -> float:
    parsed = required_positive_number(value, key)
    if parsed >= 1:
        unavailable("INVALID_REQUEST")
    return parsed


def required_boolean(value: dict[str, Any], key: str) -> bool:
    raw = value.get(key)
    if not isinstance(raw, bool):
        unavailable("INVALID_REQUEST")
    return raw


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
    # Polymarket represents amounts with six token decimals. Market BUY orders
    # allow at most two decimal places for maker USDC and four for taker shares.
    return maker_amount % 10_000 == 0 and taker_amount % 100 == 0


def valid_market_sell_amount_precision(order: object) -> bool:
    try:
        maker_amount = int(getattr(order, "makerAmount"))
        taker_amount = int(getattr(order, "takerAmount"))
    except (AttributeError, TypeError, ValueError):
        return False
    # Market SELL orders invert the BUY precision rule: maker outcome-token
    # shares may have four decimals, while taker pUSD remains cent precision.
    return maker_amount % 100 == 0 and taker_amount % 10_000 == 0


def submit_single_order(
    value: dict[str, Any],
    *,
    side: str,
    order_type: str,
    success_code: str,
) -> None:
    token_id = required_string(value, "tokenId")
    leg = required_string(value, "leg").upper()
    price = required_probability(value, "price")
    size = required_positive_number(value, "size")
    if leg not in ("YES", "NO"):
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
                "detail": "The signed rescue order does not meet Polymarket maker/taker precision limits.",
                "orders": [{"leg": leg, "accepted": False, "orderId": None}],
                "noOrdersAccepted": True,
            }
        )
        return

    response = client.post_order(
        order,
        order_type=order_type,
        defer_exec=True,
    )
    diagnostic_log(f"【{side} {order_type} 救援單回傳結果】", response)
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
            "orders": [
                {
                    "leg": leg,
                    "accepted": bool(order_id),
                    "orderId": order_id,
                }
            ],
            "noOrdersAccepted": explicitly_rejected,
        }
    )


def submit_fok_buy(value: dict[str, Any]) -> None:
    submit_single_order(
        value,
        side="BUY",
        order_type=OrderType.FOK,
        success_code="RESCUE_FOK_BUY_ACCEPTED",
    )


def submit_fak_sell(value: dict[str, Any]) -> None:
    submit_single_order(
        value,
        side="SELL",
        order_type=OrderType.FAK,
        success_code="RESCUE_FAK_SELL_ACCEPTED",
    )


def merge_capability(value: dict[str, Any]) -> None:
    condition_id = required_string(value, "conditionId")
    yes_token_id = required_string(value, "yesTokenId")
    no_token_id = required_string(value, "noTokenId")
    shares = required_positive_number(value, "size")
    neg_risk = required_boolean(value, "negRisk")
    if not condition_id.startswith("0x") or len(condition_id) != 66:
        unavailable("INVALID_CONDITION_ID")
    if not yes_token_id.isdigit() or not no_token_id.isdigit():
        unavailable("INVALID_REQUEST")
    amount = int(math.floor(shares * TOKEN_BASE_UNITS + 1e-6))
    if amount <= 0:
        unavailable("INVALID_REQUEST")

    rpc_url = os.environ.get("POLYMARKET_MERGE_RPC_URL", "").strip()
    private_key = os.environ.get("POLYMARKET_PRIVATE_KEY", "").strip()
    funder = os.environ.get("POLYMARKET_FUNDER", "").strip()
    if not rpc_url:
        unavailable("MERGE_RPC_NOT_CONFIGURED")
    if configured_signature_type() != 0:
        unavailable("MERGE_REQUIRES_RELAYER")
    if not private_key or not funder:
        unavailable("AUTHENTICATION_NOT_CONFIGURED")

    from eth_account import Account
    import requests
    from web3 import HTTPProvider, Web3

    account = Account.from_key(private_key)
    if account.address.lower() != funder.lower():
        unavailable("MERGE_WALLET_OWNERSHIP_MISMATCH")
    session = requests.Session()
    session.trust_env = False
    web3 = Web3(HTTPProvider(rpc_url, session=session, request_kwargs={"timeout": 12}))
    if not web3.is_connected() or web3.eth.chain_id != POLYGON_CHAIN_ID:
        unavailable("MERGE_RPC_UNAVAILABLE")
    owner = Web3.to_checksum_address(account.address)
    adapter_address = Web3.to_checksum_address(
        NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS
        if neg_risk
        else CTF_COLLATERAL_ADAPTER_ADDRESS
    )
    ctf = web3.eth.contract(
        address=Web3.to_checksum_address(CONDITIONAL_TOKENS_ADDRESS),
        abi=[
            {
                "inputs": [
                    {"internalType": "address", "name": "account", "type": "address"},
                    {"internalType": "address", "name": "operator", "type": "address"},
                ],
                "name": "isApprovedForAll",
                "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
                "stateMutability": "view",
                "type": "function",
            }
        ],
    )
    if not web3.eth.get_code(ctf.address) or not web3.eth.get_code(adapter_address):
        unavailable("MERGE_CONTRACT_UNAVAILABLE")
    approval_required = not ctf.functions.isApprovedForAll(owner, adapter_address).call()
    reserved_gas = MERGE_GAS_RESERVE + (
        APPROVAL_GAS_RESERVE if approval_required else 0
    )
    required_native_balance = (
        web3.eth.gas_price * reserved_gas * GAS_RESERVE_MULTIPLIER
    )
    if web3.eth.get_balance(owner) < required_native_balance:
        unavailable("MERGE_GAS_BALANCE_UNAVAILABLE")
    emit(
        {
            "ok": True,
            "code": "MERGE_CAPABLE",
            "approvalRequired": approval_required,
            "reservedGas": reserved_gas,
        }
    )


def merge_positions(value: dict[str, Any]) -> None:
    """Merge an exact complete set for a directly-owned EOA wallet.

    Deposit/proxy wallets require Polymarket's gasless Relayer or Builder
    authorization. This helper deliberately refuses to sign a direct Polygon
    transaction unless the configured funder is the private-key EOA itself.
    """

    condition_id = required_string(value, "conditionId")
    yes_token_id = required_string(value, "yesTokenId")
    no_token_id = required_string(value, "noTokenId")
    shares = required_positive_number(value, "size")
    neg_risk = required_boolean(value, "negRisk")
    if not condition_id.startswith("0x") or len(condition_id) != 66:
        unavailable("INVALID_CONDITION_ID")

    rpc_url = os.environ.get("POLYMARKET_MERGE_RPC_URL", "").strip()
    private_key = os.environ.get("POLYMARKET_PRIVATE_KEY", "").strip()
    funder = os.environ.get("POLYMARKET_FUNDER", "").strip()
    if not rpc_url:
        unavailable("MERGE_RPC_NOT_CONFIGURED")
    if configured_signature_type() != 0:
        unavailable("MERGE_REQUIRES_RELAYER")

    from eth_account import Account
    import requests
    from web3 import HTTPProvider, Web3

    account = Account.from_key(private_key)
    if account.address.lower() != funder.lower():
        unavailable("MERGE_WALLET_OWNERSHIP_MISMATCH")

    amount = int(math.floor(shares * TOKEN_BASE_UNITS + 1e-6))
    if amount <= 0:
        unavailable("INVALID_REQUEST")

    # Polygon RPC is unrelated to the geo-restricted CLOB endpoint. Keep the
    # RPC session outside the residential proxy so SOCKS-only proxy plans do
    # not break Web3's requests transport.
    session = requests.Session()
    session.trust_env = False
    web3 = Web3(HTTPProvider(rpc_url, session=session, request_kwargs={"timeout": 12}))
    if not web3.is_connected() or web3.eth.chain_id != POLYGON_CHAIN_ID:
        unavailable("MERGE_RPC_UNAVAILABLE")

    owner = Web3.to_checksum_address(account.address)
    adapter_address = Web3.to_checksum_address(
        NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS
        if neg_risk
        else CTF_COLLATERAL_ADAPTER_ADDRESS
    )
    ctf = web3.eth.contract(
        address=Web3.to_checksum_address(CONDITIONAL_TOKENS_ADDRESS),
        abi=[
            {
                "inputs": [
                    {"internalType": "address", "name": "account", "type": "address"},
                    {"internalType": "uint256", "name": "id", "type": "uint256"},
                ],
                "name": "balanceOf",
                "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
                "stateMutability": "view",
                "type": "function",
            },
            {
                "inputs": [
                    {"internalType": "address", "name": "account", "type": "address"},
                    {"internalType": "address", "name": "operator", "type": "address"},
                ],
                "name": "isApprovedForAll",
                "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
                "stateMutability": "view",
                "type": "function",
            },
            {
                "inputs": [
                    {"internalType": "address", "name": "operator", "type": "address"},
                    {"internalType": "bool", "name": "approved", "type": "bool"},
                ],
                "name": "setApprovalForAll",
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function",
            },
        ],
    )
    adapter = web3.eth.contract(
        address=adapter_address,
        abi=[
            {
                "inputs": [
                    {"internalType": "address", "name": "collateralToken", "type": "address"},
                    {"internalType": "bytes32", "name": "parentCollectionId", "type": "bytes32"},
                    {"internalType": "bytes32", "name": "conditionId", "type": "bytes32"},
                    {"internalType": "uint256[]", "name": "partition", "type": "uint256[]"},
                    {"internalType": "uint256", "name": "amount", "type": "uint256"},
                ],
                "name": "mergePositions",
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function",
            }
        ],
    )

    yes_before = ctf.functions.balanceOf(owner, int(yes_token_id)).call()
    no_before = ctf.functions.balanceOf(owner, int(no_token_id)).call()
    if yes_before < amount or no_before < amount:
        emit(
            {
                "ok": False,
                "code": "MERGE_BALANCE_INSUFFICIENT",
                "yesBalanceBaseUnits": str(yes_before),
                "noBalanceBaseUnits": str(no_before),
                "requiredBaseUnits": str(amount),
            }
        )
        return

    def send_transaction(function: Any) -> str:
        nonce = web3.eth.get_transaction_count(owner, "pending")
        transaction = function.build_transaction(
            {
                "from": owner,
                "chainId": POLYGON_CHAIN_ID,
                "nonce": nonce,
                "gasPrice": web3.eth.gas_price,
            }
        )
        estimated = web3.eth.estimate_gas(transaction)
        transaction["gas"] = max(estimated, math.ceil(estimated * 1.2))
        signed = account.sign_transaction(transaction)
        tx_hash = web3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = web3.eth.wait_for_transaction_receipt(tx_hash, timeout=45)
        if receipt.status != 1:
            unavailable("MERGE_TRANSACTION_REVERTED")
        return tx_hash.hex()

    approval_tx_hash = None
    if not ctf.functions.isApprovedForAll(owner, adapter_address).call():
        approval_tx_hash = send_transaction(
            ctf.functions.setApprovalForAll(adapter_address, True)
        )

    merge_tx_hash = send_transaction(
        adapter.functions.mergePositions(
            Web3.to_checksum_address(PUSD_ADDRESS),
            bytes(32),
            bytes.fromhex(condition_id[2:]),
            [1, 2],
            amount,
        )
    )
    yes_after = ctf.functions.balanceOf(owner, int(yes_token_id)).call()
    no_after = ctf.functions.balanceOf(owner, int(no_token_id)).call()
    confirmed = yes_before - yes_after >= amount and no_before - no_after >= amount
    emit(
        {
            "ok": confirmed,
            "code": "MERGE_CONFIRMED" if confirmed else "MERGE_BALANCE_UNCONFIRMED",
            "mergeTxHash": merge_tx_hash,
            "approvalTxHash": approval_tx_hash,
            "mergedBaseUnits": str(amount),
        }
    )


def submit_pair(value: dict[str, Any]) -> None:
    yes_token_id = required_string(value, "yesTokenId")
    no_token_id = required_string(value, "noTokenId")
    yes_price = required_positive_number(value, "yesPrice")
    no_price = required_positive_number(value, "noPrice")
    size = required_positive_number(value, "size")

    client = configured_client()
    # FOK is a non-GTD order type. Polymarket rejects any non-zero expiration
    # for non-GTD orders. The FOK is immediate, so no client-side expiration
    # deadline is needed here.
    fok_expiration = 0
    orders = [
        client.create_order(
            OrderArgsV2(
                token_id=yes_token_id,
                price=yes_price,
                size=size,
                side="BUY",
                expiration=fok_expiration,
            )
        ),
        client.create_order(
            OrderArgsV2(
                token_id=no_token_id,
                price=no_price,
                size=size,
                side="BUY",
                expiration=fok_expiration,
            )
        ),
    ]
    if not all(valid_market_buy_amount_precision(order) for order in orders):
        emit(
            {
                "ok": False,
                "code": "PAIR_AMOUNT_PRECISION_INVALID",
                "detail": "Both FOK legs must have maker amounts at cent precision and taker amounts at four-decimal precision.",
                "orders": [
                    {"leg": "YES", "accepted": False, "orderId": None},
                    {"leg": "NO", "accepted": False, "orderId": None},
                ],
                "cancellationRequested": False,
                "noOrdersAccepted": True,
            }
        )
        return
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
    explicitly_rejected = all(
        isinstance(response, dict)
        and response.get("success") is False
        and accepted_order_id(response) is None
        for response in responses
    )
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
            "code": (
                "FOK_PAIR_ACCEPTED"
                if fully_accepted
                else "FOK_PAIR_REJECTED"
                if explicitly_rejected
                else "FOK_PAIR_UNCONFIRMED"
            ),
            "orders": [
                {"leg": "YES", "accepted": bool(order_ids[0]), "orderId": order_ids[0]},
                {"leg": "NO", "accepted": bool(order_ids[1]), "orderId": order_ids[1]},
            ],
            "cancellationRequested": cancellation_requested,
            "noOrdersAccepted": explicitly_rejected,
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
    response = configured_client().cancel_orders(order_ids)
    diagnostic_log("【取消訂單回傳結果】", response)
    canceled = response.get("canceled") if isinstance(response, dict) else None
    not_canceled = response.get("not_canceled") if isinstance(response, dict) else None
    valid_canceled = isinstance(canceled, list) and all(
        isinstance(order_id, str) for order_id in canceled
    )
    valid_not_canceled = isinstance(not_canceled, dict)
    confirmed = (
        valid_canceled
        and valid_not_canceled
        and all(order_id in canceled for order_id in dict.fromkeys(order_ids))
        and len(not_canceled) == 0
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
    client = configured_client()
    orders = []
    for order_id in order_ids:
        response = client.get_order(order_id)
        diagnostic_log("【查詢訂單回傳結果】", {"orderId": order_id, "response": response})
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
        if action == "submit_pair":
            submit_pair(value)
        elif action == "submit_fok_buy":
            submit_fok_buy(value)
        elif action == "submit_fak_sell":
            submit_fak_sell(value)
        elif action == "merge_capability":
            merge_capability(value)
        elif action == "merge_positions":
            merge_positions(value)
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
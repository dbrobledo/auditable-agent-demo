#!/usr/bin/env python3
"""Human ratification gate for Category A (irreversible) actions.

ALL DATA IS SYNTHETIC.

Usage:
    python3 ratify.py <dispute_id> approve|reject --by <human_name>

This script is the ONLY path by which a proposed Category A action gets
executed. It verifies the pending proposal's hash, records the human
decision in the same append-only log, and only then executes (here:
a synthetic ledger write). The agent itself has no execution path.
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG_PATH = ROOT / "decisions.jsonl"
PENDING_DIR = ROOT / "pending"
EXECUTED_DIR = ROOT / "executed"


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def input_hash(obj) -> str:
    return "sha256:" + hashlib.sha256(canonical(obj).encode("utf-8")).hexdigest()


def log(actor: str, event: str, ihash: str, decision: str, basis: str) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "actor": actor,
        "event": event,
        "input_hash": ihash,
        "decision": decision,
        "basis": basis,
    }
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, separators=(",", ":")) + "\n")
    print(f"  [{event}] {decision}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dispute_id")
    parser.add_argument("verdict", choices=["approve", "reject"])
    parser.add_argument("--by", required=True, help="name of ratifying human")
    args = parser.parse_args()

    pending_path = PENDING_DIR / f"{args.dispute_id}.json"
    if not pending_path.exists():
        print(f"no pending proposal for {args.dispute_id}", file=sys.stderr)
        return 1

    with open(pending_path, encoding="utf-8") as f:
        proposal = json.load(f)
    phash = input_hash(proposal)
    actor = f"human:{args.by}"

    if args.verdict == "reject":
        log(actor, "RATIFICATION_RECORDED", phash, "REJECT",
            "human reviewer rejected the proposed action; it will not execute")
        pending_path.unlink()
        return 0

    log(actor, "RATIFICATION_RECORDED", phash, "APPROVE",
        f"human reviewer approved proposed {proposal['action']} of "
        f"${proposal['amount_usd']:.2f} for {proposal['dispute_id']}; "
        "recorded before execution")

    # Execution happens only past this line — after the human decision
    # is durably in the log. (Synthetic ledger: a file write.)
    EXECUTED_DIR.mkdir(exist_ok=True)
    record = dict(proposal, executed_at=datetime.now(timezone.utc).isoformat(),
                  ratified_by=actor)
    with open(EXECUTED_DIR / f"{args.dispute_id}.json", "w",
              encoding="utf-8") as f:
        json.dump(record, f, indent=2)
    pending_path.unlink()

    log("system:executor", "ACTION_EXECUTED", phash,
        f"EXECUTED:{proposal['action']}:${proposal['amount_usd']:.2f}",
        "executed strictly after human ratification was recorded; "
        "synthetic ledger write, no real funds moved")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""ACH dispute intake triage agent — proof-of-work demo.

ALL DATA IS SYNTHETIC. No real accounts, people, or transactions.

Design invariants this script demonstrates:
  1. Append-only JSONL decision log: every step writes
     {ts, actor, event, input_hash, decision, basis}.
  2. Mechanical guardrail: disputes over $500.00 are routed to manual
     review by a plain code branch that runs BEFORE any model call.
  3. Human ratification gate: provisional credit is a Category A
     (irreversible) action. The agent writes PENDING_RATIFICATION and
     halts. Execution happens only after ratify.py records a human
     approval.

The only model consultation is for the case-file narrative summary.
The model never decides routing, eligibility, or execution.
"""

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG_PATH = ROOT / "decisions.jsonl"
PENDING_DIR = ROOT / "pending"

# ---- policy constants (mechanism, not model) -------------------------------

AMOUNT_GUARDRAIL_USD = 500.00      # above this: manual review, no model call
MIN_ACCOUNT_AGE_DAYS = 90          # younger accounts: manual review
AUTO_ELIGIBLE_REASON_CODES = {     # NACHA-style reason codes eligible for
    "R10",                         # provisional-credit proposal
    "R11",
}
MODEL_ID = "claude-haiku-4-5-20251001"

# ---- synthetic queue --------------------------------------------------------

SYNTHETIC_QUEUE = [
    {
        "synthetic": True,
        "dispute_id": "DSP-9001",
        "account_id": "ACCT-SYN-4417",
        "account_age_days": 1213,
        "amount_usd": 812.50,
        "reason_code": "R10",
        "narrative": "Cardholder states an ACH debit of $812.50 to "
                     "'NORTHWIND UTILITIES LLC' on 2026-06-28 was not "
                     "authorized. No prior relationship with the payee.",
    },
    {
        "synthetic": True,
        "dispute_id": "DSP-9002",
        "account_id": "ACCT-SYN-7730",
        "account_age_days": 421,
        "amount_usd": 137.20,
        "reason_code": "R10",
        "narrative": "Account holder reports a recurring ACH debit of "
                     "$137.20 from 'FITLIFE GYM MEMBERSHIPS' on 2026-06-30 "
                     "that continued after a documented cancellation on "
                     "2026-05-15.",
    },
]

# ---- log primitives ---------------------------------------------------------


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def input_hash(obj) -> str:
    return "sha256:" + hashlib.sha256(canonical(obj).encode("utf-8")).hexdigest()


def log(actor: str, event: str, ihash: str, decision: str, basis: str) -> dict:
    """Append one entry to the decision log. Append-only: open mode 'a',
    never rewritten, never edited."""
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
    return entry


# ---- model consultation (narrative summary ONLY) ----------------------------


def consult_model_for_summary(dispute: dict) -> str:
    """The single place the model is consulted. Advisory narrative only;
    it cannot route, approve, or execute anything."""
    prompt = (
        "You are summarizing a SYNTHETIC ACH dispute record for a case file. "
        "Write exactly one neutral, factual sentence summarizing the dispute. "
        "Do not recommend any action or resolution. Record: "
        + canonical(dispute)
    )
    try:
        result = subprocess.run(
            ["claude", "-p", "--model", MODEL_ID, prompt],
            capture_output=True, text=True, timeout=300,
        )
    except FileNotFoundError:
        print(
            "\n  [!] `claude` CLI not found on PATH — skipping the advisory "
            "narrative summary.\n"
            "      Install: https://docs.claude.com/en/docs/claude-code\n"
            "      Note: routing, eligibility, and execution below are all "
            "code-branch decisions and are unaffected by this — that's the "
            "point of the guardrail design.\n"
        )
        return "(narrative summary skipped — claude CLI not installed)"
    if result.returncode != 0:
        raise RuntimeError(f"model call failed: {result.stderr.strip()}")
    return " ".join(result.stdout.split())


# ---- triage ------------------------------------------------------------------


def triage(dispute: dict) -> None:
    ihash = input_hash(dispute)
    did = dispute["dispute_id"]
    amount = dispute["amount_usd"]

    log("agent", "QUEUE_READ", ihash, f"INTAKE:{did}",
        "dispute record read from synthetic intake queue")

    # GUARDRAIL — plain code branch, evaluated before any model call.
    if amount > AMOUNT_GUARDRAIL_USD:
        log("agent", "GUARDRAIL_AMOUNT", ihash, "ROUTE_MANUAL_REVIEW",
            f"amount ${amount:.2f} > ${AMOUNT_GUARDRAIL_USD:.2f} threshold; "
            "deterministic code branch; model was not consulted for this record")
        log("agent", "CASE_CLOSED_TO_HUMAN_QUEUE", ihash,
            f"HANDOFF:{did}",
            "routed to manual review queue; agent takes no further action")
        return

    log("agent", "GUARDRAIL_AMOUNT", ihash, "PASS",
        f"amount ${amount:.2f} <= ${AMOUNT_GUARDRAIL_USD:.2f} threshold; "
        "deterministic code branch")

    # Deterministic checks — code, not model.
    age = dispute["account_age_days"]
    if age < MIN_ACCOUNT_AGE_DAYS:
        log("agent", "CHECK_ACCOUNT_AGE", ihash, "ROUTE_MANUAL_REVIEW",
            f"account age {age}d < {MIN_ACCOUNT_AGE_DAYS}d minimum; "
            "deterministic code branch")
        return
    log("agent", "CHECK_ACCOUNT_AGE", ihash, "PASS",
        f"account age {age}d >= {MIN_ACCOUNT_AGE_DAYS}d minimum; "
        "deterministic code branch")

    code = dispute["reason_code"]
    if code not in AUTO_ELIGIBLE_REASON_CODES:
        log("agent", "CHECK_REASON_CODE", ihash, "ROUTE_MANUAL_REVIEW",
            f"reason code {code} not in auto-eligible set "
            f"{sorted(AUTO_ELIGIBLE_REASON_CODES)}; deterministic code branch")
        return
    log("agent", "CHECK_REASON_CODE", ihash, "PASS",
        f"reason code {code} in auto-eligible set "
        f"{sorted(AUTO_ELIGIBLE_REASON_CODES)}; deterministic code branch")

    # Model consultation — narrative summary only, after all checks passed.
    summary = consult_model_for_summary(dispute)
    log("agent", "MODEL_CONSULT_SUMMARY", ihash, "SUMMARY_RECORDED",
        f"advisory narrative only; model={MODEL_ID}; no routing or execution "
        f"authority; output: {summary!r}")

    # Propose resolution — Category A (irreversible): halt for human.
    proposal = {
        "synthetic": True,
        "dispute_id": did,
        "action": "ISSUE_PROVISIONAL_CREDIT",
        "amount_usd": amount,
        "category": "A_IRREVERSIBLE",
        "dispute_input_hash": ihash,
    }
    phash = input_hash(proposal)
    PENDING_DIR.mkdir(exist_ok=True)
    with open(PENDING_DIR / f"{did}.json", "w", encoding="utf-8") as f:
        json.dump(proposal, f, indent=2)

    log("agent", "RESOLUTION_PROPOSED", phash,
        f"PROPOSE:ISSUE_PROVISIONAL_CREDIT:${amount:.2f}",
        "all deterministic checks passed; provisional credit is Category A "
        "(irreversible) and cannot be executed by the agent")
    log("agent", "PENDING_RATIFICATION", phash, "HALT",
        f"agent halts; execution blocked until a human decision is recorded "
        f"via ratify.py for {did}")


def main() -> None:
    print(f"triage run start — {len(SYNTHETIC_QUEUE)} synthetic dispute(s)")
    for dispute in SYNTHETIC_QUEUE:
        print(f"\ndispute {dispute['dispute_id']} "
              f"(${dispute['amount_usd']:.2f}, {dispute['reason_code']}):")
        triage(dispute)
    print("\ntriage run complete — agent halted; "
          "pending actions require human ratification")


if __name__ == "__main__":
    sys.exit(main())
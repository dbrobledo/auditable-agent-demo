# Auditable agent — proof of work

**All data is synthetic. No real accounts, people, or funds.**

This repo is a small, complete demonstration of how I build production
agents for regulated workflows: every decision logged, every guardrail a
mechanism, every irreversible action gated behind a human.

**Read the trace first:** open [`trace.html`](trace.html) — it renders the
unedited decision log from a real run and annotates the three things worth
checking. Under 60 seconds.

## What the run proves

1. **Append-only decision log.** Every step writes one JSONL line —
   `{ts, actor, event, input_hash, decision, basis}` — to
   [`decisions.jsonl`](decisions.jsonl). The `input_hash` is the SHA-256 of
   the exact record being decided on, so any line can be re-verified
   against its input.
2. **Guardrails are code, not prompts.** Disputes over $500 route to manual
   review via an `if` statement that runs before any model call exists in
   the control flow. In this run, DSP-9001 ($812.50) hit that branch — the
   log shows the model was never consulted for it.
3. **Irreversible actions require a human.** The agent may _propose_ a
   provisional credit; it is structurally unable to execute one. It writes
   `PENDING_RATIFICATION` and exits. A separate program,
   [`ratify.py`](ratify.py), records the human decision, and only then does
   execution run. In this run, 68 seconds elapsed between the agent's HALT
   and the human's APPROVE — the agent process was dead while a human decided.

The model (used once, for a narrative summary only) has no routing,
approval, or execution authority. That's the point.

## Files

| File              | Role                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `agent.py`        | Triage agent: deterministic checks, one advisory model call, proposal + halt |
| `ratify.py`       | The only execution path — records the human verdict first                    |
| `decisions.jsonl` | The captured log, exactly as written during the run                          |
| `build_trace.py`  | Renders the log into `trace.html`, character-for-character                   |
| `trace.html`      | The annotated trace — start here                                             |

## Run it yourself

```bash
python3 agent.py                            # triage the synthetic queue; agent halts
python3 ratify.py DSP-9002 approve --by "Your Name"   # record the human decision; execute
python3 build_trace.py                      # regenerate trace.html from the fresh log
```

Requires Python 3.10+ and, for the one advisory model call, the `claude`
CLI on PATH. Everything else is stdlib — no framework, no infrastructure.

## What an engagement looks like

The same invariants, applied to one of your real workflows: one workflow,
four weeks, fixed price, you own the code — including the log format your
auditors will read.

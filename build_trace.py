#!/usr/bin/env python3
"""Build trace.html from the captured decisions.jsonl.

This script embeds the log lines character-for-character (HTML-escaped
only). It never composes, edits, or reorders a log line. Re-run after a
fresh agent.py + ratify.py run to regenerate the artifact.
"""

import html
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG_PATH = ROOT / "decisions.jsonl"
OUT_PATH = ROOT / "trace.html"

lines = LOG_PATH.read_text(encoding="utf-8").splitlines()
entries = [json.loads(l) for l in lines]

# ---- classify each verbatim line for annotation color ----------------------

def css_class(e: dict) -> str:
    if e["event"] == "GUARDRAIL_AMOUNT" and e["decision"] != "PASS":
        return "guardrail"
    if e["event"] == "MODEL_CONSULT_SUMMARY":
        return "model"
    if e["event"] in ("RESOLUTION_PROPOSED", "PENDING_RATIFICATION"):
        return "gate"
    if e["actor"].startswith("human:"):
        return "human"
    if e["event"] == "ACTION_EXECUTED":
        return "executed"
    return "plain"


def render(indices) -> str:
    rows = []
    for i in indices:
        cls = css_class(entries[i])
        rows.append(
            f'<div class="row {cls}"><span class="ln">{i + 1:>2}</span>'
            f'<code>{html.escape(lines[i])}</code></div>'
        )
    return "\n".join(rows)


def find(pred):
    return next(i for i, e in enumerate(entries) if pred(e))


def ts(i) -> datetime:
    return datetime.fromisoformat(entries[i]["ts"])


# indices of the interesting moments (located, not assumed)
i_guard_fire = find(lambda e: e["event"] == "GUARDRAIL_AMOUNT"
                    and e["decision"] == "ROUTE_MANUAL_REVIEW")
i_handoff = find(lambda e: e["event"] == "CASE_CLOSED_TO_HUMAN_QUEUE")
i_model = find(lambda e: e["event"] == "MODEL_CONSULT_SUMMARY")
i_halt = find(lambda e: e["event"] == "PENDING_RATIFICATION")
i_ratify = find(lambda e: e["event"] == "RATIFICATION_RECORDED")
i_exec = find(lambda e: e["event"] == "ACTION_EXECUTED")

gate_gap = (ts(i_ratify) - ts(i_halt)).total_seconds()
model_gap = (ts(i_model) - ts(i_model - 1)).total_seconds()
human_actor = html.escape(entries[i_ratify]["actor"])  # from the log, not assumed

# guardrail source, extracted verbatim from agent.py
src = (ROOT / "agent.py").read_text(encoding="utf-8").splitlines()
g0 = next(i for i, l in enumerate(src) if "GUARDRAIL — plain code branch" in l)
guard_src = html.escape("\n".join(src[g0:g0 + 7]))

page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proof of work — logged, guarded, gated</title>
<style>
  :root {{
    --ink: #1c1c1c; --paper: #faf9f6; --dim: #6b6b6b; --rule: #e2ded6;
    --amber: #b45309; --amber-bg: #fef3e2;
    --blue: #1d4ed8;  --blue-bg: #eaf0fe;
    --purple: #7c3aed; --purple-bg: #f3eefe;
    --green: #15803d; --green-bg: #e9f6ec;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--paper); color: var(--ink);
    font: 16px/1.55 Georgia, 'Times New Roman', serif;
  }}
  main {{ max-width: 880px; margin: 0 auto; padding: 48px 24px 64px; }}
  header h1 {{
    font-size: 30px; line-height: 1.25; margin: 0 0 10px; letter-spacing: -0.01em;
  }}
  .synthetic {{
    display: inline-block; font: 700 11px/1 -apple-system, Helvetica, Arial, sans-serif;
    letter-spacing: 0.12em; color: var(--amber); border: 1.5px solid var(--amber);
    border-radius: 3px; padding: 4px 8px; margin-bottom: 18px;
  }}
  header p.sub {{ color: var(--dim); margin: 0; max-width: 62ch; }}
  section {{ margin-top: 52px; }}
  h2 {{
    font-size: 21px; margin: 0 0 4px;
    display: flex; align-items: baseline; gap: 10px;
  }}
  h2 .no {{
    font: 700 12px/1 -apple-system, Helvetica, Arial, sans-serif;
    color: var(--dim); letter-spacing: 0.08em;
  }}
  section > p {{ margin: 8px 0 16px; max-width: 68ch; }}
  .logbox {{
    background: #fffefb; border: 1px solid var(--rule); border-radius: 6px;
    padding: 10px 0; overflow-x: auto;
  }}
  .row {{
    display: flex; padding: 3px 14px 3px 0; border-left: 4px solid transparent;
    white-space: nowrap;
  }}
  .row .ln {{
    flex: 0 0 34px; text-align: right; padding-right: 12px; user-select: none;
    color: #b8b2a6; font: 11px/1.9 ui-monospace, Menlo, Consolas, monospace;
  }}
  .row code {{ font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace; }}
  .row.guardrail {{ border-left-color: var(--amber); background: var(--amber-bg); }}
  .row.model     {{ border-left-color: var(--blue);  background: var(--blue-bg); }}
  .row.gate      {{ border-left-color: var(--purple); background: var(--purple-bg); }}
  .row.human     {{ border-left-color: var(--green); background: var(--green-bg); }}
  .row.executed  {{ border-left-color: var(--green); background: var(--green-bg); }}
  .legend {{
    font: 12px/1.6 -apple-system, Helvetica, Arial, sans-serif; color: var(--dim);
    margin: 10px 2px 0; display: flex; flex-wrap: wrap; gap: 14px;
  }}
  .legend b {{ font-weight: 600; }}
  .swatch {{
    display: inline-block; width: 10px; height: 10px; border-radius: 2px;
    margin-right: 5px; vertical-align: baseline;
  }}
  .note {{
    border-left: 3px solid var(--rule); padding: 2px 0 2px 14px;
    color: var(--dim); font-size: 14.5px; margin: 14px 0; max-width: 66ch;
  }}
  pre.src {{
    background: #fffefb; border: 1px solid var(--rule); border-radius: 6px;
    padding: 14px 16px; overflow-x: auto; margin: 14px 0;
    font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace;
  }}
  footer {{
    margin-top: 64px; padding-top: 18px; border-top: 1px solid var(--rule);
    color: var(--dim); font-size: 14px;
  }}
  a {{ color: var(--blue); }}
</style>
</head>
<body>
<main>
  <header>
    <div class="synthetic">SYNTHETIC DATA — DEMO ONLY</div>
    <h1>Every decision logged. Every guardrail a mechanism. Every irreversible action gated.</h1>
    <p class="sub">Below is the unedited decision log from a real run of a small
    ACH-dispute triage agent (<code>agent.py</code> + <code>ratify.py</code>) over
    two synthetic disputes. The HTML you are reading was generated by a build
    script that copies the log character-for-character. Nothing here was
    written by hand.</p>
  </header>

  <section id="log">
    <h2><span class="no">1</span>The Log</h2>
    <p>Append-only JSONL. Every step — reads, checks, model calls, halts, human
    decisions, execution — writes one line:
    <code>{{ts, actor, event, input_hash, decision, basis}}</code>. The
    <code>input_hash</code> is the SHA-256 of the exact record being decided on,
    so any line can be re-verified against its input. All {len(lines)} lines,
    verbatim:</p>
    <div class="logbox">
{render(range(len(lines)))}
    </div>
    <div class="legend">
      <span><b><span class="swatch" style="background:var(--amber)"></span>guardrail fired</b></span>
      <span><b><span class="swatch" style="background:var(--blue)"></span>model consulted</b></span>
      <span><b><span class="swatch" style="background:var(--purple)"></span>halted for human</b></span>
      <span><b><span class="swatch" style="background:var(--green)"></span>human decision &amp; execution</b></span>
    </div>
  </section>

  <section id="guardrail">
    <h2><span class="no">2</span>The Guardrail</h2>
    <p>Disputes over $500 go to manual review. This is not a prompt, a policy
    the model is asked to follow, or a post-hoc filter — it is an
    <code>if</code> statement that runs before any model call exists in the
    control flow:</p>
    <pre class="src">{guard_src}</pre>
    <p>DSP-9001 came in at $812.50. Three log lines, then silence — no
    <code>MODEL_CONSULT_SUMMARY</code> event appears for its hash
    (<code>…{entries[i_guard_fire]["input_hash"][-12:]}</code>) anywhere in the
    log, because the branch returned before the model could be reached:</p>
    <div class="logbox">
{render(range(i_guard_fire - 1, i_handoff + 1))}
    </div>
    <div class="note">Contrast with DSP-9002 ($137.20): it passed the same
    branch, cleared two more deterministic checks, and only then was the model
    consulted — line {i_model + 1}, for a narrative summary only. The
    {model_gap:.1f}-second timestamp jump before that line is the real model
    call; every deterministic step around it is milliseconds.</div>
  </section>

  <section id="gate">
    <h2><span class="no">3</span>The Gate</h2>
    <p>Issuing a provisional credit is Category A — irreversible. The agent is
    allowed to <em>propose</em> it, and structurally unable to <em>execute</em>
    it: it writes <code>PENDING_RATIFICATION</code>, halts, and exits. A
    separate program, <code>ratify.py</code>, records the human decision, and
    only past that line does execution run. The four lines, verbatim:</p>
    <div class="logbox">
{render([i_halt - 1, i_halt, i_ratify, i_exec])}
    </div>
    <div class="note">Watch three things: the actor changes
    (<code>agent</code> → <code>{human_actor}</code> →
    <code>system:executor</code>); all four lines carry the same
    <code>input_hash</code>, so the thing approved is provably the thing
    proposed and the thing executed; and {gate_gap:.0f} seconds elapse between
    HALT and APPROVE — the agent process was genuinely dead while a human
    decided.</div>
  </section>

  <footer>
    All records synthetic; no real accounts, people, or funds. Model consulted
    once, for narrative only ({html.escape(json.loads(lines[i_model])["basis"].split(";")[1].split("=")[1].strip())}).
    Built on the pattern described in Anthropic&#x27;s
    <a href="https://www.anthropic.com/engineering/building-effective-agents">Building
    Effective Agents</a>.
  </footer>
</main>
</body>
</html>
"""

OUT_PATH.write_text(page, encoding="utf-8")
print(f"wrote {OUT_PATH} ({len(page):,} bytes, {len(lines)} log lines embedded)")

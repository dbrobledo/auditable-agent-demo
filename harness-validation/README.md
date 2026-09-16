# harness-validation

Executable validation of the *AI Agent Code Generation Harness* design document.

**Read [`REPORT.md`](REPORT.md) first.** This directory is the evidence behind it.

The document's code is transcribed verbatim into `src/` and actually run — against
a real sandbox implementation (temp dir, real child processes, the real Node test
runner) with a scripted model client standing in for Qwen. Thirteen probes each
assert one falsifiable claim about the design.

Every scenario also runs against `src/hardened/`, a corrected implementation of
the same design, as a control group. The control passes 13/13; the document
passes 1/13. That contrast is the point: it shows the failures are defects in the
design, not assertions written to fail.

```bash
npm install
npm run probe        # run all 13 probes against both implementations
npm run typecheck    # reproduces finding M5
```

| Path | Role |
| --- | --- |
| `src/*.ts` | The document's code, verbatim and unmodified |
| `src/hardened/*.ts` | Corrected implementation — the control group |
| `test/local-sandbox.ts` | Real `SandboxService`: temp dir + child processes, fully instrumented |
| `test/scripted-llm.ts` | Scripted `LLMClient`; records every context it is handed |
| `test/sut.ts` | Both orchestrators behind one interface, so scenarios run identically |
| `test/run-probes.ts` | The 13 probes |
| `REPORT.md` | Findings, evidence, and recommended fix order |

`src/llm-client.ts` is a stub: `tdd-loop.ts` imports `LLMClient` from it, but the
document never defines it. The shape is inferred from the single call site.

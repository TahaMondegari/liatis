// Generates docs/LIMITATIONS.md from the Capability Registry: `npm run docs:limitations`.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityRegistry } from "../liara/capabilities.js";
import { SPEC_SOURCES } from "../liara/operations.generated.js";
import { REPO_ROOT } from "../context.js";

const reg = new CapabilityRegistry({ fileBrowserUrl: null, dbInspectorUrl: null });
const all = reg.views();
const by = (s: string) => all.filter((c) => c.status === s);
const lines: string[] = [
  "# LIMITATIONS — generated from the Capability Registry",
  "",
  "> Do not edit by hand. Regenerate with `npm run docs:limitations`.",
  "> Source of truth: official Liara OpenAPI specs in `specs/liara/` (see `RETRIEVED_AT`, `SHA256SUMS`).",
  "",
  `Totals: **${by("supported").length} supported**, **${by("partial").length} partial**, **${by("unsupported").length} unsupported**, ${by("unknown").length} unknown — across ${SPEC_SOURCES.length} specs.`,
  "",
  "## Unsupported (no official API operation)",
  "",
  "| Capability | Persian label | Evidence | What the agent does instead |",
  "|---|---|---|---|",
  ...by("unsupported").map((c) => `| \`${c.id}\` | ${c.labelFa} | ${c.evidence} | ${c.notes ?? ""} |`),
  "",
  "## Partial",
  "",
  "| Capability | Endpoint | Why partial |",
  "|---|---|---|",
  ...by("partial").map((c) => `| \`${c.id}\` | ${c.endpoint ? `\`${c.method} ${c.endpoint}\`` : "—"} | ${c.notes ?? ""} |`),
  "",
  "## Supported but NOT exposed to the model",
  "",
  "These exist in the API but are blocked for the LLM (personal data, arbitrary SQL, password inputs, internal gateway use).",
  "",
  "| Capability | Risk | Reason |",
  "|---|---|---|",
  ...all.filter((c) => c.status === "supported" && !c.exposedToAgent).map((c) => `| \`${c.id}\` | ${c.risk} | ${c.notes ?? ""} |`),
  "",
  "## Other known limitations",
  "",
  "- **Plan catalogue/prices**: read from `GET /v1/me → plans.*`, which the spec types as free-form objects. Missing fields are shown as «نامشخص». Bundle plan (برنزی/نقره‌ای/طلایی) selection is not part of the `createApp` schema.",
  "- **Metric units**: the spec does not state units for `metrics/*` values. The agent assumes memory in bytes and CPU in cores (Liara CLI conventions) and computes % only when the plan RAM/CPU is known.",
  "- **Release states**: the spec does not enumerate `state`; terminal states assumed: READY, FAILED, CANCELED, TIMEOUT. Unknown states keep polling until a 20-minute deadline.",
  "- **Global app-name availability** cannot be checked before creation (only the caller's own apps are visible).",
  "- **Wallet top-up, invoices, usage history, discount codes**: not in the billing API — the UI links to the console.",
  "- **Registrar (e.g. nic.ir) operations** are outside Liara's API; the agent gives manual steps and verifies DNS afterwards.",
  "- **Sandbox**: real QualityGate execution needs Docker. Without it, stages are reported NOT_AVAILABLE; Demo Mode uses a clearly-labelled static simulation.",
  "- **AI models**: only the 12 allowed IDs are used. Image/TTS/STT endpoints exist in Liara AI but no allowed model covers them, so they are not used.",
  "",
];
writeFileSync(join(REPO_ROOT, "docs", "LIMITATIONS.md"), lines.join("\n"));
console.log(`wrote docs/LIMITATIONS.md (${all.length} capabilities)`);

# Architecture

## Components

```mermaid
flowchart LR
  subgraph Web["apps/web (Next.js 16, RTL)"]
    Chat[Chat + Ask Cards] --- Pages[Projects · Incidents · Approvals · Activity · Capabilities · AI]
  end
  Web -- REST --> API
  API -- SSE (replayable) --> Web
  subgraph Server["apps/server (Fastify, TypeScript)"]
    API[routes.ts] --> Agent
    Agent[Agent / Router] --> Deploy[DeployFlow\nstate machine]
    Agent --> Incident[IncidentFlow]
    Agent --> Ops[OpsAgent\nLLM tool loop]
    Deploy & Incident & Ops --> GW[ToolGateway]
    GW --> Policy[PolicyEngine] & Approvals[ApprovalService] & Audit[(append-only audit)]
    GW --> Client[LiaraClient]
    Client --> T{Transport}
    T -- REAL --> HTTP[HttpTransport\nallow-listed hosts]
    T -- DEMO --> Mock[MockTransport + DemoWorld]
    Deploy --> Gate[QualityGate] --> SB[Sandbox: Docker / Simulated]
    Deploy & Incident --> RCA[RCA + KB] --> Coder[CodingAgent]
    Ops & RCA & Coder & Incident --> LLM[LlmGateway]
    Patrol[Patrol worker] --> Incident
    Deploy & Incident & Patrol --> Verify[Verification + verify-delta]
  end
  HTTP --> Liara[(Liara APIs)]
  LLM --> LiaraAI[(Liara AI · allowed models)]
  Server --- DB[(node:sqlite)]
```

## Deploy flow (DeployGraph)

```mermaid
stateDiagram-v2
  [*] --> source: ask card
  source --> analyze: git / zip / sample
  analyze --> platform --> stage --> users --> appName
  appName --> database: new app & DB detected
  appName --> env: existing app
  database --> network --> env --> plan
  plan --> gate
  gate --> invoice: PASS / WARN
  gate --> rca: FAIL
  rca --> patch: code defect (≤ MAX attempts)
  rca --> env: CONFIG_ENV
  patch --> gate: applied to deploy copy
  rca --> acceptIssues: pre-existing / attempts exhausted
  acceptIssues --> invoice: user accepts risk (audited)
  invoice --> execute: approvals approved (server-side)
  execute --> poll: createApp → createDatabase → updateEnvs → upload → release
  poll --> verify: READY
  poll --> deployFailed: FAILED/TIMEOUT
  deployFailed --> redeployApproval: env fix / patch
  verify --> patrolOffer: healthy/warning
  verify --> [*]: unhealthy (no success claimed)
  patrolOffer --> [*]
```

Every transition is persisted in `runs.state_json` before side effects; answers/approvals resume the run.
Interrupted runs are marked on boot (`Agent.recover`).

## Tool execution boundary

```mermaid
sequenceDiagram
  participant M as Model / workflow
  participant G as ToolGateway
  participant P as PolicyEngine
  participant A as ApprovalService
  participant C as LiaraClient
  M->>G: run({capabilityId, req, resource})
  G->>P: evaluate(capability, args, actor)
  alt deny (unsupported / not exposed / demo≠mock)
    G-->>M: denied + audit
  else L0/L1 or standing authorization
    G->>C: executeUnchecked
    C-->>G: redacted data
    G-->>M: executed + audit
  else L2+ (L4 typed)
    G->>A: create(scopeHash, TTL)
    G-->>M: approval_required (card in chat + inbox)
    Note over A: user approves in UI (server-side)
    M->>G: executeApproved(id, resolve placeholders)
    G->>A: consume (tx: status, TTL, scope hash, single-use)
    G->>C: executeUnchecked(resolved req)
  end
```

## Model routing
`config/models.yaml` maps roles → primary + fallbacks (only allowed IDs). The gateway skips models whose probe failed or
that the catalog says lack a needed parameter (e.g. `tools`), retries transient errors with backoff, escalates after two
failed repair attempts, validates structured output with zod, records tokens/latency/`total_cost_toman`, and enforces
daily/per-run Toman budgets.

## Why not LangGraph/Python
The owner allowed any architecture and preferred TypeScript. The same guarantees (typed state, checkpoints, resumable
human-in-the-loop interrupts) are implemented as explicit state machines persisted in SQLite, which keeps
policy/approval semantics in deterministic code and avoids a second runtime.

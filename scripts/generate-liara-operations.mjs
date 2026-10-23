#!/usr/bin/env node
// Generates apps/server/src/liara/operations.generated.ts from the official
// Liara OpenAPI specs stored in specs/liara/*.yaml.
// The generated inventory is the ONLY source of executable Liara endpoints.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specDir = join(root, "specs", "liara");
const outFile = join(root, "apps", "server", "src", "liara", "operations.generated.ts");

/** spec file -> internal service key + default base URL variable */
const SERVICES = {
  "paas.yaml": { service: "paas", baseUrl: "https://api.liara.ir" },
  "dbaas.yaml": { service: "dbaas", baseUrl: "https://api.liara.ir" },
  "billing.yaml": { service: "billing", baseUrl: "https://api.liara.ir" },
  "me.yaml": { service: "account", baseUrl: "https://api.liara.ir" },
  "dns.yaml": { service: "dns", baseUrl: "https://dns-service.liara.ir" },
  "object-storage.yaml": { service: "storage", baseUrl: "https://storage-service.liara.ir" },
  "mail.yaml": { service: "mail", baseUrl: "https://mail-service.liara.ir" },
  "Iaas.yaml": { service: "iaas", baseUrl: "https://iaas-api.liara.ir" },
  // Per-resource hosts: the spec only publishes a templated server URL.
  "file-browser.yaml": { service: "filebrowser", baseUrl: "env:LIARA_FILEBROWSER_URL" },
  "database-inspector.yaml": { service: "dbinspector", baseUrl: "env:LIARA_DB_INSPECTOR_URL" },
  "ai-chat-completions.yaml": { service: "ai_inference", baseUrl: "https://ai.liara.ir" },
  "ai-embeddings.yaml": { service: "ai_inference", baseUrl: "https://ai.liara.ir" },
  "ai-image-generation.yaml": { service: "ai_inference", baseUrl: "https://ai.liara.ir" },
  "ai-tts.yaml": { service: "ai_inference", baseUrl: "https://ai.liara.ir" },
  "ai-stt.yaml": { service: "ai_inference", baseUrl: "https://ai.liara.ir" },
  "ai-workspaces.yaml": { service: "ai_workspaces", baseUrl: "https://ai.liara.ir" },
  "ai-keys.yaml": { service: "ai_keys", baseUrl: "https://ai.liara.ir" },
  "ai-logs.yaml": { service: "ai_logs", baseUrl: "https://ai.liara.ir" },
  "ai-models.yaml": { service: "ai_models", baseUrl: "https://ai.liara.ir" },
  "ai-playground.yaml": { service: "ai_playground", baseUrl: "https://ai.liara.ir" },
};

const METHODS = ["get", "post", "put", "patch", "delete"];

function deref(doc, node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return node;
  if (node.$ref) {
    const parts = node.$ref.replace(/^#\//, "").split("/");
    let cur = doc;
    for (const p of parts) cur = cur?.[p];
    return deref(doc, cur, depth + 1);
  }
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(doc, v, depth + 1);
  return out;
}

/** Strip OpenAPI-only keys so the schema is plain JSON Schema. */
function toJsonSchema(s) {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(toJsonSchema);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (["example", "examples", "xml", "x-codegen-request-body-name", "nullable", "format"].includes(k)) {
      if (k === "nullable" && v === true) out.nullable = true;
      continue;
    }
    out[k] = toJsonSchema(v);
  }
  return out;
}

const ops = [];
const sources = [];
for (const file of readdirSync(specDir).filter((f) => f.endsWith(".yaml")).sort()) {
  const meta = SERVICES[file];
  if (!meta) continue;
  const raw = readFileSync(join(specDir, file), "utf8");
  const doc = yaml.load(raw);
  sources.push({ file, title: doc.info?.title ?? file, sha256: createHash("sha256").update(raw).digest("hex") });
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(doc, p));
      const pathParams = params.filter((p) => p.in === "path").map((p) => ({
        name: p.name,
        enum: p.schema?.enum ?? null,
      }));
      // Spec bug: object-storage download path is written as "/download/${object}".
      const cleanPath = path.replace("${", "{");
      const queryParams = params.filter((p) => p.in === "query").map((p) => ({
        name: p.name,
        required: Boolean(p.required),
        type: p.schema?.type ?? "string",
        enum: p.schema?.enum ?? null,
      }));
      const rb = deref(doc, op.requestBody);
      let body = null;
      if (rb?.content && Object.keys(rb.content).length) {
        const [contentType, media] = Object.entries(rb.content)[0];
        body = { contentType, required: Boolean(rb.required), schema: toJsonSchema(media.schema ?? {}) };
      }
      const security = op.security ?? doc.security ?? [];
      const authKinds = [...new Set(security.flatMap((s) => Object.keys(s)))];
      ops.push({
        id: `${meta.service}.${op.operationId}`,
        service: meta.service,
        operationId: op.operationId,
        method: method.toUpperCase(),
        path: cleanPath,
        summary: op.summary ?? "",
        description: (op.description ?? "").slice(0, 400),
        tags: op.tags ?? [],
        baseUrl: meta.baseUrl,
        auth: file.startsWith("ai-models") ? "none" : authKinds.includes("apiKey") ? "ai_api_key" : "liara_token",
        pathParams,
        queryParams,
        body,
        specFile: file,
        docUrl: `https://developers.liara.ir/`,
      });
    }
  }
}

const header = `// AUTO-GENERATED by scripts/generate-liara-operations.mjs — do not edit.
// Source: official Liara OpenAPI specs (https://developers.liara.ir/spec/*.yaml)
// Retrieved: ${readFileSync(join(specDir, "RETRIEVED_AT"), "utf8").trim()}
/* eslint-disable */
`;
const body = `${header}
export interface GeneratedOperation {
  id: string;
  service: string;
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  description: string;
  tags: string[];
  baseUrl: string;
  auth: "liara_token" | "ai_api_key" | "none";
  pathParams: { name: string; enum: string[] | null }[];
  queryParams: { name: string; required: boolean; type: string; enum: string[] | null }[];
  body: { contentType: string; required: boolean; schema: unknown } | null;
  specFile: string;
  docUrl: string;
}

export const SPEC_SOURCES = ${JSON.stringify(sources, null, 2)} as const;

export const GENERATED_OPERATIONS: readonly GeneratedOperation[] = ${JSON.stringify(ops, null, 2)};
`;
writeFileSync(outFile, body);
console.log(`generated ${ops.length} operations from ${sources.length} specs -> ${outFile}`);

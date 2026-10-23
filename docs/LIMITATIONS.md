# LIMITATIONS — generated from the Capability Registry

> Do not edit by hand. Regenerate with `npm run docs:limitations`.
> Source of truth: official Liara OpenAPI specs in `specs/liara/` (see `RETRIEVED_AT`, `SHA256SUMS`).

Totals: **192 supported**, **22 partial**, **8 unsupported**, 0 unknown — across 20 specs.

## Unsupported (no official API operation)

| Capability | Persian label | Evidence | What the agent does instead |
|---|---|---|---|
| `billing.topUp` | افزایش موجودی کیف پول | Billing spec exposes only GET /v1/billing. | User must pay in the Liara console. |
| `billing.usageHistory` | ریز مصرف و فاکتورها | No usage/invoice endpoint in billing.yaml. | Runway is estimated from balance and the hourlyPrice of resources returned by PaaS/DBaaS. |
| `paas.deployImage` | دپلوی Docker Image آماده | releasesDeploy schema has no image field. | Use `liara deploy --image` from the Liara CLI. |
| `paas.privateNetwork.create` | ساخت شبکه‌ی خصوصی | Only a `network` name can be passed to createApp; no network endpoints. | Create the network in the console, then the agent can attach new apps to it by name. |
| `paas.logs.download` | دانلود فایل لاگ | getAppLogs returns JSON lines only. | The UI can copy the filtered lines. |
| `domain.registrar` | خرید دامنه / تغییر نیم‌سرور در ثبت‌کننده | Not part of any Liara API. | Agent gives manual steps, then verifies with dns.checkNameServer / paas.checkDomain. |
| `dbaas.restore` | بازگردانی بکاپ دیتابیس | dbaas.yaml has backup create/list/download only. | Download the backup and restore manually. |
| `ssl.autoRenew` | تمدید خودکار SSL | Only provision/disable SSL endpoints exist. | Agent can re-run provision-ssl-certs; certificate expiry is checked over TLS. |

## Partial

| Capability | Endpoint | Why partial |
|---|---|---|
| `dbinspector.getAllRoles` | `GET /v1/databases/{databaseID}/roles` | Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.createRole` | `POST /v1/databases/{databaseID}/roles` | Requires a password value; not exposed to the model. Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.updateRole` | `PUT /v1/databases/{databaseID}/roles/{roleName}` | Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.deleteRole` | `DELETE /v1/databases/{databaseID}/roles/{roleName}` | Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.getAllDatasets` | `GET /v1/databases/{databaseID}/datasets` | Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.getDatasetByName` | `GET /v1/databases/{databaseID}/datasets/{datasetName}` | May return personal data; not sent to the model. Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.queries` | `POST /v1/databases/{databaseID}/queries` | Arbitrary SQL is forbidden for the agent (BRIEF §6.2). Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.filterDataset` | `POST /v1/databases/{databaseID}/datasets/{datasetName}/filter` | Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.createData` | `POST /v1/databases/{databaseID}/datasets/{datasetName}/data` | Request body is not described in the spec. Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.updateData` | `PUT /v1/databases/{databaseID}/datasets/{datasetName}/data` | Request body is not described in the spec. Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `dbinspector.deleteData` | `DELETE /v1/databases/{databaseID}/datasets/{datasetName}/data` | Request body is not described in the spec. Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable. |
| `filebrowser.getList` | `GET /v1/projects/{projectID}/disks/{diskName}/list` | Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable. |
| `filebrowser.search` | `GET /v1/projects/{projectID}/disks/{diskName}/search` | Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable. |
| `filebrowser.serve` | `GET /v1/projects/{projectID}/disks/{diskName}/serve` | Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable. |
| `filebrowser.createLink` | `POST /v1/projects/{projectID}/disks/{diskName}/createLink` | Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable. |
| `filebrowser.rename` | `POST /v1/projects/{projectID}/disks/{diskName}/rename` | Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable. |
| `filebrowser.create` | `POST /v1/projects/{projectID}/disks/{diskName}/create` | Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable. |
| `filebrowser.extract` | `POST /v1/projects/{projectID}/disks/{diskName}/extract` | Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable. |
| `filebrowser.upload` | `POST /v1/projects/{projectID}/disks/{diskName}/upload` | Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable. |
| `filebrowser.delete` | `DELETE /v1/projects/{projectID}/disks/{diskName}/delete` | Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable. |
| `paas.rollback` | — | Implemented by re-releasing a sourceID this agent uploaded earlier; works only if Liara still retains that source. |
| `paas.planPrices` | — | Parsed defensively; fields not present are shown as unknown. |

## Supported but NOT exposed to the model

These exist in the API but are blocked for the LLM (personal data, arbitrary SQL, password inputs, internal gateway use).

| Capability | Risk | Reason |
|---|---|---|
| `ai_inference.createChatCompletion` | L0 | Used only by the LLM Gateway. |
| `ai_inference.createEmbedding` | L0 | Used only by the LLM Gateway. |
| `ai_inference.generateImage` | L1 | No image model is in the allowed model list. |
| `ai_inference.editImage` | L1 | No image model is in the allowed model list. |
| `ai_logs.getLogDetailsApiKey` | L0 |  |
| `ai_logs.getLogDetailsPlayground` | L0 |  |
| `ai_playground.playgroundChatCompletion` | L0 |  |
| `ai_playground.playgroundImageGeneration` | L1 |  |
| `ai_playground.playgroundImageEdit` | L1 |  |
| `ai_playground.playgroundListModels` | L0 |  |
| `ai_inference.createTranscription` | L1 | No speech model is in the allowed model list. |
| `ai_inference.createSpeech` | L1 | No speech model is in the allowed model list. |
| `mail.createMailACcount` | L2 | Requires a password value; handled outside the model. |
| `mail.getAllMails` | L0 | Mailbox content is personal data; not sent to the model. |
| `mail.getSingleMail` | L0 |  |
| `mail.getSingleMailHtml` | L0 |  |
| `mail.getAllAttachments` | L0 |  |
| `mail.downloadAttachments` | L0 |  |
| `mail.generateTemporary` | L1 |  |
| `mail.trashMessage` | L1 |  |
| `mail.deleteMessage` | L4 |  |
| `account.getMeUTM` | L0 |  |

## Other known limitations

- **Plan catalogue/prices**: read from `GET /v1/me → plans.*`, which the spec types as free-form objects. Missing fields are shown as «نامشخص». Bundle plan (برنزی/نقره‌ای/طلایی) selection is not part of the `createApp` schema.
- **Metric units**: the spec does not state units for `metrics/*` values. The agent assumes memory in bytes and CPU in cores (Liara CLI conventions) and computes % only when the plan RAM/CPU is known.
- **Release states**: the spec does not enumerate `state`; terminal states assumed: READY, FAILED, CANCELED, TIMEOUT. Unknown states keep polling until a 20-minute deadline.
- **Global app-name availability** cannot be checked before creation (only the caller's own apps are visible).
- **Wallet top-up, invoices, usage history, discount codes**: not in the billing API — the UI links to the console.
- **Registrar (e.g. nic.ir) operations** are outside Liara's API; the agent gives manual steps and verifies DNS afterwards.
- **Sandbox**: real QualityGate execution needs Docker. Without it, stages are reported NOT_AVAILABLE; Demo Mode uses a clearly-labelled static simulation.
- **AI models**: only the 12 allowed IDs are used. Image/TTS/STT endpoints exist in Liara AI but no allowed model covers them, so they are not used.

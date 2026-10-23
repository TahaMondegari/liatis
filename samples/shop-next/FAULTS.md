# shop-next — sample repository with switchable faults

Used by Demo Mode, `npm run demo:replay` and the tests. The agent is NOT
hardcoded to this project; it analyzes it like any other repository.

| Fault | Where | Enabled by default | How the agent should react |
|---|---|---|---|
| `cart_total_string_concat` | `src/cart.ts` (`sum += i.price`) | yes | test «نمایش جمع سبد خرید» fails → RCA (CODE_DEFECT, src/cart.ts:27) → minimal patch `Number(i.price)` on the deploy copy only |
| `preexisting_failing_test` | `tests/checkout.test.ts` («اعتبار کد تخفیف») | yes | classified as pre-existing; never edited; user must accept the risk |
| `missing_env` | `src/db.ts` requires `DATABASE_URL` | yes | env card / auto-provisioned from a new Liara DB |
| `broken_import` | add `import x from "./missing"` to any `src/*.ts` | no | build fails → DEPENDENCY |
| `ts_error` | add `const n: number = "1";` | no | typecheck fails → CODE_DEFECT |
| `missing_dep_in_lockfile` | add a dependency to package.json only | no | install fails → DEPENDENCY |
| `hardcoded_port` | `app.listen(8080)` in a server file | no | analyzer flags hardcoded port; PORT_BINDING patch |
| `memory_leak` / `slow_query` / `bad_release_500` / `db_down` | runtime (mock world scenarios) | via `/api/demo/scenario` | incident detection + remediation proposal + verify-delta |

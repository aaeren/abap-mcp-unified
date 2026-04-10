# MCP ABAP ADT Server — AI Self-Test

Connect to the target SAP system and exercise every tool. Report each result.
Any unhandled exception (stack trace, "Cannot read properties of undefined") is a **critical bug**.

## Read-only tools (safe, run first)

1. **healthcheck** `{}` — expect healthy=true
2. **login** `{}` — expect loggedIn=true
3. **abap_search** `{ query: "CL_ABAP_*", type: "CLAS/OC", max: 5 }` — expect results > 0
4. **abap_search** `{ query: "ZXYZZY_NONEXISTENT_99999" }` — expect count=0, hint present
5. **abap_get_source** `{ name: "CL_ABAP_TYPEDESCR", type: "CLAS" }` — expect source string
6. **abap_object_info** `{ name: "CL_ABAP_TYPEDESCR", type: "CLAS" }` — expect structure
7. **abap_table** `{ name: "T000", limit: 5 }` — expect rows
8. **abap_query** `{ sql: "SELECT * FROM T000", limit: 5 }` — expect rows
9. **abap_syntax_check** `{ name: "CL_ABAP_TYPEDESCR", type: "CLAS" }` — expect result
10. **transport_list** `{}` — expect transports object
11. **abap_get_dump** `{}` — expect dumps array
12. **git_repos** `{}` — expect repos (or clean error if gCTS not configured)

## Validation tests (should produce clean errors, NEVER crashes)

13. **abap_get_source** `{}` — expect error mentioning "name" and "type"
14. **abap_set_source** `{}` — expect error mentioning "name", "type", "source"
15. **abap_create** `{}` — expect error mentioning "name", "type", "description"
16. **abap_delete** `{}` — expect error mentioning "name", "type"
17. **abap_activate** `{}` — expect error mentioning "name", "type"
18. **abap_syntax_check** `{}` — expect error mentioning "name", "type"
19. **abap_atc_run** `{}` — expect error mentioning "name", "type"
20. **transport_assign** `{}` — expect error mentioning "name", "type", "transport"
21. **transport_release** `{}` — expect error mentioning "transport"
22. **transport_contents** `{}` — expect error mentioning "transport"
23. **transport_info** `{}` — expect error mentioning "name", "type"
24. **raw_http** `{}` — expect error mentioning "method", "path"
25. **abap_run** `{}` — expect error mentioning "methodBody"
26. **abap_get_function_group** `{}` — expect error mentioning "name"

## Edge case tests

27. **transport_info** `{ name: "D23K900001" }` — should redirect to transport_contents
28. **abap_search** `{ query: "CL_ABAP_TYPEDESCR", type: "BOGUS/XX" }` — should get clean error about unknown type

## Write-path test (creates and deletes temp object in $TMP)

29. **abap_create** `{ name: "ZMCPTEST_AI", type: "PROG/P", package: "$TMP", description: "AI self-test" }`
30. **abap_set_source** `{ name: "ZMCPTEST_AI", type: "PROG/P", source: "REPORT zmcptest_ai.\nWRITE: / 'Self-test OK'." }`
31. **abap_syntax_check** `{ name: "ZMCPTEST_AI", type: "PROG/P" }` — expect clean
32. **abap_activate** `{ name: "ZMCPTEST_AI", type: "PROG/P" }` — expect activated=true
33. **abap_delete** `{ name: "ZMCPTEST_AI", type: "PROG/P" }` — expect success
34. **abap_search** `{ query: "ZMCPTEST_AI" }` — expect count=0

## Report format

| # | Tool | Test | Result | Notes |
|---|------|------|--------|-------|
| 1 | healthcheck | no args | PASS/FAIL | |
| ... | | | | |

Total: ___ PASS / ___ FAIL

Any FAIL with a stack trace = file as regression test immediately.

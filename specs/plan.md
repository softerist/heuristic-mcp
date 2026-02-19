# Invoking heuristic-mcp Tools Plan

## Why (Architectural intent)

The goal is to demonstrate the capabilities of the `heuristic-mcp` server by invoking its core tools in a logical sequence.

## How (Proposed changes)

I will use the `antigravity` toolset to call the MCP tools directly.
Sequence:

1. `b_index_codebase`
2. `e_check_package_version`
3. `f_set_workspace`
4. `d_ann_config`
5. `a_semantic_search`
6. `d_find_similar_code`
7. `c_clear_cache`

## Risks (What might break?)

- Reindexing might take time depending on the codebase size.
- Clearing cache will require a subsequent reindex for search tools to work.

## Verification (How will we prove it works?)

- Capture and display the JSON output of each MCP call.
- Run `npm test` on key features to ensure system stability.

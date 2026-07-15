# Legacy ACP Runtimes: ACPX and Go SDK

Status: archived

Pocket Studio now supports one conversational runtime: Direct ACP. This document records the removed ACPX and Go SDK implementations so their design decisions and migration constraints are not lost.

## Decision

Direct ACP is the sole runtime because it gives the daemon direct ownership of the agent process, ACP JSON-RPC connection, session lifecycle, model/config changes, event normalization, cancellation, and persisted UI history.

ACPX and Go SDK were removed from product and daemon runtime selection. Existing tabs that contain `agentRuntime: "acpx"` or `agentRuntime: "gosdk"` are migrated to `direct_acp` when loaded. Existing ACPX files are not deleted automatically.

## ACPX Archive

ACPX was an external CLI wrapper between Pocket Studio and an ACP agent:

```text
Studio -> daemon -> acpx CLI -> ACP agent
```

It provided an agent command registry, persistent named sessions, queue ownership, cancellation, model switching, session listing, and provider-history replay. Pocket Studio also implemented its own task records, queues, lifecycle events, and history. The overlapping ownership created two sources of truth.

The most important failure modes were:

- a rejected model could remain in ACPX queue/session options after the UI selected a valid model;
- live stdout events and provider history could describe the same turn with different IDs or formatting;
- refreshing merged daemon history with ACPX history could duplicate a complete turn;
- process ownership and cancellation crossed daemon, ACPX queue-owner, and agent process boundaries;
- session names, ACPX record IDs, task IDs, and provider session IDs required alias reconciliation.

Legacy data locations:

```text
~/.acpx/sessions/
~/.acpx/queues/
~/.config/pocket-studio/acpx-history.json
```

These files may be retained for forensic or manual export purposes. Direct ACP does not consume them as active conversation history.

To restore ACPX in a future branch, recover the removed runtime from version control rather than rebuilding it from this document. Preserve its session locking, process-group termination, tombstones, event-key normalization, and restart recovery tests as one unit.

## Go SDK Archive

Go SDK embedded an ACP client implementation in the daemon and used a separate frontend chat component. It removed the external ACPX process but duplicated most of Direct ACP's responsibilities:

- agent process startup and shutdown;
- initialize/authenticate/session creation;
- prompt streaming and notification conversion;
- model selection and config options;
- cancellation and restart behavior;
- frontend history, status, and message rendering.

Its protocol boundary and product behavior were not distinct enough to justify a second implementation and test matrix. Direct ACP now owns these responsibilities.

To restore Go SDK, recover `internal/daemon/gosdk.go`, its tests, and the former GoSDK frontend component from version control. Do not restore only one layer; the backend and frontend event assumptions evolved together.

## Direct ACP Ownership

The supported flow is:

```text
Studio -> daemon Direct ACP client -> ACP agent
```

The daemon is the single owner of:

- process identity and termination;
- ACP request IDs and pending calls;
- session ID and resume metadata;
- normalized task events and UI history;
- model and config-option state;
- turn status, cancellation, and deletion.

Provider session IDs are resume handles. They are not an independent source from which an already persisted Pocket Studio timeline should be reconstructed.

The history contract is:

- `task.history.get` reads only Pocket Studio's persisted Direct ACP session store;
- `session/load` and `session/resume` may restore provider context, but conversation `session/update` notifications emitted during that recovery window are ignored;
- provider history must never replace, append to, or reconstruct an already saved UI timeline;
- after recovery completes, new live updates are normalized and appended to the Pocket Studio timeline as usual.

Control metadata required for the active connection, such as the provider session ID, model state, and metrics, may still be refreshed. It does not become conversation history.

## Migration Notes

- Remove `acpx` and `gosdk` from UI runtime unions and menus.
- Normalize persisted legacy tab values to `direct_acp`.
- Ignore removed ACPX daemon configuration keys when reading old JSON so upgrades do not fail.
- Keep wire fields such as `agent_runtime` during the compatibility window; emit `direct_acp` for new requests.
- Do not delete user ACPX data during application startup or upgrade.
- New qualification matrices should contain Direct ACP cases only.
- Keep a regression test where a provider emits old conversation updates during resume and assert that none appear in the restored Pocket Studio timeline.

## Reintroduction Gate

A second runtime should only be introduced if it provides a required capability that cannot be implemented through Direct ACP. It must also define one owner for session history, process lifecycle, queueing, and model state before implementation begins.

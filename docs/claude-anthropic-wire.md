# Claude Code support: Anthropic wire front end

Claude Code speaks the **Anthropic Messages API** (`POST /v1/messages`, SSE
with `message_start`/`content_block_delta`/`message_delta`/`message_stop`).
The router currently serves only the OpenAI wire (`/v1/chat/completions`), so
Claude cannot use it yet. This is the plan to add an `anthropic-messages`
front end so Claude Code gets the router's per-turn cost/complexity routing.

The router core is already wire-agnostic (`src/wire/types.ts` defines
`NormRequest`/`UpstreamChunk`/`ResponseSink`; `WireProtocol` already lists
`"pi-native"` as a future front end). Adding Anthropic is a bounded new front
end, not a core change.

## What Claude Code sends

- `POST /v1/messages` with `{ model, max_tokens, system, messages, tools, stream, thinking }`.
- Messages: `user`/`assistant` roles with `content` as a string or a
  content-block array (`text`, `image`, `tool_use`, `tool_result`).
- Tools: `{ name, description, input_schema }`.
- SSE response: `message_start`, `content_block_start`, `content_block_delta`
  (`text_delta`, `input_json_delta`, `thinking_delta`), `content_block_stop`,
  `message_delta`, `message_stop`.

## Work items

### 1. `src/wire/anthropic/request.ts` — parse `/v1/messages` → `NormRequest`

Mirror `src/wire/openai/request.ts`:

- `parseMessagesRequest(body, headers)` → `NormRequest`.
- Map Anthropic roles → `NormRole`: `user`/`assistant`/`system` → the router's
  `system`/`user`/`assistant`; `tool_result`/`tool_use` content blocks → the
  router's `tool` role with `toolCallId`/`name`/`args`.
- Flatten `content` blocks (text + image + tool blocks) into `NormMessage`
  for feature extraction.
- Parse `tools[].input_schema` → `NormTool` (the router sizes tools for
  prompt-cost accounting).
- Parse `thinking` → `ReasoningLevel`.
- `conversationKeyOf` from the same hash util.

### 2. `src/wire/anthropic/sink.ts` — render `UpstreamChunk` → Anthropic SSE

Mirror `src/wire/openai/sink.ts`:

- `createAnthropicStreamingSink(requestedModel)` → `ResponseSink` that emits
  Anthropic SSE frames from `StreamEvent`s:
  - `start` → `message_start` + `content_block_start` (text or tool_use).
  - `text` → `content_block_delta` with `text_delta`.
  - `reasoning` → `content_block_delta` with `thinking_delta`.
  - `tool_call` → `content_block_delta` with `input_json_delta` (partial JSON).
  - `finish` → `content_block_stop` + `message_delta` (stop_reason) +
    `message_stop`.
  - `usage` → `message_delta` with `usage` (input_tokens/output_tokens).
- `createAnthropicBufferedSink` for non-streaming clients (re-buffer the SSE).
- Reuse `encodeSseData` from `src/util/sse.ts`.

### 3. `src/wire/anthropic/errors.ts` — map `WireError` → Anthropic error envelope

Anthropic errors are `{ type: "error", error: { type, message } }` with
`type` ∈ `invalid_request_error` | `authentication_error` | `rate_limit_error`
| `api_error`. Map the router's `WireError.status`/`code` accordingly.

### 4. `src/server/http.ts` — add `POST /v1/messages` route

- In the `fetch` handler, add `if (req.method === "POST" && url.pathname === "/v1/messages")`.
- Parse with `parseMessagesRequest`, build the Anthropic sink, call the same
  `runTurn(normReq, sink, turnDeps, req.signal)` core.
- Reuse the existing Host validation, auth check, and concurrency cap.

### 5. Upstream dispatch — the key decision

The router dispatches to OpenRouter. OpenRouter accepts **both** Anthropic and
OpenAI formats. Two options:

- **A (recommended): dispatch to OpenRouter in Anthropic format** for
  Claude-originated turns. Add an `anthropic-messages` renderer to
  `src/upstream/openrouter.ts` that builds the `/v1/messages` body from
  `NormRequest` + `UpstreamMutations`. This preserves Anthropic-native
  features (thinking blocks, tool_use framing) end to end.
- **B: dispatch in OpenAI format** and let OpenRouter translate. Simpler, but
  loses Anthropic-native thinking/tool framing and may degrade Claude's
  tool-call fidelity.

Recommend **A** — the router's `renderUpstreamBody` is already per-wire, so
adding an Anthropic variant is consistent.

### 6. `/v1/models` for Claude

Claude Code may probe `/v1/models`. The router already returns the profiles in
OpenAI shape. If Claude needs Anthropic shape, add a small renderer; otherwise
reuse the existing list (verify during implementation).

### 7. Tests

- `test/wire-anthropic-request.test.ts` — parse `/v1/messages` bodies
  (roles, content blocks, tools, thinking) into `NormRequest`.
- `test/wire-anthropic-sink.test.ts` — render `StreamEvent`s into Anthropic
  SSE frames (message_start, deltas, tool_use, finish, usage).
- `test/wire-anthropic-errors.test.ts` — `WireError` → Anthropic envelope.
- Extend `tools/smoke.ts` with an Anthropic-wire turn against the mock
  OpenRouter.

## Day-1 support

- **Hermes**: already works (OpenAI wire) — config snippet added to README.
- **Claude**: requires this front end. Not day-1; a deliberate follow-up.

## Open questions

1. **Upstream dispatch format** — confirm A (Anthropic-native) vs B (OpenAI +
   OpenRouter translation). Recommend A.
2. **`/v1/models` shape** — does Claude Code need Anthropic-shaped model
   metadata, or is the OpenAI list sufficient?
3. **Thinking blocks** — how faithfully to round-trip Claude's `thinking`
   through the router's `reasoning` `StreamEvent` (the router already models
   `reasoning` deltas).

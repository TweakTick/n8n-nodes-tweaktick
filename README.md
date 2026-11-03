# n8n-nodes-tweaktick

n8n community nodes for [TweakTick](https://tweaktick.com): client feedback pinned on live websites, images, PDFs and video, with approval rounds and a sign-off record.

> This repository is the published source of the node. TweakTick develops it in a private monorepo and
> syncs each release here as one commit plus a version tag. Issues and pull requests are welcome here;
> accepted changes are applied in the monorepo and come back with the next release.

- **TweakTick Trigger** starts a workflow when clients leave feedback, reply, change a status, approve or ask for changes.
- **TweakTick** replies to, resolves and reopens comments, and lists projects.

[Installation](#installation) · [Credentials](#credentials) · [Trigger](#tweaktick-trigger) · [Actions](#tweaktick-actions) · [Self-hosted n8n](#self-hosted-n8n-needs-a-public-https-url) · [Example workflows](#example-workflows) · [Development](#development)

## Installation

- **n8n Cloud and self-hosted (once the node is verified by n8n):** open the nodes panel, search for **TweakTick** and install it.
- **Self-hosted, manual:** Settings → Community Nodes → Install → `n8n-nodes-tweaktick`. See the [n8n community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/).

You need a paid TweakTick plan. The trial has no API access, so requests answer `402 plan_required`.

## Credentials

1. In TweakTick, an **owner** opens **Settings → API** and creates a key with the **"Zapier / Make / n8n"** preset. The preset gives the scopes `webhooks:write`, `projects:read`, `comments:read` and `comments:write`.
2. Copy the key (it starts with `prk_` and is shown once).
3. In n8n, create a **TweakTick API** credential:
   - **API Key:** the key.
   - **Base URL:** leave it as `https://tweaktick.com` unless you run your own TweakTick app.
4. Save. n8n tests the key with `GET /api/v2/me`.

The key acts as the owner who created it. It stops working when it is revoked or that person is no longer an owner, and the hooks it created stop too.

## TweakTick Trigger

Pick an **Event** and, if you like, one **Project** (leave it empty for all projects).

| Event | Fires when |
|---|---|
| New comment | A client or teammate starts a new comment thread (first comment only) |
| Comment replied | Someone replies in an existing thread |
| Comment updated | A thread's assignee, priority, due date or stage changes |
| Status changed | A thread is resolved or reopened |
| Round approved | The client approves a round |
| Changes requested | The client asks for changes on a round |
| New round | A new round (version) is added to a project |

When you activate the workflow (or click **Listen for test event**), the node registers a webhook with TweakTick. Deactivating it deletes the webhook again.

**Output:** one item per event, for example:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "type": "comment.created",
  "createdAt": "2026-10-27T09:00:00.000Z",
  "workspaceId": "00000000-0000-4000-8000-000000000002",
  "actor": { "type": "guest" },
  "project": { "id": "…", "name": "Example website", "url": "https://tweaktick.com/projects/…" },
  "round": { "id": "…", "n": 1 },
  "pin": { "id": "…", "number": 1, "status": "open", "url": "https://tweaktick.com/projects/…#pin-…" },
  "comment": { "id": "…", "body": "Make the logo bigger.", "author": { "type": "guest", "name": "Sam" }, "createdAt": "2026-10-27T09:00:00.000Z", "isReply": false }
}
```

- `decision` (`approved` or `approved_minor`) appears on round approvals. `outcome` (`changes` or `rejected`) appears on Changes requested only (since 0.3.0); `rejected` means the client rejected the round. `changes` (the new assignee, priority, due date or stage) appears on Comment updated. `stage` is `in_progress`, `ready` or `null`, and is sent only when the workspace has comment stages on. Resolving or reopening clears the stage without a Comment updated event.
- Internal (agency-only) comments, email addresses, tokens and signed links are never sent.
- TweakTick retries failed deliveries, so the same event can arrive twice. Deduplicate on `id` if that matters.

**Security:** every delivery is signed (`X-TweakTick-Signature`, HMAC-SHA256 with a per-webhook secret, 5-minute window). The node checks the signature and answers `401` to anything that fails. n8n sometimes loses the stored secret during manual test runs. When that happens the event is still passed on, with `"verified": false`, and the webhook is registered again the next time the workflow is activated.

## TweakTick actions

| Resource | Operation | What it does |
|---|---|---|
| Comment | Create Reply | Adds a reply to a thread. **Internal (Agency Only)** is on by default; turn it off to reply to the client |
| Comment | Get | Gets a thread with its replies |
| Comment | Resolve / Reopen | Sets the thread's status |
| Project | Get Many | Lists projects, newest first (up to 200) |

**Comment ID** is the thread ID. From the trigger, use `{{ $json.pin.id }}`, not `comment.id`.

Errors show TweakTick's own message, for example `403 insufficient_scope` when the key lacks a scope or `429` when you pass 120 requests a minute.

## Self-hosted n8n needs a public https URL

TweakTick only delivers webhooks to a **public https URL on port 443**. It refuses `http://`, `localhost`, IP addresses, internal host names and custom ports, and the trigger shows that error when you activate it. Options:

- Use **n8n Cloud**, or
- Put self-hosted n8n behind an https reverse proxy or a tunnel (for example Cloudflare Tunnel or ngrok) and set n8n's `WEBHOOK_URL` environment variable to that public address.

The action node has no such limit; it only calls TweakTick.

## Example workflows

- **Client feedback to Slack:** TweakTick Trigger (New comment) → Slack "Send message" with `{{ $json.project.name }}: {{ $json.comment.body }}` and a link to `{{ $json.pin.url }}`.
- **Approval to invoicing:** TweakTick Trigger (Round approved) → your invoicing app "Create invoice" for `{{ $json.project.name }}`.
- **Auto-acknowledge:** TweakTick Trigger (New comment) → TweakTick "Create Reply" with Comment ID `{{ $json.pin.id }}`, Internal off, text "Thanks, we're on it."
- **Close the loop from your task tool:** your tool's "task completed" trigger → TweakTick "Resolve" with the stored thread ID.

## Development

```bash
pnpm install
pnpm build      # n8n-node build (tsc + icons)
pnpm lint       # n8n-node lint (n8n community-node ESLint rules)
pnpm test       # build, then node:test unit tests (no network)
pnpm dev        # runs n8n locally with this node loaded
```

No runtime dependencies: signatures use Node's built-in `crypto`.

### Releasing

Releases are published to npm by GitHub Actions with npm provenance (`.github/workflows/publish.yml`),
which n8n requires for community and verified nodes. The workflow only runs from this repository.

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then push a tag that equals the version with no `v` prefix, for example `0.3.2`.
3. The tag push checks that the tag matches `package.json`, builds, tests and publishes `n8n-nodes-tweaktick` to npm.

The first publish uses a granular npm token stored as the repository secret `NPM_TOKEN`. After that the
package moves to npm Trusted Publishing (GitHub OIDC) and the token is removed, so no npm token is stored here.

## License

[MIT](LICENSE.md)

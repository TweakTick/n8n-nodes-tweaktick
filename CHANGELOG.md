# Changelog

## 0.3.1 (2 Nov 2026)

- The default Base URL is now `https://tweaktick.com` (was `https://app.tweaktick.com`; the app is served from the main domain). Credentials that saved the old default must change it.

## 0.3.0 (29 Oct 2026)

- Changes requested: the output has a new `outcome` field, `changes` (the client asked for changes) or `rejected` (the client rejected the round). Only this trigger has it. No reject reason is sent.

## 0.2.0

- Comment updated: also fires when a thread's stage changes (In progress / Ready to check, when the workspace has comment stages on). The output's `changes` can carry `stage` (`in_progress`, `ready` or `null`). Resolving or reopening clears the stage without a Comment updated event.

## 0.1.0

- TweakTick Trigger: New comment, Comment replied, Comment updated, Status changed, Round approved, Changes requested, New round; optional project filter; signed deliveries (HMAC-SHA256).
- TweakTick: Comment (Create Reply, Get, Reopen, Resolve), Project (Get Many).

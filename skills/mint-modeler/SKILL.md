---
name: mint-modeler
description: Create and revise static 3D models (GLB) with Mint Modeler through the Mint API. Use when the user asks you to make, model, design, or change a 3D model, prop, object, figurine, or 3D-printable part, or mentions Mint Modeler, a GLB, or a quality tier (Low, Medium, High, Studio).
license: MIT
compatibility: Needs Node.js 18 or later, network access to api.mint.gg, and a Mint API key.
metadata:
  homepage: https://docs.mint.gg/developers/modeler
---

# Mint Modeler

Mint Modeler turns a description, reference images, or both into a static, textured 3D Model with real-world proportions, delivered as one self-contained GLB plus a PNG preview. Each revision becomes a new model; the original stays.

Run everything through `scripts/mint-modeler.mjs` in this skill folder. It calls only the Mint API (`https://api.mint.gg/v1`), handles retries safely, and never prints the API key.

## Before the first request

1. Check the key: `node scripts/mint-modeler.mjs me`. It prints the account email, key prefix, and available Credits.
2. If it reports no key, ask the user for one. Offer the private option first: they can run `node <this skill folder>/scripts/mint-modeler.mjs login` in their own terminal and paste the key at the hidden prompt. If they paste the key into chat instead, save it by piping it to `node scripts/mint-modeler.mjs login --stdin`. Either way the key is stored as `MINT_API_KEY` in the user's Mint credentials file with owner-only permissions. Keys come from https://platform.mint.gg under **API keys**.
3. Never print, repeat, log, or commit the key, and never send it anywhere except `api.mint.gg`.

## Make a model

1. Turn the user's words into one clear description: the object, its style, its materials and colors, and its real size (for example "about 10 cm tall"). Keep the user's own details; do not invent extra features.
2. Pick the quality tier (see below). If the user did not say, recommend one and confirm before starting anything above Low, because it spends Credits.
3. Start the request, then wait in short steps. Modeling takes minutes and agent shell commands usually time out sooner, so start with `--no-wait`:

   ```bash
   node scripts/mint-modeler.mjs generate --prompt "A small low-poly coffee mug, about 9 cm tall, matte white glaze" --tier low --no-wait
   ```

   Add `--image path/or/https-url` (up to 8) for reference images. Local images must be JPEG, PNG, GIF, or WebP, at most 5 MB and 5,000 x 5,000 pixels.
4. Tell the user the operation ID, then wait and download:

   ```bash
   node scripts/mint-modeler.mjs wait <operationId> --out ./mint-models --timeout-minutes 8
   ```

   If it stops because the time ran out, the request is still running: run the same `wait` command again. Repeat until it finishes. Use a shorter `--timeout-minutes` if your shell limit is below 8 minutes, and never start a second request for the same model while waiting. `status <operationId>` shows progress without waiting.
5. The final JSON summary has `operationId`, `status`, `modelId`, `files.glb`, `files.preview`, `creditsCharged`, and `creditsMax`. Report to the user: where the GLB and preview are saved, the operation ID, the model ID, and the Credits charged. If `billing` is still `pending`, say the charge is not settled yet and will be at most `creditsMax`.

## Quality tiers

| Tier | Use for | Modeling time | Most charged |
| --- | --- | ---: | ---: |
| `low` | Quick drafts, low-poly props, trying an idea | up to 30 min | 2,000 Credits |
| `medium` | Balanced detail for most props | up to 45 min | 8,000 Credits |
| `high` | Detailed hero objects. The API default | up to 75 min | 25,000 Credits |
| `studio` | The most detail; pauses for feedback before more work | up to 90 min | 100,000 Credits |

Mint reserves the tier's price when the request starts, charges actual usage up to that price, and releases the rest, so small edits cost much less. Queue time is free. A request that builds nothing fails and is refunded in full. If modeling hits its time or budget limit, Modeler delivers the latest model it built, marked as stopped early, and charges it the same way. Always pass `--tier` explicitly so the request never falls back to High by accident.

## Revise or cancel

- Revise a delivered model: `node scripts/mint-modeler.mjs revise <modelId> --prompt "Make the handle thicker" --tier low`. Describe only the change; Modeler keeps everything else. A revision is billed like a new request at its own tier.
- A session runs one request at a time; a second request in the same session returns `409` until the first finishes or is canceled.
- Cancel: `node scripts/mint-modeler.mjs cancel <operationId>`. Before modeling starts it costs nothing; after that it charges only the usage so far. Cancel when the user asks, or when a request is clearly not what they wanted. Never cancel or restart work silently.

## Real-world scale and 3D printing

- Models are in meters and rest on the ground plane (Y up, as in glTF). State the real size in the description, such as "a 9 cm tall mug" or "a 40 mm wide cable clip".
- Many 3D-printing tools read model units as millimeters. When the user wants to print, tell them to scale by 1000 when importing (1 m in the file = 1000 mm), or confirm the size in their tool's measure view.
- For printing, ask for "a single solid, watertight piece with a flat base" and give minimum wall thickness, such as "walls at least 2 mm thick". Avoid thin free-standing parts unless the user wants them.
- Delivered files are GLB with embedded textures. If the user's printing tool needs STL or OBJ, try `POST /v1/models/{modelId}:convert` with `targetFormats` (see the API reference); if that model cannot be converted, tell the user to export STL from any 3D tool that opens GLB.
- Modeler makes static models only: no rigging, animation, or editing of uploaded models.

## Errors

The script prints a JSON error with `status`, `type`, and `requestId`. Read [references/errors.md](references/errors.md) for what to do with each one. In short:

- `401` or `403`: the key is wrong, revoked, or the account cannot use the API. Ask the user to check the key at https://platform.mint.gg; do not retry.
- `402 billing-required`: not enough Credits for the tier. Show the available Credits and suggest a lower tier or adding Credits. Do not retry automatically.
- `400 invalid-request`: fix the listed fields; do not resend unchanged input.
- `409`: the session is busy, or an idempotency key was reused with different input.
- `422 content-policy-blocked`: tell the user the description was blocked; do not rephrase it to get around the policy.
- `429` and `5xx`: the script already waits (`Retry-After`) and retries safely with the same `Idempotency-Key`. If it still fails, report the `requestId`.

## Rules

- Spend only what the user asked for. Confirm the tier before paid work, start one request at a time, and report the Credits used after each one.
- Keep operation and model IDs in your reply so the user can resume, revise, or cancel later.
- Do not call endpoints this skill does not cover without reading the API reference at https://api.mint.gg/openapi.json first. Full guide: https://docs.mint.gg/developers/modeler.

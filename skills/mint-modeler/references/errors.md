# Mint Modeler errors

Mint returns problem JSON. The script prints `status`, `type` (the last part of the problem `type` URL), `requestId`, and, for validation errors, `fields`. Branch on `status` and `type`, not on the wording of the message. Include the `requestId` when the user contacts Mint support.

| Status | Type | What to do |
| --- | --- | --- |
| `400` | `invalid-request` | Fix every field in `fields` (or the message) and try again with a new request. An unavailable parent model or reference image also returns this: use a successful Modeler model and reference images owned by the same account. |
| `400` | `invalid-idempotency-key` | The `Idempotency-Key` header was empty or longer than 255 characters. The script generates valid keys; only a custom `--idempotency-key` can cause this. |
| `401` | | The key is missing, wrong, or revoked. Ask the user to check or create a key at https://platform.mint.gg. Do not retry. |
| `402` | `billing-required` | Not enough Credits for the tier's price. Run `me` to show available Credits, then suggest a lower tier or adding Credits. Do not retry automatically. |
| `403` | `access-denied` | The account or its API project cannot use Modeler. Ask the user to sign in at https://platform.mint.gg and check the account. |
| `404` | `operation-not-found` | The operation or session does not exist or belongs to another account. |
| `409` | `invalid-operation-stage` | The session already has an active request (wait or cancel it), or the operation is not a Modeler operation and cannot be canceled here. |
| `409` | `idempotency-conflict` | The same `Idempotency-Key` was used with different input. Use a new key for a new request. |
| `422` | `content-policy-blocked` | The description was blocked by Mint's content policy. Tell the user; do not reword it to get around the policy. |
| `429` | | Rate limit. The script waits for `Retry-After` and retries. Mint allows 600 requests per minute per account, including polling, shared across its keys. |
| `503` | `content-safety-unavailable` | The content check is briefly unavailable. The script retries; if it keeps failing, try again in a few minutes. |
| `503` | `generation-start-failed` | Modeler could not start. The script retries with the same `Idempotency-Key`, which reuses the original request instead of starting a second one. |

## Final operation states

- `succeeded`: the GLB is ready. The script downloads it and the preview, if one was rendered.
- `failed`: nothing usable was built and the reservation is refunded. Report the error message on the operation.
- `canceled`: the request was canceled. Usage before cancellation is charged, up to the tier's price.

## Safe retries

Every request the script starts carries a fresh `Idempotency-Key`, and it reuses that key only when it retries the same request after a network error, `429`, or `5xx`. That way a retry returns the existing operation instead of starting and charging a second one. Never retry a paid request with a new key unless the first one is known to have failed.

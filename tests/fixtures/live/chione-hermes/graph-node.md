# Authority Context Graph — Loop Proof Node

**`acg:loop:external:b37284a2-7d58-46e7-93e5-53c066618e5c`**

| field | value |
| --- | --- |
| type | `loop_proof` |
| loop_id | `b37284a2-7d58-46e7-93e5-53c066618e5c` |
| goal_hash | `8b3e92a659dc7420a19e944167cb6df22fc950bdbdc4c8ad15386deefe07e64d` |
| action_count | 7 |
| sealed | **SEALED ✓** |
| scope | `external` |
| receipt_count | 8 |
| trust_root.key_id | `ed25519:8681b4b5b46d88fd` |
| trust_root.ed25519_public_key | `2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2` |
| content_digest | `sha256:a56748e05dd39bd142c0f8614325f59c76d3cb7f83d38aa7ccc916198baa2cc0` (over `receipts.json`) |
| source_env | `live-bind-gate` |
| exported_at | `2026-06-05T22:50:33.433Z` |

> Content-blind: only `goal_hash` is carried — never the plaintext goal.
> The sealed verdict above is advisory; verify independently with
> `lyhna-verify --chain receipts.json` (trusts only the pinned public key).

# Configuration Contract: Generic message length

| Property | Contract |
|---|---|
| Key | `GENERIC_MESSAGE_MAX_LENGTH` |
| Type | Integer character count |
| Default | `4000` |
| Inclusive bounds | `1` to `20000` |
| Eligibility | Non-secret runtime tuning; eligible for Firebase Remote Config |
| Precedence | Fresh valid Remote Config value, otherwise environment value, otherwise default |
| Invalid environment input | Use the `4000` default |
| Invalid Remote Config input | Ignore it; retain the valid environment value or the `4000` default |
| Delivery behavior | Invalid configuration never fails webhook delivery |

This does not add a request field or change the response schema. Existing truncation metadata remains conditional on actual truncation, with `deliveredLength` retaining its current name.

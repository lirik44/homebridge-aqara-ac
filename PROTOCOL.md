# The infrared air conditioner behind an Aqara M200, over the cloud

Worked out against a live account, September 2026. Everything here is the app's own RPC — the one
`src/cloud/client.js` signs for — not the developer-console Open API.

## Where the air conditioner lives

It is **not a device of its own**. A remote matched onto the hub becomes another *endpoint* on the
hub, which is why it never appears in `/app/v1.0/lumi/app/position/device/query`.

`GET /app/v1.0/lumi/app/layout/collection/panels?subjectIds=<hub>&types=device_endpoint_panel`
is the only call that says so:

```
endpointId 2  "Aqara Hub M200"   deviceTypes: Hub
endpointId 3  "Air conditioner"  deviceTypes: AirConditioner
              paths: 3.130.32913 3.130.32919 3.130.32915 3.130.33012
                     3.132.32920 3.132.32922
                     3.141.32947 3.141.32948 3.141.32949 3.141.32952 3.141.32953
                     3.142.32950 3.142.32951
              objProperties: 8.0.2116  3.1.28  3.1.600
```

Every call below uses the **hub's** did (`lumi3....`). The endpoint is the `3.` in each path.

## Reading

Two ways, and they answer different things.

**Resources** — `POST /app/v1.0/lumi/res/query/by/resourceId`,
body `{"data": [{"options": [<ids>], "subjectId": "<hub>"}]}`:

| Resource | Example | Meaning |
|---|---|---|
| `0.1.85` | `"2434"` | room temperature, hundredths of a degree → 24.34 °C |
| `0.2.85` | `"6729"` | room humidity, hundredths of a percent → 67.29 % |
| `8.0.2116` | `"P0_M0_T22_S1_D1"` | the whole air conditioner state, as one word |
| `3.1.28` | `"Air conditioner"` | the name shown in the app |
| `3.1.600` | `"air_conditioning"` | which kind of remote was matched |

The room sensor is the useful part: the traits that ought to carry it (`3.141.32952`,
`3.141.32953`) read back empty, and these two do not.

**Traits** — `POST /app/v1.0/lumi/app/qlink/trait/read`,
body `{"devices": [{"deviceId": "<hub>", "traits": [{"path": "<p>", "needSubscribe": true}]}], "needParam": true}`.
Worth it for the metadata rather than the value: each trait answers with its unit, range, step and
enumeration, which is how the table below was read off rather than guessed.

## The state word

`8.0.2116`, also readable as trait `3.132.32922`:

```
P1_M0_T22_S1_D1
 │   │   │    │  └── D  swing
 │   │   │    └───── S  fan speed
 │   │   └────────── T  target temperature, °C
 │   └────────────── M  mode, 0 = cooling
 └────────────────── P  power, 1 = on
```

It is **read-only**. A write is accepted with `code 0, Success` and changes nothing.

## Writing

`POST /app/v1.0/lumi/app/qlink/trait/write`, and the body is flat — no `devices` wrapper, which is
what the read call uses and what makes this easy to get wrong:

```json
{"deviceId": "<hub>", "traits": [{"path": "3.141.32948", "value": "23"}]}
```

Every one of these was written, read back and restored, and the field it moves in the state word
was watched to confirm it:

| Path | Range | Sets | Moves |
|---|---|---|---|
| `3.132.32920` | 0 or 1 | **power, inverted: `0` switches it on, `1` off** | `P` |
| `3.141.32947` | 0–5 | mode; `0` is cooling | `M` |
| `3.141.32948` | 16–32 °C, step 1 | target temperature | `T` |
| `3.141.32949` | 16–32 °C, step 1 | target temperature (the two move together) | `T` |
| `3.142.32950` | 1–4 | fan speed | `S` |

Inert, whatever they are: `3.130.33012`, `3.142.32951`, `3.130.32915` all took a write and moved
nothing.

The inversion on power is worth repeating because it reads like a bug: **zero means on.**

### The state word cannot be trusted

Infrared is one way, so the hub never hears back from the air conditioner and the state word is
only what Aqara believes. It drifts: during these tests `P` fell back to `0` on its own more than
once, including while a different trait was being written.

So a plugin should treat what it last commanded as the truth, report that to HomeKit, and write
`3.132.32920` explicitly rather than inferring power from the word — the same conclusion the
SwitchBot and Sensibo plugins reached about devices that cannot be read back.

## Other endpoints

Refused with 404, so they do not exist on this API: `lumi/irdevice/query`,
`app/irdevice/query`, `app/ir/device/query`, `app/ir/list`, `app/virtual/device/query`,
`app/res/write`, `app/device/control`, `qlink/trait/set`, `qlink/trait/control`.

`res/write` exists (it answers 302/303 rather than 404) but refused every body tried.

A reply code of `302`/`303` means the path is real and the body is wrong; `404` means the path is
not there at all. That distinction is what found the write endpoint.

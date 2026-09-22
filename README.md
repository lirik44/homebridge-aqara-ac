# homebridge-aqara-ac

An infrared air conditioner behind an Aqara hub, in HomeKit as a thermostat with a working AUTO.

The hub already has the two things this needs: a remote matched to the air conditioner, and a
thermometer in the same room. What it does not have is a thermostat - Aqara's Privacy Mode is a
sleep curve on a clock, not a loop on a sensor. So the loop is here.

## What it gives you

- A **heater-cooler** accessory, which is the service Apple Home draws with a range slider.
- **AUTO**: pick a band, and the air conditioner runs while the room is above it and is switched
  off - properly off, fan and all - once the room comes down. The band says *when* it runs; a
  separate setpoint says how hard it works while it does.
- The room's temperature and humidity, read from the hub itself.
- HomeKit only. Nothing here is published over Matter.

Cooling only. The remote can heat, but AUTO with both ends live is a different design and this
room only ever cools.

## Why not Sensibo

Because the hub is already in the room, already pointed at the air conditioner, and already on
ethernet. One fewer box, one fewer cloud, one fewer wifi link to drop.

## Configuration

```json
{
  "platform": "AqaraAC",
  "email": "you@example.com",
  "password": "...",
  "region": "RU",
  "autoTargetTemperature": 22,
  "autoFanSpeed": 1,
  "deadband": 0.2,
  "refreshSeconds": 60
}
```

The region is the one the account lives in, which is not always where you are: on the wrong one
the login succeeds and the device list comes back empty.

The hub is found on its own. `hubDid` is only needed when the account has more than one hub with
an air conditioner matched to it.

## How it talks to the hub

Over Aqara's own app RPC, signed the way their app signs it - the same client the
[homebridge-aqara-matter](https://github.com/lirik44/homebridge-aqara-matter) fork uses for its
cloud login. No developer-console registration.

The awkward parts, worked out against live hardware, are written down in [PROTOCOL.md](PROTOCOL.md):
where a matched remote actually lives, which trait moves what, and why the air conditioner's own
reported state cannot be believed.

## Credit

The cloud client and its signing come from
[absent42/Aqara-LANLink](https://github.com/absent42/Aqara-LANLink) by way of
[homebridge-aqara-matter](https://github.com/lirik44/homebridge-aqara-matter). The shape of AUTO -
a band that switches the unit rather than nudging a setpoint - is taken from the Climate React work
in [homebridge-sensibo-ac](https://github.com/lirik44/homebridge-sensibo-ac).

MIT.

# AwoX SmartLIGHT BLE for Homey (beta)

A Homey app for first-generation AwoX SmartLIGHT Bluetooth bulbs, the ones controlled by the legacy AwoX Smart CONTROL app. These bulbs are not supported by AwoX's newer HomeControl app or by the official Eglo Homey app, which only covers Zigbee models. *Note: this app is mostly vibecoded within a single afternoon, please use at own risk.*

*This is an unofficial community project. It is not affiliated with or endorsed by AwoX or Eglo.*

## Status

**Beta (0.1.x).** Tested on one bulb (`SML_w13`, model `SML2-w13-E27`, firmware 1.3.5) with Homey Self-Hosted Server. Other Homey models and other first-generation white SmartLIGHT bulbs should work but are untested. Reports are welcome via GitHub issues.

## Features

- On/off, dimming and color temperature (Homey's standard light capabilities, so Flows, moods and voice work as usual)
- Multiple bulbs: each bulb is its own Homey device with its own connection
- Live state sync via BLE notifications, plus periodic polling as a safety net (interval configurable per device, 0 disables)
- Persistent connection with automatic reconnect and backoff
- Clear device status when a bulb is unreachable or its firmware stops responding

## Requirements

- A Homey with Bluetooth LE: Homey Pro (2019 or later), Homey Pro mini, or Homey Self-Hosted Server with a Bluetooth path (for example a Homey Bridge). Homey Cloud is not supported.
- Homey firmware 5.0 or later
- The bulb within Bluetooth range of Homey

## Installation

```bash
npm install --global homey
git clone <this repository>
cd nl.michadenheijer.awox
homey app install
```

Then in the Homey app: add device, AwoX SmartLIGHT BLE, AwoX SmartLIGHT (white). Start pairing from inside the room where the bulb is, so it lands in the right zone.

Close the AwoX phone app (or any other BLE client) before pairing. These bulbs accept a single connection, and a connected bulb stops advertising.

For development with live logs, use `homey app run --remote`. Note that stopping it uninstalls the app and its devices.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bulb not listed during pairing | Another client holds the connection, or out of range | Close the AwoX app, move Homey (or the Bridge) closer |
| `BLE Timeout for _servicesDiscover`, device shows "not responding" | Bulb firmware's GATT server is stuck, typically after many rapid reconnects | Switch the bulb off at the wall for 10 seconds |
| Device shows the wrong state | Missed notification | Wait for the next poll, or lower the refresh interval in device settings |

## Protocol

The bulb exposes plain GATT characteristics with no pairing, login or encryption. Each value is a single byte, written with response.

| Characteristic | Service | Meaning | Range |
|---|---|---|---|
| `217887f8-0af2-4002-9c05-24c9ecf71600` | `33160fb9-5b27-4e70-b0f8-ff411e3ae078` | Power | `00` off, `01` on |
| `d8da934c-3d8f-4bdf-9230-f61295b69570` | `fff6fe25-469d-42bc-9179-b3a093f19032` | White brightness | `00`-`73` |
| `5b430c99-cb06-4c66-be2c-b538acfd1961` | `fff6fe25-469d-42bc-9179-b3a093f19032` | White temperature | `00` cool - `7F` warm |
| `9e926da7-cffa-47f5-8d4b-7e82aff1a02a` | `33160fb9-5b27-4e70-b0f8-ff411e3ae078` | Mode | `00` white, `01` color (not used) |

All of the above support notify. Do not write to service `f000ffc0-0451-4000-b000-000000000000`: it is TI's over-the-air firmware update service.

The bulb's firmware is slow (roughly 0.5 to 1 second per write) and does not tolerate parallel GATT requests, so the driver serializes all reads and writes and only discovers the services it needs. Names set in the AwoX app are stored on the phone, not on the bulb, so they cannot be imported.

## Credits

Characteristic UUIDs were first documented by [awoxpy](https://pypi.org/project/awoxpy/) (Apache 2.0), and verified and corrected against real hardware for this app.

## License

MIT, see [LICENSE](LICENSE). AwoX and SmartLIGHT are trademarks of their respective owners.

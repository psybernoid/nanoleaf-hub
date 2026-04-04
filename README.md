⚠️ NOTICE: THIS CODE WAS PRODUCED WITH THE ASSISTANCE OF CLAUDE AI  
It is not in any way secure. Do NOT expose this to the internet as there's no authentication.  
Recommended to have this and the Nanoleaf devices on a segmented VLAN.

# Nanoleaf Hub

A self-hosted, Dockerised web application for managing Nanoleaf panel clusters. Combines a full panel layout editor (Studio) with an animation effects editor — all in a single Node.js container.

---

## Features

- **Studio** — panel layout editor with colour picker, paint/select tools, effect saving, brightness control, and per-cluster rotation memory
- **Animation Effects** — create and save animated effects using Nanoleaf's built-in plugin system, including sound-reactive effects using the panels' built-in microphone
- **Cluster Management** — add, edit, and delete multiple Nanoleaf clusters with token acquisition built in

---

## Requirements

- Docker + Docker Compose
- Nanoleaf Shapes, Canvas, or Light Panels with API access (firmware 7.1.0+)

---

## Quick Start

```bash
git clone https://github.com/psybernoid/nanoleaf-hub
cd nanoleaf-hub
docker compose up --build -d
```

Open `http://your-host:3000`.

### First-time setup

1. Click **MANAGE** → **+ ADD CLUSTER**
2. Enter a name and the IP address of your Nanoleaf device
3. Hold the power button on the controller for 5–7 seconds until the LEDs flash, then click **GET TOKEN** within 30 seconds
4. Save the cluster, select it from the dropdown, and click **CONNECT**

---

## File Structure

```
nanoleaf-hub/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js           # Express app + Nanoleaf API proxies
├── public/
│   └── index.html      # Full UI
└── data/               # Persistent data (bind-mounted)
    └── nanoleaf.db     # SQLite database (clusters table)
```

The `data/` directory is the only persistent state. Everything else is stateless and rebuildable.

---

## Docker Compose

```yaml
services:
  nanoleaf-hub:
    image: ghcr.io/psybernoid/nanoleaf-hub:latest
    container_name: nanoleaf-hub
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    environment:
      - PORT=3000
      - DATA_DIR=/data
```

No credentials are needed in `docker-compose.yml` — all configuration is done through the UI and stored in the database.

---

## Nanoleaf API Token

To get a token for a new cluster:

1. Hold the power button on the Nanoleaf controller for **5–7 seconds** until the LEDs flash
2. In the Add Cluster modal, enter the IP address and click **GET TOKEN** within 30 seconds
3. The token is automatically filled in — save the cluster

Alternatively, using curl:
```bash
curl -X POST http://<nanoleaf-ip>:16021/api/v1/new
# Returns: {"auth_token":"<your-token>"}
```

---

## Studio

The Studio is a full panel layout editor:

- **Connect** — select a cluster and click CONNECT to load its panel layout
- **Paint tool** — click a panel to paint it with the current colour and push immediately to the device
- **Select tool** — click or shift-click to multi-select, then use APPLY COLOUR or PUSH TO DEVICE
- **Push to Device** — sends the full current colour layout to the panels as a static effect
- **Save as Effect** — saves the current layout as a named effect on the device (appears in the effects list)
- **Device Effects list** — click any saved effect to activate it; hover to reveal the delete button
- **Rotation** — rotate the canvas view to match your physical panel orientation; remembered per cluster across sessions
- **Brightness** and **Power** controls take effect immediately on the device
- **ID button** — flashes all panels to help identify which cluster you're connected to
- **Pan/Zoom** — alt+drag (or middle-mouse drag) to pan; scroll wheel to zoom

---

## Animation Effects

The Animation Effects section lets you create animated and sound-reactive effects using Nanoleaf's built-in plugin system. Effects are saved directly to the device and appear in the Device Effects list.

### How it works

Nanoleaf panels run effect plugins natively in firmware. Rather than streaming colour data from the Hub, you configure a plugin (choosing colours, speed, direction etc.) and push the configuration to the device. The panels then run the effect independently — no ongoing connection needed.

There are two plugin types:

- **Colour animations** — the device cycles through your palette autonomously
- **Rhythm (microphone)** — the panels react to ambient sound using their built-in microphone

### Built-in microphone

Nanoleaf Shapes (and some other models) have a microphone built into the controller. This is used exclusively by the Rhythm plugin type. It picks up ambient sound in the room — it is not connected to any audio output or stream. Ensure the rhythm module is enabled in the Nanoleaf app under device settings before using rhythm effects.

### Colour animation plugins

| Plugin | Description |
|--------|-------------|
| **Flow** | Colours flow across panels in a chosen direction |
| **Wheel** | Colours spin around the layout like a colour wheel |
| **Fade** | All panels fade smoothly between palette colours |
| **Random** | Panels randomly change to palette colours independently |
| **Highlight** | Spotlight effect — one panel highlighted against the others |

**Shared options (all colour plugins):**

| Option | Description |
|--------|-------------|
| Transition Time | How quickly each colour transition completes (1–600, in tenths of a second) |
| Delay Time | Pause between transitions (0 = continuous) |

**Flow-specific options:**

| Option | Description |
|--------|-------------|
| Direction | Which way colours flow: left, right, up, down |
| Colours per Frame | How many palette colours are visible simultaneously |

### Rhythm (microphone) plugins

| Plugin | Description |
|--------|-------------|
| **Beat Drop** | Panels pulse and flash on beats |
| **Energy** | Brightness and colour intensity follow audio energy |
| **Meteor Shower** | Colour streaks travel across panels to the rhythm |
| **Flames** | Flame-like animation driven by audio intensity |
| **Equalizer** | Panels act as frequency bands of a spectrum analyser |

All rhythm plugins share a **Sensitivity** slider that controls how aggressively the effect responds to audio.

### Palette

Each effect uses a palette of 1–10 colours. Click **+ ADD COLOUR** to pick a colour and add it. Click any colour swatch to remove it. The palette determines which colours the effect cycles through — more contrast between colours generally produces more dynamic results.

### Preview and Save

- **PREVIEW** — pushes the effect to the device immediately without saving. Useful for auditioning palette and parameter combinations live.
- **SAVE** — prompts for a name and saves the effect permanently to the device. It then appears in the Device Effects list and can be activated at any time, even when the Hub is not running.

---

## VLAN / Network Notes

If your Nanoleaf devices are on a separate IoT VLAN (recommended), the Docker host must be able to reach TCP port `16021` on each Nanoleaf IP. The Hub communicates only via the Nanoleaf HTTP API — no UDP or multicast is required for Studio or Animation features.

mDNS discovery is not used; IP addresses are entered manually.

---

## Troubleshooting

**Panels not appearing after CONNECT**  
Verify the IP address is reachable from the Docker host. If on a separate VLAN, ensure your firewall allows TCP 16021 from the Hub's host to the Nanoleaf IP. Try the ID button — if the panels flash, the connection is working but the layout may have failed to load; click RELOAD.

**Canvas is black after connecting**  
Click the **FIT** button in the toolbar. If panels still don't appear, click **RELOAD** to re-fetch the layout from the device.

**GET TOKEN not working**  
You have a 30-second window after holding the power button. If the window expires, hold the button again and retry immediately. The LEDs should flash white briefly to confirm pairing mode is active.

**Animation preview plays but sound doesn't react**  
Rhythm effects require the rhythm module to be enabled in the official Nanoleaf app (device settings → rhythm). The built-in microphone picks up ambient room sound — it is not connected to any audio stream.

**Effect not saving**  
Effect names must be unique on the device. Saving with an existing name will overwrite it silently. Names are limited to 32 characters.

**Animation effect not showing correct colours**  
The palette is converted from hex to HSB internally. Very dark colours (low brightness) may appear similar to black on the panels — use bright, saturated colours for best results.

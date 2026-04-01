⚠️ NOTICE: THIS CODE WAS PRODUCED WITH THE ASSISTANCE OF CLAUDE AI  
It is not in anyway secure. Do NOT expose this to the internet as there's no authentication.  
Recommended to have this and the Nanoleaf devices on a segmented VLAN

# Nanoleaf Hub

A self-hosted, Dockerised web application for managing and visualising Nanoleaf panel clusters. Combines a panel layout editor (Studio), a real-time audio visualiser driven by Music Assistant, and cluster management — all in one container.

---

## Features

- **Dashboard** — live view of all clusters, now-playing metadata, per-cluster visualiser toggle
- **Visualiser** — real-time audio reactive lighting driven by Music Assistant's Sendspin protocol; each cluster appears as its own player in MA
- **Studio** — panel layout editor with colour picker, effect saving, brightness control, and per-cluster rotation memory
- **Settings** — Music Assistant connection config and global visualiser settings; all stored in SQLite, no environment variables required after first setup

---

## Requirements

- Docker + Docker Compose
- Music Assistant 2.7+ (standalone Docker or HA add-on)
- Nanoleaf Shapes/Canvas/Light Panels with API access (firmware 7.1.0+)

---

## Quick Start

```bash
git clone https://github.com/psybernoid/nanoleaf-hub
cd nanoleaf-hub
docker compose up --build -d
```

Open `http://your-host:3000`.

### First-time setup

1. **Settings tab** → enter your Music Assistant host/IP, port (`8095`), and a long-lived access token
   - Create the token in the MA web UI → Profile → Long Lived Access Tokens
2. **Dashboard → Manage Clusters** → Add your first Nanoleaf cluster
3. The visualiser starts automatically — the green dot on the Visualiser tab confirms it's running
4. In Music Assistant, play something to the cluster's player (named whatever you set as Player Name)

---

## File Structure

```
nanoleaf-hub/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js           # Express app + Python process manager
├── visualiser.py       # Multi-cluster MA Sendspin → FFT → UDP engine
├── public/
│   └── index.html      # Full UI (Dashboard, Visualiser, Studio, Settings)
└── data/               # Persistent data (bind-mounted)
    ├── nanoleaf.db     # SQLite database
    └── viz_status.json # IPC between visualiser and web server
```

The `data/` directory is the only persistent state. Everything else is stateless and rebuildable.

---

## Docker Compose

```yaml
services:
  nanoleaf-hub:
    build: .
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


The Hub will automatically add the new columns (`player_name`, `viz_enabled`, `smoothing`, `freq_min`, `freq_max`) to your existing clusters table without losing any data.

---

## How the Visualiser Works

```
Music Assistant (Sendspin WebSocket)
        │
        │  PCM audio chunks (44100Hz, 16-bit stereo)
        ▼
  visualiser.py
        │  FFT per chunk → per-panel frequency levels
        │  Each panel owns a centre frequency (log-linear across spectrum)
        │  Colour = frequency position (red→green→cyan→blue→violet)
        │  Brightness = energy in ±0.4 octave window around centre freq
        ▼
  UDP extControl v2 → Nanoleaf panels (~30fps)
```

Each cluster connects to MA as a separate Sendspin player. MA routes audio independently to each — you can play different sources to different clusters simultaneously.

### Per-cluster settings

| Setting | Default | Description |
|---|---|---|
| Player Name | Same as cluster name | How it appears in Music Assistant |
| Visualiser enabled | On | Toggle per cluster without removing it |
| Smoothing | 0.15 | 0.05 = very reactive, 0.8 = very smooth |
| Freq min | 40 Hz | Lower bound of spectrum mapped across panels |
| Freq max | 16000 Hz | Upper bound — radio streams rarely exceed this usefully |

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

## Music Assistant Setup

The visualiser uses MA's Sendspin protocol (MA 2.7+). Each cluster registers as a Sendspin player with:

- **Manufacturer:** Nanoleaf  
- **Model:** Nanoleaf Hub

To play audio to a cluster, select it as the player in MA just like any other speaker. The visualiser receives the audio stream, performs FFT analysis, and drives the panels — it does not output audio (volume is muted at the protocol level).

> **Note:** The Sendspin visualiser role (which would allow MA to push pre-computed frequency data) is not yet fully implemented in MA 2.8. The Hub works around this by registering as a player and doing its own FFT analysis on the received PCM stream.

---

## Studio

The Studio tab is a full panel layout editor:

- **Connect** to any configured cluster to load its panel layout
- **Paint tool** — click a panel to paint it with the current colour immediately
- **Select tool** — click or shift-click to multi-select, then apply colour or push to device
- **Push to Device** — sends the current colour layout to the panels as a static effect
- **Save as Effect** — saves the layout as a named effect on the device, visible in the effects list
- **Rotation** — rotate the canvas view; remembered per cluster across browser sessions
- **Brightness** and **Power** controls affect the device immediately

---

## Troubleshooting

**Visualiser not starting**  
Check Settings → confirm MA host, port, and token are saved. The Visualiser tab shows the error reason if config is missing.

**Player not appearing in MA**  
The player registers when the visualiser connects. If it doesn't appear within ~10 seconds of the visualiser running, check MA logs for Sendspin connection errors. Ensure MA can reach the Hub's host on port 8095.

**Only some panels lighting up**  
High-frequency panels (violet end of spectrum) are naturally quieter, especially with radio streams. Adjust Freq Max downward on the Visualiser tab to compress the spectrum into the audible content range of your source.

**Panels not responding at all**  
Ensure the Nanoleaf device is reachable from the Docker container. If using VLANs, the container needs UDP access to port 60222 on the Nanoleaf IP. The Hub enables extControl mode automatically when the visualiser starts.

**Stream switching glitch (radio → local file)**  
This is handled by tracking `stream/start` and `stream/end` messages separately from MA's playback state. If you notice a delay, the visualiser restarts the stream cleanly on the next `stream/start`.

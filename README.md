⚠️ NOTICE: THIS CODE WAS PRODUCED WITH THE ASSISTANCE OF CLAUDE AI  
It is not in anyway secure. Do NOT expose this to the internet as there's no authentication.  
Recommended to have this and the Nanoleaf devices on a segmented VLAN

# Nanoleaf Hub

A self-hosted, Dockerised web application for managing and visualising Nanoleaf panel clusters.

---

## Features

- **Studio** — panel layout editor with colour picker, effect saving, brightness control, and per-cluster rotation memory

---

## Requirements

- Docker + Docker Compose
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

1. **Dashboard → Manage Clusters** → Add your first Nanoleaf cluster

---

## File Structure

```
nanoleaf-hub/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js           # Express app + Python process manager
├── public/
│   └── index.html      # Full UI (Dashboard, Visualiser, Studio, Settings)
└── data/               # Persistent data (bind-mounted)
    ├── nanoleaf.db     # SQLite database
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

**Only some panels lighting up**  
High-frequency panels (violet end of spectrum) are naturally quieter, especially with radio streams. Adjust Freq Max downward on the Visualiser tab to compress the spectrum into the audible content range of your source.

**Panels not responding at all**  
Ensure the Nanoleaf device is reachable from the Docker container. If using VLANs, the container needs UDP access to port 60222 on the Nanoleaf IP. The Hub enables extControl mode automatically when the visualiser starts.

**Stream switching glitch (radio → local file)**  
This is handled by tracking `stream/start` and `stream/end` messages separately from MA's playback state. If you notice a delay, the visualiser restarts the stream cleanly on the next `stream/start`.

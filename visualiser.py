"""
Nanoleaf Multi-Cluster Visualiser
Receives PCM audio from Music Assistant via Sendspin.
Drives multiple Nanoleaf clusters simultaneously via UDP extControl.
Config is passed via environment variables from server.js.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import struct
import time
from collections import deque
from dataclasses import dataclass

import aiohttp
import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    force=True,
)
log = logging.getLogger("nanoleaf-viz")

# ── Config from env ────────────────────────────────────────────────────────────
MA_HOST      = os.environ.get("MA_HOST", "")
MA_PORT      = int(os.environ.get("MA_PORT", "8095"))
MA_TOKEN     = os.environ.get("MA_TOKEN", "")
VIZ_FPS      = int(os.environ.get("VIZ_FPS", "30"))
STATUS_FILE  = os.environ.get("STATUS_FILE", "/data/viz_status.json")
CLUSTERS_JSON = os.environ.get("CLUSTERS_JSON", "[]")

FRAME_PERIOD = 1.0 / VIZ_FPS
SAMPLE_RATE  = 44100
HEADER_SIZE  = 9
FREQ_MIN     = 40
FREQ_MAX     = 16000

# ── Cluster config ─────────────────────────────────────────────────────────────
@dataclass
class ClusterConfig:
    id: int
    name: str
    player_name: str
    ip: str
    token: str
    smoothing: float
    freq_min: int
    freq_max: int

def load_clusters() -> list[ClusterConfig]:
    try:
        raw = json.loads(CLUSTERS_JSON)
        return [ClusterConfig(
            id=c["id"],
            name=c["name"],
            player_name=c.get("player_name") or c["name"],
            ip=c["ip"],
            token=c["token"],
            smoothing=float(c.get("smoothing", 0.15)),
            freq_min=int(c.get("freq_min", 40)),
            freq_max=int(c.get("freq_max", 16000)),
        ) for c in raw]
    except Exception as e:
        log.error("Failed to parse CLUSTERS_JSON: %s", e)
        return []

# ── Status file ────────────────────────────────────────────────────────────────
_status: dict = {}

def write_status(data: dict) -> None:
    global _status
    _status.update(data)
    _status["ts"] = int(time.time() * 1000)
    try:
        with open(STATUS_FILE, "w") as f:
            json.dump(_status, f)
    except Exception:
        pass

# ── Nanoleaf helpers ───────────────────────────────────────────────────────────
async def nanoleaf_put(session: aiohttp.ClientSession, ip: str, token: str, path: str, body: dict) -> None:
    url = f"http://{ip}:16021/api/v1/{token}/{path}"
    try:
        async with session.put(url, json=body) as r:
            if r.status not in (200, 204):
                log.warning("Nanoleaf PUT %s -> %s", path, r.status)
    except Exception as e:
        log.warning("Nanoleaf PUT failed %s: %s", ip, e)

async def nanoleaf_get(session: aiohttp.ClientSession, ip: str, token: str, path: str) -> dict:
    url = f"http://{ip}:16021/api/v1/{token}/{path}"
    try:
        async with session.get(url) as r:
            return await r.json()
    except Exception as e:
        log.warning("Nanoleaf GET failed %s: %s", ip, e)
        return {}

async def get_panel_ids(session: aiohttp.ClientSession, ip: str, token: str) -> list[int]:
    info = await nanoleaf_get(session, ip, token, "panelLayout/layout")
    panels = info.get("positionData", [])
    ids = [p["panelId"] for p in panels if p["panelId"] != 0 and p.get("shapeType") != 12]
    log.info("[%s] Found %d panels: %s", ip, len(ids), ids)
    return ids

async def enable_extcontrol(session: aiohttp.ClientSession, ip: str, token: str) -> tuple[str, int]:
    body = {"write": {"command": "display", "animType": "extControl", "extControlVersion": "v2"}}
    await nanoleaf_put(session, ip, token, "effects", body)
    return ip, 60222

# ── Spectrum / colour ──────────────────────────────────────────────────────────
def freq_to_colour(freq_hz: float, f_min: float, f_max: float) -> tuple[int, int, int]:
    t = np.log(max(freq_hz, f_min) / f_min) / np.log(f_max / f_min)
    t = float(np.clip(t, 0.0, 1.0))
    hue = t * 0.85
    h6 = hue * 6.0
    i = int(h6) % 6
    f = h6 - int(h6)
    if i == 0:   r, g, b = 1.0,   f, 0.0
    elif i == 1: r, g, b = 1-f, 1.0, 0.0
    elif i == 2: r, g, b = 0.0, 1.0,   f
    elif i == 3: r, g, b = 0.0, 1-f, 1.0
    elif i == 4: r, g, b =   f, 0.0, 1.0
    else:        r, g, b = 1.0, 0.0, 1-f
    return (int(r * 255), int(g * 255), int(b * 255))

def build_panel_freq_map(panel_ids: list[int], f_min: int, f_max: int):
    n = len(panel_ids)
    mapping = []
    for i, pid in enumerate(panel_ids):
        t = i / max(n - 1, 1)
        freq = f_min * (f_max / f_min) ** t
        colour = freq_to_colour(freq, f_min, f_max)
        mapping.append((pid, freq, colour))
    return mapping

def pcm_to_float(data: bytes) -> np.ndarray:
    samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    return (samples[0::2] + samples[1::2]) / 2.0

def compute_panel_levels(mono: np.ndarray, panel_freq_map, sample_rate: int, n_fft: int = 2048) -> dict[int, float]:
    if len(mono) < n_fft:
        mono = np.pad(mono, (0, n_fft - len(mono)))
    windowed = mono[:n_fft] * np.hanning(n_fft)
    spectrum  = np.abs(np.fft.rfft(windowed))
    freqs     = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    overall_rms = float(np.sqrt(np.mean(spectrum ** 2))) or 1e-6

    result = {}
    for pid, centre_freq, _ in panel_freq_map:
        lo = centre_freq * (2 ** -0.4)
        hi = centre_freq * (2 **  0.4)
        mask = (freqs >= lo) & (freqs < hi)
        band_rms = float(np.sqrt(np.mean(spectrum[mask] ** 2))) if mask.any() else 0.0
        level = band_rms / (overall_rms * 2.0)
        f_min_map = panel_freq_map[0][1]
        f_max_map = panel_freq_map[-1][1]
        freq_t = np.log(centre_freq / f_min_map) / np.log(f_max_map / f_min_map) if f_max_map > f_min_map else 0
        boost = 1.0 + float(freq_t) * 2.5
        result[pid] = float(np.clip(level * boost, 0.0, 1.0))
    return result

def build_udp_frame(panel_colours: dict[int, tuple[int, int, int]]) -> bytes:
    frame = struct.pack(">H", len(panel_colours))
    for panel_id, (r, g, b) in panel_colours.items():
        frame += struct.pack(">HBBBBH", panel_id, r, g, b, 0, 1)
    return frame

def panel_levels_to_colours(panel_freq_map, levels: dict[int, float], overall: float, peak: float) -> dict[int, tuple[int, int, int]]:
    result = {}
    for pid, _freq, (r, g, b) in panel_freq_map:
        level = levels.get(pid, 0.0)
        brightness = max(level, overall * 0.25)
        brightness = max(brightness, 0.04 if peak > 0.05 else 0.0)
        result[pid] = (int(r * brightness), int(g * brightness), int(b * brightness))
    return result

# ── Per-cluster state ──────────────────────────────────────────────────────────
class ClusterState:
    def __init__(self, cfg: ClusterConfig, panel_ids: list[int], udp_host: str, udp_port: int):
        self.cfg = cfg
        self.panel_freq_map = build_panel_freq_map(panel_ids, cfg.freq_min, cfg.freq_max)
        self.smooth_levels: dict[int, float] = {pid: 0.0 for pid, _, _ in self.panel_freq_map}
        self.udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp_addr = (udp_host, udp_port)
        log.info("[%s] Ready with %d panels", cfg.name, len(panel_ids))

    def send_frame(self, pcm_data: bytes | None, stream_active: bool, sample_rate: int) -> None:
        if not stream_active or pcm_data is None or len(pcm_data) < 4:
            for pid in self.smooth_levels:
                self.smooth_levels[pid] *= 0.85
            peak = max(self.smooth_levels.values(), default=0)
            if peak < 0.005:
                return
            overall = sum(self.smooth_levels.values()) / max(len(self.smooth_levels), 1)
            colours = panel_levels_to_colours(self.panel_freq_map, self.smooth_levels, overall, peak)
        else:
            mono = pcm_to_float(pcm_data)
            if len(mono) == 0:
                return
            n_fft = min(2048, len(mono))
            levels = compute_panel_levels(mono, self.panel_freq_map, sample_rate, n_fft)
            overall = sum(levels.values()) / max(len(levels), 1)
            peak = max(levels.values(), default=0)
            for pid in self.smooth_levels:
                self.smooth_levels[pid] = (
                    self.smooth_levels[pid] * self.cfg.smoothing
                    + levels.get(pid, 0.0) * (1 - self.cfg.smoothing)
                )
            smooth_overall = sum(self.smooth_levels.values()) / max(len(self.smooth_levels), 1)
            smooth_peak = max(self.smooth_levels.values(), default=0)
            colours = panel_levels_to_colours(self.panel_freq_map, self.smooth_levels, smooth_overall, smooth_peak)

        frame = build_udp_frame(colours)
        try:
            self.udp_sock.sendto(frame, self.udp_addr)
        except Exception:
            pass

# ── MA Sendspin connection per cluster ────────────────────────────────────────
def make_client_hello(cfg: ClusterConfig) -> dict:
    client_id = f"nanoleaf-viz-cluster-{cfg.id}"
    return {
        "type": "client/hello",
        "payload": {
            "client_id": client_id,
            "name": cfg.player_name,
            "version": 1,
            "device_info": {
                "manufacturer": "Nanoleaf",
                "product_name": "Nanoleaf Hub",
                "software_version": "2.0.0",
            },
            "supported_roles": ["player@v1", "metadata@v1"],
            "player@v1_support": {
                "buffer_capacity": 200,
                "supported_formats": [
                    {"codec": "pcm", "channels": 2, "sample_rate": 44100, "bit_depth": 16},
                    {"codec": "pcm", "channels": 2, "sample_rate": 48000, "bit_depth": 16},
                ],
                "supported_commands": [],
            },
        }
    }

PLAYER_STATE = {
    "type": "client/state",
    "payload": {
        "state": "synchronized",
        "player": {"volume": 0, "muted": True}
    }
}

async def run_cluster(session: aiohttp.ClientSession, cfg: ClusterConfig, cluster_state: ClusterState) -> None:
    """Connect one cluster to MA Sendspin and drive its panels."""
    url = f"ws://{MA_HOST}:{MA_PORT}/sendspin"

    while True:
        try:
            log.info("[%s] Connecting to MA...", cfg.name)
            ws = await session.ws_connect(url)

            await ws.send_str(json.dumps({
                "type": "auth",
                "token": MA_TOKEN,
                "client_id": f"nanoleaf-viz-cluster-{cfg.id}"
            }))
            msg = await asyncio.wait_for(ws.receive(), timeout=5.0)
            if json.loads(msg.data).get("type") != "auth_ok":
                raise RuntimeError("Auth failed")

            await ws.send_str(json.dumps(make_client_hello(cfg)))
            log.info("[%s] Connected to MA", cfg.name)

            pcm_buffer: deque[bytes] = deque()
            stream_active = False
            sample_rate = SAMPLE_RATE
            last_frame = 0.0

            async def frame_loop():
                nonlocal last_frame
                while True:
                    await asyncio.sleep(FRAME_PERIOD)
                    now = time.monotonic()
                    if now - last_frame < FRAME_PERIOD * 0.8:
                        continue
                    last_frame = now
                    try:
                        if stream_active and pcm_buffer:
                            raw = b"".join(pcm_buffer)
                            pcm_buffer.clear()
                            cluster_state.send_frame(raw, True, sample_rate)
                        else:
                            cluster_state.send_frame(None, False, sample_rate)
                    except Exception as e:
                        log.warning("[%s] Frame error: %s", cfg.name, e)

            frame_task = asyncio.create_task(frame_loop())

            try:
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        t = data.get("type")

                        if t == "server/hello":
                            await ws.send_str(json.dumps(PLAYER_STATE))

                        elif t == "stream/start":
                            fmt = data["payload"].get("player", {})
                            sample_rate = fmt.get("sample_rate", SAMPLE_RATE)
                            pcm_buffer.clear()
                            stream_active = True
                            log.info("[%s] Stream started: %s", cfg.name, fmt)

                        elif t == "stream/end":
                            stream_active = False
                            pcm_buffer.clear()
                            log.info("[%s] Stream ended", cfg.name)

                        elif t == "server/state":
                            meta = data["payload"].get("metadata", {})
                            if meta.get("title"):
                                log.info("[%s] Now playing: %s – %s", cfg.name, meta.get("artist"), meta.get("title"))
                                write_status({
                                    "now_playing": {
                                        "title": meta.get("title"),
                                        "artist": meta.get("artist"),
                                        "cluster": cfg.name,
                                    }
                                })

                    elif msg.type == aiohttp.WSMsgType.BINARY:
                        if stream_active and len(msg.data) > HEADER_SIZE:
                            pcm_buffer.append(msg.data[HEADER_SIZE:])

                    elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING):
                        break
            finally:
                frame_task.cancel()
                try: await frame_task
                except asyncio.CancelledError: pass

        except Exception as e:
            log.warning("[%s] Connection error: %s — retrying in 5s", cfg.name, e)

        await asyncio.sleep(5)

# ── Main ───────────────────────────────────────────────────────────────────────
async def run() -> None:
    clusters = load_clusters()
    if not clusters:
        log.error("No clusters configured — exiting")
        write_status({"running": False, "error": "No enabled clusters"})
        return

    if not MA_HOST or not MA_TOKEN:
        log.error("MA_HOST / MA_TOKEN not set — exiting")
        write_status({"running": False, "error": "MA not configured"})
        return

    write_status({
        "running": True,
        "clusters": [{"id": c.id, "name": c.name, "player_name": c.player_name} for c in clusters],
        "now_playing": None,
    })

    async with aiohttp.ClientSession() as session:
        # Initialise all clusters (get panel IDs, enable extControl)
        cluster_states: list[tuple[ClusterConfig, ClusterState]] = []
        for cfg in clusters:
            try:
                panel_ids = await get_panel_ids(session, cfg.ip, cfg.token)
                if not panel_ids:
                    log.warning("[%s] No panels found — skipping", cfg.name)
                    continue
                udp_host, udp_port = await enable_extcontrol(session, cfg.ip, cfg.token)
                state = ClusterState(cfg, panel_ids, udp_host, udp_port)
                cluster_states.append((cfg, state))
            except Exception as e:
                log.error("[%s] Init failed: %s — skipping", cfg.name, e)

        if not cluster_states:
            log.error("No clusters initialised — exiting")
            write_status({"running": False, "error": "All cluster connections failed"})
            return

        # Run all clusters concurrently
        await asyncio.gather(*[
            run_cluster(session, cfg, state)
            for cfg, state in cluster_states
        ])

if __name__ == "__main__":
    asyncio.run(run())

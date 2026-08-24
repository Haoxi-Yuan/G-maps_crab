"""Render photometa facade planes over Google and OSM map layers.

The important detail is that facade points are recomputed from the raw
photometa payload with the current local->ENU rotation. Do not use the cached
``merged_pointcloud.npz`` in temporal capture folders for this diagnostic: some
older caches were written in pano-local coordinates and will be rotated by the
capture heading when overlaid on an ENU map.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "raw"))
import build_rgb_pointcloud as br  # noqa: E402


TEST_ROOT = Path(__file__).resolve().parents[3]
CAPTURE_DIR = (
    TEST_ROOT
    / "data/raw/google_maps/temporal/JqSnKB7Pp-XymzXWDuP71w/"
    / "2026-05-03_14-13-28-097/captures/"
    / "2025-03-01_JqSnKB7Pp-XymzXWDuP71w"
)
GOOGLE_TILE_DIR = TEST_ROOT / "data/raw/google_tiles"
OSM_PATH = TEST_ROOT / "data/raw/osm/ghim_moh_overpass_200m.json"
OUT_DIR = TEST_ROOT / "docs/images"

MIN_FACADE_COMPONENT_CELLS = 30
RADIUS_M = 130.0
EARTH_R = 6378137.0


def wrap_line_angle_deg(angle: float) -> float:
    while angle <= -90.0:
        angle += 180.0
    while angle > 90.0:
        angle -= 180.0
    return angle


def load_focal_points():
    parsed = json.loads((CAPTURE_DIR / "parsed.json").read_text())
    planes, idx_map, panoid, lat, lng, pose = br.parse_photometa_geometry(parsed)
    image = Image.open(CAPTURE_DIR / "panoramas" / f"{panoid}.jpg").convert("RGB")
    rotation = br.build_rotation(pose["heading_deg"], pose["pitch_deg"], pose["roll_deg"])
    x, y, z, _rgb, plane, cls, _b2, _cap = br.build_pano_points(
        panoid,
        planes,
        idx_map,
        image,
        0.0,
        0.0,
        0.0,
        rotation,
        hard_max_dist=200.0,
        b2_grid=None,
    )
    H, W = idx_map.shape
    uu, vv = np.meshgrid(np.arange(W), np.arange(H))
    theta = (uu + 0.5) / W * 2 * np.pi - np.pi
    phi = np.pi / 2 - (vv + 0.5) / H * np.pi
    dx = np.sin(theta) * np.cos(phi)
    dy = np.cos(theta) * np.cos(phi)
    dz = np.sin(phi)
    nx = planes[idx_map][:, :, 0]
    ny = planes[idx_map][:, :, 1]
    nz = planes[idx_map][:, :, 2]
    pd = planes[idx_map][:, :, 3]
    n_dot = nx * dx + ny * dy + nz * dz
    with np.errstate(divide="ignore", invalid="ignore"):
        t = pd / n_dot
    plane_norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    plane_anchored = (plane_norm > 1e-6) & np.isfinite(t) & (t > 0)
    if plane_anchored.sum() > 100:
        adaptive_cap = float(np.percentile(t[plane_anchored], 99.9))
    else:
        adaptive_cap = 200.0
    valid = plane_anchored & (t < min(adaptive_cap, 200.0))
    return {
        "panoid": panoid,
        "lat": float(lat),
        "lng": float(lng),
        "pose": pose,
        "rotation": rotation,
        "x": x,
        "y": y,
        "z": z,
        "plane": plane,
        "cls": cls,
        "idx_map": idx_map,
        "row": vv[valid].astype(np.int32),
        "col": uu[valid].astype(np.int32),
    }


def connected_components(mask: np.ndarray) -> list[np.ndarray]:
    H, W = mask.shape
    seen = np.zeros(mask.shape, dtype=bool)
    comps: list[list[tuple[int, int]]] = []
    for i in range(H):
        for j in range(W):
            if not mask[i, j] or seen[i, j]:
                continue
            stack = [(i, j)]
            seen[i, j] = True
            comp: list[tuple[int, int]] = []
            while stack:
                r, c = stack.pop()
                comp.append((r, c))
                for dr in (-1, 0, 1):
                    for dc in (-1, 0, 1):
                        if dr == 0 and dc == 0:
                            continue
                        rr = r + dr
                        cc = (c + dc) % W
                        if 0 <= rr < H and mask[rr, cc] and not seen[rr, cc]:
                            seen[rr, cc] = True
                            stack.append((rr, cc))
            comps.append(comp)
    return [np.array(c, dtype=np.int32) for c in sorted(comps, key=len, reverse=True)]


def facade_segments(points: dict) -> list[dict]:
    x = points["x"]
    y = points["y"]
    plane = points["plane"]
    cls = points["cls"]
    idx_map = points["idx_map"]
    rows = points["row"]
    cols = points["col"]
    facade_ids, counts = np.unique(plane[cls == br.CLASS_INDEX["facade"]], return_counts=True)
    count_by_id = dict(zip(facade_ids.tolist(), counts.tolist()))

    colors = plt.cm.tab20(np.linspace(0, 1, 20))
    out: list[dict] = []
    for pid in sorted(facade_ids.tolist(), key=lambda k: count_by_id[k], reverse=True):
        for comp_idx, comp in enumerate(connected_components(idx_map == pid)):
            if comp.shape[0] < MIN_FACADE_COMPONENT_CELLS:
                continue
            comp_lookup = np.zeros(idx_map.shape, dtype=bool)
            comp_lookup[comp[:, 0], comp[:, 1]] = True
            mask = (plane == pid) & (cls == br.CLASS_INDEX["facade"]) & comp_lookup[rows, cols]
            n = int(mask.sum())
            if n < MIN_FACADE_COMPONENT_CELLS:
                continue
            xy = np.column_stack([x[mask], y[mask]]).astype(float)
            xy = xy[np.isfinite(xy).all(axis=1)]
            if xy.shape[0] < MIN_FACADE_COMPONENT_CELLS:
                continue
            centre = xy.mean(axis=0)
            cov = np.cov((xy - centre).T)
            vals, vecs = np.linalg.eigh(cov)
            direction = vecs[:, int(np.argmax(vals))]
            proj = (xy - centre) @ direction
            lo, hi = np.percentile(proj, [5, 95])
            a = centre + lo * direction
            b = centre + hi * direction
            angle = wrap_line_angle_deg(math.degrees(math.atan2(direction[1], direction[0])))
            out.append(
                {
                    "pid": int(pid),
                    "component": int(comp_idx),
                    "n": n,
                    "a": a,
                    "b": b,
                    "mid": (a + b) / 2.0,
                    "angle": angle,
                    "color": colors[len(out) % len(colors)],
                }
            )
    return out


def google_extent_enu(tile_kind: str, lat0: float, lng0: float):
    bbox = json.loads((GOOGLE_TILE_DIR / "bbox.json").read_text())
    lat_n, lng_w, lat_s, lng_e = bbox[f"{tile_kind}_bbox"]

    def enu(lat: float, lng: float) -> tuple[float, float]:
        east = math.radians(lng - lng0) * EARTH_R * math.cos(math.radians(lat0))
        north = math.radians(lat - lat0) * EARTH_R
        return east, north

    west, north = enu(lat_n, lng_w)
    east, south = enu(lat_s, lng_e)
    return [west, east, south, north]


def draw_rings(ax, color="white"):
    for radius in [25, 50, 100]:
        ax.add_patch(plt.Circle((0, 0), radius, fill=False, lw=0.8, ls=":", color=color, alpha=0.75))
        ax.text(
            0,
            radius,
            f"{radius} m",
            color=color,
            fontsize=8,
            ha="center",
            va="bottom",
            path_effects=[pe.withStroke(linewidth=2, foreground="black", alpha=0.45)],
        )


def draw_plane_segments(ax, segments: list[dict], transform=lambda p: p):
    for seg in segments:
        a = transform(seg["a"])
        b = transform(seg["b"])
        ax.plot(
            [a[0], b[0]],
            [a[1], b[1]],
            color=seg["color"],
            lw=3.4,
            solid_capstyle="round",
            path_effects=[pe.withStroke(linewidth=6, foreground="white", alpha=0.8)],
        )


def segment_label(seg: dict) -> str:
    return f"#{seg['pid']}" if seg.get("component", 0) == 0 else f"#{seg['pid']}.{seg['component']}"


def spread_label_y(values: list[float], low: float, high: float, min_sep: float = 5.0) -> list[float]:
    if not values:
        return []
    order = np.argsort(values)[::-1]
    ys = np.clip(np.array(values, dtype=float)[order], low, high)
    for i in range(1, len(ys)):
        ys[i] = min(ys[i], ys[i - 1] - min_sep)
    if ys[-1] < low:
        ys += low - ys[-1]
    if ys[0] > high:
        ys -= ys[0] - high
    out = np.empty_like(ys)
    out[order] = ys
    return out.tolist()


def draw_branch_labels(ax, segments: list[dict], transform=lambda p: p):
    xlim = ax.get_xlim()
    ylim = ax.get_ylim()
    width = xlim[1] - xlim[0]
    height = ylim[1] - ylim[0]

    items = []
    for seg in segments:
        mid = transform(seg["mid"])
        items.append({**seg, "mid_t": mid, "label": segment_label(seg)})

    groups: dict[tuple[str, str], list[dict]] = {}
    for item in items:
        x, y = item["mid_t"]
        side = "left" if x < (xlim[0] + xlim[1]) / 2 else "right"
        if y > ylim[0] + height * 0.66:
            band = "top"
        elif y < ylim[0] + height * 0.34:
            band = "bottom"
        else:
            band = "middle"
        groups.setdefault((side, band), []).append(item)

    band_ranges = {
        "top": (ylim[1] - height * 0.28, ylim[1] - height * 0.06),
        "middle": (ylim[0] + height * 0.42, ylim[0] + height * 0.60),
        "bottom": (ylim[0] + height * 0.07, ylim[0] + height * 0.30),
    }

    for (side, band), group in groups.items():
        group.sort(key=lambda g: (-g["mid_t"][1], g["mid_t"][0]))
        sign = -1 if side == "left" else 1
        label_x = xlim[0] + width * 0.045 if side == "left" else xlim[1] - width * 0.045
        spine_x = xlim[0] + width * 0.16 if side == "left" else xlim[1] - width * 0.16
        low, high = band_ranges[band]
        desired = [float(g["mid_t"][1]) for g in group]
        label_ys = spread_label_y(desired, low, high, min_sep=max(4.3, height * 0.017))

        mids = np.vstack([g["mid_t"] for g in group])
        root = np.median(mids, axis=0)
        spine_mid_y = float(np.median(label_ys))
        spine_top = max(label_ys)
        spine_bottom = min(label_ys)

        # Thin twigs from each observed segment to a shared root, then a heavier
        # trunk to the label spine. This keeps labels off the geometry itself.
        for g in group:
            ax.plot(
                [g["mid_t"][0], root[0]],
                [g["mid_t"][1], root[1]],
                color=g["color"],
                lw=0.8,
                alpha=0.45,
                zorder=5,
            )
        ax.plot(
            [root[0], spine_x],
            [root[1], spine_mid_y],
            color="#111827",
            lw=1.0,
            alpha=0.68,
            zorder=6,
        )
        ax.plot(
            [spine_x, spine_x],
            [spine_bottom, spine_top],
            color="#111827",
            lw=1.0,
            alpha=0.68,
            zorder=6,
        )

        for g, y in zip(group, label_ys):
            branch_end_x = label_x - sign * width * 0.012
            ax.plot(
                [spine_x, branch_end_x],
                [y, y],
                color=g["color"],
                lw=1.2,
                alpha=0.9,
                zorder=7,
            )
            ax.text(
                label_x,
                y,
                g["label"],
                color="#111827",
                fontsize=7.2,
                ha="right" if side == "right" else "left",
                va="center",
                zorder=8,
                bbox=dict(boxstyle="round,pad=0.12", fc="white", ec=g["color"], lw=0.8, alpha=0.92),
            )


def draw_camera(ax, local=False):
    ax.scatter([0], [0], s=80, c="#ffd400", edgecolor="black", zorder=8)
    ax.text(
        0,
        0,
        "+Y" if not local else "camera",
        fontsize=9,
        weight="bold",
        ha="center",
        va="center",
        color="black" if not local else "#1f6feb",
        path_effects=[pe.withStroke(linewidth=3, foreground="white", alpha=0.9)],
        zorder=9,
    )


def render_google(points: dict, segments: list[dict], kind: str, title_layer: str, out_name: str):
    img = Image.open(GOOGLE_TILE_DIR / f"ghim_moh_{kind}.png").convert("RGB")
    extent = google_extent_enu(kind if kind != "map" else "map", points["lat"], points["lng"])
    fig, ax = plt.subplots(figsize=(9, 9), dpi=180)
    tile_alpha = 0.62 if kind == "satellite" else 0.48
    ax.imshow(img, extent=extent, origin="upper", alpha=tile_alpha)
    draw_rings(ax, color="white")
    draw_plane_segments(ax, segments)
    draw_camera(ax)
    ax.annotate(
        "N",
        xy=(110, 100),
        xytext=(110, 75),
        arrowprops=dict(arrowstyle="-|>", color="white", lw=2),
        color="white",
        fontsize=13,
        weight="bold",
        ha="center",
        path_effects=[pe.withStroke(linewidth=3, foreground="black")],
    )
    ax.set_xlim(-130, 130)
    ax.set_ylim(-130, 130)
    ax.set_aspect("equal", adjustable="box")
    draw_branch_labels(ax, segments)
    ax.set_xlabel("East (m)")
    ax.set_ylabel("North (m)")
    pose = points["pose"]
    ax.set_title(
        f"Photometa facade planes overlaid on {title_layer}\n"
        f"pano {points['panoid']} · ({points['lat']:.6f}, {points['lng']:.6f}) · "
        f"heading {pose['heading_deg']:.2f}° · ENU frame",
        fontsize=12,
    )
    fig.tight_layout()
    fig.savefig(OUT_DIR / out_name)
    plt.close(fig)


def osm_enu_features(lat0: float, lng0: float):
    data = json.loads(OSM_PATH.read_text())
    nodes = {
        e["id"]: np.array(
            [
                math.radians(e["lon"] - lng0) * EARTH_R * math.cos(math.radians(lat0)),
                math.radians(e["lat"] - lat0) * EARTH_R,
            ],
            dtype=float,
        )
        for e in data["elements"]
        if e.get("type") == "node"
    }
    buildings = []
    roads = []
    for way in [e for e in data["elements"] if e.get("type") == "way"]:
        pts = [nodes[n] for n in way.get("nodes", []) if n in nodes]
        if len(pts) < 2:
            continue
        arr = np.vstack(pts)
        tags = way.get("tags", {})
        if "building" in tags:
            buildings.append((arr, tags))
        if "highway" in tags:
            roads.append((arr, tags))
    return buildings, roads


def render_osm(points: dict, segments: list[dict]):
    buildings, roads = osm_enu_features(points["lat"], points["lng"])
    rotation = points["rotation"]
    right = rotation[:2, 0]
    forward = rotation[:2, 1]

    def to_local(p):
        p = np.asarray(p, dtype=float)
        return np.array([p @ right, p @ forward], dtype=float)

    north_local = to_local([0.0, 1.0])

    fig, ax = plt.subplots(figsize=(9, 9), dpi=180)
    for arr, _tags in roads:
        local = np.vstack([to_local(p) for p in arr])
        ax.plot(local[:, 0], local[:, 1], color="#c7ced8", lw=1.0, ls="--", alpha=0.75)
    for arr, tags in buildings:
        local = np.vstack([to_local(p) for p in arr])
        ax.fill(local[:, 0], local[:, 1], facecolor="#dbe3ee", edgecolor="#8390a3", lw=1.0, alpha=0.85)
        house = tags.get("addr:housenumber")
        if house:
            cen = local.mean(axis=0)
            ax.text(
                cen[0],
                cen[1],
                house,
                fontsize=8,
                color="#6b7280",
                ha="center",
                va="center",
                clip_on=True,
            )

    draw_rings(ax, color="#9aa4b2")
    draw_plane_segments(ax, segments, transform=to_local)
    draw_camera(ax, local=True)
    ax.annotate(
        "N",
        xy=95 * north_local,
        xytext=112 * north_local,
        arrowprops=dict(arrowstyle="->", color="#606872", lw=1.6),
        color="#606872",
        fontsize=13,
        weight="bold",
        ha="center",
        va="center",
    )
    ax.set_xlim(-110, 110)
    ax.set_ylim(-110, 110)
    ax.set_aspect("equal", adjustable="box")
    draw_branch_labels(ax, segments, transform=to_local)
    ax.grid(True, lw=0.4, color="#e6e9ef")
    ax.set_xlabel("+X -> pano-right (m)")
    ax.set_ylabel("+Y -> pano-forward (m)")
    pose = points["pose"]
    ax.set_title(
        f"Photometa facade planes overlaid on OSM building footprints\n"
        f"pano {points['panoid']} · ({points['lat']:.6f}, {points['lng']:.6f}) · "
        f"heading {pose['heading_deg']:.2f}° (NNW)",
        fontsize=12,
    )
    ax.legend(
        handles=[
            plt.Rectangle((0, 0), 1, 1, facecolor="#dbe3ee", edgecolor="#8390a3", label=f"{len(buildings)} OSM buildings"),
            plt.Line2D([0], [0], color="#c7ced8", lw=2, ls="--", label=f"{len(roads)} OSM road segments"),
            plt.Line2D(
                [0],
                [0],
                color="#9b59b6",
                lw=4,
                label=f"{len(segments)} photometa facade components (>= {MIN_FACADE_COMPONENT_CELLS} cells)",
            ),
        ],
        loc="upper left",
        framealpha=0.95,
    )
    fig.tight_layout()
    fig.savefig(OUT_DIR / "photometa_vs_osm.png")
    plt.close(fig)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    points = load_focal_points()
    segments = facade_segments(points)
    render_google(points, segments, "map", "Google Maps building footprints", "photometa_vs_google_map.png")
    render_google(points, segments, "satellite", "Google satellite imagery", "photometa_vs_google_satellite.png")
    render_osm(points, segments)
    print(f"Rendered {len(segments)} facade segments to {OUT_DIR}")


if __name__ == "__main__":
    main()

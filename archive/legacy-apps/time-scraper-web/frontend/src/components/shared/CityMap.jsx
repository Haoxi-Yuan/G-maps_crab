import { useEffect, useRef } from 'react';
import L from 'leaflet';

const boundaryStyle = {
  color: '#a1a1aa',
  weight: 2,
  fillColor: '#3f3f46',
  fillOpacity: 0.15,
  dashArray: '4 4'
};

const pointStyle = {
  color: '#22d3ee',
  fillColor: '#22d3ee',
  fillOpacity: 0.6,
  weight: 1,
  radius: 3
};

export function CityMap({ boundary, points, height = '400px', className = '' }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const boundaryLayerRef = useRef(null);
  const pointsLayerRef = useRef(null);

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [20, 0],
      zoom: 2,
      zoomControl: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update boundary layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (boundaryLayerRef.current) {
      map.removeLayer(boundaryLayerRef.current);
      boundaryLayerRef.current = null;
    }

    if (boundary) {
      const layer = L.geoJSON(boundary, { style: boundaryStyle }).addTo(map);
      boundaryLayerRef.current = layer;

      const bounds = layer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [30, 30] });
      }
    }
  }, [boundary]);

  // Update points layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (pointsLayerRef.current) {
      map.removeLayer(pointsLayerRef.current);
      pointsLayerRef.current = null;
    }

    if (points && points.length > 0) {
      const group = L.layerGroup();
      for (const p of points) {
        L.circleMarker([p.lat, p.lng], pointStyle).addTo(group);
      }
      group.addTo(map);
      pointsLayerRef.current = group;
    }
  }, [points]);

  return (
    <div
      className={`border border-zinc-800 rounded-lg overflow-hidden ${className}`}
      style={{ height }}
    >
      <div ref={containerRef} style={{ height: '100%', width: '100%', background: '#09090b' }} />
    </div>
  );
}

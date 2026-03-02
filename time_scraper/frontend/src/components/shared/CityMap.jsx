import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, GeoJSON, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';

function FitBounds({ boundary }) {
  const map = useMap();
  const fitted = useRef(false);

  useEffect(() => {
    if (boundary && !fitted.current) {
      try {
        const geoLayer = L.geoJSON(boundary);
        const bounds = geoLayer.getBounds();
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [30, 30] });
          fitted.current = true;
        }
      } catch (e) {
        console.warn('Failed to fit bounds:', e);
      }
    }
  }, [boundary, map]);

  // Reset when boundary changes identity
  useEffect(() => {
    fitted.current = false;
  }, [boundary]);

  return null;
}

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
  weight: 1
};

export function CityMap({ boundary, points, height = '400px', className = '' }) {
  const defaultCenter = [20, 0];

  return (
    <div
      className={`border border-zinc-800 rounded-lg overflow-hidden ${className}`}
      style={{ height }}
    >
      <MapContainer
        center={defaultCenter}
        zoom={2}
        style={{ height: '100%', width: '100%', background: '#09090b' }}
        zoomControl={true}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        />

        {boundary && (
          <>
            <GeoJSON data={boundary} style={boundaryStyle} key={JSON.stringify(boundary).slice(0, 100)} />
            <FitBounds boundary={boundary} />
          </>
        )}

        {points && points.map((p, i) => (
          <CircleMarker
            key={i}
            center={[p.lat, p.lng]}
            radius={3}
            pathOptions={pointStyle}
          />
        ))}
      </MapContainer>
    </div>
  );
}
